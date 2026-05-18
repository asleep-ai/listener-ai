import * as fs from 'fs';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import * as path from 'path';
import { GeminiService } from './geminiService';
import { findFfmpegSync, makeOpusWebm, makeTempDir, rmDir } from './test-helpers';

const ffmpegPath = findFfmpegSync();

let workDir: string;

type GeminiServiceFfmpegHelpers = {
  getAudioDuration(audioFilePath: string, signal?: AbortSignal): Promise<number>;
  splitAudioIntoSegments(audioFilePath: string, segmentDurationSeconds: number): Promise<string[]>;
  findSegmentFiles(audioFilePath: string, ext?: string): string[];
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

// Abort plumbing: transcribeAudio honors `options.signal` at its very top,
// before the LISTENER_TEST_MODE stub branch. The renderer cancel-button flow
// depends on this -- without it, a pre-aborted signal would still return a
// stubbed transcript and the inline UI would treat cancel as success.
describe('GeminiService transcribeAudio abort plumbing', () => {
  it('throws synchronously when the signal is already aborted', async () => {
    process.env.LISTENER_TEST_MODE = '1';
    process.env.NODE_ENV = 'test';
    try {
      const service = new GeminiService({
        apiKey: 'test-key',
        dataPath: workDir,
        proModel: 'gemini-test-pro',
        flashModel: 'gemini-test-flash',
      });
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        () =>
          service.transcribeAudio('/tmp/doesnt-matter.webm', undefined, undefined, undefined, {
            signal: controller.signal,
          }),
        (err: unknown) => {
          const e = err as { name?: unknown } | null;
          return Boolean(e && (e.name === 'AbortError' || /aborted/i.test(String(err))));
        },
      );
    } finally {
      delete process.env.LISTENER_TEST_MODE;
      delete process.env.NODE_ENV;
    }
  });
});

// findSegmentFiles must be strict on the exact `_segment_NNN.<ext>` pattern.
// A loose prefix match would let cleanup delete real recordings whose user-
// chosen names happen to contain `_segment_` (e.g. `Meeting_segment_notes
// .webm`).
describe('GeminiService.findSegmentFiles bounds', () => {
  it('only matches ffmpeg-formatted segment files, not user-named lookalikes', () => {
    const dir = makeTempDir('seg-bounds');
    try {
      const sourceAudio = path.join(dir, 'Meeting.webm');
      fs.writeFileSync(sourceAudio, '');
      // Real ffmpeg-formatted segments (should match).
      fs.writeFileSync(path.join(dir, 'Meeting_segment_000.webm'), '');
      fs.writeFileSync(path.join(dir, 'Meeting_segment_007.webm'), '');
      // User-named files that share a prefix but are NOT segments.
      fs.writeFileSync(path.join(dir, 'Meeting_segment_notes.webm'), '');
      fs.writeFileSync(path.join(dir, 'Meeting_segment_001.txt.webm'), '');
      fs.writeFileSync(path.join(dir, 'Meeting_segment_1.webm'), '');
      // Unrelated recording with similar name (different base).
      fs.writeFileSync(path.join(dir, 'MeetingX_segment_000.webm'), '');

      const helpers = new GeminiService({
        apiKey: 'test-key',
        dataPath: workDir,
        proModel: 'gemini-test-pro',
        flashModel: 'gemini-test-flash',
      }) as unknown as GeminiServiceFfmpegHelpers;
      const matches = helpers.findSegmentFiles(sourceAudio).map((p) => path.basename(p));
      assert.deepEqual(matches.sort(), ['Meeting_segment_000.webm', 'Meeting_segment_007.webm']);
    } finally {
      rmDir(dir);
    }
  });

  it('respects the extension filter when supplied', () => {
    const dir = makeTempDir('seg-ext');
    try {
      const sourceAudio = path.join(dir, 'Talk.mp3');
      fs.writeFileSync(sourceAudio, '');
      fs.writeFileSync(path.join(dir, 'Talk_segment_000.webm'), '');
      fs.writeFileSync(path.join(dir, 'Talk_segment_000.mp3'), '');

      const helpers = new GeminiService({
        apiKey: 'test-key',
        dataPath: workDir,
        proModel: 'gemini-test-pro',
        flashModel: 'gemini-test-flash',
      }) as unknown as GeminiServiceFfmpegHelpers;
      const onlyWebm = helpers.findSegmentFiles(sourceAudio, '.webm').map((p) => path.basename(p));
      assert.deepEqual(onlyWebm, ['Talk_segment_000.webm']);
    } finally {
      rmDir(dir);
    }
  });
});

// getAudioDuration's catch blocks normally swallow ffmpeg failures to keep
// the pipeline moving on a malformed file. They must NOT swallow aborts --
// the surrounding cancel flow depends on a thrown AbortError to short-circuit.
describe(
  'GeminiService.getAudioDuration re-throws aborts',
  { skip: !ffmpegPath ? 'ffmpeg not installed' : undefined },
  () => {
    it('throws when called with a pre-aborted signal', async () => {
      const audioPath = await makeOpusWebm(ffmpegPath!, workDir, 'duration-abort.webm', 440);
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        () => makeService().getAudioDuration(audioPath, controller.signal),
        (err: unknown) => {
          const e = err as { name?: unknown } | null;
          return Boolean(e && e.name === 'AbortError');
        },
      );
    });
  },
);
