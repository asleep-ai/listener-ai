import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { GoogleGenAI } from '@google/genai';
import {
  type AiProvider,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_TRANSCRIPTION_MODEL,
  DEFAULT_GEMINI_THINKING_LEVEL,
  type GeminiThinkingLevel,
} from './aiProvider';
import { mimeTypeForExtension } from './audioFormats';
import { type CodexOAuthCredentials } from './codexOAuth';
import { CodexOAuthHolder } from './codexOAuthHolder';
import {
  EmptyTranscriptionError,
  OPENAI_TRANSCRIPTION_EXTENSIONS,
  TranscriptionApiError,
  transcribeCodexAudio,
} from './codexTranscription';
import {
  NO_SPEECH_SENTINEL,
  analyzeAssembledTranscript,
  applyTranscriptQualityGate,
  normalizeTranscriptQualityNotes,
  reconcileOverlappingSegments,
  stripNoSpeechSentinel,
} from './transcriptQuality';
import { formatOffsetTimestamp, type LiveNote } from './outputService';
import { type Context, completeSimple, extractFinalText, getModel } from './piAiClient';
import { FFmpegManager } from './services/ffmpegManager';
import { type CostSession, type CostSnapshot, createCostSession } from './services/usageTracker';

const execFileAsync = promisify(execFile);

// Promise-based sleep that rejects with AbortError if the signal fires during
// the wait. Without this, polling loops swallow the cancel for up to one full
// interval before the next signal check runs.
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Quality-retry thunks map a typed "no speech" outcome to an empty string:
// an empty context-cleared retry is evidence the first (flagged) result was
// hallucinated over silence, and the gate accepts a clean empty retry.
function emptyTranscriptionAsBlank(error: unknown): string {
  if (error instanceof EmptyTranscriptionError) return '';
  throw error;
}

// Peak level below which audio is treated as digital silence and never sent
// to a transcription provider (issue #182 H1: silence admission is the root
// seed of hallucination loops). The mic chain applies +12dB gain, so real
// speech -- even quiet speakers -- peaks far above this. Only a measured
// peak counts: when volumedetect cannot run or parse we FAIL OPEN and
// transcribe normally.
const SILENT_SEGMENT_MAX_VOLUME_DB = -50;

// Head overlap for long-file segmentation. Each segment after the first
// starts this many seconds early so speech spanning a boundary is fully
// contained in (at least) one segment and transcribed twice -- the evidence
// reconcileOverlappingSegments uses to drop the duplicate at join time.
// Capped at a quarter of the segment length so the size-based smaller Codex
// segments keep a sane audio-to-overlap ratio.
const SEGMENT_OVERLAP_SECONDS = 15;

// Pure segmentation plan: start offset + length per segment (length omitted
// for the last segment -- it runs to EOF). Exported for direct unit testing;
// splitAudioIntoSegments turns each entry into one ffmpeg `-ss/-t` cut.
export function computeSegmentPlan(
  duration: number,
  segmentDuration: number,
): Array<{ start: number; length?: number }> {
  const overlap = Math.min(SEGMENT_OVERLAP_SECONDS, Math.floor(segmentDuration / 4));
  const count = Math.max(1, Math.ceil(duration / segmentDuration));
  const plan: Array<{ start: number; length?: number }> = [];
  for (let i = 0; i < count; i++) {
    const start = i === 0 ? 0 : i * segmentDuration - overlap;
    if (i === count - 1) {
      plan.push({ start });
    } else {
      plan.push({ start, length: (i + 1) * segmentDuration - start });
    }
  }
  return plan;
}

// Append a section to the summary prompt instructing Gemini to enrich each
// user-flagged moment with a subtitle + categorized bullets, returned as a
// `highlights` array on the JSON response. Returns '' when there's nothing to
// enrich -- prompt stays untouched in that case so we don't pay for empty
// instructions.
function buildHighlightsPromptBlock(notes: LiveNote[]): string {
  if (notes.length === 0) return '';
  const lines = notes.map(
    (n) =>
      `- offsetMs=${n.offsetMs}, timestamp=${formatOffsetTimestamp(n.offsetMs)}, userText=${JSON.stringify(n.text)}`,
  );
  return `In addition, the user flagged the following moments during the meeting. For each note, produce a structured analysis tied to that moment in the transcript:

${lines.join('\n')}

For every flagged moment above, write one entry in a JSON array named "highlights". Each entry must include:
- "offsetMs": the exact integer from the input
- "userText": the user's typed text, copied verbatim
- "subtitle": a short topic label in Korean (3-7 words) summarising what was being discussed at that timestamp
- "bullets": 2-5 short Korean bullet strings categorising the discussion at that point. Prefix each bullet with one of these categories when applicable, omitting categories that don't fit: "결정 사항:", "주요 인사이트:", "실행 항목:", "식별된 리스크:". If none of the categories fit, just write the bullet without a prefix.

Use the transcript as the ground truth -- if the user's typed text doesn't clearly match anything in the transcript, fall back to the meeting content nearest the given timestamp. Return the highlights array as an additional key alongside the other fields in the JSON.`;
}

function mergeHighlights(
  liveNotes: LiveNote[] | undefined,
  raw: unknown,
): HighlightEntry[] | undefined {
  if (!liveNotes || liveNotes.length === 0) return undefined;
  // Index Gemini's returned highlights by offsetMs so we can attach
  // enrichment to the matching user note. Treat anything malformed as
  // "no enrichment for that note" -- the bare offset+userText still
  // round-trips so the user's data is never lost.
  const byOffset = new Map<number, { subtitle?: string; bullets?: string[] }>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const offsetMs = Number((item as { offsetMs?: unknown }).offsetMs);
      if (!Number.isFinite(offsetMs)) continue;
      const subtitleRaw = (item as { subtitle?: unknown }).subtitle;
      const bulletsRaw = (item as { bullets?: unknown }).bullets;
      const subtitle =
        typeof subtitleRaw === 'string' && subtitleRaw.trim().length > 0
          ? subtitleRaw.trim()
          : undefined;
      const bullets = Array.isArray(bulletsRaw)
        ? bulletsRaw.map((b) => (typeof b === 'string' ? b.trim() : '')).filter((b) => b.length > 0)
        : undefined;
      byOffset.set(offsetMs, {
        subtitle,
        bullets: bullets && bullets.length > 0 ? bullets : undefined,
      });
    }
  }
  return liveNotes.map((note) => {
    const enrichment = byOffset.get(note.offsetMs);
    return {
      offsetMs: note.offsetMs,
      userText: note.text,
      subtitle: enrichment?.subtitle,
      bullets: enrichment?.bullets,
    };
  });
}

export interface TranscriptionResult {
  transcript: string;
  summary: string;
  keyPoints: string[];
  actionItems: string[];
  emoji: string;
  suggestedTitle?: string;
  customFields?: Record<string, unknown>;
  // Notes captured live by the user during the recording. Not produced by
  // Gemini -- attached by main after transcription returns.
  liveNotes?: LiveNote[];
  // Plaud-style enriched view of the user's live notes: each entry pairs the
  // user-typed text with an AI-generated subtitle + categorized bullets that
  // describe what was being discussed around that moment in the meeting.
  // Pure flag-only notes (empty text) round-trip as `userText: ""` with no
  // subtitle/bullets -- they remain bare timestamp markers.
  highlights?: HighlightEntry[];
  // Best-effort USD estimate for the API calls that produced this transcription.
  // Aggregated from per-step usage telemetry via usageTracker. Absent when
  // every sub-call returned no usage (e.g. test stubs).
  cost?: CostSnapshot;
}

export interface HighlightEntry {
  offsetMs: number;
  userText: string;
  subtitle?: string;
  bullets?: string[];
}

export interface TranscriptionOptions {
  transcriptOnly?: boolean;
  /**
   * Override the default speaker-identification instruction sent to Gemini
   * during transcription. The user-supplied glossary (knownWords) and
   * per-segment positional prefix are still applied automatically unless
   * includeGlossary is false.
   */
  transcriptionPrompt?: string;
  includeGlossary?: boolean;
  /**
   * When false, a transcript flagged by the repetition/hallucination
   * analyzer is kept as-is instead of triggering the single context-cleared
   * quality retry. Live snippet callers disable this: re-sending the same
   * low-signal 12s blob would burn quota without new evidence (issue #182).
   * Defaults to true.
   */
  qualityRetry?: boolean;
  /**
   * Cancellation signal. The pipeline checks `signal.aborted` at every stage
   * boundary and forwards it to the underlying provider SDKs (pi-ai, Gemini
   * files/generateContent, OpenAI transcription fetch). On abort the in-flight
   * call rejects with the signal's reason and the surrounding wrapper rethrows.
   */
  signal?: AbortSignal;
}

function transcriptOnlyResult(transcript: string): TranscriptionResult {
  return {
    transcript,
    summary: '',
    keyPoints: [],
    actionItems: [],
    emoji: '',
  };
}

