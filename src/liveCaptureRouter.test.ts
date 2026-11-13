import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { LiveCaptureRouter, LiveCaptureUnavailableError } from './liveCaptureRouter';
import {
  LiveChunkedCaptionsUnavailableError,
  LiveSessionEndedError,
  LiveSessionService,
  type LiveSessionEvent,
} from './liveSessionService';
import type { LiveSttCallbacks, LiveSttSession } from './liveSttProvider';
import type { LiveCaptureStartCommand } from './recordingState';
import { makeTempDir, rmDir } from './test-helpers';

let workDir: string;
const owned = new Set<LiveSessionService>();

beforeEach(() => {
  workDir = makeTempDir('live-capture-router');
});

afterEach(async () => {
  try {
    await Promise.all(Array.from(owned, (service) => service.stopActive('user')));
  } finally {
    owned.clear();
    rmDir(workDir);
  }
});

type HostCall =
  | { type: 'start'; command: LiveCaptureStartCommand }
  | { type: 'stop'; id: string }
  | { type: 'translate'; id: string; translate: boolean };

function setup(
  opts: {
    realtime?: boolean;
    autoAck?: boolean;
    flushTimeoutMs?: number;
    available?: () => boolean;
    /** No streaming provider connects and chunked captions have no backend. */
    noFallback?: boolean;
  } = {},
) {
  const calls: HostCall[] = [];
  const events: LiveSessionEvent[] = [];
  const timers: Array<() => void> = [];
  let callbacks: LiveSttCallbacks | undefined;
  let closes = 0;
  const stream: LiveSttSession = {
    provider: 'gemini',
    kind: 'translation',
    sendPcm: () => {},
    async close() {
      closes++;
    },
  };
  const service = new LiveSessionService({
    getDataPath: () => workDir,
    ensureGeminiService: () => null,
    getAgentService: () => null,
    formatAiCredentialsError: () => 'missing credentials',
    getLiveSttConfig: () =>
      opts.realtime
        ? { provider: 'openai', openaiApiKey: 'sk-test' }
        : { provider: 'gemini', geminiApiKey: 'gemini-key' },
    createLiveSttSession: async (_config, cbs) => {
      if (opts.noFallback) throw new Error('streaming provider refused');
      callbacks = cbs;
      return stream;
    },
    getChunkedCaptionsIssue: opts.noFallback ? () => 'No batch transcription backend.' : undefined,
    createRealtimeClientConfig: opts.realtime
      ? async () => ({ transport: 'webrtc', endpoint: 'realtime', clientSecret: 'ek_secret' })
      : undefined,
    emitEvent: (event) => events.push(event),
  });
  owned.add(service);
  let router: LiveCaptureRouter;
  const ack = (id: string) => router.hostEvent({ type: 'live-stopped', liveSessionId: id });
  router = new LiveCaptureRouter({
    service,
    host: {
      available: opts.available ?? (() => true),
      startLive: (command) => calls.push({ type: 'start', command }),
      stopLive: (id) => {
        calls.push({ type: 'stop', id });
        if (opts.autoAck !== false) queueMicrotask(() => ack(id));
      },
      setTranslate: (id, translate) => calls.push({ type: 'translate', id, translate }),
    },
    emit: (event) => events.push(event),
    flushTimeoutMs: opts.flushTimeoutMs,
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length - 1;
    },
    clearTimer: () => {},
  });
  return {
    service,
    router,
    calls,
    events,
    timers,
    ack,
    closes: () => closes,
    callbacks: () => callbacks!,
  };
}

const ended = (events: LiveSessionEvent[]) => events.filter((event) => event.type === 'ended');

