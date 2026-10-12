// Contract tests for the API-key OpenAI batch transcription client. Locks in:
//   - Authorization carries the configured OpenAI API key (never a ChatGPT
//     sign-in token -- this module has no OAuth input at all)
//   - per-model multipart shape documented by the speech-to-text guide
//     (diarize default: diarized_json + chunking_strategy, no prompt/temperature;
//     gpt-transcribe: languages[] instead of language, prompt allowed)
//   - knownWords (prompt) only reaches models that accept prompts
//   - abort forwarding, HTTP error mapping, empty vs malformed responses
//   - diarized_json re-labeling onto 참가자N

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  DEFAULT_OPENAI_TRANSCRIPTION_MODEL,
  formatDiarizedSegments,
  isDiarizeModel,
  supportsTranscriptionPrompt,
  transcribeOpenAiAudio,
} from './openaiTranscription';
import { EmptyTranscriptionError, TranscriptionApiError } from './transcriptionErrors';

interface CapturedRequest {
  url: string;
  headers: Headers;
  body: FormData;
  signal?: AbortSignal | null;
}

const originalFetch = globalThis.fetch;
let audioPath = '';
let captured: CapturedRequest | undefined;

function stubFetch(respond: (req: CapturedRequest) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req: CapturedRequest = {
      url: String(input),
      headers: new Headers(init?.headers),
      body: init?.body as FormData,
      signal: init?.signal,
    };
    captured = req;
    return respond(req);
  }) as typeof fetch;
}

function jsonResponse(
  payload: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function okFor(req: CapturedRequest): Response {
  return req.body.get('model') === 'gpt-4o-transcribe-diarize'
    ? jsonResponse({ segments: [{ speaker: 'A', text: 'transcript', start: 0, end: 1 }] })
    : jsonResponse({ text: 'transcript' });
}

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-stt-'));
  audioPath = path.join(dir, 'clip.webm');
  fs.writeFileSync(audioPath, Buffer.alloc(16, 1));
  captured = undefined;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (audioPath) fs.rmSync(path.dirname(audioPath), { recursive: true, force: true });
});

describe('model capabilities', () => {
  it('defaults to the diarize model so speaker labels are preserved', () => {
    assert.equal(DEFAULT_OPENAI_TRANSCRIPTION_MODEL, 'gpt-4o-transcribe-diarize');
    assert.equal(isDiarizeModel(DEFAULT_OPENAI_TRANSCRIPTION_MODEL), true);
  });

  it('accepts prompts on every documented model except diarize', () => {
    assert.equal(supportsTranscriptionPrompt('gpt-4o-transcribe-diarize'), false);
    for (const model of [
      'gpt-transcribe',
      'gpt-4o-transcribe',
      'gpt-4o-mini-transcribe',
      'whisper-1',
    ]) {
      assert.equal(supportsTranscriptionPrompt(model), true, model);
    }
  });
});

describe('transcribeOpenAiAudio request', () => {
  it('posts to the public transcription endpoint with the API key as bearer', async () => {
    stubFetch(okFor);
    await transcribeOpenAiAudio({
      apiKey: '  sk-test-key  ',
      audioFilePath: audioPath,
      model: 'gpt-4o-transcribe',
    });
    assert.ok(captured);
    assert.equal(captured.url, 'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(captured.headers.get('authorization'), 'Bearer sk-test-key');
    assert.equal(captured.body.get('model'), 'gpt-4o-transcribe');
    const file = captured.body.get('file');
    assert.ok(file instanceof Blob);
    assert.equal((file as File).name, 'clip.webm');
  });

  it('refuses to call the API without a key', async () => {
    let called = false;
    stubFetch((req) => {
      called = true;
      return okFor(req);
    });
    await assert.rejects(
      transcribeOpenAiAudio({
        apiKey: '   ',
        audioFilePath: audioPath,
        model: 'gpt-4o-transcribe',
      }),
      /API key is not configured/,
    );
    assert.equal(called, false);
  });

  it('diarize model: diarized_json + chunking_strategy, drops prompt and temperature', async () => {
    stubFetch(okFor);
    const text = await transcribeOpenAiAudio({
      apiKey: 'sk-test',
      audioFilePath: audioPath,
      model: 'gpt-4o-transcribe-diarize',
      prompt: 'Glossary: Listener.AI',
      language: 'ko',
      temperature: 0.4,
    });
    assert.equal(text, '참가자1: transcript');
    assert.ok(captured);
    assert.equal(captured.body.get('response_format'), 'diarized_json');
    assert.equal(captured.body.get('chunking_strategy'), 'auto');
    assert.equal(captured.body.get('language'), 'ko');
    assert.equal(captured.body.get('prompt'), null);
    assert.equal(captured.body.get('temperature'), null);
  });

  it('gpt-4o-transcribe: forwards knownWords prompt, language and temperature', async () => {
    stubFetch(okFor);
    await transcribeOpenAiAudio({
      apiKey: 'sk-test',
      audioFilePath: audioPath,
      model: 'gpt-4o-transcribe',
      prompt: '  Glossary: Listener.AI  ',
      language: 'ko',
      temperature: 0.7,
    });
    assert.ok(captured);
    assert.equal(captured.body.get('prompt'), 'Glossary: Listener.AI');
    assert.equal(captured.body.get('language'), 'ko');
    assert.equal(captured.body.get('temperature'), '0.7');
    assert.equal(captured.body.get('response_format'), null);
  });

  it('omits temperature when unset', async () => {
    stubFetch(okFor);
    await transcribeOpenAiAudio({
      apiKey: 'sk-test',
      audioFilePath: audioPath,
      model: 'gpt-4o-transcribe',
    });
    assert.equal(captured?.body.get('temperature'), null);
  });

  it('gpt-transcribe: sends languages[] (never language), keeps prompt, omits temperature', async () => {
    stubFetch(okFor);
    await transcribeOpenAiAudio({
      apiKey: 'sk-test',
      audioFilePath: audioPath,
      model: 'gpt-transcribe',
      prompt: 'Glossary',
      language: 'ko',
      temperature: 0.4,
    });
    assert.ok(captured);
    assert.equal(captured.body.get('languages[]'), 'ko');
    assert.equal(captured.body.get('language'), null);
    assert.equal(captured.body.get('prompt'), 'Glossary');
    assert.equal(captured.body.get('temperature'), null);
  });
});

describe('transcribeOpenAiAudio abort', () => {
  it('aborts the in-flight fetch when the caller signal fires', async () => {
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
      transcribeOpenAiAudio({
        apiKey: 'sk-test',
        audioFilePath: audioPath,
        model: 'gpt-4o-transcribe',
        signal: controller.signal,
      }),
      (err: unknown) => (err as { name?: unknown } | null)?.name === 'AbortError',
    );
  });
});

