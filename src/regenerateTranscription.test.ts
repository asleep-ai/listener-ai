import { spawnSync } from 'child_process';
import * as fs from 'fs';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import * as path from 'path';
import type { TranscriptionResult } from './geminiService';
import { withMeetingLock } from './meetingLock';
import {
  HIGHLIGHTS_JSON_FILE,
  KEY_POINTS_FILE,
  META_JSON,
  getTranscriptionsDir,
  listTranscriptions,
  readTranscription,
  saveTranscription,
} from './outputService';
import {
  recoverInterruptedRegenerations,
  saveRegeneratedTranscription,
} from './regenerateTranscription';
import { makeTempDir, rmDir } from './test-helpers';

const tmpDirs: string[] = [];
function makeDataPath(): string {
  const dir = makeTempDir('regenerate');
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) rmDir(dir);
});

const oldResult: TranscriptionResult = {
  transcript: 'Speaker A: old transcript.',
  summary: 'Old summary.',
  keyPoints: ['old point'],
  actionItems: ['old action'],
  emoji: '📝',
  suggestedTitle: 'Old Title',
  highlights: [{ offsetMs: 1000, userText: 'old highlight' }],
} as TranscriptionResult;

const newResult: TranscriptionResult = {
  transcript: 'Speaker A: new transcript.',
  summary: 'New summary.',
  keyPoints: [],
  actionItems: ['new action'],
  emoji: '🎯',
  suggestedTitle: 'New Title',
} as TranscriptionResult;

function listNoteFolders(dataPath: string): string[] {
  return fs.readdirSync(getTranscriptionsDir(dataPath)).sort();
}

function snapshot(folderPath: string): Map<string, string> {
  return new Map(
    fs
      .readdirSync(folderPath)
      .sort()
      .map((n) => [n, fs.readFileSync(path.join(folderPath, n), 'utf-8')]),
  );
}

function scratchDirs(dataPath: string): string[] {
  return fs.readdirSync(dataPath).filter((n) => n.startsWith('.regenerate'));
}

