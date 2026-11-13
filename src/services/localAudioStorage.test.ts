// Google Drive backed local storage management, end to end against the real
// on-disk layout: recordings live in `<dataPath>/recordings/`, notes in
// `<dataPath>/transcriptions/<folder>/meta.json` linking them via audioFile.
// The Drive client is a fake that keeps byte content and Drive-style md5
// checksums, so verification paths run for real.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as fs from 'fs';
import * as path from 'path';
import type { TranscriptionResult } from '../geminiService';
import {
  __saveTranscriptionLegacyV1ForTests,
  migrateV1ToV2,
  saveTranscription,
} from '../outputService';
import { saveRegeneratedTranscription } from '../regenerateTranscription';
import { makeTempDir, rmDir } from '../test-helpers';
import { FakeDrive } from './fakeDriveForTests';
import { GoogleSessionTracker } from './googleSession';
import {
  buildLocalStorageReport,
  cleanupRestoreTemps,
  readLocalAudioRecord,
  reclaimLocalAudio,
  resolveNoteAudioPath,
  resolveVerifiedNoteAudioPath,
  restoreLocalAudio,
  withAudioReadLease,
} from './localAudioStorage';
import { SyncEngine, type SyncState } from './syncEngine';

const DAY = 24 * 60 * 60 * 1000;

const md5 = (b: Buffer) => createHash('md5').update(b).digest('hex');

const result: TranscriptionResult = {
  transcript: 'Speaker A: hello.',
  summary: 'Greeting.',
  keyPoints: ['Hello'],
  actionItems: [],
  emoji: '👋',
  suggestedTitle: 'Greeting',
};

