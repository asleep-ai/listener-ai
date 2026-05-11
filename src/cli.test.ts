import * as fs from 'fs';
import assert from 'node:assert/strict';
// adb-style integration test: drive the listener CLI as an external process
// (analogous to `adb shell am start INTENT`), with a sandboxed dataPath and
// a stubbed GeminiService, then assert on the resulting transcription folder.
//
// Catches things service-layer tests can't: CLI argument parsing, ref
// resolution, the wiring between CLI -> readTranscription -> concat ->
// transcribe -> saveTranscription, and the mergedFrom round-trip.
import { after, before, describe, it } from 'node:test';
import * as path from 'path';
import { saveTranscription } from './outputService';
import { execFileAsync, findFfmpegSync, makeOpusWebm, makeTempDir, rmDir } from './test-helpers';

const ffmpegPath = findFfmpegSync();

let dataPath: string;
let cliPath: string;

before(() => {
  dataPath = makeTempDir('cli-merge');
  // Compiled CLI lives next to this compiled test under dist/.
  cliPath = path.join(__dirname, 'cli.js');
});

after(() => rmDir(dataPath));

describe('listener CLI basics', () => {
  let basicsDataPath: string;

  before(() => {
    basicsDataPath = makeTempDir('cli-basics');
  });

  after(() => rmDir(basicsDataPath));

  function runCli(
    args: string[],
  ): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve) => {
      const { spawn } = require('child_process') as typeof import('child_process');
      const child = spawn('node', [cliPath, ...args], {
        env: {
          ...process.env,
          NODE_ENV: 'test',
          LISTENER_DATA_PATH: basicsDataPath,
          LISTENER_TEST_MODE: '1',
          GEMINI_API_KEY: 'test-mode-key',
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      child.on('close', (code: number | null) => {
        resolve({ stdout, stderr, code });
      });
    });
  }

  it('--version prints version on stdout and exits 0', async () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'),
    ) as { version: string };
    const { stdout, code } = await runCli(['--version']);
    assert.equal(code, 0);
    assert.equal(stdout.trim(), `listener ${pkg.version}`);
  });

  it('-V is an alias for --version', async () => {
    const { stdout, code } = await runCli(['-V']);
    assert.equal(code, 0);
    assert.match(stdout, /^listener \d/);
  });

  it('--help exits 0 and writes to stdout', async () => {
    const { stdout, stderr, code } = await runCli(['--help']);
    assert.equal(code, 0);
    assert.match(stdout, /Usage: listener/);
    assert.equal(stderr, '');
  });

  it('no args exits 1 and writes to stderr', async () => {
    const { stdout, stderr, code } = await runCli([]);
    assert.equal(code, 1);
    assert.match(stderr, /Usage: listener/);
    assert.equal(stdout, '');
  });

  it('config set + get round-trips knownWords as comma-separated', async () => {
    const set = await runCli(['config', 'set', 'knownWords', 'foo, bar ,baz']);
    assert.equal(set.code, 0);
    const get = await runCli(['config', 'get', 'knownWords']);
    assert.equal(get.code, 0);
    assert.equal(get.stdout.trim(), 'foo,bar,baz');
  });

  it('config set rejects invalid boolean', async () => {
    const { stderr, code } = await runCli(['config', 'set', 'recordSystemAudio', 'yes']);
    assert.equal(code, 1);
    assert.match(stderr, /must be "true" or "false"/);
  });

  it('config set + get round-trips boolean', async () => {
    await runCli(['config', 'set', 'recordSystemAudio', 'true']);
    const { stdout } = await runCli(['config', 'get', 'recordSystemAudio']);
    assert.equal(stdout.trim(), 'true');
  });

  it('config unset clears the stored value', async () => {
    await runCli(['config', 'set', 'geminiModel', 'gemini-2.5-flash']);
    const before = await runCli(['config', 'get', 'geminiModel']);
    assert.equal(before.stdout.trim(), 'gemini-2.5-flash');
    const unset = await runCli(['config', 'unset', 'geminiModel']);
    assert.equal(unset.code, 0);
    const after = await runCli(['config', 'get', 'geminiModel']);
    // Falls back to the default model returned by ConfigService.getGeminiModel().
    assert.equal(after.stdout.trim(), 'gemini-2.5-pro');
  });

  it('config list masks slackWebhookUrl', async () => {
    await runCli([
      'config',
      'set',
      'slackWebhookUrl',
      'https://hooks.slack.com/services/SECRET123',
    ]);
    const { stdout } = await runCli(['config', 'list']);
    const line = stdout.split('\n').find((l) => l.startsWith('slackWebhookUrl='));
    assert.ok(line, 'expected slackWebhookUrl in config list');
    assert.match(line!, /^slackWebhookUrl=\*\*\*\*/);
    assert.doesNotMatch(line!, /SECRET123/);
  });

  it('config unset on unknown key fails with non-zero exit', async () => {
    const { code, stderr } = await runCli(['config', 'unset', 'bogusKey']);
    assert.equal(code, 1);
    assert.match(stderr, /Unknown key/);
  });

  it('--transcript-only skips summary data while saving the transcript', async () => {
    const audioPath = path.join(basicsDataPath, 'sample.mp3');
    const outputDir = path.join(basicsDataPath, 'exports');
    fs.writeFileSync(audioPath, '');

    const { stdout, stderr, code } = await runCli([
      audioPath,
      '--transcript-only',
      '--output',
      outputDir,
    ]);

    assert.equal(code, 0, stderr);
    const folderPath = stdout.trim();
    const transcript = fs.readFileSync(path.join(folderPath, 'transcript.md'), 'utf-8');
    const summary = fs.readFileSync(path.join(folderPath, 'summary.md'), 'utf-8');

    assert.match(transcript, /Stubbed transcript\./);
    assert.doesNotMatch(summary, /Stubbed summary/);
    assert.doesNotMatch(summary, /stub point/);
    assert.doesNotMatch(summary, /stub action/);
    assert.match(stderr, /Skipping summary generation/);
  });
});

describe(
  'listener merge (CLI integration)',
  { skip: !ffmpegPath ? 'ffmpeg not installed' : undefined },
  () => {
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
      assert.ok(
        resultFolder.startsWith(dataPath),
        `result folder must live inside the test dataPath, got ${resultFolder}`,
      );

      const summary = fs.readFileSync(path.join(resultFolder, 'summary.md'), 'utf-8');
      // User-provided --title beats the stub's suggestedTitle.
      assert.match(summary, /^title: Combined Meeting$/m);
      assert.match(summary, /suggestedTitle: Stubbed Title/);
      assert.match(summary, /## Sources/);
      assert.match(summary, new RegExp(folderNameA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(summary, new RegExp(folderNameB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

      const audioLine = summary.match(/^audioFilePath:\s*(.+)$/m);
      const mergedAudioPath = audioLine?.[1].trim().replace(/^"|"$/g, '') ?? '';
      assert.ok(
        mergedAudioPath.endsWith('.webm'),
        `merged audio should be webm, got ${mergedAudioPath}`,
      );
      assert.ok(
        fs.existsSync(mergedAudioPath),
        `merged audio file should exist on disk: ${mergedAudioPath}`,
      );

      assert.ok(fs.existsSync(folderA), 'source folder A should be preserved');
      assert.ok(fs.existsSync(folderB), 'source folder B should be preserved');
    });
  },
);