describe('saveRegeneratedTranscription', () => {
  it('replaces the previous note in place and keeps the folder name', async () => {
    const dataPath = makeDataPath();
    const audio = path.join(dataPath, 'recordings', 'meeting.webm');
    const previous = saveTranscription({
      title: 'Old Title',
      result: oldResult,
      audioFilePath: audio,
      dataPath,
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    const saved = saveRegeneratedTranscription({
      title: 'New Title',
      result: newResult,
      audioFilePath: audio,
      dataPath,
      previousFolderPath: previous,
      now: new Date('2026-02-02T00:00:00.000Z'),
    });

    assert.equal(saved, previous, 'folder identity must be stable for Drive sync');
    assert.deepEqual(listNoteFolders(dataPath), [path.basename(previous)]);

    const read = await readTranscription(saved);
    assert.ok(read);
    assert.equal(read.title, 'New Title');
    assert.equal(read.summary, 'New summary.');
    assert.equal(read.transcript, 'Speaker A: new transcript.');
    assert.deepEqual(read.actionItems, ['new action']);
    assert.equal(read.keyPoints, undefined);
    assert.equal(read.highlights, undefined);
    assert.equal(read.emoji, '🎯');
    assert.equal(read.transcribedAt, '2026-02-02T00:00:00.000Z');
    assert.equal(read.audioFilePath, audio);

    const all = await listTranscriptions(dataPath, 0);
    assert.equal(all.length, 1, 'exactly one note must be listed after regenerate');

    // Scratch area is cleaned up after a successful swap.
    assert.deepEqual(
      fs.readdirSync(dataPath).filter((n) => n.startsWith('.regenerate')),
      [],
    );
  });

  it('leaves dropped optional files as empty placeholders so Drive sync cannot resurrect them', () => {
    const dataPath = makeDataPath();
    const previous = saveTranscription({ title: 'Old Title', result: oldResult, dataPath });
    assert.ok(fs.existsSync(path.join(previous, KEY_POINTS_FILE)));
    assert.ok(fs.existsSync(path.join(previous, HIGHLIGHTS_JSON_FILE)));

    saveRegeneratedTranscription({
      title: 'New Title',
      result: newResult,
      dataPath,
      previousFolderPath: previous,
    });

    // A locally-missing file that still exists on Drive is downloaded again by
    // the sync engine, so a dropped file is truncated rather than removed.
    assert.equal(fs.readFileSync(path.join(previous, KEY_POINTS_FILE), 'utf-8'), '');
    assert.equal(fs.readFileSync(path.join(previous, HIGHLIGHTS_JSON_FILE), 'utf-8'), '');
  });

  it('preserves unknown metadata while clearing exports tied to the old content', () => {
    const dataPath = makeDataPath();
    const previous = saveTranscription({ title: 'Old Title', result: oldResult, dataPath });
    const metaPath = path.join(previous, META_JSON);
    const oldMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    oldMeta.futureField = { retained: true };
    oldMeta.exports = { notion: { pageUrl: 'https://example.test/old-note' } };
    oldMeta.customFields = { oldTranscriptTag: true };
    fs.writeFileSync(metaPath, `${JSON.stringify(oldMeta, null, 2)}\n`);

    saveRegeneratedTranscription({
      title: 'New Title',
      result: newResult,
      dataPath,
      previousFolderPath: previous,
    });

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    assert.deepEqual(meta.futureField, { retained: true });
    assert.equal(meta.exports, undefined, 'old export status does not describe the new content');
    assert.equal(
      meta.customFields,
      undefined,
      'old transcript fields do not describe the new content',
    );
    assert.equal(meta.title, 'New Title');
  });

  it('keeps an unrelated note when a stale sidecar points to it', async () => {
    const dataPath = makeDataPath();
    const oldAudio = path.join(dataPath, 'recordings', 'old.webm');
    const selectedAudio = path.join(dataPath, 'recordings', 'selected.webm');
    const previous = saveTranscription({
      title: 'Old Title',
      result: oldResult,
      dataPath,
      audioFilePath: oldAudio,
    });
    const before = snapshot(previous);

    const saved = saveRegeneratedTranscription({
      title: 'New Title',
      result: newResult,
      dataPath,
      audioFilePath: selectedAudio,
      previousFolderPath: previous,
    });

    assert.notEqual(saved, previous);
    assert.deepEqual(snapshot(previous), before);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(saved, META_JSON), 'utf-8')).audioFile,
      selectedAudio,
    );
  });

  it('carries merge provenance forward', async () => {
    const dataPath = makeDataPath();
    const previous = saveTranscription({
      title: 'Merged',
      result: oldResult,
      dataPath,
      mergedFrom: ['a_folder', 'b_folder'],
    });

    saveRegeneratedTranscription({
      title: 'Merged again',
      result: newResult,
      dataPath,
      previousFolderPath: previous,
    });

    const read = await readTranscription(previous);
    assert.deepEqual(read?.mergedFrom, ['a_folder', 'b_folder']);
  });

  it('keeps the previous note intact and rolls back when the swap fails midway', async () => {
    const dataPath = makeDataPath();
    const previous = saveTranscription({ title: 'Old Title', result: oldResult, dataPath });
    const before = new Map(
      fs.readdirSync(previous).map((n) => [n, fs.readFileSync(path.join(previous, n), 'utf-8')]),
    );

    let swapped = 0;
    assert.throws(
      () =>
        saveRegeneratedTranscription({
          title: 'New Title',
          result: newResult,
          dataPath,
          previousFolderPath: previous,
          onFileSwapped: () => {
            swapped++;
            if (swapped === 2) throw new Error('simulated swap failure');
          },
        }),
      /simulated swap failure/,
    );

    const after = new Map(
      fs.readdirSync(previous).map((n) => [n, fs.readFileSync(path.join(previous, n), 'utf-8')]),
    );
    assert.deepEqual(after, before, 'previous note must be byte-identical after a failed swap');
    const read = await readTranscription(previous);
    assert.equal(read?.summary, 'Old summary.');
    assert.deepEqual(listNoteFolders(dataPath), [path.basename(previous)]);
    assert.deepEqual(
      fs.readdirSync(dataPath).filter((n) => n.startsWith('.regenerate')),
      [],
    );
  });

  it('creates a new note when there is no previous folder to replace', () => {
    const dataPath = makeDataPath();
    const saved = saveRegeneratedTranscription({ title: 'First', result: newResult, dataPath });
    assert.ok(fs.existsSync(path.join(saved, META_JSON)));
    assert.deepEqual(listNoteFolders(dataPath), [path.basename(saved)]);
  });

  it('creates a new note and leaves the old path alone when it is missing, legacy, or outside the store', () => {
    const dataPath = makeDataPath();

    // Missing: sidecar points at a folder that was deleted out from under it.
    const missing = path.join(getTranscriptionsDir(dataPath), 'gone');
    const a = saveRegeneratedTranscription({
      title: 'A',
      result: newResult,
      dataPath,
      previousFolderPath: missing,
      now: new Date('2026-03-01T00:00:00.000Z'),
    });
    assert.notEqual(a, missing);
    assert.ok(!fs.existsSync(missing));

    // No meta.json: not a v2 note, never overwrite it.
    const legacy = path.join(getTranscriptionsDir(dataPath), 'legacy_folder');
    fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, 'summary.md'), 'keep me');
    const b = saveRegeneratedTranscription({
      title: 'B',
      result: newResult,
      dataPath,
      previousFolderPath: legacy,
      now: new Date('2026-03-02T00:00:00.000Z'),
    });
    assert.notEqual(b, legacy);
    assert.equal(fs.readFileSync(path.join(legacy, 'summary.md'), 'utf-8'), 'keep me');

    // Outside transcriptions/: e.g. a stale sidecar from another data path.
    const otherData = makeDataPath();
    const outside = saveTranscription({
      title: 'Elsewhere',
      result: oldResult,
      dataPath: otherData,
    });
    const c = saveRegeneratedTranscription({
      title: 'C',
      result: newResult,
      dataPath,
      previousFolderPath: outside,
      now: new Date('2026-03-03T00:00:00.000Z'),
    });
    assert.notEqual(c, outside);
    assert.equal(fs.readFileSync(path.join(outside, 'summary.md'), 'utf-8').trim(), 'Old summary.');
  });

  it('falls back to a new note for a symlinked folder or an unsupported meta.json', () => {
    const dataPath = makeDataPath();
    const transcriptionsDir = getTranscriptionsDir(dataPath);

    const otherData = makeDataPath();
    const outside = saveTranscription({ title: 'Outside', result: oldResult, dataPath: otherData });
    const link = path.join(transcriptionsDir, 'linked_note');
    fs.mkdirSync(transcriptionsDir, { recursive: true });
    fs.symlinkSync(outside, link);
    const beforeOutside = snapshot(outside);
    const a = saveRegeneratedTranscription({
      title: 'A',
      result: newResult,
      dataPath,
      previousFolderPath: link,
      now: new Date('2026-04-01T00:00:00.000Z'),
    });
    assert.notEqual(a, link);
    assert.deepEqual(snapshot(outside), beforeOutside);

    // A symlink to another note inside the store is not replaced either.
    const sibling = saveTranscription({
      title: 'Sibling',
      result: oldResult,
      dataPath,
      now: new Date('2026-04-01T12:00:00.000Z'),
    });
    const siblingLink = path.join(transcriptionsDir, 'sibling_link');
    fs.symlinkSync(sibling, siblingLink);
    const beforeSibling = snapshot(sibling);
    saveRegeneratedTranscription({
      title: 'A2',
      result: newResult,
      dataPath,
      previousFolderPath: siblingLink,
      now: new Date('2026-04-01T13:00:00.000Z'),
    });
    assert.deepEqual(snapshot(sibling), beforeSibling);

    const future = path.join(transcriptionsDir, 'future_note');
    fs.mkdirSync(future);
    fs.writeFileSync(path.join(future, META_JSON), JSON.stringify({ schemaVersion: 99 }));
    const b = saveRegeneratedTranscription({
      title: 'B',
      result: newResult,
      dataPath,
      previousFolderPath: future,
      now: new Date('2026-04-02T00:00:00.000Z'),
    });
    assert.notEqual(b, future);
    assert.deepEqual([...snapshot(future).keys()], [META_JSON]);
  });
});

