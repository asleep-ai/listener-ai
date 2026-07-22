// Covers the diarized_json response reshape that gpt-4o-transcribe-diarize
// returns. Behavior we lock in:
//   - Re-label OpenAI speaker ids onto our 참가자N convention
//   - Merge consecutive segments from the same speaker onto one line
//   - Empty-string segments are skipped
//   - No segments / no usable text throws the typed EmptyTranscriptionError:
//     whole-file callers surface it as a "no speech found" error (never a
//     blank transcript quietly saved), while per-segment and live-snippet
//     callers convert it to an empty result (issue #182)

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  EmptyTranscriptionError,
  formatDiarizedSegments,
  isDiarizeModel,
  transcribeCodexAudio,
} from './codexTranscription';

describe('isDiarizeModel', () => {
  it('matches the diarize model id', () => {
    assert.equal(isDiarizeModel('gpt-4o-transcribe-diarize'), true);
    assert.equal(isDiarizeModel('  gpt-4o-transcribe-diarize  '), true);
  });

  it('does not match the non-diarize transcription models', () => {
    assert.equal(isDiarizeModel('gpt-4o-transcribe'), false);
    assert.equal(isDiarizeModel('gpt-4o-mini-transcribe'), false);
    assert.equal(isDiarizeModel('whisper-1'), false);
  });
});

describe('formatDiarizedSegments', () => {
  it('maps Speaker 0/1 to 참가자1/2 in first-seen order', () => {
    const out = formatDiarizedSegments([
      { speaker: 'Speaker 0', text: '안녕하세요' },
      { speaker: 'Speaker 1', text: '네 반갑습니다' },
      { speaker: 'Speaker 0', text: '회의 시작하겠습니다' },
    ]);
    assert.equal(
      out,
      '참가자1: 안녕하세요\n\n참가자2: 네 반갑습니다\n\n참가자1: 회의 시작하겠습니다',
    );
  });

  it('merges consecutive segments from the same speaker onto one line', () => {
    const out = formatDiarizedSegments([
      { speaker: 'Speaker 0', text: '첫 문장입니다' },
      { speaker: 'Speaker 0', text: '두 번째 문장입니다' },
      { speaker: 'Speaker 1', text: '제가 답변드릴게요' },
    ]);
    const lines = out.split('\n\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[0], '참가자1: 첫 문장입니다 두 번째 문장입니다');
    assert.equal(lines[1], '참가자2: 제가 답변드릴게요');
  });

  it('honors user-supplied speaker names if OpenAI returns them', () => {
    // When `known_speaker_names[]` is set, OpenAI labels segments with the
    // user-supplied names instead of "Speaker 0/1". Treat each unique label
    // as a new participant in first-seen order, same as the Speaker N path.
    const out = formatDiarizedSegments([
      { speaker: '한결', text: '안녕하세요' },
      { speaker: '주연', text: '안녕하세요' },
    ]);
    assert.equal(out, '참가자1: 안녕하세요\n\n참가자2: 안녕하세요');
  });

  it('drops segments with empty/whitespace-only text', () => {
    const out = formatDiarizedSegments([
      { speaker: 'Speaker 0', text: '' },
      { speaker: 'Speaker 0', text: '   ' },
      { speaker: 'Speaker 1', text: '실제 내용' },
    ]);
    assert.equal(out, '참가자1: 실제 내용');
  });

  it('treats missing speaker as a single "unknown" bucket', () => {
    const out = formatDiarizedSegments([{ text: '첫 번째' }, { text: '두 번째' }]);
    // Same bucket, so segments merge.
    assert.equal(out, '참가자1: 첫 번째 두 번째');
  });

  it('throws a plain Error when the segments field is missing', () => {
    assert.throws(
      () => formatDiarizedSegments(undefined),
      (err: unknown) =>
        err instanceof Error &&
        !(err instanceof EmptyTranscriptionError) &&
        /missing segments/.test(err.message),
    );
  });

  it('throws the typed EmptyTranscriptionError for an empty segments array', () => {
    assert.throws(() => formatDiarizedSegments([]), EmptyTranscriptionError);
  });

  it('throws the typed EmptyTranscriptionError when segments have no usable text', () => {
    assert.throws(() => formatDiarizedSegments([{ text: '   ' }]), EmptyTranscriptionError);
  });

  it('throws when segments are present but all empty', () => {
    assert.throws(
      () =>
        formatDiarizedSegments([
          { speaker: 'Speaker 0', text: '' },
          { speaker: 'Speaker 1', text: '   ' },
        ]),
      /no usable text/,
    );
  });
});

// Signal forwarding: the inline Cancel button only feels responsive when the
// OpenAI multipart POST aborts on the same signal. Without this propagation,
// the upload completes in the background after the user cancelled.
describe('transcribeCodexAudio signal propagation', () => {
  const originalFetch = globalThis.fetch;
  let audioPath = '';

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-signal-'));
    audioPath = path.join(dir, 'clip.webm');
    fs.writeFileSync(audioPath, Buffer.alloc(16, 1));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (audioPath) fs.rmSync(path.dirname(audioPath), { recursive: true, force: true });
  });

  it('aborts the in-flight fetch when the caller signal fires', async () => {
    // Fake fetch that resolves only when the signal aborts.
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) {
          reject(new Error('expected signal to be forwarded into fetch init'));
          return;
        }
        if (sig.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        sig.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        });
      })) as unknown as typeof fetch;

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(
      transcribeCodexAudio({
        getToken: async () => 'fake-token',
        audioFilePath: audioPath,
        model: 'gpt-4o-transcribe',
        signal: controller.signal,
      }),
      (err: unknown) => (err as { name?: unknown } | null)?.name === 'AbortError',
    );
  });
});

