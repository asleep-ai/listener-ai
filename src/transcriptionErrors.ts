// Error types shared by every batch transcription backend.
//
// These used to live in `codexTranscription.ts`, which made them the de-facto
// "OpenAI transcription" errors even though the pipeline treats them as
// provider-neutral control flow. A third backend (Soniox) must be able to
// throw them without importing the Codex client, so they live here and
// `codexTranscription.ts` re-exports them for existing importers.

export interface TranscriptionApiErrorDetails {
  status: number;
  statusText: string;
  requestId?: string;
  errorType?: string;
  errorCode?: string;
  rawBody?: string;
}

export class TranscriptionApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly requestId?: string;
  readonly errorType?: string;
  readonly errorCode?: string;
  readonly rawBody?: string;
  constructor(message: string, details: TranscriptionApiErrorDetails) {
    super(message);
    this.name = 'TranscriptionApiError';
    this.status = details.status;
    this.statusText = details.statusText;
    this.requestId = details.requestId;
    this.errorType = details.errorType;
    this.errorCode = details.errorCode;
    this.rawBody = details.rawBody;
  }
  toJSON(): TranscriptionApiErrorDetails & { message: string; name: string } {
    return {
      name: this.name,
      message: this.message,
      status: this.status,
      statusText: this.statusText,
      requestId: this.requestId,
      errorType: this.errorType,
      errorCode: this.errorCode,
      rawBody: this.rawBody,
    };
  }
}

// Thrown when the provider processed the audio fine but produced no usable
// speech (silence, noise-only input). Distinct from TranscriptionApiError so
// callers can branch: whole-file transcription surfaces it as a friendly
// "no speech found" error, while per-segment and live-snippet callers treat
// it as an empty result instead of failing the whole run (issue #182).
export class EmptyTranscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmptyTranscriptionError';
  }
}

export function isRetryableStatus(status: number): boolean {
  // Worth retrying: server errors (5xx), rate-limit (429), and the rare
  // 408 request-timeout. Everything else in 4xx is a non-transient client
  // / config issue (invalid model id, bad request shape, auth, billing).
  if (status >= 500) return true;
  if (status === 429 || status === 408) return true;
  return false;
}
