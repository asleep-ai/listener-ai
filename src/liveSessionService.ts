import * as fs from 'fs';
import * as path from 'path';
import { extensionForMimeType } from './audioFormats';
import type { AgentChatMessage, AgentRunResult, AgentService } from './agentService';
import {
  type LiveSttProvider,
  DEFAULT_GEMINI_LIVE_TRANSCRIPTION_MODEL,
  DEFAULT_GEMINI_LIVE_TRANSLATION_MODEL,
  DEFAULT_OPENAI_LIVE_TRANSCRIPTION_MODEL,
  DEFAULT_OPENAI_LIVE_TRANSLATION_MODEL,
  SONIOX_REALTIME_MODEL,
} from './aiProvider';
import type { GeminiService } from './geminiService';
import {
  createLiveSttSession,
  type LiveSttProviderConfig,
  type LiveSttSession,
  type StreamingLiveSttProvider,
} from './liveSttProvider';
import { recordUsage, type RecordInput } from './services/usageTracker';
import {
  analyzeTranscriptQuality,
  normalizeForComparison,
  stripSpeakerLabel,
} from './transcriptQuality';

export interface LiveTranscriptSegment {
  id: string;
  offsetMs: number;
  durationMs: number;
  transcript: string;
  translation?: string;
  translationError?: string;
  final: boolean;
  createdAt: string;
  /**
   * Set when the repetition/hallucination analyzer flagged this final
   * (issue #182). The text is kept -- deletion without audio evidence is
   * unsafe -- but consumers can render or weigh it as uncertain.
   */
  quality?: { flagged: boolean; reasons: string[] };
}

export interface LiveSessionStartResult {
  sessionId: string;
  title: string;
  startedAt: string;
  translate: boolean;
  mode: 'streaming' | 'chunked';
  provider: StreamingLiveSttProvider | 'chunked';
  realtimeClient?: LiveRealtimeClientConfig;
}

/**
 * Why a live session ended. `renderer-lost` means main closed the provider
 * because the window that captures the session's audio reloaded or crashed.
 */
export type LiveSessionEndReason = 'user' | 'renderer-lost';

export interface LiveSessionSnapshot {
  sessionId: string;
  title: string;
  startedAt: string;
  /** False from the moment a stop begins, while finals may still flush. */
  active: boolean;
  /** Set once the session has stopped or begun stopping. Absent = never stopped. */
  endedReason?: LiveSessionEndReason;
  translate: boolean;
  mode: 'streaming' | 'chunked';
  provider: StreamingLiveSttProvider | 'chunked';
  segments: LiveTranscriptSegment[];
  interimTranscript: string;
  interimTranslation: string;
  transcript: string;
  translation: string;
}

export type LiveSessionEvent =
  | {
      type: 'status';
      sessionId: string;
      status: string;
      mode?: 'streaming' | 'chunked';
      provider?: StreamingLiveSttProvider | 'chunked';
    }
  | { type: 'interim'; sessionId: string; text: string; offsetMs?: number }
  | { type: 'translationInterim'; sessionId: string; text: string; offsetMs?: number }
  | { type: 'segment'; sessionId: string; segment: LiveTranscriptSegment }
  | { type: 'error'; sessionId: string; error: string };

export interface LiveRealtimeClientConfig {
  transport: 'webrtc';
  endpoint: 'realtime' | 'translation';
  clientSecret: string;
}

// The session was stopped or replaced while it was still starting (for
// example, its window reloaded while the provider was connecting).
export class LiveSessionEndedError extends Error {
  constructor(message = 'Live session ended before it finished starting.') {
    super(message);
    this.name = 'LiveSessionEndedError';
  }
}

// The chunked fallback cannot run as configured. Raised instead of reporting
// captions that every later chunk would fail; the message is actionable.
export class LiveChunkedCaptionsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveChunkedCaptionsUnavailableError';
  }
}