// Silence vs malformed-response distinction on the non-diarize path: an empty
// `text` string is a well-formed "no speech" outcome (typed error), while a
// missing/non-string `text` stays a generic malformed-response error.
describe('transcribeCodexAudio empty responses', () => {
  const originalFetch = globalThis.fetch;
  let audioPath = '';

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-empty-'));
    audioPath = path.join(dir, 'clip.webm');
    fs.writeFileSync(audioPath, Buffer.alloc(16, 1));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (audioPath) fs.rmSync(path.dirname(audioPath), { recursive: true, force: true });
  });

  function stubFetchJson(payload: unknown): void {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
  }

  it('throws EmptyTranscriptionError when text is present but empty', async () => {
    stubFetchJson({ text: '   ' });
    await assert.rejects(
      transcribeCodexAudio({
        getToken: async () => 'fake-token',
        audioFilePath: audioPath,
        model: 'gpt-4o-transcribe',
      }),
      EmptyTranscriptionError,
    );
  });

  it('keeps the generic error when text is missing entirely (malformed response)', async () => {
    stubFetchJson({});
    await assert.rejects(
      transcribeCodexAudio({
        getToken: async () => 'fake-token',
        audioFilePath: audioPath,
        model: 'gpt-4o-transcribe',
      }),
      (err: unknown) =>
        err instanceof Error &&
        !(err instanceof EmptyTranscriptionError) &&
        /missing text/.test(err.message),
    );
  });

  it('throws EmptyTranscriptionError for a diarize response with no segments', async () => {
    stubFetchJson({ segments: [] });
    await assert.rejects(
      transcribeCodexAudio({
        getToken: async () => 'fake-token',
        audioFilePath: audioPath,
        model: 'gpt-4o-transcribe-diarize',
      }),
      EmptyTranscriptionError,
    );
  });
});

describe('transcribeCodexAudio temperature', () => {
  const originalFetch = globalThis.fetch;
  let audioPath = '';
  let requestBody: FormData | undefined;

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-temperature-'));
    audioPath = path.join(dir, 'clip.webm');
    fs.writeFileSync(audioPath, Buffer.alloc(16, 1));
    requestBody = undefined;
    globalThis.fetch = (async (_input, init) => {
      requestBody = init?.body as FormData;
      const payload =
        requestBody.get('model') === 'gpt-4o-transcribe-diarize'
          ? { segments: [{ speaker: 'A', text: 'transcript', start: 0, end: 1 }] }
          : { text: 'transcript' };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (audioPath) fs.rmSync(path.dirname(audioPath), { recursive: true, force: true });
  });

  async function transcribe(model: string, temperature?: number): Promise<FormData> {
    await transcribeCodexAudio({
      getToken: async () => 'fake-token',
      audioFilePath: audioPath,
      model,
      temperature,
    });
    assert.ok(requestBody);
    return requestBody;
  }

  it('includes temperature for non-diarize models when set', async () => {
    assert.equal((await transcribe('gpt-4o-transcribe', 0.7)).get('temperature'), '0.7');
  });

  it('omits temperature for non-diarize models when unset', async () => {
    assert.equal((await transcribe('gpt-4o-transcribe')).get('temperature'), null);
  });

  it('omits temperature for the diarize model', async () => {
    assert.equal((await transcribe('gpt-4o-transcribe-diarize', 0.7)).get('temperature'), null);
  });
});
