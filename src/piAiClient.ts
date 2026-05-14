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

export async function getModel(provider: AiProvider, modelId: string): Promise<PiAiModel> {
  const m = await loadPiAi();
  const piId = toPiAiProvider(provider);
  // pi-ai's getModel is typed against literal model ids per provider; our
  // model strings come from user config. Cast is documented as the supported
  // path for non-literal ids ("Custom Models" in pi-ai's README).
  return m.getModel(piId as never, modelId as never) as unknown as PiAiModel;
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

export async function complete(
  model: PiAiModel,
  context: Context,
  options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
  const m = await loadPiAi();
  const tag = `[pi-ai ${model.provider}/${model.id}]`;
  const startedAt = Date.now();
  console.log(`${tag} -> ${summarizeContextSize(context)}`);
  const adjustedOptions = adjustOptionsForModel(model, options);
  const response = await m.complete(model, context, adjustedOptions);
  const elapsed = Date.now() - startedAt;
  const stop = response.stopReason ?? 'unknown';
  const textChars = extractFinalText(response).length;
  console.log(
    `${tag} <- ${elapsed}ms stop=${stop} textChars=${textChars} usage=in:${response.usage?.input ?? '?'}/out:${response.usage?.output ?? '?'}${response.errorMessage ? ` errorMessage=${response.errorMessage.slice(0, 300)}` : ''}`,
  );
  // pi-ai surfaces upstream failures via stopReason='error' rather than
  // throwing. Without this, geminiService.generateSummary returns "" and
  // agentService.run returns "(no answer)" with no breadcrumb. Promote the
  // diagnostic into a thrown error so it reaches the renderer / CLI surface.
  if (response.stopReason === 'error') {
    throw new Error(
      `Pi-ai ${model.provider}/${model.id} failed: ${response.errorMessage ?? 'no errorMessage'}`,
    );
  }
  return response;
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
