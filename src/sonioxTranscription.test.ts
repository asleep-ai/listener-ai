// Covers the async (batch) Soniox job lifecycle. Behavior locked in here:
//   - upload -> create -> poll -> transcript, then DELETE both server-side
//     objects on every exit path (quota: 2,000 jobs / 1,000 stored files)
//   - token rendering onto the shared 참가자N convention, with speaker ids
//     renumbered by first appearance and audio events dropped
//   - HTTP and job-level failures surface as TranscriptionApiError carrying
//     the status/error type/request id triage needs
//   - no-speech audio surfaces as the typed EmptyTranscriptionError
//
// Every request goes through an injected fetch, so nothing here touches the
// network and no API key is ever logged.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  formatSonioxTokens,
  SONIOX_MAX_FILE_SECONDS,
  SONIOX_TRANSCRIPTION_EXTENSIONS,
  transcribeSonioxAudio,
  type SonioxAsyncToken,
} from './sonioxTranscription';
import { EmptyTranscriptionError, TranscriptionApiError } from './transcriptionErrors';

const API_KEY = 'soniox-test-key';
const FILE_ID = 'file_123';
const TRANSCRIPTION_ID = 'tr_456';

interface RecordedCall {
  method: string;
  url: string;
  authorization?: string;
  hasSignal: boolean;
  signal?: AbortSignal | null;
  body?: unknown;
}

interface ScriptOptions {
  /** Status payloads returned by successive GET /v1/transcriptions/{id} calls. */
  statuses?: unknown[];
  transcript?: unknown;
  uploadResponse?: () => Response;
  createResponse?: () => Response;
  transcriptResponse?: () => Response;
  deleteResponse?: (resource: 'transcription' | 'file') => Response;
}

function json(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

// Routes by method+path rather than call index so a test that changes the
// number of polls doesn't have to re-count the whole script, while `calls`
// still records the exact sequence for ordering assertions.
function scriptFetch(options: ScriptOptions = {}): {
  impl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const statuses = [...(options.statuses ?? [{ status: 'completed' }])];

  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : String(input);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    let body: unknown;
    if (typeof init?.body === 'string') {
      body = JSON.parse(init.body);
    } else if (init?.body instanceof FormData) {
      body = init.body;
    }
    calls.push({
      method,
      url,
      authorization: headers.Authorization,
      hasSignal: Boolean(init?.signal),
      signal: init?.signal,
      body,
    });

    if (method === 'POST' && url.endsWith('/v1/files')) {
      return options.uploadResponse?.() ?? json({ id: FILE_ID });
    }
    if (method === 'POST' && url.endsWith('/v1/transcriptions')) {
      return options.createResponse?.() ?? json({ id: TRANSCRIPTION_ID, status: 'queued' });
    }
    if (method === 'GET' && url.endsWith(`/v1/transcriptions/${TRANSCRIPTION_ID}`)) {
      const next = statuses.length > 1 ? statuses.shift() : statuses[0];
      return json(next);
    }
    if (method === 'GET' && url.endsWith('/transcript')) {
      return (
        options.transcriptResponse?.() ??
        json(options.transcript ?? { tokens: [{ text: 'hello', speaker: '1' }] })
      );
    }
    if (method === 'DELETE' && url.includes('/v1/transcriptions/')) {
      return options.deleteResponse?.('transcription') ?? new Response(null, { status: 204 });
    }
    if (method === 'DELETE' && url.includes('/v1/files/')) {
      return options.deleteResponse?.('file') ?? new Response(null, { status: 204 });
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  }) as unknown as typeof fetch;

  return { impl, calls };
}

function steps(calls: RecordedCall[]): string[] {
  return calls.map((call) => `${call.method} ${call.url.replace('https://api.soniox.com', '')}`);
}

