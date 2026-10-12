// `chatgpt` is the official Sign in with ChatGPT (SIWC) plan-usage path for
// text tasks only (summary, judge, cleanup, report regeneration, agent). It
// replaced the unofficial `codex` provider, which borrowed the Codex CLI's
// OAuth client. A stored `codex` value still loads (see `normalizeAiProvider`)
// but always needs a fresh ChatGPT sign-in: the old tokens are never reused.
export const AI_PROVIDERS = ['gemini', 'chatgpt'] as const;

export type AiProvider = (typeof AI_PROVIDERS)[number];

/** Retired `aiProvider` / `transcriptionProvider` value kept for migration. */
export const LEGACY_CODEX_PROVIDER = 'codex';

export const LIVE_STT_PROVIDERS = ['auto', 'openai', 'gemini', 'soniox', 'chunked'] as const;

export type LiveSttProvider = (typeof LIVE_STT_PROVIDERS)[number];

// Batch (file) transcription backend. `auto` follows `aiProvider` only for
// Gemini; Sign in with ChatGPT cannot carry audio ("the transcription API
// [is] not supported by this flow"), so `auto` + `chatgpt` refuses instead of
// silently picking another vendor or billing path. `openai` is the standard
// OpenAI API (billed to `openaiApiKey`) and is always an explicit choice, as
// is Soniox.
export const TRANSCRIPTION_PROVIDERS = ['auto', 'gemini', 'openai', 'soniox'] as const;

export type TranscriptionProvider = (typeof TRANSCRIPTION_PROVIDERS)[number];

/** A resolved backend: `auto` has already been mapped onto a real provider. */
export type BatchSttProvider = 'gemini' | 'openai' | 'soniox';

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

// No default ChatGPT model id: the list is account-specific and comes from
// `GET /v1/models`. An unset `chatgptModel` uses the first listed model in
// server order; a set one must be listed or the call fails (no substitution).

// gpt-4o-transcribe-diarize ships native speaker diarization at the same
// per-minute price ($0.006/min) as the non-diarize model. Trade-offs vs
// gpt-4o-transcribe (see docs/model-pricing.md):
//   - doesn't accept the `prompt` parameter, so user glossaries
//     (`knownWords`) are silently dropped on this path
//   - we still segment audio into 5-min chunks for parallel-upload speed,
//     so "Speaker 0" in chunk 1 is not guaranteed to be the same physical
//     person as "Speaker 0" in chunk 2
export const DEFAULT_OPENAI_TRANSCRIPTION_MODEL = 'gpt-4o-transcribe-diarize';

// Pre-diarize model id. Useful for users who want the older prompt-driven
// behavior (vocabulary hints via `knownWords`) at the cost of speaker
// labels. Switch via `listener config set openaiTranscriptionModel gpt-4o-transcribe`.
export const OPENAI_TRANSCRIPTION_NON_DIARIZE_MODEL = 'gpt-4o-transcribe';

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

export function isLegacyCodexProvider(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === LEGACY_CODEX_PROVIDER;
}

// A legacy `codex` value maps to `chatgpt`: the user chose a ChatGPT-plan
// text provider, and that intent survives. The credential does not -- the
// ChatGPT path reads only its own SIWC store, so the user must sign in again.
export function normalizeAiProvider(value: unknown): AiProvider | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === LEGACY_CODEX_PROVIDER) return 'chatgpt';
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

export type TranscriptionProviderIssue = 'chatgpt-auto' | 'legacy-codex';

export type BatchSttResolution =
  | { provider: BatchSttProvider; issue?: undefined; message?: undefined }
  | { provider?: undefined; issue: TranscriptionProviderIssue; message: string };

export const CHATGPT_AUTO_TRANSCRIPTION_MESSAGE =
  'Sign in with ChatGPT cannot transcribe audio. Choose a transcription provider ' +
  '(Gemini, OpenAI API key, or Soniox) in Settings, or run ' +
  '`listener config set transcriptionProvider gemini|openai|soniox`.';

