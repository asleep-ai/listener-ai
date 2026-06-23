import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GeminiLiveSession,
  type LiveSttCallbacks,
  type LiveSttPcmFrame,
  type LiveSttProviderConfig,
} from './liveSttProvider';

// A scripted stand-in for a @google/genai live Session. The real transport is
// injected via GeminiLiveSession.create(..., { connect }), so these tests drive
// the reconnect state machine offline -- no network, no API key, deterministic.
class FakeSession {
  readonly realtime: unknown[] = [];
  closed = false;
  sendRealtimeInput(input: unknown): void {
    this.realtime.push(input);
  }
  close(): void {
    this.closed = true;
  }
}

interface ConnectCapture {
  params: { config: { sessionResumption?: { handle?: string }; contextWindowCompression?: unknown } };
  callbacks: {
    onopen: () => void;
    onmessage: (message: unknown) => void;
    onerror: (event: { message?: string }) => void;
    onclose: () => void;
  };
  session: FakeSession;
}

// behaviors[n] decides whether the n-th connect call resolves ('ok') or rejects
// ('fail'). Successful calls are recorded in `captures` so a test can fire that
// connection's callbacks; failed calls throw before being recorded.
function scriptConnect(behaviors: Array<'ok' | 'fail'>) {
  const captures: ConnectCapture[] = [];
  let calls = 0;
  const connect = async (params: unknown): Promise<FakeSession> => {
    const idx = calls++;
    if ((behaviors[idx] ?? 'ok') === 'fail') throw new Error(`connect ${idx} failed`);
    const session = new FakeSession();
    const p = params as ConnectCapture['params'] & { callbacks: ConnectCapture['callbacks'] };
    captures.push({ params: p, callbacks: p.callbacks, session });
    return session;
  };
  return { connect: connect as never, captures, callCount: () => calls };
}

function recordCallbacks() {
  const events: Array<{ type: string; value?: unknown }> = [];
  const callbacks: LiveSttCallbacks = {
    onStatus: (status) => events.push({ type: 'status', value: status }),
    onInterim: (event) => events.push({ type: 'interim', value: event }),
    onTranslationInterim: (event) => events.push({ type: 'translationInterim', value: event }),
    onFinal: (event) => events.push({ type: 'final', value: event }),
    onError: (error) => events.push({ type: 'error', value: error.message }),
  };
  return { callbacks, events };
}

const CONFIG: LiveSttProviderConfig = {
  provider: 'gemini',
  geminiApiKey: 'test-key',
  translate: false,
};

const instantSleep = async (): Promise<void> => {};

function pcmFrame(sequence: number): LiveSttPcmFrame {
  return {
    audioData: new Uint8Array(320), // 160 samples * 2 bytes == 10ms @ 16kHz
    sampleRate: 16_000,
    channelCount: 1,
    offsetMs: sequence * 10,
    durationMs: 10,
    sequence,
  };
}

// Drain the microtask/macrotask queue so the void-returning reconnect chain
// (onclose -> handleDisconnect -> sleep -> connect) settles before assertions.
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

test('GeminiLiveSession enables session resumption and context compression on connect', async () => {
  const { connect, captures } = scriptConnect(['ok']);
  const { callbacks } = recordCallbacks();
  await GeminiLiveSession.create(CONFIG, callbacks, { connect, sleep: instantSleep });

  assert.equal(captures.length, 1);
  assert.ok(captures[0].params.config.sessionResumption, 'sessionResumption is configured');
  assert.ok(
    (captures[0].params.config.contextWindowCompression as { slidingWindow?: unknown })
      ?.slidingWindow,
    'sliding-window context compression is configured',
  );
});

test('GeminiLiveSession reconnects with the stored resumption handle after an unexpected close', async () => {
  const { connect, captures } = scriptConnect(['ok', 'ok']);
  const { callbacks, events } = recordCallbacks();
  await GeminiLiveSession.create(CONFIG, callbacks, { connect, sleep: instantSleep });

  captures[0].callbacks.onopen();
  captures[0].callbacks.onmessage({
    sessionResumptionUpdate: { newHandle: 'handle-1', resumable: true },
  });
  captures[0].callbacks.onclose();
  await flush();

  assert.equal(captures.length, 2, 'a second connection was opened');
  assert.equal(
    captures[1].params.config.sessionResumption?.handle,
    'handle-1',
    'the reconnect resumed with the saved handle',
  );
  // The unexpected close is recovered, not surfaced as a fatal error.
  assert.ok(!events.some((e) => e.type === 'error'), 'no error surfaced on transient close');
});

