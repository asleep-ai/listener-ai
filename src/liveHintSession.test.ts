// Live hints wired through LiveSessionService: per-session opt-in, finals
// from a streaming provider, begin-stop before the final flush, no-final
// translation streams, sourceMissing and the text-route fence. No network:
// the stream and the text service are fakes.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { GeminiService } from './geminiService';
import type { LiveHintCandidate, LiveHintGenerateRequest } from './liveHintEngine';
import { LiveSessionService, type LiveSessionEvent } from './liveSessionService';
import type { LiveSttCallbacks, LiveSttSession } from './liveSttProvider';
import { makeTempDir, rmDir } from './test-helpers';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

class FakeClock {
  t = 1_700_000_000_000;
  private timers: Array<{ at: number; fn: () => void; id: number }> = [];
  private nextId = 1;
  now = (): number => this.t;
  setTimer = (fn: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  };
  clearTimer = (handle: unknown): void => {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  };
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = Math.max(this.t, next.at);
      next.fn();
      await flush();
    }
    this.t = end;
    await flush();
  }
}

let workDir: string;
beforeEach(() => {
  workDir = makeTempDir('live-hints-session');
});
afterEach(() => {
  rmDir(workDir);
});

interface HintCall {
  req: LiveHintGenerateRequest;
  signal?: AbortSignal;
  resolve(c: LiveHintCandidate[]): void;
}

