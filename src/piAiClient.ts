// Thin wrapper around `@earendil-works/pi-ai`. The package is ESM-only and
// our codebase compiles to CommonJS, so we can't statically `import` it --
// see src/esmImport.ts for the workaround. Types are imported normally and
// erased at compile time.
//
// Runtime surface is the root `createModels()` API (not the deprecated
// `/compat` entrypoint): one shared Models collection carrying only the two
// providers Listener uses, which also skips /compat's eager evaluation of
// every bundled provider catalog at module load.

import { importEsm } from './esmImport';

import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
  ProviderStreamOptions,
  SimpleStreamOptions,
  StreamOptions,
  Tool,
  ToolCall,
  ToolResultMessage,
} from '@earendil-works/pi-ai';

export type {
  AssistantMessage,
  Context,
  Message,
  ProviderStreamOptions,
  SimpleStreamOptions,
  StreamOptions,
  Tool,
  ToolCall,
  ToolResultMessage,
};

// Opaque model handle. Domain code shouldn't depend on pi-ai's TApi
// discriminator -- we never read api-specific fields off the model.
export type PiAiModel = Model<Api>;

type PiAiModule = typeof import('@earendil-works/pi-ai');
type GoogleProviderModule = typeof import('@earendil-works/pi-ai/providers/google');
type CodexProviderModule = typeof import('@earendil-works/pi-ai/providers/openai-codex');

interface PiAiRuntime {
  pi: PiAiModule;
  models: ReturnType<PiAiModule['createModels']>;
  registerBuiltinProviders: () => void;
}

let runtimePromise: Promise<PiAiRuntime> | undefined;

function loadRuntime(): Promise<PiAiRuntime> {
  runtimePromise ??= (async () => {
    const [pi, google, codex] = await Promise.all([
      importEsm<PiAiModule>('@earendil-works/pi-ai'),
      importEsm<GoogleProviderModule>('@earendil-works/pi-ai/providers/google'),
      importEsm<CodexProviderModule>('@earendil-works/pi-ai/providers/openai-codex'),
    ]);
    const models = pi.createModels();
    const registerBuiltinProviders = () => {
      models.setProvider(google.googleProvider());
      models.setProvider(codex.openaiCodexProvider());
    };
    registerBuiltinProviders();
    return { pi, models, registerBuiltinProviders };
  })();
  return runtimePromise;
}

// Test-only: replace one provider on the shared Models (faux injection).
// Returns a restore hook that re-registers the built-in providers; call it in
// afterEach or faux state leaks into the next test.
export async function swapProviderForTest(
  provider: Parameters<PiAiRuntime['models']['setProvider']>[0],
): Promise<() => void> {
  const { models, registerBuiltinProviders } = await loadRuntime();
  models.setProvider(provider);
  return registerBuiltinProviders;
}

import {
  type AiProvider,
  DEFAULT_CODEX_MODEL,
  DEFAULT_GEMINI_MODEL,
  toPiAiProvider,
} from './aiProvider';
import { type CostSession, type UsageKind, recordUsage } from './services/usageTracker';

/**
 * Cost-tracking context passed alongside `complete()`. `kind` is required so
 * a future caller can't be silently misclassified as 'agent'; pass `session`
 * to also capture the cost in a transcribeWithTwoSteps aggregate.
 */
export interface UsageContext {
  kind: UsageKind;
  session?: CostSession;
  transcriptionRef?: string;
}

const DEFAULT_MODEL_BY_PROVIDER: Record<AiProvider, string> = {
  gemini: DEFAULT_GEMINI_MODEL,
  codex: DEFAULT_CODEX_MODEL,
};

export async function getModel(provider: AiProvider, modelId: string): Promise<PiAiModel> {
  const { models } = await loadRuntime();
  const piId = toPiAiProvider(provider);
  const lookup = (id: string) => models.getModel(piId, id);
  const registered = lookup(modelId);
  if (registered) return registered;
  // pi-ai bumps occasionally retire catalog entries (0.84 dropped several
  // gpt-5.x ids). A configured id that vanished must not brick every summary
  // and agent call -- fall back to the provider default and say so.
  const fallbackId = DEFAULT_MODEL_BY_PROVIDER[provider];
  if (fallbackId !== modelId) {
    const fallback = lookup(fallbackId);
    if (fallback) {
      console.warn(
        `[pi-ai] Unknown model ${piId}/${modelId}; falling back to ${fallbackId}. Update the configured model in Settings.`,
      );
      return fallback;
    }
  }
  throw new Error(`Unknown pi-ai model: ${piId}/${modelId}`);
}

function summarizeContextSize(context: Context): string {
  let chars = 0;
  let toolCalls = 0;
  let toolResults = 0;
  for (const msg of context.messages) {
    if (msg.role === 'user') {
      chars +=
        typeof msg.content === 'string'
          ? msg.content.length
          : msg.content.reduce((n, b) => n + (b.type === 'text' ? b.text.length : 0), 0);
    } else if (msg.role === 'assistant') {
      for (const b of msg.content) {
        if (b.type === 'text') chars += b.text.length;
        else if (b.type === 'toolCall') toolCalls++;
      }
    } else if (msg.role === 'toolResult') {
      toolResults++;
      for (const b of msg.content) if (b.type === 'text') chars += b.text.length;
    }
  }
  const systemChars = context.systemPrompt?.length ?? 0;
  return `messages=${context.messages.length} chars=${chars + systemChars} (system=${systemChars}) toolCalls=${toolCalls} toolResults=${toolResults} tools=${context.tools?.length ?? 0}`;
}

