import WebSocket from 'ws';
import { SONIOX_REALTIME_MODEL } from './aiProvider';
import type {
  LiveSttCallbacks,
  LiveSttPcmFrame,
  LiveSttProviderConfig,
  LiveSttSession,
} from './liveSttProvider';
import { asUint8Array, downsamplePcm16, parseMessageData } from './liveSttUtils';
import { reportError } from './sentry';

export { SONIOX_REALTIME_MODEL };

export const SONIOX_REALTIME_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';
/** Soniox realtime takes raw little-endian 16-bit PCM; we downsample to 16 kHz. */
export const SONIOX_PCM_RATE = 16_000;

// Same reconnect policy as GeminiLiveSession (see liveSttProvider.ts): Soniox
// publishes no resumption handle, so a reconnect opens a brand-new stream with
// a fresh config frame and accepts the short gap. A sustained processing
// backlog closes the socket with code 1006 and no error frame, which is why a
// plain close is a reconnect trigger rather than a fatal error.
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 4_000;
const RECONNECT_STABLE_MS = 30_000;
const CONNECT_TIMEOUT_MS = 15_000;
// The docs require a control frame at least every 20s of silence.
const KEEPALIVE_INTERVAL_MS = 10_000;
// After the empty end-of-stream frame the server replies `finished: true`; cap
// the wait so a silent server can't hang stop().
const CLOSE_DRAIN_TIMEOUT_MS = 3_000;
// One-way translation tokens for a run can land in the message AFTER the
// `<end>` that closed it, so hold the final briefly to attach them.
const TRANSLATION_GRACE_MS = 1_500;

/** `<end>` = endpoint detected, `<fin>` = reply to a manual finalize. */
const CONTROL_TOKEN_TEXTS = new Set(['<end>', '<fin>']);

export type SonioxTranslationStatus = 'none' | 'original' | 'translation';

export interface SonioxToken {
  text?: string;
  start_ms?: number;
  end_ms?: number;
  confidence?: number;
  is_final?: boolean;
  speaker?: string;
  language?: string;
  translation_status?: SonioxTranslationStatus;
  source_language?: string;
}

export interface SonioxServerMessage {
  tokens?: SonioxToken[];
  final_audio_proc_ms?: number;
  total_audio_proc_ms?: number;
  finished?: boolean;
  error_code?: number;
  error_type?: string;
  error_message?: string;
  request_id?: string;
}

/** Minimal surface of a `ws` WebSocket, so tests can script the transport. */
export interface SonioxSocket {
  send(data: string | Uint8Array | Buffer): void;
  close(code?: number): void;
  on(event: 'open' | 'message' | 'close' | 'error', listener: (...args: never[]) => void): unknown;
}

export interface SonioxLiveSessionDeps {
  /** Override the socket factory (tests inject a scripted fake). */
  createWebSocket?: (url: string) => SonioxSocket;
  /** Override backoff/grace sleeps (tests collapse them so the loop runs instantly). */
  sleep?: (ms: number) => Promise<void>;
  /** Override the per-attempt connect timeout. */
  connectTimeoutMs?: number;
  /** Override the silence keepalive cadence. */
  keepaliveIntervalMs?: number;
  /** Override the clock used for send-idle tracking. */
  now?: () => number;
}

export class SonioxRealtimeError extends Error {
  readonly status?: number;
  readonly errorType?: string;
  readonly requestId?: string;

  constructor(
    message: string,
    details: { status?: number; errorType?: string; requestId?: string } = {},
  ) {
    super(message);
    this.name = 'SonioxRealtimeError';
    this.status = details.status;
    this.errorType = details.errorType;
    this.requestId = details.requestId;
  }
}

/**
 * Split a Soniox message's tokens into real speech and the endpoint signal.
 *
 * Control tokens (`<end>`, `<fin>`) and any token without a language tag are
 * dropped before assembly: the diarization audit in issue #195 showed the
 * endpoint marker turning into a phantom speaker/word when it reached turn
 * assembly. `enable_language_identification` is what guarantees real speech
 * tokens carry a language, so it stays on.
 */
export function filterSonioxTokens(tokens: readonly SonioxToken[] | undefined): {
  speech: SonioxToken[];
  endpoint: boolean;
} {
  const speech: SonioxToken[] = [];
  let endpoint = false;
  for (const token of tokens ?? []) {
    if (!token) continue;
    if (CONTROL_TOKEN_TEXTS.has((token.text ?? '').trim())) {
      endpoint = true;
      continue;
    }
    if (!token.language?.trim()) continue;
    speech.push(token);
  }
  return { speech, endpoint };
}

