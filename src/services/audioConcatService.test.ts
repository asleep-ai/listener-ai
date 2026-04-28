import * as fs from 'fs';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import * as os from 'os';
import * as path from 'path';
import {
  ffprobeFor,
  findFfmpegSync,
  getDurationSeconds,
  makeMp3,
  makeOpusWebm,
  makeTempDir,
  rmDir,
} from '../test-helpers';
import { concatAudioFiles } from './audioConcatService';

const ffmpegPath = findFfmpegSync();
const ffprobePath = ffmpegPath ? ffprobeFor(ffmpegPath) : null;

let workDir: string;

before(() => {
  workDir = makeTempDir('concat');
});

after(() => {
  rmDir(workDir);
});

describe('concatAudioFiles', { skip: !ffmpegPath ? 'ffmpeg not installed' : undefined }, () => {
  it('concatenates two same-format webm/opus files via stream-copy fast path', async () => {
    const a = await makeOpusWebm(ffmpegPath!, workDir, 'a.webm', 440);
    const b = await makeOpusWebm(ffmpegPath!, workDir, 'b.webm', 880);
    const out = path.join(workDir, 'merged_copy.webm');

    await concatAudioFiles({ ffmpegPath: ffmpegPath!, inputPaths: [a, b], outputPath: out });

    assert.ok(fs.existsSync(out), 'output file should exist');
    const duration = await getDurationSeconds(ffprobePath!, out);
    assert.ok(duration > 1.8 && duration < 2.2, `expected ~2s output, got ${duration}s`);
  });

  it('falls back to filter path when inputs have mismatched extensions', async () => {
    const opus = await makeOpusWebm(ffmpegPath!, workDir, 'opus.webm', 440);
    const mp3 = await makeMp3(ffmpegPath!, workDir, 'lame.mp3', 880);
    const out = path.join(workDir, 'merged_filter.webm');

    await concatAudioFiles({ ffmpegPath: ffmpegPath!, inputPaths: [opus, mp3], outputPath: out });

    assert.ok(fs.existsSync(out), 'output file should exist');
    const duration = await getDurationSeconds(ffprobePath!, out);
    assert.ok(duration > 1.8 && duration < 2.2, `expected ~2s output, got ${duration}s`);
  });

  it('rejects when fewer than 2 inputs are provided', async () => {
    const a = await makeOpusWebm(ffmpegPath!, workDir, 'solo.webm', 440);
    await assert.rejects(
      () =>
        concatAudioFiles({
          ffmpegPath: ffmpegPath!,
          inputPaths: [a],
          outputPath: path.join(workDir, 'never.webm'),
        }),
      /at least 2 input files/i,
    );
  });

  it('rejects when an input file is missing', async () => {
    const a = await makeOpusWebm(ffmpegPath!, workDir, 'exists.webm', 440);
    const missing = path.join(workDir, 'does-not-exist.webm');
    await assert.rejects(
      () =>
        concatAudioFiles({
          ffmpegPath: ffmpegPath!,
          inputPaths: [a, missing],
          outputPath: path.join(workDir, 'never.webm'),
        }),
      /Input file not found/,
    );
  });

  it('handles input paths that contain a single quote', async () => {
    // ffmpeg's concat demuxer manifest uses single-quoted paths; a literal "'"
    // in the filename must round-trip via the "'\\''" escape sequence.
    const tricky = await makeOpusWebm(ffmpegPath!, workDir, "it's-fine.webm", 440);
    const plain = await makeOpusWebm(ffmpegPath!, workDir, 'plain.webm', 880);
    const out = path.join(workDir, 'merged_quote.webm');

    await concatAudioFiles({
      ffmpegPath: ffmpegPath!,
      inputPaths: [tricky, plain],
      outputPath: out,
    });

    assert.ok(fs.existsSync(out), 'output file should exist');
    const duration = await getDurationSeconds(ffprobePath!, out);
    assert.ok(duration > 1.8 && duration < 2.2, `expected ~2s output, got ${duration}s`);
  });

  it('cleans up the temp manifest file even when ffmpeg fails', async () => {
    // Count only manifest files (prefix listener-concat-<pid>-) so the workDir
    // (prefix listener-concat-test-) doesn't pollute the count.
    const manifestPrefix = `listener-concat-${process.pid}-`;
    const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(manifestPrefix)).length;
    const a = await makeOpusWebm(ffmpegPath!, workDir, 'keep.webm', 440);
    const missing = path.join(workDir, 'nope.webm');
    await assert.rejects(() =>
      concatAudioFiles({
        ffmpegPath: ffmpegPath!,
        inputPaths: [a, missing],
        outputPath: path.join(workDir, 'never.webm'),
      }),
    );
    const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(manifestPrefix)).length;
    assert.equal(after, before, 'manifest file should be cleaned up after failure');
  });
});
