import * as fs from 'fs';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import * as path from 'path';
import type { TranscriptionResult } from './geminiService';
import {
  formatSummary,
  parseFrontmatter,
  readTranscription,
  sanitizeForPath,
  saveTranscription,
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
