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
  applyTranscriptCutoff,
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

describe('applyTranscriptCutoff', () => {
  const transcript = [
    '참가자1: 오늘 안건은 출시 일정입니다.',
    '참가자2: 다음 주 화요일로 하죠.',
    '참가자1: 회의 끝.',
    '참가자2: 점심 뭐 먹을까요? 사적인 이야기.',
  ].join('\n');
  const cutAt = transcript.indexOf('참가자2: 점심');

  const cutResult: TranscriptionResult = {
    transcript: 'ignored: the saved transcript is never rewritten',
    summary: 'Cut summary.',
    keyPoints: [],
    actionItems: ['cut action'],
    emoji: '✂️',
    customFields: { decisions: ['ship Tuesday'], transcriptQuality: { modelNotes: ['new'] } },
    highlights: [{ offsetMs: 1000, userText: 'kickoff', subtitle: 'Schedule' }],
  } as TranscriptionResult;

  function makeNote(): { dataPath: string; folder: string; generationId: string } {
    const dataPath = makeDataPath();
    const folder = saveTranscription({
      title: 'Launch sync',
      result: {
        ...oldResult,
        transcript,
        customFields: {
          transcriptQuality: {
            lostSegments: [{ segment: 2, start: 300, end: 600, reason: 'empty' }],
          },
        },
      } as TranscriptionResult,
      audioFilePath: path.join(dataPath, 'recordings', 'launch.webm'),
      dataPath,
      liveNotes: [{ offsetMs: 1000, text: 'kickoff' }],
    });
    const meta = JSON.parse(fs.readFileSync(path.join(folder, META_JSON), 'utf-8'));
    meta.exports = { notion: { pageUrl: 'https://notion.so/old-page' }, slack: { sentAt: 'x' } };
    fs.writeFileSync(path.join(folder, META_JSON), JSON.stringify(meta));
    return { dataPath, folder, generationId: meta.generationId };
  }

  it('regenerates the report from the included text and keeps transcript, notes and audio path', async () => {
    const { dataPath, folder, generationId } = makeNote();
    const before = snapshot(folder);
    const calls: Array<{ text: string; lost: number; notes?: number }> = [];

    const res = await applyTranscriptCutoff({
      dataPath,
      folderPath: folder,
      expectedGenerationId: generationId,
      cutoffOffset: cutAt,
      now: new Date('2026-09-29T00:00:00.000Z'),
      summarize: async (text, context) => {
        calls.push({ text, lost: context.lostSegments.length, notes: context.liveNotes?.length });
        return cutResult;
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].text.includes('점심'),
      false,
      'the excluded tail never reaches the model',
    );
    assert.equal(calls[0].text.endsWith('회의 끝.'), true);
    assert.equal(calls[0].lost, 1, 'the coverage notice inputs are passed through');
    assert.equal(
      calls[0].notes,
      0,
      'a whole-file transcript cannot place the flagged note before the cutoff, so it is withheld',
    );

    const after = snapshot(folder);
    assert.equal(
      after.get('transcript.md'),
      before.get('transcript.md'),
      'full transcript is untouched',
    );
    assert.equal(after.get('notes.json'), before.get('notes.json'));
    assert.equal(after.get('summary.md'), 'Cut summary.\n');
    assert.equal(after.get(KEY_POINTS_FILE), '', 'a dropped section is truncated, not deleted');
    assert.equal(after.get('action-items.md'), '- cut action\n');
    assert.deepEqual(scratchDirs(dataPath), []);

    const meta = JSON.parse(after.get(META_JSON) as string);
    assert.notEqual(meta.generationId, generationId);
    assert.equal(res.generationId, meta.generationId);
    assert.equal(meta.transcriptCutoff.offset, cutAt);
    assert.equal(meta.title, 'Launch sync');
    assert.equal(meta.audioFile, path.join(dataPath, 'recordings', 'launch.webm'));
    assert.equal(meta.emoji, '✂️');
    assert.deepEqual(meta.customFields.decisions, ['ship Tuesday']);
    assert.deepEqual(
      meta.customFields.transcriptQuality,
      { lostSegments: [{ segment: 2, start: 300, end: 600, reason: 'empty' }] },
      'transcription diagnostics are kept, not replaced by the report run',
    );
    assert.equal(meta.exports.notion, undefined);
    assert.deepEqual(meta.exports.notionSuperseded, {
      pageUrl: 'https://notion.so/old-page',
      supersededAt: '2026-09-29T00:00:00.000Z',
    });
    assert.equal(meta.exports.slack.sentAt, 'x');

    const note = await readTranscription(folder);
    assert.equal(note?.transcript, transcript);
    assert.equal(note?.transcriptCutoff?.offset, cutAt);
    assert.equal(note?.notionPageUrl, undefined);
    assert.equal(note?.supersededNotionPageUrl, 'https://notion.so/old-page');
    assert.equal(note?.highlights?.[0].subtitle, 'Schedule');
  });

  it('updates an AI suggested title from the included transcript', async () => {
    const dataPath = makeDataPath();
    const folder = saveTranscription({
      title: 'Old Title',
      result: { ...oldResult, transcript },
      dataPath,
    });
    const before = await readTranscription(folder);
    assert.equal(before?.suggestedTitle, 'Old Title');

    await applyTranscriptCutoff({
      dataPath,
      folderPath: folder,
      expectedGenerationId: before?.generationId ?? null,
      cutoffOffset: cutAt,
      summarize: async () => ({ ...cutResult, suggestedTitle: 'New Title' }),
    });

    const after = await readTranscription(folder);
    assert.equal(after?.title, 'New Title');
    assert.equal(after?.suggestedTitle, 'New Title');
    assert.equal(after?.transcript, transcript);
  });

  it('feeds the model only the flagged notes the segment headers place before the cutoff', async () => {
    const segmented = [
      '[Segment 1: 00:00:00 ~ 00:05:00]',
      '',
      '참가자1: 첫 번째 안건입니다.',
      '',
      '---',
      '',
      '[Segment 2: 00:05:00 ~ 00:10:00]',
      '',
      '참가자2: 두 번째 안건입니다. 결정합시다.',
      '',
      '---',
      '',
      '[Segment 3: 00:10:00 ~ 00:15:00]',
      '',
      '참가자1: 이제 잡담이나 하죠.',
    ].join('\n');
    const notes = [
      { offsetMs: 30_000, text: 'first' },
      { offsetMs: 400_000, text: 'in the cut segment' },
      { offsetMs: 700_000, text: 'tail' },
    ];
    const dataPath = makeDataPath();
    const folder = saveTranscription({
      title: 'Long sync',
      result: {
        ...oldResult,
        transcript: segmented,
        customFields: {
          transcriptQuality: {
            lostSegments: [
              { segment: 1, start: 0, end: 300, reason: 'cleaned' },
              { segment: 3, start: 600, end: 900, reason: 'empty' },
            ],
          },
        },
      } as TranscriptionResult,
      dataPath,
      liveNotes: notes,
    });
    const meta = JSON.parse(fs.readFileSync(path.join(folder, META_JSON), 'utf-8'));
    const seen: Array<{ notes?: string[]; lost: number[] }> = [];
    const res = await applyTranscriptCutoff({
      dataPath,
      folderPath: folder,
      expectedGenerationId: meta.generationId,
      cutoffOffset: segmented.indexOf('결정합시다'),
      summarize: async (_text, context) => {
        seen.push({
          notes: context.liveNotes?.map((n) => n.text),
          lost: context.lostSegments.map((l) => l.segment),
        });
        return {
          ...cutResult,
          highlights: context.liveNotes?.map((n) => ({ offsetMs: n.offsetMs, userText: n.text })),
        };
      },
    });
    assert.deepEqual(seen, [{ notes: ['first'], lost: [1] }]);
    assert.equal(res.excludedNotes, 2);
    const note = await readTranscription(folder);
    assert.deepEqual(note?.liveNotes, notes, 'the stored notes are untouched');
    assert.deepEqual(
      note?.highlights?.map((h) => h.userText),
      ['first'],
    );
  });

  it('withholds every flagged note from a whole-file transcript and brings them back on restore', async () => {
    const { dataPath, folder, generationId } = makeNote();
    const seen: Array<string[] | undefined> = [];
    const summarize = async (_text: string, context: { liveNotes?: Array<{ text: string }> }) => {
      seen.push(context.liveNotes?.map((n) => n.text));
      return { ...cutResult, highlights: context.liveNotes?.length ? cutResult.highlights : [] };
    };
    const cut = await applyTranscriptCutoff({
      dataPath,
      folderPath: folder,
      expectedGenerationId: generationId,
      cutoffOffset: cutAt,
      summarize,
    });
    assert.equal(cut.excludedNotes, 1);
    assert.equal(
      fs.readFileSync(path.join(folder, HIGHLIGHTS_JSON_FILE), 'utf-8'),
      '',
      'no highlight may describe a note that cannot be placed before the cutoff',
    );
    assert.deepEqual((await readTranscription(folder))?.liveNotes, [
      { offsetMs: 1000, text: 'kickoff' },
    ]);

    const restored = await applyTranscriptCutoff({
      dataPath,
      folderPath: folder,
      expectedGenerationId: cut.generationId,
      cutoffOffset: null,
      summarize,
    });
    assert.equal(restored.excludedNotes, 0);
    assert.deepEqual(seen, [[], ['kickoff']]);
    assert.equal((await readTranscription(folder))?.highlights?.[0].userText, 'kickoff');
  });

  it('uses sidecar notes when the note stores none, and keeps highlights it cannot rebuild', async () => {
    const dataPath = makeDataPath();
    const folder = saveTranscription({
      title: 'Legacy',
      result: { ...oldResult, transcript } as TranscriptionResult,
      dataPath,
    });
    const meta = JSON.parse(fs.readFileSync(path.join(folder, META_JSON), 'utf-8'));
    const highlightsBefore = fs.readFileSync(path.join(folder, HIGHLIGHTS_JSON_FILE), 'utf-8');
    assert.match(highlightsBefore, /old highlight/);

    // No notes anywhere: the existing highlights file is left as it is.
    const first = await applyTranscriptCutoff({
      dataPath,
      folderPath: folder,
      expectedGenerationId: meta.generationId,
      cutoffOffset: cutAt,
      summarize: async () => ({ ...cutResult, highlights: undefined }),
    });
    assert.equal(
      fs.readFileSync(path.join(folder, HIGHLIGHTS_JSON_FILE), 'utf-8'),
      highlightsBefore,
    );

    // Sidecar notes stand in for notes.json and are filtered like stored ones.
    let seen: string[] | undefined;
    const second = await applyTranscriptCutoff({
      dataPath,
      folderPath: folder,
      expectedGenerationId: first.generationId,
      cutoffOffset: null,
      fallbackLiveNotes: [{ offsetMs: 5000, text: 'from sidecar' }],
      summarize: async (_text, context) => {
        seen = context.liveNotes?.map((n) => n.text);
        return {
          ...cutResult,
          highlights: [{ offsetMs: 5000, userText: 'from sidecar', subtitle: 'Legacy' }],
        };
      },
    });
    assert.deepEqual(seen, ['from sidecar']);
    assert.equal(second.excludedNotes, 0);
    assert.equal((await readTranscription(folder))?.highlights?.[0].subtitle, 'Legacy');
    assert.equal(
      fs.existsSync(path.join(folder, 'notes.json')),
      false,
      'sidecar notes are not copied in',
    );
  });

  it('restores the full transcript when the cutoff is removed', async () => {
    const { dataPath, folder, generationId } = makeNote();
    const first = await applyTranscriptCutoff({
      dataPath,
      folderPath: folder,
      expectedGenerationId: generationId,
      cutoffOffset: cutAt,
      summarize: async () => cutResult,
    });
    let seen = '';
    await applyTranscriptCutoff({
      dataPath,
      folderPath: folder,
      expectedGenerationId: first.generationId,
      cutoffOffset: null,
      summarize: async (text) => {
        seen = text;
        return { ...cutResult, summary: 'Full summary.' };
      },
    });
    assert.equal(seen, transcript);
    const note = await readTranscription(folder);
    assert.equal(note?.transcriptCutoff, undefined);
    assert.equal(note?.summary, 'Full summary.');
    const meta = JSON.parse(fs.readFileSync(path.join(folder, META_JSON), 'utf-8'));
    assert.equal('transcriptCutoff' in meta, false);
  });

  it('refuses a stale generation or an invalid offset without calling the model', async () => {
    const { dataPath, folder, generationId } = makeNote();
    const before = snapshot(folder);
    let called = false;
    const summarize = async () => {
      called = true;
      return cutResult;
    };
    await assert.rejects(
      applyTranscriptCutoff({
        dataPath,
        folderPath: folder,
        expectedGenerationId: 'stale',
        cutoffOffset: cutAt,
        summarize,
      }),
      /This note changed/,
    );
    await assert.rejects(
      applyTranscriptCutoff({
        dataPath,
        folderPath: folder,
        expectedGenerationId: generationId,
        cutoffOffset: transcript.length,
        summarize,
      }),
      /outside the transcript/,
    );
    assert.equal(called, false);
    assert.deepEqual(snapshot(folder), before);
  });

  it('does not save over a note that changed while the report was generating', async () => {
    const { dataPath, folder, generationId } = makeNote();
    await assert.rejects(
      applyTranscriptCutoff({
        dataPath,
        folderPath: folder,
        expectedGenerationId: generationId,
        cutoffOffset: cutAt,
        summarize: async () => {
          // A regenerate from another window lands mid-summary.
          saveRegeneratedTranscription({
            title: 'Launch sync',
            result: newResult,
            audioFilePath: path.join(dataPath, 'recordings', 'launch.webm'),
            dataPath,
            previousFolderPath: folder,
          });
          return cutResult;
        },
      }),
      /This note changed/,
    );
    const note = await readTranscription(folder);
    assert.equal(note?.summary, 'New summary.');
    assert.equal(note?.transcriptCutoff, undefined);
  });

  it('restores the previous files when the swap fails midway', async () => {
    const { dataPath, folder, generationId } = makeNote();
    const before = snapshot(folder);
    await assert.rejects(
      applyTranscriptCutoff({
        dataPath,
        folderPath: folder,
        expectedGenerationId: generationId,
        cutoffOffset: cutAt,
        summarize: async () => cutResult,
        onFileSwapped: (name) => {
          if (name === 'action-items.md') throw new Error('disk full');
        },
      }),
      /disk full/,
    );
    assert.deepEqual(snapshot(folder), before);
    assert.deepEqual(scratchDirs(dataPath), []);
  });

  it('is dropped by a full re-transcription, whose text no longer matches the offset', async () => {
    const { dataPath, folder, generationId } = makeNote();
    await applyTranscriptCutoff({
      dataPath,
      folderPath: folder,
      expectedGenerationId: generationId,
      cutoffOffset: cutAt,
      summarize: async () => cutResult,
    });
    saveRegeneratedTranscription({
      title: 'Launch sync',
      result: newResult,
      audioFilePath: path.join(dataPath, 'recordings', 'launch.webm'),
      dataPath,
      previousFolderPath: folder,
    });
    const meta = JSON.parse(fs.readFileSync(path.join(folder, META_JSON), 'utf-8'));
    assert.equal('transcriptCutoff' in meta, false);
    assert.equal(meta.exports, undefined);
  });
});