// Attach the session's aggregate cost snapshot to a TranscriptionResult, but
// drop empty snapshots (no recorded calls -- e.g. test stubs) so we don't
// pollute the frontmatter with `cost: { usd: 0, breakdown: [] }`.
function attachCost(result: TranscriptionResult, session: CostSession): TranscriptionResult {
  const cost = session.snapshot();
  if (cost.breakdown.length === 0) return result;
  return { ...result, cost };
}

// OpenAI's /v1/audio/transcriptions doesn't return token counts, so we record
// by audio duration alone (per-minute billing on the codex side).
function recordCodexSttUsage(
  session: CostSession | undefined,
  modelId: string,
  audioSeconds: number,
): void {
  session?.record({ modelId, kind: 'transcription', usage: { audioSeconds } });
}

// Map Gemini's usageMetadata into our UsageTokens. promptTokenCount includes
// cached tokens, so subtract cachedContentTokenCount before recording so the
// cached portion isn't billed twice. thoughts billed as output on 2.5 Flash.
function recordGeminiUsage(
  session: CostSession | undefined,
  modelId: string,
  metadata: unknown,
): void {
  if (!session) return;
  const meta = (metadata ?? {}) as {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  const cached = meta.cachedContentTokenCount ?? 0;
  session.record({
    modelId,
    kind: 'transcription',
    usage: {
      input: Math.max(0, (meta.promptTokenCount ?? 0) - cached) || undefined,
      output: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0) || undefined,
      cacheRead: cached || undefined,
    },
  });
}

export interface TranscriptionErrorPayload {
  userMessage: string;
  rawMessage: string;
  status?: number;
  statusText?: string;
  requestId?: string;
  errorType?: string;
  errorCode?: string;
  rawBody?: string;
}

export class TranscriptionError extends Error {
  readonly userMessage: string;
  readonly rawMessage: string;
  readonly status?: number;
  readonly statusText?: string;
  readonly requestId?: string;
  readonly errorType?: string;
  readonly errorCode?: string;
  readonly rawBody?: string;
  constructor(payload: TranscriptionErrorPayload, options?: { cause?: unknown }) {
    super(payload.userMessage, options);
    this.name = 'TranscriptionError';
    this.userMessage = payload.userMessage;
    this.rawMessage = payload.rawMessage;
    this.status = payload.status;
    this.statusText = payload.statusText;
    this.requestId = payload.requestId;
    this.errorType = payload.errorType;
    this.errorCode = payload.errorCode;
    this.rawBody = payload.rawBody;
  }
  toPayload(): TranscriptionErrorPayload {
    return {
      userMessage: this.userMessage,
      rawMessage: this.rawMessage,
      status: this.status,
      statusText: this.statusText,
      requestId: this.requestId,
      errorType: this.errorType,
      errorCode: this.errorCode,
      rawBody: this.rawBody,
    };
  }
}

export function annotateTranscriptionError(
  error: unknown,
  provider: AiProvider,
): TranscriptionError {
  const rawMessage = error instanceof Error ? error.message : String(error);
  // Provider handled the audio but found no speech -- a user-facing state
  // (silent/noise-only recording), not a failure of the pipeline.
  if (error instanceof EmptyTranscriptionError) {
    return new TranscriptionError(
      { userMessage: 'No intelligible speech was found in this recording.', rawMessage },
      { cause: error },
    );
  }
  // Structured upstream error from `transcribeCodexAudio` -- prefer the
  // `errorCode` / `status` fields over substring matching on `rawMessage`.
  if (error instanceof TranscriptionApiError) {
    const userMessage = friendlyMessageForApiError(error, provider);
    return new TranscriptionError(
      {
        userMessage,
        rawMessage,
        status: error.status,
        statusText: error.statusText,
        requestId: error.requestId,
        errorType: error.errorType,
        errorCode: error.errorCode,
        rawBody: error.rawBody,
      },
      { cause: error },
    );
  }
  // Fallback for non-API errors (Gemini SDK, file IO, ffmpeg) -- keep the
  // legacy substring heuristic so callers still get a friendlier message when
  // possible, but preserve the raw text in `rawMessage` for "Show details".
  const lower = rawMessage.toLowerCase();
  let userMessage: string;
  if (lower.includes('api key')) {
    userMessage =
      provider === 'codex'
        ? 'Invalid Codex OAuth token. Please sign in again.'
        : 'Invalid API key. Please check your Gemini API key configuration.';
  } else if (lower.includes('quota')) {
    userMessage = 'API quota exceeded. Please try again later.';
  } else if (lower.includes('model')) {
    userMessage = 'Model not available. Please check your API access.';
  } else {
    userMessage = `Failed to transcribe audio: ${rawMessage}`;
  }
  return new TranscriptionError({ userMessage, rawMessage }, { cause: error });
}

function isRetryableStatus(status: number): boolean {
  // Worth retrying: server errors (5xx), rate-limit (429), and the rare
  // 408 request-timeout. Everything else in 4xx is a non-transient client
  // / config issue (invalid model id, bad request shape, auth, billing).
  if (status >= 500) return true;
  if (status === 429 || status === 408) return true;
  return false;
}

function friendlyMessageForApiError(error: TranscriptionApiError, provider: AiProvider): string {
  const code = error.errorCode;
  const status = error.status;
  if (code === 'insufficient_quota' || code === 'billing_hard_limit_reached') {
    return provider === 'codex'
      ? 'OpenAI returned an insufficient-quota error for this account. Your ChatGPT/Codex usage limit may be reached, or this account is not entitled to use the transcription model.'
      : 'API quota exceeded. Please try again later.';
  }
  if (code === 'rate_limit_exceeded' || status === 429) {
    return 'Rate limit hit. Please retry in a minute.';
  }
  if (code === 'invalid_api_key' || status === 401) {
    return provider === 'codex'
      ? 'Codex OAuth token rejected. Sign out and sign in again from Settings.'
      : 'Invalid API key. Please check your Gemini API key configuration.';
  }
  if (code === 'model_not_found' || status === 404) {
    return 'Transcription model not available for this account. Try a different model.';
  }
  if (status === 403) {
    return 'OpenAI refused the request (403). This account may not be entitled to the requested model.';
  }
  return `Failed to transcribe audio (HTTP ${status}).`;
}

// No example dialogue on purpose: transcript-like sample text in the prompt
// is a hallucination seed on silent/low-signal audio (the model can echo the
// example instead of the audio -- issue #182). The no-speech sentinel gives
// silence a defined output so the model doesn't have to invent one.
const DEFAULT_TRANSCRIPT_PROMPT = `Please transcribe this audio recording with proper speaker identification.

Format requirements:
1. IDENTIFY different speakers and label them as 참가자1, 참가자2, etc.
2. Each speaker's turn MUST start on a NEW LINE
3. Format: 참가자X: [what they said]
4. Add a blank line between different speakers

IMPORTANT:
- You MUST identify and differentiate between speakers
- Each speaker turn MUST start on a new line
- Add blank line between different speakers
- DO NOT include timestamps
- Keep the transcription in the original spoken language
- Transcribe only speech that actually occurs in the audio; never fill gaps or repeat content that is not actually repeated
- If the audio contains no intelligible speech at all, return exactly ${NO_SPEECH_SENTINEL}
- Return ONLY the transcription text, no JSON formatting`;

// Final-stage model notes, piggybacked on the existing summary call (issue
// #182): the summary model already reads the entire assembled transcript, so
// asking it to also flag suspected transcription artifacts costs zero extra
// API calls. Text-only judgment cannot verify audio grounding, so its output
// is advisory metadata alongside the separate cleanup pass.
const TRANSCRIPT_QUALITY_PROMPT_BLOCK = `Additionally, before summarizing, review the transcript for transcription artifacts: sections where the same sentence or phrase repeats verbatim many times, boilerplate unrelated to the surrounding discussion (e.g. broadcast closing phrases on silence), or content that clearly breaks the flow of the meeting. These can be speech-to-text errors, not real speech.

- If any exist, add a "transcriptQualityNotes" array to the JSON response. Each item is one short Korean sentence describing the suspicious section and why it looks like a transcription artifact.
- If there are none, omit the field.
- Never rewrite or remove transcript content based on this review.
- Base the summary, key points, and action items only on content you judge to be genuine speech; do not summarize suspected artifacts as if they were discussion content.`;

const TRANSCRIPT_CLEANUP_SYSTEM_PROMPT = `You are a transcript post-processor for speech-to-text output. STT models sometimes emit artifacts: the same sentence or phrase repeated verbatim many times in a row, boilerplate unrelated to the conversation (e.g. broadcast closing phrases emitted over silence), or looping word sequences. Remove ONLY such artifacts and return the rest of the transcript EXACTLY as-is. Rules: (1) Keep legitimate repetition: confirmations like '네, 네', stutters, chants, emphasis. (2) Never rephrase, summarize, translate, reorder, or fix grammar/spacing — copy non-artifact text verbatim, including speaker labels (참가자N:), segment headers like [Segment 1: 00:00:00 ~ 00:05:00], blank lines, and --- separators. (3) When a phrase loops, keep its first occurrence and delete the copies. (4) If nothing is an artifact, return the transcript unchanged. Return ONLY the transcript text — no commentary, no code fences.`;