export interface LiveSessionServiceOptions {
  getDataPath(): string;
  /** Text tasks (translation, Q&A). Null without text-provider credentials. */
  ensureGeminiService(): GeminiService | null;
  /**
   * Chunked snippet transcription on the batch STT backend, which can be
   * configured without text-provider credentials. Defaults to
   * `ensureGeminiService`.
   */
  ensureTranscriptionService?(): GeminiService | null;
  /**
   * Why chunked snippets cannot be transcribed on the batch STT backend (null
   * when they can). Translation is not part of it: a caption the text provider
   * cannot translate keeps a per-segment `translationError`. Absent = always
   * available.
   */
  getChunkedCaptionsIssue?(): string | null;
  getAgentService(): AgentService | null;
  formatAiCredentialsError(): string;
  getLiveSttConfig(): LiveSttProviderConfig;
  emitEvent?(event: LiveSessionEvent): void;
  /**
   * Called when whether a live session is running changes. Main uses it to keep
   * a hidden or minimized window's capture from being throttled.
   */
  onActiveChange?(active: boolean): void;
  createLiveSttSession?(
    config: LiveSttProviderConfig,
    callbacks: Parameters<typeof createLiveSttSession>[1],
  ): Promise<LiveSttSession | null>;
  createRealtimeClientConfig?(
    config: LiveSttProviderConfig,
  ): Promise<LiveRealtimeClientConfig | null>;
  recordUsage?(input: RecordInput): void;
  now?(): number;
}

type LiveSessionState = {
  id: string;
  title: string;
  startedAt: string;
  active: boolean;
  translate: boolean;
  mode: 'streaming' | 'chunked';
  provider: StreamingLiveSttProvider | 'chunked';
  abortController: AbortController;
  nextSegmentId: number;
  segments: LiveTranscriptSegment[];
  interimTranscript: string;
  interimTranslation: string;
  stream: LiveSttSession | null;
  realtimeClient: LiveRealtimeClientConfig | null;
  usageModelId: string | null;
  usageRecorded: boolean;
  /** The stream itself returns the translation, so no Gemini call per final. */
  nativeTranslation: boolean;
  lastFinal?: { normalized: string; atMs: number };
  endedReason?: LiveSessionEndReason;
  stopping?: Promise<LiveSessionSnapshot | null>;
};

// Exact-duplicate suppression for live finals (issue #182): a provider stuck
// on silence/noise can emit the same phrase once per commit/window. Only a
// final whose normalized text EXACTLY matches the immediately previous final
// within this window is dropped -- fuzzy dedupe without timestamp/audio
// evidence risks deleting real speech, so it is intentionally not done here.
const LIVE_DUPLICATE_WINDOW_MS = 30_000;
// Very short finals ("네", "맞아요") legitimately repeat in conversation;
// only suppress duplicates long enough to be unlikely as natural echoes.
const LIVE_DUPLICATE_MIN_CHARS = 6;

function asBuffer(data: ArrayBuffer | Uint8Array): Buffer {
  if (data instanceof Uint8Array) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  return Buffer.from(data);
}

function cleanTranscript(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n\n')
    .trim();
}

function isAbortError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'name' in error) {
    return (error as { name?: unknown }).name === 'AbortError';
  }
  return false;
}

function joinSegments(
  segments: LiveTranscriptSegment[],
  field: 'transcript' | 'translation',
): string {
  return segments
    .map((s) => s[field]?.trim() ?? '')
    .filter((text) => text.length > 0)
    .join('\n\n');
}

function resolveLiveUsageModelId(
  config: LiveSttProviderConfig,
  provider: StreamingLiveSttProvider,
  kind: 'transcription' | 'translation',
): string {
  if (provider === 'openai') {
    return kind === 'translation'
      ? config.openaiLiveTranslationModel || DEFAULT_OPENAI_LIVE_TRANSLATION_MODEL
      : config.openaiLiveTranscriptionModel || DEFAULT_OPENAI_LIVE_TRANSCRIPTION_MODEL;
  }
  // One realtime model covers both kinds; translation rides the same stream.
  if (provider === 'soniox') return SONIOX_REALTIME_MODEL;
  return kind === 'translation'
    ? DEFAULT_GEMINI_LIVE_TRANSLATION_MODEL
    : DEFAULT_GEMINI_LIVE_TRANSCRIPTION_MODEL;
}

const LIVE_TRANSLATION_LANGUAGE_NAMES: Record<string, string> = {
  ko: 'Korean',
  en: 'English',
  ja: 'Japanese',
  zh: 'Chinese',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  ru: 'Russian',
  vi: 'Vietnamese',
  th: 'Thai',
  id: 'Indonesian',
  hi: 'Hindi',
  ar: 'Arabic',
};

// Provider ids are internal identifiers; a status line the user reads spells
// them the way the vendor does.
const LIVE_PROVIDER_DISPLAY_NAMES: Record<Exclude<LiveSttProvider, 'auto'>, string> = {
  openai: 'OpenAI',
  gemini: 'Gemini',
  soniox: 'Soniox',
  chunked: 'chunked fallback',
};

