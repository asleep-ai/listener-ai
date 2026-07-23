// Sentry error tracking for the Electron RENDERER process.
//
// All configuration lives in the MAIN process (src/sentry.ts): DSN, release,
// environment, the enable/opt-out gate, and PII scrubbing. The renderer SDK
// forwards its events to main over IPC (bridge auto-injected by the main
// process's `preloadInjectionIntegration`), where `beforeSend` gates + scrubs
// them. So when the user has opted out, main never initializes and these
// forwarded events have nowhere to go -- a single control point for both
// processes.
//
// We still pass `beforeBreadcrumb` here to drop console breadcrumbs locally, so
// transcript text captured by the console shim (renderer-logger.ts) never even
// leaves the renderer as breadcrumb data.

import * as Sentry from '@sentry/electron/renderer';

export type ReportSeverity = 'fatal' | 'error' | 'warning';

export interface ReportContext {
  /** Dotted `domain.action` label, e.g. `recording.start`, `live.realtime`. */
  operation: string;
  severity?: ReportSeverity;
  /** Safe, non-PII metadata (ids, codes, counts). */
  extra?: Record<string, unknown>;
}

export function initRendererSentry(): void {
  Sentry.init({
    beforeBreadcrumb(breadcrumb) {
      return breadcrumb.category === 'console' ? null : breadcrumb;
    },
  });
}

/**
 * Report a failure of a user-intended operation from the renderer. Forwards to
 * the main process, which drops it when the user has opted out. Prefer this over
 * calling Sentry directly so tagging stays consistent with the main helper.
 */
export function reportError(error: unknown, ctx: ReportContext): void {
  Sentry.withScope((scope) => {
    scope.setTag('operation', ctx.operation);
    scope.setLevel(ctx.severity ?? 'error');
    if (ctx.extra) scope.setContext('operation_extra', ctx.extra);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)));
  });
}
