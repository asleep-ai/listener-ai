import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  finishRecordingWithHints,
  parseRecordingLiveHints,
  LIVE_HINTS_FILE,
  recordingHintsBelongToAudio,
} from './recordingLiveHints';
import { readTranscription, saveTranscription } from './outputService';
import { saveRegeneratedTranscription } from './regenerateTranscription';
import { LiveSessionService } from './liveSessionService';
import type { LiveHint, RecordingLiveHintsV1 } from './liveHintTypes';

function cue(sessionId = 'session-a'): LiveHint {
  return {
    id: `${sessionId}_cue`,
    sessionId,
    kind: 'term',
    text: 'Grounded hint',
    basis: ['transcript'],
    sourceState: 'retracted',
    sourceSegmentIds: ['source'],
    sources: [{ ref: 'source', state: 'draft', text: 'Original source', offsetMs: 100 }],
    trigger: 'auto',
    revision: 2,
    createdAt: '2026-10-21T00:00:00Z',
    offsetMs: 200,
    anchorOffsetMs: 100,
    history: [
      {
        revision: 1,
        text: 'Earlier hint',
        producedOffsetMs: 150,
        sourceState: 'draft',
        sources: [{ ref: 'source', state: 'draft', text: 'Earlier source', offsetMs: 100 }],
      },
    ],
  };
}
function history(): RecordingLiveHintsV1 {
  return {
    version: 1,
    recordingId: 'audio.webm',
    sessions: [
      {
        sessionId: 'session-a',
        startedAt: '2026-10-21T00:00:00Z',
        recordingOffsetMs: 1000,
        hints: [cue()],
      },
    ],
  };
}

test('history reader preserves evidence/revisions and strips unrecognized fields', () => {
  const input = history();
  Object.assign(input.sessions[0].hints[0], { apiKey: 'not-public' });
  assert.deepEqual(parseRecordingLiveHints(input), history());
  assert.equal(parseRecordingLiveHints({ version: 2, sessions: [] }), undefined);
  input.sessions[0].hints[0].sessionId = 'another-session';
  assert.equal(parseRecordingLiveHints(input)?.truncated, true);
  assert.deepEqual(parseRecordingLiveHints(input)?.sessions[0].hints, []);
});

test('rejected persisted sessions and cues retain an incomplete-history notice', () => {
  const input = history();
  const oversized = cue();
  oversized.sources[0].text = 'x'.repeat(12001);
  input.sessions[0].hints.push(oversized);
  const partial = parseRecordingLiveHints(input);
  assert.equal(partial?.truncated, true);
  assert.equal(partial?.sessions[0].truncated, true);
  assert.deepEqual(partial?.sessions[0].hints, [cue()]);

  const invalidSession = { ...history().sessions[0], startedAt: 'invalid date' };
  const rejected = parseRecordingLiveHints({ ...history(), sessions: [invalidSession] });
  assert.equal(rejected?.truncated, true);
  assert.deepEqual(rejected?.sessions, []);
});

test('absent, malformed, and oversized histories are tolerant', () => {
  for (const value of [undefined, null, 'bad'])
    assert.equal(parseRecordingLiveHints(value), undefined);
});

