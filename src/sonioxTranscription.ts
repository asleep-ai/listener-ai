// Minimal client for Soniox's async (batch) transcription REST API.
//
// Same reasoning as `codexTranscription.ts`: pi-ai is a chat/tool-call
// surface with no audio endpoint, so a thin direct `fetch` is simpler than
// wedging audio into it. The shape is deliberately parallel to the Codex
// client -- multipart upload, JSON error envelope, `참가자N` speaker lines --
// so a reader who knows one knows both.
//
// Unlike the single-request Codex path, Soniox is a three-step job:
//
//   POST /v1/files            -> { id }            (multipart upload)
//   POST /v1/transcriptions   -> { id, status }    (job creation)
//   GET  /v1/transcriptions/{id}                   (poll to a terminal state)
//   GET  /v1/transcriptions/{id}/transcript        (tokens)
//
// and both server-side objects count against hard account quotas (2,000
// transcriptions, 1,000 stored files, 100 pending). Deleting them is
// therefore part of the happy path, not a nicety: the `finally` block below
// removes every id this client learned -- on success, failure and
// cancellation alike -- and the whole-file caller owns the shared upload it
// passed in (see `uploadSonioxFile`).
//
// What no `finally` can remove is an object whose id never reached us. Three
// residual cases leak one quota slot each: an upload or a create that answers
// 2xx with no usable `id` in the body, a body read that hits its own deadline
// after the server already allocated the object, and a cancel that lands
// mid-upload (the file may exist, and the response we would have learned its
// id from is gone). Reclaiming those needs a list-and-sweep over the account,
// which this client deliberately does not do: the listing is account-wide, so
// a sweep would delete objects belonging to another run or another device.
//
// Diarization is on, and the whole meeting is sent as one file (see
// `SONIOX_MAX_FILE_SECONDS` and the backend's `maxSegmentSeconds`), because
// Soniox only guarantees speaker ids are consistent within a single request.
// Vocabulary goes out of band through `context.terms`, not a prompt -- the
// API has no prompt or temperature knob at all, which is what collapses the
// quality-retry ladder to one provider-nondeterministic re-roll.

import * as fs from 'fs';
import * as path from 'path';
import { SONIOX_ASYNC_MODEL } from './aiProvider';
import { mimeTypeForExtension } from './audioFormats';
import { reportError } from './sentry';
import {
  EmptyTranscriptionError,
  isRetryableStatus,
  TranscriptionApiError,
} from './transcriptionErrors';

export { SONIOX_ASYNC_MODEL };

export const SONIOX_API_BASE_URL = 'https://api.soniox.com';

// Containers the async API decodes itself. Anything else is remuxed to
// webm/opus upstream by `prepareAudioForProvider`.
export const SONIOX_TRANSCRIPTION_EXTENSIONS: ReadonlySet<string> = new Set([
  '.webm',
  '.mp3',
  '.m4a',
  '.mp4',
  '.wav',
  '.ogg',
  '.flac',
  '.aac',
  '.aiff',
  '.amr',
  '.asf',
]);

/** Hard per-file cap: 300 minutes. Longer recordings go through the segment plan. */
export const SONIOX_MAX_FILE_SECONDS = 18_000;

// Byte stand-in for that cap, for the recording ffprobe could not measure:
// `planSegmentation` can only compare a duration it was given, so with no byte
// cap an unmeasurable six-hour file would be uploaded whole and rejected by
// the server. 300 minutes of the app's own 64 kbps mono Opus is ~144 MB, and
// the extra 10% covers container overhead and slightly denser encodings.
export const SONIOX_MAX_FILE_BYTES = Math.round(SONIOX_MAX_FILE_SECONDS * (64_000 / 8) * 1.1);

const DEFAULT_LANGUAGE_HINTS = ['ko', 'en'];

// Progress checkpoints inside the pipeline's 15-85% transcription window.
const SONIOX_UPLOAD_PERCENT = 25;
const SONIOX_TRANSCRIBE_PERCENT = 30;
const SONIOX_FETCH_PERCENT = 45;

// Measured turnaround is ~40x realtime (a 120-minute file came back in ~3
// minutes), so a fixed 1s poll would issue ~180 pointless requests. Start
// responsive for short clips, then back off.
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_POLL_INTERVAL_MS = 10_000;
const POLL_BACKOFF_FACTOR = 1.5;