test('GeminiLiveSession routes PCM to the reconnected session', async () => {
  const { connect, captures } = scriptConnect(['ok', 'ok']);
  const { callbacks } = recordCallbacks();
  const session = await GeminiLiveSession.create(CONFIG, callbacks, {
    connect,
    sleep: instantSleep,
  });

  captures[0].callbacks.onopen();
  session.sendPcm(pcmFrame(1));
  assert.equal(captures[0].session.realtime.length, 1, 'frame reached the first connection');

  captures[0].callbacks.onclose();
  await flush();
  assert.equal(captures.length, 2);

  captures[1].callbacks.onopen();
  session.sendPcm(pcmFrame(2));
  assert.equal(captures[1].session.realtime.length, 1, 'frame reached the reconnected connection');
});

test('GeminiLiveSession surfaces an error only after exhausting reconnect attempts', async () => {
  // 1 initial connect + 5 failing reconnects (MAX_RECONNECT_ATTEMPTS).
  const { connect, captures, callCount } = scriptConnect([
    'ok',
    'fail',
    'fail',
    'fail',
    'fail',
    'fail',
  ]);
  const { callbacks, events } = recordCallbacks();
  await GeminiLiveSession.create(CONFIG, callbacks, { connect, sleep: instantSleep });

  captures[0].callbacks.onopen();
  // A transient error on the original connection. It must NOT be the message
  // surfaced after the later give-up -- each failed reconnect refreshes it.
  captures[0].callbacks.onerror({ message: 'stale early blip' });
  captures[0].callbacks.onclose();
  await flush();

  assert.equal(callCount(), 6, 'initial connect plus five reconnect attempts');
  const errors = events.filter((e) => e.type === 'error');
  assert.equal(errors.length, 1, 'exactly one error after giving up');
  assert.equal(
    errors[0].value,
    'connect 5 failed',
    'the freshest reconnect failure is surfaced, not the stale early onerror',
  );
});

test('GeminiLiveSession does not reconnect after the user closes the session', async () => {
  const { connect, captures, callCount } = scriptConnect(['ok']);
  const { callbacks, events } = recordCallbacks();
  const session = await GeminiLiveSession.create(CONFIG, callbacks, {
    connect,
    sleep: instantSleep,
  });

  captures[0].callbacks.onopen();
  await session.close();
  // A real Session.close() makes the socket emit a close event; it must not
  // trigger the reconnect loop now that the user has ended the session.
  captures[0].callbacks.onclose();
  await flush();

  assert.equal(callCount(), 1, 'no reconnect after an intentional close');
  assert.ok(!events.some((e) => e.type === 'error'), 'no error surfaced on user close');
  assert.equal(captures[0].session.closed, true, 'the underlying session was closed');
});

test('GeminiLiveSession coalesces a close that arrives during an in-flight reconnect', async () => {
  const captures: ConnectCapture[] = [];
  let calls = 0;
  // On the first reconnect (2nd connect overall), the freshly opened socket
  // closes again before handleDisconnect settles. That re-entrant close must be
  // coalesced (pendingReconnect) into exactly one more reconnect -- not dropped,
  // and not spawning a second concurrent loop.
  const connect = (async (params: unknown) => {
    const idx = calls++;
    const session = new FakeSession();
    const p = params as ConnectCapture['params'] & { callbacks: ConnectCapture['callbacks'] };
    captures.push({ params: p, callbacks: p.callbacks, session });
    if (idx === 1) p.callbacks.onclose();
    return session;
  }) as never;

  const { callbacks, events } = recordCallbacks();
  await GeminiLiveSession.create(CONFIG, callbacks, { connect, sleep: instantSleep });
  captures[0].callbacks.onopen();
  captures[0].callbacks.onclose();
  await flush();

  assert.equal(calls, 3, 'initial connect + first reconnect + coalesced second reconnect');
  assert.ok(!events.some((e) => e.type === 'error'), 'the coalesced close did not surface an error');
});