function setup(
  opts: {
    kind?: 'transcription' | 'translation';
    provider?: 'gemini' | 'openai';
    controlled?: boolean;
  } = {},
) {
  const clock = new FakeClock();
  const events: LiveSessionEvent[] = [];
  const hintCalls: HintCall[] = [];
  const translateCalls: string[] = [];
  let callbacks: LiveSttCallbacks | undefined;
  let closeFlush: (() => void) | undefined;
  let epoch = 1;
  let textServiceAvailable = true;
  const fakeText = {
    async translateText(text: string) {
      translateCalls.push(text);
      return `[ko] ${text}`;
    },
    generateLiveHints(req: LiveHintGenerateRequest, o: { signal?: AbortSignal }) {
      return new Promise<LiveHintCandidate[]>((resolve) => {
        const call: HintCall = { req, signal: o.signal, resolve };
        hintCalls.push(call);
        if (!opts.controlled) {
          const ref = req.items.filter((i) => i.isNew).at(-1)?.ref ?? req.items.at(-1)!.ref;
          clock.setTimer(
            () =>
              resolve([
                {
                  kind: 'term',
                  text: `cue ${hintCalls.length}`,
                  refs: [ref],
                  basis: ['transcript'],
                },
              ]),
            1_000,
          );
        }
      });
    },
  };
  const stream: LiveSttSession = {
    provider: opts.provider ?? 'gemini',
    kind: opts.kind ?? 'transcription',
    sendPcm() {},
    async close() {
      closeFlush?.();
    },
  };
  const service = new LiveSessionService({
    getDataPath: () => workDir,
    ensureGeminiService: () =>
      textServiceAvailable ? (fakeText as unknown as GeminiService) : null,
    getAgentService: () => null,
    formatAiCredentialsError: () => 'No AI provider is configured.',
    getLiveSttConfig: () => ({ provider: opts.provider ?? 'gemini', translationLanguage: 'ko' }),
    createLiveSttSession: async (_config, cbs) => {
      callbacks = cbs;
      return stream;
    },
    emitEvent: (event) => events.push(event),
    getTextRouteEpoch: () => epoch,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return {
    clock,
    service,
    events,
    hintCalls,
    translateCalls,
    cb: () => callbacks!,
    onClose: (fn: () => void) => (closeFlush = fn),
    bumpEpoch: () => epoch++,
    dropTextService: () => (textServiceAvailable = false),
    hints: () => events.filter((e) => e.type === 'hint'),
  };
}

const line = (n: number) =>
  `Speaker ${n % 2 ? 'A' : 'B'}: point ${n} about the storage cutover runbook and its owner`;

describe('LiveSessionService live hints', () => {
  it('starts every session with automatic hints but never calls the text provider without speech', async () => {
    const t = setup();
    try {
      for (let i = 0; i < 2; i++) {
        const session = await t.service.start({ translate: false });
        assert.equal(t.service.snapshot()?.hints?.status.mode, 'auto');
        await t.clock.advance(60_000);
        assert.equal(t.hintCalls.length, 0, 'idle automatic sessions do not request hints');
        await t.service.stop(session.sessionId);
      }
    } finally {
      await t.service.stopActive('user');
    }
  });

  it('produces cues during continuous finals, independently of translation', async () => {
    const t = setup();
    const session = await t.service.start({ translate: true });
    t.service.setHintsMode(session.sessionId, 'auto');
    for (let i = 0; i < 16; i++) {
      t.cb().onFinal({ text: line(i), offsetMs: i * 2_000 });
      await t.clock.advance(2_000);
    }
    assert.ok(t.hintCalls.length >= 2, `got ${t.hintCalls.length} requests`);
    assert.ok(t.hints().length >= 2);
    // Translation updates re-emit segments but each final reaches hints once.
    assert.equal(t.translateCalls.length, 16);
    const newRefs = t.hintCalls.flatMap((c) =>
      c.req.items.filter((i) => i.isNew).map((i) => i.ref),
    );
    assert.equal(new Set(newRefs).size, newRefs.length, 'no source is offered as new twice');
    assert.ok(t.hintCalls.every((c) => c.req.language === 'Korean'));
  });

  it('begin-stop closes admission before the renderer flush; flushed finals start no request', async () => {
    const t = setup({ controlled: true });
    const session = await t.service.start({ translate: false });
    t.service.setHintsMode(session.sessionId, 'auto');
    for (let i = 0; i < 3; i++) t.cb().onFinal({ text: line(i), offsetMs: 0 });
    await t.clock.advance(0);
    assert.equal(t.hintCalls.length, 1);
    assert.equal(t.service.beginStop(session.sessionId), true);
    assert.equal(t.hintCalls[0].signal?.aborted, true);
    // The renderer now flushes WebRTC/chunked finals, then calls stop.
    t.service.receiveFinalTranscript({ sessionId: session.sessionId, text: line(10) });
    t.service.receiveFinalTranscript({ sessionId: session.sessionId, text: line(11) });
    await t.clock.advance(60_000);
    t.hintCalls[0].resolve([
      {
        kind: 'term',
        text: 'late',
        refs: [t.hintCalls[0].req.items[0].ref],
        basis: ['transcript'],
      },
    ]);
    await flush();
    const snapshot = await t.service.stop(session.sessionId);
    assert.equal(t.hintCalls.length, 1);
    assert.equal(t.hints().length, 0);
    assert.equal(snapshot?.segments.length, 5, 'captions still keep the flushed finals');
    assert.equal(snapshot?.hints?.status.state, 'stopped');
  });

  it('stop fences hint work before the provider flushes its last final', async () => {
    const t = setup({ controlled: true });
    const session = await t.service.start({ translate: false });
    t.service.setHintsMode(session.sessionId, 'auto');
    t.onClose(() => t.cb().onFinal({ text: `${line(1)} ${line(2)}` }));
    await t.service.stop(session.sessionId);
    await t.clock.advance(30_000);
    assert.equal(t.hintCalls.length, 0);
    assert.equal(t.service.snapshot()?.segments.length, 1);
  });

  it('drives no-final OpenAI translation streams from the original input transcript, then reconciles at close', async () => {
    const t = setup({ provider: 'openai', kind: 'translation' });
    const session = await t.service.start({ translate: true });
    t.service.setHintsMode(session.sessionId, 'auto');
    assert.equal(t.service.snapshot()?.hints?.status.sourceCapability, 'session-final');
    let source = '';
    let translation = '';
    for (let i = 0; i < 30; i++) {
      source = `${source} part ${i} of the billing export plan`.trim();
      translation = `${translation} 번역 ${i}`.trim();
      t.cb().onInterim({ text: source });
      t.cb().onTranslationInterim?.({ text: translation });
      await t.clock.advance(1_000);
    }
    assert.ok(t.hintCalls.length >= 2, `got ${t.hintCalls.length} requests before any final`);
    for (const call of t.hintCalls) {
      for (const item of call.req.items) {
        assert.equal(item.state, 'draft');
        assert.ok(!item.text.includes('번역'), 'translated text never becomes source');
      }
    }
    const draftHints = t.hints().length;
    assert.ok(draftHints >= 2);
    const callsBeforeClose = t.hintCalls.length;
    t.onClose(() => t.cb().onFinal({ text: source, translation }));
    await t.service.stop(session.sessionId);
    await t.clock.advance(30_000);
    assert.equal(t.hintCalls.length, callsBeforeClose);
    const finals = t.events.filter(
      (e) => e.type === 'hintUpdated' && e.hint.sourceState === 'final',
    );
    assert.ok(finals.length >= 1, 'draft cues upgraded to the closing final');
  });

  it('Gemini: interims every 1 s with no turn final for 40 s still yield automatic cues before stop, while captions and translation keep flowing', async () => {
    const t = setup({ provider: 'gemini', kind: 'translation' });
    const session = await t.service.start({ translate: true });
    t.service.setHintsMode(session.sessionId, 'auto');
    assert.equal(t.service.snapshot()?.hints?.status.sourceCapability, 'turn-finals');
    let source = '';
    let translation = '';
    const startsAt: number[] = [];
    for (let i = 0; i < 40; i++) {
      source = `${source} part ${i} of the billing export plan`.trim();
      translation = `${translation} 번역 ${i}`.trim();
      t.cb().onInterim({ text: source });
      t.cb().onTranslationInterim?.({ text: translation });
      while (startsAt.length < t.hintCalls.length) startsAt.push(t.events.length);
      await t.clock.advance(1_000);
    }
    assert.ok(t.hintCalls.length >= 2, `got ${t.hintCalls.length} requests before any final`);
    assert.ok(t.hints().length >= 2, 'cues are shown before the turn ends');
    for (const call of t.hintCalls) {
      for (const item of call.req.items) {
        assert.equal(item.state, 'draft');
        assert.ok(!item.text.includes('번역'), 'translated text never becomes source');
      }
    }
    // Captions and translation were emitted while a request was in flight.
    const first = startsAt[0];
    const firstCue = t.events.findIndex((e, i) => i > first && e.type === 'hint');
    const during = t.events.slice(first, firstCue);
    assert.ok(during.some((e) => e.type === 'interim'));
    assert.ok(during.some((e) => e.type === 'translationInterim'));
    assert.equal(t.events.filter((e) => e.type === 'translationInterim').length, 40);

    const callsBeforeFinal = t.hintCalls.length;
    t.cb().onFinal({ text: source, translation });
    await t.clock.advance(1_000);
    assert.ok(
      t.events.some((e) => e.type === 'hintUpdated' && e.hint.sourceState === 'final'),
      'the late turn final upgrades the draft cues',
    );
    const resent = t.hintCalls
      .slice(callsBeforeFinal)
      .flatMap((c) => c.req.items.filter((i) => i.isNew && i.text.includes('part 0 ')));
    assert.equal(resent.length, 0, 'the final never re-sends text drafts already covered');
    await t.service.stop(session.sessionId);
  });

  it('OpenAI transcription: one long item with no completed event for 32 s yields automatic cues', async () => {
    const t = setup({ provider: 'openai', kind: 'transcription' });
    const session = await t.service.start({ translate: false });
    t.service.setHintsMode(session.sessionId, 'auto');
    assert.equal(t.service.snapshot()?.hints?.status.sourceCapability, 'turn-finals');
    let source = '';
    for (let i = 0; i < 32; i++) {
      source = `${source} item ${i} about the storage cutover runbook`.trim();
      t.cb().onInterim({ text: source, itemId: 'item_1' });
      await t.clock.advance(1_000);
    }
    assert.ok(t.hintCalls.length >= 2, `got ${t.hintCalls.length} requests before completed`);
    assert.ok(t.hints().length >= 2);
    assert.ok(t.hints().every((e) => e.type === 'hint' && e.hint.sourceState === 'draft'));
    t.cb().onFinal({ text: source, itemId: 'item_1' });
    await t.clock.advance(1_000);
    assert.ok(t.events.some((e) => e.type === 'hintUpdated' && e.hint.sourceState === 'final'));
    await t.service.stop(session.sessionId);
  });

  it("a duplicate-suppressed turn final retracts that turn's drafts", async () => {
    const t = setup({ provider: 'gemini', kind: 'transcription', controlled: true });
    const session = await t.service.start({ translate: false });
    t.service.setHintsMode(session.sessionId, 'manual');
    const said = 'thanks everyone for joining the weekly operations review today';
    t.cb().onFinal({ text: said });
    t.cb().onInterim({ text: said });
    await t.clock.advance(15_000);
    t.service.requestHint(session.sessionId);
    const draft = t.hintCalls[0].req.items.find((i) => i.state === 'draft');
    assert.ok(draft, 'the second turn was admitted as a draft');
    t.hintCalls[0].resolve([
      { kind: 'term', text: 'cue', refs: [draft.ref], basis: ['transcript'] },
    ]);
    await flush();
    t.cb().onFinal({ text: said });
    assert.equal(t.service.snapshot()?.segments.length, 1, 'the duplicate final is suppressed');
    const retracted = t.events.filter(
      (e) => e.type === 'hintUpdated' && e.hint.sourceState === 'retracted',
    );
    assert.equal(retracted.length, 1);
    await t.service.stop(session.sessionId);
  });

  it('marks finals whose source is missing and never admits them', async () => {
    const t = setup({ provider: 'gemini', kind: 'translation' });
    const session = await t.service.start({ translate: true });
    t.service.setHintsMode(session.sessionId, 'auto');
    for (let i = 0; i < 10; i++) {
      t.cb().onFinal({
        text: `번역만 있는 문장 ${i} 입니다 길게 이어집니다`,
        translation: 'x',
        sourceMissing: true,
      });
      await t.clock.advance(2_000);
    }
    t.service.receiveFinalTranscript({
      sessionId: session.sessionId,
      text: '번역 텍스트',
      sourceMissing: true,
    });
    assert.equal(t.hintCalls.length, 0);
    assert.ok(t.service.snapshot()!.segments.every((s) => s.sourceMissing === true));
  });

  it('discards a result after the text route changes, and reports a missing route', async () => {
    const t = setup({ controlled: true });
    const session = await t.service.start({ translate: false });
    t.service.setHintsMode(session.sessionId, 'auto');
    for (let i = 0; i < 3; i++) t.cb().onFinal({ text: line(i), offsetMs: 0 });
    await t.clock.advance(0);
    t.bumpEpoch();
    t.service.onTextRouteChanged();
    assert.equal(t.hintCalls[0].signal?.aborted, true);
    t.hintCalls[0].resolve([
      { kind: 'term', text: 'old', refs: [t.hintCalls[0].req.items[0].ref], basis: ['transcript'] },
    ]);
    await flush();
    assert.equal(t.hints().length, 0);

    t.dropTextService();
    const result = t.service.requestHint(session.sessionId);
    assert.equal(result.accepted, false);
    assert.equal(result.hints.status.state, 'unavailable');
    assert.equal(result.hints.status.reason, 'No AI provider is configured.');
  });

  it('fences hints of a replaced session', async () => {
    const t = setup({ controlled: true });
    const first = await t.service.start({ translate: false });
    t.service.setHintsMode(first.sessionId, 'auto');
    for (let i = 0; i < 3; i++) t.cb().onFinal({ text: line(i), offsetMs: 0 });
    await t.clock.advance(0);
    const pending = t.hintCalls[0];
    await t.service.start({ translate: false });
    assert.equal(pending.signal?.aborted, true);
    pending.resolve([
      {
        kind: 'term',
        text: 'old session',
        refs: [pending.req.items[0].ref],
        basis: ['transcript'],
      },
    ]);
    await flush();
    assert.equal(t.hints().length, 0);
    assert.throws(() => t.service.setHintsMode(first.sessionId, 'auto'), /no longer active/);
  });
});