describe('transcribeOpenAiAudio error mapping', () => {
  it('maps a JSON error body to TranscriptionApiError with its fields', async () => {
    stubFetch(() =>
      jsonResponse(
        {
          error: {
            message: 'You exceeded your current quota',
            type: 'insufficient_quota',
            code: 'insufficient_quota',
          },
        },
        429,
        { 'x-request-id': 'req_123' },
      ),
    );
    await assert.rejects(
      transcribeOpenAiAudio({
        apiKey: 'sk-test',
        audioFilePath: audioPath,
        model: 'gpt-4o-transcribe',
      }),
      (err: unknown) => {
        assert.ok(err instanceof TranscriptionApiError);
        assert.equal(err.message, 'You exceeded your current quota');
        assert.equal(err.status, 429);
        assert.equal(err.requestId, 'req_123');
        assert.equal(err.errorType, 'insufficient_quota');
        assert.equal(err.errorCode, 'insufficient_quota');
        return true;
      },
    );
  });

  it('falls back to a status message and caps an opaque body', async () => {
    stubFetch(() => new Response('x'.repeat(2000), { status: 502, statusText: 'Bad Gateway' }));
    await assert.rejects(
      transcribeOpenAiAudio({
        apiKey: 'sk-test',
        audioFilePath: audioPath,
        model: 'gpt-4o-transcribe',
      }),
      (err: unknown) => {
        assert.ok(err instanceof TranscriptionApiError);
        assert.equal(err.message, 'OpenAI transcription failed (502 Bad Gateway)');
        assert.equal(err.rawBody?.length, 1503);
        return true;
      },
    );
  });
});

describe('transcribeOpenAiAudio empty responses', () => {
  it('throws EmptyTranscriptionError when text is present but empty', async () => {
    stubFetch(() => jsonResponse({ text: '   ' }));
    await assert.rejects(
      transcribeOpenAiAudio({
        apiKey: 'sk-test',
        audioFilePath: audioPath,
        model: 'gpt-4o-transcribe',
      }),
      EmptyTranscriptionError,
    );
  });

  it('keeps the generic error when text is missing (malformed response)', async () => {
    stubFetch(() => jsonResponse({}));
    await assert.rejects(
      transcribeOpenAiAudio({
        apiKey: 'sk-test',
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
    stubFetch(() => jsonResponse({ segments: [] }));
    await assert.rejects(
      transcribeOpenAiAudio({
        apiKey: 'sk-test',
        audioFilePath: audioPath,
        model: 'gpt-4o-transcribe-diarize',
      }),
      EmptyTranscriptionError,
    );
  });
});

describe('formatDiarizedSegments', () => {
  it('maps speakers to 참가자N in first-seen order and merges consecutive turns', () => {
    const out = formatDiarizedSegments([
      { speaker: 'A', text: '안녕하세요' },
      { speaker: 'A', text: '회의 시작하겠습니다' },
      { speaker: 'B', text: '네 반갑습니다' },
      { speaker: 'A', text: '좋습니다' },
    ]);
    assert.equal(
      out,
      '참가자1: 안녕하세요 회의 시작하겠습니다\n\n참가자2: 네 반갑습니다\n\n참가자1: 좋습니다',
    );
  });

  it('drops empty segments and treats a missing speaker as one bucket', () => {
    assert.equal(
      formatDiarizedSegments([{ text: '' }, { text: '첫 번째' }, { text: '두 번째' }]),
      '참가자1: 첫 번째 두 번째',
    );
  });

  it('distinguishes malformed (missing) from empty segments', () => {
    assert.throws(
      () => formatDiarizedSegments(undefined),
      (err: unknown) => err instanceof Error && !(err instanceof EmptyTranscriptionError),
    );
    assert.throws(() => formatDiarizedSegments([]), EmptyTranscriptionError);
    assert.throws(
      () => formatDiarizedSegments([{ speaker: 'A', text: '  ' }]),
      EmptyTranscriptionError,
    );
  });
});
