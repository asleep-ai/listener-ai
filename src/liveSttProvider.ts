import type {
  LiveConnectConfig,
  LiveConnectParameters,
  LiveServerMessage,
  Session,
} from '@google/genai';
import WebSocket, { type RawData } from 'ws';
import { importEsm } from './esmImport';
import { CONNECT_TIMEOUT_MS, LiveReconnectController } from './liveReconnect';
import { asUint8Array, downsamplePcm16, parseMessageData } from './liveSttUtils';
import { SonioxLiveSession } from './sonioxLiveProvider';
import {
  DEFAULT_GEMINI_LIVE_TRANSCRIPTION_MODEL,
  DEFAULT_GEMINI_LIVE_TRANSLATION_MODEL,
  DEFAULT_OPENAI_LIVE_TRANSCRIPTION_MODEL,
  DEFAULT_OPENAI_LIVE_TRANSLATION_MODEL,
  DEFAULT_OPENAI_REALTIME_SESSION_MODEL,
  type LiveSttProvider,
} from './aiProvider';

export type StreamingLiveSttProvider = 'openai' | 'gemini' | 'soniox';

export interface LiveSttProviderConfig {
  provider: LiveSttProvider;
  openaiApiKey?: string;
  geminiApiKey?: string;
  sonioxApiKey?: string;
  openaiLiveTranscriptionModel?: string;
  openaiLiveTranslationModel?: string;
  language?: string;
  translationLanguage?: string;
  translate?: boolean;
  /** Proper nouns / jargon; Soniox takes them as `context.terms`. */
  knownWords?: string[];
}

export interface LiveSttPcmFrame {
  audioData: ArrayBuffer | Uint8Array;
  sampleRate: number;
  channelCount: number;
  offsetMs: number;
  durationMs: number;
  sequence: number;
}

export interface LiveSttCallbacks {
  onStatus?(status: string): void;
  onInterim(event: { text: string; itemId?: string; offsetMs?: number }): void;
  onTranslationInterim?(event: { text: string; itemId?: string; offsetMs?: number }): void;
  onFinal(event: {
    text: string;
    itemId?: string;
    offsetMs?: number;
    durationMs?: number;
    translation?: string;
  }): void;
  onError(error: Error): void;
}

export interface LiveSttSession {
  readonly provider: StreamingLiveSttProvider;
  readonly kind: 'transcription' | 'translation';
  sendPcm(frame: LiveSttPcmFrame): void;
  close(): Promise<void>;
}

const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime';
const OPENAI_TRANSLATION_URL = 'wss://api.openai.com/v1/realtime/translations';
const OPENAI_PCM_RATE = 24_000;
const GEMINI_PCM_RATE = 16_000;
type GoogleGenAiModule = typeof import('@google/genai');
let googleGenAiPromise: Promise<GoogleGenAiModule> | undefined;

function loadGoogleGenAi(): Promise<GoogleGenAiModule> {
  googleGenAiPromise ??= importEsm<GoogleGenAiModule>('@google/genai');
  return googleGenAiPromise;
}

export function resolveStreamingProvider(
  config: LiveSttProviderConfig,
): StreamingLiveSttProvider | null {
  if (config.provider === 'chunked') return null;
  if (config.provider === 'openai') {
    if (!config.openaiApiKey?.trim()) throw new Error('OpenAI API key is not configured.');
    return 'openai';
  }
  if (config.provider === 'gemini') {
    if (!config.geminiApiKey?.trim()) throw new Error('Gemini API key is not configured.');
    return 'gemini';
  }
  if (config.provider === 'soniox') {
    if (!config.sonioxApiKey?.trim()) throw new Error('Soniox API key is not configured.');
    return 'soniox';
  }
  // `auto` intentionally never resolves to Soniox: it stays explicit-only until
  // the evaluation passes and a release has soaked.
  if (config.openaiApiKey?.trim()) return 'openai';
  if (config.geminiApiKey?.trim()) return 'gemini';
  return null;
}

