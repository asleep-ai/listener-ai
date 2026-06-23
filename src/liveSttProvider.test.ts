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
  params: {
    config: { sessionResumption?: { handle?: string }; contextWindowCompression?: unknown };
  };
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
    // The first reconnect opens, then immediately drops again before
    // handleDisconnect settles. Only an opened connection drives a reconnect, so
    // fire onopen before onclose to exercise the pendingReconnect coalescing.
    if (idx === 1) {
      p.callbacks.onopen();
      p.callbacks.onclose();
    }
    return session;
  }) as never;

  const { callbacks, events } = recordCallbacks();
  await GeminiLiveSession.create(CONFIG, callbacks, { connect, sleep: instantSleep });
  captures[0].callbacks.onopen();
  captures[0].callbacks.onclose();
  await flush();

  assert.equal(calls, 3, 'initial connect + first reconnect + coalesced second reconnect');
  assert.ok(
    !events.some((e) => e.type === 'error'),
    'the coalesced close did not surface an error',
  );
});

test('GeminiLiveSession fails create() on a pre-open close without a background reconnect', async () => {
  const captures: ConnectCapture[] = [];
  let calls = 0;
  // The initial connection closes before it ever opens (the pre-open SDK failure
  // mode). create() must reject so LiveSessionService can fall back, and must NOT
  // start a background reconnect on the instance it is about to discard.
  const connect = (async (params: unknown) => {
    const idx = calls++;
    const session = new FakeSession();
    const p = params as ConnectCapture['params'] & { callbacks: ConnectCapture['callbacks'] };
    captures.push({ params: p, callbacks: p.callbacks, session });
    if (idx === 0) {
      // Pre-open close: the SDK fires onclose but never resolves the connect
      // promise (no onopen), so model that by never resolving here.
      p.callbacks.onclose();
      return new Promise<FakeSession>(() => {});
    }
    return session;
  }) as never;

  const { callbacks } = recordCallbacks();
  await assert.rejects(
    GeminiLiveSession.create(CONFIG, callbacks, { connect, sleep: instantSleep }),
    /closed before opening/,
  );
  await flush();

  assert.equal(calls, 1, 'a pre-open initial failure does not spawn a background reconnect');
});

test('GeminiLiveSession ignores a late open/close from a timed-out reconnect attempt', async () => {
  const captures: ConnectCapture[] = [];
  let calls = 0;
  const connect = (async (params: unknown) => {
    const idx = calls++;
    const session = new FakeSession();
    const p = params as ConnectCapture['params'] & { callbacks: ConnectCapture['callbacks'] };
    captures.push({ params: p, callbacks: p.callbacks, session });
    // Reconnect attempt #1 (idx 1) hangs so it hits the connect timeout; the
    // initial connect (idx 0) and the second reconnect attempt (idx 2) resolve.
    if (idx === 1) return new Promise<FakeSession>(() => {});
    return session;
  }) as never;

  const { callbacks, events } = recordCallbacks();
  await GeminiLiveSession.create(CONFIG, callbacks, {
    connect,
    sleep: instantSleep,
    connectTimeoutMs: 5,
  });
  captures[0].callbacks.onopen();
  captures[0].callbacks.onclose();
  // Wait for the hung attempt #1 to time out (~5ms) and attempt #2 to take over.
  for (let i = 0; i < 100 && calls < 3; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls, 3, 'the hung attempt timed out and a retry reconnected');

  // Attempt #1 (captures[1]) opens only now -- after it timed out and our cleanup
  // would close it. Both the late open and close must be ignored so they don't
  // start a reconnect over the healthy attempt #2.
  captures[1].callbacks.onopen();
  captures[1].callbacks.onclose();
  await flush();

  assert.equal(calls, 3, 'a late open/close from the timed-out attempt starts no new reconnect');
  assert.ok(!events.some((e) => e.type === 'error'), 'no error surfaced from the stale attempt');
});

test('GeminiLiveSession still emits a final transcript that arrives during the close drain', async () => {
  const { connect, captures } = scriptConnect(['ok']);
  const { callbacks, events } = recordCallbacks();
  const session = await GeminiLiveSession.create(CONFIG, callbacks, {
    connect,
    sleep: instantSleep,
  });
  captures[0].callbacks.onopen();

  // close() sets this.closed before the audioStreamEnd drain; a final transcript
  // delivered during that window must still be processed and emitted.
  const closing = session.close();
  captures[0].callbacks.onmessage({
    serverContent: { inputTranscription: { text: 'final words', finished: true } },
  });
  await closing;

  const finals = events.filter((e) => e.type === 'final');
  assert.ok(
    finals.some((e) => JSON.stringify(e.value).includes('final words')),
    'the final transcript from the close drain is captured, not dropped',
  );
});
