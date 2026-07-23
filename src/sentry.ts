// Sentry error tracking for the Electron MAIN process.
//
// This module is the single egress + control point for all Sentry activity:
//   - The renderer SDK (@sentry/electron/renderer) forwards its events here over
//     IPC (the bridge is auto-injected by the default `preloadInjectionIntegration`,
//     which ships a sandbox-safe preload -- so our own sandboxed preload.ts must
//     NOT `import '@sentry/electron/preload'`, which would fail the sandbox's
//     arbitrary-require restriction).
//   - `beforeSend` is the opt-out gate: when crash reporting is disabled it drops
//     every event (JS + native minidump), so the single `enabled` flag governs
//     both processes.
//   - `beforeSend` + `beforeBreadcrumb` scrub PII (see sentryScrub.ts). This app
//     records meetings, so transcript text and API keys must never leave the box.
//
// The DSN is resolved from env (`SENTRY_DSN`) then the build-time bundle
// (dist/buildConstants.js, see scripts/write-build-constants.js), mirroring
// googleOAuth.ts. Absent DSN or NODE_ENV=test => init is a no-op, so unit tests
// and un-provisioned builds never emit events.

import type { Breadcrumb, ErrorEvent } from '@sentry/electron/main';
import { scrubDeep, scrubEvent } from './sentryScrub';

// `@sentry/electron/main` is required LAZILY inside doInit(), never at module
// top level. The package reads `process.versions.electron` at its own load time
// (electron-normalize.js) with no undefined guard, so a static
// `import ... from '@sentry/electron/main'` throws under plain `node --test`
// (electron is undefined there). `reportError` is imported by unit-tested
// services, so importing THIS module must stay safe outside Electron -- the
// require only happens once we actually initialize in the real main process.
type SentryMain = typeof import('@sentry/electron/main');
let sentry: SentryMain | null = null;

export type ReportSeverity = 'fatal' | 'error' | 'warning';

export interface ReportContext {
  /** Dotted `domain.action` label, e.g. `transcription.save`, `drive.upload`. */
  operation: string;
  severity?: ReportSeverity;
  /** Safe, non-PII metadata (ids, codes, counts). Scrubbed again before send. */
  extra?: Record<string, unknown>;
}

let enabled = false;
let initialized = false;
let initOptions: { release?: string; environment?: string } = {};

interface SentryBuildConstants {
  sentryDsn?: string;
}

let cachedBuildConstants: SentryBuildConstants | null | undefined;

function loadBuildConstants(): SentryBuildConstants | null {
  // Bypass the bundle in tests so events are never emitted regardless of what
  // the dev's last build baked. Matches googleOAuth.ts.
  if (process.env.NODE_ENV === 'test') return null;
  if (cachedBuildConstants !== undefined) return cachedBuildConstants;
  try {
    // Compiled sibling: dist/sentry.js -> dist/buildConstants.js.
    const mod: unknown = require('./buildConstants');
    cachedBuildConstants = (mod || null) as SentryBuildConstants | null;
  } catch {
    cachedBuildConstants = null;
  }
  return cachedBuildConstants;
}

function resolveDsn(): string {
  const bundled = loadBuildConstants();
  return process.env.SENTRY_DSN?.trim() || bundled?.sentryDsn?.trim() || '';
}

function doInit(): void {
  if (initialized) return;
  if (process.env.NODE_ENV === 'test') return;
  const dsn = resolveDsn();
  if (!dsn) return; // Un-provisioned build: stay silent, never crash.
  // Lazy require (see note at top) -- safe here: doInit only runs in the real
  // Electron main process, never in tests (guarded above) or without a DSN.
  sentry = require('@sentry/electron/main') as SentryMain;
  initialized = true;

  sentry.init({
    dsn,
    release: initOptions.release,
    environment: initOptions.environment,
    // Never attach IP/user/cookies automatically -- this is a meeting recorder.
    sendDefaultPii: false,
    // Console output can echo transcript text or secrets; never keep it as a
    // breadcrumb trail. (electronBreadcrumbs + console integrations are on by
    // default.)
    beforeBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
      return breadcrumb.category === 'console' ? null : breadcrumb;
    },
    beforeSend(event: ErrorEvent): ErrorEvent | null {
      if (!enabled) return null; // Runtime opt-out gate (also covers minidumps).
      return scrubEvent(event);
    },
  });
}

/**
 * Initialize main-process Sentry. Call once, as early as possible after
 * `app.setPath('userData', ...)`. When `enabled` is false we skip init entirely
 * so a user who opted out collects and transmits nothing until they opt back in.
 */
export function initMainSentry(opts: {
  enabled: boolean;
  release?: string;
  environment?: string;
}): void {
  enabled = opts.enabled;
  initOptions = { release: opts.release, environment: opts.environment };
  if (opts.enabled) doInit();
}

/**
 * Runtime opt-out toggle, wired from `applyConfigSideEffects`. Turning it on
 * lazily initializes if the app started opted-out; turning it off flips the
 * `beforeSend` gate so subsequent events are dropped (full native teardown
 * waits for the next restart -- documented limitation).
 */
export function setSentryEnabled(next: boolean): void {
  enabled = next;
  if (next) doInit();
}

/**
 * Report a failure of a user-intended operation. No-op when crash reporting is
 * disabled or un-provisioned. Prefer this over calling Sentry directly so the
 * enable-gate, tagging, and extra-scrubbing stay centralized.
 */
export function reportError(error: unknown, ctx: ReportContext): void {
  if (!enabled || !initialized || !sentry) return;
  const s = sentry;
  s.withScope((scope) => {
    scope.setTag('operation', ctx.operation);
    scope.setLevel(ctx.severity ?? 'error');
    if (ctx.extra) {
      scope.setContext('operation_extra', scrubDeep(ctx.extra) as Record<string, unknown>);
    }
    s.captureException(error instanceof Error ? error : new Error(String(error)));
  });
}
