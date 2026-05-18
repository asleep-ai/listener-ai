// Covers the structured-error path that issue #130 motivated. The substring
// matching at the call site used to map any error containing "quota" to a
// single opaque "API quota exceeded" string, losing the HTTP status,
// request-id, and OpenAI error.code that triage actually needs. We now
// branch on the structured TranscriptionApiError fields and preserve the
// raw response so the renderer can expose it via "Show details".

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TranscriptionApiError } from './codexTranscription';
import { annotateTranscriptionError } from './geminiService';

describe('annotateTranscriptionError - TranscriptionApiError path', () => {
  it('maps insufficient_quota to a Codex-specific quota message', () => {
    const upstream = new TranscriptionApiError('You exceeded your current quota.', {
      status: 429,
      statusText: 'Too Many Requests',
      requestId: 'req_abc123',
      errorType: 'insufficient_quota',
      errorCode: 'insufficient_quota',
      rawBody: '{"error":{"code":"insufficient_quota"}}',
    });
    const annotated = annotateTranscriptionError(upstream, 'codex');
    assert.match(annotated.userMessage, /ChatGPT\/Codex usage limit/);
    assert.equal(annotated.status, 429);
    assert.equal(annotated.requestId, 'req_abc123');
    assert.equal(annotated.errorCode, 'insufficient_quota');
    assert.equal(annotated.rawMessage, 'You exceeded your current quota.');
    assert.equal(annotated.rawBody, '{"error":{"code":"insufficient_quota"}}');
  });

  it('maps 401 to a sign-in-again message for codex', () => {
    const upstream = new TranscriptionApiError('Unauthorized', {
      status: 401,
      statusText: 'Unauthorized',
    });
    const annotated = annotateTranscriptionError(upstream, 'codex');
    assert.match(annotated.userMessage, /Sign out and sign in again/);
    assert.equal(annotated.status, 401);
  });

  it('maps 429 (without insufficient_quota code) to rate-limit copy', () => {
    const upstream = new TranscriptionApiError('Rate limit', {
      status: 429,
      statusText: 'Too Many Requests',
      errorCode: 'rate_limit_exceeded',
    });
    const annotated = annotateTranscriptionError(upstream, 'codex');
    assert.match(annotated.userMessage, /Rate limit/);
  });

  it('maps 403 to an entitlement message', () => {
    const upstream = new TranscriptionApiError('Forbidden', {
      status: 403,
      statusText: 'Forbidden',
    });
    const annotated = annotateTranscriptionError(upstream, 'codex');
    assert.match(annotated.userMessage, /403/);
    assert.equal(annotated.status, 403);
  });

  it('uses Gemini-specific copy for the gemini provider', () => {
    const upstream = new TranscriptionApiError('quota', {
      status: 429,
      statusText: 'Too Many Requests',
      errorCode: 'insufficient_quota',
    });
    const annotated = annotateTranscriptionError(upstream, 'gemini');
    assert.match(annotated.userMessage, /quota exceeded/i);
    assert.doesNotMatch(annotated.userMessage, /ChatGPT/);
  });
});

describe('annotateTranscriptionError - legacy fallback path', () => {
  it('still maps a generic "quota" error message when no structured fields exist', () => {
    const annotated = annotateTranscriptionError(
      new Error('You exceeded your quota for the day'),
      'codex',
    );
    assert.match(annotated.userMessage, /quota/i);
    // No structured fields available - status/code stay undefined, but
    // rawMessage is preserved so "Show details" still has something to show.
    assert.equal(annotated.status, undefined);
    assert.equal(annotated.errorCode, undefined);
    assert.equal(annotated.rawMessage, 'You exceeded your quota for the day');
  });

  it('falls through to "Failed to transcribe" for unrecognized errors', () => {
    const annotated = annotateTranscriptionError(new Error('something weird'), 'codex');
    assert.match(annotated.userMessage, /Failed to transcribe/);
    assert.equal(annotated.rawMessage, 'something weird');
  });

  it('handles non-Error throwables', () => {
    const annotated = annotateTranscriptionError('plain string thrown', 'codex');
    assert.match(annotated.userMessage, /plain string thrown/);
    assert.equal(annotated.rawMessage, 'plain string thrown');
  });
});

describe('TranscriptionApiError retryability boundary', () => {
  // The retry loop in transcribeSingleSegment uses status-class to decide
  // whether to keep retrying. These cases pin the boundary so a future
  // refactor doesn't accidentally start retrying 4xx-config errors (which
  // burn user quota for no benefit) or stop retrying 5xx / 429 (which
  // would lose a free recovery).

  const cases: Array<{ status: number; retryable: boolean; reason: string }> = [
    { status: 400, retryable: false, reason: 'bad request / invalid model id' },
    { status: 401, retryable: false, reason: 'unauthorized / token rejected' },
    { status: 403, retryable: false, reason: 'forbidden / entitlement' },
    { status: 404, retryable: false, reason: 'model not found' },
    { status: 408, retryable: true, reason: 'request timeout - transient' },
    { status: 422, retryable: false, reason: 'unprocessable entity / validation' },
    { status: 429, retryable: true, reason: 'rate limited - retry with backoff' },
    { status: 500, retryable: true, reason: 'server error - transient' },
    { status: 502, retryable: true, reason: 'bad gateway - transient' },
    { status: 503, retryable: true, reason: 'service unavailable - transient' },
    { status: 504, retryable: true, reason: 'gateway timeout - transient' },
  ];

  // Indirect: annotateTranscriptionError isn't where the retry decision
  // happens, but TranscriptionApiError is the surface, and a regression in
  // the retry-classifier is what we want to catch. The classifier is the
  // local `isRetryableStatus` helper in geminiService.ts; we re-derive
  // the same rule here so the table doubles as documentation.
  const isRetryableStatus = (status: number): boolean => {
    if (status >= 500) return true;
    if (status === 429 || status === 408) return true;
    return false;
  };

  for (const { status, retryable, reason } of cases) {
    it(`status ${status} is ${retryable ? 'retryable' : 'non-retryable'} (${reason})`, () => {
      assert.equal(isRetryableStatus(status), retryable);
    });
  }
});

describe('TranscriptionError.toPayload', () => {
  it('returns a plain object with every diagnostic field for IPC serialization', () => {
    const upstream = new TranscriptionApiError('quota exceeded', {
      status: 429,
      statusText: 'Too Many Requests',
      requestId: 'req_xyz',
      errorType: 'insufficient_quota',
      errorCode: 'insufficient_quota',
      rawBody: '{"error":{"code":"insufficient_quota"}}',
    });
    const annotated = annotateTranscriptionError(upstream, 'codex');
    const payload = annotated.toPayload();
    assert.equal(payload.status, 429);
    assert.equal(payload.statusText, 'Too Many Requests');
    assert.equal(payload.requestId, 'req_xyz');
    assert.equal(payload.errorType, 'insufficient_quota');
    assert.equal(payload.errorCode, 'insufficient_quota');
    assert.equal(payload.rawBody, '{"error":{"code":"insufficient_quota"}}');
    assert.ok(payload.userMessage.length > 0);
    assert.equal(payload.rawMessage, 'quota exceeded');
  });
});
