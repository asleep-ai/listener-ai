import * as fs from 'fs';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import * as path from 'path';
import { GeminiService } from './geminiService';
import { findFfmpegSync, makeOpusWebm, makeTempDir, rmDir } from './test-helpers';

const ffmpegPath = findFfmpegSync();

let workDir: string;

type GeminiServiceFfmpegHelpers = {
  getAudioDuration(audioFilePath: string): Promise<number>;
  splitAudioIntoSegments(audioFilePath: string, segmentDurationSeconds: number): Promise<string[]>;
};

before(() => {
  workDir = makeTempDir('gemini-ffmpeg');
});

after(() => {
  rmDir(workDir);
});

function makeService(): GeminiServiceFfmpegHelpers {
  return new GeminiService({
    apiKey: 'test-key',
    dataPath: workDir,
    proModel: 'gemini-test-pro',
    flashModel: 'gemini-test-flash',
  }) as unknown as GeminiServiceFfmpegHelpers;
}

describe(
  'GeminiService ffmpeg helpers',
  { skip: !ffmpegPath ? 'ffmpeg not installed' : undefined },
  () => {
    it('reads duration for paths containing shell-sensitive quotes', async () => {
      const audioPath = await makeOpusWebm(ffmpegPath!, workDir, 'meeting "final".webm', 440);
      const duration = await makeService().getAudioDuration(audioPath);

      assert.ok(duration > 0.8 && duration < 1.2, `expected ~1s duration, got ${duration}s`);
    });

    it('splits paths containing shell-sensitive quotes into segment files', async () => {
      const audioPath = await makeOpusWebm(ffmpegPath!, workDir, 'segment "source".webm', 550);
      const segmentFiles = await makeService().splitAudioIntoSegments(audioPath, 1);

      assert.ok(segmentFiles.length > 0, 'expected at least one segment');
      for (const segmentFile of segmentFiles) {
        assert.equal(path.dirname(segmentFile), workDir);
        assert.ok(fs.existsSync(segmentFile), `segment should exist: ${segmentFile}`);
      }
    });
  },
);