export const LEGACY_CODEX_TRANSCRIPTION_MESSAGE =
  'Codex transcription was removed. To keep using OpenAI transcription, select it ' +
  'explicitly (billed to your own OpenAI API key): ' +
  '`listener config set transcriptionProvider openai` and `listener config set openaiApiKey <key>`, ' +
  'or choose Gemini or Soniox in Settings.';

/**
 * Resolve the stored (raw) transcription selection. `auto` follows the chat
 * provider only for Gemini. A ChatGPT chat provider and the retired `codex`
 * STT value both refuse with an actionable message: neither may silently move
 * audio to another vendor or bill another account.
 */
export function resolveBatchSttProvider(
  rawTranscriptionProvider: unknown,
  aiProvider: AiProvider,
): BatchSttResolution {
  if (isLegacyCodexProvider(rawTranscriptionProvider)) {
    return { issue: 'legacy-codex', message: LEGACY_CODEX_TRANSCRIPTION_MESSAGE };
  }
  const selected = normalizeTranscriptionProvider(rawTranscriptionProvider);
  if (selected !== 'auto') return { provider: selected };
  if (aiProvider === 'gemini') return { provider: 'gemini' };
  return { issue: 'chatgpt-auto', message: CHATGPT_AUTO_TRANSCRIPTION_MESSAGE };
}

/**
 * Model the ChatGPT model select keeps while it shows a placeholder (signed
 * out, plan not enabled, loading, list unavailable). Opening Settings starts
 * from the saved model; every later placeholder keeps the user's current
 * pick, saved or not.
 */
// The select's `disabled` state is deliberately not consulted: the earlier
// placeholder disabled it while holding the pick, so a failed refresh after
// "loading..." would otherwise fall back to the saved model and Save would
// silently discard the user's choice.
export function chatgptPlaceholderModel(
  select: { value: string },
  saved: string,
  keepCurrent: boolean,
): string {
  return keepCurrent ? select.value : saved;
}

/**
 * Auto mode's status line when a finished recording cannot be transcribed
 * unattended. An unresolvable selection (ChatGPT + auto, retired codex) says
 * what to choose instead of claiming a missing key.
 */
export function autoModeSkipMessage(check: {
  hasAiAuth: boolean;
  transcriptionProvider?: string | null;
  transcriptionProviderIssue?: string;
}): string {
  const issue = !check.transcriptionProvider ? check.transcriptionProviderIssue?.trim() : undefined;
  const reason = !check.hasAiAuth
    ? 'configure your AI provider in Settings.'
    : issue
      ? issue
      : check.transcriptionProvider === 'soniox'
        ? 'transcription is set to Soniox but no Soniox API key is saved.'
        : 'the selected transcription backend has no credentials saved.';
  const sentence = /[.!?]$/.test(reason) ? reason : `${reason}.`;
  return `Auto mode: Skipped -- ${sentence} The recording was saved.`;
}

/**
 * The retired-Codex migration notice is about ChatGPT sign-in, so it shows
 * only while ChatGPT is the chosen provider and no account is connected. A
 * Gemini install that still carries old Codex keys (which cannot be unset)
 * never sees a warning it has no way to clear.
 */
export function showLegacyCodexNotice(state: {
  legacyCodexConfigured: boolean;
  selectedAiProvider: string | undefined;
  chatgptConnected: boolean;
}): boolean {
  return (
    state.legacyCodexConfigured && state.selectedAiProvider === 'chatgpt' && !state.chatgptConnected
  );
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
// boundary so callsites don't sprinkle inline ternaries. `chatgpt` is our own
// provider registered on the shared pi-ai Models (see piAiClient.ts).
export type PiAiProviderId = 'google' | 'chatgpt';

export function toPiAiProvider(provider: AiProvider): PiAiProviderId {
  return provider === 'chatgpt' ? 'chatgpt' : 'google';
}