function isTranslationToken(token: SonioxToken): boolean {
  return token.translation_status === 'translation';
}

/** Soniox tokens carry their own leading spaces, so plain concatenation. */
function joinTokenText(tokens: readonly SonioxToken[]): string {
  return tokens
    .map((token) => token.text ?? '')
    .join('')
    .trim();
}

function firstStartMs(tokens: readonly SonioxToken[]): number | undefined {
  for (const token of tokens) {
    if (typeof token.start_ms === 'number') return token.start_ms;
  }
  return undefined;
}

function lastEndMs(tokens: readonly SonioxToken[]): number | undefined {
  for (let i = tokens.length - 1; i >= 0; i--) {
    const end = tokens[i]?.end_ms;
    if (typeof end === 'number') return end;
  }
  return undefined;
}

function dedupeLanguageHints(language: string | undefined): string[] {
  const hints: string[] = [];
  for (const hint of [language?.trim() || 'ko', 'en']) {
    if (hint && !hints.includes(hint)) hints.push(hint);
  }
  return hints;
}

/** 408/429/5xx are transport-shaped; everything else is a fatal client error. */
function isRetryableSonioxStatus(status: number | undefined): boolean {
  if (typeof status !== 'number') return false;
  if (status === 408 || status === 429) return true;
  return status >= 500 && status < 600;
}

function toSonioxRealtimeError(message: SonioxServerMessage): SonioxRealtimeError {
  const status = typeof message.error_code === 'number' ? message.error_code : undefined;
  const errorType = message.error_type?.trim() || undefined;
  const detail = message.error_message?.trim() || 'Soniox realtime error.';
  const label = [status, errorType].filter((part) => part !== undefined).join(' ');
  return new SonioxRealtimeError(label ? `Soniox realtime error (${label}): ${detail}` : detail, {
    status,
    errorType,
    requestId: message.request_id?.trim() || undefined,
  });
}

function toError(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value;
  return new Error(value ? String(value) : fallback);
}

export class SonioxLiveSession implements LiveSttSession {
  readonly provider = 'soniox' as const;
  readonly kind: 'transcription' | 'translation';

  private socket: SonioxSocket | null = null;
  private connected = false;
  private closed = false;
  private finishedSeen = false;
  private finishedResolve: (() => void) | null = null;

  private finalSourceTokens: SonioxToken[] = [];
  private finalTranslationTokens: SonioxToken[] = [];
  private nonFinalSourceTokens: SonioxToken[] = [];
  private nonFinalTranslationTokens: SonioxToken[] = [];
  private pendingFinal = false;
  /** Bumped on every flush so a stale grace timer can't settle a later run. */
  private runSeq = 0;

  private keepaliveTimer: NodeJS.Timeout | null = null;
  private lastSendAt = 0;

  private reconnectAttempts = 0;
  private reconnecting = false;
  private pendingReconnect = false;
  private firstConnectPending = true;
  private pendingConnectFail: ((error: Error) => void) | null = null;
  private lastConnectedAt = 0;
  private lastErrorMessage: string | undefined;
  private lastErrorExtra: Record<string, unknown> = {};

  private constructor(
    private readonly createWebSocketFn: (url: string) => SonioxSocket,
    private readonly sleepFn: (ms: number) => Promise<void>,
    private readonly connectTimeoutMs: number,
    private readonly keepaliveIntervalMs: number,
    private readonly nowFn: () => number,
    private readonly configFrame: string,
    kind: 'transcription' | 'translation',
    private readonly callbacks: LiveSttCallbacks,
  ) {
    this.kind = kind;
  }