// Context-cleared prompt for the single bounded quality retry (issue #182):
// no glossary, no positional prefix, no format examples -- so a retry after a
// suspected repetition/hallucination loop starts from a minimal grounding
// instruction instead of re-feeding the context that may have seeded it.
const QUALITY_RETRY_TRANSCRIPT_PROMPT = `Transcribe the speech in this audio exactly as spoken.

- Keep the original spoken language.
- Label distinguishable speakers as 참가자1, 참가자2, etc., one turn per line.
- Transcribe only speech that actually occurs in the audio; never fill gaps or repeat content that is not actually repeated.
- If there is no clearly intelligible speech, return exactly ${NO_SPEECH_SENTINEL}.
- Return only the transcript text.`;

// Whisper's fallback ladder raises temperature to break self-reinforcing
// repetition loops -- our single bounded retry uses one mid-high step.
const QUALITY_RETRY_TEMPERATURE = 0.7;

export interface GeminiServiceOptions {
  provider?: AiProvider;
  apiKey?: string;
  codexOAuth?: CodexOAuthCredentials;
  onCodexOAuthUpdate?: (credentials: CodexOAuthCredentials) => void | Promise<void>;
  dataPath?: string;
  knownWords?: string[];
  proModel: string;
  flashModel: string;
  codexModel?: string;
  codexTranscriptionModel?: string;
  // Gemini summary-path thinking depth. Ignored for the Codex provider and
  // for all transcription paths. Defaults to medium (Gemini 3.x GA default).
  thinkingLevel?: GeminiThinkingLevel;
}

export class GeminiService {
  private ai?: GoogleGenAI;
  private geminiApiKey?: string;
  private codexAuth?: CodexOAuthHolder;
  private provider: AiProvider;
  private ffmpegManager: FFmpegManager;
  private knownWords: string[];
  private proModel: string;
  private flashModel: string;
  private codexModel: string;
  private codexTranscriptionModel: string;
  private thinkingLevel: GeminiThinkingLevel;

  // Get FFmpeg path for this service
  private async getFFmpegPath(): Promise<string> {
    const ffmpegPath = await this.ffmpegManager.ensureFFmpeg();
    if (ffmpegPath) {
      return ffmpegPath;
    }

    // FFmpeg not found - return default and let error handling in splitAudioIntoSegments show dialog
    return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  }

  constructor(options: GeminiServiceOptions) {
    this.provider = options.provider ?? 'gemini';
    if (this.provider === 'gemini') {
      if (!options.apiKey) {
        throw new Error('Gemini API key is required for the Gemini provider.');
      }
      this.ai = new GoogleGenAI({ apiKey: options.apiKey });
      this.geminiApiKey = options.apiKey;
    } else {
      this.codexAuth = new CodexOAuthHolder({
        credentials: options.codexOAuth,
        onUpdate: options.onCodexOAuthUpdate,
      });
    }
    this.ffmpegManager = new FFmpegManager(options.dataPath);
    this.knownWords = options.knownWords || [];
    this.proModel = options.proModel;
    this.flashModel = options.flashModel;
    this.codexModel = options.codexModel || DEFAULT_CODEX_MODEL;
    this.codexTranscriptionModel =
      options.codexTranscriptionModel || DEFAULT_CODEX_TRANSCRIPTION_MODEL;
    this.thinkingLevel = options.thinkingLevel ?? DEFAULT_GEMINI_THINKING_LEVEL;
  }

  private gemini(): GoogleGenAI {
    if (!this.ai) {
      throw new Error('Gemini client is not configured for the selected AI provider.');
    }
    return this.ai;
  }

  private async getCodexToken(): Promise<string> {
    if (!this.codexAuth) {
      throw new Error('Codex OAuth holder is not configured.');
    }
    return await this.codexAuth.getToken();
  }

  private requireGeminiApiKey(): string {
    if (!this.geminiApiKey) {
      throw new Error('Gemini API key is not configured.');
    }
    return this.geminiApiKey;
  }

  // Pi-ai's GoogleOptions doesn't expose Gemini's `responseMimeType=application/json`
  // knob, so models may wrap the JSON in ```json``` fences. The summary-text
  // consumer strips fences before parsing (see stripJsonFences in
  // transcribeWithTwoSteps).
  private async generateSummary(
    promptText: string,
    transcript: string,
    signal?: AbortSignal,
    session?: CostSession,
  ): Promise<string> {
    const modelId = this.provider === 'codex' ? this.codexModel : this.proModel;
    const apiKey =
      this.provider === 'codex' ? await this.getCodexToken() : this.requireGeminiApiKey();

    const model = await getModel(this.provider, modelId);
    // Force formal Korean register (합니다체). Codex (GPT-5.x) defaults to
    // mixed/해요체 in Korean output; Gemini tends to 합니다체 already but the
    // explicit constraint keeps both providers consistent. Applied as a system
    // prompt so it overrides whatever tone the user's customSummaryPrompt
    // implies for summary/keyPoints/actionItems bodies.
    const koreanToneSystem =
      '모든 한국어 출력은 격식체(합니다/입니다 어미)로 작성하세요. 반말이나 해요체를 쓰지 마세요. summary, keyPoints, actionItems 본문 모두 동일하게 적용합니다.';
    const context: Context = {
      systemPrompt: koreanToneSystem,
      messages: [
        {
          role: 'user',
          content: `${promptText}\n\nTranscript:\n${transcript}`,
          timestamp: Date.now(),
        },
      ],
    };
    // Codex's xhigh forces deepest analysis (gpt-5.5's thinkingLevelMap maps
    // xhigh -> "max"). Gemini uses the user-configurable level. completeSimple
    // unifies both: pi-ai translates `reasoning` to reasoningEffort (codex) or
    // thinkingConfig.thinkingLevel (gemini).
    const reasoning = this.provider === 'codex' ? 'xhigh' : this.thinkingLevel;
    const response = await completeSimple(
      model,
      context,
      {
        apiKey,
        temperature: 0.2,
        maxTokens: 32768,
        reasoning,
        signal,
      },
      { kind: 'summary', session },
    );
    return extractFinalText(response);
  }

  private async completeTextTask(
    systemPrompt: string,
    promptText: string,
    opts: {
      signal?: AbortSignal;
      maxTokens?: number;
      temperature?: number;
      reasoning?: GeminiThinkingLevel | 'xhigh';
      modelId?: string;
    } = {},
  ): Promise<string> {
    const modelId = opts.modelId ?? (this.provider === 'codex' ? this.codexModel : this.proModel);
    const apiKey =
      this.provider === 'codex' ? await this.getCodexToken() : this.requireGeminiApiKey();
    const model = await getModel(this.provider, modelId);
    const context: Context = {
      systemPrompt,
      messages: [{ role: 'user', content: promptText, timestamp: Date.now() }],
    };
    const response = await completeSimple(
      model,
      context,
      {
        apiKey,
        temperature: opts.temperature ?? 0.2,
        maxTokens: opts.maxTokens ?? 4096,
        reasoning: opts.reasoning ?? 'low',
        signal: opts.signal,
      },
      { kind: 'agent' },
    );
    return extractFinalText(response);
  }

