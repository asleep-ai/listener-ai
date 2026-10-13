// Thin wrapper around `@earendil-works/pi-ai`. The package is ESM-only and
// our codebase compiles to CommonJS, so we can't statically `import` it --
// see src/esmImport.ts for the workaround. Types are imported normally and
// erased at compile time.
//
// Runtime surface is the root `createModels()` API (not the deprecated
// `/compat` entrypoint): one shared Models collection carrying only the two
// providers Listener uses, which also skips /compat's eager evaluation of
// every bundled provider catalog at module load.
//
// The two providers are Google (Gemini API key) and `chatgpt`: Sign in with
// ChatGPT plan usage on the PUBLIC `api.openai.com/v1/responses` route, through
// pi-ai's own `openai-responses` API. Its body is rewritten onto the SIWC
// contract by the `onPayload` hook (see chatgptResponses.ts).

import {
  CHATGPT_PI_PROVIDER,
  CHATGPT_RESPONSES_BASE_URL,
  ChatGPTInferenceError,
  stripChatGPTToolNamespace,
  toChatGPTInferenceError,
  toChatGPTResponsesPayload,
} from './chatgptResponses';
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
type OpenAIResponsesApiModule = typeof import('@earendil-works/pi-ai/api/openai-responses.lazy');

interface PiAiRuntime {
  pi: PiAiModule;
  models: ReturnType<PiAiModule['createModels']>;
  registerBuiltinProviders: () => void;
}

let runtimePromise: Promise<PiAiRuntime> | undefined;

function loadRuntime(): Promise<PiAiRuntime> {
  runtimePromise ??= (async () => {
    const [pi, google, responses] = await Promise.all([
      importEsm<PiAiModule>('@earendil-works/pi-ai'),
      importEsm<GoogleProviderModule>('@earendil-works/pi-ai/providers/google'),
      importEsm<OpenAIResponsesApiModule>('@earendil-works/pi-ai/api/openai-responses.lazy'),
    ]);
    const models = pi.createModels();
    const registerBuiltinProviders = () => {
      models.setProvider(google.googleProvider());
      models.setProvider(
        pi.createProvider({
          id: CHATGPT_PI_PROVIDER,
          name: 'ChatGPT plan',
          baseUrl: CHATGPT_RESPONSES_BASE_URL,
          // Explicit per-call bearer only. No env var, no stored credential:
          // an absent ChatGPT token must fail, never fall back to an
          // OPENAI_API_KEY (a different billing path).
          auth: {
            apiKey: {
              name: 'ChatGPT sign-in',
              resolve: async ({ credential }) =>
                credential?.key
                  ? { auth: { apiKey: credential.key }, source: 'ChatGPT sign-in' }
                  : undefined,
            },
          },
          // Account-discovered models are built per call (buildChatGPTModel).
          models: [],
          api: responses.openAIResponsesApi(),
        }),
      );
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

import { type AiProvider, DEFAULT_GEMINI_MODEL, toPiAiProvider } from './aiProvider';
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

// Gemini only: ChatGPT models are account-discovered (ChatGPTBinding.model()
// in chatgptBinding.ts) and must never be substituted, so getModel refuses them.
export async function getModel(provider: AiProvider, modelId: string): Promise<PiAiModel> {
  if (provider === 'chatgpt') {
    throw new Error('ChatGPT models come from the signed-in account; use ChatGPTBinding.model().');
  }
  const { models } = await loadRuntime();
  const piId = toPiAiProvider(provider);
  const lookup = (id: string) => models.getModel(piId, id);
  const registered = lookup(modelId);
  if (registered) return registered;
  // pi-ai bumps occasionally retire catalog entries (0.84 dropped several
  // gpt-5.x ids). A configured id that vanished must not brick every summary
  // and agent call -- fall back to the provider default and say so.
  const fallbackId = DEFAULT_GEMINI_MODEL;
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

export function isChatGPTModel(model: PiAiModel): boolean {
  return model.provider === CHATGPT_PI_PROVIDER;
}

// Strip options the target provider doesn't accept, so callsites stay free of
// provider conditionals. On the ChatGPT route the sampling/limit options are
// unsupported fields; dropping them here keeps pi-ai from even building them,
// and the onPayload rewrite is the authoritative allowlist on the wire.
function adjustOptionsForModel(
  model: PiAiModel,
  options: ProviderStreamOptions | undefined,
): Record<string, unknown> | undefined {
  if (!isChatGPTModel(model)) return options ? { ...options } : undefined;
  const {
    temperature: _temperature,
    maxTokens: _maxTokens,
    serviceTier: _serviceTier,
    samplingParams: _samplingParams,
    sessionId: _sessionId,
    metadata: _metadata,
    reasoning: _reasoning,
    reasoningEffort: _reasoningEffort,
    reasoningSummary: _reasoningSummary,
    onPayload: callerOnPayload,
    ...rest
  } = (options ?? {}) as Record<string, unknown> & {
    onPayload?: (params: unknown, model: PiAiModel) => unknown;
  };
  return {
    ...rest,
    // The OpenAI SDK adds OpenAI-Organization / OpenAI-Project from the
    // OPENAI_ORG_ID / OPENAI_PROJECT_ID environment. Those select API-platform
    // billing scopes and do not belong on a ChatGPT plan request; a null
    // header removes them after the SDK's env defaults are applied.
    headers: {
      ...(rest.headers as Record<string, string | null> | undefined),
      'OpenAI-Organization': null,
      'OpenAI-Project': null,
    },
    cacheRetention: 'none',
    // A usage-limit 429 or an auth failure is a user-facing state, not a
    // transient fault; pi-ai must not re-send the request on its own.
    maxRetries: 0,
    onPayload: async (params: unknown, payloadModel: PiAiModel) => {
      const next = callerOnPayload ? await callerOnPayload(params, payloadModel) : undefined;
      return toChatGPTResponsesPayload(next ?? params);
    },
  };
}

// The ChatGPT route counts a call as successful only after
// `response.completed` ("Treat inference as successful only after receiving
// response.completed"). pi-ai maps `incomplete` with max_output_tokens to
// stopReason 'length' and an in-progress terminal status to 'stop', so check
// the raw terminal status too. Anything else throws and nothing is persisted.
function assertChatGPTCompleted(response: AssistantMessage): void {
  const raw = (response as AssistantMessage & { rawStopReason?: string }).rawStopReason;
  if (response.stopReason === 'error') {
    throw toChatGPTInferenceError(response.errorMessage ?? 'no errorMessage');
  }
  if (
    raw !== 'completed' ||
    (response.stopReason !== 'stop' && response.stopReason !== 'toolUse')
  ) {
    throw new ChatGPTInferenceError(
      'incomplete',
      'The ChatGPT response ended before it completed. The ChatGPT result was not saved; try again.',
      { rawMessage: `stopReason=${response.stopReason} status=${raw ?? 'none'}` },
    );
  }
  // Tool calls inside the `listener` namespace may come back qualified.
  for (const block of response.content) {
    if (block.type === 'toolCall') block.name = stripChatGPTToolNamespace(block.name);
  }
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
  if (isChatGPTModel(model) && response.stopReason !== 'aborted') {
    assertChatGPTCompleted(response);
  }
  // Record cost only on successful turns -- error/aborted paths throw below
  // (a ChatGPT turn that did not complete was rejected just above).
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
      // ChatGPT plan calls are subscription usage, not priced API tokens.
      billing: isChatGPTModel(model) ? ('chatgpt-plan' as const) : undefined,
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