// Budget for the polling of a WHOLE `transcribeSonioxAudio` call, shared by
// every transport attempt rather than granted afresh to each one: three
// attempts of two hours each is not a bound anyone would wait out, and a job
// that burned the budget has nothing left to retry into. A 300-minute file
// (the provider's own cap) came back in ~3 minutes at the measured ~40x
// realtime, so two hours is a wide margin that still fails a wedged job
// instead of hanging the pipeline forever when nobody is watching to cancel
// it. It bounds the polling, not a single request that never responds.
const DEFAULT_MAX_POLL_WAIT_MS = 2 * 60 * 60 * 1_000;

// Poll ceiling for the chunked live path, where one whole Soniox job covers a
// ~12s snippet. The whole-file budget would let a wedged job stall the caption
// stream for two hours while the next clips are already being recorded, so the
// snippet ceiling scales with the clip instead: 10x realtime is ~4x the
// measured turnaround, floored so a one-second clip still tolerates queueing.
const SNIPPET_POLL_WAIT_FACTOR = 10;
const SNIPPET_MIN_POLL_WAIT_MS = 30_000;

/** Poll budget for a live snippet of `audioSeconds` (0 when unknown). */
export function snippetPollWaitMs(audioSeconds: number): number {
  return Math.max(SNIPPET_MIN_POLL_WAIT_MS, SNIPPET_POLL_WAIT_FACTOR * audioSeconds * 1_000);
}

// Statuses that mean "keep waiting". Anything else -- a renamed state, a
// missing field -- fails fast instead of polling to the two-hour ceiling.
const PENDING_JOB_STATUSES = new Set(['queued', 'processing']);

// Transport retry for the whole-file path (the segment path has its own loop
// in `transcribeSingleSegment`, so it opts out). A job that ends `error` with
// a transient type is mapped to a 5xx precisely so it can be retried; without
// a retry here a 90-minute meeting would fail outright on one bad job.
const RETRY_BASE_DELAY_MS = 2_000;

// Cleanup runs off the caller's signal (see `deleteQuietly`), so it needs its
// own deadline or a cancel while offline stalls on two hanging DELETEs.
const CLEANUP_TIMEOUT_MS = 5_000;

// Same cap as the Codex client: enough for a parsed JSON error to stay
// readable under "Show details" without bloating logs.
const RAW_BODY_CAP = 1500;

// Deadline for reading a response body once its headers have arrived. The
// caller's cancel is deliberately detached at that point (see
// `fetchAllocation`), so these small bodies need a deadline of their own.
const BODY_READ_TIMEOUT_MS = 10_000;

// The poll budget covers the whole call, so a job that outlives it leaves
// nothing for another attempt: a fresh upload would start with zero budget and
// time out on its first poll. It is reported as the timeout it is (408) but
// excluded from this module's retry classification, so `isRetryableStatus`
// keeps treating a real transport 408 as retryable for every other caller.
const POLL_TIMEOUT_ERROR_TYPE = 'poll_timeout';

function pollTimeoutError(): TranscriptionApiError {
  return new TranscriptionApiError('Soniox transcription did not finish in time', {
    status: 408,
    statusText: 'transcription timed out',
    errorType: POLL_TIMEOUT_ERROR_TYPE,
    errorCode: POLL_TIMEOUT_ERROR_TYPE,
  });
}

// `fetch` rejects with a bare TypeError -- no Response, no status -- for DNS
// failures, refused connections and resets mid-request. Raw, those bypass the
// retry ladder entirely (`isRetryableSonioxFailure` only knows
// TranscriptionApiError), so one network blip fails a 90-minute recording
// outright. They are mapped onto a 503 instead, which is what the ladder
// already does for every other transient transport failure. A cancel and a
// body-read deadline are decisions, not blips, and pass through untouched.
const NETWORK_ERROR_TYPE = 'network';

async function fetchOrRetryableFailure(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  operation: string,
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    if (name === 'AbortError' || name === 'TimeoutError') throw error;
    throw new TranscriptionApiError(`Soniox ${operation} could not reach the service`, {
      status: 503,
      statusText: 'network error',
      errorType: NETWORK_ERROR_TYPE,
      errorCode: NETWORK_ERROR_TYPE,
      rawBody: capBody(error instanceof Error ? error.message : String(error)),
    });
  }
}