test('note history round-trips, remains separate from report, and survives regeneration', async () => {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-hints-'));
  const result = {
    transcript: 'Transcript',
    summary: 'Summary',
    emoji: '',
    keyPoints: [],
    actionItems: [],
  };
  try {
    const folder = saveTranscription({ title: 'Meeting', result, dataPath, liveHints: history() });
    const originalStat = fs.promises.stat;
    const visited: string[] = [];
    fs.promises.stat = (async (...args: Parameters<typeof originalStat>) => {
      visited.push(String(args[0]));
      return originalStat(...args);
    }) as typeof originalStat;
    try {
      const lightweight = await readTranscription(folder);
      assert.equal(lightweight?.liveHints, undefined);
      assert.equal(lightweight?.transcript, result.transcript);
      assert.equal(visited.includes(path.join(folder, LIVE_HINTS_FILE)), false);
    } finally {
      fs.promises.stat = originalStat;
    }
    assert.deepEqual(
      (await readTranscription(folder, { includeLiveHints: true }))?.liveHints,
      history(),
    );
    assert.equal(
      fs.readFileSync(path.join(folder, 'summary.md'), 'utf8').includes('Grounded hint'),
      false,
    );
    saveRegeneratedTranscription({
      title: 'Updated',
      result,
      dataPath,
      previousFolderPath: folder,
    });
    assert.deepEqual(
      (await readTranscription(folder, { includeLiveHints: true }))?.liveHints,
      history(),
    );
    fs.writeFileSync(path.join(folder, LIVE_HINTS_FILE), '{broken');
    assert.equal(
      (await readTranscription(folder, { includeLiveHints: true }))?.liveHints,
      undefined,
    );
    fs.unlinkSync(path.join(folder, LIVE_HINTS_FILE));
    assert.equal(
      (await readTranscription(folder, { includeLiveHints: true }))?.liveHints,
      undefined,
    );
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('recording ownership survives live stop/replacement, offsets align, and cannot leak to another recording', async () => {
  let recording: { filePath: string; startedAtMs: number } | null = {
    filePath: '/audio/a.webm',
    startedAtMs: 1000,
  };
  let now = 2000;
  const service = new LiveSessionService({
    getDataPath: () => os.tmpdir(),
    ensureGeminiService: () => null,
    getAgentService: () => null,
    formatAiCredentialsError: () => 'No credentials',
    getLiveSttConfig: () => ({ provider: 'chunked' }),
    getActiveRecording: () => recording,
    now: () => now,
  });
  const inject = (id: string) => {
    const internal = service as unknown as { session: { hints: { snapshot(): unknown } } };
    internal.session.hints.snapshot = () => ({ hints: [cue(id)], status: {} });
    (service as unknown as { emit(event: unknown): void }).emit({
      type: 'hint',
      sessionId: id,
      hint: cue(id),
    });
  };
  const first = await service.start();
  inject(first.sessionId);
  await service.stop(first.sessionId);
  now = 3000;
  const second = await service.start();
  inject(second.sessionId);
  await service.stop(second.sessionId);
  const preview = service.takeRecordingHints('/audio/a.webm', false);
  assert.equal(preview?.sessions.length, 2);
  const stored = service.takeRecordingHints('/audio/a.webm');
  assert.deepEqual(stored, preview);
  assert.equal(stored?.sessions.length, 2);
  assert.deepEqual(
    stored?.sessions.map((s) => s.recordingOffsetMs),
    [1000, 2000],
  );
  assert.equal(service.takeRecordingHints('/audio/a.webm'), undefined);
  recording = { filePath: '/audio/b.webm', startedAtMs: 4000 };
  now = 4500;
  const third = await service.start();
  inject(third.sessionId);
  assert.equal(service.takeRecordingHints('/audio/a.webm'), undefined);
  assert.equal(service.takeRecordingHints('/audio/b.webm')?.sessions[0].sessionId, third.sessionId);
  recording = null;
  const standalone = await service.start();
  inject(standalone.sessionId);
  assert.equal(service.takeRecordingHints('/audio/b.webm'), undefined);
  await service.stop(standalone.sessionId);
});

test('a recording replaced while previous stream closes cannot acquire the new session', async () => {
  let recording = { filePath: '/audio/a.webm', startedAtMs: 1000 };
  const service = new LiveSessionService({
    getDataPath: () => os.tmpdir(),
    ensureGeminiService: () => null,
    getAgentService: () => null,
    formatAiCredentialsError: () => 'No credentials',
    getLiveSttConfig: () => ({ provider: 'chunked' }),
    getActiveRecording: () => recording,
    now: () => 2000,
  });
  await service.start();
  const internal = service as unknown as {
    session: { stream: { close(): Promise<void> } | null; hints: { snapshot(): unknown } };
  };
  let release!: () => void;
  internal.session.stream = {
    close: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  };
  const pending = service.start();
  recording = { filePath: '/audio/b.webm', startedAtMs: 2000 };
  release();
  const session = await pending;
  internal.session.hints.snapshot = () => ({ hints: [cue(session.sessionId)], status: {} });
  assert.equal(service.takeRecordingHints('/audio/a.webm'), undefined);
  assert.equal(service.takeRecordingHints('/audio/b.webm'), undefined);
  await service.stop(session.sessionId);
});

test('recording archive exceeds the live 200-cue window and retains later retractions', async () => {
  const service = new LiveSessionService({
    getDataPath: () => os.tmpdir(),
    ensureGeminiService: () => null,
    getAgentService: () => null,
    formatAiCredentialsError: () => 'No credentials',
    getLiveSttConfig: () => ({ provider: 'chunked' }),
    getActiveRecording: () => ({ filePath: '/audio/a.webm', startedAtMs: 1000 }),
    now: () => 2000,
  });
  const session = await service.start();
  const emit = (hint: LiveHint) =>
    (service as unknown as { emit(event: unknown): void }).emit({
      type: 'hintUpdated',
      sessionId: session.sessionId,
      hint,
    });
  for (let i = 0; i < 210; i++)
    emit({ ...cue(session.sessionId), id: `cue-${i}`, sourceState: 'draft' });
  emit({ ...cue(session.sessionId), id: 'cue-0', revision: 3, sourceState: 'retracted' });
  const stored = service.takeRecordingHints('/audio/a.webm', false);
  assert.equal(stored?.sessions[0].hints.length, 210);
  assert.equal(stored?.sessions[0].hints[0].sourceState, 'retracted');
  assert.equal(stored?.sessions[0].hints[0].revision, 3);
  for (let i = 210; i < 2001; i++) emit({ ...cue(session.sessionId), id: `cue-${i}` });
  const bounded = service.takeRecordingHints('/audio/a.webm');
  assert.equal(bounded?.sessions[0].hints.length, 2000);
  assert.equal(bounded?.truncated, true);
  assert.equal(bounded?.sessions[0].truncated, true);
  await service.stop(session.sessionId);
});

test('valid 21-source cues survive and size bounds preserve a marked prefix', () => {
  const input = history();
  input.sessions[0].hints[0].sources = Array.from({ length: 21 }, (_, i) => ({
    ref: `source-${i}`,
    state: 'final',
    text: 'Evidence',
    offsetMs: i,
  }));
  assert.equal(parseRecordingLiveHints(input)?.sessions[0].hints[0].sources.length, 21);
  const big = cue();
  big.sources = Array.from({ length: 100 }, (_, i) => ({
    ref: `source-${i}`,
    state: 'final',
    text: 'x'.repeat(8000),
    offsetMs: i,
  }));
  input.sessions[0].hints = Array.from({ length: 12 }, (_, i) => ({ ...big, id: `cue-${i}` }));
  const bounded = parseRecordingLiveHints(input);
  assert.equal(bounded?.truncated, true);
  assert.ok(bounded!.sessions[0].hints.length > 0);
  assert.ok(bounded!.sessions[0].hints.length < 12);
});

test('replacement closes the old stream before freezing reconciled recording evidence', async () => {
  const service = new LiveSessionService({
    getDataPath: () => os.tmpdir(),
    ensureGeminiService: () => null,
    getAgentService: () => null,
    formatAiCredentialsError: () => 'No credentials',
    getLiveSttConfig: () => ({ provider: 'chunked' }),
    getActiveRecording: () => ({ filePath: '/audio/a.webm', startedAtMs: 1000 }),
    now: () => 2000,
  });
  const first = await service.start();
  const internal = service as unknown as {
    emit(event: unknown): void;
    session: { stream: { close(): Promise<void> } | null };
  };
  internal.emit({
    type: 'hint',
    sessionId: first.sessionId,
    hint: { ...cue(first.sessionId), sourceState: 'draft' },
  });
  internal.session.stream = {
    close: async () => {
      internal.emit({
        type: 'hintUpdated',
        sessionId: first.sessionId,
        hint: { ...cue(first.sessionId), sourceState: 'final', revision: 3 },
      });
    },
  };
  const second = await service.start();
  const stored = service.takeRecordingHints('/audio/a.webm');
  assert.equal(stored?.sessions[0].hints[0].sourceState, 'final');
  assert.equal(stored?.sessions[0].hints[0].revision, 3);
  await service.stop(second.sessionId);
});

test('same basename under a different directory cannot read another recording history', () => {
  assert.equal(
    recordingHintsBelongToAudio('/recordings/a.webm', { filePath: '/recordings/a.webm' }),
    true,
  );
  assert.equal(
    recordingHintsBelongToAudio('/other/a.webm', { filePath: '/recordings/a.webm' }),
    false,
  );
  assert.equal(recordingHintsBelongToAudio('/recordings/a.webm', {}), false);
});

test('finalizer persists newest late reconciliation for retained partial audio', async () => {
  let current = history();
  let consumed = false;
  let saved: RecordingLiveHintsV1 | undefined;
  const result = await finishRecordingWithHints({
    activeFilePath: '/audio/a.webm',
    stop: async () => {
      current = history();
      current.sessions[0].hints[0].revision = 9;
      return { success: false, filePath: '/audio/a.webm', error: 'Write failed' };
    },
    hints: {
      takeRecordingHints: (_, consume = true) => {
        if (consume) consumed = true;
        return current;
      },
      markRecordingHintsSaveFailed: () => assert.fail('unexpected failure'),
    },
    save: async (_, value) => {
      saved = value;
    },
    onSaveError: () => assert.fail('unexpected failure'),
  });
  assert.equal(result.success, false);
  assert.equal(saved?.sessions[0].hints[0].revision, 9);
  assert.equal(consumed, true);
});

test('metadata failure retains retryable history and returns a user-visible warning', async () => {
  let consumed = false;
  let failed = false;
  const result = await finishRecordingWithHints({
    activeFilePath: '/audio/a.webm',
    stop: async () => ({ success: true, filePath: '/audio/a.webm' }),
    hints: {
      takeRecordingHints: (_, consume = true) => {
        consumed ||= consume;
        return history();
      },
      markRecordingHintsSaveFailed: () => {
        failed = true;
      },
    },
    save: async () => {
      throw new Error('Disk full');
    },
    onSaveError: () => {},
  });
  assert.equal(result.success, true);
  assert.ok(result.liveHintsSaveError);
  assert.equal(consumed, false);
  assert.equal(failed, true);
});

test('archive byte budget counts Korean UTF-8 bytes and marks omitted hints', () => {
  const input = history();
  const big = cue();
  big.sources = Array.from({ length: 100 }, (_, i) => ({
    ref: `source-${i}`,
    state: 'final',
    text: '가'.repeat(8000),
    offsetMs: i,
  }));
  input.sessions[0].hints = Array.from({ length: 5 }, (_, i) => ({ ...big, id: `cue-${i}` }));
  const bounded = parseRecordingLiveHints(input);
  assert.equal(bounded?.truncated, true);
  assert.ok(bounded!.sessions[0].hints.length < 5);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded), 'utf8') < 8 * 1024 * 1024);
});

