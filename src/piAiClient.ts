// Thin wrapper around `@earendil-works/pi-ai`. The package is ESM-only and
// our codebase compiles to CommonJS (tsc module=commonjs), so a normal
// `import { complete } from '@earendil-works/pi-ai'` would compile to a `require`
// that fails at runtime ("ERR_REQUIRE_ESM"). The Function-eval'd `import()`
// below bypasses tsc's import-to-require rewriting and is the same pattern
// used in src/codexOAuth.ts for the OAuth subpath.
//
// Types are still imported normally via `import type` -- those are erased at
// compile time and don't emit runtime code.

import type {
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
  Model,
  StreamOptions,
  Tool,
  ToolCall,
  ToolResultMessage,
};

type PiAiModule = typeof import('@earendil-works/pi-ai');

let modulePromise: Promise<PiAiModule> | undefined;
function loadPiAi(): Promise<PiAiModule> {
  modulePromise ??= (
    Function('return import("@earendil-works/pi-ai")') as () => Promise<PiAiModule>
  )();
  return modulePromise;
}

// Subset of pi-ai's KnownProvider that we ever pass to getModel. Keeping it
// narrow forces a compile error if we accidentally pick an unsupported
// provider id (e.g. typo'd "google-vertex" instead of "google").
export type SupportedProvider = 'google' | 'openai-codex';

export async function getModel(
  provider: SupportedProvider,
  modelId: string,
): Promise<Model<never>> {
  const m = await loadPiAi();
  // pi-ai's getModel signature is typed against literal model ids per provider,
  // but config-supplied model strings are dynamic. The cast is necessary and
  // matches the documented usage for non-literal model ids (see pi-ai README,
  // "Custom Models").
  return m.getModel(provider as never, modelId as never) as unknown as Model<never>;
}

// pi-ai's complete() expects ProviderStreamOptions (StreamOptions + an open
// record). We accept the plain StreamOptions shape here for cleaner callsites
// and spread it into a record at the boundary.
export async function complete(
  model: Model<never>,
  context: Context,
  options?: StreamOptions,
): Promise<AssistantMessage> {
  const m = await loadPiAi();
  return await m.complete(model, context, options ? { ...options } : undefined);
}

// TypeBox `Type` builder for tool parameter schemas. Lazy-loaded because
// pi-ai is ESM-only -- consumers await this once at module setup and reuse.
export async function getTypeBox(): Promise<PiAiModule['Type']> {
  const m = await loadPiAi();
  return m.Type;
}