describe('LiveCaptureRouter', () => {
  it('hands a started session to the capture host and keeps the client secret out of the result', async () => {
    const { router, calls, service } = setup({ realtime: true });
    const result = await router.start({ title: 'Live', translate: false });
    assert.equal(result.realtimeClient, undefined);
    assert.equal(calls.length, 1);
    const start = calls[0];
    assert.equal(start.type, 'start');
    if (start.type !== 'start') return;
    assert.equal(start.command.liveSessionId, result.sessionId);
    assert.equal(start.command.mode, 'streaming');
    assert.equal(start.command.translate, false);
    assert.equal(start.command.startedAtMs, Date.parse(result.startedAt));
    assert.deepEqual(start.command.realtimeClient, {
      transport: 'webrtc',
      endpoint: 'realtime',
      clientSecret: 'ek_secret',
    });
    assert.equal(router.capturedSessionId(), result.sessionId);
    assert.equal(service.isActive(), true);
  });

  it('refuses to start without a recording in the host and creates no session', async () => {
    const { router, calls, service } = setup({ available: () => false });
    await assert.rejects(router.start({}), LiveCaptureUnavailableError);
    assert.equal(service.snapshot(), null);
    assert.deepEqual(calls, []);
  });

  it('lets the host flush its tail before the provider closes, then reports the end once', async () => {
    const { router, calls, events, service, ack, closes, callbacks } = setup({ autoAck: false });
    const { sessionId } = await router.start({ translate: false });
    const stopping = router.stop(sessionId);
    // Hint admission is fenced and the host was asked to flush; the provider is still open.
    assert.deepEqual(calls.at(-1), { type: 'stop', id: sessionId });
    assert.equal(service.snapshot()?.hints?.status.state, 'stopped');
    assert.equal(closes(), 0);
    // The recording stop joins the same stop instead of closing twice.
    assert.equal(router.stopActive('user'), stopping);
    // A final flushed by the host's tail lands before the close.
    callbacks().onFinal({ text: 'Speaker: the last words.', offsetMs: 1_000, durationMs: 500 });
    await new Promise((resolve) => setImmediate(resolve));
    ack(sessionId);
    const snapshot = await stopping;
    assert.equal(closes(), 1);
    assert.equal(snapshot?.endedReason, 'user');
    assert.equal(snapshot?.segments.at(-1)?.transcript, 'Speaker: the last words.');
    assert.deepEqual(ended(events), [{ type: 'ended', sessionId, reason: 'user' }]);
    assert.equal(router.capturedSessionId(), null);
    assert.equal(calls.filter((call) => call.type === 'stop').length, 1);
  });

  it('closes the provider after the flush timeout when the host never confirms', async () => {
    const { router, timers, closes } = setup({ autoAck: false, flushTimeoutMs: 5 });
    const { sessionId } = await router.start({ translate: false });
    const stopping = router.stop(sessionId);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closes(), 0);
    timers.at(-1)!();
    assert.equal((await stopping)?.endedReason, 'user');
    assert.equal(closes(), 1);
  });

  it('flushes a running session through the host before a replacement starts', async () => {
    const { router, calls, events, closes } = setup();
    const first = await router.start({ translate: false });
    const second = await router.start({ translate: false });
    assert.notEqual(second.sessionId, first.sessionId);
    assert.deepEqual(
      calls.map((call) => call.type),
      ['start', 'stop', 'start'],
    );
    assert.equal(closes(), 1);
    assert.deepEqual(ended(events), [
      { type: 'ended', sessionId: first.sessionId, reason: 'user' },
    ]);
    assert.equal(router.capturedSessionId(), second.sessionId);
  });

  it('ends the session as renderer-lost when the capture host is lost, without commanding it', async () => {
    const { router, calls, events, service, closes } = setup();
    const { sessionId } = await router.start({ translate: false });
    await router.hostLost();
    assert.equal(closes(), 1);
    assert.equal(service.snapshot()?.endedReason, 'renderer-lost');
    assert.equal(service.snapshot()?.active, false);
    assert.deepEqual(ended(events), [{ type: 'ended', sessionId, reason: 'renderer-lost' }]);
    assert.deepEqual(
      calls.map((call) => call.type),
      ['start'],
    );
    // The recording finalize that follows joins the finished drain.
    assert.equal((await router.stopActive('user'))?.endedReason, 'renderer-lost');
    assert.equal(closes(), 1);
    assert.equal(ended(events).length, 1);
  });

  it('host loss releases a stop waiting on the host flush and promotes it', async () => {
    const { router, events, closes } = setup({ autoAck: false });
    const { sessionId } = await router.start({ translate: false });
    const stopping = router.stop(sessionId);
    await router.hostLost();
    assert.equal((await stopping)?.endedReason, 'renderer-lost');
    assert.equal(closes(), 1);
    assert.deepEqual(ended(events), [{ type: 'ended', sessionId, reason: 'renderer-lost' }]);
  });

  it('host loss while the provider connects fails that start', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { router, service, calls } = setup();
    const opts = (service as unknown as { opts: { createLiveSttSession: unknown } }).opts;
    const create = opts.createLiveSttSession as (...args: unknown[]) => Promise<LiveSttSession>;
    opts.createLiveSttSession = async (...args: unknown[]) => {
      await gate;
      return create(...args);
    };
    const starting = router.start({ translate: false });
    await new Promise((resolve) => setImmediate(resolve));
    const lost = router.hostLost();
    release();
    await assert.rejects(starting, LiveSessionEndedError);
    await lost;
    assert.deepEqual(calls, []);
    assert.equal(service.isActive(), false);
  });

  it('ends a session whose capture failed with the error on the end event', async () => {
    const { router, events, service } = setup();
    const { sessionId } = await router.start({ translate: false });
    router.hostEvent({ type: 'live-failed', liveSessionId: sessionId, error: 'No fallback.' });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(service.isActive(), false);
    assert.deepEqual(
      events.filter((event) => event.type === 'error' || event.type === 'ended').slice(-2),
      [
        { type: 'error', sessionId, error: 'No fallback.' },
        { type: 'ended', sessionId, reason: 'user', error: 'No fallback.' },
      ],
    );
  });

  // OpenAI Realtime fails in the host and neither a streaming provider nor
  // chunked captions can take over: main ends the session while failing the
  // fallback, then the host reports live-failed for an already-inactive
  // session. The window must still get exactly one terminal `ended`.
  it('publishes the end of a session main already ended when its realtime fallback had nothing to use', async () => {
    const { router, events, service } = setup({ realtime: true, noFallback: true });
    const { sessionId } = await router.start({ title: 'Live', translate: false });
    assert.equal(router.capturedSessionId(), sessionId);
    await assert.rejects(
      service.fallbackFromRealtime({ sessionId, error: 'WebRTC failed' }),
      LiveChunkedCaptionsUnavailableError,
    );
    assert.equal(service.isActive(), false);
    const error =
      'Live captions cannot continue with chunked transcription: No batch transcription backend.';
    router.hostEvent({ type: 'live-failed', liveSessionId: sessionId, error });
    assert.deepEqual(
      events.filter((event) => event.type === 'error' || event.type === 'ended').slice(-2),
      [
        { type: 'error', sessionId, error },
        { type: 'ended', sessionId, reason: 'user', error },
      ],
    );
    assert.equal(router.capturedSessionId(), null, 'the host no longer captures it');
    // A duplicate report, a stale one, and the window's own Stop afterwards
    // publish nothing more.
    router.hostEvent({ type: 'live-failed', liveSessionId: sessionId, error });
    router.hostEvent({ type: 'live-failed', liveSessionId: 'live_stale', error });
    await router.stop(sessionId);
    assert.equal(ended(events).length, 1);
  });

  it('forwards host transport errors and translation changes for the current session only', async () => {
    const { router, events, calls } = setup();
    const { sessionId } = await router.start({ translate: true });
    router.hostEvent({ type: 'live-error', liveSessionId: 'stale', error: 'ignored' });
    router.hostEvent({ type: 'live-error', liveSessionId: sessionId, error: 'Chunk failed.' });
    assert.deepEqual(events.at(-1), { type: 'error', sessionId, error: 'Chunk failed.' });
    assert.equal(events.filter((event) => event.type === 'error').length, 1);
    assert.equal(router.setTranslate(sessionId, false)?.translate, false);
    assert.deepEqual(calls.at(-1), { type: 'translate', id: sessionId, translate: false });
  });

  it('stops the session when the recording ended while the provider connected', async () => {
    let available = true;
    const { router, service, calls, events } = setup({ available: () => available });
    const opts = (service as unknown as { opts: { createLiveSttSession: unknown } }).opts;
    const create = opts.createLiveSttSession as (...args: unknown[]) => Promise<LiveSttSession>;
    opts.createLiveSttSession = async (...args: unknown[]) => {
      available = false;
      return create(...args);
    };
    await assert.rejects(router.start({ translate: false }), LiveCaptureUnavailableError);
    assert.equal(service.isActive(), false);
    assert.deepEqual(calls, []);
    assert.equal(ended(events).length, 1);
  });
});
