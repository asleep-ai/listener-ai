import { execFile } from 'child_process';
import * as fs from 'fs';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import * as path from 'path';
import { EmptyTranscriptionError } from './codexTranscription';
import { GeminiService, computeSegmentPlan } from './geminiService';
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

// Repetition/hallucination quality gate wiring (issue #182). The analyzer
// itself is covered in transcriptQuality.test.ts; here we lock in how
// transcribeSingleSegment drives it: sentinel stripping, one context-cleared
// retry on flagged output, retry disabled for live-snippet callers, and a
// silent segment resolving to an empty (not failed) segment.
describe('GeminiService transcribeSingleSegment quality gate', () => {
  type SegmentHelpers = {
    transcribeSegmentRaw(
      segmentFile: string,
      promptText: string,
      segmentSeconds: number,
      signal?: AbortSignal,
      session?: unknown,
      temperature?: number,
    ): Promise<string>;
    transcribeSingleSegment(
      segmentFile: string,
      segmentIndex: number,
      totalSegments: number,
      segmentStartTime: number,
      segmentEndTime: number,
      customPrompt?: string,
      signal?: AbortSignal,
      session?: unknown,
      includeGlossary?: boolean,
      qualityRetry?: boolean,
    ): Promise<{ index: number; header: string; body: string; empty: boolean }>;
    measureMaxVolumeDb(audioFilePath: string, signal?: AbortSignal): Promise<number | null>;
  };

  const loopText = Array(5).fill('참가자1: 시청해주셔서 감사합니다.').join('\n');
  const cleanText = '참가자1: 오늘 회의를 시작하겠습니다.';

  function makeGatedService(outputs: (string | Error)[]): {
    service: SegmentHelpers;
    prompts: string[];
    temperatures: (number | undefined)[];
  } {
    const prompts: string[] = [];
    const temperatures: (number | undefined)[] = [];
    const service = new GeminiService({
      apiKey: 'test-key',
      dataPath: workDir,
      proModel: 'gemini-test-pro',
      flashModel: 'gemini-test-flash',
    }) as unknown as SegmentHelpers;
    // Fail-open volume measurement: these tests exercise the text gate, not
    // the energy gate, and must not shell out to a real ffmpeg binary.
    service.measureMaxVolumeDb = async () => null;
    let call = 0;
    service.transcribeSegmentRaw = async (
      _file,
      promptText,
      _seconds,
      _signal,
      _session,
      temperature,
    ) => {
      prompts.push(promptText);
      temperatures.push(temperature);
      const output = outputs[Math.min(call, outputs.length - 1)];
      call++;
      if (output instanceof Error) throw output;
      return output;
    };
    return { service, prompts, temperatures };
  }

  it('replaces a flagged segment with the clean context-cleared retry result', async () => {
    const { service, prompts, temperatures } = makeGatedService([loopText, loopText, cleanText]);
    const result = await service.transcribeSingleSegment('/tmp/seg.webm', 0, 2, 0, 300);

    assert.equal(prompts.length, 3, 'flagged output must advance through both retry rungs');
    assert.match(prompts[0], /Audio segment 1 of 2/);
    for (const prompt of prompts.slice(1)) {
      assert.doesNotMatch(prompt, /Audio segment/, 'retry prompt must drop positional context');
      assert.doesNotMatch(
        prompt,
        /proper nouns, names, and terms/,
        'retry prompt must drop glossary',
      );
    }
    assert.deepEqual(temperatures, [undefined, 0.4, 0.8]);
    assert.ok(result.body.includes(cleanText));
    assert.ok(!result.body.includes('시청해주셔서'));
  });

  it('stops after the low-temperature rung produces clean output', async () => {
    const { service, prompts, temperatures } = makeGatedService([loopText, cleanText]);
    const result = await service.transcribeSingleSegment('/tmp/seg.webm', 0, 2, 0, 300);

    assert.equal(prompts.length, 2);
    assert.deepEqual(temperatures, [undefined, 0.4]);
    assert.ok(result.body.includes(cleanText));
  });

  it('keeps flagged output without retrying when qualityRetry is disabled', async () => {
    const { service, prompts } = makeGatedService([loopText, cleanText]);
    const result = await service.transcribeSingleSegment(
      '/tmp/seg.webm',
      0,
      2,
      0,
      300,
      undefined,
      undefined,
      undefined,
      true,
      false,
    );

    assert.equal(prompts.length, 1);
    assert.ok(result.body.includes('시청해주셔서'));
  });

  it('does not retry clean output', async () => {
    const { service, prompts } = makeGatedService([cleanText]);
    const result = await service.transcribeSingleSegment('/tmp/seg.webm', 1, 3, 300, 600);

    assert.equal(prompts.length, 1);
    assert.ok(result.body.includes(cleanText));
    assert.equal(result.empty, false);
  });

  it('resolves the no-speech sentinel to an empty segment', async () => {
    const { service, prompts } = makeGatedService(['[NO_SPEECH]']);
    const result = await service.transcribeSingleSegment('/tmp/seg.webm', 0, 2, 0, 300);

    assert.equal(prompts.length, 1);
    assert.equal(result.empty, true);
    assert.equal(result.body, '');
    assert.match(result.header, /^\[Segment 1: /);
  });

  it('treats a typed empty-transcription error as a silent segment, not a failure', async () => {
    const { service, prompts } = makeGatedService([new EmptyTranscriptionError('no segments')]);
    const result = await service.transcribeSingleSegment('/tmp/seg.webm', 2, 4, 600, 900);

    assert.equal(prompts.length, 1, 'a silent segment must not burn provider retries');
    assert.equal(result.empty, true);
    assert.equal(result.index, 2);
  });

  it('keeps the first result when the quality retry is still flagged', async () => {
    const otherLoop = `참가자1: ${Array(12).fill('자막').join(' ')}`;
    const { service, prompts } = makeGatedService([loopText, otherLoop, otherLoop]);
    const result = await service.transcribeSingleSegment('/tmp/seg.webm', 0, 1, 0, 300);

    assert.equal(prompts.length, 3);
    assert.ok(result.body.includes('시청해주셔서'), 'first result is retained');
    assert.ok(!result.body.includes('자막'));
  });
});

// transcribeLiveSnippet maps the typed no-speech error to '' so a silent 12s
// live chunk is a clean no-op instead of a renderer error toast.
describe('GeminiService.transcribeLiveSnippet empty handling', () => {
  it('returns an empty string when transcription reports no speech', async () => {
    const service = new GeminiService({
      apiKey: 'test-key',
      dataPath: workDir,
      proModel: 'gemini-test-pro',
      flashModel: 'gemini-test-flash',
    });
    const originalTranscribeAudio = service.transcribeAudio.bind(service);
    service.transcribeAudio = async () => {
      throw new EmptyTranscriptionError('OpenAI diarized transcription returned no segments');
    };
    try {
      assert.equal(await service.transcribeLiveSnippet('/tmp/silent.webm'), '');
    } finally {
      service.transcribeAudio = originalTranscribeAudio;
    }
  });

  it('returns an empty string when the no-speech error arrives wrapped', async () => {
    const service = new GeminiService({
      apiKey: 'test-key',
      dataPath: workDir,
      proModel: 'gemini-test-pro',
      flashModel: 'gemini-test-flash',
    });
    const originalTranscribeAudio = service.transcribeAudio.bind(service);
    service.transcribeAudio = async () => {
      throw new Error('wrapped', { cause: new EmptyTranscriptionError('no speech') });
    };
    try {
      assert.equal(await service.transcribeLiveSnippet('/tmp/silent.webm'), '');
    } finally {
      service.transcribeAudio = originalTranscribeAudio;
    }
  });
});

// Final-stage quality pass wiring (issue #182): after the batch transcript is
// assembled, transcribeWithTwoSteps runs the deterministic analyzer, cleans
// model-judged artifacts, and asks the summary model for quality notes. The
// resulting quality actions persist via customFields.transcriptQuality.
describe('GeminiService transcribeWithTwoSteps final-stage quality pass', () => {
  type TwoStepHelpers = {
    transcribeWithTwoSteps(
      audioFilePath: string,
      duration: number,
      progressCallback?: (percent: number, message: string) => void,
      customSummaryPrompt?: string,
      liveNotes?: undefined,
      options?: { signal?: AbortSignal; transcriptOnly?: boolean },
    ): Promise<{
      transcript: string;
      summary: string;
      customFields?: Record<string, unknown>;
    }>;
    getShortAudioTranscript(...args: unknown[]): Promise<string>;
    cleanTranscriptWithModel(
      transcript: string,
      signal?: AbortSignal,
    ): Promise<{ text: string; removedChars: number }>;
    generateSummary(promptText: string, transcript: string, ...rest: unknown[]): Promise<string>;
  };

  function makeTwoStepService(opts: { transcript: string; summaryJson: string }): {
    service: TwoStepHelpers;
    summaryPrompts: string[];
  } {
    const summaryPrompts: string[] = [];
    const service = new GeminiService({
      apiKey: 'test-key',
      dataPath: workDir,
      proModel: 'gemini-test-pro',
      flashModel: 'gemini-test-flash',
    }) as unknown as TwoStepHelpers;
    service.getShortAudioTranscript = async () => opts.transcript;
    service.cleanTranscriptWithModel = async (transcript) => ({
      text: transcript,
      removedChars: 0,
    });
    service.generateSummary = async (promptText) => {
      summaryPrompts.push(promptText);
      return opts.summaryJson;
    };
    return { service, summaryPrompts };
  }

  function makeAudioStub(name: string): string {
    const filePath = path.join(workDir, name);
    fs.writeFileSync(filePath, Buffer.alloc(64, 1));
    return filePath;
  }

  it('persists analyzer verdict and model notes on customFields for a loop transcript', async () => {
    const loopTranscript = Array(5).fill('참가자1: 시청해주셔서 감사합니다.').join('\n\n');
    const { service, summaryPrompts } = makeTwoStepService({
      transcript: loopTranscript,
      summaryJson: JSON.stringify({
        suggestedTitle: '제목',
        summary: '요약',
        keyPoints: [],
        actionItems: [],
        emoji: '📝',
        transcriptQualityNotes: ['후반부에 동일 문장이 반복됩니다.'],
      }),
    });

    const result = await service.transcribeWithTwoSteps(makeAudioStub('loop.webm'), 10);

    assert.ok(
      summaryPrompts[0].includes('transcriptQualityNotes'),
      'summary prompt must request the artifact review',
    );
    const quality = result.customFields?.transcriptQuality as
      | { analyzer?: { reasons: string[] }; modelNotes?: string[] }
      | undefined;
    assert.ok(quality, 'transcriptQuality must be persisted');
    assert.ok(quality.analyzer?.reasons.includes('consecutive-duplicate-lines'));
    assert.deepEqual(quality.modelNotes, ['후반부에 동일 문장이 반복됩니다.']);
    assert.equal(result.transcript, loopTranscript, 'unchanged cleanup must preserve transcript');
  });

  it('adds no transcriptQuality field for a clean transcript with no model notes', async () => {
    const { service } = makeTwoStepService({
      transcript: '참가자1: 오늘 회의를 시작하겠습니다.\n\n참가자2: 네, 준비되었습니다.',
      summaryJson: JSON.stringify({
        suggestedTitle: '제목',
        summary: '요약',
        keyPoints: ['a'],
        actionItems: [],
        emoji: '📝',
      }),
    });

    const result = await service.transcribeWithTwoSteps(makeAudioStub('clean.webm'), 10);

    assert.equal(result.customFields, undefined);
  });

  it('keeps model notes even when the analyzer sees nothing (semantic-only catch)', async () => {
    const { service } = makeTwoStepService({
      transcript: '참가자1: 오늘 회의를 시작하겠습니다.',
      summaryJson: JSON.stringify({
        suggestedTitle: '제목',
        summary: '요약',
        keyPoints: [],
        actionItems: [],
        emoji: '📝',
        transcriptQualityNotes: ['도입부 문장이 맥락과 무관한 상투구로 보입니다.'],
      }),
    });

    const result = await service.transcribeWithTwoSteps(makeAudioStub('semantic.webm'), 10);

    const quality = result.customFields?.transcriptQuality as
      | { analyzer?: unknown; modelNotes?: string[] }
      | undefined;
    assert.ok(quality);
    assert.equal(quality.analyzer, undefined);
    assert.deepEqual(quality.modelNotes, ['도입부 문장이 맥락과 무관한 상투구로 보입니다.']);
  });

  it('summarizes and returns cleaned text and persists the cleanup count', async () => {
    const { service } = makeTwoStepService({
      transcript: Array(5).fill('참가자1: 반복 문장입니다.').join('\n'),
      summaryJson: JSON.stringify({
        suggestedTitle: '제목',
        summary: '요약',
        keyPoints: [],
        actionItems: [],
        emoji: '📝',
      }),
    });
    const cleanedTranscript = '참가자1: 정리된 전사입니다.';
    let summaryTranscript = '';
    service.cleanTranscriptWithModel = async () => ({ text: cleanedTranscript, removedChars: 42 });
    service.generateSummary = async (_promptText, transcript) => {
      summaryTranscript = transcript;
      return JSON.stringify({
        suggestedTitle: '제목',
        summary: '요약',
        keyPoints: [],
        actionItems: [],
        emoji: '📝',
      });
    };

    const result = await service.transcribeWithTwoSteps(makeAudioStub('cleaned-loop.webm'), 10);

    assert.equal(result.transcript, cleanedTranscript);
    assert.equal(summaryTranscript, cleanedTranscript);
    const quality = result.customFields?.transcriptQuality as {
      modelCleanup?: { removedChars: number };
    };
    assert.equal(quality.modelCleanup?.removedChars, 42);
  });

  it('does not clean transcript-only output', async () => {
    const rawTranscript = '참가자1: 원본 전사입니다.';
    const { service } = makeTwoStepService({ transcript: rawTranscript, summaryJson: '{}' });
    service.cleanTranscriptWithModel = async () => {
      throw new Error('cleanup must not be called');
    };

    const result = await service.transcribeWithTwoSteps(
      makeAudioStub('transcript-only.webm'),
      10,
      undefined,
      undefined,
      undefined,
      { transcriptOnly: true },
    );

    assert.equal(result.transcript, rawTranscript);
  });
});

describe('GeminiService LLM transcript cleanup', () => {
  type CleanupHelpers = {
    completeTextTask(
      systemPrompt: string,
      promptText: string,
      opts: { temperature?: number },
    ): Promise<string>;
    cleanTranscriptWithModel(
      transcript: string,
      signal?: AbortSignal,
    ): Promise<{ text: string; removedChars: number }>;
  };

  function makeCleanupService(): CleanupHelpers {
    return new GeminiService({
      apiKey: 'test-key',
      dataPath: workDir,
      proModel: 'gemini-test-pro',
      flashModel: 'gemini-test-flash',
    }) as unknown as CleanupHelpers;
  }

  it('returns model-cleaned text with the removed character count', async () => {
    const service = makeCleanupService();
    const original = '참가자1: 반복입니다.\n참가자1: 반복입니다.';
    const cleaned = '참가자1: 반복입니다.';
    service.completeTextTask = async (systemPrompt, _promptText, opts) => {
      assert.match(systemPrompt, /post-processor/);
      assert.equal(opts.temperature, 0);
      return cleaned;
    };

    assert.deepEqual(await service.cleanTranscriptWithModel(original), {
      text: cleaned,
      removedChars: original.length - cleaned.length,
    });
  });

  it('keeps the original transcript when the model request fails', async () => {
    const service = makeCleanupService();
    const original = '참가자1: 원본입니다.';
    service.completeTextTask = async () => {
      throw new Error('network failed');
    };

    assert.deepEqual(await service.cleanTranscriptWithModel(original), {
      text: original,
      removedChars: 0,
    });
  });

  it('keeps the original transcript when the model returns empty text', async () => {
    const service = makeCleanupService();
    const original = '참가자1: 원본입니다.';
    service.completeTextTask = async () => '';

    assert.deepEqual(await service.cleanTranscriptWithModel(original), {
      text: original,
      removedChars: 0,
    });
  });

  it('strips a single wrapping code fence', async () => {
    const service = makeCleanupService();
    const original = '참가자1: 반복입니다.\n참가자1: 반복입니다.';
    const cleaned = '참가자1: 반복입니다.';
    service.completeTextTask = async () => `\`\`\`\n${cleaned}\n\`\`\``;

    assert.deepEqual(await service.cleanTranscriptWithModel(original), {
      text: cleaned,
      removedChars: original.length - cleaned.length,
    });
  });
});

// Segmentation plan for overlapped cutting (issue #182 boundary root fix):
// segment 0 starts at zero, every later segment starts early by the overlap
// (capped at a quarter of the segment length), the last segment runs to EOF.
describe('computeSegmentPlan', () => {
  it('plans a 310s file as one full segment plus an overlapped tail', () => {
    assert.deepEqual(computeSegmentPlan(310, 300), [{ start: 0, length: 300 }, { start: 285 }]);
  });

  it('plans a 650s file with overlapped middles', () => {
    assert.deepEqual(computeSegmentPlan(650, 300), [
      { start: 0, length: 300 },
      { start: 285, length: 315 },
      { start: 585 },
    ]);
  });

  it('caps the overlap for small segment durations', () => {
    // floor(2/4) = 0 -> tiny segments cut back-to-back without overlap.
    assert.deepEqual(computeSegmentPlan(5, 2), [
      { start: 0, length: 2 },
      { start: 2, length: 2 },
      { start: 4 },
    ]);
  });
});

describe(
  'GeminiService overlapped segmentation and silence gate (real ffmpeg)',
  { skip: !ffmpegPath ? 'ffmpeg not installed' : undefined },
  () => {
    type EnergyHelpers = {
      transcribeSegmentRaw(...args: unknown[]): Promise<string>;
      transcribeSingleSegment(
        segmentFile: string,
        segmentIndex: number,
        totalSegments: number,
        segmentStartTime: number,
        segmentEndTime: number,
      ): Promise<{ index: number; header: string; body: string; empty: boolean }>;
      measureMaxVolumeDb(audioFilePath: string): Promise<number | null>;
      splitAudioIntoSegments(
        audioFilePath: string,
        segmentDuration: number,
        reencode: boolean,
        signal: undefined,
        duration: number,
      ): Promise<string[]>;
      getAudioDuration(audioFilePath: string): Promise<number>;
    };

    function makeEnergyService(): EnergyHelpers {
      return new GeminiService({
        apiKey: 'test-key',
        dataPath: workDir,
        proModel: 'gemini-test-pro',
        flashModel: 'gemini-test-flash',
      }) as unknown as EnergyHelpers;
    }

    async function makeFixture(name: string, source: string, seconds: number): Promise<string> {
      const filePath = path.join(workDir, name);
      await new Promise<void>((resolve, reject) => {
        execFile(
          ffmpegPath!,
          ['-y', '-f', 'lavfi', '-i', source, '-t', String(seconds), '-c:a', 'libopus', filePath],
          (err) => (err ? reject(err) : resolve()),
        );
      });
      return filePath;
    }

    it('cuts overlapped segments matching the plan durations', async () => {
      const audioPath = await makeFixture('overlap-src.webm', 'sine=frequency=440', 10);
      const service = makeEnergyService();
      // segmentDuration 4 -> overlap min(15, 1) = 1 -> plan [{0,4},{3,5},{7}].
      const segments = await service.splitAudioIntoSegments(audioPath, 4, false, undefined, 10);

      assert.deepEqual(
        segments.map((p) => path.basename(p)),
        [
          'overlap-src_segment_000.webm',
          'overlap-src_segment_001.webm',
          'overlap-src_segment_002.webm',
        ],
      );
      const durations = [];
      for (const segment of segments) {
        durations.push(await service.getAudioDuration(segment));
      }
      const expected = [4, 5, 3];
      durations.forEach((actual, i) => {
        assert.ok(
          Math.abs(actual - expected[i]) <= 0.8,
          `segment ${i} duration ${actual}s should be ~${expected[i]}s`,
        );
      });
      for (const segment of segments) fs.unlinkSync(segment);
    });

    it('skips provider calls for a digitally silent segment', async () => {
      const audioPath = await makeFixture('silent.webm', 'anullsrc=r=48000:cl=mono', 2);
      const service = makeEnergyService();
      let rawCalls = 0;
      service.transcribeSegmentRaw = async () => {
        rawCalls++;
        return 'should not be called';
      };

      const result = await service.transcribeSingleSegment(audioPath, 0, 1, 0, 2);

      assert.equal(rawCalls, 0, 'silent audio must never reach a provider');
      assert.equal(result.empty, true);
      assert.equal(result.body, '');
    });

    it('still transcribes audio with real signal', async () => {
      const audioPath = await makeFixture('tone.webm', 'sine=frequency=440', 2);
      const service = makeEnergyService();
      let rawCalls = 0;
      service.transcribeSegmentRaw = async () => {
        rawCalls++;
        return '참가자1: 오늘 회의를 시작하겠습니다.';
      };

      const result = await service.transcribeSingleSegment(audioPath, 0, 1, 0, 2);

      assert.equal(rawCalls, 1);
      assert.equal(result.empty, false);
    });

    it('fails open (null) when volume cannot be measured', async () => {
      const service = makeEnergyService();
      assert.equal(
        await service.measureMaxVolumeDb(path.join(workDir, 'does-not-exist.webm')),
        null,
      );
    });
  },
);
