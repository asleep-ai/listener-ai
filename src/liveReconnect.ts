/**
 * Reconnect lifecycle shared by the streaming live-STT providers.
 *
 * GeminiLiveSession (liveSttProvider.ts) and SonioxLiveSession
 * (sonioxLiveProvider.ts) recover from a dropped connection the same way over
 * two different transports: a bounded number of attempts with exponential
 * backoff, a stability reset so a long-running session keeps recovering, and a
 * per-attempt connect timeout. Only the transport differs, so the policy lives
 * here and each provider keeps nothing but its protocol handling.
 */

export const MAX_RECONNECT_ATTEMPTS = 5;
export const RECONNECT_BASE_DELAY_MS = 500;
export const RECONNECT_MAX_DELAY_MS = 4_000;
export const RECONNECT_STABLE_MS = 30_000;
// @google/genai (2.16) resolves ai.live.connect only after the server's
// setupComplete message and never settles it when the socket errors/closes
// first -- whether that close lands before onopen or in the open-but-not-set-up
// window. Our onclose handler fails the attempt for both cases; the timeout
// bounds the remaining silent hangs (dead network, no close event) so a wedged
// attempt fails and the loop can retry or give up.
export const CONNECT_TIMEOUT_MS = 15_000;

/**
 * One connect attempt. The latches are what a transport callback reads to tell
 * its own attempt apart from the one that replaced it.
 */
export interface LiveConnectAttempt {
  /**
   * True once this attempt lost the race to the connect timeout. A late
   * callback from an abandoned attempt must bail out: the connection that
   * replaced it owns the session.
   */
  readonly timedOut: boolean;
  /**
   * True once the attempt won its race and became the live connection. Only a
   * fully established connection may drive the reconnect loop.
   */
  readonly established: boolean;
  /** Fail the attempt from a transport callback (e.g. a close before setup). */
  fail(error: Error): void;
  /**
   * Race the transport's own "connected" promise against the connect timeout.
   * `adopt` stores the resulting handle before the attempt latches as
   * established, so a callback can never see an established attempt whose
   * handle is not in place yet.
   */
  establish<T>(connected: Promise<T>, adopt?: (value: T) => void): Promise<T>;
}

export interface LiveReconnectOptions {
  /** Provider name used in the status lines, timeout and give-up messages. */
  label: string;
  kind: 'transcription' | 'translation';
  /** The session's close latch: the loop stops at every step once it is set. */
  isClosed: () => boolean;
  /** Open a replacement connection (the provider's own connect, as a resume). */
  connect: () => Promise<void>;
  /** Close a connection the loop opened after close() had already landed. */
  teardown: () => void;
  onStatus: (status: string) => void;
  onError: (error: Error) => void;
  /** Runs on every disconnect, including one coalesced into a running loop. */
  onBeforeReconnect?: () => void;
  /** Runs once the budget is spent, just before the error is surfaced. */
  onExhausted?: (error: Error) => void;
  /** Backoff wait; the optional signal cancels it (see `abortSignal`). */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Cancels a backoff wait so it cannot outlive the session. */
  abortSignal?: AbortSignal;
  connectTimeoutMs: number;
}

export class LiveReconnectController {
  /**
   * Latest transport failure text. Both the providers' connect handlers and
   * the loop write it, and the give-up error falls back to it, so a single
   * owner keeps the surfaced message fresh.
   */
  lastErrorMessage: string | undefined;

  private attempts = 0;
  private running = false;
  private pending = false;
  private lastConnectedAt = 0;

  constructor(private readonly options: LiveReconnectOptions) {}

  /** True while the loop owns the transport; senders drop frames meanwhile. */
  get reconnecting(): boolean {
    return this.running;
  }

  /**
   * Stamp the connection as up. Monotonic clock: connection-stability timing
   * must not be skewed by wall-clock adjustments (NTP, manual changes).
   */
  markConnected(): void {
    this.lastConnectedAt = performance.now();
  }

  beginConnect(): LiveConnectAttempt {
    let timedOut = false;
    let established = false;
    let failAttempt: (error: Error) => void = () => {};
    const attemptFailure = new Promise<never>((_, reject) => {
      failAttempt = reject;
    });
    const { label, connectTimeoutMs } = this.options;
    return {
      get timedOut() {
        return timedOut;
      },
      get established() {
        return established;
      },
      fail(error: Error): void {
        failAttempt(error);
      },
      async establish<T>(connected: Promise<T>, adopt?: (value: T) => void): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const value = await Promise.race([
            connected,
            attemptFailure,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                timedOut = true;
                reject(new Error(`Timed out connecting to ${label}.`));
              }, connectTimeoutMs);
            }),
          ]);
          adopt?.(value);
          established = true;
          return value;
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
    };
  }

  async handleDisconnect(): Promise<void> {
    const { options } = this;
    if (options.isClosed()) return;
    options.onBeforeReconnect?.();
    if (this.running) {
      // A close fired while we were already reconnecting; re-run once we settle.
      this.pending = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.pending = false;
        // A connection that stayed up comfortably (e.g. the ~10-min cap) is a
        // fresh failure, not a flapping retry storm -- reset the counter so a
        // long-running session can keep reconnecting indefinitely.
        if (
          this.lastConnectedAt &&
          performance.now() - this.lastConnectedAt > RECONNECT_STABLE_MS
        ) {
          this.attempts = 0;
        }
        let reconnected = false;
        while (!options.isClosed() && this.attempts < MAX_RECONNECT_ATTEMPTS) {
          this.attempts++;
          const delayMs = Math.min(
            RECONNECT_MAX_DELAY_MS,
            RECONNECT_BASE_DELAY_MS * 2 ** (this.attempts - 1),
          );
          options.onStatus(
            `Reconnecting to ${options.label} ${options.kind} (attempt ${this.attempts})...`,
          );
          await options.sleep(delayMs, options.abortSignal);
          if (options.isClosed()) return;
          try {
            await options.connect();
            if (options.isClosed()) {
              // close() landed during the reconnect; don't leak the new socket.
              options.teardown();
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
        if (!reconnected && !options.isClosed()) {
          const error = new Error(this.lastErrorMessage ?? `${options.label} disconnected.`);
          options.onExhausted?.(error);
          options.onError(error);
          return;
        }
      } while (this.pending && !options.isClosed());
    } finally {
      this.running = false;
    }
  }
}