function waitForOpen(ws: WebSocket, timeoutMs = 8_000): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out connecting to OpenAI Realtime.'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('open', handleOpen);
      ws.off('error', handleError);
      ws.off('close', handleClose);
    };
    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error('Could not connect to OpenAI Realtime.'));
    };
    const handleClose = () => {
      cleanup();
      reject(new Error('OpenAI Realtime closed before connecting.'));
    };
    ws.once('open', handleOpen);
    ws.once('error', handleError);
    ws.once('close', handleClose);
  });
}

function sendJson(ws: WebSocket, value: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
}

function closeAfterDelay(ws: WebSocket, delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    const timeout = setTimeout(done, 1_500);
    const closeTimer = setTimeout(() => {
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      } catch {
        done();
      }
    }, delayMs);
    function done() {
      clearTimeout(timeout);
      clearTimeout(closeTimer);
      ws.off('close', done);
      ws.off('error', done);
      resolve();
    }
    ws.once('close', done);
    ws.once('error', done);
  });
}

function pcmFrameToOpenAiBase64(frame: LiveSttPcmFrame): string {
  const pcm = downsamplePcm16(asUint8Array(frame.audioData), frame.sampleRate, OPENAI_PCM_RATE);
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
}

function pcmFrameToGeminiBase64(frame: LiveSttPcmFrame): string {
  const pcm = downsamplePcm16(asUint8Array(frame.audioData), frame.sampleRate, GEMINI_PCM_RATE);
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
}

function openAiRealtimeWebSocket(url: string, apiKey: string): WebSocket {
  return new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      'OpenAI-Safety-Identifier': 'listener-ai-local',
    },
  });
}

function mergeTranscriptText(current: string, next: string | undefined): string {
  const text = next?.trim();
  if (!text) return current;
  if (!current) return text;
  if (text.startsWith(current)) return text;
  if (current.endsWith(text)) return current;
  return `${current}${text.startsWith(' ') ? '' : ' '}${text}`.trim();
}

class OpenAiRealtimeTranscriptionSession implements LiveSttSession {
  readonly provider = 'openai' as const;
  readonly kind = 'transcription' as const;
  private readonly ws: WebSocket;
  private readonly commitTimer: NodeJS.Timeout;
  private readonly itemText = new Map<string, string>();
  private hasUncommittedAudio = false;
  private closed = false;

  private constructor(ws: WebSocket, callbacks: LiveSttCallbacks) {
    this.ws = ws;
    this.commitTimer = setInterval(() => this.commit(), 2_000);
    ws.on('message', (data: RawData) => {
      try {
        const payload = JSON.parse(parseMessageData(data)) as {
          type?: string;
          item_id?: string;
          delta?: string;
          transcript?: string;
          error?: { message?: string };
        };
        if (payload.type === 'error') {
          callbacks.onError(
            new Error(payload.error?.message || 'OpenAI Realtime transcription error.'),
          );
          return;
        }
        if (payload.type === 'conversation.item.input_audio_transcription.delta') {
          const itemId = payload.item_id || 'current';
          const text = `${this.itemText.get(itemId) ?? ''}${payload.delta ?? ''}`.trim();
          this.itemText.set(itemId, text);
          if (text) callbacks.onInterim({ text, itemId });
          return;
        }
        if (payload.type === 'conversation.item.input_audio_transcription.completed') {
          const itemId = payload.item_id || `item_${Date.now()}`;
          const text = (payload.transcript || this.itemText.get(itemId) || '').trim();
          this.itemText.delete(itemId);
          if (text) callbacks.onFinal({ text, itemId });
        }
      } catch (err) {
        callbacks.onError(err instanceof Error ? err : new Error(String(err)));
      }
    });
    ws.on('close', () => {
      clearInterval(this.commitTimer);
      if (!this.closed) callbacks.onError(new Error('OpenAI Realtime transcription disconnected.'));
    });
    ws.on('error', () => {
      clearInterval(this.commitTimer);
      callbacks.onError(new Error('OpenAI Realtime transcription connection failed.'));
    });
  }