function isRetryableSonioxFailure(error: unknown): error is TranscriptionApiError {
  if (!(error instanceof TranscriptionApiError)) return false;
  if (error.errorCode === POLL_TIMEOUT_ERROR_TYPE) return false;
  return isRetryableStatus(error.status);
}

// A job that fails with one of these will fail again on a retry -- the input
// is wrong, not the service. Everything else (capacity, internal errors) is
// reported as a 5xx so `isRetryableStatus` lets the caller try again.
const NON_RETRYABLE_JOB_ERROR_TYPES = new Set([
  'invalid_audio_file',
  'transcription_output_too_long',
]);
const NON_RETRYABLE_JOB_ERROR_PREFIXES = ['file_download_'];

export interface SonioxAsyncToken {
  text?: string;
  start_ms?: number;
  end_ms?: number;
  confidence?: number;
  /** Diarization id. A STRING ("1", "2"), not a number, and not 1-based. */
  speaker?: string;
  language?: string;
  source_language?: string;
  translation_status?: string;
  /** Non-speech marker (music, laughter). Never part of the transcript. */
  is_audio_event?: boolean;
}

export interface SonioxTranscriptionStatus {
  id?: string;
  status?: string;
  error_type?: string;
  error_message?: string;
  audio_duration_ms?: number;
  /** Server-reported model. Soniox silently re-routes retired ids, so log it. */
  model?: string;
}

export interface SonioxTranscriptResponse {
  id?: string;
  text?: string;
  tokens?: SonioxAsyncToken[];
}

export interface TranscribeSonioxAudioParams {
  apiKey: string;
  audioFilePath: string;
  /** Defaults to `stt-async-v5`. */
  model?: string;
  /** Defaults to `['ko', 'en']`. */
  languageHints?: string[];
  /** User glossary (`knownWords`), sent as `context.terms`. */
  terms?: string[];
  /** Opaque correlation id. Must never carry meeting content -- hash it. */
  clientReferenceId?: string;
  signal?: AbortSignal;
  /** Test seam: replaces `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Test seam: collapses the poll backoff. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  /**
   * Budget for the polling of this whole call, every transport attempt
   * included; defaults to two hours.
   */
  maxPollWaitMs?: number;
  /**
   * Id of a file the caller already uploaded with `uploadSonioxFile`. The
   * call then creates and deletes only the job, and the file outlives it as
   * the caller's to delete -- which is what lets the whole-file quality ladder
   * reuse one upload across every attempt and every retry rung.
   */
  fileId?: string;
  /**
   * Transport attempts for the whole upload/job cycle. Defaults to 1 (no
   * retry) because the segment path is already wrapped in its own bounded
   * retry loop; the whole-file path passes 3.
   */
  maxAttempts?: number;
  onProgress?: (percent: number, message: string) => void;
}

export interface SonioxTranscriptionResult {
  text: string;
  /** Provider-measured audio length, preferred over our ffprobe number for billing. */
  audioDurationMs?: number;
  /** Model the server actually ran, which may differ from the requested id. */
  modelId: string;
}

const defaultFetchImpl: typeof fetch = (input: RequestInfo | URL, init?: RequestInit) =>
  globalThis.fetch(input, init);