describe('formatSonioxTokens', () => {
  it('groups consecutive tokens per speaker and renumbers ids by first appearance', () => {
    // Soniox speaker ids are arbitrary strings; "3" speaking first becomes 참가자1.
    const out = formatSonioxTokens([
      { text: '안녕하세요', speaker: '3' },
      { text: ' 반갑습니다', speaker: '3' },
      { text: '네', speaker: '1' },
      { text: '시작하겠습니다', speaker: '3' },
    ]);
    assert.equal(out, '참가자1: 안녕하세요 반갑습니다\n\n참가자2: 네\n\n참가자1: 시작하겠습니다');
  });

  it('concatenates token text verbatim (tokens carry their own leading spaces)', () => {
    const out = formatSonioxTokens([
      { text: 'we', speaker: '1' },
      { text: ' ship', speaker: '1' },
      { text: ' today', speaker: '1' },
    ]);
    assert.equal(out, '참가자1: we ship today');
  });

  it('drops audio-event tokens instead of making them a phantom speaker', () => {
    const out = formatSonioxTokens([
      { text: '[music]', is_audio_event: true, speaker: '9' },
      { text: '회의 시작', speaker: '1' },
      { text: '[laughter]', is_audio_event: true },
    ]);
    assert.equal(out, '참가자1: 회의 시작');
  });

  it('drops whitespace-only tokens without breaking the current turn', () => {
    const out = formatSonioxTokens([
      { text: '첫', speaker: '1' },
      { text: '   ', speaker: '2' },
      { text: ' 문장', speaker: '1' },
    ]);
    assert.equal(out, '참가자1: 첫 문장');
  });

  it('emits unlabeled lines when diarization returned no speakers', () => {
    const out = formatSonioxTokens([{ text: 'one' }, { text: ' two' }]);
    assert.equal(out, 'one two');
  });

  it('returns an empty string for no tokens', () => {
    assert.equal(formatSonioxTokens(), '');
    assert.equal(formatSonioxTokens([]), '');
    assert.equal(formatSonioxTokens([{ text: '   ' }]), '');
  });
});

describe('Soniox backend constants', () => {
  it('caps a single file at the documented 300 minutes', () => {
    assert.equal(SONIOX_MAX_FILE_SECONDS, 300 * 60);
  });

  it('accepts webm natively so our own recordings never need a remux', () => {
    assert.ok(SONIOX_TRANSCRIPTION_EXTENSIONS.has('.webm'));
    assert.ok(!SONIOX_TRANSCRIPTION_EXTENSIONS.has('.opus'));
  });
});

