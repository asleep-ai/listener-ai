// Classifiers for failures that come from the user's environment or provider
// account rather than from a defect in this app: a full disk, an unreachable
// network, an overloaded provider, an exhausted billing balance. Callers use
// them to give actionable copy and to keep these out of Sentry error reports.
//
// Every classifier walks the `cause` chain, because Node/undici wrap the real
// errno (`TypeError: fetch failed` -> `cause: Error { code: 'ENOTFOUND' }`) and
// our own wrappers (TranscriptionError) keep the original as `cause`.

import { EmptyTranscriptionError } from './transcriptionErrors';

// Upper bound on errors visited across the whole graph (cause links plus
// AggregateError members), shared by every branch so a cyclic or very wide
// graph cannot recurse or loop without end.
const MAX_VISITED_ERRORS = 32;

function* causeChain(error: unknown): Generator<unknown> {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  while (queue.length > 0 && seen.size < MAX_VISITED_ERRORS) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    yield current;
    if (current instanceof AggregateError && Array.isArray(current.errors)) {
      queue.push(...current.errors);
    }
    if (typeof current === 'object') queue.push((current as { cause?: unknown }).cause);
  }
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '';
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

const DISK_FULL_CODES = new Set(['ENOSPC', 'EDQUOT']);

/** True when a write failed because the disk (or the user's quota) is full. */
export function isDiskFullError(error: unknown): boolean {
  for (const e of causeChain(error)) {
    const code = errorCode(e);
    if (code && DISK_FULL_CODES.has(code)) return true;
  }
  return false;
}

const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * True when the request never got an HTTP response because the network was
 * unreachable: offline, DNS failure, connect timeout, reset.
 *
 * The decision follows the concrete cause, not the wrapper: undici reports
 * every transport failure as `TypeError: fetch failed`, including local
 * defects such as `write ERANGE` (LISTENER-AI-R). So when the graph carries
 * any concrete errno/undici code, every such code must be a known network
 * code; one unknown code keeps the failure reportable. Only a bare
 * `fetch failed` with no concrete cause at all -- pi-ai flattens the error to
 * `Pi-ai google/<model> failed: fetch failed` -- falls back to the message.
 */
export function isNetworkUnreachableError(error: unknown): boolean {
  let sawNetworkCode = false;
  let sawFetchFailed = false;
  for (const e of causeChain(error)) {
    const code =
      errorCode(e) ??
      (e instanceof Error && e.name === 'ConnectTimeoutError'
        ? 'UND_ERR_CONNECT_TIMEOUT'
        : undefined);
    if (code !== undefined) {
      if (!NETWORK_CODES.has(code)) return false;
      sawNetworkCode = true;
    } else if (hasSyscall(e)) {
      // An errno-shaped error without a code we recognise (e.g. a bare
      // "write ERANGE" with only `syscall`): concrete but unknown.
      return false;
    }
    if (/(^|: )fetch failed$/i.test(errorMessage(e))) sawFetchFailed = true;
  }
  return sawNetworkCode || sawFetchFailed;
}

function hasSyscall(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    typeof (error as { syscall?: unknown }).syscall === 'string'
  );
}

/**
 * True for a provider-side "busy, try later" answer (HTTP 503, Gemini
 * UNAVAILABLE / "high demand", "overloaded"). Not a client defect, and not a
 * missing model either -- the old substring heuristic labelled Gemini's
 * "This model is currently experiencing high demand" as "Model not available".
 */
export function isProviderOverloadedError(error: unknown): boolean {
  for (const e of causeChain(error)) {
    if (errorStatus(e) === 503) return true;
    const message = errorMessage(e);
    if (/"code"\s*:\s*503\b/.test(message)) return true;
    if (/"status"\s*:\s*"UNAVAILABLE"/.test(message)) return true;
    if (/experiencing high demand|model is overloaded|\boverloaded_error\b/i.test(message)) {
      return true;
    }
  }
  return false;
}

/**
 * True when the provider refused because the account has no credit left
 * (HTTP 402, Gemini "prepayment credits are depleted"). A user billing state,
 * not an app failure.
 */
export function isProviderBillingError(error: unknown): boolean {
  for (const e of causeChain(error)) {
    if (errorStatus(e) === 402) return true;
    const message = errorMessage(e);
    if (/"code"\s*:\s*402\b/.test(message)) return true;
    if (/prepayment credits are depleted/i.test(message)) return true;
  }
  return false;
}

/**
 * True when a failed transcription came from the user's environment or
 * provider account (no speech in the audio, offline, provider overloaded or
 * out of credit) rather than from an app defect. These still reach the user
 * with their own message; they are just not Sentry error reports.
 */
export function isExpectedTranscriptionFailure(error: unknown): boolean {
  for (const e of causeChain(error)) {
    if (e instanceof EmptyTranscriptionError) return true;
  }
  return (
    isNetworkUnreachableError(error) ||
    isProviderOverloadedError(error) ||
    isProviderBillingError(error)
  );
}
