import * as fs from 'fs';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import * as path from 'path';
import type { TranscriptionResult } from './geminiService';
import {
  ACTION_ITEMS_FILE,
  HIGHLIGHTS_JSON_FILE,
  KEY_POINTS_FILE,
  META_JSON,
  NOTES_JSON_FILE,
  SUMMARY_FILE,
  TRANSCRIPT_FILE,
  __saveTranscriptionLegacyV1ForTests,
  autoMigrateLegacyOnStartup,
  formatSummary,
  formatV2Timestamp,
  gcLegacyBackups,
  getTranscriptionsDir,
  isV2Folder,
  listTranscriptions,
  migrateV1ToV2,
  parseBullets,
  parseFrontmatter,
  readTranscription,
  sanitizeForPath,
  sanitizeV2Title,
  saveTranscription,
  splitV2FolderName,
  updateTranscriptionStatus,
} from './outputService';
import { makeTempDir, rmDir } from './test-helpers';

const tmpDirs: string[] = [];

function makeTmpDataPath(): string {
  const dir = makeTempDir('output');
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) rmDir(dir);
});

const baseResult: TranscriptionResult = {
  transcript: 'Speaker A: hello.\nSpeaker B: hi.',
  summary: 'A short greeting.',
  keyPoints: ['Greeting exchanged'],
  actionItems: ['Schedule follow-up'],
  emoji: '👋',
  suggestedTitle: 'Greeting Sync',
};