describe('transcribeSonioxAudio', () => {
  let audioPath = '';
  const noSleep = async (): Promise<void> => {};

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soniox-batch-'));
    audioPath = path.join(dir, 'clip.webm');
    fs.writeFileSync(audioPath, Buffer.alloc(16, 1));
  });

  afterEach(() => {
    if (audioPath) fs.rmSync(path.dirname(audioPath), { recursive: true, force: true });
  });

  function run(
    impl: typeof fetch,
    overrides: Partial<Parameters<typeof transcribeSonioxAudio>[0]> = {},
  ): ReturnType<typeof transcribeSonioxAudio> {
    return transcribeSonioxAudio({
      apiKey: API_KEY,
      audioFilePath: audioPath,
      fetchImpl: impl,
      sleep: noSleep,
      ...overrides,
    });
  }

  it('walks upload -> create -> poll -> transcript -> delete both objects', async () => {
    const { impl, calls } = scriptFetch({
      statuses: [
        { status: 'queued' },
        { status: 'processing' },
        { status: 'completed', audio_duration_ms: 61_000, model: 'stt-async-v5' },
      ],
      transcript: {
        tokens: [
          { text: '안녕하세요', speaker: '1' },
          { text: '네', speaker: '2' },
        ],
      },
    });

    const result = await run(impl);

    assert.equal(result.text, '참가자1: 안녕하세요\n\n참가자2: 네');
    assert.equal(result.audioDurationMs, 61_000);
    assert.equal(result.modelId, 'stt-async-v5');
    assert.deepEqual(steps(calls), [
      'POST /v1/files',
      'POST /v1/transcriptions',
      `GET /v1/transcriptions/${TRANSCRIPTION_ID}`,
      `GET /v1/transcriptions/${TRANSCRIPTION_ID}`,
      `GET /v1/transcriptions/${TRANSCRIPTION_ID}`,
      `GET /v1/transcriptions/${TRANSCRIPTION_ID}/transcript`,
      `DELETE /v1/transcriptions/${TRANSCRIPTION_ID}`,
      `DELETE /v1/files/${FILE_ID}`,
    ]);
  });

  it('sends the bearer token on every request and never logs it', async () => {
    const logged: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    };
    try {
      const { impl, calls } = scriptFetch();
      await run(impl);
      for (const call of calls) {
        assert.equal(call.authorization, `Bearer ${API_KEY}`);
      }
      assert.ok(logged.length > 0, 'expected the client to log its request/response summary');
      for (const line of logged) {
        assert.ok(!line.includes(API_KEY), `api key leaked into a log line: ${line}`);
      }
    } finally {
      console.log = originalLog;
    }
  });

  it('reports the model the server actually ran when it differs from the request', async () => {
    // Retired model ids are silently re-routed to the successor.
    const { impl } = scriptFetch({
      statuses: [{ status: 'completed', model: 'stt-async-v6' }],
    });
    const result = await run(impl, { model: 'stt-async-v5' });
    assert.equal(result.modelId, 'stt-async-v6');
  });

  it('requests diarization, language id and the default ko/en hints', async () => {
    const { impl, calls } = scriptFetch();
    await run(impl);
    const create = calls.find((call) => call.url.endsWith('/v1/transcriptions'));
    assert.ok(create);
    assert.deepEqual(create.body, {
      model: 'stt-async-v5',
      file_id: FILE_ID,
      language_hints: ['ko', 'en'],
      enable_speaker_diarization: true,
      enable_language_identification: true,
    });
  });

  it('sends context.terms only when the glossary is non-empty', async () => {
    const withTerms = scriptFetch();
    await run(withTerms.impl, {
      terms: [' Listener.AI ', '', '  ', 'Asleep'],
      clientReferenceId: 'abc123def456',
    });
    const created = withTerms.calls.find((call) => call.url.endsWith('/v1/transcriptions'))
      ?.body as Record<string, unknown>;
    assert.deepEqual(created.context, { terms: ['Listener.AI', 'Asleep'] });
    assert.equal(created.client_reference_id, 'abc123def456');

    const withoutTerms = scriptFetch();
    await run(withoutTerms.impl, { terms: ['   '] });
    const plain = withoutTerms.calls.find((call) => call.url.endsWith('/v1/transcriptions'))
      ?.body as Record<string, unknown>;
    assert.ok(!('context' in plain));
    assert.ok(!('client_reference_id' in plain));
  });

  it('deletes the uploaded file when job creation fails', async () => {
    const { impl, calls } = scriptFetch({
      createResponse: () =>
        json(
          {
            status_code: 500,
            error_type: 'internal_error',
            message: 'Something went wrong',
            request_id: 'req_soniox_1',
          },
          500,
        ),
    });

    await assert.rejects(run(impl), (err: unknown) => {
      assert.ok(err instanceof TranscriptionApiError);
      assert.equal(err.status, 500);
      assert.equal(err.errorType, 'internal_error');
      assert.equal(err.requestId, 'req_soniox_1');
      assert.equal(err.message, 'Something went wrong');
      return true;
    });
    // No transcription id exists yet, so only the file is cleaned up.
    assert.deepEqual(steps(calls).slice(-1), [`DELETE /v1/files/${FILE_ID}`]);
    assert.ok(!steps(calls).some((step) => step.startsWith('DELETE /v1/transcriptions')));
  });

  it('maps a terminal job error to a retryable TranscriptionApiError and deletes both', async () => {
    const { impl, calls } = scriptFetch({
      statuses: [
        { status: 'processing' },
        { status: 'error', error_type: 'internal_error', error_message: 'decoder crashed' },
      ],
    });

    await assert.rejects(run(impl), (err: unknown) => {
      assert.ok(err instanceof TranscriptionApiError);
      assert.equal(err.status, 500);
      assert.equal(err.errorType, 'internal_error');
      assert.equal(err.errorCode, 'internal_error');
      assert.equal(err.message, 'decoder crashed');
      return true;
    });
    assert.deepEqual(steps(calls).slice(-2), [
      `DELETE /v1/transcriptions/${TRANSCRIPTION_ID}`,
      `DELETE /v1/files/${FILE_ID}`,
    ]);
  });

  it('treats an input-shaped job error as non-retryable (400)', async () => {
    for (const errorType of [
      'invalid_audio_file',
      'transcription_output_too_long',
      'file_download_error',
    ]) {
      const { impl } = scriptFetch({ statuses: [{ status: 'error', error_type: errorType }] });
      await assert.rejects(run(impl), (err: unknown) => {
        assert.ok(err instanceof TranscriptionApiError);
        assert.equal(err.status, 400, `${errorType} should not be retried`);
        return true;
      });
    }
  });

  it('keeps the primary error when cleanup itself fails', async () => {
    const { impl, calls } = scriptFetch({
      statuses: [{ status: 'error', error_type: 'internal_error', error_message: 'boom' }],
      deleteResponse: () => json({ status_code: 503, error_type: 'unavailable' }, 503),
    });

    await assert.rejects(run(impl), (err: unknown) => {
      assert.ok(err instanceof TranscriptionApiError);
      assert.equal(err.message, 'boom');
      return true;
    });
    // Both deletes were still attempted despite the first one failing.
    assert.deepEqual(steps(calls).slice(-2), [
      `DELETE /v1/transcriptions/${TRANSCRIPTION_ID}`,
      `DELETE /v1/files/${FILE_ID}`,
    ]);
  });

  it('treats a 404 on delete as already-cleaned-up', async () => {
    const { impl } = scriptFetch({
      deleteResponse: () => new Response(null, { status: 404 }),
    });
    const result = await run(impl);
    assert.ok(result.text.length > 0);
  });

  it('rejects before uploading anything when the signal is already aborted', async () => {
    const { impl, calls } = scriptFetch();
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      run(impl, { signal: controller.signal }),
      (err: unknown) => (err as { name?: unknown } | null)?.name === 'AbortError',
    );
    assert.equal(calls.length, 0);
  });

  it('aborts mid-poll and still deletes both server-side objects', async () => {
    const controller = new AbortController();
    const { impl, calls } = scriptFetch({ statuses: [{ status: 'processing' }] });

    await assert.rejects(
      run(impl, {
        signal: controller.signal,
        sleep: async () => {
          controller.abort();
          throw new DOMException('Aborted', 'AbortError');
        },
      }),
      (err: unknown) => (err as { name?: unknown } | null)?.name === 'AbortError',
    );

    assert.deepEqual(steps(calls).slice(-2), [
      `DELETE /v1/transcriptions/${TRANSCRIPTION_ID}`,
      `DELETE /v1/files/${FILE_ID}`,
    ]);
    // Cleanup must not carry the caller's aborted signal, or cancelling would
    // permanently leak the quota -- but it still needs its own deadline so an
    // offline cancel doesn't stall on two hanging DELETEs.
    for (const call of calls.filter((c) => c.method === 'DELETE')) {
      assert.ok(call.signal, 'expected a cleanup timeout signal');
      assert.notEqual(call.signal, controller.signal);
      assert.equal(call.signal.aborted, false);
    }
  });

  it('forwards the caller signal into the upload/create/poll requests', async () => {
    const controller = new AbortController();
    const { impl, calls } = scriptFetch();
    await run(impl, { signal: controller.signal });
    for (const call of calls.filter((c) => c.method !== 'DELETE')) {
      assert.ok(call.hasSignal, `expected signal on ${call.method} ${call.url}`);
    }
  });

  it('backs off between polls using the injected sleep', async () => {
    const waits: number[] = [];
    const { impl } = scriptFetch({
      statuses: [
        { status: 'queued' },
        { status: 'queued' },
        { status: 'queued' },
        { status: 'queued' },
        { status: 'completed' },
      ],
    });

    await run(impl, {
      sleep: async (ms: number) => {
        waits.push(ms);
      },
      pollIntervalMs: 1_000,
      maxPollIntervalMs: 2_000,
    });

    assert.deepEqual(waits, [1_000, 1_500, 2_000, 2_000]);
  });

  it('gives up on a wedged job instead of polling forever', async () => {
    const { impl, calls } = scriptFetch({ statuses: [{ status: 'processing' }] });
    await assert.rejects(run(impl, { maxPollWaitMs: 0 }), (err: unknown) => {
      assert.ok(err instanceof TranscriptionApiError);
      // 408 is retryable, so the caller's bounded retry may start a fresh job.
      assert.equal(err.status, 408);
      assert.equal(err.errorCode, 'poll_timeout');
      return true;
    });
    assert.deepEqual(steps(calls).slice(-2), [
      `DELETE /v1/transcriptions/${TRANSCRIPTION_ID}`,
      `DELETE /v1/files/${FILE_ID}`,
    ]);
  });

  it('keeps a missing tokens field a malformed-response error, not silence', async () => {
    // The job is deleted right after, so mislabelling this as "no speech"
    // would destroy the evidence and show the user an empty recording.
    for (const transcript of [{}, { tokens: 'not-an-array' }, { text: 'plain' }]) {
      const { impl } = scriptFetch({ transcript });
      await assert.rejects(
        run(impl),
        (err: unknown) =>
          err instanceof Error &&
          !(err instanceof EmptyTranscriptionError) &&
          /missing tokens/.test(err.message),
      );
    }
  });

  it('throws EmptyTranscriptionError for a transcript with no speech', async () => {
    for (const transcript of [
      { tokens: [] },
      { tokens: [{ text: '   ' }] as SonioxAsyncToken[] },
      { tokens: [{ text: '[music]', is_audio_event: true }] as SonioxAsyncToken[] },
    ]) {
      const { impl, calls } = scriptFetch({ transcript });
      await assert.rejects(run(impl), EmptyTranscriptionError);
      assert.deepEqual(steps(calls).slice(-2), [
        `DELETE /v1/transcriptions/${TRANSCRIPTION_ID}`,
        `DELETE /v1/files/${FILE_ID}`,
      ]);
    }
  });

  it('maps auth, billing and rate-limit failures onto TranscriptionApiError', async () => {
    const cases = [
      { status: 401, errorType: 'unauthenticated' },
      { status: 402, errorType: 'organization_balance_exhausted' },
      { status: 429, errorType: 'limit_exceeded' },
    ];
    for (const { status, errorType } of cases) {
      const { impl } = scriptFetch({
        uploadResponse: () =>
          json(
            {
              status_code: status,
              error_type: errorType,
              message: `denied: ${errorType}`,
              request_id: `req_${status}`,
            },
            status,
          ),
      });
      await assert.rejects(run(impl), (err: unknown) => {
        assert.ok(err instanceof TranscriptionApiError);
        assert.equal(err.status, status);
        assert.equal(err.errorType, errorType);
        assert.equal(err.errorCode, errorType);
        assert.equal(err.requestId, `req_${status}`);
        return true;
      });
    }
  });

  it('keeps a non-JSON error body as opaque raw text', async () => {
    const { impl } = scriptFetch({
      uploadResponse: () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    });
    await assert.rejects(run(impl), (err: unknown) => {
      assert.ok(err instanceof TranscriptionApiError);
      assert.equal(err.status, 502);
      assert.equal(err.rawBody, '<html>502 Bad Gateway</html>');
      assert.match(err.message, /file upload failed \(502/);
      return true;
    });
  });

  it('uploads multipart audio without exposing the recording filename', async () => {
    const { impl, calls } = scriptFetch();
    await run(impl);
    const upload = calls.find((call) => call.url.endsWith('/v1/files'));
    assert.ok(upload?.body instanceof FormData);
    const file = upload.body.get('file') as { name?: string; type?: string } | null;
    assert.ok(file && typeof file === 'object');
    assert.equal(file.name, 'audio.webm');
    assert.equal(file.type, 'audio/webm');
  });

  it('reports progress for the upload, each poll, and the transcript fetch', async () => {
    const events: Array<[number, string]> = [];
    const { impl } = scriptFetch({
      statuses: [{ status: 'processing' }, { status: 'processing' }, { status: 'completed' }],
    });
    await run(impl, { onProgress: (percent, message) => events.push([percent, message]) });

    const messages = events.map(([, message]) => message);
    assert.equal(messages[0], 'Uploading audio to Soniox...');
    assert.equal(messages[1], 'Transcribing with Soniox...');
    assert.equal(messages.at(-1), 'Fetching transcript...');
    // One liveness line per pending poll, carrying elapsed time.
    const polls = messages.filter((message) => /\(\d+s elapsed\)/.test(message));
    assert.equal(polls.length, 2);
    // Never rewinds, and stays inside the window the pipeline leaves for
    // transcription.
    const percents = events.map(([percent]) => percent);
    assert.deepEqual(
      percents,
      [...percents].sort((a, b) => a - b),
    );
    assert.ok(percents.every((percent) => percent > 15 && percent < 85));
  });

  it('fails fast on a job status it does not recognise', async () => {
    for (const status of [{ status: 'paused' }, {}]) {
      const { impl, calls } = scriptFetch({ statuses: [status] });
      await assert.rejects(run(impl), (err: unknown) => {
        assert.ok(err instanceof TranscriptionApiError);
        assert.equal(err.errorCode, 'unexpected_status');
        return true;
      });
      // Still cleans up rather than leaving the job pending against the quota.
      assert.deepEqual(steps(calls).slice(-2), [
        `DELETE /v1/transcriptions/${TRANSCRIPTION_ID}`,
        `DELETE /v1/files/${FILE_ID}`,
      ]);
    }
  });

  // The whole-file path has no retry loop above it (unlike the segment path),
  // so a transient 5xx has to be recoverable here or a 90-minute meeting
  // fails outright on one bad job.
  it('retries a retryable failure with a fresh upload and job', async () => {
    let attempts = 0;
    const { impl, calls } = scriptFetch({
      createResponse: () => {
        attempts++;
        return attempts === 1
          ? json({ status_code: 500, error_type: 'internal_error' }, 500)
          : json({ id: TRANSCRIPTION_ID, status: 'queued' });
      },
    });

    const result = await run(impl, { maxAttempts: 3 });

    assert.ok(result.text.length > 0);
    assert.equal(attempts, 2);
    // Each attempt uploads its own file and deletes it.
    assert.equal(steps(calls).filter((step) => step === 'POST /v1/files').length, 2);
    assert.equal(steps(calls).filter((step) => step === `DELETE /v1/files/${FILE_ID}`).length, 2);
  });

  it('does not retry a non-retryable failure', async () => {
    let attempts = 0;
    const { impl } = scriptFetch({
      uploadResponse: () => {
        attempts++;
        return json({ status_code: 401, error_type: 'unauthenticated' }, 401);
      },
    });

    await assert.rejects(run(impl, { maxAttempts: 3 }), TranscriptionApiError);
    assert.equal(attempts, 1);
  });

  it('gives up after the attempt cap', async () => {
    let attempts = 0;
    const { impl } = scriptFetch({
      uploadResponse: () => {
        attempts++;
        return json({ status_code: 503, error_type: 'unavailable' }, 503);
      },
    });

    await assert.rejects(run(impl, { maxAttempts: 3 }), TranscriptionApiError);
    assert.equal(attempts, 3);
  });

  it('abandons the retry when the caller cancels during the backoff', async () => {
    let attempts = 0;
    const controller = new AbortController();
    const { impl } = scriptFetch({
      uploadResponse: () => {
        attempts++;
        return json({ status_code: 503, error_type: 'unavailable' }, 503);
      },
    });

    await assert.rejects(
      run(impl, {
        maxAttempts: 3,
        signal: controller.signal,
        sleep: async () => {
          controller.abort();
          throw new DOMException('Aborted', 'AbortError');
        },
      }),
      (err: unknown) => (err as { name?: unknown } | null)?.name === 'AbortError',
    );
    assert.equal(attempts, 1);
  });
});
