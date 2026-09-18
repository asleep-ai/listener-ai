import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LiveSttCallbacks, LiveSttPcmFrame, LiveSttProviderConfig } from './liveSttProvider';
import {
  filterSonioxTokens,
  SonioxLiveSession,
  SONIOX_REALTIME_MODEL,
  type SonioxServerMessage,
  type SonioxSocket,
  type SonioxToken,
} from './sonioxLiveProvider';

// A scripted stand-in for the `ws` socket. The real transport is injected via
// SonioxLiveSession.create(..., { createWebSocket }), so these tests drive the
// token assembly and reconnect state machine offline -- no network, no API key.
class FakeSocket implements SonioxSocket {
  readonly sent: Array<string | Uint8Array | Buffer> = [];
  closed = false;
  closeCode: number | undefined;
  private readonly listeners = new Map<string, Array<(...args: never[]) => void>>();

  send(data: string | Uint8Array | Buffer): void {
    if (this.closed) throw new Error('socket is closed');
    this.sent.push(data);
  }

  close(code?: number): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    this.emit('close', code ?? 1000);
  }

  on(event: string, listener: (...args: never[]) => void): this {
    const existing = this.listeners.get(event);
    if (existing) existing.push(listener);
    else this.listeners.set(event, [listener]);
    return this;
  }

  /** Test driver: fire the transport `open` event. */
  open(): void {
    this.emit('open');
  }

  /** Test driver: deliver one JSON server message. */
  deliver(message: SonioxServerMessage): void {
    this.emit('message', Buffer.from(JSON.stringify(message)));
  }

  /** Test driver: an abrupt drop (code 1006, no error frame). */
  drop(code = 1006): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    this.emit('close', code);
  }

  jsonFrames(): Record<string, unknown>[] {
    return this.sent
      .filter((data): data is string => typeof data === 'string' && data.length > 0)
      .map((data) => JSON.parse(data) as Record<string, unknown>);
  }

  configFrame(): Record<string, unknown> {
    return this.jsonFrames()[0] ?? {};
  }

  binaryFrames(): Array<Uint8Array | Buffer> {
    return this.sent.filter((data): data is Uint8Array | Buffer => typeof data !== 'string');
  }

  emptyFrameCount(): number {
    return this.sent.filter((data) => data === '').length;
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...a: unknown[]) => void)(...args);
    }
  }
}

type SocketScript =
  | 'ok'
  | 'fail'
  /** Opens, then synchronously delivers a first server message. */
  | { open: SonioxServerMessage };

function scriptSockets(behaviors: SocketScript[] = []) {
  const sockets: FakeSocket[] = [];
  let calls = 0;
  const createWebSocket = (): SonioxSocket => {
    const behavior = behaviors[calls++] ?? 'ok';
    const socket = new FakeSocket();
    sockets.push(socket);
    queueMicrotask(() => {
      if (behavior === 'fail') {
        socket.drop(1006);
        return;
      }
      socket.open();
      if (typeof behavior === 'object') socket.deliver(behavior.open);
    });
    return socket;
  };
  return { createWebSocket, sockets, callCount: () => calls };
}

function recordCallbacks() {
  const events: Array<{ type: string; value?: unknown }> = [];
  const callbacks: LiveSttCallbacks = {
    onStatus: (status) => events.push({ type: 'status', value: status }),
    onInterim: (event) => events.push({ type: 'interim', value: event }),
    onTranslationInterim: (event) => events.push({ type: 'translationInterim', value: event }),
    onFinal: (event) => events.push({ type: 'final', value: event }),
    onError: (error) => events.push({ type: 'error', value: error }),
  };
  const of = (type: string) => events.filter((event) => event.type === type);
  return { callbacks, events, of };
}

const instantSleep = async (): Promise<void> => {};

/** Instant for the connect grace (0ms), manually released for everything else. */
function manualSleep() {
  const pending: Array<() => void> = [];
  const sleep = async (ms: number): Promise<void> => {
    if (ms === 0) return;
    await new Promise<void>((resolve) => pending.push(resolve));
  };
  return { sleep, fire: (index: number) => pending[index]?.(), pendingCount: () => pending.length };
}