  static async create(
    config: LiveSttProviderConfig,
    callbacks: LiveSttCallbacks,
  ): Promise<OpenAiRealtimeTranscriptionSession> {
    const transcriptionModel =
      config.openaiLiveTranscriptionModel || DEFAULT_OPENAI_LIVE_TRANSCRIPTION_MODEL;
    const ws = openAiRealtimeWebSocket(
      `${OPENAI_REALTIME_URL}?model=${encodeURIComponent(DEFAULT_OPENAI_REALTIME_SESSION_MODEL)}`,
      config.openaiApiKey ?? '',
    );
    await waitForOpen(ws);
    sendJson(ws, {
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: OPENAI_PCM_RATE },
            transcription: {
              model: transcriptionModel,
              ...(config.language?.trim() ? { language: config.language.trim() } : {}),
              delay: 'low',
            },
            turn_detection: null,
          },
        },
      },
    });
    callbacks.onStatus?.('Connected to OpenAI Realtime transcription.');
    return new OpenAiRealtimeTranscriptionSession(ws, callbacks);
  }

  sendPcm(frame: LiveSttPcmFrame): void {
    if (frame.channelCount !== 1) return;
    const audio = pcmFrameToOpenAiBase64(frame);
    if (!audio) return;
    this.hasUncommittedAudio = true;
    sendJson(this.ws, { type: 'input_audio_buffer.append', audio });
  }

  private commit(): void {
    if (!this.hasUncommittedAudio) return;
    this.hasUncommittedAudio = false;
    sendJson(this.ws, { type: 'input_audio_buffer.commit' });
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.commitTimer);
    const hadUncommitted = this.hasUncommittedAudio;
    this.commit();
    if (hadUncommitted) {
      // Wait for the final committed window to transcribe (the message handler
      // emits it via onFinal) instead of racing a fixed 500ms timer.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        const onMessage = (data: RawData) => {
          try {
            const payload = JSON.parse(parseMessageData(data)) as { type?: string };
            if (payload.type === 'conversation.item.input_audio_transcription.completed') {
              clearTimeout(timer);
              this.ws.off('message', onMessage);
              resolve();
            }
          } catch {
            // ignore
          }
        };
        this.ws.on('message', onMessage);
      });
    }
    await closeAfterDelay(this.ws, 0);
  }
}

class OpenAiRealtimeTranslationSession implements LiveSttSession {
  readonly provider = 'openai' as const;
  readonly kind = 'translation' as const;
  private readonly ws: WebSocket;
  private readonly callbacks: LiveSttCallbacks;
  private inputTranscript = '';
  private outputTranscript = '';
  private finalEmitted = false;
  private closed = false;

  private constructor(ws: WebSocket, callbacks: LiveSttCallbacks) {
    this.ws = ws;
    this.callbacks = callbacks;
    ws.on('message', (data: RawData) => {
      try {
        const payload = JSON.parse(parseMessageData(data)) as {
          type?: string;
          delta?: string;
          error?: { message?: string };
        };
        if (payload.type === 'error') {
          callbacks.onError(
            new Error(payload.error?.message || 'OpenAI Realtime translation error.'),
          );
          return;
        }
        if (payload.type === 'session.input_transcript.delta') {
          this.inputTranscript = `${this.inputTranscript}${payload.delta ?? ''}`.trim();
          if (this.inputTranscript) callbacks.onInterim({ text: this.inputTranscript });
          return;
        }
        if (payload.type === 'session.output_transcript.delta') {
          this.outputTranscript = `${this.outputTranscript}${payload.delta ?? ''}`.trim();
          if (this.outputTranscript) {
            callbacks.onTranslationInterim?.({ text: this.outputTranscript });
          }
          return;
        }
        if (payload.type === 'session.closed') {
          this.emitFinal(callbacks);
          this.closed = true;
          this.ws.close();
        }
      } catch (err) {
        callbacks.onError(err instanceof Error ? err : new Error(String(err)));
      }
    });
    ws.on('close', () => {
      if (!this.closed) callbacks.onError(new Error('OpenAI Realtime translation disconnected.'));
    });
    ws.on('error', () => {
      callbacks.onError(new Error('OpenAI Realtime translation connection failed.'));
    });
  }

