import {
  GoogleGenAI,
  Modality,
  type LiveConnectConfig,
  type LiveConnectParameters,
  type LiveServerMessage,
  type Session,
} from '@google/genai';
import WebSocket, { type RawData } from 'ws';
import {
  DEFAULT_GEMINI_LIVE_TRANSCRIPTION_MODEL,
  DEFAULT_GEMINI_LIVE_TRANSLATION_MODEL,
  DEFAULT_OPENAI_LIVE_TRANSCRIPTION_MODEL,
  DEFAULT_OPENAI_LIVE_TRANSLATION_MODEL,
  DEFAULT_OPENAI_REALTIME_SESSION_MODEL,
  type LiveSttProvider,
} from './aiProvider';

export type StreamingLiveSttProvider = 'openai' | 'gemini';

export interface LiveSttProviderConfig {
  provider: LiveSttProvider;
  openaiApiKey?: string;
  geminiApiKey?: string;
  openaiLiveTranscriptionModel?: string;
  openaiLiveTranslationModel?: string;
  language?: string;
  translationLanguage?: string;
  translate?: boolean;
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
  if (config.openaiApiKey?.trim()) return 'openai';
  if (config.geminiApiKey?.trim()) return 'gemini';
  return null;
}

function asUint8Array(data: ArrayBuffer | Uint8Array): Uint8Array {
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
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

function parseMessageData(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  return String(data);
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

function downsamplePcm16(input: Uint8Array, inputRate: number, outputRate: number): Uint8Array {
  if (inputRate === outputRate) return input;
  if (input.byteLength < 2) return input;
  // Int16Array views require a 2-byte-aligned offset; copy when the incoming
  // view starts on an odd byte to avoid a RangeError.
  const source =
    input.byteOffset % 2 === 0
      ? new Int16Array(input.buffer, input.byteOffset, Math.floor(input.byteLength / 2))
      : new Int16Array(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
  const ratio = inputRate / outputRate;
  const outputLength = Math.max(1, Math.floor(source.length / ratio));
  const output = new Int16Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(source.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      sum += source[j] ?? 0;
      count++;
    }
    output[i] = Math.max(-32768, Math.min(32767, Math.round(sum / Math.max(1, count))));
  }
  return new Uint8Array(output.buffer);
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

// Gemini Live caps an audio-only session at 15 minutes and the underlying
// WebSocket connection at ~10 minutes (sending a GoAway first), so a live
// caption stream is severed roughly every 10 minutes. Session resumption plus
// sliding-window context compression let one logical session outlive that cap;
// on an unexpected socket close we transparently reconnect with the last
// resumption handle instead of surfacing a fatal error.
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 4_000;
const RECONNECT_STABLE_MS = 30_000;
// @google/genai resolves ai.live.connect from `onopen` and does not reject on a
// pre-open error/close, so a dead network can leave it pending forever. Bound
// each attempt so a wedged reconnect fails and the loop can retry or give up.
const CONNECT_TIMEOUT_MS = 15_000;

export type GeminiLiveConnect = (params: LiveConnectParameters) => Promise<Session>;

export interface GeminiLiveSessionDeps {
  /** Override the live-connect transport (tests inject a scripted fake). */
  connect?: GeminiLiveConnect;
  /** Override the backoff/flush sleep (tests collapse it so reconnects run instantly). */
  sleep?: (ms: number) => Promise<void>;
}

export class GeminiLiveSession implements LiveSttSession {
  readonly provider = 'gemini' as const;
  readonly kind: 'transcription' | 'translation';
  private session: Session | null = null;
  private inputTranscript = '';
  private outputTranscript = '';
  private closed = false;
  private resumeHandle: string | undefined;
  private reconnectAttempts = 0;
  private reconnecting = false;
  private pendingReconnect = false;
  private lastConnectedAt = 0;
  private lastErrorMessage: string | undefined;

  private constructor(
    private readonly connectFn: GeminiLiveConnect,
    private readonly sleepFn: (ms: number) => Promise<void>,
    private readonly model: string,
    private readonly baseConfig: LiveConnectConfig,
    kind: 'transcription' | 'translation',
    private readonly callbacks: LiveSttCallbacks,
  ) {
    this.kind = kind;
  }

  static async create(
    config: LiveSttProviderConfig,
    callbacks: LiveSttCallbacks,
    deps: GeminiLiveSessionDeps = {},
  ): Promise<GeminiLiveSession> {
    const apiKey = config.geminiApiKey?.trim();
    if (!apiKey) throw new Error('Gemini API key is not configured.');
    const translate = config.translate !== false;
    const ai = new GoogleGenAI({ apiKey });
    const connectFn = deps.connect ?? ((params) => ai.live.connect(params));
    const sleepFn = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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
      model,
      baseConfig,
      translate ? 'translation' : 'transcription',
      callbacks,
    );
    // The first connect rejects on failure so LiveSessionService can fall back
    // to another provider; only post-open closes drive the reconnect loop.
    await instance.connect(false);
    return instance;
  }

  private async connect(isResume: boolean): Promise<void> {
    // A reconnect only ever starts from a connection's terminal `onclose` (the
    // sole caller of handleDisconnect), so a superseded connection never emits
    // again: at most one connection is live at a time, and these callbacks need
    // no per-connection guard. If a GoAway pre-handoff is ever added (opening the
    // next socket before the old one closes), connections would overlap and each
    // callback would then have to ignore events from a non-current connection.
    let timedOut = false;
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
          // Monotonic clock: connection-stability timing must not be skewed by
          // wall-clock adjustments (NTP, manual changes).
          this.lastConnectedAt = performance.now();
          this.callbacks.onStatus?.(
            isResume
              ? `Reconnected to Gemini Live ${this.kind}.`
              : `Connected to Gemini Live ${this.kind}.`,
          );
        },
        onmessage: (message) => this.handleMessage(message),
        onerror: (event) => {
          // Let onclose drive reconnection; retain the message so the surfaced
          // error is meaningful if the reconnect budget is exhausted.
          this.lastErrorMessage = event.message || 'Gemini Live connection failed.';
        },
        onclose: () => {
          void this.handleDisconnect();
        },
      },
    });
    // If the connection opens only after we have already timed out, discard the
    // late socket so it doesn't leak.
    connectPromise
      .then((late) => {
        if (timedOut) late.close();
      })
      .catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      this.session = await Promise.race([
        connectPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error('Timed out connecting to Gemini Live.'));
          }, CONNECT_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async handleDisconnect(): Promise<void> {
    if (this.closed) return;
    if (this.reconnecting) {
      // A close fired while we were already reconnecting; re-run once we settle.
      this.pendingReconnect = true;
      return;
    }
    this.reconnecting = true;
    try {
      do {
        this.pendingReconnect = false;
        // A connection that stayed up comfortably (e.g. the ~10-min cap) is a
        // fresh failure, not a flapping retry storm -- reset the counter so a
        // long-running session can keep reconnecting indefinitely.
        if (
          this.lastConnectedAt &&
          performance.now() - this.lastConnectedAt > RECONNECT_STABLE_MS
        ) {
          this.reconnectAttempts = 0;
        }
        let reconnected = false;
        while (!this.closed && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          this.reconnectAttempts++;
          const delayMs = Math.min(
            RECONNECT_MAX_DELAY_MS,
            RECONNECT_BASE_DELAY_MS * 2 ** (this.reconnectAttempts - 1),
          );
          this.callbacks.onStatus?.(
            `Reconnecting to Gemini Live ${this.kind} (attempt ${this.reconnectAttempts})...`,
          );
          await this.sleepFn(delayMs);
          if (this.closed) return;
          try {
            await this.connect(true);
            if (this.closed) {
              // close() landed during the reconnect; don't leak the new socket.
              this.session?.close();
              return;
            }
            reconnected = true;
            break;
          } catch (error) {
            // Keep the latest failure so the give-up error below is fresh and
            // accurate, not a stale message from an earlier, already-recovered blip.
            this.lastErrorMessage = error instanceof Error ? error.message : String(error);
          }
        }
        if (!reconnected && !this.closed) {
          this.callbacks.onError(new Error(this.lastErrorMessage ?? 'Gemini Live disconnected.'));
          return;
        }
      } while (this.pendingReconnect && !this.closed);
    } finally {
      this.reconnecting = false;
    }
  }

  sendPcm(frame: LiveSttPcmFrame): void {
    if (this.closed || this.reconnecting || !this.session) return;
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
  if (config.translate) return await OpenAiRealtimeTranslationSession.create(config, callbacks);
  return await OpenAiRealtimeTranscriptionSession.create(config, callbacks);
}