describe('recoverInterruptedRegenerations', () => {
  it('waits for readers and lets only one process restore an interrupted swap', async () => {
    const dataPath = makeDataPath();
    const previous = saveTranscription({ title: 'Old Title', result: oldResult, dataPath });
    const before = snapshot(previous);
    const scratch = path.join(dataPath, '.regenerate-overlapping-recovery');
    fs.mkdirSync(path.join(scratch, 'new'), { recursive: true });
    fs.cpSync(previous, path.join(scratch, 'backup'), { recursive: true });
    fs.writeFileSync(path.join(scratch, 'new', META_JSON), '{}');
    fs.writeFileSync(
      path.join(scratch, 'swap.json'),
      JSON.stringify({ pid: 2147483647, target: previous, staged: 'new' }),
    );
    fs.writeFileSync(path.join(previous, 'summary.md'), 'Partially swapped summary.');

    let releaseReader!: () => void;
    let signalReader!: () => void;
    const readerReady = new Promise<void>((resolve) => {
      signalReader = resolve;
    });
    const reader = withMeetingLock(
      previous,
      () =>
        new Promise<void>((resolve) => {
          releaseReader = resolve;
          signalReader();
        }),
    );
    await readerReady;
    try {
      const first = recoverInterruptedRegenerations(dataPath, { strict: true });
      const second = recoverInterruptedRegenerations(dataPath, { strict: true });
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      assert.equal(
        fs.readFileSync(path.join(previous, 'summary.md'), 'utf-8'),
        'Partially swapped summary.',
      );
      releaseReader();
      const results = await Promise.all([first, second]);
      assert.deepEqual(results.flat(), [previous]);
      assert.deepEqual(snapshot(previous), before);
      assert.equal(fs.existsSync(scratch), false);
    } finally {
      releaseReader();
      await reader;
    }
  });

  it('blocks a strict reader while another process owns a live regeneration', async () => {
    const dataPath = makeDataPath();
    const scratch = path.join(dataPath, '.regenerate-live-writer');
    fs.mkdirSync(scratch);
    fs.writeFileSync(path.join(scratch, 'swap.json'), JSON.stringify({ pid: process.ppid }));

    await assert.rejects(
      recoverInterruptedRegenerations(dataPath, { strict: true }),
      /Meeting regeneration is in progress/,
    );
    assert.ok(fs.existsSync(scratch));
  });

  it('preserves an unrecognized directory with the scratch prefix', async () => {
    const dataPath = makeDataPath();
    const unknown = path.join(dataPath, '.regenerate-user-data');
    fs.mkdirSync(unknown);
    fs.writeFileSync(path.join(unknown, 'keep.txt'), 'keep');

    assert.deepEqual(await recoverInterruptedRegenerations(dataPath), []);
    assert.equal(fs.readFileSync(path.join(unknown, 'keep.txt'), 'utf-8'), 'keep');
  });

  it('fails a CLI read without deleting data when an interrupted swap has no backup', () => {
    const dataPath = makeDataPath();
    const previous = saveTranscription({ title: 'Old Title', result: oldResult, dataPath });
    const scratch = path.join(dataPath, '.regenerate-missing-backup');
    fs.mkdirSync(path.join(scratch, 'new'), { recursive: true });
    fs.writeFileSync(path.join(scratch, 'new', META_JSON), '{}');
    fs.writeFileSync(
      path.join(scratch, 'swap.json'),
      JSON.stringify({ pid: 2147483647, target: previous, staged: 'new' }),
    );
    fs.writeFileSync(path.join(previous, 'summary.md'), 'Partially swapped summary.');

    const cli = spawnSync(
      process.execPath,
      [require.resolve('./cli'), 'show', path.basename(previous)],
      {
        encoding: 'utf-8',
        env: { ...process.env, NODE_ENV: 'test', LISTENER_DATA_PATH: dataPath },
      },
    );
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /Regeneration backup is missing meta.json/);
    assert.equal(cli.stdout, '');
    assert.ok(fs.existsSync(scratch), 'keep the scratch files for manual recovery');
    assert.equal(
      fs.readFileSync(path.join(previous, 'summary.md'), 'utf-8'),
      'Partially swapped summary.',
    );
  });

  it('restores the previous note when the process died mid-swap', async () => {
    const dataPath = makeDataPath();
    const previous = saveTranscription({ title: 'Old Title', result: oldResult, dataPath });
    const before = snapshot(previous);

    // Run the regenerate in a child that exits hard after the second file
    // lands: no catch, no finally, just like a crash or force quit.
    const script = `
      const { saveRegeneratedTranscription } = require(${JSON.stringify(require.resolve('./regenerateTranscription'))});
      let n = 0;
      saveRegeneratedTranscription({
        title: 'New Title',
        result: ${JSON.stringify(newResult)},
        dataPath: ${JSON.stringify(dataPath)},
        previousFolderPath: ${JSON.stringify(previous)},
        onFileSwapped: () => { if (++n === 2) process.exit(7); },
      });
    `;
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf-8' });
    assert.equal(child.status, 7, child.stderr);

    // The crash left a mix of old and new files behind the old meta.json.
    assert.equal(
      fs.readFileSync(path.join(previous, 'summary.md'), 'utf-8').trim(),
      'New summary.',
    );
    assert.equal(scratchDirs(dataPath).length, 1);

    // The CLI can be the first process to read this note after the GUI crash.
    const cli = spawnSync(
      process.execPath,
      [require.resolve('./cli'), 'show', path.basename(previous)],
      {
        encoding: 'utf-8',
        env: { ...process.env, NODE_ENV: 'test', LISTENER_DATA_PATH: dataPath },
      },
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /Old summary\./);
    assert.doesNotMatch(cli.stdout, /New summary\./);
    assert.match(cli.stderr, /Recovered interrupted regeneration/);

    assert.deepEqual(await recoverInterruptedRegenerations(dataPath), []);
    assert.deepEqual(snapshot(previous), before);
    assert.equal((await readTranscription(previous))?.summary, 'Old summary.');
    assert.deepEqual(scratchDirs(dataPath), []);
  });

  it('removes leftovers from a swap that already finished without touching the note', async () => {
    const dataPath = makeDataPath();
    const previous = saveTranscription({ title: 'Old Title', result: oldResult, dataPath });
    const script = `
      const { saveRegeneratedTranscription } = require(${JSON.stringify(require.resolve('./regenerateTranscription'))});
      saveRegeneratedTranscription({
        title: 'New Title',
        result: ${JSON.stringify(newResult)},
        dataPath: ${JSON.stringify(dataPath)},
        previousFolderPath: ${JSON.stringify(previous)},
        onFileSwapped: (name) => { if (name === 'meta.json') process.exit(7); },
      });
    `;
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf-8' });
    assert.equal(child.status, 7, child.stderr);
    const after = snapshot(previous);

    assert.deepEqual(await recoverInterruptedRegenerations(dataPath), []);
    assert.deepEqual(snapshot(previous), after);
    assert.equal(after.get('summary.md')?.trim(), 'New summary.');
    assert.deepEqual(scratchDirs(dataPath), []);
  });

  it('leaves scratch folders owned by another live process alone', async () => {
    const dataPath = makeDataPath();
    const scratch = path.join(dataPath, '.regenerate-live');
    fs.mkdirSync(scratch);
    fs.writeFileSync(path.join(scratch, 'swap.json'), JSON.stringify({ pid: process.ppid }));

    assert.deepEqual(await recoverInterruptedRegenerations(dataPath), []);
    assert.ok(fs.existsSync(scratch));

    // Same live pid, but far too old to be an in-flight swap: pid was reused.
    const stale = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(path.join(scratch, 'swap.json'), stale, stale);
    assert.deepEqual(await recoverInterruptedRegenerations(dataPath), []);
    assert.ok(!fs.existsSync(scratch));
  });
});
