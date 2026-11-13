// Routes live-caption capture to the hidden capture host.
//
// LiveSessionService stays the authority for the session, its segments, hints
// and snapshot. The capture host (src/captureHost.ts, renderer/capture/live.ts)
// owns the audio side: PCM to streaming providers, the OpenAI Realtime WebRTC
// peer and the chunked snippet uploads. This router connects the two. A start
// creates the session and hands it to the host. Every stop -- the dialog's
// Stop, a recording stop, quit -- fences hints, lets the host flush its tail
// (final WebRTC commit, last chunked window) and only then closes the
// provider. Losing the host ends the session as `renderer-lost`. The visible
// window is only an observer: its reload, crash or destruction changes
// nothing here, and the client secret never reaches it.
//
// Dependencies are injected so the routing runs under `node --test`.

import type {
  LiveSessionEndReason,
  LiveSessionEvent,
  LiveSessionSnapshot,
  LiveSessionStartResult,
} from './liveSessionService';
import type { CaptureHostLiveEvent, LiveCaptureStartCommand } from './recordingState';

/** Upper bound for the host's flush (WebRTC tail plus a last chunked upload). */
export const DEFAULT_LIVE_FLUSH_TIMEOUT_MS = 15_000;

export interface LiveCaptureServicePort {
  start(input: { title?: string; translate?: boolean }): Promise<LiveSessionStartResult>;
  stop(sessionId: string, reason?: LiveSessionEndReason): Promise<LiveSessionSnapshot | null>;
  stopActive(reason: LiveSessionEndReason): Promise<LiveSessionSnapshot | null>;
  beginStop(sessionId: string): boolean;
  setTranslate(sessionId: string, translate: boolean): LiveSessionSnapshot | null;
  snapshot(): LiveSessionSnapshot | null;
}

export interface LiveCaptureHostPort {
  /** A recording runs in the capture host, so live capture can attach to it. */
  available(): boolean;
  startLive(command: LiveCaptureStartCommand): void;
  stopLive(liveSessionId: string): void;
  setTranslate(liveSessionId: string, translate: boolean): void;
}

export interface LiveCaptureRouterDeps {
  service: LiveCaptureServicePort;
  host: LiveCaptureHostPort;
  emit(event: LiveSessionEvent): void;
  flushTimeoutMs?: number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  reportError?(error: unknown, operation: string): void;
}

/** Live captions need a running recording to capture from. */
export class LiveCaptureUnavailableError extends Error {
  constructor(message = 'Start recording before starting live captions.') {
    super(message);
    this.name = 'LiveCaptureUnavailableError';
  }
}

export class LiveCaptureRouter {
  private readonly deps: LiveCaptureRouterDeps;
  /** The live session the host is capturing, if any. */
  private hostSessionId: string | null = null;
  private readonly flushWaiters = new Map<string, () => void>();
  private readonly stops = new Map<string, Promise<LiveSessionSnapshot | null>>();
  /** Capture failures reported by the host, carried on the `ended` event. */
  private readonly failures = new Map<string, string>();
  /** Sessions whose terminal `ended` was published: each gets exactly one. */
  private readonly ended = new Set<string>();

  constructor(deps: LiveCaptureRouterDeps) {
    this.deps = deps;
  }

  /** The session the host currently captures (tests and diagnostics). */
  capturedSessionId(): string | null {
    return this.hostSessionId;
  }

  /**
   * Starts a session and its capture in the host. The result never carries the
   * realtime client secret: only the host needs it.
   */
  async start(input: { title?: string; translate?: boolean }): Promise<LiveSessionStartResult> {
    if (!this.deps.host.available()) throw new LiveCaptureUnavailableError();
    // A replaced session flushes its host tail like any other stop.
    const previous = this.deps.service.snapshot();
    if (previous?.active) await this.stop(previous.sessionId, 'user');
    const result = await this.deps.service.start(input);
    const { realtimeClient, ...visible } = result;
    const current = this.deps.service.snapshot();
    // Stopped or replaced while starting: whoever stopped it owns the teardown.
    if (current?.sessionId !== result.sessionId || !current.active) return visible;
    if (!this.deps.host.available()) {
      // The recording stopped while the provider connected.
      await this.stop(result.sessionId, 'user');
      throw new LiveCaptureUnavailableError();
    }
    try {
      this.deps.host.startLive({
        type: 'live-start',
        liveSessionId: result.sessionId,
        mode: result.mode,
        translate: result.translate,
        startedAtMs: Date.parse(result.startedAt) || Date.now(),
        ...(realtimeClient ? { realtimeClient } : {}),
      });
      this.hostSessionId = result.sessionId;
    } catch (error) {
      this.deps.reportError?.(error, 'live.host-start');
      await this.stop(result.sessionId, 'user');
      throw error;
    }
    return visible;
  }

  /**
   * Stops a session: hint admission closes first, the host flushes its tail,
   * then the provider closes and drains. Concurrent stops join one another.
   */
  stop(
    sessionId: string,
    reason: LiveSessionEndReason = 'user',
  ): Promise<LiveSessionSnapshot | null> {
    const pending = this.stops.get(sessionId);
    if (pending) {
      // Host loss promotes a draining stop, as the service does.
      if (reason === 'renderer-lost') void this.deps.service.stop(sessionId, reason);
      return pending;
    }
    const snapshot = this.deps.service.snapshot();
    if (!snapshot || snapshot.sessionId !== sessionId) return Promise.resolve(null);
    // Already stopping or stopped through the service itself: join it there.
    if (!snapshot.active) return this.deps.service.stop(sessionId, reason);
    const run = this.runStop(sessionId, reason);
    this.stops.set(sessionId, run);
    const clear = () => {
      if (this.stops.get(sessionId) === run) this.stops.delete(sessionId);
    };
    run.then(clear, clear);
    return run;
  }