test('failed history retention stays bounded and reserves a visible incomplete result without blocking audio', async () => {
  let recording = { filePath: '/audio/0.webm', startedAtMs: 1000 };
  const service = new LiveSessionService({
    getDataPath: () => os.tmpdir(),
    ensureGeminiService: () => null,
    getAgentService: () => null,
    formatAiCredentialsError: () => 'No credentials',
    getLiveSttConfig: () => ({ provider: 'chunked' }),
    getActiveRecording: () => recording,
    now: () => 2000,
  });
  const emit = (id: string) =>
    (service as unknown as { emit(event: unknown): void }).emit({
      type: 'hint',
      sessionId: id,
      hint: cue(id),
    });
  for (let i = 0; i < 8; i++) {
    recording = { filePath: `/audio/${i}.webm`, startedAtMs: 1000 };
    const session = await service.start();
    emit(session.sessionId);
    service.markRecordingHintsSaveFailed(recording.filePath);
  }
  recording = { filePath: '/audio/current.webm', startedAtMs: 1000 };
  const blocked = await service.start();
  emit(blocked.sessionId);
  assert.equal(service.takeRecordingHints(recording.filePath)?.truncated, true);
  // Failed originals are intact, and consuming one releases a retry slot.
  assert.equal(service.takeRecordingHints('/audio/0.webm')?.sessions[0].hints.length, 1);
  recording = { filePath: '/audio/next.webm', startedAtMs: 1000 };
  const next = await service.start();
  emit(next.sessionId);
  assert.equal(service.takeRecordingHints(recording.filePath)?.sessions[0].hints.length, 1);
  await service.stop(next.sessionId);
});

