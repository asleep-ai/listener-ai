import * as fs from 'fs';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as path from 'path';
import { makeTempDir, rmDir } from './test-helpers';
import {
  pathKeys,
  type TranscriptionJobHandle,
  type TranscriptionJobResultLike,
  type TranscriptionJobSnapshot,
  TranscriptionJobRegistry,
} from './transcriptionJobs';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('TranscriptionJobRegistry', () => {
  let dir: string;
  let audio: string;

  beforeEach(() => {
    dir = makeTempDir('transcription-jobs');
    audio = path.join(dir, 'Untitled_Meeting_2026-10-12T05-00-00-000Z.webm');
    fs.writeFileSync(audio, 'audio');
  });
  afterEach(() => rmDir(dir));

  it('joins an active job for the same path instead of starting or aborting one', async () => {
    const registry = new TranscriptionJobRegistry();
    const gate = deferred<TranscriptionJobResultLike>();
    let runs = 0;
    let firstSignal: AbortSignal | undefined;
    const runner = async (handle: TranscriptionJobHandle) => {
      runs++;
      firstSignal ??= handle.signal;
      return gate.promise;
    };
    const first = registry.start({ kind: 'transcribe', filePath: audio }, runner);
    const second = registry.start({ kind: 'transcribe', filePath: audio }, runner);
    assert.equal(first.joined, false);
    assert.equal(second.joined, true);
    assert.equal(second.job.id, first.job.id);
    assert.equal(runs, 1);
    gate.resolve({ success: true, transcriptionPath: '/note' });
    assert.deepEqual(await second.promise, await first.promise);
    assert.equal(firstSignal?.aborted, false);
    // A deliberate run after completion starts a new job.
    const third = registry.start({ kind: 'transcribe', filePath: audio }, async () => ({
      success: true,
    }));
    assert.equal(third.joined, false);
    assert.notEqual(third.job.id, first.job.id);
    await third.promise;
    assert.equal(runs, 1);
  });

  it('identifies one job by its original, unnormalized, and renamed paths', async () => {
    const registry = new TranscriptionJobRegistry();
    const gate = deferred<TranscriptionJobResultLike>();
    let handle!: TranscriptionJobHandle;
    const started = registry.start({ kind: 'transcribe', filePath: audio }, async (h) => {
      handle = h;
      return gate.promise;
    });
    const unnormalized = path.join(dir, '.', 'sub', '..', path.basename(audio));
    assert.equal(registry.findActive(unnormalized, 'transcribe')?.id, started.job.id);

    const renamed = path.join(dir, 'Weekly_Sync_2026-10-12T05-00-00-000Z.webm');
    fs.renameSync(audio, renamed);
    handle.addPath(renamed);
    assert.equal(registry.findActive(renamed, 'transcribe')?.id, started.job.id);
    assert.equal(registry.findActive(audio, 'transcribe')?.id, started.job.id);
    assert.equal(
      registry.start({ kind: 'transcribe', filePath: renamed }, async () => ({})).joined,
      true,
    );

    // Cancel through the renamed path reaches the same controller.
    assert.deepEqual(registry.cancel(renamed), { success: true });
    assert.equal(handle.signal.aborted, true);
    gate.resolve({ success: false, cancelled: true });
    await started.promise;
    assert.deepEqual(registry.cancel(audio), { success: false, reason: 'not-running' });
  });

  it('matches a symlinked directory spelling of the same recording', async () => {
    const link = path.join(makeTempDir('transcription-jobs-link'), 'recordings');
    fs.symlinkSync(dir, link);
    try {
      const registry = new TranscriptionJobRegistry();
      const gate = deferred<TranscriptionJobResultLike>();
      const started = registry.start(
        { kind: 'transcribe', filePath: path.join(link, path.basename(audio)) },
        async () => gate.promise,
      );
      assert.equal(registry.findActive(audio, 'transcribe')?.id, started.job.id);
      gate.resolve({ success: true });
      await started.promise;
    } finally {
      rmDir(path.dirname(link));
    }
  });

  it('never lets two running jobs answer to the same path', async () => {
    const registry = new TranscriptionJobRegistry();
    const other = path.join(dir, 'Weekly_Sync_2026-10-12T05-00-00-000Z.webm');
    fs.writeFileSync(other, 'other');
    const gateA = deferred<TranscriptionJobResultLike>();
    const gateB = deferred<TranscriptionJobResultLike>();
    let handleA!: TranscriptionJobHandle;
    let handleB!: TranscriptionJobHandle;
    const b = registry.start({ kind: 'transcribe', filePath: other }, async (h) => {
      handleB = h;
      return gateB.promise;
    });
    const a = registry.start({ kind: 'transcribe', filePath: audio }, async (h) => {
      handleA = h;
      return gateA.promise;
    });
    assert.equal(handleA.addPath(other), false);
    assert.ok(!registry.findActive(other, 'transcribe')?.paths.includes(audio));
    // Cancel through B's path reaches B only.
    assert.deepEqual(registry.cancel(other), { success: true });
    assert.equal(handleB.signal.aborted, true);
    assert.equal(handleA.signal.aborted, false);
    assert.equal(registry.findActive(audio, 'transcribe')?.id, a.job.id);
    gateA.resolve({ success: true });
    gateB.resolve({ success: false, cancelled: true });
    await Promise.all([a.promise, b.promise]);
    assert.equal(b.job.id !== a.job.id, true);
  });

  it('reserves a path before its file exists and releases only that path', async () => {
    const registry = new TranscriptionJobRegistry();
    const target = path.join(dir, 'Weekly_Sync_2026-10-12T05-00-00-000Z.webm');
    const gate = deferred<TranscriptionJobResultLike>();
    let handle!: TranscriptionJobHandle;
    const a = registry.start({ kind: 'transcribe', filePath: audio }, async (h) => {
      handle = h;
      return gate.promise;
    });
    assert.equal(handle.addPath(target), true);
    // While reserved, nobody else is admitted for that name.
    const other = registry.start({ kind: 'transcribe', filePath: target }, async () => ({}));
    assert.equal(other.joined, true);
    assert.equal(other.job.id, a.job.id);

    handle.removePath(target);
    assert.equal(registry.findActive(target, 'transcribe'), undefined);
    assert.equal(registry.findActive(audio, 'transcribe')?.id, a.job.id);
    assert.deepEqual(registry.findActive(audio, 'transcribe')?.paths, [audio]);
    assert.ok(registry.findActive(audio, 'transcribe')?.aliases.includes(fs.realpathSync(audio)));
    // The requested path is never released.
    handle.removePath(audio);
    assert.equal(registry.findActive(audio, 'transcribe')?.id, a.job.id);
    gate.resolve({ success: true });
    await a.promise;
  });

  it('keeps a reservation private until it is committed', async () => {
    const registry = new TranscriptionJobRegistry();
    const target = path.join(dir, 'Weekly_Sync_2026-10-12T05-00-00-000Z.webm');
    const gate = deferred<TranscriptionJobResultLike>();
    const events: string[][] = [];
    registry.subscribe((j) => events.push(j.paths));
    let handle!: TranscriptionJobHandle;
    const a = registry.start({ kind: 'transcribe', filePath: audio }, async (h) => {
      handle = h;
      return gate.promise;
    });
    assert.equal(handle.reservePath(target), true);
    // Nothing reaches A through the reserved name, and nothing lists it ...
    assert.equal(registry.findActive(target, 'transcribe'), undefined);
    assert.deepEqual(registry.cancel(target), { success: false, reason: 'not-running' });
    assert.equal(handle.signal.aborted, false);
    assert.ok(events.every((paths) => !paths.includes(target)));
    // ... but no other job can take it, and requests can wait for it.
    const other = registry.start(
      { kind: 'transcribe', filePath: dir + '/other.webm' },
      async (h) => {
        assert.equal(h.addPath(target), false);
        return {};
      },
    );
    await other.promise;
    const pending = registry.pendingReservation(target);
    assert.ok(pending);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    handle.commitPath(target);
    await pending;
    assert.equal(settled, true);
    assert.equal(registry.pendingReservation(target), undefined);
    assert.equal(registry.findActive(target, 'transcribe')?.id, a.job.id);
    assert.ok(events.at(-1)?.includes(target));

    // A released reservation was never visible.
    const later = path.join(dir, 'Later_2026-10-12T05-00-00-000Z.webm');
    assert.equal(handle.reservePath(later), true);
    handle.removePath(later);
    assert.equal(registry.pendingReservation(later), undefined);
    assert.equal(registry.findActive(later, 'transcribe'), undefined);
    gate.resolve({ success: true });
    await a.promise;
  });

  it('gives a missing file under a symlinked directory the canonical key too', () => {
    const link = path.join(makeTempDir('transcription-jobs-missing'), 'recordings');
    fs.symlinkSync(dir, link);
    try {
      const viaLink = pathKeys(path.join(link, 'Not_Created_Yet.webm'));
      const canonical = pathKeys(path.join(fs.realpathSync.native(dir), 'Not_Created_Yet.webm'));
      assert.ok(viaLink.some((key) => canonical.includes(key)));
    } finally {
      rmDir(path.dirname(link));
    }
  });

  it('lists the canonical keys it matches on as aliases', async () => {
    const registry = new TranscriptionJobRegistry();
    const gate = deferred<TranscriptionJobResultLike>();
    const started = registry.start(
      { kind: 'transcribe', filePath: audio },
      async () => gate.promise,
    );
    const real = fs.realpathSync.native(audio);
    assert.ok(started.job.aliases.includes(path.resolve(audio)));
    assert.ok(started.job.aliases.includes(real));
    gate.resolve({ success: true });
    await started.promise;
  });

  it('never treats two Unicode spellings as one file unless the filesystem says so', async () => {
    const nfc = path.join(dir, 'Re\u0301union_\uD68C\uC758.webm'.normalize('NFC'));
    const nfd = nfc.normalize('NFD');
    assert.notEqual(nfc, nfd);
    // Nothing on disk: no identity is inferred from normalization.
    assert.deepEqual(
      pathKeys(nfc).filter((key) => pathKeys(nfd).includes(key)),
      [],
    );

    fs.writeFileSync(nfc, 'audio');
    const registry = new TranscriptionJobRegistry();
    const gate = deferred<TranscriptionJobResultLike>();
    const started = registry.start({ kind: 'transcribe', filePath: nfc }, async () => gate.promise);
    const sameFile = fs.existsSync(nfd) && fs.statSync(nfd).ino === fs.statSync(nfc).ino;
    // Normalization-insensitive (APFS): the real path proves it is one file.
    // Normalization-sensitive (ext4): the NFD name is a different file.
    assert.equal(registry.findActive(nfd, 'transcribe')?.id === started.job.id, sameFile);
    gate.resolve({ success: true });
    await started.promise;
  });

  it('refuses to cancel after the commit boundary and keeps the result', async () => {
    const registry = new TranscriptionJobRegistry();
    const gate = deferred<TranscriptionJobResultLike>();
    let handle!: TranscriptionJobHandle;
    const started = registry.start({ kind: 'transcribe', filePath: audio }, async (h) => {
      handle = h;
      return gate.promise;
    });
    handle.commit();
    assert.deepEqual(registry.cancel(audio), { success: false, reason: 'committed' });
    assert.equal(handle.signal.aborted, false);
    assert.equal(registry.findActive(audio, 'transcribe')?.cancellable, false);
    gate.resolve({ success: true, transcriptionPath: '/note' });
    await started.promise;
    assert.equal(registry.list().jobs[0].status, 'succeeded');
  });

  it('emits strictly increasing revisions and a terminal snapshot', async () => {
    const registry = new TranscriptionJobRegistry();
    const events: TranscriptionJobSnapshot[] = [];
    registry.subscribe((job) => events.push(job));
    let handle!: TranscriptionJobHandle;
    const started = registry.start({ kind: 'transcribe', filePath: audio }, async (h) => {
      handle = h;
      h.progress(40, 'halfway');
      h.update({ phase: 'exporting', exports: { notion: { status: 'running' } } });
      return {
        success: true,
        newFilePath: path.join(dir, 'Renamed.webm'),
        transcriptionPath: '/note',
        generationId: 'gen-1',
        exports: { notion: { status: 'failed', error: 'down' } },
      };
    });
    await started.promise;
    const revisions = events.map((e) => e.revision);
    assert.deepEqual(
      revisions,
      [...revisions].sort((a, b) => a - b),
    );
    assert.equal(new Set(revisions).size, revisions.length);
    const last = events[events.length - 1];
    assert.equal(last.status, 'succeeded');
    assert.equal(last.percent, 100);
    assert.equal(last.cancellable, false);
    assert.equal(last.transcriptionPath, '/note');
    assert.equal(last.generationId, 'gen-1');
    assert.deepEqual(last.exports, { notion: { status: 'failed', error: 'down' } });
    assert.ok(last.paths.includes(path.join(dir, 'Renamed.webm')));
    assert.equal(registry.list().revision, last.revision);
    // Progress after settlement is ignored and never reopens the job.
    events.length = 0;
    handle.progress(10, 'late');
    handle.update({ phase: 'transcribing' });
    assert.equal(events.length, 0);
    assert.equal(registry.list().jobs[0].status, 'succeeded');
  });

  it('settles a throwing runner as failed and rethrows to callers', async () => {
    const registry = new TranscriptionJobRegistry();
    const started = registry.start({ kind: 'transcribe', filePath: audio }, async () => {
      throw new Error('boom');
    });
    await assert.rejects(started.promise, /boom/);
    const [job] = registry.list().jobs;
    assert.equal(job.status, 'failed');
    assert.equal(job.error, 'boom');
  });

  it('keeps merge jobs separate from transcription of their sources', async () => {
    const registry = new TranscriptionJobRegistry();
    const gate = deferred<TranscriptionJobResultLike>();
    const merge = registry.start(
      { kind: 'merge', filePath: 'merge', sourcePaths: [audio] },
      async () => gate.promise,
    );
    assert.equal(registry.hasActive('merge'), true);
    assert.equal(registry.findActive(audio, 'transcribe'), undefined);
    assert.deepEqual(registry.cancel(audio), { success: false, reason: 'not-running' });
    gate.resolve({ success: true, mergedAudioPath: '/merged.webm' });
    await merge.promise;
    assert.equal(registry.hasActive('merge'), false);
    assert.equal(registry.list().jobs[0].mergedAudioPath, '/merged.webm');
  });

  it('evicts finished jobs past the retention bound but never running ones', async () => {
    let now = 1_000_000;
    const registry = new TranscriptionJobRegistry({
      maxFinished: 2,
      finishedTtlMs: 1000,
      now: () => now,
    });
    const gate = deferred<TranscriptionJobResultLike>();
    const running = registry.start(
      { kind: 'transcribe', filePath: audio },
      async () => gate.promise,
    );
    for (let i = 0; i < 3; i++) {
      await registry.start(
        { kind: 'transcribe', filePath: path.join(dir, `f${i}.webm`) },
        async () => ({
          success: true,
        }),
      ).promise;
    }
    assert.equal(registry.list().jobs.length, 3);
    now += 5000;
    const ids = registry.list().jobs.map((j) => j.id);
    assert.deepEqual(ids, [running.job.id]);
    gate.resolve({ success: true });
    await running.promise;
  });
});
