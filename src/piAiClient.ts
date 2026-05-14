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
  StreamOptions,
  Tool,
  ToolCall,
  ToolResultMessage,
} from '@earendil-works/pi-ai';

export type {
  AssistantMessage,
  Context,
  Message,
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

export async function complete(
  model: PiAiModel,
  context: Context,
  options?: StreamOptions,
): Promise<AssistantMessage> {
  const m = await loadPiAi();
  // pi-ai's ProviderStreamOptions is `StreamOptions & Record<string, unknown>`;
  // spread to satisfy the index-signature constraint.
  return await m.complete(model, context, options ? { ...options } : undefined);
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