test('crash finalizer closes audio first, then saves late finals drained by the same live stop', async () => {
  const service = new LiveSessionService({
    getDataPath: () => os.tmpdir(),
    ensureGeminiService: () => null,
    getAgentService: () => null,
    formatAiCredentialsError: () => 'No credentials',
    getLiveSttConfig: () => ({ provider: 'chunked' }),
    getActiveRecording: () => ({ filePath: '/audio/a.webm', startedAtMs: 1000 }),
    now: () => 2000,
  });
  const session = await service.start();
  const internal = service as unknown as {
    emit(event: unknown): void;
    session: { stream: { close(): Promise<void> } | null };
  };
  internal.emit({
    type: 'hint',
    sessionId: session.sessionId,
    hint: { ...cue(session.sessionId), sourceState: 'draft' },
  });
  const order: string[] = [];
  let release!: () => void;
  internal.session.stream = {
    close: () =>
      new Promise<void>((resolve) => {
        release = () => {
          order.push('late-final');
          internal.emit({
            type: 'hintUpdated',
            sessionId: session.sessionId,
            hint: { ...cue(session.sessionId), sourceState: 'final', revision: 3 },
          });
          resolve();
        };
      }),
  };
  // Renderer crash: main starts the renderer-lost stop, then finalizes audio.
  const liveDrain = service.stopActive('renderer-lost');
  let saved: { filePath: string; history: RecordingLiveHintsV1 } | undefined;
  const finishing = finishRecordingWithHints({
    activeFilePath: '/audio/a.webm',
    stop: async () => {
      order.push('audio-stop');
      return { success: true, filePath: '/audio/a.webm' };
    },
    hints: service,
    save: async (filePath, value) => {
      order.push('save');
      saved = { filePath, history: value };
    },
    onSaveError: () => assert.fail('unexpected failure'),
    liveDrain,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    order,
    ['audio-stop'],
    'audio closes first and hints wait for the live stop drain',
  );
  release();
  const result = await finishing;
  assert.equal(result.success, true);
  assert.deepEqual(order, ['audio-stop', 'late-final', 'save']);
  assert.equal(saved?.filePath, '/audio/a.webm');
  assert.equal(saved?.history.recordingId, 'a.webm');
  assert.equal(saved?.history.sessions[0].sessionId, session.sessionId);
  assert.equal(saved?.history.sessions[0].hints[0].sourceState, 'final');
  assert.equal(saved?.history.sessions[0].hints[0].revision, 3);
  assert.equal(service.takeRecordingHints('/audio/a.webm'), undefined, 'archive consumed once');
  assert.equal((await liveDrain)?.endedReason, 'renderer-lost');
});

test('normal stop without a live drain saves right after the audio stop', async () => {
  const order: string[] = [];
  await finishRecordingWithHints({
    activeFilePath: '/audio/a.webm',
    stop: async () => {
      order.push('audio-stop');
      return { success: true, filePath: '/audio/a.webm' };
    },
    hints: {
      takeRecordingHints: (_, consume = true) => {
        order.push(consume ? 'consume' : 'take');
        return history();
      },
      markRecordingHintsSaveFailed: () => assert.fail('unexpected failure'),
    },
    save: async () => {
      order.push('save');
    },
    onSaveError: () => assert.fail('unexpected failure'),
  });
  assert.deepEqual(order, ['take', 'audio-stop', 'take', 'save', 'consume']);
});