  static async create(
    config: LiveSttProviderConfig,
    callbacks: LiveSttCallbacks,
    deps: SonioxLiveSessionDeps = {},
  ): Promise<SonioxLiveSession> {
    const apiKey = config.sonioxApiKey?.trim();
    if (!apiKey) throw new Error('Soniox API key is not configured.');
    // Unlike Gemini Live, translation is opt-in: it changes what the stream
    // returns (translated text alongside the source), so LiveSessionService
    // always passes the flag explicitly rather than inferring it. Soniox
    // bundles translation into the same $0.12/h realtime rate, so the choice
    // costs nothing extra.
    const translate = config.translate === true;
    const terms = (config.knownWords ?? [])
      .map((word) => word.trim())
      .filter((word) => word.length > 0);
    const frame: Record<string, unknown> = {
      api_key: apiKey,
      model: SONIOX_REALTIME_MODEL,
      audio_format: 'pcm_s16le',
      sample_rate: SONIOX_PCM_RATE,
      num_channels: 1,
      language_hints: dedupeLanguageHints(config.language),
      // Required for the no-language control-token filter to work.
      enable_language_identification: true,
      enable_endpoint_detection: true,
    };
    if (terms.length > 0) frame.context = { terms };
    if (translate) {
      frame.translation = {
        type: 'one_way',
        target_language: config.translationLanguage?.trim() || 'ko',
      };
    }
    const instance = new SonioxLiveSession(
      deps.createWebSocket ?? ((url) => new WebSocket(url)),
      deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
      deps.keepaliveIntervalMs ?? KEEPALIVE_INTERVAL_MS,
      deps.now ?? (() => Date.now()),
      JSON.stringify(frame),
      translate ? 'translation' : 'transcription',
      callbacks,
    );
    // The first connect rejects on failure so LiveSessionService can fall back
    // to another provider. Mark the instance closed on failure so a socket that
    // opens late can't start a background reconnect on a discarded instance.
    try {
      await instance.connect(false);
    } catch (error) {
      instance.closed = true;
      throw error;
    } finally {
      instance.firstConnectPending = false;
    }
    return instance;
  }