  static async create(
    config: LiveSttProviderConfig,
    callbacks: LiveSttCallbacks,
  ): Promise<OpenAiRealtimeTranslationSession> {
    const model = config.openaiLiveTranslationModel || DEFAULT_OPENAI_LIVE_TRANSLATION_MODEL;
    const ws = openAiRealtimeWebSocket(
      `${OPENAI_TRANSLATION_URL}?model=${encodeURIComponent(model)}`,
      config.openaiApiKey ?? '',
    );
    await waitForOpen(ws);
    sendJson(ws, {
      type: 'session.update',
      session: {
        audio: {
          output: {
            language: config.translationLanguage?.trim() || 'ko',
          },
        },
      },
    });
    callbacks.onStatus?.('Connected to OpenAI Realtime translation.');
    return new OpenAiRealtimeTranslationSession(ws, callbacks);
  }

  sendPcm(frame: LiveSttPcmFrame): void {
    if (frame.channelCount !== 1) return;
    const audio = pcmFrameToOpenAiBase64(frame);
    if (!audio) return;
    sendJson(this.ws, { type: 'session.input_audio_buffer.append', audio });
  }

  private emitFinal(callbacks: LiveSttCallbacks): void {
    if (this.finalEmitted) return;
    this.finalEmitted = true;
    const text = this.inputTranscript.trim();
    const translation = this.outputTranscript.trim();
    if (text || translation) {
      callbacks.onFinal({
        text: text || translation,
        translation: translation || undefined,
      });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // OpenAI Realtime translation sessions support `session.close`: it flushes
    // pending audio, emits the remaining translated output, then replies with
    // `session.closed`. Wait for that (or a 2s cap) before closing the socket so
    // the final translated segment isn't dropped mid-drain.
    sendJson(this.ws, { type: 'session.close' });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.emitFinal(this.callbacks);
        this.ws.close();
        resolve();
      }, 2_000);
      const done = () => {
        clearTimeout(timer);
        this.ws.off('close', done);
        this.ws.off('error', done);
        resolve();
      };
      this.ws.once('close', done);
      this.ws.once('error', done);
    });
  }
}

export type GeminiLiveConnect = (params: LiveConnectParameters) => Promise<Session>;

export interface GeminiLiveSessionDeps {
  /** Override the live-connect transport (tests inject a scripted fake). */
  connect?: GeminiLiveConnect;
  /** Override the backoff/flush sleep (tests collapse it so reconnects run instantly). */
  sleep?: (ms: number) => Promise<void>;
  /** Override the per-attempt connect timeout (tests shrink it to force timeouts fast). */
  connectTimeoutMs?: number;
}

// Gemini Live caps an audio-only session at 15 minutes and the underlying
// WebSocket connection at ~10 minutes (sending a GoAway first), so a live
// caption stream is severed roughly every 10 minutes. Session resumption plus
// sliding-window context compression let one logical session outlive that cap;
// on an unexpected socket close we transparently reconnect with the last
// resumption handle instead of surfacing a fatal error.
export class GeminiLiveSession implements LiveSttSession {
  readonly provider = 'gemini' as const;
  readonly kind: 'transcription' | 'translation';
  private session: Session | null = null;
  private inputTranscript = '';
  private outputTranscript = '';
  private closed = false;
  private resumeHandle: string | undefined;
  private readonly reconnector: LiveReconnectController;

  private constructor(
    private readonly connectFn: GeminiLiveConnect,
    private readonly sleepFn: (ms: number) => Promise<void>,
    connectTimeoutMs: number,
    private readonly model: string,
    private readonly baseConfig: LiveConnectConfig,
    kind: 'transcription' | 'translation',
    private readonly callbacks: LiveSttCallbacks,
  ) {
    this.kind = kind;
    this.reconnector = new LiveReconnectController({
      label: 'Gemini Live',
      kind,
      connectTimeoutMs,
      sleep: sleepFn,
      isClosed: () => this.closed,
      connect: () => this.connect(true),
      teardown: () => {
        this.session?.close();
      },
      onStatus: (status) => this.callbacks.onStatus?.(status),
      onError: (error) => this.callbacks.onError(error),
    });
  }

