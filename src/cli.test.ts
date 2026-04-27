// adb-style integration test: drive the listener CLI as an external process
// (analogous to `adb shell am start INTENT`), with a sandboxed dataPath and
// a stubbed GeminiService, then assert on the resulting transcription folder.
//
// Catches things service-layer tests can't: CLI argument parsing, ref
// resolution, the wiring between CLI -> readTranscription -> concat ->
// transcribe -> saveTranscription, and the mergedFrom round-trip.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import {
  execFileAsync,
  findFfmpegSync,
  makeTempDir,
  rmDir,
  makeOpusWebm,
} from './test-helpers';
import { saveTranscription } from './outputService';

const ffmpegPath = findFfmpegSync();

let dataPath: string;
let cliPath: string;

before(() => {
  dataPath = makeTempDir('cli-merge');
  // Compiled CLI lives next to this compiled test under dist/.
  cliPath = path.join(__dirname, 'cli.js');
});

after(() => rmDir(dataPath));

describe('listener merge (CLI integration)', { skip: !ffmpegPath ? 'ffmpeg not installed' : undefined }, () => {
  it('merges two transcribed sources end-to-end and writes mergedFrom frontmatter', async () => {
    const recordingsDir = path.join(dataPath, 'recordings');
    fs.mkdirSync(recordingsDir, { recursive: true });

    const audioA = await makeOpusWebm(ffmpegPath!, recordingsDir, 'partA.webm', 440);
    const audioB = await makeOpusWebm(ffmpegPath!, recordingsDir, 'partB.webm', 880);

    const folderA = saveTranscription({
      title: 'Part One',
      result: {
        transcript: 'Part one body.',
        summary: 'Part one summary.',
        keyPoints: ['a1'],
        actionItems: ['a-action'],
        emoji: 'A',
        suggestedTitle: 'Part One',
      },
      audioFilePath: audioA,
      dataPath,
    });
    const folderB = saveTranscription({
      title: 'Part Two',
      result: {
        transcript: 'Part two body.',
        summary: 'Part two summary.',
        keyPoints: ['b1'],
        actionItems: ['b-action'],
        emoji: 'B',
        suggestedTitle: 'Part Two',
      },
      audioFilePath: audioB,
      dataPath,
    });

    const folderNameA = path.basename(folderA);
    const folderNameB = path.basename(folderB);

    const env = {
      ...process.env,
      NODE_ENV: 'test',
      LISTENER_DATA_PATH: dataPath,
      LISTENER_TEST_MODE: '1',
      GEMINI_API_KEY: 'test-mode-key',
    };

    const { stdout } = await execFileAsync(
      'node',
      [cliPath, 'merge', folderNameA, folderNameB, '--title', 'Combined Meeting'],
      { env },
    );

    const resultFolder = stdout.trim();
    assert.ok(fs.existsSync(resultFolder), `result folder ${resultFolder} should exist`);
    assert.ok(resultFolder.startsWith(dataPath), `result folder must live inside the test dataPath, got ${resultFolder}`);

    const summary = fs.readFileSync(path.join(resultFolder, 'summary.md'), 'utf-8');
    // User-provided --title beats the stub's suggestedTitle.
    assert.match(summary, /^title: Combined Meeting$/m);
    assert.match(summary, /suggestedTitle: Stubbed Title/);
    assert.match(summary, /## Sources/);
    assert.match(summary, new RegExp(folderNameA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(summary, new RegExp(folderNameB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const audioLine = summary.match(/^audioFilePath:\s*(.+)$/m);
    const mergedAudioPath = audioLine?.[1].trim().replace(/^"|"$/g, '') ?? '';
    assert.ok(mergedAudioPath.endsWith('.webm'), `merged audio should be webm, got ${mergedAudioPath}`);
    assert.ok(fs.existsSync(mergedAudioPath), `merged audio file should exist on disk: ${mergedAudioPath}`);

    assert.ok(fs.existsSync(folderA), 'source folder A should be preserved');
    assert.ok(fs.existsSync(folderB), 'source folder B should be preserved');
  });
});