/** Rejects with AbortError the moment the signal fires, instead of one poll later. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function capBody(body: string): string {
  return body.length > RAW_BODY_CAP ? `${body.slice(0, RAW_BODY_CAP)}...` : body;
}

interface SonioxErrorBody {
  status_code?: number;
  error_type?: string;
  message?: string;
  request_id?: string;
  validation_errors?: unknown;
}

// Soniox's error envelope is `{ status_code, error_type, message, request_id }`.
// `errorType` and `errorCode` are both filled from `error_type` so the shared
// `friendlyMessageForApiError` can branch on either field the same way it does
// for OpenAI's `error.type` / `error.code`.
async function failureFromResponse(
  response: Response,
  operation: string,
): Promise<TranscriptionApiError> {
  let body = '';
  try {
    body = await response.text();
  } catch (error) {
    // A cancel landing while the error body streams is still a cancel. Turning
    // it into a TranscriptionApiError would report the user's own abort as a
    // provider failure -- and make the caller's retry ladder act on it.
    if ((error as { name?: unknown } | null)?.name === 'AbortError') throw error;
    // Anything else (truncated/undecodable body) stays an opaque empty body.
  }
  let parsed: SonioxErrorBody | undefined;
  try {
    parsed = JSON.parse(body) as SonioxErrorBody;
  } catch {
    // Not JSON (proxy/HTML error page) -- keep it as opaque text in rawBody.
  }
  const apiMessage = typeof parsed?.message === 'string' ? parsed.message.trim() : '';
  return new TranscriptionApiError(
    apiMessage || `Soniox ${operation} failed (${response.status} ${response.statusText})`,
    {
      status: response.status,
      statusText: response.statusText,
      requestId: parsed?.request_id ?? response.headers.get('x-request-id') ?? undefined,
      errorType: parsed?.error_type,
      errorCode: parsed?.error_type,
      rawBody: capBody(body),
    },
  );
}

// A job that reaches `status: 'error'` returns HTTP 200 on the poll, so there
// is no transport status to reuse. Synthesize one: 500 (retryable) unless the
// error type says the input itself is the problem, which maps to 400.
function failureFromJobStatus(status: SonioxTranscriptionStatus): TranscriptionApiError {
  const errorType = status.error_type?.trim() || undefined;
  const permanent =
    errorType !== undefined &&
    (NON_RETRYABLE_JOB_ERROR_TYPES.has(errorType) ||
      NON_RETRYABLE_JOB_ERROR_PREFIXES.some((prefix) => errorType.startsWith(prefix)));
  const message = status.error_message?.trim();
  return new TranscriptionApiError(
    message || `Soniox transcription failed${errorType ? ` (${errorType})` : ''}`,
    {
      status: permanent ? 400 : 500,
      statusText: 'transcription failed',
      errorType,
      errorCode: errorType,
    },
  );
}

/**
 * Render Soniox tokens as `참가자N` turns, the same convention the Gemini
 * prompt and the Codex diarize reshape produce, so downstream consumers
 * (summary, transcript.md, Notion) never learn which engine ran.
 *
 * Speaker ids are renumbered in order of first appearance -- Soniox returns
 * arbitrary strings ("3" can be the first voice heard). Consecutive tokens
 * from one speaker merge into a single turn, and tokens carrying no speaker
 * (diarization off or unassigned) produce an unlabeled line.
 *
 * Token text carries its own leading whitespace, so it is concatenated
 * verbatim and trimmed once per turn. Some of that whitespace arrives as a
 * token of its own (see the loop), which is why the concatenation has to take
 * every token's text, not only the ones that look like words.
 */
export function formatSonioxTokens(tokens?: SonioxAsyncToken[]): string {
  if (!tokens || tokens.length === 0) return '';

  const speakerIdx = new Map<string, number>();
  let nextIdx = 1;
  const lines: string[] = [];
  let started = false;
  let activeLabel: string | undefined;
  let buffer = '';

  const flush = (): void => {
    const text = buffer.trim();
    if (text) lines.push(activeLabel === undefined ? text : `${activeLabel}: ${text}`);
    buffer = '';
  };

  for (const token of tokens) {
    // Audio events ("[music]", "[laughter]") are not speech and would show up
    // as a phantom speaker turn.
    if (token.is_audio_event) continue;
    const text = token.text ?? '';
    if (text.length === 0) continue;

    // Soniox emits standalone whitespace as a token in its own right, with its
    // own timings, confidence and sometimes its own speaker id (a 5-minute
    // probe: 51 of 1,436 tokens). Its text is real spacing -- dropping it glued
    // adjacent words together, ~1,900 missing spaces on a 120-minute file --
    // but it is not speech: it must not open a turn, and it must not claim a
    // speaker number for a voice that never said anything. `flush` trims, so a
    // run of them still cannot be emitted as a turn of its own.
    if (text.trim().length === 0) {
      if (started) buffer += text;
      continue;
    }

    const speaker = token.speaker?.trim();
    let label: string | undefined;
    if (speaker) {
      let idx = speakerIdx.get(speaker);
      if (idx === undefined) {
        idx = nextIdx++;
        speakerIdx.set(speaker, idx);
      }
      label = `참가자${idx}`;
    }

    if (!started) {
      started = true;
      activeLabel = label;
    } else if (label !== activeLabel) {
      flush();
      activeLabel = label;
    }
    buffer += text;
  }
  if (started) flush();

  // Blank line between turns, matching `formatDiarizedSegments` and the
  // Gemini transcript prompt: the transcript is rendered as markdown, where
  // single newlines collapse turns into one paragraph.
  return lines.join('\n\n');
}

