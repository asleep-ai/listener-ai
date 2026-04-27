import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import {
  saveTranscription,
  readTranscription,
  parseFrontmatter,
  formatSummary,
  sanitizeForPath,
} from './outputService';
import type { TranscriptionResult } from './geminiService';
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
    assert.deepEqual(data!.mergedFrom, [
      'Part_One_20260101_120000',
      'Part_Two_20260101_130000',
    ]);
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

describe('sanitizeForPath', () => {
  it('replaces filesystem-hostile characters', () => {
    assert.equal(sanitizeForPath('LG : meeting / part 1?'), 'LG _ meeting _ part 1_');
  });

  it('collapses repeated whitespace', () => {
    assert.equal(sanitizeForPath('hello    world'), 'hello world');
  });
});