describe('saveTranscription with mergedFrom', () => {
  it('round-trips mergedFrom through frontmatter', async () => {
    const dataPath = makeTmpDataPath();
    const folderPath = saveTranscription({
      title: 'Combined Meeting',
      result: baseResult,
      audioFilePath: '/tmp/merged.webm',
      dataPath,
      mergedFrom: ['Part_One_20260101_120000', 'Part_Two_20260101_130000'],
    });

    const data = await readTranscription(folderPath);
    assert.ok(data, 'readTranscription returned null');
    assert.deepEqual(data!.mergedFrom, ['Part_One_20260101_120000', 'Part_Two_20260101_130000']);
    assert.equal(data!.summary, 'A short greeting.');
    assert.deepEqual(data!.keyPoints, ['Greeting exchanged']);
  });

  it('omits mergedFrom from frontmatter when absent', async () => {
    const dataPath = makeTmpDataPath();
    const folderPath = saveTranscription({
      title: 'Solo Meeting',
      result: baseResult,
      dataPath,
    });

    const summaryRaw = fs.readFileSync(path.join(folderPath, 'summary.md'), 'utf-8');
    const { meta } = parseFrontmatter(summaryRaw);
    assert.equal(meta.mergedFrom, undefined);

    const data = await readTranscription(folderPath);
    assert.equal(data!.mergedFrom, undefined);
  });

  it('renders a Sources section in the markdown body when mergedFrom is set', () => {
    const body = formatSummary(baseResult, 'Combined Meeting', [
      'Part_One_20260101_120000',
      'Part_Two_20260101_130000',
    ]);
    assert.match(body, /## Sources/);
    assert.match(body, /Merged from 2 recordings/);
    assert.match(body, /- Part_One_20260101_120000/);
    assert.match(body, /- Part_Two_20260101_130000/);
  });

  it('omits the Sources section when mergedFrom is empty', () => {
    const body = formatSummary(baseResult, 'Solo Meeting');
    assert.doesNotMatch(body, /## Sources/);
  });
});

describe('updateTranscriptionStatus', () => {
  it('writes Notion URL and Slack send timestamp without losing the markdown body', async () => {
    const dataPath = makeTmpDataPath();
    const folderPath = saveTranscription({
      title: 'Status Test',
      result: baseResult,
      dataPath,
    });

    const before = fs.readFileSync(path.join(folderPath, 'summary.md'), 'utf-8');
    const bodyBefore = before.split('\n---').slice(1).join('\n---');

    await updateTranscriptionStatus(folderPath, {
      notionPageUrl: 'https://www.notion.so/abc123',
      slackSentAt: '2026-04-30T09:30:00Z',
    });

    const after = fs.readFileSync(path.join(folderPath, 'summary.md'), 'utf-8');
    const bodyAfter = after.split('\n---').slice(1).join('\n---');
    assert.equal(bodyAfter, bodyBefore, 'body should be preserved verbatim');

    const data = await readTranscription(folderPath);
    assert.equal(data!.notionPageUrl, 'https://www.notion.so/abc123');
    assert.equal(data!.slackSentAt, '2026-04-30T09:30:00Z');
    assert.equal(data!.slackError, undefined);
  });

  it('clears a field when passed null', async () => {
    const dataPath = makeTmpDataPath();
    const folderPath = saveTranscription({
      title: 'Status Test 2',
      result: baseResult,
      dataPath,
    });

    await updateTranscriptionStatus(folderPath, {
      slackSentAt: '2026-04-30T09:30:00Z',
      slackError: 'temporary failure',
    });
    let data = await readTranscription(folderPath);
    assert.equal(data!.slackError, 'temporary failure');

    await updateTranscriptionStatus(folderPath, { slackError: null });
    data = await readTranscription(folderPath);
    assert.equal(data!.slackError, undefined);
    assert.equal(data!.slackSentAt, '2026-04-30T09:30:00Z');
  });
});

describe('saveTranscription with liveNotes', () => {
  it('round-trips liveNotes through frontmatter (text + flag-only)', async () => {
    const dataPath = makeTmpDataPath();
    const folderPath = saveTranscription({
      title: 'Notes Sync',
      result: baseResult,
      dataPath,
      liveNotes: [
        { offsetMs: 8_000, text: '지금' },
        { offsetMs: 12_500, text: '' },
        { offsetMs: 30_000, text: '액션 아이템: 후속 미팅 잡기' },
      ],
    });

    const data = await readTranscription(folderPath);
    assert.ok(data, 'readTranscription returned null');
    assert.deepEqual(data!.liveNotes, [
      { offsetMs: 8_000, text: '지금' },
      { offsetMs: 12_500, text: '' },
      { offsetMs: 30_000, text: '액션 아이템: 후속 미팅 잡기' },
    ]);
  });

  it('omits liveNotes from frontmatter when none provided', async () => {
    const dataPath = makeTmpDataPath();
    const folderPath = saveTranscription({
      title: 'Notes Sync 2',
      result: baseResult,
      dataPath,
    });

    const summaryRaw = fs.readFileSync(path.join(folderPath, 'summary.md'), 'utf-8');
    const { meta } = parseFrontmatter(summaryRaw);
    assert.equal(meta.liveNotes, undefined);

    const data = await readTranscription(folderPath);
    assert.equal(data!.liveNotes, undefined);
  });

  it('renders the Highlights section with mm:ss timestamps and flag fallback', () => {
    const body = formatSummary(baseResult, 'Notes Sync', undefined, [
      { offsetMs: 8_000, text: '지금' },
      { offsetMs: 12_500, text: '' },
      { offsetMs: 65_000, text: '계약 조건 확인' },
    ]);
    assert.match(body, /## 🗒️ Highlights/);
    assert.match(body, /- \[00:08\] 지금/);
    assert.match(body, /- \[00:12\] 🏴/);
    assert.match(body, /- \[01:05\] 계약 조건 확인/);
  });

  it('omits the Highlights section when liveNotes is empty', () => {
    const body = formatSummary(baseResult, 'Notes Sync');
    assert.doesNotMatch(body, /## 🗒️ Highlights/);
  });

  it('updateTranscriptionStatus preserves liveNotes across a status write', async () => {
    const dataPath = makeTmpDataPath();
    const folderPath = saveTranscription({
      title: 'Notes Persist',
      result: baseResult,
      dataPath,
      liveNotes: [{ offsetMs: 1_000, text: 'first note' }],
    });

    await updateTranscriptionStatus(folderPath, {
      notionPageUrl: 'https://www.notion.so/page',
    });

    const data = await readTranscription(folderPath);
    assert.deepEqual(data!.liveNotes, [{ offsetMs: 1_000, text: 'first note' }]);
    assert.equal(data!.notionPageUrl, 'https://www.notion.so/page');
  });
});

describe('saveTranscription with AI-enriched highlights', () => {
  const resultWithHighlights: TranscriptionResult = {
    ...baseResult,
    highlights: [
      {
        offsetMs: 8_000,
        userText: '지금',
        subtitle: '도입 인사',
        bullets: ['주요 인사이트: 첫 인사를 교환했다.', '실행 항목: 후속 미팅 일정 조율'],
      },
      {
        offsetMs: 12_500,
        userText: '',
      },
    ],
  };

  it('round-trips highlights through frontmatter (rich + flag-only)', async () => {
    const dataPath = makeTmpDataPath();
    const folderPath = saveTranscription({
      title: 'Highlights Sync',
      result: resultWithHighlights,
      dataPath,
      liveNotes: [
        { offsetMs: 8_000, text: '지금' },
        { offsetMs: 12_500, text: '' },
      ],
    });

    const data = await readTranscription(folderPath);
    assert.ok(data, 'readTranscription returned null');
    assert.deepEqual(data!.highlights, [
      {
        offsetMs: 8_000,
        userText: '지금',
        subtitle: '도입 인사',
        bullets: ['주요 인사이트: 첫 인사를 교환했다.', '실행 항목: 후속 미팅 일정 조율'],
      },
      { offsetMs: 12_500, userText: '', subtitle: undefined, bullets: undefined },
    ]);
  });

  it('renders rich Highlights body (heading + subtitle + bullets) when highlights present', () => {
    const body = formatSummary(
      resultWithHighlights,
      'Highlights Sync',
      undefined,
      [
        { offsetMs: 8_000, text: '지금' },
        { offsetMs: 12_500, text: '' },
      ],
      resultWithHighlights.highlights,
    );
    assert.match(body, /## 🗒️ Highlights/);
    assert.match(body, /### \[00:08\] 지금/);
    assert.match(body, /\*도입 인사\*/);
    assert.match(body, /- 주요 인사이트: 첫 인사를 교환했다\./);
    assert.match(body, /### \[00:12\] 🏴/);
  });

  it('falls back to bare bullet list when highlights are absent but liveNotes exist', () => {
    const body = formatSummary(baseResult, 'Highlights Sync', undefined, [
      { offsetMs: 8_000, text: '지금' },
    ]);
    assert.match(body, /## 🗒️ Highlights/);
    assert.match(body, /- \[00:08\] 지금/);
    assert.doesNotMatch(body, /### \[00:08\]/);
  });
});

describe('sanitizeForPath', () => {
  it('replaces filesystem-hostile characters', () => {
    assert.equal(sanitizeForPath('LG : meeting / part 1?'), 'LG _ meeting _ part 1_');
  });

  it('collapses repeated whitespace', () => {
    assert.equal(sanitizeForPath('hello    world'), 'hello world');
  });
});

// ---------- v2 layout suite ----------

describe('v2 folder naming primitives', () => {
  it('formatV2Timestamp produces a 24-char filesystem-safe ISO stamp', () => {
    const ts = formatV2Timestamp(new Date('2026-05-20T10:30:15.123Z'));
    assert.equal(ts, '2026-05-20T10-30-15.123Z');
    assert.equal(ts.length, 24);
  });

  it('splitV2FolderName parses a v2 folder name', () => {
    const split = splitV2FolderName('2026-05-20T10-30-15.123Z_Team_Meeting');
    assert.deepEqual(split, { ts: '2026-05-20T10-30-15.123Z', title: 'Team_Meeting' });
  });

  it('splitV2FolderName rejects v1-style folder names', () => {
    assert.equal(splitV2FolderName('Team_Meeting_20260520_103015'), null);
  });

  it('sanitizeV2Title strips filesystem-forbidden characters', () => {
    assert.equal(sanitizeV2Title('LG : meeting / part 1?'), 'LG_meeting_part_1');
  });

  it('sanitizeV2Title preserves Korean characters and length-caps', () => {
    assert.equal(sanitizeV2Title('Q3 로드맵 논의'), 'Q3_로드맵_논의');
    assert.ok(sanitizeV2Title('x'.repeat(500)).length <= 100);
  });

  it('sanitizeV2Title falls back to "meeting" on empty input', () => {
    assert.equal(sanitizeV2Title(''), 'meeting');
    assert.equal(sanitizeV2Title('   '), 'meeting');
  });

  it('parseBullets strips the "- " prefix and ignores other lines', () => {
    const text = '- first item\n- second item\nstray line\n- third item';
    assert.deepEqual(parseBullets(text), ['first item', 'second item', 'third item']);
  });
});

describe('saveTranscription v2 default', () => {
  it('writes the v2 layout, not v1', () => {
    const dataPath = makeTmpDataPath();
    const folderPath = saveTranscription({
      title: 'V2 Meeting',
      result: baseResult,
      dataPath,
    });

    assert.ok(isV2Folder(folderPath), 'folder should be v2');
    assert.ok(fs.existsSync(path.join(folderPath, META_JSON)));
    assert.ok(fs.existsSync(path.join(folderPath, SUMMARY_FILE)));
    assert.ok(fs.existsSync(path.join(folderPath, TRANSCRIPT_FILE)));

    // summary.md must be plain markdown -- no YAML frontmatter on the v2 path.
    const summary = fs.readFileSync(path.join(folderPath, SUMMARY_FILE), 'utf-8');
    assert.ok(!summary.startsWith('---'), 'v2 summary.md must not start with frontmatter');
    assert.equal(summary.trim(), 'A short greeting.');

    // transcript.md drops the "# title" heading too.
    const transcript = fs.readFileSync(path.join(folderPath, TRANSCRIPT_FILE), 'utf-8');
    assert.equal(transcript.trim(), 'Speaker A: hello.\nSpeaker B: hi.');
    assert.ok(!transcript.startsWith('# '), 'v2 transcript.md should have no `# title` heading');
  });

  it('folder name follows the v2 naming scheme', () => {
    const dataPath = makeTmpDataPath();
    const folderPath = saveTranscription({
      title: 'Team Meeting',
      result: baseResult,
      dataPath,
      now: new Date('2026-05-20T10:30:15.123Z'),
    });
    assert.equal(path.basename(folderPath), '2026-05-20T10-30-15.123Z_Team_Meeting');
  });

  it('bumps the timestamp ms on folder-name collision', () => {
    const dataPath = makeTmpDataPath();
    const ts = new Date('2026-05-20T10:30:15.123Z');
    const a = saveTranscription({ title: 'Same', result: baseResult, dataPath, now: ts });
    const b = saveTranscription({ title: 'Same', result: baseResult, dataPath, now: ts });
    assert.notEqual(path.basename(a), path.basename(b));
  });

  it('round-trips through readTranscription (mergedFrom + keyPoints + actionItems)', async () => {
    const dataPath = makeTmpDataPath();
    const folderPath = saveTranscription({
      title: 'Combined Meeting',
      result: baseResult,
      dataPath,
      mergedFrom: ['Part_One', 'Part_Two'],
    });

    const data = await readTranscription(folderPath);
    assert.ok(data);
    assert.equal(data!.title, 'Combined Meeting');
    assert.equal(data!.summary, 'A short greeting.');
    assert.deepEqual(data!.keyPoints, ['Greeting exchanged']);
    assert.deepEqual(data!.actionItems, ['Schedule follow-up']);
    assert.deepEqual(data!.mergedFrom, ['Part_One', 'Part_Two']);
    assert.equal(data!.transcript, 'Speaker A: hello.\nSpeaker B: hi.');
  });

  it('omits optional files when fields are empty', () => {
    const dataPath = makeTmpDataPath();
    const folderPath = saveTranscription({
      title: 'Minimal',
      result: {
        transcript: 'just a transcript',
        summary: '',
        keyPoints: [],
        actionItems: [],
        emoji: '',
      },
      dataPath,
    });

    assert.ok(!fs.existsSync(path.join(folderPath, KEY_POINTS_FILE)));
    assert.ok(!fs.existsSync(path.join(folderPath, ACTION_ITEMS_FILE)));
    assert.ok(!fs.existsSync(path.join(folderPath, NOTES_JSON_FILE)));
    assert.ok(!fs.existsSync(path.join(folderPath, HIGHLIGHTS_JSON_FILE)));
  });

  it('writes liveNotes + highlights as separate JSON files', async () => {
    const dataPath = makeTmpDataPath();
    const folderPath = saveTranscription({
      title: 'Rich',
      result: {
        ...baseResult,
        highlights: [
          {
            offsetMs: 8000,
            userText: 'now',
            subtitle: 'intro',
            bullets: ['point one'],
          },
        ],
      },
      dataPath,
      liveNotes: [{ offsetMs: 8000, text: 'now' }],
    });

    assert.ok(fs.existsSync(path.join(folderPath, NOTES_JSON_FILE)));
    assert.ok(fs.existsSync(path.join(folderPath, HIGHLIGHTS_JSON_FILE)));

    const data = await readTranscription(folderPath);
    assert.deepEqual(data!.liveNotes, [{ offsetMs: 8000, text: 'now' }]);
    assert.equal(data!.highlights!.length, 1);
    assert.equal(data!.highlights![0].subtitle, 'intro');
  });

  it('normalizes multi-line bullets so they survive a round-trip', async () => {
    const dataPath = makeTmpDataPath();
    const folderPath = saveTranscription({
      title: 'MultiLine',
      result: {
        ...baseResult,
        keyPoints: ['line one\n  continued on line two', 'second item'],
      },
      dataPath,
    });
    const data = await readTranscription(folderPath);
    assert.deepEqual(data!.keyPoints, ['line one continued on line two', 'second item']);
  });
});

describe('updateTranscriptionStatus on v2 folders', () => {
  it('writes Notion URL and Slack timestamp into meta.json', async () => {
    const dataPath = makeTmpDataPath();
    const folderPath = saveTranscription({
      title: 'V2 Status',
      result: baseResult,
      dataPath,
    });

    const summaryBefore = fs.readFileSync(path.join(folderPath, SUMMARY_FILE), 'utf-8');

    await updateTranscriptionStatus(folderPath, {
      notionPageUrl: 'https://www.notion.so/abc',
      slackSentAt: '2026-04-30T09:30:00Z',
    });

    // summary.md must not be touched -- only meta.json holds tracking state.
    const summaryAfter = fs.readFileSync(path.join(folderPath, SUMMARY_FILE), 'utf-8');
    assert.equal(summaryAfter, summaryBefore, 'summary.md should not change on status update');

    const meta = JSON.parse(fs.readFileSync(path.join(folderPath, META_JSON), 'utf-8'));
    assert.equal(meta.exports.notion.pageUrl, 'https://www.notion.so/abc');
    assert.equal(meta.exports.slack.sentAt, '2026-04-30T09:30:00Z');

    const data = await readTranscription(folderPath);
    assert.equal(data!.notionPageUrl, 'https://www.notion.so/abc');
    assert.equal(data!.slackSentAt, '2026-04-30T09:30:00Z');
  });

  it('clears slackError when passed null', async () => {
    const dataPath = makeTmpDataPath();
    const folderPath = saveTranscription({
      title: 'V2 Clear',
      result: baseResult,
      dataPath,
    });

    await updateTranscriptionStatus(folderPath, {
      slackSentAt: '2026-04-30T09:30:00Z',
      slackError: 'transient failure',
    });
    let data = await readTranscription(folderPath);
    assert.equal(data!.slackError, 'transient failure');

    await updateTranscriptionStatus(folderPath, { slackError: null });
    data = await readTranscription(folderPath);
    assert.equal(data!.slackError, undefined);
    assert.equal(data!.slackSentAt, '2026-04-30T09:30:00Z');
  });

  it('preserves liveNotes across a status write (file unchanged)', async () => {
    const dataPath = makeTmpDataPath();
    const folderPath = saveTranscription({
      title: 'V2 LiveNotes',
      result: baseResult,
      dataPath,
      liveNotes: [{ offsetMs: 1000, text: 'first' }],
    });

    const notesBefore = fs.readFileSync(path.join(folderPath, NOTES_JSON_FILE), 'utf-8');

    await updateTranscriptionStatus(folderPath, {
      notionPageUrl: 'https://www.notion.so/x',
    });

    const notesAfter = fs.readFileSync(path.join(folderPath, NOTES_JSON_FILE), 'utf-8');
    assert.equal(notesAfter, notesBefore, 'notes.json should be untouched');

    const data = await readTranscription(folderPath);
    assert.deepEqual(data!.liveNotes, [{ offsetMs: 1000, text: 'first' }]);
    assert.equal(data!.notionPageUrl, 'https://www.notion.so/x');
  });
});

describe('v1 fixtures round-trip through migration', () => {
  it('a v1 fixture migrated to v2 reads back identically', async () => {
    const dataPath = makeTmpDataPath();
    const folderPath = __saveTranscriptionLegacyV1ForTests({
      title: 'Legacy Meeting',
      result: baseResult,
      dataPath,
    });
    assert.ok(!isV2Folder(folderPath));

    await migrateV1ToV2(folderPath);

    const data = await readTranscription(folderPath);
    assert.ok(data);
    assert.equal(data!.title, 'Legacy Meeting');
    assert.equal(data!.summary, 'A short greeting.');
    assert.deepEqual(data!.keyPoints, ['Greeting exchanged']);
    assert.deepEqual(data!.actionItems, ['Schedule follow-up']);
    assert.equal(data!.transcript, 'Speaker A: hello.\nSpeaker B: hi.');
  });

  it('listTranscriptions returns v2 folders after migration', async () => {
    const dataPath = makeTmpDataPath();

    __saveTranscriptionLegacyV1ForTests({
      title: 'Legacy A',
      result: { ...baseResult, suggestedTitle: 'A' },
      dataPath,
    });
    saveTranscription({
      title: 'V2 B',
      result: { ...baseResult, suggestedTitle: 'B' },
      dataPath,
    });

    // Auto-migrate brings the v1 fixture up to v2 so the runtime reader sees it.
    await autoMigrateLegacyOnStartup(dataPath);

    const entries = await listTranscriptions(dataPath, 0);
    assert.equal(entries.length, 2);
    const titles = entries.map((e) => e.title).sort();
    assert.deepEqual(titles, ['Legacy A', 'V2 B']);
    for (const e of entries) assert.ok(e.transcribedAt, `each entry must have a transcribedAt`);
  });
});

describe('migrateV1ToV2', () => {
  it('migrates a v1 folder in-place and is idempotent', async () => {
    const dataPath = makeTmpDataPath();
    const folderPath = __saveTranscriptionLegacyV1ForTests({
      title: 'Migrate Me',
      result: {
        ...baseResult,
        customFields: { decisions: ['ship it'] },
      },
      audioFilePath: '/tmp/migrate.webm',
      dataPath,
      liveNotes: [{ offsetMs: 1000, text: 'remember this' }],
    });
    assert.ok(!isV2Folder(folderPath));

    // Round 1: actually migrates.
    const changed1 = await migrateV1ToV2(folderPath);
    assert.equal(changed1, true);
    assert.ok(isV2Folder(folderPath));
    assert.ok(fs.existsSync(path.join(folderPath, META_JSON)));
    assert.ok(fs.existsSync(path.join(folderPath, NOTES_JSON_FILE)));

    // Round 2: idempotent.
    const changed2 = await migrateV1ToV2(folderPath);
    assert.equal(changed2, false);

    // Data survives.
    const data = await readTranscription(folderPath);
    assert.equal(data!.title, 'Migrate Me');
    assert.equal(data!.summary, 'A short greeting.');
    assert.deepEqual(data!.keyPoints, ['Greeting exchanged']);
    assert.deepEqual(data!.actionItems, ['Schedule follow-up']);
    assert.equal(data!.transcript, 'Speaker A: hello.\nSpeaker B: hi.');
    assert.equal(data!.audioFilePath, '/tmp/migrate.webm');
    assert.deepEqual(data!.customFields, { decisions: ['ship it'] });
    assert.deepEqual(data!.liveNotes, [{ offsetMs: 1000, text: 'remember this' }]);
  });

  it('carries Notion URL and Slack sentAt forward into v2 exports', async () => {
    const dataPath = makeTmpDataPath();
    // Hand-craft a v1 folder that already has notionPageUrl + slackSentAt in
    // its frontmatter (simulating a previously-published meeting). We can't
    // route through updateTranscriptionStatus anymore because that's v2-only.
    const folderPath = __saveTranscriptionLegacyV1ForTests({
      title: 'Already Published',
      result: baseResult,
      dataPath,
    });
    const summaryPath = path.join(folderPath, 'summary.md');
    const original = fs.readFileSync(summaryPath, 'utf-8');
    const patched = original.replace(
      /^---\n/,
      `---\nnotionPageUrl: "https://www.notion.so/published"\nslackSentAt: "2026-04-30T09:30:00Z"\n`,
    );
    fs.writeFileSync(summaryPath, patched, 'utf-8');

    const changed = await migrateV1ToV2(folderPath);
    assert.equal(changed, true);

    const meta = JSON.parse(fs.readFileSync(path.join(folderPath, META_JSON), 'utf-8'));
    assert.equal(meta.exports.notion.pageUrl, 'https://www.notion.so/published');
    assert.equal(meta.exports.slack.sentAt, '2026-04-30T09:30:00Z');
  });

  it('does not destroy transcript content when frontmatter transcript was empty', async () => {
    const dataPath = makeTmpDataPath();
    // Build a folder where summary.md has no `transcript:` field but
    // transcript.md still has content. Mimics a hand-edited corruption.
    const folderPath = __saveTranscriptionLegacyV1ForTests({
      title: 'Recover',
      result: { ...baseResult, transcript: '' }, // empty frontmatter transcript
      dataPath,
    });
    fs.writeFileSync(
      path.join(folderPath, 'transcript.md'),
      '# Recover\n\nrescued transcript content\n',
      'utf-8',
    );

    await migrateV1ToV2(folderPath);
    const data = await readTranscription(folderPath);
    assert.equal(data!.transcript, 'rescued transcript content');
  });
});

describe('listTranscriptions ordering', () => {
  it('sorts by transcribedAt descending after a mixed v1/v2 dir is migrated', async () => {
    const dataPath = makeTmpDataPath();

    saveTranscription({
      title: 'Newest',
      result: baseResult,
      dataPath,
      now: new Date('2026-05-22T10:00:00.000Z'),
    });
    saveTranscription({
      title: 'Middle',
      result: baseResult,
      dataPath,
      now: new Date('2026-05-21T10:00:00.000Z'),
    });
    // Legacy folder dated by its formatTimestamp (now) -- will sort by its real time.
    __saveTranscriptionLegacyV1ForTests({
      title: 'OldestLegacy',
      result: baseResult,
      dataPath,
    });

    // Bring the v1 fixture forward; listTranscriptions only sees v2 folders.
    await autoMigrateLegacyOnStartup(dataPath);

    const entries = await listTranscriptions(dataPath, 0);
    assert.equal(entries.length, 3);
    // V2 entries are dated 2026-05-22 and 2026-05-21; the legacy fixture uses
    // `new Date().toISOString()` for its transcribedAt, so its position
    // depends on the real-world clock. Pin only the v2 ordering and the
    // legacy entry's presence.
    const v2Order = entries.filter((e) => e.title !== 'OldestLegacy').map((e) => e.title);
    assert.deepEqual(v2Order, ['Newest', 'Middle']);
    assert.ok(entries.some((e) => e.title === 'OldestLegacy'));
  });
});

describe('autoMigrateLegacyOnStartup', () => {
  it('returns empty result when there is no transcriptions/ dir', async () => {
    const dataPath = makeTmpDataPath();
    const r = await autoMigrateLegacyOnStartup(dataPath);
    assert.deepEqual(r, { migrated: [], alreadyV2: 0 });
  });

  it('returns empty result when there are no v1 folders', async () => {
    const dataPath = makeTmpDataPath();
    saveTranscription({ title: 'V2', result: baseResult, dataPath });
    const r = await autoMigrateLegacyOnStartup(dataPath);
    assert.equal(r.migrated.length, 0);
    assert.equal(r.alreadyV2, 1);
    assert.equal(r.backupDir, undefined);
  });

  it('migrates every v1 folder and writes a backup outside transcriptions/', async () => {
    const dataPath = makeTmpDataPath();
    const v1a = __saveTranscriptionLegacyV1ForTests({
      title: 'Legacy A',
      result: baseResult,
      dataPath,
    });
    const v1b = __saveTranscriptionLegacyV1ForTests({
      title: 'Legacy B',
      result: baseResult,
      dataPath,
    });
    saveTranscription({ title: 'New V2', result: baseResult, dataPath });

    const r = await autoMigrateLegacyOnStartup(dataPath);
    assert.equal(r.migrated.length, 2);
    assert.equal(r.alreadyV2, 1);
    assert.ok(r.backupDir);

    // Both legacy folders are now v2 (meta.json present)
    assert.ok(isV2Folder(v1a));
    assert.ok(isV2Folder(v1b));

    // Backup lives OUTSIDE transcriptions/ so Drive sync won't see it.
    assert.ok(r.backupDir!.startsWith(dataPath));
    assert.ok(!r.backupDir!.startsWith(getTranscriptionsDir(dataPath)));

    // Backup contains the original summary.md per legacy folder.
    for (const folderName of r.migrated) {
      assert.ok(
        fs.existsSync(path.join(r.backupDir!, folderName, 'summary.md')),
        `backup should include summary.md for ${folderName}`,
      );
    }
  });

  it('snapshot contains v1 frontmatter (recoverable)', async () => {
    const dataPath = makeTmpDataPath();
    const v1 = __saveTranscriptionLegacyV1ForTests({
      title: 'Recoverable',
      result: baseResult,
      dataPath,
    });

    const r = await autoMigrateLegacyOnStartup(dataPath);
    assert.ok(r.backupDir);

    const backupSummary = fs.readFileSync(
      path.join(r.backupDir!, path.basename(v1), 'summary.md'),
      'utf-8',
    );
    // Original v1 summary.md had YAML frontmatter
    assert.match(backupSummary, /^---\n/);
    assert.match(backupSummary, /title:/);
  });

  it('is idempotent (no-op on second run)', async () => {
    const dataPath = makeTmpDataPath();
    __saveTranscriptionLegacyV1ForTests({
      title: 'Once',
      result: baseResult,
      dataPath,
    });

    const r1 = await autoMigrateLegacyOnStartup(dataPath);
    assert.equal(r1.migrated.length, 1);

    const r2 = await autoMigrateLegacyOnStartup(dataPath);
    assert.equal(r2.migrated.length, 0);
    assert.equal(r2.alreadyV2, 1);
  });

  it('ignores prior .v1-backup-* directories during scan', async () => {
    const dataPath = makeTmpDataPath();
    // Manually drop a `.v1-backup-...` directory inside transcriptions/ to be
    // sure the scan doesn't try to migrate it. (Normally the backup lives at
    // the data-path root, not inside transcriptions/, but we guard anyway.)
    const decoyBackup = path.join(getTranscriptionsDir(dataPath), '.v1-backup-decoy');
    fs.mkdirSync(decoyBackup, { recursive: true });
    fs.writeFileSync(path.join(decoyBackup, 'summary.md'), 'decoy\n', 'utf-8');

    __saveTranscriptionLegacyV1ForTests({ title: 'Real', result: baseResult, dataPath });

    const r = await autoMigrateLegacyOnStartup(dataPath);
    assert.equal(r.migrated.length, 1);
    assert.ok(r.migrated[0].includes('Real'));
  });

  it('preserves data through migration (round-trips via readTranscription)', async () => {
    const dataPath = makeTmpDataPath();
    const v1 = __saveTranscriptionLegacyV1ForTests({
      title: 'Round Trip',
      result: {
        ...baseResult,
        customFields: { decisions: ['ship it'] },
      },
      dataPath,
      liveNotes: [{ offsetMs: 2000, text: 'note' }],
    });

    await autoMigrateLegacyOnStartup(dataPath);

    const data = await readTranscription(v1);
    assert.equal(data!.title, 'Round Trip');
    assert.equal(data!.summary, baseResult.summary);
    assert.deepEqual(data!.keyPoints, baseResult.keyPoints);
    assert.deepEqual(data!.actionItems, baseResult.actionItems);
    assert.deepEqual(data!.customFields, { decisions: ['ship it'] });
    assert.deepEqual(data!.liveNotes, [{ offsetMs: 2000, text: 'note' }]);
  });
});

describe('gcLegacyBackups', () => {
  it('returns 0 when there are no backups', async () => {
    const dataPath = makeTmpDataPath();
    assert.equal(await gcLegacyBackups(dataPath), 0);
  });

  it('preserves recent backups, deletes old ones', async () => {
    const dataPath = makeTmpDataPath();
    const recent = path.join(dataPath, '.v1-backup-recent');
    const stale = path.join(dataPath, '.v1-backup-stale');
    fs.mkdirSync(recent, { recursive: true });
    fs.mkdirSync(stale, { recursive: true });
    // Force stale's mtime to 60 days ago.
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    fs.utimesSync(stale, sixtyDaysAgo, sixtyDaysAgo);

    const removed = await gcLegacyBackups(dataPath, 30);
    assert.equal(removed, 1);
    assert.ok(fs.existsSync(recent), 'recent backup should survive');
    assert.ok(!fs.existsSync(stale), 'stale backup should be removed');
  });

  it('ignores non-backup directories', async () => {
    const dataPath = makeTmpDataPath();
    const transcriptions = getTranscriptionsDir(dataPath);
    fs.mkdirSync(transcriptions, { recursive: true });
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    fs.utimesSync(transcriptions, sixtyDaysAgo, sixtyDaysAgo);

    await gcLegacyBackups(dataPath, 30);
    assert.ok(fs.existsSync(transcriptions), 'transcriptions/ must be untouched');
  });
});

describe('migrate crash-safety and corruption recovery', () => {
  it('detects and migrates a v1 folder whose name matches the v2 timestamp pattern', async () => {
    // Create a normal v1 fixture, then rename its folder so the slug starts
    // with a 24-char ISO timestamp prefix (a v2-shaped name without meta.json).
    const dataPath = makeTmpDataPath();
    const v1OriginalPath = __saveTranscriptionLegacyV1ForTests({
      title: 'Renamed v1',
      result: baseResult,
      dataPath,
    });
    const v2ShapedName = '2026-05-20T10-30-15.123Z_Renamed_v1';
    const v2ShapedPath = path.join(getTranscriptionsDir(dataPath), v2ShapedName);
    fs.renameSync(v1OriginalPath, v2ShapedPath);

    const r = await autoMigrateLegacyOnStartup(dataPath);
    assert.equal(r.migrated.length, 1, 'name-matches-v2 v1 folder must still be migrated');
    assert.ok(isV2Folder(v2ShapedPath), 'folder must end up v2');

    const data = await readTranscription(v2ShapedPath);
    assert.equal(data!.title, 'Renamed v1');
    assert.equal(data!.summary, baseResult.summary);
  });

  it('recovers from .v1-bak siblings left by a previous crashed migration', async () => {
    const dataPath = makeTmpDataPath();
    const folderPath = __saveTranscriptionLegacyV1ForTests({
      title: 'Crash Recovery',
      result: baseResult,
      dataPath,
    });

    // Simulate the on-disk state after a mid-migration crash: v1 summary/transcript
    // renamed to `.v1-bak`, body files replaced with empty v2-shaped scaffold,
    // meta.json never landed.
    const summary = path.join(folderPath, 'summary.md');
    const transcript = path.join(folderPath, 'transcript.md');
    fs.renameSync(summary, `${summary}.v1-bak`);
    fs.renameSync(transcript, `${transcript}.v1-bak`);
    fs.writeFileSync(summary, '', 'utf-8'); // half-written v2 summary
    fs.writeFileSync(transcript, '', 'utf-8');

    // migrateV1ToV2 should detect the .v1-bak siblings, restore originals,
    // then complete the migration cleanly.
    const changed = await migrateV1ToV2(folderPath);
    assert.equal(changed, true);
    assert.ok(isV2Folder(folderPath));
    assert.ok(!fs.existsSync(`${summary}.v1-bak`), '.v1-bak must be cleaned up after success');
    assert.ok(!fs.existsSync(`${transcript}.v1-bak`));

    const data = await readTranscription(folderPath);
    assert.equal(data!.title, 'Crash Recovery');
    assert.equal(data!.summary, baseResult.summary);
    assert.equal(data!.transcript, baseResult.transcript);
  });

  it('writes meta.json atomically (write-to-tmp + rename, no .tmp leftover)', async () => {
    const dataPath = makeTmpDataPath();
    const folderPath = saveTranscription({
      title: 'Atomic Meta',
      result: baseResult,
      dataPath,
    });
    assert.ok(!fs.existsSync(path.join(folderPath, 'meta.json.tmp')));
    assert.ok(fs.existsSync(path.join(folderPath, 'meta.json')));
  });

  it('readTranscription returns null (not throws) on corrupt meta.json', async () => {
    const dataPath = makeTmpDataPath();
    const folderPath = saveTranscription({
      title: 'Corrupt',
      result: baseResult,
      dataPath,
    });
    // Truncate meta.json to invalid JSON.
    fs.writeFileSync(path.join(folderPath, 'meta.json'), '{ not valid json', 'utf-8');
    const data = await readTranscription(folderPath);
    assert.equal(data, null, 'corrupt meta.json must yield null, not throw');
  });
});