/** Read a response body under its own deadline, never the caller's signal. */
async function readWithDeadline<T>(
  controller: AbortController,
  read: () => Promise<T>,
): Promise<T> {
  const deadline = AbortSignal.timeout(BODY_READ_TIMEOUT_MS);
  const onTimeout = (): void => controller.abort(deadline.reason);
  deadline.addEventListener('abort', onTimeout, { once: true });
  try {
    return await read();
  } finally {
    deadline.removeEventListener('abort', onTimeout);
  }
}

/**
 * POST a request that allocates a server-side object (a stored file, a
 * transcription job) and return its parsed body.
 *
 * The caller's signal drives the request only until the response headers
 * arrive. Past that point the server has already created the object, and
 * aborting the body read would throw away the id we need -- `runSonioxJob`'s
 * `finally` can only delete what it learned, so a cancel in that window would
 * silently leak one of the hard account quotas. The body is therefore read
 * under its own deadline, and the caller re-checks the abort once the id is
 * recorded.
 */
async function fetchAllocation(params: {
  fetchImpl: typeof fetch;
  url: string;
  init: Omit<RequestInit, 'signal'>;
  operation: string;
  signal?: AbortSignal;
}): Promise<{ id?: unknown }> {
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort(params.signal?.reason);
  if (params.signal?.aborted) forwardAbort();
  params.signal?.addEventListener('abort', forwardAbort, { once: true });
  try {
    const response = await fetchOrRetryableFailure(
      params.fetchImpl,
      params.url,
      { ...params.init, signal: controller.signal },
      params.operation,
    );
    // Headers are in: from here the caller's cancel must not reach the body.
    params.signal?.removeEventListener('abort', forwardAbort);
    if (!response.ok) {
      throw await readWithDeadline(controller, () =>
        failureFromResponse(response, params.operation),
      );
    }
    return await readWithDeadline(controller, () => response.json() as Promise<{ id?: unknown }>);
  } finally {
    params.signal?.removeEventListener('abort', forwardAbort);
  }
}

async function uploadAudioFile(params: {
  fetchImpl: typeof fetch;
  apiKey: string;
  audioFilePath: string;
  signal?: AbortSignal;
}): Promise<{ fileId: string; sizeBytes: number }> {
  const ext = path.extname(params.audioFilePath).toLowerCase();
  // `openAsBlob` streams from the file handle, so a 55 MB recording is not
  // also held in a Buffer while FormData copies it.
  const blob = await fs.openAsBlob(params.audioFilePath, { type: mimeTypeForExtension(ext) });
  const form = new FormData();
  // Neutral filename on purpose: recording names are derived from the meeting
  // title, and the extension is all the server needs to pick a demuxer.
  form.append('file', blob, `audio${ext}`);

  const payload = await fetchAllocation({
    fetchImpl: params.fetchImpl,
    url: `${SONIOX_API_BASE_URL}/v1/files`,
    init: {
      method: 'POST',
      headers: { Authorization: `Bearer ${params.apiKey}` },
      body: form,
    },
    operation: 'file upload',
    signal: params.signal,
  });
  if (typeof payload.id !== 'string' || payload.id.length === 0) {
    throw new Error('Soniox file upload response missing id');
  }
  return { fileId: payload.id, sizeBytes: blob.size };
}

/**
 * Upload one audio file and return the stored-file id, without creating a
 * transcription job.
 *
 * The caller owns the id from here: it passes it to `transcribeSonioxAudio` as
 * `fileId` for as many attempts and retry rungs as it needs, then hands it to
 * `deleteSonioxFile` when the run is over. Skipping that release leaks one of
 * the 1,000 stored-file slots.
 */