  // Observability follows the `[codex-transcribe] -> / <-` arrow style:
  // model id, sizes, and latency only -- never transcript text.
  private async cleanTranscriptWithModel(
    transcript: string,
    signal?: AbortSignal,
  ): Promise<{ text: string; removedChars: number }> {
    if (!transcript.trim()) return { text: transcript, removedChars: 0 };

    const modelId = this.provider === 'codex' ? this.codexModel : this.flashModel;
    const startedAt = Date.now();
    console.error(
      `[transcript-quality] model cleanup -> model=${modelId} inputChars=${transcript.length}`,
    );
    try {
      const response = await this.completeTextTask(
        TRANSCRIPT_CLEANUP_SYSTEM_PROMPT,
        `Transcript to clean:\n${transcript}`,
        {
          modelId,
          temperature: 0,
          reasoning: 'low',
          maxTokens: 32768,
          signal,
        },
      );
      const elapsed = Date.now() - startedAt;
      const fenced = response.match(/^```(?:\w+)?\r?\n([\s\S]*?)(?:\r?\n)?```\s*$/);
      const cleaned = (fenced ? fenced[1] : response).trimEnd();
      if (!cleaned) {
        console.error(
          `[transcript-quality] model cleanup <- ${elapsed}ms empty response; keeping original`,
        );
        return { text: transcript, removedChars: 0 };
      }

      const removedChars = Math.max(0, transcript.length - cleaned.length);
      console.error(
        `[transcript-quality] model cleanup <- ${elapsed}ms outputChars=${cleaned.length} ` +
          `removedChars=${removedChars}${removedChars === 0 ? ' (unchanged)' : ''}${fenced ? ' (stripped fence)' : ''}`,
      );
      return { text: cleaned, removedChars };
    } catch (error) {
      if (signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[transcript-quality] model cleanup <- failed after ${Date.now() - startedAt}ms: ${message}`,
      );
      return { text: transcript, removedChars: 0 };
    }
  }

  private async prepareAudioForProvider(
    audioFilePath: string,
    signal?: AbortSignal,
  ): Promise<{
    audioFilePath: string;
    cleanup?: () => void;
  }> {
    if (this.provider !== 'codex') return { audioFilePath };

    const ext = path.extname(audioFilePath).toLowerCase();
    if (OPENAI_TRANSCRIPTION_EXTENSIONS.has(ext)) return { audioFilePath };

    const outputPath = path.join(
      path.dirname(audioFilePath),
      `${path.basename(audioFilePath, ext)}_codex_${Date.now()}.webm`,
    );
    const ffmpegPath = await this.getFFmpegPath();
    try {
      await execFileAsync(
        ffmpegPath,
        ['-i', audioFilePath, '-vn', '-c:a', 'libopus', '-b:a', '48k', outputPath],
        { signal },
      );
    } catch (err) {
      // Abort or ffmpeg failure can leave a partial `_codex_<ts>.webm` on
      // disk. Because we threw before returning the `cleanup` closure, the
      // outer `transcribeAudio` finally never sees this path -- the new
      // watcher filter only HIDES it from the list, it does not delete it.
      // Unlink best-effort so the file doesn't accumulate, then rethrow so
      // cancellation/error semantics are unchanged.
      try {
        fs.unlinkSync(outputPath);
      } catch {
        /* probably ENOENT -- ffmpeg failed before writing anything */
      }
      throw err;
    }
    return {
      audioFilePath: outputPath,
      cleanup: () => {
        try {
          fs.unlinkSync(outputPath);
        } catch {
          /* ignore */
        }
      },
    };
  }

  private buildGlossaryBlock(): string {
    if (this.knownWords.length === 0) return '';
    const wordList = this.knownWords.map((w) => `- ${w}`).join('\n');
    return `The following proper nouns, names, and terms may appear in the audio. Transcribe them exactly as spelled:\n${wordList}\n\n`;
  }

  async transcribeAudio(
    audioFilePath: string,
    progressCallback?: (percent: number, message: string) => void,
    summaryPrompt?: string,
    liveNotes?: LiveNote[],
    options: TranscriptionOptions = {},
  ): Promise<TranscriptionResult> {
    const signal = options.signal;
    signal?.throwIfAborted();

    // Integration-test escape hatch: avoid the real Gemini call so tests can
    // exercise the surrounding pipeline (CLI parsing, IPC, ffmpeg, save) for
    // free and offline. Gated on NODE_ENV=test so a stray LISTENER_TEST_MODE
    // in a packaged user's shell rc can't silently stub their transcripts.
    if (process.env.LISTENER_TEST_MODE && process.env.NODE_ENV === 'test') {
      if (progressCallback) progressCallback(100, 'Stubbed transcription');
      if (options.transcriptOnly) {
        return transcriptOnlyResult('Stubbed transcript.');
      }
      return {
        transcript: 'Stubbed transcript.',
        summary: 'Stubbed summary.',
        keyPoints: ['stub point'],
        actionItems: ['stub action'],
        emoji: '🧪',
        suggestedTitle: 'Stubbed Title',
      };
    }

    const prepared = await this.prepareAudioForProvider(audioFilePath, signal);
    try {
      signal?.throwIfAborted();
      // Check file size
      const stats = await fs.promises.stat(prepared.audioFilePath);
      const fileSizeInMB = stats.size / (1024 * 1024);
      console.error(`Audio file size: ${fileSizeInMB.toFixed(2)} MB`);

      if (progressCallback) {
        progressCallback(15, `Processing ${fileSizeInMB.toFixed(1)} MB audio file...`);
      }

      // Get audio duration using ffmpeg
      const duration = await this.getAudioDuration(prepared.audioFilePath, signal);
      console.error(`Audio duration: ${duration} seconds`);

      // If duration is 0, log a warning but continue processing
      if (duration === 0) {
        console.warn(
          'WARNING: Could not determine audio duration. Will process as single file without segmentation.',
        );
      }

      signal?.throwIfAborted();
      // Always use the two-step approach for consistency
      console.error('Using two-step transcription approach...');
      return await this.transcribeWithTwoSteps(
        prepared.audioFilePath,
        duration,
        progressCallback,
        summaryPrompt,
        liveNotes,
        options,
      );
    } catch (error) {
      console.error('Error transcribing audio:', error);
      throw annotateTranscriptionError(error, this.provider);
    } finally {
      prepared.cleanup?.();
    }
  }

  async transcribeLiveSnippet(
    audioFilePath: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<string> {
    let result: TranscriptionResult;
    try {
      result = await this.transcribeAudio(audioFilePath, undefined, undefined, undefined, {
        transcriptOnly: true,
        includeGlossary: false,
        // No bounded quality retry for live snippets: re-sending the same
        // 12s low-signal blob can't produce new evidence. The live session
        // layer suppresses duplicates and marks flagged finals instead.
        qualityRetry: false,
        transcriptionPrompt: `Please transcribe this short live meeting audio snippet.

Requirements:
- Keep the original spoken language.
- Preserve proper nouns and technical terms.
- Do not infer names, company names, or terms from context. Write them only when clearly spoken.
- If there is no clearly intelligible speech, return exactly ${NO_SPEECH_SENTINEL}.
- If speakers are distinguishable, prefix turns with 참가자1, 참가자2, etc.
- Return only transcript text. Do not summarize and do not add commentary.`,
        signal: opts.signal,
      });
    } catch (error) {
      // A silent snippet is normal during a live session (pauses, breaks) --
      // map the typed no-speech error to an empty result instead of surfacing
      // an error toast every 12 seconds. The error may arrive wrapped by
      // annotateTranscriptionError, so walk the cause chain.
      for (let cause: unknown = error; cause; cause = (cause as Error).cause) {
        if (cause instanceof EmptyTranscriptionError) return '';
      }
      throw error;
    }
    return stripNoSpeechSentinel(result.transcript);
  }

  async translateText(
    text: string,
    opts: { targetLanguage?: string; signal?: AbortSignal } = {},
  ): Promise<string> {
    const source = text.trim();
    if (!source) return '';
    const targetLanguage = opts.targetLanguage || 'Korean';
    return await this.completeTextTask(
      `You translate live meeting transcript snippets into ${targetLanguage}. Preserve speaker labels, names, numbers, and technical terms. If the source is already ${targetLanguage}, lightly clean it without changing meaning. Return only the translated text.`,
      `Translate this live transcript snippet:\n\n${source}`,
      {
        signal: opts.signal,
        maxTokens: 4096,
        temperature: 0.1,
        reasoning: 'low',
        modelId: this.provider === 'gemini' ? this.flashModel : undefined,
      },
    );
  }

  // Get audio duration using ffmpeg
  private async getAudioDuration(audioFilePath: string, signal?: AbortSignal): Promise<number> {
    try {
      const ffmpegPath = await this.getFFmpegPath();

      // Use ffmpeg with -f null to get file info including duration
      // This will output file info to stderr which we can parse
      console.error('Running ffmpeg for duration:', ffmpegPath, audioFilePath);

      const { stderr } = await execFileAsync(ffmpegPath, ['-i', audioFilePath, '-f', 'null', '-'], {
        signal,
      }).catch((error: unknown) => {
        // Re-throw aborts so the surrounding transcribeAudio catch sees a
        // proper AbortError instead of swallowing it into "duration=0".
        if (signal?.aborted) throw error;
        const execError = error as { stdout?: string; stderr?: string };
        // FFmpeg exits with non-zero code when output is null, but still provides info in stderr
        // This is expected behavior, so we return the error object which contains stdout/stderr
        return { stdout: execError.stdout || '', stderr: execError.stderr || '' };
      });

      // Extract duration from stderr (where ffmpeg outputs file info)
      const durationMatch = stderr?.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})/);
      if (durationMatch) {
        const hours = Number.parseInt(durationMatch[1]);
        const minutes = Number.parseInt(durationMatch[2]);
        const seconds = Number.parseFloat(durationMatch[3]);
        const totalSeconds = hours * 3600 + minutes * 60 + seconds;
        console.error(`FFmpeg extracted duration: ${totalSeconds} seconds`);
        return totalSeconds;
      }

      // Alternative regex pattern for different duration formats
      const altDurationMatch = stderr?.match(/Duration: (\d+):(\d+):(\d+)/);
      if (altDurationMatch) {
        const hours = Number.parseInt(altDurationMatch[1]);
        const minutes = Number.parseInt(altDurationMatch[2]);
        const seconds = Number.parseInt(altDurationMatch[3]);
        const totalSeconds = hours * 3600 + minutes * 60 + seconds;
        console.error(`FFmpeg extracted duration (alt format): ${totalSeconds} seconds`);
        return totalSeconds;
      }

      // Default to 0 if we can't determine duration
      console.warn('Could not determine audio duration from stderr:', stderr);
      return 0;
    } catch (error) {
      // Don't swallow aborts -- let them propagate so the caller can short-
      // circuit the rest of the transcription pipeline.
      if (signal?.aborted) throw error;
      console.error('Error getting audio duration:', error);
      // Return 0 as fallback to continue processing
      return 0;
    }
  }

  // Measure the peak level (dBFS) of a file via ffmpeg's volumedetect
  // filter. Returns null whenever the measurement cannot be trusted
  // (missing binary, unparseable output) -- callers FAIL OPEN on null and
  // transcribe normally, so this gate can only ever skip provably silent
  // audio, never real speech.
  private async measureMaxVolumeDb(
    audioFilePath: string,
    signal?: AbortSignal,
  ): Promise<number | null> {
    try {
      const ffmpegPath = await this.getFFmpegPath();
      const { stderr } = await execFileAsync(
        ffmpegPath,
        ['-i', audioFilePath, '-af', 'volumedetect', '-f', 'null', '-'],
        { signal },
      ).catch((error: unknown) => {
        if (signal?.aborted) throw error;
        // ffmpeg can exit non-zero while still printing the stats we need.
        const execError = error as { stdout?: string; stderr?: string };
        return { stdout: execError.stdout || '', stderr: execError.stderr || '' };
      });

      // Pure digital silence can report `-inf dB` depending on the build.
      const match = /max_volume:\s*(-?)(inf|\d+(?:\.\d+)?)\s*dB/i.exec(stderr || '');
      if (!match) return null;
      const magnitude = match[2].toLowerCase() === 'inf' ? Infinity : Number.parseFloat(match[2]);
      return match[1] === '-' ? -magnitude : magnitude;
    } catch (error) {
      if (signal?.aborted) throw error;
      return null;
    }
  }

  // List existing `<base>_segment_NNN.<ext>` files for an audio path. Used by
  // both the split step (collecting newly written segments) and the cleanup
  // step (sweeping leftovers when ffmpeg was killed mid-split). Optional
  // extension filter -- omit to match any segment file regardless of ext.
  //
  // Pattern is strict on purpose: ffmpeg's `%03d` formatter emits exactly
  // three digits, and a loose prefix match would let user-named recordings
  // like `Meeting_segment_notes.webm` get caught by cleanup and deleted.
  private findSegmentFiles(audioFilePath: string, ext?: string): string[] {
    const outputDir = path.dirname(audioFilePath);
    const baseName = path.basename(audioFilePath, path.extname(audioFilePath));
    const escaped = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const extPattern = ext ? ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '\\.[A-Za-z0-9]+';
    const pattern = new RegExp(`^${escaped}_segment_\\d{3}${extPattern}$`);
    try {
      return fs
        .readdirSync(outputDir)
        .filter((file) => pattern.test(file))
        .map((file) => path.join(outputDir, file))
        .sort();
    } catch {
      return [];
    }
  }

  // Split audio file into segments with head overlap (see computeSegmentPlan)
  private async splitAudioIntoSegments(
    audioFilePath: string,
    segmentDuration = 300,
    // Historical knob from the pre-overlap implementation (Codex passed
    // true, Gemini false). The overlapped plan path now ALWAYS re-encodes:
    // measured on webm-opus, `-ss/-t -c copy` extraction cuts wildly wrong
    // (a 5s request produced an 8s file) because copy mode cannot use
    // ffmpeg's accurate_seek -- and reconciliation depends on cut accuracy.
    // Only the legacy no-duration fallback still honors this flag.
    reencode = false,
    signal?: AbortSignal,
    // Total duration in seconds. Required for the overlapped per-segment
    // plan; when unknown (<= 0, i.e. ffprobe failed upstream) we fall back
    // to the legacy single-invocation segment muxer without overlap.
    duration = 0,
  ): Promise<string[]> {
    const outputDir = path.dirname(audioFilePath);
    const baseName = path.basename(audioFilePath, path.extname(audioFilePath));
    const ext = path.extname(audioFilePath);

    // When re-encoding to opus we MUST force a container that supports
    // opus -- ffmpeg picks the muxer from the output extension, so leaving
    // an imported `.mp3`/`.m4a`/`.wav` source as `.mp3` makes ffmpeg pick
    // the MP3 muxer and reject the opus stream. `.webm` is in OpenAI's
    // supported transcription extensions, so the segments still upload.
    const planReencodes = duration > 0;
    const segmentExt = reencode || planReencodes ? '.webm' : ext;

    // Get the bundled FFmpeg path
    const ffmpegPath = await this.getFFmpegPath();

    try {
      if (duration > 0) {
        // One ffmpeg invocation per planned segment. `-ss` before `-i` with
        // re-encoding uses ffmpeg's default accurate_seek, giving
        // sample-accurate cuts (copy mode cannot: measured on webm-opus it
        // produced a wildly wrong cut). Every segment after the first
        // starts SEGMENT_OVERLAP_SECONDS early so boundary speech is
        // transcribed twice -- the evidence reconcileOverlappingSegments
        // needs to safely drop the duplicate at join time (issue #182 H3).
        const plan = computeSegmentPlan(duration, segmentDuration);
        for (const [i, part] of plan.entries()) {
          signal?.throwIfAborted();
          const segmentPath = path.join(
            outputDir,
            `${baseName}_segment_${String(i).padStart(3, '0')}${segmentExt}`,
          );
          await execFileAsync(
            ffmpegPath,
            [
              '-y',
              '-ss',
              String(part.start),
              '-i',
              audioFilePath,
              ...(part.length !== undefined ? ['-t', String(part.length)] : []),
              '-c:a',
              'libopus',
              '-b:a',
              '48k',
              segmentPath,
            ],
            { signal },
          );
        }
      } else {
        // Legacy fallback (unknown duration): the segment muxer with
        // `-reset_timestamps 1` so each segment starts at PTS 0 and carries
        // its own container duration. No overlap in this mode.
        const codecArgs = reencode ? ['-c:a', 'libopus', '-b:a', '48k'] : ['-c', 'copy'];
        const segmentPattern = path.join(outputDir, `${baseName}_segment_%03d${segmentExt}`);
        await execFileAsync(
          ffmpegPath,
          [
            '-i',
            audioFilePath,
            '-f',
            'segment',
            '-segment_time',
            String(segmentDuration),
            '-reset_timestamps',
            '1',
            ...codecArgs,
            segmentPattern,
          ],
          { signal },
        );
      }

      // Find all created segment files. Match on the EXTENSION WE TOLD
      // FFMPEG TO WRITE -- when re-encoding, that's `.webm` regardless of
      // the source's original extension.
      const segmentFiles = this.findSegmentFiles(audioFilePath, segmentExt);

      console.error(`Split audio into ${segmentFiles.length} segments`);
      return segmentFiles;
    } catch (error: any) {
      console.error('Error splitting audio:', error);

      // Check if it's a Windows FFmpeg not found error
      if (
        process.platform === 'win32' &&
        (error.message?.includes('is not recognized') ||
          error.message?.includes('ffmpeg.exe') ||
          error.code === 'ENOENT')
      ) {
        let dialog: any;
        let shell: any;
        try {
          ({ dialog, shell } = require('electron'));
        } catch {
          throw new Error('FFmpeg not found. Please install FFmpeg.');
        }

        dialog.showErrorBox(
          'FFmpeg Not Found',
          'FFmpeg is required for audio transcription but was not found.\n\n' +
            'To install FFmpeg on Windows:\n\n' +
            'Option 1 (Recommended):\n' +
            '1. Open PowerShell as Administrator\n' +
            '2. Run: winget install ffmpeg\n' +
            '3. Restart Listener.AI\n\n' +
            'Option 2 (Manual):\n' +
            '1. Download from: https://www.gyan.dev/ffmpeg/builds/\n' +
            '2. Download "release essentials" build\n' +
            '3. Extract to C:\\ffmpeg\n' +
            '4. The ffmpeg.exe should be at C:\\ffmpeg\\bin\\ffmpeg.exe\n' +
            '5. Restart Listener.AI',
        );

        // Offer to open download page
        const result = dialog.showMessageBoxSync(null, {
          type: 'question',
          buttons: ['Open Download Page', 'Cancel'],
          defaultId: 0,
          message: 'Open FFmpeg download page?',
        });

        if (result === 0) {
          shell.openExternal('https://www.gyan.dev/ffmpeg/builds/');
        }

        throw new Error('FFmpeg not found. Please install FFmpeg and restart Listener.AI.');
      }

      throw error;
    }
  }

  // Two-step transcription approach for all audio files
  private async transcribeWithTwoSteps(
    audioFilePath: string,
    duration: number,
    progressCallback?: (percent: number, message: string) => void,
    customSummaryPrompt?: string,
    liveNotes?: LiveNote[],
    options: TranscriptionOptions = {},
  ): Promise<TranscriptionResult> {
    const signal = options.signal;
    const costSession = createCostSession();
    try {
      let fullTranscript = '';
      const stats = await fs.promises.stat(audioFilePath);
      const fileSizeInMB = stats.size / (1024 * 1024);
      // Segment intentionally for parallelism: even when the API would
      // accept the whole file (Gemini long-context, gpt-4o-transcribe-diarize
      // via chunking_strategy=auto), N parallel 5-min requests finish much
      // faster than one big sequential pass. Trade-off for the diarize
      // model: speaker IDs are mapped fresh per segment ("Speaker 0" in
      // segment 1 may not be the same physical person as "Speaker 0" in
      // segment 2). See docs/model-pricing.md.
      const shouldSegment = duration > 300 || (this.provider === 'codex' && fileSizeInMB > 24);
      const segmentDuration =
        this.provider === 'codex' && duration > 0 && fileSizeInMB > 20
          ? Math.max(30, Math.min(300, Math.floor((20 / fileSizeInMB) * duration)))
          : 300;

      // Step 1: Get transcript
      if (shouldSegment) {
        // Use segmented approach for long audio
        console.error('Using segmented transcription...');
        fullTranscript = await this.getSegmentedTranscript(
          audioFilePath,
          duration,
          progressCallback,
          options.transcriptionPrompt,
          segmentDuration,
          signal,
          costSession,
          options.includeGlossary !== false,
          options.qualityRetry !== false,
        );
      } else {
        // Get transcript for short audio
        console.error('Transcribing short audio...');
        fullTranscript = await this.getShortAudioTranscript(
          audioFilePath,
          duration,
          progressCallback,
          options.transcriptionPrompt,
          signal,
          costSession,
          options.includeGlossary !== false,
          options.qualityRetry !== false,
        );
      }

      signal?.throwIfAborted();

      // Final-stage analyzer pass over the ASSEMBLED transcript: catches
      // cross-segment repetition the per-segment gate cannot see. Its raw
      // verdict is logged (metrics only) and persisted on the saved note.
      const assembledQuality = analyzeAssembledTranscript(fullTranscript);
      if (assembledQuality.flagged) {
        console.error(
          `[transcript-quality] assembled transcript flagged (${assembledQuality.reasons.join(', ')}; ` +
            `normalizedLength=${assembledQuality.metrics.normalizedLength})`,
        );
      }

      if (options.transcriptOnly) {
        if (progressCallback) {
          progressCallback(100, 'Transcript ready');
        }
        return attachCost(transcriptOnlyResult(fullTranscript), costSession);
      }

      const cleanup = await this.cleanTranscriptWithModel(fullTranscript, signal);
      fullTranscript = cleanup.text;

      // Step 2: Generate summary, key points, action items from transcript
      if (progressCallback) {
        progressCallback(85, 'Generating summary and key points...');
      }

      const basePrompt =
        customSummaryPrompt ||
        `Based on this meeting transcript, provide:

1. A concise meeting title in Korean (10-20 characters that captures the main topic)
2. A concise summary in Korean (2-3 paragraphs)
3. Key points discussed in Korean (as a bullet list)
4. Action items mentioned in Korean (as a bullet list)
5. An appropriate emoji that represents the meeting

Return as JSON:
{
  "suggestedTitle": "concise title in Korean",
  "summary": "summary in Korean",
  "keyPoints": ["point 1", "point 2"],
  "actionItems": ["action 1", "action 2"],
  "emoji": "📝"
}`;

      const enrichableNotes = (liveNotes ?? []).filter((n) => (n.text ?? '').trim().length > 0);
      const highlightsBlock = buildHighlightsPromptBlock(enrichableNotes);
      // Same additive pattern as the highlights block: appended to custom
      // summary prompts too, since the shared parser tolerates the extra key.
      const summaryPrompt = [basePrompt, highlightsBlock, TRANSCRIPT_QUALITY_PROMPT_BLOCK]
        .filter(Boolean)
        .join('\n\n');

      const summaryText = await this.generateSummary(
        summaryPrompt,
        fullTranscript,
        signal,
        costSession,
      );

      let summaryData = {
        suggestedTitle: '',
        summary: '',
        keyPoints: [] as string[],
        actionItems: [] as string[],
        emoji: '📝',
      };

      const KNOWN_KEYS = new Set([
        'suggestedTitle',
        'summary',
        'keyPoints',
        'actionItems',
        'emoji',
        'highlights',
        'transcriptQualityNotes',
      ]);
      const customFields: Record<string, unknown> = {};
      let rawHighlights: unknown;
      let rawQualityNotes: unknown;

      // Pi-ai's unified API doesn't pass through Gemini's responseMimeType
      // knob, so models can wrap the JSON in ```json``` fences or add leading
      // chatter. Strip a single fenced block if present, otherwise feed the
      // raw text to JSON.parse and fall back to a regex extract.
      const stripJsonFences = (text: string): string => {
        const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        return fenced ? fenced[1].trim() : text.trim();
      };

      try {
        const parsed = JSON.parse(stripJsonFences(summaryText));
        summaryData = parsed;
        rawHighlights = (parsed as { highlights?: unknown }).highlights;
        rawQualityNotes = (parsed as { transcriptQualityNotes?: unknown }).transcriptQualityNotes;

        // Extract custom fields (any keys not in the known set)
        for (const [key, value] of Object.entries(parsed)) {
          if (!KNOWN_KEYS.has(key)) {
            customFields[key] = value;
          }
        }
      } catch (e) {
        console.error('Error parsing summary JSON:', e);
        // Try to extract manually
        const summaryMatch = summaryText.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
        if (summaryMatch) {
          summaryData.summary = summaryMatch[1].replace(/\\n/g, '\n');
        }
      }

      const highlights = mergeHighlights(liveNotes, rawHighlights);

      // Persist the final-stage quality picture on the note (meta.json
      // customFields) when the analyzer, summary review, or cleanup reports
      // an artifact.
      const modelQualityNotes = normalizeTranscriptQualityNotes(rawQualityNotes);
      if (assembledQuality.flagged || modelQualityNotes.length > 0 || cleanup.removedChars > 0) {
        customFields.transcriptQuality = {
          ...(assembledQuality.flagged
            ? {
                analyzer: {
                  reasons: assembledQuality.reasons,
                  metrics: assembledQuality.metrics,
                },
              }
            : {}),
          ...(modelQualityNotes.length > 0 ? { modelNotes: modelQualityNotes } : {}),
          ...(cleanup.removedChars > 0
            ? { modelCleanup: { removedChars: cleanup.removedChars } }
            : {}),
        };
      }

      if (progressCallback) {
        progressCallback(95, 'Finalizing results...');
      }

      return attachCost(
        {
          transcript: fullTranscript,
          summary: summaryData.summary,
          keyPoints: summaryData.keyPoints,
          actionItems: summaryData.actionItems,
          emoji: summaryData.emoji,
          suggestedTitle: summaryData.suggestedTitle,
          customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
          highlights,
        },
        costSession,
      );
    } catch (error) {
      console.error('Error in two-step transcription:', error);
      throw error;
    }
  }

  // Get transcript for short audio files
  private async getShortAudioTranscript(
    audioFilePath: string,
    audioSeconds: number,
    progressCallback?: (percent: number, message: string) => void,
    customPrompt?: string,
    signal?: AbortSignal,
    session?: CostSession,
    includeGlossary = true,
    qualityRetry = true,
  ): Promise<string> {
    try {
      const stats = await fs.promises.stat(audioFilePath);
      const fileSizeInMB = stats.size / (1024 * 1024);

      if (progressCallback) {
        progressCallback(20, 'Processing audio file...');
      }

      // Energy gate: provably silent audio never reaches a provider (issue
      // #182 H1). Whole-file callers surface the typed error as a friendly
      // "no speech" message; live snippets map it to an empty result.
      const maxVolumeDb = await this.measureMaxVolumeDb(audioFilePath, signal);
      if (maxVolumeDb !== null && maxVolumeDb < SILENT_SEGMENT_MAX_VOLUME_DB) {
        console.error(
          `[transcript-quality] audio is silent (max_volume ${maxVolumeDb} dB); skipping transcription`,
        );
        throw new EmptyTranscriptionError('Audio contains no signal above the silence floor');
      }

      const transcriptPrompt = `${includeGlossary ? this.buildGlossaryBlock() : ''}${customPrompt ?? DEFAULT_TRANSCRIPT_PROMPT}`;
      if (this.provider === 'codex') {
        const runCodex = async (prompt: string, temperature?: number): Promise<string> => {
          const text = await transcribeCodexAudio({
            getToken: () => this.getCodexToken(),
            audioFilePath,
            model: this.codexTranscriptionModel,
            // `prompt` is dropped inside transcribeCodexAudio when the
            // diarize model is active. Keep passing it -- the helper picks
            // the right shape per model.
            prompt,
            temperature,
            // Intentionally NOT passing `language: 'ko'`. Whisper-derived
            // transcription auto-detects from the first ~30s, which handles
            // bilingual/code-switched meetings (Korean primary, English
            // acronyms/quotes) better than forcing a single language.
            signal,
          });
          recordCodexSttUsage(session, this.codexTranscriptionModel, audioSeconds);
          return text;
        };
        const gated = await applyTranscriptQualityGate({
          text: stripNoSpeechSentinel(await runCodex(transcriptPrompt)),
          label: 'short audio (codex)',
          retry: qualityRetry
            ? () =>
                runCodex(QUALITY_RETRY_TRANSCRIPT_PROMPT, QUALITY_RETRY_TEMPERATURE)
                  .then(stripNoSpeechSentinel)
                  .catch(emptyTranscriptionAsBlank)
            : undefined,
          log: (message) => console.error(message),
        });
        if (!gated.text.trim()) {
          throw new EmptyTranscriptionError('Transcription produced no speech content');
        }
        return gated.text;
      }

      const ai = this.gemini();

      // Use Files API for files over 20MB
      let fileUri: string | null = null;
      if (fileSizeInMB > 20) {
        console.error('File is over 20MB, using Files API for upload...');

        if (progressCallback) {
          progressCallback(25, 'Uploading large file to Gemini...');
        }

        const mimeType = mimeTypeForExtension(path.extname(audioFilePath));

        const fileData = await fs.promises.readFile(audioFilePath);
        const uploadResult = await ai.files.upload({
          file: new Blob([fileData], { type: mimeType }),
          config: { abortSignal: signal },
        });

        fileUri = uploadResult.uri || '';

        // Wait for file to be active
        let file = await ai.files.get({
          name: uploadResult.name || '',
          config: { abortSignal: signal },
        });
        let retries = 0;
        while (file.state === 'PROCESSING' && retries < 30) {
          signal?.throwIfAborted();
          console.error(`Waiting for file to be processed... (attempt ${retries + 1}/30)`);
          await abortableDelay(2000, signal);
          file = await ai.files.get({
            name: uploadResult.name || '',
            config: { abortSignal: signal },
          });
          retries++;
        }

        if (file.state !== 'ACTIVE') {
          throw new Error(`File is not active. State: ${file.state}`);
        }
      }

      if (progressCallback) {
        progressCallback(50, 'Transcribing audio...');
      }

      const runGemini = (prompt: string, temperature?: number): Promise<string> =>
        this.generateGeminiTranscript(audioFilePath, fileUri, prompt, signal, session, temperature);
      const gated = await applyTranscriptQualityGate({
        text: stripNoSpeechSentinel(await runGemini(transcriptPrompt)),
        label: 'short audio (gemini)',
        retry: qualityRetry
          ? () =>
              runGemini(QUALITY_RETRY_TRANSCRIPT_PROMPT, QUALITY_RETRY_TEMPERATURE).then(
                stripNoSpeechSentinel,
              )
          : undefined,
        log: (message) => console.error(message),
      });
      if (!gated.text.trim()) {
        throw new EmptyTranscriptionError('Transcription produced no speech content');
      }
      return gated.text;
    } catch (error) {
      console.error('Error transcribing short audio:', error);
      throw error;
    }
  }

  // Single Gemini generateContent transcription call. Shared by the first
  // attempt and the context-cleared quality retry so both go through the
  // exact same request shape (inline data under 20MB, files API above).
  private async generateGeminiTranscript(
    audioFilePath: string,
    fileUri: string | null,
    promptText: string,
    signal?: AbortSignal,
    session?: CostSession,
    temperature = 0.2,
  ): Promise<string> {
    const ai = this.gemini();
    const mimeType = mimeTypeForExtension(path.extname(audioFilePath));
    let mediaPart:
      | { fileData: { fileUri: string; mimeType: string } }
      | { inlineData: { mimeType: string; data: string } };
    if (fileUri) {
      mediaPart = { fileData: { fileUri, mimeType } };
    } else {
      const audioData = await fs.promises.readFile(audioFilePath);
      mediaPart = { inlineData: { mimeType, data: audioData.toString('base64') } };
    }

    const result = await ai.models.generateContent({
      model: this.flashModel,
      contents: [
        {
          role: 'user',
          parts: [mediaPart, { text: promptText }],
        },
      ],
      config: {
        temperature,
        maxOutputTokens: 32768,
        abortSignal: signal,
      },
    });

    recordGeminiUsage(session, this.flashModel, result.usageMetadata);
    return result.text || '';
  }

  // Format time in HH:MM:SS format
  private formatTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  // Create segment header with time range
  private createSegmentHeader(
    segmentIndex: number,
    segmentStartTime: number,
    segmentEndTime: number,
  ): string {
    return `[Segment ${segmentIndex + 1}: ${this.formatTime(segmentStartTime)} ~ ${this.formatTime(segmentEndTime)}]\n\n`;
  }

  // Create prompt for segment transcription
  private createSegmentPrompt(
    segmentIndex: number,
    totalSegments: number,
    customPrompt?: string,
    includeGlossary = true,
  ): string {
    const positional = `[Audio segment ${segmentIndex + 1} of ${totalSegments}]\n\n`;
    const body = customPrompt ?? DEFAULT_TRANSCRIPT_PROMPT;
    return `${includeGlossary ? this.buildGlossaryBlock() : ''}${positional}${body}`;
  }

  // One raw provider transcription call for a segment file. Shared by the
  // first attempt and the context-cleared quality retry.
  private async transcribeSegmentRaw(
    segmentFile: string,
    promptText: string,
    segmentSeconds: number,
    signal?: AbortSignal,
    session?: CostSession,
    // Undefined on first attempts: codex then omits the field entirely
    // (provider default, exactly as before) and gemini falls back to 0.2.
    // Only the quality retry passes an explicit raised value.
    temperature?: number,
  ): Promise<string> {
    if (this.provider === 'codex') {
      const transcript = await transcribeCodexAudio({
        getToken: () => this.getCodexToken(),
        audioFilePath: segmentFile,
        model: this.codexTranscriptionModel,
        prompt: promptText,
        temperature,
        signal,
      });
      recordCodexSttUsage(session, this.codexTranscriptionModel, segmentSeconds);
      return transcript;
    }

    const audioData = await fs.promises.readFile(segmentFile);
    const base64Audio = audioData.toString('base64');
    const mimeType = mimeTypeForExtension(path.extname(segmentFile));

    const result = await this.gemini().models.generateContent({
      model: this.flashModel,
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                mimeType: mimeType,
                data: base64Audio,
              },
            },
            { text: promptText },
          ],
        },
      ],
      config: {
        temperature: temperature ?? 0.2,
        maxOutputTokens: 32768,
        abortSignal: signal,
      },
    });

    recordGeminiUsage(session, this.flashModel, result.usageMetadata);
    return result.text || '';
  }

  // Transcribe a single segment with retry logic
  private async transcribeSingleSegment(
    segmentFile: string,
    segmentIndex: number,
    totalSegments: number,
    segmentStartTime: number,
    segmentEndTime: number,
    customPrompt?: string,
    signal?: AbortSignal,
    session?: CostSession,
    includeGlossary = true,
    qualityRetry = true,
  ): Promise<{ index: number; header: string; body: string; empty: boolean }> {
    const maxRetries = 3;
    let lastError: any = null;
    let attemptsMade = 0;
    const segmentPrompt = this.createSegmentPrompt(
      segmentIndex,
      totalSegments,
      customPrompt,
      includeGlossary,
    );
    const segmentSeconds = Math.max(0, segmentEndTime - segmentStartTime);
    const segmentHeader = this.createSegmentHeader(segmentIndex, segmentStartTime, segmentEndTime);

    // Energy gate: provably silent segments never reach a provider. Cheap
    // local decode, and the strongest possible evidence -- no audio signal
    // means any transcript would be hallucinated (issue #182 H1).
    const maxVolumeDb = await this.measureMaxVolumeDb(segmentFile, signal);
    if (maxVolumeDb !== null && maxVolumeDb < SILENT_SEGMENT_MAX_VOLUME_DB) {
      console.error(
        `[transcript-quality] segment ${segmentIndex + 1}/${totalSegments} is silent ` +
          `(max_volume ${maxVolumeDb} dB); skipping transcription`,
      );
      return { index: segmentIndex, header: segmentHeader, body: '', empty: true };
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      attemptsMade = attempt;
      signal?.throwIfAborted();
      try {
        console.error(
          `Starting transcription for segment ${segmentIndex + 1}/${totalSegments} (attempt ${attempt}/${maxRetries})...`,
        );

        const raw = stripNoSpeechSentinel(
          await this.transcribeSegmentRaw(
            segmentFile,
            segmentPrompt,
            segmentSeconds,
            signal,
            session,
          ),
        );

        console.error(`Completed transcription for segment ${segmentIndex + 1}/${totalSegments}`);

        // Repetition/hallucination gate (issue #182): flagged output gets one
        // context-cleared retry; a still-flagged retry keeps the first result.
        const gated = await applyTranscriptQualityGate({
          text: raw,
          label: `segment ${segmentIndex + 1}/${totalSegments}`,
          retry: qualityRetry
            ? () =>
                this.transcribeSegmentRaw(
                  segmentFile,
                  QUALITY_RETRY_TRANSCRIPT_PROMPT,
                  segmentSeconds,
                  signal,
                  session,
                  QUALITY_RETRY_TEMPERATURE,
                )
                  .then(stripNoSpeechSentinel)
                  .catch(emptyTranscriptionAsBlank)
            : undefined,
          log: (message) => console.error(message),
        });

        return {
          index: segmentIndex,
          header: segmentHeader,
          body: gated.text,
          empty: gated.text.trim().length === 0,
        };
      } catch (segmentError) {
        // Abort surfaces here too; don't burn through retries when the caller
        // cancelled. Re-throw so getSegmentedTranscript's Promise.all rejects
        // immediately.
        if (signal?.aborted) throw segmentError;

        // A silent segment is a normal part of long recordings (breaks,
        // empty tails) -- keep the time-range header, emit no text, and
        // don't fail or retry the segment.
        if (segmentError instanceof EmptyTranscriptionError) {
          console.error(
            `Segment ${segmentIndex + 1}/${totalSegments} contained no intelligible speech; leaving it empty.`,
          );
          return { index: segmentIndex, header: segmentHeader, body: '', empty: true };
        }
        lastError = segmentError;
        console.error(
          `Error transcribing segment ${segmentIndex + 1} (attempt ${attempt}/${maxRetries}):`,
          segmentError,
        );

        // Non-retryable upstream errors: 4xx (except 429 rate-limit and 408
        // request-timeout) come from invalid input / auth / billing /
        // wrong model id and won't change on retry. Burning two more API
        // calls just to fail the same way wastes the user's quota and
        // delays the error dialog. 5xx and network errors keep the retry.
        if (
          segmentError instanceof TranscriptionApiError &&
          !isRetryableStatus(segmentError.status)
        ) {
          console.error(
            `Segment ${segmentIndex + 1} hit non-retryable status ${segmentError.status}; aborting retries.`,
          );
          break;
        }

        if (attempt < maxRetries) {
          // Wait before retry with exponential backoff
          const retryDelay = Math.min(1000 * 2 ** (attempt - 1), 10000); // Max 10 seconds
          console.error(`Retrying segment ${segmentIndex + 1} in ${retryDelay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
        }
      }
    }

    // Throw on retry exhaustion. Returning a `[Segment N transcription
    // failed]` placeholder here would let an entirely-failed run look
    // like a success to the renderer.
    console.error(
      `Failed to transcribe segment ${segmentIndex + 1} after ${attemptsMade} attempt${attemptsMade === 1 ? '' : 's'}:`,
      lastError,
    );
    if (lastError instanceof Error) throw lastError;
    throw new Error(
      lastError !== null && lastError !== undefined
        ? `Segment ${segmentIndex + 1} transcription failed: ${String(lastError)}`
        : `Segment ${segmentIndex + 1} transcription failed after ${attemptsMade} attempt${attemptsMade === 1 ? '' : 's'}`,
    );
  }

