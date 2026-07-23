// PII scrubbing for Sentry payloads. Kept free of any `@sentry/electron` VALUE
// import (only `import type`, which tsc erases) so this logic is unit-testable
// under plain `node --test` -- the main SDK pulls in `electron`, which is
// unavailable outside the Electron runtime.
//
// This app records meetings: transcript text, API keys, and OAuth tokens must
// never leave the machine on an event. See sentry.ts for how these run inside
// `beforeSend` / `beforeBreadcrumb`.

import { createHash } from 'node:crypto';
import type { Event } from '@sentry/electron/main';

/**
 * Opaque, stable identifier for telemetry. Use for values that are useful to
 * correlate events (e.g. which meeting keeps failing to sync) but must never
 * leave the machine in the clear. Meeting folder names embed the AI-generated
 * title (`<ts24>_<sanitized-title>`), i.e. meeting content -- sending them raw
 * would break the privacy guarantee, and the scrubber can't catch them (an
 * innocent-looking key holding title-derived text). Same input -> same short
 * hash, so repeated failures still cluster in Sentry while the original value
 * stays unrecoverable.
 */
export function telemetryHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

// Keys whose values are credentials/secrets. Mirrors the redaction lists in
// main.ts (SENSITIVE_LOG_KEY_RE) and renderer-logger.ts.
const SENSITIVE_KEY_RE =
  /(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|secret|webhook|password|token|dsn|cookie)/i;

export function redactString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, 'sk-[REDACTED]');
}

/**
 * Deep-clone a value, redacting secret-shaped string values and dropping values
 * under secret-shaped keys. Used on the free-form parts of a Sentry event
 * (extra, contexts, request, breadcrumb data) and on caller-supplied `extra`.
 */
export function scrubDeep(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return String(value);

  if (seen.has(value)) return '[Circular]';
  if (depth >= 6) return '[MaxDepth]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, depth + 1, seen));

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY_RE.test(key) ? '[REDACTED]' : scrubDeep(item, depth + 1, seen);
  }
  return out;
}

/**
 * Scrub PII from a Sentry event in place: drop the hostname, redact exception
 * messages, filter console breadcrumbs (they can echo transcript text), and
 * deep-scrub the free-form containers.
 */
export function scrubEvent<E extends Event>(event: E): E {
  // Hostname identifies the user's machine.
  delete event.server_name;

  if (event.message) event.message = redactString(event.message);

  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (ex.value) ex.value = redactString(ex.value);
    }
  }

  if (event.extra) event.extra = scrubDeep(event.extra) as Record<string, unknown>;
  if (event.contexts) event.contexts = scrubDeep(event.contexts) as Event['contexts'];
  if (event.request) event.request = scrubDeep(event.request) as Event['request'];

  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs
      .filter((b) => b.category !== 'console')
      .map((b) => ({
        ...b,
        message: b.message ? redactString(b.message) : b.message,
        data: b.data ? (scrubDeep(b.data) as Record<string, unknown>) : b.data,
      }));
  }

  return event;
}