describe('local audio storage backed by Google Drive', () => {
  let dataPath: string;
  let recordingsDir: string;
  let drive: FakeDrive;
  let syncStatePath: string;

  beforeEach(() => {
    dataPath = makeTempDir('local-audio');
    recordingsDir = path.join(dataPath, 'recordings');
    fs.mkdirSync(recordingsDir, { recursive: true });
    drive = new FakeDrive();
    syncStatePath = path.join(dataPath, 'sync-state.json');
  });
  afterEach(() => rmDir(dataPath));

  function engine(): SyncEngine {
    return new SyncEngine({
      driveClient: drive.asClient(),
      transcriptionsDir: path.join(dataPath, 'transcriptions'),
      syncStatePath,
      recordingsDir,
    });
  }

  function record(name: string, bytes = `audio:${name}`, ageDays = 0): string {
    const p = path.join(recordingsDir, name);
    fs.writeFileSync(p, Buffer.from(bytes.repeat(50)));
    if (ageDays) {
      const t = new Date(Date.now() - ageDays * DAY);
      fs.utimesSync(p, t, t);
    }
    return p;
  }

  function note(title: string, audioFilePath: string, now?: Date): string {
    return saveTranscription({ title, result, audioFilePath, dataPath, ...(now ? { now } : {}) });
  }

  function state(): SyncState {
    return JSON.parse(fs.readFileSync(syncStatePath, 'utf-8'));
  }

  const reclaim = (extra: Partial<Parameters<typeof reclaimLocalAudio>[0]> = {}) =>
    reclaimLocalAudio({ dataPath, driveClient: drive.asClient(), ...extra });

  it('sync uploads the linked recording from recordings/ with a verified checksum', async () => {
    const audio = record('Weekly_2026-01-01T00-00-00-000Z.webm');
    const folder = note('Weekly', audio);
    const before = buildLocalStorageReport(dataPath);
    assert.equal(before.notBackedUpFiles, 1);
    assert.equal(before.eligibleFiles, 0);

    const res = await engine().syncOnce();
    assert.deepEqual(res.errors, []);
    const meeting = path.basename(folder);
    const entry = state().meetings[meeting].files[path.basename(audio)];
    assert.equal(entry.sourceAudio, true);
    assert.equal(entry.md5Checksum, md5(fs.readFileSync(audio)));
    assert.equal(entry.size, fs.statSync(audio).size);
    const [remote] = drive.byName(path.basename(audio));
    assert.equal(remote.parents?.[0], state().meetings[meeting].driveFolderId);

    const report = buildLocalStorageReport(dataPath);
    assert.equal(report.eligibleFiles, 1);
    assert.equal(report.eligibleBytes, fs.statSync(audio).size);
    assert.ok(report.audioBytes >= report.eligibleBytes);
    assert.ok(report.notesBytes > 0);
    assert.equal(report.totalBytes >= report.audioBytes + report.notesBytes, true);

    // Second sync: unchanged audio is not uploaded again.
    const uploadsBefore = drive.uploads.length;
    await engine().syncOnce();
    assert.equal(drive.uploads.length, uploadsBefore);
  });

  it('records no backup when Drive reports a different checksum', async () => {
    const audio = record('A_2026-01-01T00-00-00-000Z.webm');
    note('A', audio);
    drive.corruptUploadChecksum = true;
    const res = await engine().syncOnce();
    assert.ok(res.errors.some((e) => /did not match/.test(e.error)));
    assert.equal(buildLocalStorageReport(dataPath).eligibleFiles, 0);
    const out = await reclaim();
    assert.equal(out.removed.length, 0);
    assert.ok(fs.existsSync(audio));
  });

  it('frees space, then the next sync keeps the Drive copy and the note', async () => {
    const audio = record('B_2026-01-01T00-00-00-000Z.webm');
    const folder = note('B', audio);
    await engine().syncOnce();
    const size = fs.statSync(audio).size;

    const out = await reclaim({ paths: [audio] });
    assert.deepEqual(out.skipped, []);
    assert.equal(out.freedBytes, size);
    assert.equal(fs.existsSync(audio), false);
    assert.ok(fs.existsSync(path.join(folder, 'meta.json')), 'note kept');
    assert.ok(readLocalAudioRecord(dataPath, audio)?.removedAt);

    const uploads = drive.uploads.length;
    const res = await engine().syncOnce();
    assert.deepEqual(res.errors, []);
    assert.deepEqual(res.tombstoned, []);
    assert.equal(drive.trashCalls.length, 0, 'nothing trashed on Drive');
    assert.equal(drive.uploads.length, uploads, 'nothing re-uploaded');
    assert.equal(drive.byName(path.basename(audio)).length, 1, 'Drive copy kept');
    const entry = state().meetings[path.basename(folder)].files[path.basename(audio)];
    assert.equal(entry.cloudOnly, true);

    const report = buildLocalStorageReport(dataPath);
    assert.equal(report.cloudOnlyFiles, 1);
    assert.equal(report.cloudOnlyBytes, size);
    assert.equal(report.eligibleFiles, 0);
  });

  describe('never removes audio when verification fails', () => {
    let audio: string;
    let remoteId: string;
    beforeEach(async () => {
      audio = record('C_2026-01-01T00-00-00-000Z.webm');
      note('C', audio);
      await engine().syncOnce();
      remoteId = drive.byName(path.basename(audio))[0].id;
    });

    const expectKept = async (reason: string) => {
      const out = await reclaim({ paths: [audio] });
      assert.equal(out.removed.length, 0);
      assert.equal(out.skipped[0]?.reason, reason);
      assert.ok(fs.existsSync(audio));
    };

    it('Drive checksum differs', async () => {
      drive.files.get(remoteId)!.md5Checksum = 'ffff';
      await expectKept('drive-mismatch');
    });
    it('Drive size differs', async () => {
      drive.files.get(remoteId)!.size = '1';
      await expectKept('drive-mismatch');
    });
    it('Drive copy is in the trash', async () => {
      drive.files.get(remoteId)!.trashed = true;
      await expectKept('drive-mismatch');
    });
    it('Drive copy moved to another folder', async () => {
      drive.files.get(remoteId)!.parents = ['elsewhere'];
      await expectKept('drive-mismatch');
    });
    it('the signed-in account cannot see the copy', async () => {
      drive.hidden = true;
      await expectKept('drive-unavailable');
    });
    it('the expected Drive folder is unknown', async () => {
      const s = state();
      for (const m of Object.values(s.meetings)) m.driveFolderId = '';
      fs.writeFileSync(syncStatePath, JSON.stringify(s));
      await expectKept('drive-mismatch');
    });
    it('local audio changed after upload', async () => {
      fs.appendFileSync(audio, 'more');
      await expectKept('not-backed-up');
    });
    it('local bytes changed but size and mtime were restored', async () => {
      const buf = fs.readFileSync(audio);
      buf[0] ^= 0xff;
      fs.writeFileSync(audio, buf);
      // Make the recorded bookkeeping match the new size and mtime, so only
      // the fresh hash can tell the bytes changed.
      const s = state();
      const entry = Object.values(s.meetings)[0].files[path.basename(audio)];
      entry.localMtimeMs = fs.statSync(audio).mtimeMs;
      fs.writeFileSync(syncStatePath, JSON.stringify(s));
      await expectKept('changed');
    });
    it('a process holds a read lease', async () => {
      let out: Awaited<ReturnType<typeof reclaim>> | undefined;
      await withAudioReadLease(dataPath, audio, async () => {
        out = await reclaim({ paths: [audio] });
      });
      assert.equal(out?.skipped[0]?.reason, 'in-use');
      assert.ok(fs.existsSync(audio));
    });
    it('the app reports the file in use', async () => {
      await (async () => {
        const out = await reclaim({ paths: [audio], isInUse: () => true });
        assert.equal(out.skipped[0]?.reason, 'in-use');
      })();
      assert.ok(fs.existsSync(audio));
    });
    it('cancelled while verifying with Drive', async () => {
      let go = true;
      drive.getFileHook = () => {
        go = false;
      };
      const out = await reclaim({ paths: [audio], shouldContinue: () => go });
      assert.equal(out.skipped[0]?.reason, 'cancelled');
      assert.ok(fs.existsSync(audio));
    });
  });

  it('a read lease fails closed when it cannot be taken', async () => {
    const audio = record('D_2026-01-01T00-00-00-000Z.webm');
    // A plain file where the lock directory must go makes locking fail.
    fs.writeFileSync(path.join(dataPath, '.listener-meeting-locks'), 'x');
    let ran = false;
    await assert.rejects(
      withAudioReadLease(dataPath, audio, () => {
        ran = true;
      }),
    );
    assert.equal(ran, false);
  });

  it('read leases of dead processes do not block removal', async () => {
    const audio = record('E_2026-01-01T00-00-00-000Z.webm');
    note('E', audio);
    await engine().syncOnce();
    const leaseDir = fs.readdirSync(path.join(dataPath)).includes('.listener-audio-leases');
    assert.equal(leaseDir, false);
    const hash = createHash('sha256').update(path.resolve(audio)).digest('hex');
    const dir = path.join(dataPath, '.listener-audio-leases', hash);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '999999999-dead.lease'), '{}');
    const out = await reclaim({ paths: [audio] });
    assert.equal(out.removed.length, 1);
  });

  it('automatic policy removes only audio unused for the configured days', async () => {
    const old = record('Old_2026-01-01T00-00-00-000Z.webm', 'old', 40);
    const fresh = record('New_2026-01-02T00-00-00-000Z.webm', 'new');
    note('Old', old);
    note('New', fresh);
    await engine().syncOnce();

    const out = await reclaim({ olderThanDays: 30 });
    assert.deepEqual(
      out.removed.map((r) => path.basename(r.path)),
      ['Old_2026-01-01T00-00-00-000Z.webm'],
    );
    assert.ok(out.skipped.some((s) => s.path === fresh && s.reason === 'too-recent'));
    assert.ok(fs.existsSync(fresh));
  });

  it('a use during verification keeps the file (retention re-checked under the lock)', async () => {
    const audio = record('F_2026-01-01T00-00-00-000Z.webm', 'f', 40);
    note('F', audio);
    await engine().syncOnce();
    drive.getFileHook = async () => {
      await withAudioReadLease(dataPath, audio, () => {});
    };
    const out = await reclaim({ olderThanDays: 30 });
    assert.equal(out.removed.length, 0);
    assert.equal(out.skipped[0]?.reason, 'too-recent');
    assert.ok(fs.existsSync(audio));
  });

  it('shared audio is removed only when every linked note has a copy', async () => {
    const audio = record('G_2026-01-01T00-00-00-000Z.webm');
    note('G one', audio, new Date('2026-01-01T00:00:00Z'));
    await engine().syncOnce();
    // A second note (e.g. an independent regenerate) links the same recording.
    note('G two', audio, new Date('2026-01-02T00:00:00Z'));
    let out = await reclaim({ paths: [audio] });
    assert.equal(out.skipped[0]?.reason, 'not-backed-up');
    assert.ok(fs.existsSync(audio));

    await engine().syncOnce();
    assert.equal(drive.byName(path.basename(audio)).length, 2, 'one copy per note');
    out = await reclaim({ paths: [audio] });
    assert.equal(out.removed.length, 1);
  });

  it('never uploads or removes an original outside recordings/', async () => {
    const elsewhere = makeTempDir('original');
    try {
      const original = path.join(elsewhere, 'interview.m4a');
      fs.writeFileSync(original, 'original bytes');
      note('Interview', original);
      await engine().syncOnce();
      assert.equal(drive.byName('interview.m4a').length, 0);
      const out = await reclaim({ paths: [original] });
      assert.equal(out.skipped[0]?.reason, 'not-managed');
      assert.ok(fs.existsSync(original));
      assert.equal(buildLocalStorageReport(dataPath).externalFiles, 1);
    } finally {
      rmDir(elsewhere);
    }
  });

  it('recordings without a note are reported and never removed', async () => {
    const lone = record('Lone_2026-01-01T00-00-00-000Z.webm');
    await engine().syncOnce();
    const report = buildLocalStorageReport(dataPath);
    assert.equal(report.unlinkedFiles, 1);
    const out = await reclaim({ paths: [lone] });
    assert.equal(out.skipped[0]?.reason, 'not-linked');
    assert.ok(fs.existsSync(lone));
  });

  it('restores on demand: same path, fresh retention, adopted by the next sync', async () => {
    const audio = record('H_2026-01-01T00-00-00-000Z.webm', 'h', 40);
    const folder = note('H', audio);
    await engine().syncOnce();
    const bytes = fs.readFileSync(audio);
    await reclaim({ paths: [audio] });
    assert.equal(fs.existsSync(audio), false);

    const restored = await restoreLocalAudio({
      dataPath,
      driveClient: drive.asClient(),
      meetingFolder: path.basename(folder),
    });
    assert.equal(restored.path, audio);
    assert.equal(restored.downloaded, true);
    assert.deepEqual(fs.readFileSync(audio), bytes);
    assert.ok(readLocalAudioRecord(dataPath, audio)?.hydratedAt);
    assert.equal(readLocalAudioRecord(dataPath, audio)?.removedAt, undefined);

    // Downloading an old recording restarts its retention clock.
    const auto = await reclaim({ olderThanDays: 30 });
    assert.equal(auto.removed.length, 0);

    const uploads = drive.uploads.length;
    await engine().syncOnce();
    assert.equal(drive.uploads.length, uploads, 'restored bytes are not uploaded again');
    assert.equal(buildLocalStorageReport(dataPath).eligibleFiles, 1);
    const again = await reclaim({ paths: [audio] });
    assert.equal(again.removed.length, 1);
  });

  it('a corrupted download changes nothing', async () => {
    const audio = record('I_2026-01-01T00-00-00-000Z.webm');
    const folder = note('I', audio);
    await engine().syncOnce();
    await reclaim({ paths: [audio] });
    drive.corruptDownload = true;
    await assert.rejects(
      restoreLocalAudio({
        dataPath,
        driveClient: drive.asClient(),
        meetingFolder: path.basename(folder),
      }),
      /did not match/,
    );
    assert.equal(fs.existsSync(audio), false);
    assert.deepEqual(
      fs.readdirSync(recordingsDir).filter((n) => n.startsWith('.restore-')),
      [],
      'temp file cleaned up',
    );
  });

  it('a cancelled download changes nothing', async () => {
    const audio = record('J_2026-01-01T00-00-00-000Z.webm');
    const folder = note('J', audio);
    await engine().syncOnce();
    await reclaim({ paths: [audio] });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      restoreLocalAudio({
        dataPath,
        driveClient: drive.asClient(),
        meetingFolder: path.basename(folder),
        signal: controller.signal,
      }),
    );
    assert.equal(fs.existsSync(audio), false);
  });

  it('restore works after sync-state.json is wiped, by finding the copy in the meeting folder', async () => {
    const audio = record('K_2026-01-01T00-00-00-000Z.webm');
    const folder = note('K', audio);
    await engine().syncOnce();
    await reclaim({ paths: [audio] });
    const s = state();
    const meeting = path.basename(folder);
    s.meetings[meeting].files = {};
    fs.writeFileSync(syncStatePath, JSON.stringify(s));
    const restored = await restoreLocalAudio({
      dataPath,
      driveClient: drive.asClient(),
      meetingFolder: meeting,
    });
    assert.equal(restored.path, audio);
  });

  it('migrated legacy v1 notes back up and free their audio', async () => {
    const audio = record('Legacy_2025-01-01T00-00-00-000Z.webm');
    const v1 = __saveTranscriptionLegacyV1ForTests({
      title: 'Legacy',
      result,
      audioFilePath: audio,
      dataPath,
    });
    assert.equal(await migrateV1ToV2(v1), true);
    await engine().syncOnce();
    assert.equal(drive.byName(path.basename(audio)).length, 1);
    const out = await reclaim({ paths: [audio] });
    assert.equal(out.removed.length, 1);
  });

  describe('notes from another device', () => {
    // Device B: the note arrives through sync with its audio cloud-only and a
    // meta.audioFile path from device A that does not exist here.
    async function remoteNote(title: string, audioName: string, bytes: string, at: Date) {
      const otherData = makeTempDir('device-a');
      try {
        const otherRecordings = path.join(otherData, 'recordings');
        fs.mkdirSync(otherRecordings, { recursive: true });
        const otherAudio = path.join(otherRecordings, audioName);
        fs.writeFileSync(otherAudio, Buffer.from(bytes.repeat(40)));
        saveTranscription({
          title,
          result,
          audioFilePath: otherAudio,
          dataPath: otherData,
          now: at,
        });
        await new SyncEngine({
          driveClient: drive.asClient(),
          transcriptionsDir: path.join(otherData, 'transcriptions'),
          syncStatePath: path.join(otherData, 'sync-state.json'),
          recordingsDir: otherRecordings,
        }).syncOnce();
        return { otherAudio, bytes: fs.readFileSync(otherAudio) };
      } finally {
        rmDir(otherData);
      }
    }

    it('restores under recordings/, links the sidecar, and never overwrites another file', async () => {
      const name = 'Shared_2026-02-01T00-00-00-000Z.webm';
      const { bytes } = await remoteNote(
        'Remote',
        name,
        'remote',
        new Date('2026-02-01T00:00:00Z'),
      );
      // An unrelated local recording already holds the basename.
      const unrelated = record(name, 'local-unrelated');
      const unrelatedBytes = fs.readFileSync(unrelated);
      await engine().syncOnce();
      const meeting = fs
        .readdirSync(path.join(dataPath, 'transcriptions'))
        .find((n) => !n.startsWith('.'))!;
      assert.equal(buildLocalStorageReport(dataPath).cloudOnlyFiles, 1);

      const restored = await restoreLocalAudio({
        dataPath,
        driveClient: drive.asClient(),
        meetingFolder: meeting,
      });
      assert.equal(path.basename(restored.path), 'Shared_2026-02-01T00-00-00-000Z (2).webm');
      assert.deepEqual(fs.readFileSync(restored.path), bytes);
      assert.deepEqual(fs.readFileSync(unrelated), unrelatedBytes, 'existing file untouched');
      const sidecar = JSON.parse(
        fs.readFileSync(
          path.join(dataPath, 'metadata', 'Shared_2026-02-01T00-00-00-000Z (2).json'),
          'utf-8',
        ),
      );
      assert.equal(path.basename(sidecar.transcriptionPath), meeting);
      const metaAudio = JSON.parse(
        fs.readFileSync(path.join(dataPath, 'transcriptions', meeting, 'meta.json'), 'utf-8'),
      ).audioFile;
      assert.equal(resolveNoteAudioPath(dataPath, meeting, metaAudio), restored.path);

      // Next sync: nothing uploaded under the new name; the copy is reclaimable.
      const uploads = drive.uploads.length;
      await engine().syncOnce();
      assert.equal(drive.uploads.length, uploads);
      assert.equal(drive.byName(path.basename(restored.path)).length, 0);
      const out = await reclaim({ paths: [restored.path] });
      assert.equal(out.removed.length, 1);
      assert.ok(fs.existsSync(unrelated));

      // And it can be restored again (adopting the same numbered name).
      const again = await restoreLocalAudio({
        dataPath,
        driveClient: drive.asClient(),
        meetingFolder: meeting,
      });
      assert.equal(again.path, restored.path);
    });

    it('two notes sharing the same audio keep one local copy linked to both', async () => {
      const name = 'Same_2026-03-01T00-00-00-000Z.webm';
      await remoteNote('One', name, 'same', new Date('2026-03-01T00:00:00Z'));
      await remoteNote('Two', name, 'same', new Date('2026-03-02T00:00:00Z'));
      await engine().syncOnce();
      const [a, b] = fs
        .readdirSync(path.join(dataPath, 'transcriptions'))
        .filter((n) => !n.startsWith('.'))
        .sort();
      const ra = await restoreLocalAudio({
        dataPath,
        driveClient: drive.asClient(),
        meetingFolder: a,
      });
      const rb = await restoreLocalAudio({
        dataPath,
        driveClient: drive.asClient(),
        meetingFolder: b,
      });
      assert.equal(rb.path, ra.path);
      assert.deepEqual(readLocalAudioRecord(dataPath, ra.path)?.meetings?.sort(), [a, b]);
      for (const m of [a, b]) {
        const metaAudio = JSON.parse(
          fs.readFileSync(path.join(dataPath, 'transcriptions', m, 'meta.json'), 'utf-8'),
        ).audioFile;
        assert.equal(resolveNoteAudioPath(dataPath, m, metaAudio), ra.path);
      }

      // Each note keeps its own Drive copy, so the shared file can be freed
      // (every copy verified in its own folder), and the next sync changes
      // nothing on Drive.
      const out = await reclaim({ paths: [ra.path] });
      assert.deepEqual(out.skipped, []);
      assert.equal(out.removed.length, 1);
      const uploads = drive.uploads.length;
      const res = await engine().syncOnce();
      assert.deepEqual(res.errors, []);
      assert.equal(drive.uploads.length, uploads);
      assert.deepEqual(drive.trashCalls, []);
      assert.equal(drive.byName(name).length, 2);
    });

    it("a different file at the note's own absolute path is never adopted or uploaded", async () => {
      // Same username and app paths on both devices: the remote note names a
      // path that exists here, holding unrelated audio.
      const name = 'Collide_2026-05-01T00-00-00-000Z.webm';
      const localPath = path.join(recordingsDir, name);
      fs.writeFileSync(localPath, Buffer.from('remote meeting audio'.repeat(30)));
      const otherData = makeTempDir('device-a-same-path');
      try {
        saveTranscription({
          title: 'Remote',
          result,
          audioFilePath: localPath,
          dataPath: otherData,
        });
        await new SyncEngine({
          driveClient: drive.asClient(),
          transcriptionsDir: path.join(otherData, 'transcriptions'),
          syncStatePath: path.join(otherData, 'sync-state.json'),
          recordingsDir,
        }).syncOnce();
      } finally {
        rmDir(otherData);
      }
      const remoteBytes = fs.readFileSync(localPath);
      fs.writeFileSync(localPath, Buffer.from('unrelated local audio'.repeat(30)));
      const unrelated = fs.readFileSync(localPath);

      const res = await engine().syncOnce();
      assert.deepEqual(res.errors, []);
      const [copy] = drive.byName(name);
      assert.deepEqual(copy.content, remoteBytes, 'Drive copy not overwritten by unrelated bytes');
      const meeting = fs
        .readdirSync(path.join(dataPath, 'transcriptions'))
        .find((n) => !n.startsWith('.'))!;

      // Consumers that read bytes refuse the unrelated file.
      assert.equal(await resolveVerifiedNoteAudioPath(dataPath, meeting, localPath), null);
      // It is not this note's backed-up audio, so it is never freed.
      const kept = await reclaim({ paths: [localPath] });
      assert.equal(kept.removed.length, 0);

      const restored = await restoreLocalAudio({
        dataPath,
        driveClient: drive.asClient(),
        meetingFolder: meeting,
      });
      assert.equal(restored.downloaded, true);
      assert.equal(path.basename(restored.path), 'Collide_2026-05-01T00-00-00-000Z (2).webm');
      assert.deepEqual(fs.readFileSync(restored.path), remoteBytes);
      assert.deepEqual(fs.readFileSync(localPath), unrelated, 'unrelated file untouched');
      assert.equal(resolveNoteAudioPath(dataPath, meeting, localPath), restored.path);
      assert.equal(await resolveVerifiedNoteAudioPath(dataPath, meeting, localPath), restored.path);
    });

    it('a collision-safe restored copy stays linked: reported, reclaimable, and the next sync keeps both sides', async () => {
      const name = 'Numbered_2026-05-03T00-00-00-000Z.webm';
      const localPath = path.join(recordingsDir, name);
      fs.writeFileSync(localPath, Buffer.from('remote meeting audio'.repeat(30)));
      const otherData = makeTempDir('device-a-numbered');
      try {
        saveTranscription({
          title: 'Remote',
          result,
          audioFilePath: localPath,
          dataPath: otherData,
        });
        await new SyncEngine({
          driveClient: drive.asClient(),
          transcriptionsDir: path.join(otherData, 'transcriptions'),
          syncStatePath: path.join(otherData, 'sync-state.json'),
          recordingsDir,
        }).syncOnce();
      } finally {
        rmDir(otherData);
      }
      const remoteBytes = fs.readFileSync(localPath);
      fs.writeFileSync(localPath, Buffer.from('unrelated local audio'.repeat(30)));
      const unrelated = fs.readFileSync(localPath);
      await engine().syncOnce();
      const meeting = fs
        .readdirSync(path.join(dataPath, 'transcriptions'))
        .find((n) => !n.startsWith('.'))!;
      const restored = await restoreLocalAudio({
        dataPath,
        driveClient: drive.asClient(),
        meetingFolder: meeting,
      });
      assert.equal(path.basename(restored.path), 'Numbered_2026-05-03T00-00-00-000Z (2).webm');

      // The restored copy belongs to the note; the unrelated file at the
      // note's original path belongs to no note.
      const report = buildLocalStorageReport(dataPath);
      const item = report.items.find((i) => i.path === restored.path);
      assert.equal(item?.status, 'uploaded');
      assert.deepEqual(item?.meetings, [meeting]);
      assert.equal(report.unlinkedFiles, 1, 'the unrelated file is the unlinked one');
      assert.equal(report.eligibleBytes, remoteBytes.length);

      const out = await reclaim({ paths: [restored.path] });
      assert.deepEqual(out.skipped, []);
      assert.equal(out.removed.length, 1);
      assert.equal(fs.existsSync(restored.path), false);
      assert.deepEqual(fs.readFileSync(localPath), unrelated, 'unrelated bytes kept');

      const uploads = drive.uploads.length;
      const res = await engine().syncOnce();
      assert.deepEqual(res.errors, []);
      assert.equal(drive.uploads.length, uploads, 'nothing uploaded');
      assert.deepEqual(drive.trashCalls, []);
      const copies = drive.byName(name);
      assert.equal(copies.length, 1);
      assert.deepEqual(copies[0].content, remoteBytes, 'Drive backup unchanged');
      // The unrelated file is still never treated as removable.
      assert.equal((await reclaim({ paths: [localPath] })).removed.length, 0);
    });

    it('regenerating from a restored copy updates the original note, not a new one', async () => {
      const name = 'Regen_2026-05-04T00-00-00-000Z.webm';
      await remoteNote('Regen', name, 'regen', new Date('2026-05-04T00:00:00Z'));
      await engine().syncOnce();
      const meeting = fs
        .readdirSync(path.join(dataPath, 'transcriptions'))
        .find((n) => !n.startsWith('.'))!;
      const folder = path.join(dataPath, 'transcriptions', meeting);
      const originalAudio = JSON.parse(fs.readFileSync(path.join(folder, 'meta.json'), 'utf-8'))
        .audioFile as string;
      // A merged note references this one by folder name.
      const merged = saveTranscription({
        title: 'Merged',
        result,
        dataPath,
        mergedFrom: [meeting],
        now: new Date('2026-05-05T00:00:00Z'),
      });
      const restored = await restoreLocalAudio({
        dataPath,
        driveClient: drive.asClient(),
        meetingFolder: meeting,
      });
      assert.notEqual(restored.path, originalAudio);

      const saved = saveRegeneratedTranscription({
        title: 'Regen v2',
        result: { ...result, summary: 'Regenerated summary.' },
        audioFilePath: restored.path,
        dataPath,
        previousFolderPath: folder,
      });
      assert.equal(saved, folder, 'the linked note was replaced in place');
      assert.equal(
        fs.readFileSync(path.join(folder, 'summary.md'), 'utf-8').trim(),
        'Regenerated summary.',
      );
      const meta = JSON.parse(fs.readFileSync(path.join(folder, 'meta.json'), 'utf-8'));
      assert.equal(meta.audioFile, originalAudio, 'source-audio identity kept for sync');
      const notes = fs
        .readdirSync(path.join(dataPath, 'transcriptions'))
        .filter((n) => !n.startsWith('.'));
      assert.equal(notes.length, 2, 'no duplicate note');
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(merged, 'meta.json'), 'utf-8')).merge?.sourceIds,
        [meeting],
      );

      // The next sync uploads nothing new (no audio under the local name).
      const uploadsBefore = drive.uploads.filter((u) => u.name.endsWith('.webm')).length;
      await engine().syncOnce();
      assert.equal(drive.uploads.filter((u) => u.name.endsWith('.webm')).length, uploadsBefore);
      assert.equal(drive.byName(name).length, 1, 'still one Drive copy of the audio');

      // Unrelated audio, or the restored copy after its bytes changed, never
      // replaces the note.
      const other = path.join(recordingsDir, 'Other_2026-05-06T00-00-00-000Z.webm');
      fs.writeFileSync(other, 'other recording');
      const fromOther = saveRegeneratedTranscription({
        title: 'Other',
        result,
        audioFilePath: other,
        dataPath,
        previousFolderPath: folder,
      });
      assert.notEqual(fromOther, folder);
      fs.appendFileSync(restored.path, 'edited');
      const fromEdited = saveRegeneratedTranscription({
        title: 'Edited',
        result,
        audioFilePath: restored.path,
        dataPath,
        previousFolderPath: folder,
      });
      assert.notEqual(fromEdited, folder);
      assert.equal(
        fs.readFileSync(path.join(folder, 'summary.md'), 'utf-8').trim(),
        'Regenerated summary.',
      );
    });

    it("a matching file at the note's own path is adopted without downloading", async () => {
      const name = 'Match_2026-05-02T00-00-00-000Z.webm';
      const localPath = path.join(recordingsDir, name);
      fs.writeFileSync(localPath, Buffer.from('same meeting audio'.repeat(30)));
      const otherData = makeTempDir('device-a-match');
      try {
        saveTranscription({
          title: 'Match',
          result,
          audioFilePath: localPath,
          dataPath: otherData,
        });
        await new SyncEngine({
          driveClient: drive.asClient(),
          transcriptionsDir: path.join(otherData, 'transcriptions'),
          syncStatePath: path.join(otherData, 'sync-state.json'),
          recordingsDir,
        }).syncOnce();
      } finally {
        rmDir(otherData);
      }
      await engine().syncOnce();
      const meeting = fs
        .readdirSync(path.join(dataPath, 'transcriptions'))
        .find((n) => !n.startsWith('.'))!;
      const restored = await restoreLocalAudio({
        dataPath,
        driveClient: drive.asClient(),
        meetingFolder: meeting,
      });
      assert.equal(restored.downloaded, false);
      assert.equal(restored.path, localPath);
    });

    it('concurrent restores of different audio with the same name get distinct files', async () => {
      const name = 'Clash_2026-04-01T00-00-00-000Z.webm';
      const x = await remoteNote('X', name, 'xxxx', new Date('2026-04-01T00:00:00Z'));
      const y = await remoteNote('Y', name, 'yyyy', new Date('2026-04-02T00:00:00Z'));
      await engine().syncOnce();
      const [mx, my] = fs
        .readdirSync(path.join(dataPath, 'transcriptions'))
        .filter((n) => !n.startsWith('.'))
        .sort();
      const [rx, ry] = await Promise.all([
        restoreLocalAudio({ dataPath, driveClient: drive.asClient(), meetingFolder: mx }),
        restoreLocalAudio({ dataPath, driveClient: drive.asClient(), meetingFolder: my }),
      ]);
      assert.notEqual(rx.path, ry.path);
      assert.deepEqual(fs.readFileSync(rx.path), x.bytes);
      assert.deepEqual(fs.readFileSync(ry.path), y.bytes);
      assert.equal(readLocalAudioRecord(dataPath, rx.path)?.md5Checksum, md5(x.bytes));
      assert.equal(readLocalAudioRecord(dataPath, ry.path)?.md5Checksum, md5(y.bytes));
    });
  });

  it('reports exact category totals and counts shared audio once', async () => {
    const shared = record('Shared_2026-01-01T00-00-00-000Z.webm', 'x'.repeat(10)); // 500 bytes
    record('Lone_2026-01-02T00-00-00-000Z.webm', 'y'.repeat(4)); // 200 bytes, no note
    note('One', shared, new Date('2026-01-01T00:00:00Z'));
    note('Two', shared, new Date('2026-01-02T00:00:00Z'));
    await engine().syncOnce();
    fs.writeFileSync(path.join(dataPath, 'other.bin'), Buffer.alloc(1000));

    const sizeOfTree = (dir: string): number =>
      fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => {
        const p = path.join(dir, e.name);
        return n + (e.isDirectory() ? sizeOfTree(p) : e.isFile() ? fs.statSync(p).size : 0);
      }, 0);
    const report = buildLocalStorageReport(dataPath);
    assert.equal(report.audioBytes, 700);
    assert.equal(report.audioFiles, 2);
    assert.equal(report.eligibleBytes, 500, 'shared recording counted once');
    assert.equal(report.eligibleFiles, 1);
    assert.equal(report.unlinkedBytes, 200);
    assert.equal(report.unlinkedFiles, 1);
    assert.equal(report.notesBytes, sizeOfTree(path.join(dataPath, 'transcriptions')));
    assert.equal(report.totalBytes, sizeOfTree(dataPath));
    assert.equal(report.otherBytes, report.totalBytes - report.audioBytes - report.notesBytes);
    assert.ok(report.otherBytes >= 1000);
    assert.equal(report.items.find((i) => i.status === 'uploaded')?.meetings.length, 2);
  });

  it('a read lease held by another process blocks removal until it ends', async () => {
    const audio = record('Child_2026-01-01T00-00-00-000Z.webm');
    note('Child', audio);
    await engine().syncOnce();
    const { spawn } = await import('node:child_process');
    const script = `
      const { withAudioReadLease } = require(${JSON.stringify(path.join(__dirname, 'localAudioStorage.js'))});
      withAudioReadLease(process.argv[1], process.argv[2], () => new Promise((resolve) => {
        process.stdout.write('leased\\n');
        process.stdin.once('data', resolve);
      })).then(() => process.exit(0));
    `;
    const child = spawn(process.execPath, ['-e', script, dataPath, audio], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    await new Promise<void>((resolve) => child.stdout!.once('data', () => resolve()));
    try {
      const blocked = await reclaim({ paths: [audio] });
      assert.equal(blocked.skipped[0]?.reason, 'in-use');
      assert.ok(fs.existsSync(audio));
    } finally {
      child.stdin!.write('done\n');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    const after = await reclaim({ paths: [audio] });
    assert.equal(after.removed.length, 1);
  });

  it('cleans only stale restore temp files', () => {
    const stale = path.join(recordingsDir, '.restore-old.part');
    const live = path.join(recordingsDir, '.restore-new.part');
    fs.writeFileSync(stale, 'x');
    fs.writeFileSync(live, 'y');
    const t = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(stale, t, t);
    cleanupRestoreTemps(dataPath);
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(live), true);
  });
});

