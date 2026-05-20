// Thin wrapper around `@earendil-works/pi-ai`. The package is ESM-only and
// our codebase compiles to CommonJS, so we can't statically `import` it --
// see src/esmImport.ts for the workaround. Types are imported normally and
// erased at compile time.

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

let modulePromise: Promise<PiAiModule> | undefined;
function loadPiAi(): Promise<PiAiModule> {
  modulePromise ??= importEsm<PiAiModule>('@earendil-works/pi-ai');
  return modulePromise;
}

import { type AiProvider, toPiAiProvider } from './aiProvider';
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

// Explicit overrides for model ids pi-ai's bundled registry doesn't carry yet.
// Mirrors pi-ai's upstream main-branch entry shape so the next published
// version transparently shadows what we have here (m.getModel() wins).
// Add entries as Google releases new models ahead of pi-ai's catch-up cycle.
const CUSTOM_GOOGLE_MODELS: Record<string, PiAiModel> = {
  'gemini-3.5-flash': {
    id: 'gemini-3.5-flash',
    name: 'Gemini 3.5 Flash',
    api: 'google-generative-ai',
    provider: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    reasoning: true,
    thinkingLevelMap: { off: null },
    input: ['text', 'image'],
    cost: { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  } as unknown as PiAiModel,
};

export async function getModel(provider: AiProvider, modelId: string): Promise<PiAiModel> {
  const m = await loadPiAi();
  const piId = toPiAiProvider(provider);
  // pi-ai's getModel is typed against literal model ids per provider; our
  // model strings come from user config. Cast is documented as the supported
  // path for non-literal ids ("Custom Models" in pi-ai's README).
  const registered = m.getModel(piId as never, modelId as never) as unknown as
    | PiAiModel
    | undefined;
  if (registered) return registered;
  if (provider === 'gemini' && CUSTOM_GOOGLE_MODELS[modelId]) {
    return CUSTOM_GOOGLE_MODELS[modelId];
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
  // pi-ai already priced this call against its bundled model table
  // (see node_modules/@earendil-works/pi-ai/dist/models.generated.js); pass
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
  const m = await loadPiAi();
  const adjustedOptions = adjustOptionsForModel(model, options);
  return runPiAiCall(
    model,
    options?.signal,
    context,
    () => m.complete(model, context, adjustedOptions),
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
  const m = await loadPiAi();
  const adjustedOptions = adjustOptionsForModel(
    model,
    options as ProviderStreamOptions | undefined,
  ) as SimpleStreamOptions | undefined;
  return runPiAiCall(
    model,
    options?.signal,
    context,
    () => m.completeSimple(model, context, adjustedOptions),
    usageContext,
  );
}

export async function getTypeBox(): Promise<PiAiModule['Type']> {
  const m = await loadPiAi();
  return m.Type;
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