  private async connect(isResume: boolean): Promise<void> {
    let established = false;
    let timedOut = false;
    let settled = false;
    let settleOk: () => void = () => {};
    let settleFail: (error: Error) => void = () => {};
    const settlement = new Promise<void>((resolve, reject) => {
      settleOk = () => {
        if (settled) return;
        settled = true;
        this.pendingConnectFail = null;
        resolve();
      };
      settleFail = (error) => {
        if (settled) return;
        settled = true;
        this.pendingConnectFail = null;
        reject(error);
      };
    });
    this.pendingConnectFail = settleFail;

    const socket = this.createWebSocketFn(SONIOX_REALTIME_URL);
    this.socket = socket;
    this.connected = false;
    this.finishedSeen = false;

    socket.on('open', () => {
      if (timedOut || this.closed || this.socket !== socket) return;
      try {
        socket.send(this.configFrame);
      } catch (error) {
        settleFail(toError(error, 'Could not start the Soniox realtime stream.'));
        return;
      }
      this.lastSendAt = this.nowFn();
      this.connected = true;
      // Monotonic clock: connection-stability timing must not be skewed by
      // wall-clock adjustments.
      this.lastConnectedAt = performance.now();
      this.startKeepalive();
      this.callbacks.onStatus?.(
        isResume
          ? `Reconnected to Soniox realtime ${this.kind}.`
          : `Connected to Soniox realtime ${this.kind}.`,
      );
      // Give an immediate rejection (bad key, exhausted balance) one turn to
      // land so the first connect can reject instead of surfacing an error on
      // a session the caller already considers started.
      void this.sleepFn(0).then(() => {
        if (timedOut || this.socket !== socket) return;
        settleOk();
      });
    });

    socket.on('message', (data: unknown) => {
      if (timedOut || this.socket !== socket) return;
      this.handleRawMessage(socket, data);
    });

    socket.on('error', (error: unknown) => {
      // Let the close event drive reconnection; keep the message so a give-up
      // surfaces something meaningful.
      this.lastErrorMessage =
        error instanceof Error && error.message
          ? error.message
          : 'Soniox realtime connection failed.';
    });

    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.connected = false;
      this.stopKeepalive();
      // Unblock a close() that is draining for `finished: true`.
      this.finishedResolve?.();
      if (timedOut || this.closed) return;
      if (established) {
        void this.handleDisconnect();
      } else {
        settleFail(
          new Error(
            this.lastErrorMessage ??
              'Soniox realtime closed before the connection was established.',
          ),
        );
      }
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        settlement,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error('Timed out connecting to Soniox realtime.'));
          }, this.connectTimeoutMs);
        }),
      ]);
      established = true;
    } catch (error) {
      this.pendingConnectFail = null;
      this.stopKeepalive();
      this.connected = false;
      if (this.socket === socket) this.socket = null;
      try {
        socket.close();
      } catch {
        // The socket may already be gone.
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async handleDisconnect(): Promise<void> {
    if (this.closed) return;
    // Don't lose the run that was in flight when the socket dropped.
    this.flushFinal();
    if (this.reconnecting) {
      this.pendingReconnect = true;
      return;
    }
    this.reconnecting = true;
    try {
      do {
        this.pendingReconnect = false;
        // A connection that stayed up comfortably is a fresh failure, not a
        // flapping retry storm -- reset the counter so a long session can keep
        // reconnecting indefinitely.
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
            `Reconnecting to Soniox realtime ${this.kind} (attempt ${this.reconnectAttempts})...`,
          );
          await this.sleepFn(delayMs);
          if (this.closed) return;
          try {
            await this.connect(true);
            if (this.closed) {
              // close() landed during the reconnect; don't leak the new socket.
              this.teardownSocket();
              return;
            }
            reconnected = true;
            break;
          } catch (error) {
            this.lastErrorMessage = error instanceof Error ? error.message : String(error);
          }
        }
        if (!reconnected && !this.closed) {
          const error = new Error(this.lastErrorMessage ?? 'Soniox realtime disconnected.');
          reportError(error, {
            operation: 'liveSession.sonioxReconnectExhausted',
            extra: this.lastErrorExtra,
          });
          this.lastErrorExtra = {};
          this.callbacks.onError(error);
          return;
        }
      } while (this.pendingReconnect && !this.closed);
    } finally {
      this.reconnecting = false;
    }
  }

  private handleRawMessage(socket: SonioxSocket, data: unknown): void {
    let message: SonioxServerMessage;
    try {
      message = JSON.parse(parseMessageData(data)) as SonioxServerMessage;
    } catch {
      // Non-JSON frames are not part of the protocol; ignore them.
      return;
    }
    if (typeof message.error_code === 'number' || message.error_message) {
      this.handleErrorFrame(socket, message);
      return;
    }
    this.handleTokens(message);
    if (message.finished === true) {
      this.finishedSeen = true;
      this.flushFinal();
      this.finishedResolve?.();
    }
  }

  private handleErrorFrame(socket: SonioxSocket, message: SonioxServerMessage): void {
    const error = toSonioxRealtimeError(message);
    this.lastErrorMessage = error.message;
    this.lastErrorExtra = {
      status: error.status,
      errorType: error.errorType,
      requestId: error.requestId,
    };
    if (isRetryableSonioxStatus(error.status)) {
      // Transport-shaped: treat it like a dropped connection. Closing here is
      // defensive -- the server closes after an error frame anyway -- and the
      // close handler drives the reconnect loop.
      try {
        socket.close();
      } catch {
        // Already closing.
      }
      return;
    }
    // Auth, balance, plan and duration-cap failures never recover on a retry.
    // Emit whatever was already transcribed first: close() is a no-op once
    // `closed` is set, so this is the last chance to flush it.
    this.flushFinal();
    this.closed = true;
    this.stopKeepalive();
    reportError(error, {
      operation: 'liveSession.sonioxFatalFrame',
      extra: this.lastErrorExtra,
    });
    this.lastErrorExtra = {};
    if (this.firstConnectPending && this.pendingConnectFail) {
      // create() rejects instead, so the caller can fall back without also
      // seeing a session-level error for a session that never started.
      this.pendingConnectFail(error);
    } else {
      this.pendingConnectFail?.(error);
      this.callbacks.onError(error);
    }
    this.teardownSocket();
  }

  private handleTokens(message: SonioxServerMessage): void {
    const { speech, endpoint } = filterSonioxTokens(message.tokens);
    const finalSource: SonioxToken[] = [];
    const finalTranslation: SonioxToken[] = [];
    const nonFinalSource: SonioxToken[] = [];
    const nonFinalTranslation: SonioxToken[] = [];
    for (const token of speech) {
      const translation = isTranslationToken(token);
      if (token.is_final === true) {
        (translation ? finalTranslation : finalSource).push(token);
      } else {
        (translation ? nonFinalTranslation : nonFinalSource).push(token);
      }
    }

    // Translation finals in this message belong to the run that is still
    // pending, so buffer them BEFORE deciding to settle it. Soniox commonly
    // sends run A's translation in the same message as run B's first source
    // tokens; flushing first would ship A untranslated and hand its
    // translation to B.
    this.finalTranslationTokens.push(...finalTranslation);

    // A final held back for late translation tokens is settled the moment new
    // source speech arrives: the previous run is definitively over.
    if (this.pendingFinal && (finalSource.length > 0 || nonFinalSource.length > 0)) {
      this.flushFinal();
    }

    this.finalSourceTokens.push(...finalSource);
    this.nonFinalSourceTokens = nonFinalSource;
    this.nonFinalTranslationTokens = nonFinalTranslation;

    const sourceTokens = [...this.finalSourceTokens, ...this.nonFinalSourceTokens];
    const interim = joinTokenText(sourceTokens);
    if (interim) {
      this.callbacks.onInterim({ text: interim, offsetMs: firstStartMs(sourceTokens) });
    }
    if (nonFinalTranslation.length > 0) {
      const translationTokens = [...this.finalTranslationTokens, ...this.nonFinalTranslationTokens];
      const interimTranslation = joinTokenText(translationTokens);
      if (interimTranslation) {
        this.callbacks.onTranslationInterim?.({
          text: interimTranslation,
          offsetMs: firstStartMs(sourceTokens),
        });
      }
    }

    if (endpoint) this.finalizeRun();
  }

  private finalizeRun(): void {
    if (this.kind === 'translation') {
      if (this.pendingFinal) return;
      this.pendingFinal = true;
      const run = this.runSeq;
      void this.sleepFn(TRANSLATION_GRACE_MS).then(() => {
        // A run flushed early by new speech leaves its grace timer behind; it
        // must not settle whatever run is pending by the time it fires.
        if (this.pendingFinal && this.runSeq === run) this.flushFinal();
      });
      return;
    }
    this.flushFinal();
  }

  private flushFinal(): void {
    this.pendingFinal = false;
    this.runSeq++;
    const sourceTokens = this.finalSourceTokens;
    const translationTokens = this.finalTranslationTokens;
    this.finalSourceTokens = [];
    this.finalTranslationTokens = [];
    // Non-finals are a full hypothesis that the server re-sends on every
    // message, so the next message restores anything still in flight.
    this.nonFinalSourceTokens = [];
    this.nonFinalTranslationTokens = [];
    const text = joinTokenText(sourceTokens);
    if (!text) return;
    const start = firstStartMs(sourceTokens);
    const end = lastEndMs(sourceTokens);
    const translation = joinTokenText(translationTokens);
    this.callbacks.onFinal({
      text,
      offsetMs: start,
      durationMs:
        typeof start === 'number' && typeof end === 'number' ? Math.max(0, end - start) : undefined,
      translation: translation || undefined,
    });
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    // Tick at half the cadence so a skewed timer can't push a keepalive past
    // the provider's 20s silence budget.
    const tickMs = Math.max(1, Math.floor(this.keepaliveIntervalMs / 2));
    const timer = setInterval(() => {
      if (this.closed || !this.connected || !this.socket) return;
      if (this.nowFn() - this.lastSendAt < this.keepaliveIntervalMs) return;
      try {
        this.socket.send(JSON.stringify({ type: 'keepalive' }));
        this.lastSendAt = this.nowFn();
      } catch {
        // The socket may be tearing down; the close handler takes over.
      }
    }, tickMs);
    timer.unref?.();
    this.keepaliveTimer = timer;
  }

  private stopKeepalive(): void {
    if (!this.keepaliveTimer) return;
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  private teardownSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    if (!socket) return;
    try {
      socket.close();
    } catch {
      // Already closing.
    }
  }

  sendPcm(frame: LiveSttPcmFrame): void {
    if (this.closed || this.reconnecting || !this.connected || !this.socket) return;
    if (frame.channelCount !== 1) return;
    const pcm = downsamplePcm16(asUint8Array(frame.audioData), frame.sampleRate, SONIOX_PCM_RATE);
    if (pcm.byteLength === 0) return;
    try {
      this.socket.send(pcm);
      this.lastSendAt = this.nowFn();
    } catch {
      // The socket may be tearing down just before a reconnect; drop the frame.
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopKeepalive();
    const socket = this.socket;
    if (socket && this.connected) {
      try {
        // End of stream: the server replies `finished: true` and closes.
        socket.send('');
        await this.waitForFinished();
      } catch {
        // Best-effort flush before closing the socket.
      }
    }
    this.flushFinal();
    this.teardownSocket();
  }

  private waitForFinished(): Promise<void> {
    if (this.finishedSeen) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const settle = () => {
        if (this.finishedResolve !== settle) return;
        this.finishedResolve = null;
        resolve();
      };
      this.finishedResolve = settle;
      void this.sleepFn(CLOSE_DRAIN_TIMEOUT_MS).then(settle);
    });
  }
}
