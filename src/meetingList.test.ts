import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeTempDir, rmDir } from './test-helpers';
import {
  __saveTranscriptionLegacyV1ForTests,
  autoMigrateLegacyOnStartup,
  readTranscription,
  listTranscriptions,
  saveTranscription,
} from './outputService';
import { unlinkedNotes, syncChangedLocalNotes } from './meetingList';

test('only sidecar-linked notes deduplicate while independent saved reports remain reachable', async () => {
  const dir = makeTempDir('meeting-list');
  try {
    const audio = path.join(dir, 'local.wav');
    fs.writeFileSync(audio, 'audio');
    const save = (title: string, audioFilePath: string) =>
      saveTranscription({
        title,
        audioFilePath,
        dataPath: dir,
        result: {
          emoji: '',
          transcript: 'Speech',
          summary: 'Summary',
          keyPoints: [],
          actionItems: [],
        },
      });
    const local = save('Local', audio);
    const independent = save('Old duplicate', audio);
    const remote = save('Remote', '/missing-other-device/remote.wav');
    const notes = await listTranscriptions(dir, 0);
    const rows = await unlinkedNotes({
      notes,
      recordings: [{ path: audio }],
      sidecarFor: async () => null,
    });
    assert.deepEqual(rows.map((row) => row.folderPath).sort(), [remote, independent, local].sort());
    assert.equal(rows.find((row) => row.folderPath === remote)?.audioAvailable, false);
    const stale = await unlinkedNotes({
      notes,
      recordings: [{ path: audio }],
      sidecarFor: async () => ({ transcriptionPath: path.join(dir, 'deleted-note') }),
    });
    assert.equal(stale.length, 3);
    const malformed = await unlinkedNotes({
      notes,
      recordings: [{ path: audio }],
      sidecarFor: async () => ({ transcriptionPath: 42 }),
    });
    assert.equal(malformed.length, 3);
    const link = path.join(dir, 'alias');
    fs.symlinkSync(dir, link);
    assert.equal(
      (
        await unlinkedNotes({
          notes,
          recordings: [{ path: path.join(link, 'local.wav') }],
          sidecarFor: async () => null,
        })
      ).length,
      3,
    );
    assert.equal(
      (
        await unlinkedNotes({
          notes,
          recordings: [{ path: '/different.wav' }],
          sidecarFor: async () => ({ transcriptionPath: local }),
        })
      ).some((row) => row.folderPath === local),
      false,
    );
  } finally {
    rmDir(dir);
  }
});

test('only local sync changes require a list refresh, including partially successful cycles', () => {
  const empty = { downloaded: [], deleted: [], conflicts: [] };
  assert.equal(syncChangedLocalNotes(empty), false);
  for (const key of ['downloaded', 'deleted', 'conflicts']) {
    assert.equal(syncChangedLocalNotes({ ...empty, [key]: ['meeting'] }), true);
  }
});

test('metadata-only listing tolerates missing transcripts and malformed audio metadata', async () => {
  const dir = makeTempDir('meeting-list-legacy');
  try {
    const root = path.join(dir, 'transcriptions');
    const folderName = 'Legacy_20261023_120000';
    const folder = path.join(root, folderName);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, 'meta.json'),
      JSON.stringify({ title: 'Legacy', audioFile: 42 }),
    );
    fs.mkdirSync(path.join(root, '.listener-partial', 'Incomplete'), { recursive: true });
    fs.mkdirSync(path.join(root, 'WithoutMeta'));
    const notes = await listTranscriptions(dir, 0);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].audioFile, undefined);
    assert.equal(notes[0].transcribedAt, '2026-10-23T12:00:00');
    const rows = await unlinkedNotes({
      notes,
      recordings: [{ path: '/old-inline.wav' }],
      sidecarFor: async () => null,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].audioAvailable, false);
  } finally {
    rmDir(dir);
  }
});

test('real legacy reports remain listable and readable after startup migration', async () => {
  const dir = makeTempDir('meeting-list-v1');
  try {
    __saveTranscriptionLegacyV1ForTests({
      title: 'Legacy report',
      dataPath: dir,
      result: {
        emoji: '',
        transcript: 'Legacy speech',
        summary: 'Legacy summary',
        keyPoints: [],
        actionItems: [],
      },
    });
    await autoMigrateLegacyOnStartup(dir);
    const notes = await listTranscriptions(dir, 0);
    const rows = await unlinkedNotes({ notes, recordings: [], sidecarFor: async () => null });
    assert.equal(rows.length, 1);
    const report = await readTranscription(rows[0].folderPath);
    assert.ok(report?.transcript.includes('Legacy speech'));
    assert.ok(report?.summary.includes('Legacy summary'));
  } finally {
    rmDir(dir);
  }
});