  // Get segmented transcript (renamed from transcribeAudioSegmented)
  private async getSegmentedTranscript(
    audioFilePath: string,
    duration: number,
    progressCallback?: (percent: number, message: string) => void,
    customPrompt?: string,
    segmentDuration = 300,
    signal?: AbortSignal,
    session?: CostSession,
    includeGlossary = true,
    qualityRetry = true,
  ): Promise<string> {
    // Track segments outside the try so the finally can clean them up on
    // abort / mid-pipeline failure too. Without this, cancelled transcribes
    // leave `<base>_segment_NNN.<ext>` files piling up in recordings/.
    let segmentFiles: string[] = [];
    try {
      signal?.throwIfAborted();
      // Split audio into 5-minute segments. Codex transcription requires
      // accurate cut times (gpt-4o-transcribe rejects >1400s/segment), so
      // force re-encode there; Gemini's API tolerates long inputs and we
      // keep the cheaper `-c copy` path for it.
      segmentFiles = await this.splitAudioIntoSegments(
        audioFilePath,
        segmentDuration,
        this.provider === 'codex',
        signal,
        duration,
      );

      signal?.throwIfAborted();

      if (progressCallback) {
        progressCallback(20, `Processing ${segmentFiles.length} segments...`);
      }

      // Shared abort: when one segment fails fast (e.g. 4xx on segment 0),
      // cancel the sibling fetches so we don't burn the user's quota on
      // results that will be thrown away. Combined with the caller's signal
      // via AbortSignal.any so a user-driven cancel also fans out to every
      // in-flight segment.
      const aborter = new AbortController();
      const combinedSignal = signal ? AbortSignal.any([signal, aborter.signal]) : aborter.signal;

      const transcriptionPromises = segmentFiles.map((segmentFile, i) => {
        const segmentStartTime = i * segmentDuration;
        const segmentEndTime = Math.min(segmentStartTime + segmentDuration, duration);
        return this.transcribeSingleSegment(
          segmentFile,
          i,
          segmentFiles.length,
          segmentStartTime,
          segmentEndTime,
          customPrompt,
          combinedSignal,
          session,
          includeGlossary,
          qualityRetry,
        ).catch((err) => {
          aborter.abort();
          throw err;
        });
      });

      // Track progress of concurrent transcriptions
      let completedCount = 0;
      const progressTrackedPromises = transcriptionPromises.map((promise) =>
        promise.then((result) => {
          completedCount++;
          if (progressCallback) {
            const progress = 20 + (completedCount / segmentFiles.length) * 60; // 20-80% range
            progressCallback(
              progress,
              `Transcribed ${completedCount} of ${segmentFiles.length} segments...`,
            );
          }
          return result;
        }),
      );

      // Wait for all transcriptions to complete. Any segment that exhausts
      // retries (or hits a non-retryable status) throws from
      // transcribeSingleSegment, which rejects Promise.all -- so if we
      // reach the next line, every segment succeeded.
      let segmentResults: { index: number; header: string; body: string; empty: boolean }[];
      try {
        segmentResults = await Promise.all(progressTrackedPromises);
      } finally {
        // Always clean up segment temp files, even when a segment failed
        // and the function is about to throw.
        await Promise.all(
          segmentFiles.map(async (segmentFile) => {
            try {
              fs.unlinkSync(segmentFile);
            } catch (e) {
              console.error(`Failed to delete segment file: ${segmentFile}`, e);
            }
          }),
        );
      }

      // Sort by index to maintain order
      segmentResults.sort((a, b) => a.index - b.index);

      // Update progress
      if (progressCallback) {
        progressCallback(80, 'All segments transcribed, merging results...');
      }

      // A recording where EVERY segment came back silent has no speech at
      // all -- surface the same friendly no-speech error the short path
      // uses instead of saving a note of bare segment headers.
      if (segmentResults.length > 0 && segmentResults.every((result) => result.empty)) {
        throw new EmptyTranscriptionError('All segments produced no speech content');
      }

      // Boundary reconciliation: segments were cut with head overlap, so the
      // same boundary speech appears at the tail of segment N and the head
      // of segment N+1. Drop the evidenced duplicate from the later segment
      // before joining. Logs carry char counts only, never transcript text.
      const { bodies: reconciledBodies, removedPerBoundary } = reconcileOverlappingSegments(
        segmentResults.map((result) => result.body),
      );
      removedPerBoundary.forEach((removed, i) => {
        if (removed > 0) {
          console.error(
            `[transcript-quality] boundary ${i + 1}/${i + 2}: removed ${removed} overlap chars`,
          );
        }
      });

      // Merge all transcripts with clear segment breaks
      return segmentResults
        .map((result, i) => result.header + reconciledBodies[i])
        .join('\n\n---\n\n');
    } catch (error) {
      console.error('Error in segmented transcription:', error);
      throw error;
    } finally {
      // Clean up segment files regardless of outcome (success, error, abort).
      // On the happy path `segmentFiles` is authoritative; on abort/error
      // before split returned we re-scan because ffmpeg may have written
      // partial segments that never made it into the array. Best-effort:
      // missing/locked files shouldn't crash the pipeline.
      const toDelete =
        segmentFiles.length > 0 ? segmentFiles : this.findSegmentFiles(audioFilePath);
      for (const segmentFile of toDelete) {
        try {
          fs.unlinkSync(segmentFile);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException | null)?.code;
          if (code !== 'ENOENT') {
            console.error(`Failed to delete segment file: ${segmentFile}`, e);
          }
        }
      }
    }
  }
}
