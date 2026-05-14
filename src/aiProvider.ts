export const AI_PROVIDERS = ['gemini', 'codex'] as const;

export type AiProvider = (typeof AI_PROVIDERS)[number];

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-pro';
export const DEFAULT_GEMINI_FLASH_MODEL = 'gemini-2.5-flash';
export const DEFAULT_CODEX_MODEL = 'gpt-5.5';
// gpt-4o-transcribe-diarize ships native speaker diarization at the same
// per-minute price ($0.006/min) as the non-diarize model. Trade-offs vs
// gpt-4o-transcribe (see docs/model-pricing.md):
//   - doesn't accept the `prompt` parameter, so user glossaries
//     (`knownWords`) are silently dropped on this path
//   - we still segment audio into 5-min chunks for parallel-upload speed,
//     so "Speaker 0" in chunk 1 is not guaranteed to be the same physical
//     person as "Speaker 0" in chunk 2
export const DEFAULT_CODEX_TRANSCRIPTION_MODEL = 'gpt-4o-transcribe-diarize';

// Pre-diarize model id. Useful for users who want the older prompt-driven
// behavior (vocabulary hints via `knownWords`) at the cost of speaker
// labels. Switch via `listener config set codexTranscriptionModel gpt-4o-transcribe`.
export const CODEX_TRANSCRIPTION_NON_DIARIZE_MODEL = 'gpt-4o-transcribe';

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
