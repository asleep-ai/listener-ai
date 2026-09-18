export const AI_PROVIDERS = ['gemini', 'codex'] as const;

export type AiProvider = (typeof AI_PROVIDERS)[number];

export const LIVE_STT_PROVIDERS = ['auto', 'openai', 'gemini', 'soniox', 'chunked'] as const;

export type LiveSttProvider = (typeof LIVE_STT_PROVIDERS)[number];

// Batch (file) transcription backend. `auto` follows `aiProvider` so existing
// installs keep their current behavior; Soniox is opt-in only.
export const TRANSCRIPTION_PROVIDERS = ['auto', 'gemini', 'codex', 'soniox'] as const;

export type TranscriptionProvider = (typeof TRANSCRIPTION_PROVIDERS)[number];

/** A resolved backend: `auto` has already been mapped onto a real provider. */
export type BatchSttProvider = 'gemini' | 'codex' | 'soniox';

export const DEFAULT_TRANSCRIPTION_PROVIDER: TranscriptionProvider = 'auto';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash';
export const DEFAULT_GEMINI_FLASH_MODEL = 'gemini-2.5-flash';
// Gemini 3.x replaces the older numeric `thinking_budget` knob with a coarse
// level. We expose low/medium/high to users; the older Pro-only `minimal` and
// internal `xhigh` are skipped because Google docs the GA range as
// minimal/low/medium/high and only the three middle tiers are user-meaningful
// for summarization (low ~= terse, medium ~= GA default, high ~= deep
// analysis). pi-ai's `reasoning` option accepts the same strings and forwards
// them to GoogleGenAI's `thinkingConfig.thinkingLevel`.
export const GEMINI_THINKING_LEVELS = ['low', 'medium', 'high'] as const;
export type GeminiThinkingLevel = (typeof GEMINI_THINKING_LEVELS)[number];
export const DEFAULT_GEMINI_THINKING_LEVEL: GeminiThinkingLevel = 'medium';

export function isGeminiThinkingLevel(value: unknown): value is GeminiThinkingLevel {
  return typeof value === 'string' && (GEMINI_THINKING_LEVELS as readonly string[]).includes(value);
}

export function normalizeGeminiThinkingLevel(value: unknown): GeminiThinkingLevel | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return isGeminiThinkingLevel(normalized) ? normalized : undefined;
}

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

export const DEFAULT_LIVE_STT_PROVIDER: LiveSttProvider = 'auto';
export const DEFAULT_OPENAI_LIVE_TRANSCRIPTION_MODEL = 'gpt-realtime-whisper';
export const DEFAULT_OPENAI_LIVE_TRANSLATION_MODEL = 'gpt-realtime-translate';
export const DEFAULT_OPENAI_REALTIME_SESSION_MODEL = 'gpt-realtime-2';
export const DEFAULT_GEMINI_LIVE_TRANSCRIPTION_MODEL = 'gemini-3.1-flash-live-preview';
export const DEFAULT_GEMINI_LIVE_TRANSLATION_MODEL = 'gemini-3.5-live-translate-preview';

// Soniox model ids. Model churn is roughly annual and retired ids are silently
// re-routed to the successor, so log the resolved id rather than assuming it.
export const SONIOX_ASYNC_MODEL = 'stt-async-v5';
export const SONIOX_REALTIME_MODEL = 'stt-rt-v5';

export function isAiProvider(value: string): value is AiProvider {
  return (AI_PROVIDERS as readonly string[]).includes(value);
}

export function normalizeAiProvider(value: unknown): AiProvider | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return isAiProvider(normalized) ? normalized : undefined;
}

export function isTranscriptionProvider(value: string): value is TranscriptionProvider {
  return (TRANSCRIPTION_PROVIDERS as readonly string[]).includes(value);
}

export function normalizeTranscriptionProvider(
  value: unknown,
  fallback: TranscriptionProvider = DEFAULT_TRANSCRIPTION_PROVIDER,
): TranscriptionProvider {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  return isTranscriptionProvider(normalized) ? normalized : fallback;
}

/** `auto` follows the configured chat provider; everything else is explicit. */
export function resolveBatchSttProvider(
  transcriptionProvider: TranscriptionProvider,
  aiProvider: AiProvider,
): BatchSttProvider {
  return transcriptionProvider === 'auto' ? aiProvider : transcriptionProvider;
}

export function isLiveSttProvider(value: string): value is LiveSttProvider {
  return (LIVE_STT_PROVIDERS as readonly string[]).includes(value);
}

export function normalizeLiveSttProvider(value: unknown): LiveSttProvider | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return isLiveSttProvider(normalized) ? normalized : undefined;
}

// pi-ai uses different provider ids than our internal `AiProvider`. Map at the
// boundary so callsites don't sprinkle inline ternaries.
export type PiAiProviderId = 'google' | 'openai-codex';

export function toPiAiProvider(provider: AiProvider): PiAiProviderId {
  return provider === 'codex' ? 'openai-codex' : 'google';
}
