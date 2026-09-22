import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CONNECT_TIMEOUT_MS,
  LiveReconnectController,
  MAX_RECONNECT_ATTEMPTS,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  RECONNECT_STABLE_MS,
  type LiveReconnectOptions,
} from './liveReconnect';

/**
 * The controller is the whole subject here: no transport, no real timers. A
 * scripted `connect` stands in for the providers' sockets, and every callback
 * the controller makes is appended to `order` so a test can assert sequencing
 * rather than counts alone.
 */
function makeController(
  options: {
    /** behaviors[n] decides whether the n-th reconnect resolves or rejects. */
    behaviors?: Array<'ok' | 'fail'>;
    sleep?: LiveReconnectOptions['sleep'];
    abortSignal?: AbortSignal;
    connectTimeoutMs?: number;
    /** Runs inside connect(), so a test can close the session mid-attempt. */
    onConnect?: () => void;
  } = {},
) {
  const behaviors = options.behaviors ?? [];
  const statuses: string[] = [];
  const errors: Error[] = [];
  const exhausted: Error[] = [];
  const delays: number[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const order: string[] = [];
  const counts = { connects: 0, teardowns: 0, beforeReconnects: 0 };
  let closed = false;

  const controller = new LiveReconnectController({
    label: 'Test Live',
    kind: 'transcription',
    connectTimeoutMs: options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
    abortSignal: options.abortSignal,
    sleep:
      options.sleep ??
      (async (ms, signal) => {
        delays.push(ms);
        signals.push(signal);
        order.push(`sleep:${ms}`);
      }),
    isClosed: () => closed,
    connect: async () => {
      const index = counts.connects++;
      options.onConnect?.();
      const behavior = behaviors[index] ?? 'ok';
      order.push(`connect:${behavior}`);
      if (behavior === 'fail') throw new Error(`connect ${index} failed`);
    },
    teardown: () => {
      counts.teardowns++;
      order.push('teardown');
    },
    onStatus: (status) => {
      statuses.push(status);
      order.push('status');
    },
    onError: (error) => {
      errors.push(error);
      order.push('error');
    },
    onBeforeReconnect: () => {
      counts.beforeReconnects++;
      order.push('beforeReconnect');
    },
    onExhausted: (error) => {
      exhausted.push(error);
      order.push('exhausted');
    },
  });

  return {
    controller,
    statuses,
    errors,
    exhausted,
    delays,
    signals,
    order,
    counts,
    close: () => {
      closed = true;
    },
  };
}

/**
 * Fake the monotonic clock the stability reset reads. Only `now` is replaced,
 * so the rest of the Performance surface keeps working.
 */
function fakeClock(start = 1_000) {
  const realNow = performance.now;
  let now = start;
  performance.now = () => now;
  return {
    advance: (ms: number) => {
      now += ms;
    },
    restore: () => {
      performance.now = realNow;
    },
  };
}

/** Let the parked reconnect loop run up to its next await. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const allFail = (count: number): Array<'ok' | 'fail'> =>
  Array.from({ length: count }, () => 'fail' as const);

describe('LiveReconnectController', () => {
  it('holds the reconnect policy every live provider runs on', () => {
    // Pinned as literals: the rest of this file states its expectations in
    // terms of the constants, so only this test notices a policy change.
    assert.equal(MAX_RECONNECT_ATTEMPTS, 5);
    assert.equal(RECONNECT_BASE_DELAY_MS, 500);
    assert.equal(RECONNECT_MAX_DELAY_MS, 4_000);
    assert.equal(RECONNECT_STABLE_MS, 30_000);
    assert.equal(CONNECT_TIMEOUT_MS, 15_000);
  });

  it('backs off exponentially up to the cap, flushing before it starts', async () => {
    const harness = makeController({ behaviors: allFail(MAX_RECONNECT_ATTEMPTS) });

    await harness.controller.handleDisconnect();

    assert.deepEqual(harness.delays, [500, 1_000, 2_000, 4_000, 4_000]);
    assert.equal(harness.delays[0], RECONNECT_BASE_DELAY_MS);
    assert.equal(harness.delays.at(-1), RECONNECT_MAX_DELAY_MS);
    // The pre-flush hook runs before anything is announced or awaited: a
    // provider holding an in-flight run must not lose it to the reconnect.
    assert.deepEqual(harness.order.slice(0, 3), ['beforeReconnect', 'status', 'sleep:500']);
  });

  it('reports one status line per attempt and stops once a connect succeeds', async () => {
    const harness = makeController({ behaviors: ['fail', 'ok', 'ok'] });

    await harness.controller.handleDisconnect();

    assert.equal(harness.counts.connects, 2);
    assert.deepEqual(harness.statuses, [
      'Reconnecting to Test Live transcription (attempt 1)...',
      'Reconnecting to Test Live transcription (attempt 2)...',
    ]);
    assert.equal(harness.errors.length, 0, 'a recovered drop is not an error');
  });

  it('gives up after MAX_RECONNECT_ATTEMPTS and surfaces the freshest failure', async () => {
    const harness = makeController({ behaviors: allFail(MAX_RECONNECT_ATTEMPTS + 2) });

    await harness.controller.handleDisconnect();

    assert.equal(harness.counts.connects, MAX_RECONNECT_ATTEMPTS);
    assert.equal(harness.errors.length, 1, 'exactly one error after giving up');
    assert.equal(
      harness.errors[0].message,
      `connect ${MAX_RECONNECT_ATTEMPTS - 1} failed`,
      'the last attempt failure is surfaced, not a stale earlier one',
    );
    assert.deepEqual(harness.exhausted, harness.errors, 'the hook saw the surfaced error');
    assert.ok(
      harness.order.indexOf('exhausted') < harness.order.indexOf('error'),
      'the exhaustion hook runs before the error reaches the session callbacks',
    );
  });

  it('spends one budget across reconnects and names the provider when it is gone', async () => {
    const harness = makeController();

    for (let i = 0; i < MAX_RECONNECT_ATTEMPTS; i++) {
      await harness.controller.handleDisconnect();
    }
    assert.equal(harness.counts.connects, MAX_RECONNECT_ATTEMPTS);
    assert.equal(harness.errors.length, 0);

    // Nothing stayed up long enough to refresh the budget, so the next drop
    // gives up without an attempt -- and with no failure text of its own.
    await harness.controller.handleDisconnect();

    assert.equal(harness.counts.connects, MAX_RECONNECT_ATTEMPTS, 'no further attempt');
    assert.deepEqual(
      harness.errors.map((error) => error.message),
      ['Test Live disconnected.'],
    );
  });

  it('refreshes the budget once a connection stayed up past RECONNECT_STABLE_MS', async () => {
    const clock = fakeClock();
    try {
      const harness = makeController();
      for (let i = 0; i < MAX_RECONNECT_ATTEMPTS; i++) {
        await harness.controller.handleDisconnect();
      }

      harness.controller.markConnected();
      clock.advance(RECONNECT_STABLE_MS + 1);
      await harness.controller.handleDisconnect();

      assert.equal(
        harness.counts.connects,
        MAX_RECONNECT_ATTEMPTS + 1,
        'a connection that stayed up is a fresh failure, not a retry storm',
      );
      assert.equal(harness.delays.at(-1), RECONNECT_BASE_DELAY_MS, 'the backoff restarts too');
      assert.equal(harness.errors.length, 0);
    } finally {
      clock.restore();
    }
  });

  it('keeps the budget when the connection did not stay up long enough', async () => {
    const clock = fakeClock();
    try {
      const harness = makeController();
      for (let i = 0; i < MAX_RECONNECT_ATTEMPTS; i++) {
        await harness.controller.handleDisconnect();
      }

      harness.controller.markConnected();
      clock.advance(RECONNECT_STABLE_MS);
      await harness.controller.handleDisconnect();

      assert.equal(
        harness.counts.connects,
        MAX_RECONNECT_ATTEMPTS,
        'a flapping link gets no reset',
      );
      assert.equal(harness.errors.length, 1);
    } finally {
      clock.restore();
    }
  });

  it('coalesces the drops that arrive while the loop is reconnecting', async () => {
    const releases: Array<() => void> = [];
    const harness = makeController({
      sleep: () => new Promise<void>((resolve) => releases.push(resolve)),
    });

    const running = harness.controller.handleDisconnect();
    assert.equal(
      harness.controller.reconnecting,
      true,
      'the loop owns the transport while it runs',
    );
    // Two more drops while the loop is parked in its backoff: coalesced into
    // exactly one further pass, not dropped, and not a second loop.
    void harness.controller.handleDisconnect();
    void harness.controller.handleDisconnect();
    releases.shift()?.();
    await flush();
    releases.shift()?.();
    await running;

    assert.equal(harness.counts.connects, 2, 'one reconnect plus one coalesced pass');
    assert.equal(harness.counts.beforeReconnects, 3, 'every drop flushes, coalesced or not');
    assert.equal(harness.controller.reconnecting, false);
    assert.equal(harness.errors.length, 0);
  });

  it('does nothing at all once the session is closed', async () => {
    const harness = makeController();
    harness.close();

    await harness.controller.handleDisconnect();

    assert.deepEqual(harness.order, [], 'not even the pre-flush hook runs after close()');
  });

  it('abandons the loop when close() cancels the backoff wait', async () => {
    const aborter = new AbortController();
    const harness = makeController({
      abortSignal: aborter.signal,
      sleep: (_ms, signal) =>
        new Promise<void>((resolve) => {
          signal?.addEventListener('abort', () => resolve(), { once: true });
        }),
    });

    const running = harness.controller.handleDisconnect();
    harness.close();
    aborter.abort();
    await running;

    assert.equal(harness.counts.connects, 0, 'the cancelled wait never reaches a connect');
    assert.equal(harness.errors.length, 0, 'a closed session is not a failure');
  });

  it('hands every backoff wait the signal the provider supplied, or none', async () => {
    const aborter = new AbortController();
    const withSignal = makeController({ abortSignal: aborter.signal, behaviors: ['ok'] });
    const withoutSignal = makeController({ behaviors: ['ok'] });

    await withSignal.controller.handleDisconnect();
    await withoutSignal.controller.handleDisconnect();

    assert.deepEqual(withSignal.signals, [aborter.signal]);
    assert.deepEqual(withoutSignal.signals, [undefined]);
  });

  it('tears down a connection that came up after close() landed', async () => {
    let onConnect: (() => void) | undefined;
    const harness = makeController({ onConnect: () => onConnect?.() });
    onConnect = () => harness.close();

    await harness.controller.handleDisconnect();

    assert.equal(harness.counts.connects, 1);
    assert.equal(harness.counts.teardowns, 1, 'the socket the loop opened is not leaked');
    assert.equal(harness.errors.length, 0);
  });

  it('fails a connect attempt that outlives the connect timeout', async () => {
    const harness = makeController({ connectTimeoutMs: 5 });
    const attempt = harness.controller.beginConnect();

    await assert.rejects(
      attempt.establish(new Promise<never>(() => {})),
      /Timed out connecting to Test Live\./,
    );

    assert.equal(attempt.timedOut, true, 'late callbacks can tell the attempt was abandoned');
    assert.equal(attempt.established, false);
  });

  it('clears the connect timeout once the attempt is established', async () => {
    const harness = makeController({ connectTimeoutMs: 5 });
    const attempt = harness.controller.beginConnect();

    await attempt.establish(Promise.resolve('socket'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(attempt.timedOut, false, 'a cleared timer cannot abandon a live connection');
  });

  it('adopts the transport handle before latching the attempt as established', async () => {
    const harness = makeController();
    const attempt = harness.controller.beginConnect();
    const establishedDuringAdopt: boolean[] = [];

    const handle = await attempt.establish(Promise.resolve('socket'), (value) => {
      assert.equal(value, 'socket');
      establishedDuringAdopt.push(attempt.established);
    });

    assert.equal(handle, 'socket');
    assert.deepEqual(
      establishedDuringAdopt,
      [false],
      'the handle is stored before any callback can act on an established attempt',
    );
    assert.equal(attempt.established, true);
  });

  it('lets a transport callback fail an attempt, before or during the race', async () => {
    const harness = makeController();

    const racing = harness.controller.beginConnect();
    const pending = racing.establish(new Promise<never>(() => {}));
    racing.fail(new Error('closed before setup'));
    await assert.rejects(pending, /closed before setup/);
    assert.equal(racing.established, false);
    assert.equal(racing.timedOut, false);

    // A transport that closes synchronously while it is being constructed
    // fails the attempt before anyone awaits it.
    const early = harness.controller.beginConnect();
    early.fail(new Error('closed before open'));
    await assert.rejects(early.establish(new Promise<never>(() => {})), /closed before open/);
  });
});