describe('Google session binding', () => {
  it('a sync started under one account stops after sign-out or a switch', () => {
    let creds: { email?: string; refresh: string } | null = { email: 'a@x', refresh: 'ra' };
    const tracker = new GoogleSessionTracker(() => creds);
    const session = tracker.capture();
    assert.ok(tracker.isCurrent(session));
    creds = null;
    tracker.bump();
    assert.equal(tracker.isCurrent(session), false);
    creds = { email: 'b@x', refresh: 'rb' };
    tracker.bump();
    assert.equal(tracker.isCurrent(session), false);
  });

  it('switching away and back still invalidates the old session', () => {
    let creds: { email?: string; refresh: string } | null = { email: 'a@x', refresh: 'ra' };
    const tracker = new GoogleSessionTracker(() => creds);
    const session = tracker.capture();
    creds = { email: 'b@x', refresh: 'rb' };
    tracker.bump();
    creds = { email: 'a@x', refresh: 'ra2' };
    tracker.bump();
    assert.equal(tracker.isCurrent(session), false);
  });

  it('another process changing the account invalidates the session', () => {
    let creds: { email?: string; refresh: string } | null = { email: 'a@x', refresh: 'ra' };
    const tracker = new GoogleSessionTracker(() => creds);
    const session = tracker.capture();
    creds = { email: 'b@x', refresh: 'rb' };
    assert.equal(tracker.isCurrent(session), false);
  });

  it('a delayed token refresh is not persisted after a switch', async () => {
    let creds: { email?: string; refresh: string } | null = { email: 'a@x', refresh: 'ra' };
    const tracker = new GoogleSessionTracker(() => creds);
    const session = tracker.capture();
    const writes: unknown[] = [];
    creds = { email: 'b@x', refresh: 'rb' };
    tracker.bump();
    const write = (v: unknown) => {
      writes.push(v);
    };
    assert.equal(
      await tracker.persistRefreshed(session, { email: 'a@x', refresh: 'ra' }, write),
      false,
    );
    assert.deepEqual(writes, []);
    const current = tracker.capture();
    assert.equal(
      await tracker.persistRefreshed(current, { email: 'b@x', refresh: 'rb2' }, write),
      true,
    );
  });

  it('sees a sign-out or switch made by another process through config.json', async () => {
    const { ConfigService } = await import('../configService');
    const dataPath = makeTempDir('session-crossprocess');
    try {
      const app = new ConfigService(dataPath);
      app.setGoogleOAuth({ email: 'a@x', refresh: 'ra', access: 'x', expires: Date.now() + 1e6 });
      const tracker = new GoogleSessionTracker(() => app.readPersistedGoogleOAuth());
      const session = tracker.capture();
      assert.ok(tracker.isCurrent(session));

      const cli = new ConfigService(dataPath);
      cli.setGoogleOAuth({
        email: 'a@x',
        refresh: 'ra-new',
        access: 'y',
        expires: Date.now() + 1e6,
      });
      assert.ok(tracker.isCurrent(session), 'same account re-signed in elsewhere stays valid');

      cli.setGoogleOAuth({ email: 'b@x', refresh: 'rb', access: 'z', expires: Date.now() + 1e6 });
      assert.equal(tracker.isCurrent(session), false, 'switch in another process');
      // The app's cached view still shows account A.
      assert.equal(app.getGoogleOAuth()?.email, 'a@x');

      cli.clearGoogleOAuth();
      assert.equal(tracker.isCurrent(session), false, 'sign-out in another process');
    } finally {
      rmDir(dataPath);
    }
  });

  it('a refresh is never persisted over a signed-out or env-only sign-in', async () => {
    const { ConfigService } = await import('../configService');
    const dataPath = makeTempDir('session-refresh');
    try {
      const app = new ConfigService(dataPath);
      app.setGoogleOAuth({ email: 'a@x', refresh: 'ra', access: 'x', expires: Date.now() });
      // Built exactly as the app and CLI build it.
      const tracker = new GoogleSessionTracker(
        () => app.readPersistedGoogleOAuth(),
        () => app.readPersistedStoredGoogleOAuth(),
      );
      const snap = tracker.snapshot()!;
      assert.equal(snap.credentials.refresh, 'ra');
      assert.equal(snap.session.accountKey, 'a@x');

      // Another process signs out while this one's refresh is in flight.
      new ConfigService(dataPath).clearGoogleOAuth();
      const wrote = await tracker.persistRefreshed(
        snap.session,
        { email: 'a@x', refresh: 'ra' },
        (v) => app.setGoogleOAuth(v as never),
      );
      assert.equal(wrote, false);
      assert.equal(new ConfigService(dataPath).hasStoredGoogleOAuth(), false, 'not resurrected');
      assert.equal(tracker.snapshot(), null, 'a new operation sees the sign-out before starting');
    } finally {
      rmDir(dataPath);
    }
  });

  it('automatic removal driven by a stale session removes nothing', async () => {
    const dataPath = makeTempDir('session-reclaim');
    try {
      const recordingsDir = path.join(dataPath, 'recordings');
      fs.mkdirSync(recordingsDir, { recursive: true });
      const audio = path.join(recordingsDir, 'S_2026-01-01T00-00-00-000Z.webm');
      fs.writeFileSync(audio, 'session audio'.repeat(20));
      saveTranscription({ title: 'S', result, audioFilePath: audio, dataPath });
      const drive = new FakeDrive();
      await new SyncEngine({
        driveClient: drive.asClient(),
        transcriptionsDir: path.join(dataPath, 'transcriptions'),
        syncStatePath: path.join(dataPath, 'sync-state.json'),
        recordingsDir,
      }).syncOnce();
      let creds: { email?: string; refresh: string } | null = { email: 'a@x', refresh: 'ra' };
      const tracker = new GoogleSessionTracker(() => creds);
      const session = tracker.capture();
      // The user signs out while Drive verification is in flight.
      drive.getFileHook = () => {
        creds = null;
        tracker.bump();
      };
      const out = await reclaimLocalAudio({
        dataPath,
        driveClient: drive.asClient(),
        shouldContinue: () => tracker.isCurrent(session),
      });
      assert.equal(out.removed.length, 0);
      assert.ok(fs.existsSync(audio));
    } finally {
      rmDir(dataPath);
    }
  });
});
