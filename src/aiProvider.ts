export const AI_PROVIDERS = ['gemini', 'codex'] as const;

export type AiProvider = (typeof AI_PROVIDERS)[number];

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-pro';
export const DEFAULT_GEMINI_FLASH_MODEL = 'gemini-2.5-flash';
export const DEFAULT_CODEX_MODEL = 'gpt-5.5';
export const DEFAULT_CODEX_TRANSCRIPTION_MODEL = 'gpt-4o-transcribe';

export function isAiProvider(value: string): value is AiProvider {
  return (AI_PROVIDERS as readonly string[]).includes(value);
}

export function normalizeAiProvider(value: unknown): AiProvider | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return isAiProvider(normalized) ? normalized : undefined;
}

// pi-ai uses different provider ids than our internal `AiProvider`. Map at the
// boundary so callsites don't sprinkle inline ternaries.
export type PiAiProviderId = 'google' | 'openai-codex';

export function toPiAiProvider(provider: AiProvider): PiAiProviderId {
  return provider === 'codex' ? 'openai-codex' : 'google';
}