export async function uploadSonioxFile(params: {
  apiKey: string;
  audioFilePath: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<{ fileId: string; sizeBytes: number }> {
  return await uploadAudioFile({
    fetchImpl: params.fetchImpl ?? defaultFetchImpl,
    apiKey: params.apiKey,
    audioFilePath: params.audioFilePath,
    signal: params.signal,
  });
}

/**
 * Release a file from `uploadSonioxFile`. Runs off any caller signal and never
 * throws, so it is safe in a `finally` on the cancellation path (see
 * `deleteQuietly`).
 */
export async function deleteSonioxFile(params: {
  apiKey: string;
  fileId: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  await deleteQuietly({
    fetchImpl: params.fetchImpl ?? defaultFetchImpl,
    apiKey: params.apiKey,
    resourcePath: `/v1/files/${params.fileId}`,
    label: 'file',
  });
}

async function createTranscription(params: {
  fetchImpl: typeof fetch;
  apiKey: string;
  fileId: string;
  model: string;
  languageHints: string[];
  terms?: string[];
  clientReferenceId?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const terms = (params.terms ?? []).map((term) => term.trim()).filter((term) => term.length > 0);
  const body: Record<string, unknown> = {
    model: params.model,
    file_id: params.fileId,
    language_hints: params.languageHints,
    enable_speaker_diarization: true,
    enable_language_identification: true,
  };
  // Omit `context` entirely when the user has no glossary: an empty terms
  // array is a request the server has no reason to validate favorably.
  if (terms.length > 0) body.context = { terms };
  if (params.clientReferenceId) body.client_reference_id = params.clientReferenceId;

  const payload = await fetchAllocation({
    fetchImpl: params.fetchImpl,
    url: `${SONIOX_API_BASE_URL}/v1/transcriptions`,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    operation: 'transcription create',
    signal: params.signal,
  });
  if (typeof payload.id !== 'string' || payload.id.length === 0) {
    throw new Error('Soniox transcription create response missing id');
  }
  return payload.id;
}

async function pollUntilCompleted(params: {
  fetchImpl: typeof fetch;
  apiKey: string;
  transcriptionId: string;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  pollIntervalMs: number;
  maxPollIntervalMs: number;
  maxPollWaitMs: number;
  signal?: AbortSignal;
  onProgress?: (percent: number, message: string) => void;
}): Promise<SonioxTranscriptionStatus> {
  const startedAt = Date.now();
  let interval = params.pollIntervalMs;
  for (;;) {
    params.signal?.throwIfAborted();
    const response = await fetchOrRetryableFailure(
      params.fetchImpl,
      `${SONIOX_API_BASE_URL}/v1/transcriptions/${params.transcriptionId}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${params.apiKey}` },
        signal: params.signal,
      },
      'transcription status',
    );
    if (!response.ok) throw await failureFromResponse(response, 'transcription status');

    const status = (await response.json()) as SonioxTranscriptionStatus;
    if (status.status === 'completed') return status;
    if (status.status === 'error') throw failureFromJobStatus(status);
    if (status.status === undefined || !PENDING_JOB_STATUSES.has(status.status)) {
      // A state we don't recognise is not a reason to wait two hours for it.
      throw new TranscriptionApiError('Soniox returned an unexpected job status', {
        status: 500,
        statusText: 'unexpected status',
        errorType: 'unexpected_status',
        errorCode: 'unexpected_status',
      });
    }

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    // Same percent every time -- this is a liveness signal, not progress, and
    // the bar must not rewind.
    params.onProgress?.(
      SONIOX_TRANSCRIBE_PERCENT,
      `Transcribing with Soniox... (${elapsedSeconds}s elapsed)`,
    );

    if (Date.now() - startedAt >= params.maxPollWaitMs) {
      throw pollTimeoutError();
    }
    await params.sleep(interval, params.signal);
    interval = Math.min(params.maxPollIntervalMs, Math.round(interval * POLL_BACKOFF_FACTOR));
  }
}

async function fetchTranscript(params: {
  fetchImpl: typeof fetch;
  apiKey: string;
  transcriptionId: string;
  signal?: AbortSignal;
}): Promise<SonioxTranscriptResponse> {
  const response = await fetchOrRetryableFailure(
    params.fetchImpl,
    `${SONIOX_API_BASE_URL}/v1/transcriptions/${params.transcriptionId}/transcript`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${params.apiKey}` },
      signal: params.signal,
    },
    'transcript fetch',
  );
  if (!response.ok) throw await failureFromResponse(response, 'transcript fetch');
  return (await response.json()) as SonioxTranscriptResponse;
}

// Quota cleanup. Deliberately runs WITHOUT the caller's AbortSignal: the most
// common reason to reach here with server-side objects alive is a cancelled
// transcription, and reusing the aborted signal would skip the delete and leak
// the quota it was meant to reclaim. Failures are logged and swallowed so they
// can never mask the error that triggered the cleanup.
async function deleteQuietly(params: {
  fetchImpl: typeof fetch;
  apiKey: string;
  resourcePath: string;
  label: string;
}): Promise<void> {
  try {
    const response = await fetchOrRetryableFailure(
      params.fetchImpl,
      `${SONIOX_API_BASE_URL}${params.resourcePath}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${params.apiKey}` },
        // Its own deadline, never the caller's: cleanup must still run after a
        // cancel, but a cancel while offline must not stall on two hung
        // DELETEs.
        signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
      },
      `${params.label} delete`,
    );
    // 404 means somebody already removed it -- the quota is free either way.
    if (response.ok || response.status === 404) return;
    throw await failureFromResponse(response, `${params.label} delete`);
  } catch (error) {
    const status = error instanceof TranscriptionApiError ? error.status : undefined;
    console.error(
      `[soniox-transcribe] cleanup failed for ${params.label}${status ? ` (HTTP ${status})` : ''}`,
    );
    // Silent cleanup failures accumulate against the 1,000-file / 2,000-job
    // quotas until every transcription starts failing, so they are worth a
    // report even though the user-visible call succeeded. Throttled: the
    // chunked live path runs a whole Soniox job per ~12s snippet, and a
    // provider-side outage would make every one of them report twice (file
    // plus job) for the length of the meeting.
    reportError(error, {
      operation: 'transcription.soniox.cleanup',
      severity: 'warning',
      throttleMs: 60_000,
      extra: { status },
    });
  }
}

/**
 * Transcribe one audio file end to end: upload, create the job, poll it to a
 * terminal state, render the tokens, and delete both server-side objects.
 *
 * Throws `TranscriptionApiError` for HTTP failures and for a job that ends in
 * `status: 'error'`, and `EmptyTranscriptionError` when the audio produced no
 * speech (silence/noise), which the pipeline treats as a normal outcome.
 */
export async function transcribeSonioxAudio(
  params: TranscribeSonioxAudioParams,
): Promise<SonioxTranscriptionResult> {
  const sleep = params.sleep ?? abortableSleep;
  const maxAttempts = Math.max(1, params.maxAttempts ?? 1);
  // One budget for the call rather than one per attempt: the clock starts
  // here, and each attempt polls against whatever is left of it.
  const pollBudgetMs = Math.max(0, params.maxPollWaitMs ?? DEFAULT_MAX_POLL_WAIT_MS);
  const budgetStartedAt = Date.now();
  const remainingPollBudgetMs = (): number =>
    Math.max(0, pollBudgetMs - (Date.now() - budgetStartedAt));
  for (let attempt = 1; ; attempt++) {
    try {
      return await runSonioxJob(params, remainingPollBudgetMs());
    } catch (error) {
      // A cancel is the user's decision, never a transport failure to retry.
      if (params.signal?.aborted || (error as { name?: unknown } | null)?.name === 'AbortError') {
        throw error;
      }
      if (!isRetryableSonioxFailure(error) || attempt >= maxAttempts) throw error;
      // An attempt that cannot poll is a wasted upload and a wasted job slot,
      // so a spent budget ends the call here instead of allocating more quota.
      if (remainingPollBudgetMs() <= 0) throw pollTimeoutError();
      console.error(
        `[soniox-transcribe] attempt ${attempt}/${maxAttempts} failed with HTTP ${error.status}; retrying`,
      );
      // A retry re-uploads only when this call owns the upload; with a shared
      // file it re-creates just the job, so the bar must not rewind to it.
      params.onProgress?.(
        params.fileId ? SONIOX_TRANSCRIBE_PERCENT : SONIOX_UPLOAD_PERCENT,
        `Retrying Soniox transcription (${attempt + 1}/${maxAttempts})...`,
      );
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), params.signal);
    }
  }
}

// One job/transcript cycle, with its own upload unless the caller supplied a
// file. Separate from the retry wrapper so every attempt gets its own job and
// its own cleanup, and takes the poll budget left for it rather than reading
// the caller's ceiling itself.
async function runSonioxJob(
  params: TranscribeSonioxAudioParams,
  maxPollWaitMs: number,
): Promise<SonioxTranscriptionResult> {
  const fetchImpl = params.fetchImpl ?? defaultFetchImpl;
  const sleep = params.sleep ?? abortableSleep;
  const apiKey = params.apiKey;
  const model = params.model?.trim() || SONIOX_ASYNC_MODEL;
  const languageHints =
    params.languageHints && params.languageHints.length > 0
      ? params.languageHints
      : DEFAULT_LANGUAGE_HINTS;
  const signal = params.signal;

  signal?.throwIfAborted();

  let fileId = params.fileId;
  // A caller-supplied file is shared with the other attempts and retry rungs
  // of the same run, so only the caller may delete it.
  const ownsFile = fileId === undefined;
  let uploadedBytes: number | undefined;
  let transcriptionId: string | undefined;
  const startedAt = Date.now();
  try {
    if (fileId === undefined) {
      params.onProgress?.(SONIOX_UPLOAD_PERCENT, 'Uploading audio to Soniox...');
      const uploaded = await uploadAudioFile({
        fetchImpl,
        apiKey,
        audioFilePath: params.audioFilePath,
        signal,
      });
      fileId = uploaded.fileId;
      uploadedBytes = uploaded.sizeBytes;
      // Honor a cancel only once the id is recorded, so `finally` can delete
      // the object the server already allocated for us.
      signal?.throwIfAborted();
    }
    // stderr, not stdout: `listener transcript <file>` writes the transcript
    // itself to stdout, and a diagnostic line there would corrupt it.
    console.error(
      `[soniox-transcribe] -> ${
        uploadedBytes === undefined
          ? 'reused upload'
          : `${(uploadedBytes / (1024 * 1024)).toFixed(2)}MB`
      } model=${model} ` + `hints=${languageHints.join('+')} terms=${params.terms?.length ?? 0}`,
    );

    transcriptionId = await createTranscription({
      fetchImpl,
      apiKey,
      fileId,
      model,
      languageHints,
      terms: params.terms,
      clientReferenceId: params.clientReferenceId,
      signal,
    });
    signal?.throwIfAborted();

    params.onProgress?.(SONIOX_TRANSCRIBE_PERCENT, 'Transcribing with Soniox...');
    const status = await pollUntilCompleted({
      fetchImpl,
      apiKey,
      transcriptionId,
      sleep,
      pollIntervalMs: params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      maxPollIntervalMs: params.maxPollIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS,
      maxPollWaitMs,
      signal,
      onProgress: params.onProgress,
    });

    params.onProgress?.(SONIOX_FETCH_PERCENT, 'Fetching transcript...');
    const transcript = await fetchTranscript({ fetchImpl, apiKey, transcriptionId, signal });

    // Server-reported model, because retired ids are auto-routed to the
    // successor without a changelog entry (see docs/soniox-adoption-plan.md).
    const resolvedModel = status.model?.trim() || model;
    console.error(
      `[soniox-transcribe] <- ${Date.now() - startedAt}ms model=${resolvedModel} ` +
        `audio=${status.audio_duration_ms ?? 0}ms tokens=${transcript.tokens?.length ?? 0}`,
    );

    if (!Array.isArray(transcript.tokens)) {
      // Missing `tokens` is a malformed response, not silence. Calling it
      // "no speech" would be unrecoverable: the job is deleted right after,
      // so the evidence is gone and the recording looks legitimately empty.
      throw new Error('Soniox transcript response missing tokens');
    }
    const text = formatSonioxTokens(transcript.tokens);
    if (text.trim().length === 0) {
      // Well-formed response with no speech -- silence or noise-only input,
      // not a broken API. Typed so callers can branch (issue #182).
      throw new EmptyTranscriptionError('Soniox transcription returned no speech');
    }
    return { text, audioDurationMs: status.audio_duration_ms, modelId: resolvedModel };
  } finally {
    // Order matters only for tidiness: the job references the file.
    if (transcriptionId) {
      await deleteQuietly({
        fetchImpl,
        apiKey,
        resourcePath: `/v1/transcriptions/${transcriptionId}`,
        label: 'transcription',
      });
    }
    if (ownsFile && fileId) {
      await deleteQuietly({
        fetchImpl,
        apiKey,
        resourcePath: `/v1/files/${fileId}`,
        label: 'file',
      });
    }
  }
}