  static async create(
    config: LiveSttProviderConfig,
    callbacks: LiveSttCallbacks,
    deps: GeminiLiveSessionDeps = {},
  ): Promise<GeminiLiveSession> {
    const apiKey = config.geminiApiKey?.trim();
    if (!apiKey) throw new Error('Gemini API key is not configured.');
    const translate = config.translate !== false;
    const { GoogleGenAI, Modality } = await loadGoogleGenAi();
    const ai = new GoogleGenAI({ apiKey });
    const connectFn = deps.connect ?? ((params) => ai.live.connect(params));
    const sleepFn = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const connectTimeoutMs = deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    const model = translate
      ? DEFAULT_GEMINI_LIVE_TRANSLATION_MODEL
      : DEFAULT_GEMINI_LIVE_TRANSCRIPTION_MODEL;
    // sessionResumption + contextWindowCompression keep one logical session
    // alive past the ~10-minute connection cap; the resume handle is injected
    // per-connect (empty on the first connect, populated on reconnects).
    const baseConfig: LiveConnectConfig = {
      responseModalities: [Modality.AUDIO],
      inputAudioTranscription: {},
      sessionResumption: {},
      contextWindowCompression: { slidingWindow: {} },
      ...(translate
        ? {
            outputAudioTranscription: {},
            translationConfig: {
              targetLanguageCode: config.translationLanguage?.trim() || 'ko',
              echoTargetLanguage: true,
            },
          }
        : {
            systemInstruction:
              'You are a passive live captioner. Transcribe the user audio only. Do not answer, ask questions, or generate assistant content.',
          }),
    };
    const instance = new GeminiLiveSession(
      connectFn,
      sleepFn,
      connectTimeoutMs,
      model,
      baseConfig,
      translate ? 'translation' : 'transcription',
      callbacks,
    );
    // The first connect rejects on failure so LiveSessionService can fall back to
    // another provider. Mark the instance closed on failure so a socket that opens
    // after we've timed out can't start a background reconnect on an instance the
    // caller is about to discard.
    try {
      await instance.connect(false);
    } catch (error) {
      instance.closed = true;
      throw error;
    }
    return instance;
  }

  private async connect(isResume: boolean): Promise<void> {
    // Only a fully established connection may drive the reconnect loop.
    // @google/genai 2.16 resolves connect() only after the server's
    // setupComplete message and leaves it pending forever when the socket
    // closes earlier, so any close before our race settles -- pre-open or in
    // the open-but-not-set-up window -- means this attempt never came up: fail
    // the connect so create()/the reconnect loop can fall back or retry,
    // instead of spinning a background reconnect over an attempt the caller is
    // still waiting on. Once established, a reconnect only ever starts from
    // that connection's terminal onclose, so connections never overlap and the
    // callbacks need no further per-connection guard (a GoAway pre-handoff
    // would change that).
    const attempt = this.reconnector.beginConnect();
    const connectPromise = this.connectFn({
      model: this.model,
      // Pass the handle only when present -- an explicit `handle: undefined` could
      // be serialized differently than an absent key by some clients.
      config: {
        ...this.baseConfig,
        sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {},
      },
      callbacks: {
        onopen: () => {
          // Ignore a late open from an attempt we already abandoned (timed out)
          // or from any attempt once the session has been closed.
          if (attempt.timedOut || this.closed) return;
          this.reconnector.markConnected();
          this.callbacks.onStatus?.(
            isResume
              ? `Reconnected to Gemini Live ${this.kind}.`
              : `Connected to Gemini Live ${this.kind}.`,
          );
        },
        onmessage: (message) => {
          // Keep processing during the close drain -- close() sets this.closed
          // before the 2s audioStreamEnd flush, and the final transcript arrives
          // in that window. Only drop messages from an attempt we abandoned on
          // timeout (a closed socket delivers nothing more once close() returns).
          if (attempt.timedOut) return;
          this.handleMessage(message);
        },
        onerror: (event) => {
          // Let onclose drive reconnection; retain the message so the surfaced
          // error is meaningful if the reconnect budget is exhausted.
          this.reconnector.lastErrorMessage = event.message || 'Gemini Live connection failed.';
        },
        onclose: () => {
          // A timed-out attempt's late close (including our own timeout cleanup
          // close) must not drive a reconnect over the connection that already
          // replaced it; likewise once the session is closed.
          if (attempt.timedOut || this.closed) return;
          if (attempt.established) {
            void this.reconnector.handleDisconnect();
          } else {
            attempt.fail(
              new Error(
                this.reconnector.lastErrorMessage ??
                  'Gemini Live closed before the connection was established.',
              ),
            );
          }
        },
      },
    });
    // If the connection opens only after we have already timed out, discard the
    // late socket so it doesn't leak.
    connectPromise
      .then((late) => {
        if (attempt.timedOut) late.close();
      })
      .catch(() => {});
    await attempt.establish(connectPromise, (session) => {
      this.session = session;
    });
  }