  /** Ends whatever session runs (recording stop, quit). Undefined when none. */
  stopActive(
    reason: LiveSessionEndReason = 'user',
  ): Promise<LiveSessionSnapshot | null> | undefined {
    const current = this.deps.service.snapshot();
    if (!current) return undefined;
    const pending = this.stops.get(current.sessionId);
    if (pending) return pending;
    // Ended, or draining after host loss: join that drain (resolved if done).
    if (!current.active) return this.deps.service.stop(current.sessionId, reason);
    return this.stop(current.sessionId, reason);
  }

  private async runStop(
    sessionId: string,
    reason: LiveSessionEndReason,
  ): Promise<LiveSessionSnapshot | null> {
    this.deps.service.beginStop(sessionId);
    await this.flushHost(sessionId);
    const snapshot = await this.deps.service.stop(sessionId, reason);
    const error = this.failures.get(sessionId);
    this.failures.delete(sessionId);
    if (snapshot) this.emitEnded(sessionId, snapshot.endedReason ?? reason, error);
    return snapshot;
  }

  private flushHost(sessionId: string): Promise<void> {
    if (this.hostSessionId !== sessionId) return Promise.resolve();
    this.hostSessionId = null;
    return new Promise<void>((resolve) => {
      const setTimer = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
      const clearTimer =
        this.deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
      const done = () => {
        if (this.flushWaiters.get(sessionId) === done) this.flushWaiters.delete(sessionId);
        clearTimer(timer);
        resolve();
      };
      const timer = setTimer(() => {
        console.warn('Capture host did not finish flushing live captions; closing the provider');
        done();
      }, this.deps.flushTimeoutMs ?? DEFAULT_LIVE_FLUSH_TIMEOUT_MS);
      this.flushWaiters.set(sessionId, done);
      try {
        this.deps.host.stopLive(sessionId);
      } catch (error) {
        this.deps.reportError?.(error, 'live.host-stop');
        done();
      }
    });
  }

  setTranslate(sessionId: string, translate: boolean): LiveSessionSnapshot | null {
    const snapshot = this.deps.service.setTranslate(sessionId, translate);
    if (snapshot && this.hostSessionId === sessionId) {
      try {
        this.deps.host.setTranslate(sessionId, translate);
      } catch (error) {
        this.deps.reportError?.(error, 'live.host-translate');
      }
    }
    return snapshot;
  }

  hostEvent(event: CaptureHostLiveEvent): void {
    const id = event.liveSessionId;
    if (typeof id !== 'string') return;
    switch (event.type) {
      case 'live-stopped':
        this.flushWaiters.get(id)?.();
        return;
      case 'live-error':
        if (this.deps.service.snapshot()?.sessionId === id && typeof event.error === 'string') {
          this.deps.emit({ type: 'error', sessionId: id, error: event.error });
        }
        return;
      case 'live-failed': {
        const current = this.deps.service.snapshot();
        // A stale session, or one whose end was already published.
        if (current?.sessionId !== id || this.ended.has(id)) return;
        const error = typeof event.error === 'string' ? event.error : 'Live captions failed.';
        // The host stopped capturing this session.
        if (this.hostSessionId === id) this.hostSessionId = null;
        if (current.active) {
          this.failures.set(id, error);
          this.deps.emit({ type: 'error', sessionId: id, error });
          void this.stop(id, 'user').catch((err) =>
            this.deps.reportError?.(err, 'live.failed-stop'),
          );
          return;
        }
        // Main already ended the session while failing it (OpenAI Realtime
        // failed and no streaming or chunked fallback is usable): nothing is
        // left to stop, but the window must still learn it ended. A stop in
        // flight publishes its own `ended` and carries the failure.
        if (this.stops.has(id)) {
          this.failures.set(id, error);
          return;
        }
        this.deps.emit({ type: 'error', sessionId: id, error });
        this.emitEnded(id, current.endedReason ?? 'user', error);
        return;
      }
      default:
        return;
    }
  }

  /**
   * The capture host crashed or closed: nothing feeds the session any more.
   * Ends it as `renderer-lost` (also failing a start in flight) and resolves
   * once the provider drained.
   */
  async hostLost(): Promise<void> {
    this.hostSessionId = null;
    for (const release of this.flushWaiters.values()) release();
    const current = this.deps.service.snapshot();
    const joined = current ? this.stops.get(current.sessionId) : undefined;
    const snapshot = await this.deps.service.stopActive('renderer-lost');
    // A router stop in flight joins the same close and emits `ended` itself.
    if (snapshot && !joined) {
      this.emitEnded(snapshot.sessionId, snapshot.endedReason ?? 'renderer-lost');
    }
    await joined?.catch(() => {});
  }

  private emitEnded(sessionId: string, reason: LiveSessionEndReason, error?: string): void {
    if (this.ended.has(sessionId)) return;
    this.ended.add(sessionId);
    this.deps.emit({ type: 'ended', sessionId, reason, ...(error ? { error } : {}) });
  }
}
