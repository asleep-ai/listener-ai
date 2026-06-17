import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from '@google/genai';
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
    this.commit();
    await closeAfterDelay(this.ws, 500);
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
    // OpenAI Realtime has no `session.close` client event; emit whatever
    // translation has accumulated and close the socket directly. Sending the
    // unsupported event only drew a server error and forced the 2s timeout.
    this.emitFinal(this.callbacks);
    this.ws.close();
  }
}

class GeminiLiveSession implements LiveSttSession {
  readonly provider = 'gemini' as const;
  readonly kind: 'transcription' | 'translation';
  private inputTranscript = '';
  private outputTranscript = '';
  private closed = false;

  private constructor(
    private readonly session: Session,
    kind: 'transcription' | 'translation',
    private readonly callbacks: LiveSttCallbacks,
  ) {
    this.kind = kind;
  }

  static async create(
    config: LiveSttProviderConfig,
    callbacks: LiveSttCallbacks,
  ): Promise<GeminiLiveSession> {
    const apiKey = config.geminiApiKey?.trim();
    if (!apiKey) throw new Error('Gemini API key is not configured.');
    const translate = config.translate !== false;
    const ai = new GoogleGenAI({ apiKey });
    const holder: { live?: GeminiLiveSession } = {};
    const pendingMessages: LiveServerMessage[] = [];
    const model = translate
      ? DEFAULT_GEMINI_LIVE_TRANSLATION_MODEL
      : DEFAULT_GEMINI_LIVE_TRANSCRIPTION_MODEL;
    const session = await ai.live.connect({
      model,
      config: translate
        ? {
            responseModalities: [Modality.AUDIO],
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            translationConfig: {
              targetLanguageCode: config.translationLanguage?.trim() || 'ko',
              echoTargetLanguage: true,
            },
          }
        : {
            responseModalities: [Modality.AUDIO],
            inputAudioTranscription: {},
            systemInstruction:
              'You are a passive live captioner. Transcribe the user audio only. Do not answer, ask questions, or generate assistant content.',
          },
      callbacks: {
        onopen: () =>
          callbacks.onStatus?.(
            `Connected to Gemini Live ${translate ? 'translation' : 'transcription'}.`,
          ),
        onmessage: (message) => {
          if (holder.live) {
            holder.live.handleMessage(message);
          } else {
            pendingMessages.push(message);
          }
        },
        onerror: (event) => {
          callbacks.onError(new Error(event.message || 'Gemini Live connection failed.'));
        },
        onclose: () => {
          if (!holder.live?.closed) callbacks.onError(new Error('Gemini Live disconnected.'));
        },
      },
    });
    holder.live = new GeminiLiveSession(
      session,
      translate ? 'translation' : 'transcription',
      callbacks,
    );
    for (const message of pendingMessages) holder.live.handleMessage(message);
    return holder.live;
  }

  sendPcm(frame: LiveSttPcmFrame): void {
    if (frame.channelCount !== 1) return;
    const audio = pcmFrameToGeminiBase64(frame);
    if (!audio) return;
    this.session.sendRealtimeInput({
      audio: {
        data: audio,
        mimeType: `audio/pcm;rate=${GEMINI_PCM_RATE}`,
      },
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.session.sendRealtimeInput({ audioStreamEnd: true });
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    } catch {
      // Best-effort flush before closing the websocket.
    }
    this.emitFinal();
    this.session.close();
  }

  private handleMessage(message: LiveServerMessage): void {
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