  sendPcm(frame: LiveSttPcmFrame): void {
    if (this.closed || this.reconnector.reconnecting || !this.session) return;
    if (frame.channelCount !== 1) return;
    const audio = pcmFrameToGeminiBase64(frame);
    if (!audio) return;
    try {
      this.session.sendRealtimeInput({
        audio: {
          data: audio,
          mimeType: `audio/pcm;rate=${GEMINI_PCM_RATE}`,
        },
      });
    } catch {
      // The socket may be tearing down just before a reconnect; drop the frame.
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.session?.sendRealtimeInput({ audioStreamEnd: true });
      await this.sleepFn(2_000);
    } catch {
      // Best-effort flush before closing the websocket.
    }
    this.emitFinal();
    this.session?.close();
  }

  private handleMessage(message: LiveServerMessage): void {
    // Persist the latest resumption handle so a reconnect resumes this session
    // rather than starting fresh. newHandle is empty when resumable is false.
    const resumption = message.sessionResumptionUpdate;
    if (resumption?.newHandle) this.resumeHandle = resumption.newHandle;

    const content = message.serverContent;
    if (!content) return;
    const inputText = content.inputTranscription?.text;
    if (inputText) {
      this.inputTranscript = mergeTranscriptText(this.inputTranscript, inputText);
      this.callbacks.onInterim({ text: this.inputTranscript });
    }
    const outputText = this.kind === 'translation' ? content.outputTranscription?.text : undefined;
    if (outputText) {
      this.outputTranscript = mergeTranscriptText(this.outputTranscript, outputText);
      this.callbacks.onTranslationInterim?.({ text: this.outputTranscript });
    }
    if (this.kind === 'transcription' && content.inputTranscription?.finished) {
      this.emitFinal();
      return;
    }
    if (
      this.kind === 'translation' &&
      (content.outputTranscription?.finished || content.turnComplete === true)
    ) {
      this.emitFinal();
    }
  }

  private emitFinal(): void {
    const text = this.inputTranscript.trim();
    const translation = this.kind === 'translation' ? this.outputTranscript.trim() : '';
    if (!text && !translation) return;
    this.callbacks.onFinal({
      text: text || translation,
      translation: translation || undefined,
    });
    this.inputTranscript = '';
    this.outputTranscript = '';
  }
}

export async function createLiveSttSession(
  config: LiveSttProviderConfig,
  callbacks: LiveSttCallbacks,
): Promise<LiveSttSession | null> {
  const provider = resolveStreamingProvider(config);
  if (provider === null) return null;
  if (provider === 'gemini') return await GeminiLiveSession.create(config, callbacks);
  if (provider === 'soniox') return await SonioxLiveSession.create(config, callbacks);
  if (config.translate) return await OpenAiRealtimeTranslationSession.create(config, callbacks);
  return await OpenAiRealtimeTranscriptionSession.create(config, callbacks);
}