const CONFIG: LiveSttProviderConfig = {
  provider: 'soniox',
  sonioxApiKey: 'test-key',
  language: 'ko',
  translate: false,
};

// Drain the microtask/macrotask queues so the void-returning chains (open ->
// config frame -> settle, close -> reconnect -> connect) finish before asserts.
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    for (let j = 0; j < 20; j++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function token(text: string, extra: Partial<SonioxToken> = {}): SonioxToken {
  return { text, language: 'ko', is_final: true, ...extra };
}

function pcmFrame(sequence: number, channelCount = 1, sampleRate = 16_000): LiveSttPcmFrame {
  const samples = (sampleRate / 100) * channelCount; // 10ms of audio
  return {
    audioData: new Uint8Array(samples * 2),
    sampleRate,
    channelCount,
    offsetMs: sequence * 10,
    durationMs: 10,
    sequence,
  };
}

describe('filterSonioxTokens', () => {
  it('drops control tokens and tokens without a language tag', () => {
    const { speech, endpoint } = filterSonioxTokens([
      token('안녕', { start_ms: 0, end_ms: 100 }),
      { text: '<end>', is_final: true },
      { text: '???', is_final: true },
      { text: 'noise', is_final: true, language: '  ' },
    ]);

    assert.equal(endpoint, true);
    assert.deepEqual(
      speech.map((t) => t.text),
      ['안녕'],
    );
  });

  it('treats <fin> as an endpoint without contributing text', () => {
    const { speech, endpoint } = filterSonioxTokens([{ text: '<fin>', is_final: true }]);
    assert.equal(endpoint, true);
    assert.equal(speech.length, 0);
  });

  it('reports no endpoint for an unknown control token', () => {
    const { speech, endpoint } = filterSonioxTokens([{ text: '<unknown>', is_final: true }]);
    assert.equal(endpoint, false);
    assert.equal(speech.length, 0);
  });
});

describe('SonioxLiveSession', () => {
  it('opens with a raw-PCM config frame carrying language hints and glossary terms', async () => {
    const { createWebSocket, sockets } = scriptSockets();
    const { callbacks } = recordCallbacks();

    const session = await SonioxLiveSession.create(
      { ...CONFIG, knownWords: ['Listener.AI', '  ', 'Asleep'] },
      callbacks,
      { createWebSocket, sleep: instantSleep },
    );

    const frame = sockets[0].configFrame();
    assert.equal(typeof frame.api_key, 'string');
    assert.ok((frame.api_key as string).length > 0);
    assert.equal(frame.model, SONIOX_REALTIME_MODEL);
    assert.equal(frame.audio_format, 'pcm_s16le');
    assert.equal(frame.sample_rate, 16_000);
    assert.equal(frame.num_channels, 1);
    assert.deepEqual(frame.language_hints, ['ko', 'en']);
    assert.equal(frame.enable_language_identification, true);
    assert.equal(frame.enable_endpoint_detection, true);
    assert.deepEqual(frame.context, { terms: ['Listener.AI', 'Asleep'] });
    assert.equal('enable_speaker_diarization' in frame, false);
    assert.equal('translation' in frame, false);
    assert.equal(session.provider, 'soniox');
    assert.equal(session.kind, 'transcription');

    await session.close();
  });

  it('requests one-way translation and reports the translation kind when translate is on', async () => {
    const { createWebSocket, sockets } = scriptSockets();
    const { callbacks } = recordCallbacks();

    const session = await SonioxLiveSession.create(
      { ...CONFIG, translate: true, translationLanguage: 'en' },
      callbacks,
      { createWebSocket, sleep: instantSleep },
    );

    assert.deepEqual(sockets[0].configFrame().translation, {
      type: 'one_way',
      target_language: 'en',
    });
    assert.equal(session.kind, 'translation');

    await session.close();
  });

  it('emits interim text from finals plus non-finals and finalizes on <end>', async () => {
    const { createWebSocket, sockets } = scriptSockets();
    const { callbacks, of } = recordCallbacks();

    const session = await SonioxLiveSession.create(CONFIG, callbacks, {
      createWebSocket,
      sleep: instantSleep,
    });

    sockets[0].deliver({
      tokens: [
        token('안녕', { start_ms: 100, end_ms: 400 }),
        token(' 하세요', { is_final: false }),
      ],
    });
    assert.deepEqual(of('interim').at(-1)?.value, { text: '안녕 하세요', offsetMs: 100 });
    assert.equal(of('final').length, 0);

    sockets[0].deliver({
      tokens: [token(' 하세요', { start_ms: 400, end_ms: 900 }), { text: '<end>', is_final: true }],
    });

    assert.equal(of('final').length, 1);
    assert.deepEqual(of('final')[0].value, {
      text: '안녕 하세요',
      offsetMs: 100,
      durationMs: 800,
      translation: undefined,
    });

    await session.close();
  });

  it('never leaks control tokens or language-less tokens into the emitted text', async () => {
    const { createWebSocket, sockets } = scriptSockets();
    const { callbacks, of } = recordCallbacks();

    const session = await SonioxLiveSession.create(CONFIG, callbacks, {
      createWebSocket,
      sleep: instantSleep,
    });

    sockets[0].deliver({
      tokens: [
        { text: '<fin>', is_final: true },
        { text: '???', is_final: true },
        token('Hello', { language: 'en', start_ms: 0, end_ms: 100 }),
        { text: '<end>', is_final: true },
      ],
    });

    const finalEvent = of('final')[0]?.value as { text: string };
    assert.equal(finalEvent.text, 'Hello');
    for (const event of [...of('interim'), ...of('final')]) {
      const { text } = event.value as { text: string };
      assert.equal(/<end>|<fin>|\?\?\?/.test(text), false, `control token leaked: ${text}`);
    }

    await session.close();
  });

  it('attaches translation finals that arrive after the endpoint', async () => {
    const { createWebSocket, sockets } = scriptSockets();
    const { callbacks, of } = recordCallbacks();

    const session = await SonioxLiveSession.create({ ...CONFIG, translate: true }, callbacks, {
      createWebSocket,
      sleep: instantSleep,
    });

    sockets[0].deliver({
      tokens: [
        token('Good morning', {
          language: 'en',
          start_ms: 0,
          end_ms: 900,
          translation_status: 'original',
        }),
        { text: '<end>', is_final: true },
      ],
    });
    // The endpoint alone must not finalize yet -- the translated tokens for the
    // run land in a later message.
    assert.equal(of('final').length, 0);

    sockets[0].deliver({
      tokens: [token('좋은 아침입니다', { translation_status: 'translation' })],
    });
    await flush();

    assert.equal(of('final').length, 1);
    assert.deepEqual(of('final')[0].value, {
      text: 'Good morning',
      offsetMs: 0,
      durationMs: 900,
      translation: '좋은 아침입니다',
    });

    await session.close();
  });

  it('settles a deferred translation final as soon as new source speech arrives', async () => {
    const { createWebSocket, sockets } = scriptSockets();
    const { callbacks, of } = recordCallbacks();
    // A sleep that never settles isolates the "new source speech" flush path
    // from the grace timer.
    await SonioxLiveSession.create({ ...CONFIG, translate: true }, callbacks, {
      createWebSocket,
      sleep: async (ms: number) => {
        if (ms > 0) await new Promise(() => {});
      },
    });

    sockets[0].deliver({
      tokens: [
        token('첫 문장', { start_ms: 0, end_ms: 500, translation_status: 'original' }),
        { text: '<end>', is_final: true },
      ],
    });
    assert.equal(of('final').length, 0);

    sockets[0].deliver({ tokens: [token('두 번째', { start_ms: 600, is_final: false })] });

    assert.equal(of('final').length, 1);
    assert.equal((of('final')[0].value as { text: string }).text, '첫 문장');
    assert.deepEqual(of('interim').at(-1)?.value, { text: '두 번째', offsetMs: 600 });
  });

  it('keeps a run translation that arrives alongside the next run source tokens', async () => {
    const { createWebSocket, sockets } = scriptSockets();
    const { callbacks, of } = recordCallbacks();

    const session = await SonioxLiveSession.create({ ...CONFIG, translate: true }, callbacks, {
      createWebSocket,
      sleep: instantSleep,
    });

    sockets[0].deliver({
      tokens: [
        token('첫 문장', { start_ms: 0, end_ms: 500, translation_status: 'original' }),
        { text: '<end>', is_final: true },
      ],
    });

    // The common interleaving: run A's translation and run B's first source
    // tokens share one message. A must keep its own translation.
    sockets[0].deliver({
      tokens: [
        token('First sentence', { language: 'en', translation_status: 'translation' }),
        token('두 번째', { start_ms: 600, end_ms: 900, translation_status: 'original' }),
        { text: '<end>', is_final: true },
      ],
    });
    await flush();

    assert.equal(of('final').length, 2);
    assert.deepEqual(of('final')[0].value, {
      text: '첫 문장',
      offsetMs: 0,
      durationMs: 500,
      translation: 'First sentence',
    });
    assert.equal((of('final')[1].value as { text: string }).text, '두 번째');
    assert.equal((of('final')[1].value as { translation?: string }).translation, undefined);

    await session.close();
  });

  it('ignores a grace timer left behind by a run that was already flushed', async () => {
    const { createWebSocket, sockets } = scriptSockets();
    const { callbacks, of } = recordCallbacks();
    const { sleep, fire } = manualSleep();

    await SonioxLiveSession.create({ ...CONFIG, translate: true }, callbacks, {
      createWebSocket,
      sleep,
    });

    // Run A: endpoint arms grace timer #0.
    sockets[0].deliver({
      tokens: [
        token('A 문장', { start_ms: 0, end_ms: 400, translation_status: 'original' }),
        { text: '<end>', is_final: true },
      ],
    });
    // Run B's first source tokens settle run A early; timer #0 is now stale.
    sockets[0].deliver({
      tokens: [
        token('B 문장', { start_ms: 500, end_ms: 900, translation_status: 'original' }),
        { text: '<end>', is_final: true },
      ],
    });
    await flush();
    assert.equal(of('final').length, 1, 'only run A has been emitted');

    // The stale timer must not settle run B before its translation lands.
    fire(0);
    await flush();
    assert.equal(of('final').length, 1, 'run B is still waiting for its translation');

    sockets[0].deliver({
      tokens: [token('B sentence', { language: 'en', translation_status: 'translation' })],
    });
    fire(1);
    await flush();

    assert.equal(of('final').length, 2);
    assert.deepEqual(of('final')[1].value, {
      text: 'B 문장',
      offsetMs: 500,
      durationMs: 400,
      translation: 'B sentence',
    });
  });

  it('emits a translation interim while translation non-finals stream in', async () => {
    const { createWebSocket, sockets } = scriptSockets();
    const { callbacks, of } = recordCallbacks();

    const session = await SonioxLiveSession.create({ ...CONFIG, translate: true }, callbacks, {
      createWebSocket,
      sleep: instantSleep,
    });

    sockets[0].deliver({
      tokens: [
        token('Hello', { language: 'en', is_final: false, start_ms: 0 }),
        token('안녕', { is_final: false, translation_status: 'translation' }),
      ],
    });

    assert.deepEqual(of('translationInterim').at(-1)?.value, { text: '안녕', offsetMs: 0 });

    await session.close();
  });

  it('sends PCM as binary frames and drops non-mono frames', async () => {
    const { createWebSocket, sockets } = scriptSockets();
    const { callbacks } = recordCallbacks();

    const session = await SonioxLiveSession.create(CONFIG, callbacks, {
      createWebSocket,
      sleep: instantSleep,
    });

    session.sendPcm(pcmFrame(0));
    session.sendPcm(pcmFrame(1, 2));

    assert.equal(sockets[0].binaryFrames().length, 1);
    assert.equal(sockets[0].binaryFrames()[0].byteLength, 320);

    await session.close();
  });

  it('downsamples a 48 kHz frame to 16 kHz before sending', async () => {
    const { createWebSocket, sockets } = scriptSockets();
    const { callbacks } = recordCallbacks();

    const session = await SonioxLiveSession.create(CONFIG, callbacks, {
      createWebSocket,
      sleep: instantSleep,
    });

    // 10ms @ 48kHz mono = 480 samples (960 bytes) -> 160 samples (320 bytes).
    session.sendPcm(pcmFrame(0, 1, 48_000));

    assert.equal(sockets[0].binaryFrames().length, 1);
    assert.equal(sockets[0].binaryFrames()[0].byteLength, 320);

    await session.close();
  });

  it('sends a keepalive control frame when no audio is flowing', async () => {
    const { createWebSocket, sockets } = scriptSockets();
    const { callbacks } = recordCallbacks();

    const session = await SonioxLiveSession.create(CONFIG, callbacks, {
      createWebSocket,
      sleep: instantSleep,
      keepaliveIntervalMs: 10,
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    const keepalives = sockets[0].jsonFrames().filter((frame) => frame.type === 'keepalive');
    assert.ok(keepalives.length >= 1, 'at least one keepalive was sent');

    await session.close();
    const afterClose = sockets[0].jsonFrames().filter((frame) => frame.type === 'keepalive').length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(
      sockets[0].jsonFrames().filter((frame) => frame.type === 'keepalive').length,
      afterClose,
      'the keepalive timer stops on close',
    );
  });

  it('flushes a final when the server reports finished', async () => {
    const { createWebSocket, sockets } = scriptSockets();
    const { callbacks, of } = recordCallbacks();

    const session = await SonioxLiveSession.create(CONFIG, callbacks, {
      createWebSocket,
      sleep: instantSleep,
    });

    sockets[0].deliver({ tokens: [token('마무리', { start_ms: 10, end_ms: 510 })] });
    assert.equal(of('final').length, 0);
    sockets[0].deliver({ tokens: [], finished: true });

    assert.equal(of('final').length, 1);
    assert.equal((of('final')[0].value as { text: string }).text, '마무리');

    await session.close();
  });

  it('closes by sending the empty end-of-stream frame and flushing the buffered final', async () => {
    const { createWebSocket, sockets } = scriptSockets();
    const { callbacks, of } = recordCallbacks();

    const session = await SonioxLiveSession.create(CONFIG, callbacks, {
      createWebSocket,
      sleep: instantSleep,
    });

    sockets[0].deliver({ tokens: [token('마지막 문장', { start_ms: 0, end_ms: 400 })] });
    await session.close();

    assert.equal(sockets[0].emptyFrameCount(), 1);
    assert.equal(of('final').length, 1);
    assert.equal((of('final')[0].value as { text: string }).text, '마지막 문장');
    assert.equal(sockets[0].closed, true);
  });

  it('reconnects with a fresh config frame after an established drop and keeps the pending final', async () => {
    const { createWebSocket, sockets } = scriptSockets();
    const { callbacks, of } = recordCallbacks();

    const session = await SonioxLiveSession.create(CONFIG, callbacks, {
      createWebSocket,
      sleep: instantSleep,
    });

    sockets[0].deliver({ tokens: [token('드랍 직전', { start_ms: 0, end_ms: 300 })] });
    sockets[0].drop(1006);
    await flush();

    assert.equal(sockets.length, 2, 'a second connection was opened');
    assert.deepEqual(sockets[1].configFrame(), sockets[0].configFrame());
    assert.equal(of('final').length, 1, 'the in-flight run was flushed before reconnecting');
    assert.equal((of('final')[0].value as { text: string }).text, '드랍 직전');
    assert.ok(
      of('status').some((event) => /Reconnecting/.test(String(event.value))),
      'a reconnect status was reported',
    );
    assert.equal(of('error').length, 0);

    // The new stream keeps working.
    sockets[1].deliver({
      tokens: [
        token('재연결 후', { start_ms: 400, end_ms: 800 }),
        { text: '<end>', is_final: true },
      ],
    });
    assert.equal(of('final').length, 2);

    await session.close();
  });

  it('surfaces a 401 error frame once and never reconnects', async () => {
    const { createWebSocket, sockets } = scriptSockets();
    const { callbacks, of } = recordCallbacks();

    const session = await SonioxLiveSession.create(CONFIG, callbacks, {
      createWebSocket,
      sleep: instantSleep,
    });

    sockets[0].deliver({ tokens: [token('버려지면 안 되는 문장', { start_ms: 0, end_ms: 300 })] });
    sockets[0].deliver({
      tokens: [],
      error_code: 401,
      error_type: 'unauthenticated',
      error_message: 'Invalid API key.',
      request_id: 'req-1',
    });
    await flush();

    assert.equal(sockets.length, 1, 'no reconnect after a fatal error frame');
    assert.equal(of('final').length, 1, 'buffered text is flushed before the session shuts down');
    assert.equal(of('error').length, 1);
    const error = of('error')[0].value as Error & {
      status?: number;
      errorType?: string;
      requestId?: string;
    };
    assert.equal(error.name, 'SonioxRealtimeError');
    assert.equal(error.status, 401);
    assert.equal(error.errorType, 'unauthenticated');
    assert.equal(error.requestId, 'req-1');

    await session.close();
  });

  it('reconnects after a retryable error frame', async () => {
    const { createWebSocket, sockets } = scriptSockets();
    const { callbacks, of } = recordCallbacks();

    const session = await SonioxLiveSession.create(CONFIG, callbacks, {
      createWebSocket,
      sleep: instantSleep,
    });

    sockets[0].deliver({
      tokens: [],
      error_code: 503,
      error_type: 'service_unavailable',
      error_message: 'Try again.',
    });
    await flush();

    assert.equal(sockets.length, 2);
    assert.equal(of('error').length, 0);

    await session.close();
  });

  it('gives up after five failed reconnect attempts', async () => {
    const { createWebSocket, sockets } = scriptSockets([
      'ok',
      'fail',
      'fail',
      'fail',
      'fail',
      'fail',
      'fail',
    ]);
    const { callbacks, of } = recordCallbacks();

    const session = await SonioxLiveSession.create(CONFIG, callbacks, {
      createWebSocket,
      sleep: instantSleep,
    });

    sockets[0].drop(1006);
    await flush();

    assert.equal(sockets.length, 6, 'one live connection plus five reconnect attempts');
    assert.equal(of('error').length, 1);

    await session.close();
  });

  it('does not reconnect after close()', async () => {
    const { createWebSocket, sockets } = scriptSockets();
    const { callbacks, of } = recordCallbacks();

    const session = await SonioxLiveSession.create(CONFIG, callbacks, {
      createWebSocket,
      sleep: instantSleep,
    });

    await session.close();
    sockets[0].drop(1006);
    await flush();

    assert.equal(sockets.length, 1);
    assert.equal(of('error').length, 0);
  });

  it('rejects create when the first connection never comes up', async () => {
    const { createWebSocket, sockets } = scriptSockets(['fail']);
    const { callbacks, of } = recordCallbacks();

    await assert.rejects(
      () => SonioxLiveSession.create(CONFIG, callbacks, { createWebSocket, sleep: instantSleep }),
      /Soniox realtime closed before the connection was established/,
    );
    await flush();

    assert.equal(sockets.length, 1, 'a failed first connect does not start the reconnect loop');
    assert.equal(of('error').length, 0);
  });

  it('rejects create when the first server message is an error frame', async () => {
    const { createWebSocket, sockets } = scriptSockets([
      {
        open: {
          tokens: [],
          error_code: 402,
          error_type: 'balance_exhausted',
          error_message: 'Out of balance.',
        },
      },
    ]);
    const { callbacks, of } = recordCallbacks();

    await assert.rejects(
      () => SonioxLiveSession.create(CONFIG, callbacks, { createWebSocket, sleep: instantSleep }),
      /balance_exhausted/,
    );
    await flush();

    assert.equal(sockets.length, 1);
    assert.equal(of('error').length, 0, 'the rejection replaces a session-level error callback');
  });
});
