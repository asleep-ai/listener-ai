import * as fs from 'fs';
import * as path from 'path';
import { extensionForMimeType } from './audioFormats';
import type { AgentChatMessage, AgentRunResult, AgentService } from './agentService';
import {
  DEFAULT_GEMINI_LIVE_TRANSCRIPTION_MODEL,
  DEFAULT_GEMINI_LIVE_TRANSLATION_MODEL,
  DEFAULT_OPENAI_LIVE_TRANSCRIPTION_MODEL,
  DEFAULT_OPENAI_LIVE_TRANSLATION_MODEL,
} from './aiProvider';
import type { GeminiService } from './geminiService';
import {
  createLiveSttSession,
  type LiveSttProviderConfig,
  type LiveSttSession,
  type StreamingLiveSttProvider,
} from './liveSttProvider';
import { recordUsage, type RecordInput } from './services/usageTracker';

export interface LiveTranscriptSegment {
  id: string;
  offsetMs: number;
  durationMs: number;
  transcript: string;
  translation?: string;
  translationError?: string;
  final: boolean;
  createdAt: string;
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

export interface LiveSessionSnapshot {
  sessionId: string;
  title: string;
  startedAt: string;
  active: boolean;
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

export interface LiveSessionServiceOptions {
  getDataPath(): string;
  ensureGeminiService(): GeminiService | null;
  getAgentService(): AgentService | null;
  formatAiCredentialsError(): string;
  getLiveSttConfig(): LiveSttProviderConfig;
  emitEvent?(event: LiveSessionEvent): void;
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
};

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

  constructor(opts: LiveSessionServiceOptions) {
    this.opts = opts;
  }

  async start(
    input: { title?: string; translate?: boolean } = {},
  ): Promise<LiveSessionStartResult> {
    const previous = this.session;
    previous?.abortController.abort();
    await previous?.stream?.close().catch(() => {});
    if (previous) this.recordLiveUsage(previous);
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
    };
    this.session = session;
    let config = { ...this.opts.getLiveSttConfig(), translate: session.translate };
    if (config.provider !== 'chunked' && this.opts.createRealtimeClientConfig) {
      try {
        session.realtimeClient = await this.opts.createRealtimeClientConfig(config);
      } catch (error) {
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
        const recovered = await this.tryProviderFallbackAfterStartFailure(session, config, error);
        if (!recovered) throw error;
      }
    } else {
      this.setRealtimeProvider(session, config);
    }
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
    if (!session.active || session.abortController.signal.aborted)
      throw new Error('Live session is no longer active.');
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
        this.handleStreamError(session, error);
      }
    }

    session.mode = 'chunked';
    session.provider = 'chunked';
    session.usageModelId = null;
    this.emit({
      type: 'status',
      sessionId: session.id,
      status: 'OpenAI Realtime unavailable; using chunked fallback transcription.',
      mode: session.mode,
      provider: session.provider,
    });
    return this.startResult(session);
  }

  async stop(sessionId: string): Promise<LiveSessionSnapshot | null> {
    const session = this.session;
    if (!session || session.id !== sessionId) return null;
    // Close the stream while the session is still active so streaming providers
    // (Gemini Live, OpenAI translation) can flush their final transcript via
    // onFinal -- handleFinalTranscript drops segments once active is false.
    await session.stream?.close().catch((err) => this.handleStreamError(session, err));
    session.stream = null;
    session.active = false;
    session.abortController.abort();
    this.recordLiveUsage(session);
    return this.snapshot();
  }

  snapshot(): LiveSessionSnapshot | null {
    const session = this.session;
    if (!session) return null;
    const segments = [...session.segments].sort((a, b) => a.offsetMs - b.offsetMs);
    return {
      sessionId: session.id,
      title: session.title,
      startedAt: session.startedAt,
      active: session.active,
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
    const createSession = this.opts.createLiveSttSession ?? createLiveSttSession;
    session.stream = await createSession(config, {
      onStatus: (status) => this.emit({ type: 'status', sessionId: session.id, status }),
      onInterim: (event) => this.handleInterim(session, event),
      onTranslationInterim: (event) => this.handleTranslationInterim(session, event),
      onFinal: (event) => {
        void this.handleFinalTranscript(session, event);
      },
      onError: (error) => this.handleStreamError(session, error),
    });
    if (!session.stream) return;
    session.mode = 'streaming';
    session.provider = session.stream.provider;
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
    const fallbackConfigs = this.buildRealtimeFallbackConfigs({
      ...config,
      openaiApiKey: undefined,
    });
    if (fallbackConfigs.length === 0) return false;

    this.handleStreamError(session, error);
    for (const fallbackConfig of fallbackConfigs) {
      try {
        await this.startStreamingProvider(session, fallbackConfig);
        if (session.stream) {
          this.emit({
            type: 'status',
            sessionId: session.id,
            status: `OpenAI live provider unavailable; using ${session.provider} live transcription.`,
            mode: session.mode,
            provider: session.provider,
          });
          return true;
        }
      } catch (fallbackError) {
        this.handleStreamError(session, fallbackError);
      }
    }
    return false;
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
    const geminiService = this.opts.ensureGeminiService();
    if (!geminiService) {
      throw new Error(this.opts.formatAiCredentialsError());
    }

    const buffer = asBuffer(input.audioData);
    if (buffer.byteLength < 512) return null;

    const tempPath = await this.writeTempSnippet(session, input.mimeType, buffer);
    try {
      if (!session.active || session.abortController.signal.aborted) return null;
      const transcript = cleanTranscript(
        await geminiService.transcribeLiveSnippet(tempPath, {
          signal: session.abortController.signal,
        }),
      );
      if (!transcript) return null;
      if (this.session !== session) throw new Error('Live session was replaced.');
      if (!session.active || session.abortController.signal.aborted) return null;

      let translation: string | undefined;
      let translationError: string | undefined;
      session.translate = input.translate !== false;
      if (input.translate !== false) {
        try {
          translation = (
            await geminiService.translateText(transcript, {
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
    };
    session.segments.push(segment);
    session.segments.sort((a, b) => a.offsetMs - b.offsetMs);
    this.emit({ type: 'segment', sessionId: session.id, segment });

    if (!session.active || !session.translate || segment.translation) return;
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