// The live translation target is stored as a BCP-47 code (e.g. `ja`) but the
// chunked-fallback translator prompt reads better with a language name. Map
// known codes to names and pass through anything already spelled out.
function resolveLiveTranslationTarget(language: string | undefined): string {
  const value = language?.trim();
  if (!value) return 'Korean';
  return LIVE_TRANSLATION_LANGUAGE_NAMES[value.toLowerCase()] ?? value;
}

export class LiveSessionService {
  private readonly opts: LiveSessionServiceOptions;
  private session: LiveSessionState | null = null;
  private notifiedActive = false;
  private rendererGeneration = 0;

  constructor(opts: LiveSessionServiceOptions) {
    this.opts = opts;
  }

  async start(
    input: { title?: string; translate?: boolean } = {},
  ): Promise<LiveSessionStartResult> {
    const rendererGeneration = this.rendererGeneration;
    // Replace a running session through the same settlement as stop(), so a
    // replacement racing a renderer-lost teardown never closes a stream twice.
    // Loop: another start may have installed a session while this one waited.
    for (let current = this.session; current?.active; current = this.session) {
      await this.stop(current.id, 'user');
    }
    if (rendererGeneration !== this.rendererGeneration) throw new LiveSessionEndedError();
    const startedAt = new Date(this.opts.now?.() ?? Date.now()).toISOString();
    const session: LiveSessionState = {
      id: `live_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      title: input.title?.trim() || 'Live Session',
      startedAt,
      active: true,
      translate: input.translate !== false,
      mode: 'chunked',
      provider: 'chunked',
      abortController: new AbortController(),
      nextSegmentId: 0,
      segments: [],
      interimTranscript: '',
      interimTranslation: '',
      stream: null,
      realtimeClient: null,
      usageModelId: null,
      usageRecorded: false,
      nativeTranslation: false,
    };
    this.session = session;
    try {
      return await this.startSession(session);
    } catch (error) {
      // A failed start leaves no running session; don't report it as active.
      // A stop that ended it mid-start owns the teardown.
      if (session.stopping) {
        await session.stopping;
        // Whatever failed, the session had already been ended mid-start.
        throw new LiveSessionEndedError();
      } else if (this.session === session) {
        session.active = false;
        session.abortController.abort();
        await session.stream?.close().catch(() => {});
        session.stream = null;
        this.recordLiveUsage(session);
      }
      throw error;
    } finally {
      this.notifyActiveChange();
    }
  }

  private async startSession(session: LiveSessionState): Promise<LiveSessionStartResult> {
    let config = { ...this.opts.getLiveSttConfig(), translate: session.translate };
    // The realtime client-secret path is OpenAI's; `soniox` and `chunked` never
    // route through it.
    if (
      config.provider !== 'chunked' &&
      config.provider !== 'soniox' &&
      this.opts.createRealtimeClientConfig
    ) {
      try {
        session.realtimeClient = await this.opts.createRealtimeClientConfig(config);
        this.assertStillStarting(session);
      } catch (error) {
        if (error instanceof LiveSessionEndedError) throw error;
        if (config.provider === 'openai') throw error;
        if (config.provider === 'auto') {
          // Realtime client-secret/WebRTC is the supported OpenAI live path.
          // If it fails in auto mode, continue to Gemini or chunked fallback
          // instead of trying the lower-level OpenAI WebSocket fallback.
          config = { ...config, openaiApiKey: undefined };
        }
        this.handleStreamError(session, error);
      }
    }
    if (!session.realtimeClient) {
      try {
        await this.startStreamingProvider(session, config);
      } catch (error) {
        if (error instanceof LiveSessionEndedError) throw error;
        const recovered = await this.tryProviderFallbackAfterStartFailure(session, config, error);
        if (!recovered) throw error;
      }
    } else {
      this.setRealtimeProvider(session, config);
    }
    if (session.mode === 'chunked') this.assertChunkedCaptionsAvailable(session);
    // A stop during a failed provider attempt must not announce captions.
    this.assertStillStarting(session);
    this.emit({
      type: 'status',
      sessionId: session.id,
      status:
        session.mode === 'streaming'
          ? `Listening with ${session.provider} live transcription...`
          : 'Listening with chunked fallback transcription...',
      mode: session.mode,
      provider: session.provider,
    });
    return this.startResult(session);
  }

  async fallbackFromRealtime(input: {
    sessionId: string;
    error?: string;
  }): Promise<LiveSessionStartResult> {
    const session = this.session;
    if (!session || session.id !== input.sessionId)
      throw new Error('Live session is no longer active.');
    this.assertStillStarting(session);
    if (!session.realtimeClient) return this.startResult(session);

    session.realtimeClient = null;
    session.usageModelId = null;
    if (input.error?.trim()) {
      this.handleStreamError(session, new Error(`OpenAI Realtime WebRTC failed: ${input.error}`));
    }

    const baseConfig = { ...this.opts.getLiveSttConfig(), translate: session.translate };
    for (const config of this.buildRealtimeFallbackConfigs(baseConfig)) {
      try {
        await this.startStreamingProvider(session, config);
        if (session.stream) {
          this.emit({
            type: 'status',
            sessionId: session.id,
            status: `OpenAI Realtime unavailable; using ${session.provider} live transcription.`,
            mode: session.mode,
            provider: session.provider,
          });
          return this.startResult(session);
        }
      } catch (error) {
        if (error instanceof LiveSessionEndedError) throw error;
        this.assertStillStarting(session);
        this.handleStreamError(session, error);
      }
    }

    this.assertStillStarting(session);
    session.mode = 'chunked';
    session.provider = 'chunked';
    session.usageModelId = null;
    this.assertChunkedCaptionsAvailable(session);
    this.emit({
      type: 'status',
      sessionId: session.id,
      status: 'OpenAI Realtime unavailable; using chunked fallback transcription.',
      mode: session.mode,
      provider: session.provider,
    });
    return this.startResult(session);
  }

  async stop(
    sessionId: string,
    reason: LiveSessionEndReason = 'user',
  ): Promise<LiveSessionSnapshot | null> {
    const session = this.session;
    if (!session || session.id !== sessionId) return null;
    // A stop already in flight (the renderer's own stop racing a renderer-lost
    // teardown) owns the close. Renderer loss promotes a draining user stop
    // so its retained finals can be recovered after reload.
    if (session.stopping) {
      if (reason === 'renderer-lost') session.endedReason = reason;
      return session.stopping;
    }
    if (!session.active) return this.snapshot();
    session.endedReason = reason;
    session.stopping = this.finishStop(session);
    return session.stopping;
  }

  /**
   * Ends whatever session is running, for a caller that has no session id --
   * main, when the renderer feeding the session's audio is gone.
   */
  async stopActive(reason: LiveSessionEndReason): Promise<LiveSessionSnapshot | null> {
    if (reason === 'renderer-lost') this.rendererGeneration++;
    const session = this.session;
    // `active` stays true until an in-flight stop finishes, so a teardown that
    // races the renderer's own stop joins it instead of returning early.
    if (!session || !session.active) return null;
    return this.stop(session.id, reason);
  }

  isActive(): boolean {
    const session = this.session;
    return !!session && session.active && !session.stopping;
  }

  private isEnded(session: LiveSessionState): boolean {
    return (
      this.session !== session ||
      !session.active ||
      !!session.stopping ||
      session.abortController.signal.aborted
    );
  }

  private assertStillStarting(session: LiveSessionState): void {
    if (this.isEnded(session)) throw new LiveSessionEndedError();
  }

  private async finishStop(session: LiveSessionState): Promise<LiveSessionSnapshot | null> {
    // Close the stream while the session is still active so streaming providers
    // (Gemini Live, OpenAI translation) can flush their final transcript via
    // onFinal -- handleFinalTranscript drops segments once active is false.
    await session.stream?.close().catch((err) => this.handleStreamError(session, err));
    session.stream = null;
    session.active = false;
    session.abortController.abort();
    this.recordLiveUsage(session);
    this.notifyActiveChange();
    // This session's snapshot, even if a replacement start installed another.
    return this.snapshotOf(session);
  }

  private notifyActiveChange(): void {
    const active = this.isActive();
    if (active === this.notifiedActive) return;
    this.notifiedActive = active;
    this.opts.onActiveChange?.(active);
  }

  snapshot(): LiveSessionSnapshot | null {
    return this.session ? this.snapshotOf(this.session) : null;
  }

  private snapshotOf(session: LiveSessionState): LiveSessionSnapshot {
    const segments = [...session.segments].sort((a, b) => a.offsetMs - b.offsetMs);
    return {
      sessionId: session.id,
      title: session.title,
      startedAt: session.startedAt,
      active: session.active && !session.stopping,
      ...(session.endedReason ? { endedReason: session.endedReason } : {}),
      translate: session.translate,
      mode: session.mode,
      provider: session.provider,
      segments,
      interimTranscript: session.interimTranscript,
      interimTranslation: session.interimTranslation,
      transcript: joinSegments(segments, 'transcript'),
      translation: joinSegments(segments, 'translation'),
    };
  }

  appendPcm(input: {
    sessionId: string;
    audioData: ArrayBuffer | Uint8Array;
    sampleRate: number;
    channelCount: number;
    offsetMs: number;
    durationMs: number;
    sequence: number;
  }): void {
    const session = this.session;
    if (!session || session.id !== input.sessionId || !session.active || !session.stream) return;
    session.stream.sendPcm(input);
  }

  private async startStreamingProvider(
    session: LiveSessionState,
    config: LiveSttProviderConfig,
  ): Promise<void> {
    this.assertStillStarting(session);
    const createSession = this.opts.createLiveSttSession ?? createLiveSttSession;
    const stream = await createSession(config, {
      onStatus: (status) => this.emit({ type: 'status', sessionId: session.id, status }),
      onInterim: (event) => this.handleInterim(session, event),
      onTranslationInterim: (event) => this.handleTranslationInterim(session, event),
      onFinal: (event) => {
        void this.handleFinalTranscript(session, event);
      },
      onError: (error) => this.handleStreamError(session, error),
    });
    // The session may have been stopped (renderer lost) or replaced while the
    // provider connected; a transport nobody will close must not stay open.
    if (this.isEnded(session)) {
      await stream?.close().catch(() => {});
      throw new LiveSessionEndedError();
    }
    session.stream = stream;
    if (!session.stream) return;
    session.mode = 'streaming';
    session.provider = session.stream.provider;
    // D6: Soniox one-way translation rides the transcription stream, so its
    // finals arrive already translated and must never cost a Gemini call.
    session.nativeTranslation =
      session.stream.provider === 'soniox' && session.stream.kind === 'translation';
    session.usageModelId = resolveLiveUsageModelId(config, session.provider, session.stream.kind);
  }

  private setRealtimeProvider(session: LiveSessionState, config: LiveSttProviderConfig): void {
    if (!session.realtimeClient) return;
    session.mode = 'streaming';
    session.provider = 'openai';
    const kind =
      session.realtimeClient.endpoint === 'translation' ? 'translation' : 'transcription';
    session.usageModelId = resolveLiveUsageModelId(config, session.provider, kind);
  }

  private buildRealtimeFallbackConfigs(config: LiveSttProviderConfig): LiveSttProviderConfig[] {
    const configs: LiveSttProviderConfig[] = [];
    if (config.openaiApiKey?.trim()) {
      configs.push({ ...config, provider: 'openai' });
    }
    if (config.geminiApiKey?.trim()) {
      configs.push({ ...config, provider: 'gemini', openaiApiKey: undefined });
    }
    return configs;
  }

  private async tryProviderFallbackAfterStartFailure(
    session: LiveSessionState,
    config: LiveSttProviderConfig,
    error: unknown,
  ): Promise<boolean> {
    this.assertStillStarting(session);
    const fallbackConfigs = this.buildRealtimeFallbackConfigs({
      ...config,
      openaiApiKey: undefined,
    });
    if (fallbackConfigs.length === 0) return false;

    // `auto` picked the provider for the user, so there is no name of theirs
    // to report; and a provider that failed and then succeeded on its own
    // fallback config must not be named on both sides of the sentence.
    const failedProvider = config.provider === 'auto' ? undefined : config.provider;
    this.handleStreamError(session, error);
    for (const fallbackConfig of fallbackConfigs) {
      try {
        await this.startStreamingProvider(session, fallbackConfig);
        if (session.stream) {
          const recoveredName = LIVE_PROVIDER_DISPLAY_NAMES[session.provider];
          const failedName =
            failedProvider !== undefined && failedProvider !== session.provider
              ? LIVE_PROVIDER_DISPLAY_NAMES[failedProvider]
              : undefined;
          this.emit({
            type: 'status',
            sessionId: session.id,
            status: failedName
              ? `${failedName} live provider unavailable; using ${recoveredName} live transcription.`
              : `Live provider unavailable; using ${recoveredName} live transcription.`,
            mode: session.mode,
            provider: session.provider,
          });
          return true;
        }
      } catch (fallbackError) {
        if (fallbackError instanceof LiveSessionEndedError) throw fallbackError;
        this.assertStillStarting(session);
        this.handleStreamError(session, fallbackError);
      }
    }
    return false;
  }

  // Ends the session instead of announcing chunked captions that every chunk
  // would then fail on. Never picks another STT backend or billing path.
  private assertChunkedCaptionsAvailable(session: LiveSessionState): void {
    const issue = this.opts.getChunkedCaptionsIssue?.() ?? null;
    if (!issue) return;
    session.active = false;
    session.abortController.abort();
    this.notifyActiveChange();
    throw new LiveChunkedCaptionsUnavailableError(
      `Live captions cannot continue with chunked transcription: ${issue}`,
    );
  }

  private startResult(session: LiveSessionState): LiveSessionStartResult {
    return {
      sessionId: session.id,
      title: session.title,
      startedAt: session.startedAt,
      translate: session.translate,
      mode: session.mode,
      provider: session.provider,
      realtimeClient: session.realtimeClient ?? undefined,
    };
  }

  setTranslate(sessionId: string, translate: boolean): LiveSessionSnapshot | null {
    const session = this.session;
    if (!session || session.id !== sessionId) return null;
    session.translate = translate;
    return this.snapshot();
  }

  receiveInterim(input: {
    sessionId: string;
    text: string;
    translation?: boolean;
    offsetMs?: number;
  }): void {
    const session = this.session;
    if (!session || session.id !== input.sessionId || !session.active) return;
    if (input.translation) {
      this.handleTranslationInterim(session, {
        text: input.text,
        offsetMs: input.offsetMs,
      });
      return;
    }
    this.handleInterim(session, {
      text: input.text,
      offsetMs: input.offsetMs,
    });
  }

  receiveFinalTranscript(input: {
    sessionId: string;
    text: string;
    offsetMs?: number;
    durationMs?: number;
    translation?: string;
  }): void {
    const session = this.session;
    if (!session || session.id !== input.sessionId || !session.active) return;
    void this.handleFinalTranscript(session, {
      text: input.text,
      offsetMs: input.offsetMs,
      durationMs: input.durationMs,
      translation: input.translation,
    });
  }

  async processAudioChunk(input: {
    sessionId: string;
    audioData: ArrayBuffer | Uint8Array;
    mimeType: string;
    offsetMs: number;
    durationMs: number;
    translate?: boolean;
  }): Promise<LiveTranscriptSegment | null> {
    const session = this.session;
    if (!session || session.id !== input.sessionId)
      throw new Error('Live session is no longer active.');
    if (!session.active || session.abortController.signal.aborted) return null;
    const transcriber = this.opts.ensureTranscriptionService
      ? this.opts.ensureTranscriptionService()
      : this.opts.ensureGeminiService();
    if (!transcriber) {
      throw new Error(
        this.opts.getChunkedCaptionsIssue?.() ?? this.opts.formatAiCredentialsError(),
      );
    }

    const buffer = asBuffer(input.audioData);
    if (buffer.byteLength < 512) return null;

    const tempPath = await this.writeTempSnippet(session, input.mimeType, buffer);
    try {
      if (!session.active || session.abortController.signal.aborted) return null;
      const transcript = cleanTranscript(
        await transcriber.transcribeLiveSnippet(tempPath, {
          signal: session.abortController.signal,
        }),
      );
      if (!transcript) return null;
      if (this.session !== session) throw new Error('Live session was replaced.');
      if (!session.active || session.abortController.signal.aborted) return null;
      // Duplicate check before translation so a suppressed chunk doesn't
      // spend a translation call either.
      if (this.shouldSuppressDuplicateFinal(session, transcript)) return null;
      const quality = this.qualityForFinal(transcript);

      let translation: string | undefined;
      let translationError: string | undefined;
      session.translate = input.translate !== false;
      // Translation is the only text call here; without text credentials the
      // caption stays and the segment says why it is untranslated.
      const translator = input.translate !== false ? this.opts.ensureGeminiService() : null;
      if (input.translate !== false && !translator) {
        translationError = this.opts.formatAiCredentialsError();
      } else if (translator) {
        try {
          translation = (
            await translator.translateText(transcript, {
              targetLanguage: resolveLiveTranslationTarget(
                this.opts.getLiveSttConfig().translationLanguage,
              ),
              signal: session.abortController.signal,
            })
          ).trim();
        } catch (err) {
          if (isAbortError(err) || !session.active || session.abortController.signal.aborted) {
            return null;
          }
          translationError = err instanceof Error ? err.message : String(err);
        }
      }
      if (!session.active || session.abortController.signal.aborted) return null;

      const segment: LiveTranscriptSegment = {
        id: `${session.id}_${++session.nextSegmentId}`,
        offsetMs: Math.max(0, Math.floor(input.offsetMs)),
        durationMs: Math.max(0, Math.floor(input.durationMs)),
        transcript,
        translation: translation || undefined,
        translationError,
        final: true,
        createdAt: new Date().toISOString(),
        quality,
      };
      session.segments.push(segment);
      session.segments.sort((a, b) => a.offsetMs - b.offsetMs);
      this.emit({ type: 'segment', sessionId: session.id, segment });
      return segment;
    } catch (err) {
      if (isAbortError(err) || !session.active || session.abortController.signal.aborted) {
        return null;
      }
      throw err;
    } finally {
      await fs.promises.unlink(tempPath).catch(() => {});
    }
  }

  async ask(input: {
    sessionId: string;
    question: string;
    history?: AgentChatMessage[];
  }): Promise<AgentRunResult> {
    const session = this.session;
    if (!session || session.id !== input.sessionId) {
      throw new Error('Live session is no longer active.');
    }
    const question = input.question.trim();
    if (!question) throw new Error('Empty question.');
    const snapshot = this.snapshot();
    const liveText = [
      snapshot?.transcript,
      snapshot?.interimTranscript,
      snapshot?.translation,
      snapshot?.interimTranslation,
    ]
      .filter(Boolean)
      .join('\n\n');
    if (!snapshot || !liveText.trim()) {
      throw new Error('No live transcript is available yet.');
    }
    const agent = this.opts.getAgentService();
    if (!agent) {
      throw new Error(this.opts.formatAiCredentialsError());
    }
    return await agent.run({
      question,
      history: Array.isArray(input.history) ? input.history : [],
      scope: {
        kind: 'live',
        title: snapshot.title,
        transcript: snapshot.transcript || '(no finalized transcript yet)',
        interimTranscript: snapshot.interimTranscript || undefined,
        interimTranslation: snapshot.interimTranslation || undefined,
        translation:
          [snapshot.translation, snapshot.interimTranslation].filter(Boolean).join('\n\n') ||
          undefined,
      },
    });
  }

  private emit(event: LiveSessionEvent): void {
    this.opts.emitEvent?.(event);
  }

  private handleInterim(
    session: LiveSessionState,
    event: { text: string; itemId?: string; offsetMs?: number },
  ): void {
    if (this.session !== session || !session.active || !event.text.trim()) return;
    session.interimTranscript = event.text.trim();
    this.emit({
      type: 'interim',
      sessionId: session.id,
      text: session.interimTranscript,
      offsetMs: event.offsetMs,
    });
  }

  private handleTranslationInterim(
    session: LiveSessionState,
    event: { text: string; itemId?: string; offsetMs?: number },
  ): void {
    if (this.session !== session || !session.active || !event.text.trim()) return;
    session.interimTranslation = event.text.trim();
    this.emit({
      type: 'translationInterim',
      sessionId: session.id,
      text: session.interimTranslation,
      offsetMs: event.offsetMs,
    });
  }

  // Sliding exact-duplicate guard. Records every final (suppressed or not)
  // as the new comparison point so a continuous provider loop stays
  // suppressed after its first occurrence, and any different text resets
  // the chain immediately.
  private shouldSuppressDuplicateFinal(session: LiveSessionState, transcript: string): boolean {
    const normalized = normalizeForComparison(transcript);
    // Keep speaker labels in the equality key so different speakers never
    // cross-dedupe. Exclude labels only from the length floor: labels must not
    // turn genuine short acknowledgements into suppressible content.
    const contentLength = normalizeForComparison(
      transcript.split(/\r?\n/).map(stripSpeakerLabel).join('\n'),
    ).length;
    const now = this.opts.now?.() ?? Date.now();
    const prev = session.lastFinal;
    session.lastFinal = { normalized, atMs: now };
    if (!prev || contentLength < LIVE_DUPLICATE_MIN_CHARS) return false;
    const suppress = prev.normalized === normalized && now - prev.atMs <= LIVE_DUPLICATE_WINDOW_MS;
    if (suppress) {
      // Metrics only -- never log transcript text.
      console.warn(
        `[live-quality] suppressed exact-duplicate live final (${normalized.length} chars, ${
          now - prev.atMs
        }ms after previous)`,
      );
    }
    return suppress;
  }

  private qualityForFinal(transcript: string): LiveTranscriptSegment['quality'] {
    const report = analyzeTranscriptQuality(transcript);
    if (!report.flagged) return undefined;
    console.warn(
      `[live-quality] final transcript flagged (${report.reasons.join(', ')}; ` +
        `${report.metrics.normalizedLength} chars) -- kept and marked uncertain`,
    );
    return { flagged: true, reasons: report.reasons };
  }

  private async handleFinalTranscript(
    session: LiveSessionState,
    event: {
      text: string;
      itemId?: string;
      offsetMs?: number;
      durationMs?: number;
      translation?: string;
    },
  ): Promise<void> {
    const transcript = cleanTranscript(event.text);
    if (this.session !== session || !session.active || !transcript) return;
    session.interimTranscript = '';
    session.interimTranslation = '';
    if (this.shouldSuppressDuplicateFinal(session, transcript)) return;
    const segment: LiveTranscriptSegment = {
      id: `${session.id}_${++session.nextSegmentId}`,
      offsetMs:
        typeof event.offsetMs === 'number'
          ? Math.max(0, Math.floor(event.offsetMs))
          : Math.max(0, Date.now() - new Date(session.startedAt).getTime()),
      durationMs:
        typeof event.durationMs === 'number' ? Math.max(0, Math.floor(event.durationMs)) : 0,
      transcript,
      translation: event.translation?.trim() || undefined,
      final: true,
      createdAt: new Date().toISOString(),
      quality: this.qualityForFinal(transcript),
    };
    session.segments.push(segment);
    session.segments.sort((a, b) => a.offsetMs - b.offsetMs);
    this.emit({ type: 'segment', sessionId: session.id, segment });

    if (!session.active || !session.translate || segment.translation) return;
    if (session.nativeTranslation) return;
    const geminiService = this.opts.ensureGeminiService();
    if (!geminiService) {
      segment.translationError = this.opts.formatAiCredentialsError();
      this.emit({ type: 'segment', sessionId: session.id, segment });
      return;
    }
    try {
      const translation = await geminiService.translateText(transcript, {
        targetLanguage: resolveLiveTranslationTarget(
          this.opts.getLiveSttConfig().translationLanguage,
        ),
        signal: session.abortController.signal,
      });
      if (this.session !== session || !session.active || session.abortController.signal.aborted)
        return;
      segment.translation = translation.trim() || undefined;
    } catch (err) {
      if (isAbortError(err) || !session.active || session.abortController.signal.aborted) return;
      segment.translationError = err instanceof Error ? err.message : String(err);
    }
    this.emit({ type: 'segment', sessionId: session.id, segment });
  }

  private handleStreamError(session: LiveSessionState, error: unknown): void {
    if (this.session !== session || !session.active || isAbortError(error)) return;
    const message = error instanceof Error ? error.message : String(error);
    this.emit({ type: 'error', sessionId: session.id, error: message });
  }

  private recordLiveUsage(session: LiveSessionState): void {
    if (session.usageRecorded) return;
    session.usageRecorded = true;
    if (session.mode !== 'streaming' || !session.usageModelId) return;
    const startedAt = Date.parse(session.startedAt);
    if (!Number.isFinite(startedAt)) return;
    const now = this.opts.now?.() ?? Date.now();
    const audioSeconds = Math.max(0, (now - startedAt) / 1000);
    if (audioSeconds <= 0) return;
    const writeUsage = this.opts.recordUsage ?? recordUsage;
    writeUsage({
      modelId: session.usageModelId,
      kind: 'realtime',
      usage: { audioSeconds },
      timestamp: new Date(now).toISOString(),
    });
  }

  private async writeTempSnippet(
    session: LiveSessionState,
    mimeType: string,
    buffer: Buffer,
  ): Promise<string> {
    const dir = path.join(this.opts.getDataPath(), 'live-snippets');
    await fs.promises.mkdir(dir, { recursive: true });
    const ext = extensionForMimeType(mimeType || 'audio/webm');
    const filePath = path.join(dir, `.${session.id}-${Date.now()}-${session.nextSegmentId}.${ext}`);
    await fs.promises.writeFile(filePath, buffer);
    return filePath;
  }
}