// Strip options the target provider doesn't accept. OpenAI Codex routes
// through GPT-5.x reasoning models which reject sampling parameters
// (`Unsupported parameter: temperature`). pi-ai forwards options verbatim,
// so the adjustment has to happen at our boundary -- doing it here keeps
// callsites free of provider conditionals.
function adjustOptionsForModel(
  model: PiAiModel,
  options: ProviderStreamOptions | undefined,
): Record<string, unknown> | undefined {
  if (!options) return undefined;
  const isCodex = model.api === 'openai-codex-responses' || model.provider === 'openai-codex';
  if (isCodex) {
    const { temperature: _t, ...rest } = options;
    return { ...rest };
  }
  return { ...options };
}

// Shared instrumentation + error/abort promotion for both `complete()` and
// `completeSimple()`. pi-ai surfaces upstream failures via stopReason='error'
// rather than throwing, and 'aborted' returns a partial message; both must be
// re-thrown here so geminiService.generateSummary and agentService.run don't
// silently persist empty / truncated content. Factored out so future
// error-handling tweaks can't drift between the two wrappers.
async function runPiAiCall(
  model: PiAiModel,
  signal: AbortSignal | undefined,
  context: Context,
  call: () => Promise<AssistantMessage>,
  usageContext?: UsageContext,
): Promise<AssistantMessage> {
  const tag = `[pi-ai ${model.provider}/${model.id}]`;
  const startedAt = Date.now();
  console.log(`${tag} -> ${summarizeContextSize(context)}`);
  const response = await call();
  const elapsed = Date.now() - startedAt;
  const stop = response.stopReason ?? 'unknown';
  const textChars = extractFinalText(response).length;
  console.log(
    `${tag} <- ${elapsed}ms stop=${stop} textChars=${textChars} usage=in:${response.usage?.input ?? '?'}/out:${response.usage?.output ?? '?'}${response.errorMessage ? ` errorMessage=${response.errorMessage.slice(0, 300)}` : ''}`,
  );
  // Record cost only on successful turns -- error/aborted paths throw below.
  // pi-ai already priced this call against its bundled per-provider catalog
  // (node_modules/@earendil-works/pi-ai/dist/providers/data/*.json); pass
  // its `cost.total` through verbatim rather than re-implementing.
  if (usageContext && response.stopReason !== 'error' && response.stopReason !== 'aborted') {
    const usage = response.usage;
    const recordInput = {
      modelId: model.id,
      kind: usageContext.kind,
      usage: {
        input: typeof usage?.input === 'number' ? usage.input : undefined,
        output: typeof usage?.output === 'number' ? usage.output : undefined,
        cacheRead: typeof usage?.cacheRead === 'number' ? usage.cacheRead : undefined,
        cacheWrite: typeof usage?.cacheWrite === 'number' ? usage.cacheWrite : undefined,
      },
      precomputedUsd: typeof usage?.cost?.total === 'number' ? usage.cost.total : undefined,
      transcriptionRef: usageContext.transcriptionRef,
    };
    if (usageContext.session) {
      usageContext.session.record(recordInput);
    } else {
      recordUsage(recordInput);
    }
  }
  if (response.stopReason === 'error') {
    throw new Error(
      `Pi-ai ${model.provider}/${model.id} failed: ${response.errorMessage ?? 'no errorMessage'}`,
    );
  }
  if (response.stopReason === 'aborted') {
    if (signal) signal.throwIfAborted();
    throw new DOMException('Pi-ai request aborted', 'AbortError');
  }
  return response;
}

export async function complete(
  model: PiAiModel,
  context: Context,
  options?: ProviderStreamOptions,
  usageContext?: UsageContext,
): Promise<AssistantMessage> {
  const { models } = await loadRuntime();
  const adjustedOptions = adjustOptionsForModel(model, options);
  return runPiAiCall(
    model,
    options?.signal,
    context,
    () => models.complete(model, context, adjustedOptions as ProviderStreamOptions | undefined),
    usageContext,
  );
}

// Use this (not `complete`) when callers pass `reasoning`. pi-ai's
// `streamSimpleGoogle` translates it to `thinkingConfig.thinkingLevel`; the
// regular `stream`/`complete` path silently drops it.
export async function completeSimple(
  model: PiAiModel,
  context: Context,
  options?: SimpleStreamOptions,
  usageContext?: UsageContext,
): Promise<AssistantMessage> {
  const { models } = await loadRuntime();
  const adjustedOptions = adjustOptionsForModel(
    model,
    options as ProviderStreamOptions | undefined,
  ) as SimpleStreamOptions | undefined;
  return runPiAiCall(
    model,
    options?.signal,
    context,
    () => models.completeSimple(model, context, adjustedOptions),
    usageContext,
  );
}

export async function getTypeBox(): Promise<PiAiModule['Type']> {
  const { pi } = await loadRuntime();
  return pi.Type;
}

// Reduce a pi-ai assistant message to its concatenated text content.
// Filters out thinking and tool-call blocks; trims trailing whitespace.
export function extractFinalText(message: AssistantMessage): string {
  return message.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}
