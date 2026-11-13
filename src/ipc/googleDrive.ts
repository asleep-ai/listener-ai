import * as fs from 'fs';
import * as path from 'path';
import { app, ipcMain, shell } from 'electron';
import {
  type GoogleOAuthCredentials,
  loginGoogleOAuth,
  resolveGoogleAccessToken,
} from '../googleOAuth';
import { syncChangedLocalNotes } from '../meetingList';
import { getTranscriptionsDir } from '../outputService';
import { isDiskFullError } from '../errorClassification';
import { reportError } from '../sentry';
import { GoogleDriveClient, isTransientDriveError } from '../services/googleDriveService';
import {
  AudioRestoreError,
  buildLocalStorageReport,
  cleanupRestoreTemps,
  meetingsForAudio,
  type ReclaimResult,
  reclaimLocalAudio,
  recordingsDirFor,
  restoreLocalAudio,
} from '../services/localAudioStorage';
import {
  type GoogleSession,
  GoogleSessionTracker,
  withGoogleCredentialLock,
} from '../services/googleSession';
import { SyncEngine, type SyncProgressEvent, type SyncResult } from '../services/syncEngine';
import { backgroundOperations, operationTarget } from './backgroundOperations';
import type { IpcContext } from './types';

// Google Drive sync: OAuth + manual sync + auto-trigger + periodic timer.
// Mirrors the Codex OAuth IPC pattern. The sync engine itself lives in
// src/services/syncEngine.ts; this module just orchestrates triggers.

// Module-level singleton ctx. Set on register(); exported functions
// (refreshGoogleSyncTimer, maybeAutoSync) reference this singleton so callers
// outside the IPC handlers (main.ts startup, applyConfigSideEffects,
// save-transcription, merge-recordings) can drive sync without re-passing ctx.
let ctxRef: IpcContext | null = null;

function requireCtx(): IpcContext {
  if (!ctxRef) {
    throw new Error('googleDrive IPC module used before register() was called.');
  }
  return ctxRef;
}

let pendingGoogleLogin: { controller: AbortController; done: Promise<void> } | null = null;
let googleSyncTimer: NodeJS.Timeout | null = null;
// The 5s post-enable kick is tracked separately from the periodic interval so
// `refreshGoogleSyncTimer` can cancel it when the user toggles off within the
// window (otherwise the deferred sync runs after they think it's disabled).
let googleSyncInitialKick: NodeJS.Timeout | null = null;
// The running cycle and the Google session it runs under. A trigger that
// arrives while it runs joins it only while that session is still the current
// sign-in: a manual "Sync now" awaits the same result, and an automatic
// trigger (a save or delete) asks for one more cycle after it so the change is
// not left for the next tick. After a sign-in change a trigger never receives
// the old account's result; its own cycle runs once the old one has settled.
let googleSyncRun: {
  promise: Promise<SyncResult | undefined>;
  session: GoogleSession | null;
} | null = null;
let googleSyncRerunRequested = false;
// Undefined until first read: the last completed cycle survives an app
// restart through sync-state.json, which the engine writes after each cycle.
let googleLastSyncedAt: string | null | undefined;
let googleLastSyncResult: SyncResult | null = null;
// The last cycle's failure, kept until a later cycle succeeds so a window that
// opens or reloads afterwards still shows it.
let googleLastError: string | null = null;
// The sign-in that failure belongs to; after a sign-in change (here or in the
// CLI) it no longer describes the current account.
let googleLastErrorAccount: string | null = null;

function setLastError(message: string | null): void {
  googleLastError = message;
  googleLastErrorAccount = message ? (sessions().capture()?.accountKey ?? null) : null;
}

function currentLastError(): string | null {
  if (!googleLastError) return null;
  return (sessions().capture()?.accountKey ?? null) === googleLastErrorAccount
    ? googleLastError
    : null;
}
// Whether the last scheduler check found sync enabled and signed in; only
// used to log transitions.
let googleSyncSchedulerActive = false;
// Most recent progress event from the currently-running sync. Cleared when
// the cycle finishes so getGoogleSyncStatus doesn't surface a stale "Syncing
// 7/12" pill after a sync error and the next modal open.
let googleSyncProgress: SyncProgressEvent | null = null;
const GOOGLE_SYNC_INTERVAL_MS = 60_000;
// After a sync stops on a full disk, automatic triggers wait this long before
// trying again; every cycle would otherwise fail the same way each minute.
// "Sync now" still runs immediately.
const GOOGLE_SYNC_DISK_FULL_BACKOFF_MS = 15 * 60_000;
// A full disk is the user's machine state, not an app defect: keep one
// warning a day for visibility instead of a report per cycle.
const DISK_FULL_REPORT_THROTTLE_MS = 24 * 60 * 60_000;
const GOOGLE_SYNC_DISK_FULL_MESSAGE =
  'Not enough disk space to sync with Google Drive. Free up space on this computer; sync will try again automatically.';
let googleSyncDiskFullUntil = 0;
// Delay before the first sync after enable/sign-in. Short enough that users
// see activity quickly, long enough that batched config saves (multi-key
// settings modal commits) don't trigger multiple bursts in flight.
const GOOGLE_SYNC_INITIAL_DELAY_MS = 5_000;
// server.close() in Node releases the listening socket via libuv on the next
// tick, but `loginGoogleOAuth` doesn't await its callback. Hold the slot for a
// short cushion so a re-bind cannot race the kernel.
const PORT_RELEASE_CUSHION_MS = 250;

function broadcastGoogleSyncStatus(
  phase: 'idle' | 'syncing' | 'success' | 'error',
  extra?: { result?: SyncResult; error?: string },
): void {
  const mainWindow = requireCtx().getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('google-sync-status', {
      phase,
      lastSyncedAt: lastSyncedAt(),
      result: extra?.result,
      error: extra?.error,
    });
  }
}

function broadcastGoogleSyncProgress(event: SyncProgressEvent): void {
  googleSyncProgress = event;
  const mainWindow = requireCtx().getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('google-sync-progress', event);
  }
}

// Sign-in generation for this process; see googleSession.ts.
let sessionTracker: GoogleSessionTracker<GoogleOAuthCredentials> | null = null;
function sessions(): GoogleSessionTracker<GoogleOAuthCredentials> {
  if (!sessionTracker) {
    const { configService } = requireCtx();
    // Reads the persisted sign-in, so a CLI sign-out or account switch is seen
    // even though this process's ConfigService caches config.json.
    sessionTracker = new GoogleSessionTracker<GoogleOAuthCredentials>(
      () => configService.readPersistedGoogleOAuth(),
      () => configService.readPersistedStoredGoogleOAuth(),
      (action) => withGoogleCredentialLock(app.getPath('userData'), action),
    );
  }
  return sessionTracker;
}

// Restores in flight; a sign-in change cancels them.
const restoreControllers = new Set<AbortController>();

function onGoogleSessionChanged(): void {
  sessions().bump();
  // The previous account's outcome does not describe the new sign-in.
  setLastError(null);
  googleLastSyncResult = null;
  for (const controller of restoreControllers) controller.abort();
}

// The client carries the credentials and session of ONE persisted snapshot
// (see GoogleSessionTracker.snapshot). Refreshed tokens are persisted only
// while that session is current and a stored sign-in of the same account
// exists, so env-sourced tokens never leak into config.json and a late
// refresh cannot overwrite or resurrect another sign-in.
function buildDriveClient(snapshot: {
  credentials: GoogleOAuthCredentials;
  session: GoogleSession;
}): GoogleDriveClient {
  const { configService } = requireCtx();
  const { credentials, session } = snapshot;
  return new GoogleDriveClient({
    getAccessToken: async () => {
      if (!sessions().isCurrent(session)) {
        throw new Error('The Google sign-in changed; this Drive operation was stopped.');
      }
      const token = await resolveGoogleAccessToken({
        credentials,
        onCredentialsChanged: async (next) => {
          await sessions().persistRefreshed(session, next, (value) =>
            configService.setGoogleOAuth(value),
          );
        },
      });
      if (!token) throw new Error('Failed to resolve Google access token.');
      return token;
    },
  });
}

// Sync and local audio removal both read and act on sync-state.json and the
// recordings folder; they never overlap inside this process. (Across
// processes, removal re-verifies with Drive and the engine treats a missing
// source audio as cloud-only, so an interleaved CLI run cannot lose data.)
let storageChain: Promise<unknown> = Promise.resolve();
function serializeStorage<T>(work: () => Promise<T>): Promise<T> {
  const run = storageChain.then(work, work);
  storageChain = run.catch(() => {});
  return run;
}

// Join identity for Drive-backed operations: the same target under the same
// sign-in. Kept out of operation snapshots (the account key can be a token).
function sessionJoinKey(session: GoogleSession | null, target: string): string {
  return JSON.stringify([session?.accountKey ?? null, session?.generation ?? null, target]);
}

function notifyLocalStorageChanged(): void {
  const window = requireCtx().getMainWindow();
  if (window && !window.isDestroyed()) {
    window.webContents.send('recordings-changed');
    window.webContents.send('local-storage-changed');
  }
}

function isAudioInUse(audioPath: string): boolean {
  return requireCtx().isAudioInUse?.(audioPath) ?? false;
}

// Automatic policy: after a successful sync, remove local audio unused for
// the configured number of days whose Drive copies verify. Stops between
// files when the setting, sync toggle, or account changes.
async function runAutomaticAudioOffload(
  driveClient: GoogleDriveClient,
  dataPath: string,
  session: GoogleSession | null,
): Promise<void> {
  // The policy as persisted now: the CLI may have turned it (or sync) off
  // since this process loaded its config, and removal must honor that.
  const days = offloadDays();
  if (days <= 0 || !driveEnabled()) return;
  // The client verifies against the account the sync started under; stop if
  // that is no longer the signed-in session.
  if (!sessions().isCurrent(session)) return;
  const result = await reclaimLocalAudio({
    dataPath,
    driveClient,
    olderThanDays: days,
    isInUse: isAudioInUse,
    shouldContinue: () => offloadDays() === days && driveEnabled() && sessions().isCurrent(session),
    logger: (msg) => console.log(`[local-audio] ${msg}`),
  });
  if (result.removed.length > 0) {
    console.log(
      `[local-audio] Automatic cleanup removed ${result.removed.length} local recording(s), ${result.freedBytes} bytes.`,
    );
    notifyLocalStorageChanged();
  }
}

const NOT_SIGNED_IN_MESSAGE = 'Not signed in to Google Drive.';

// The last completed cycle: this process's, else the one recorded in
// sync-state.json (by an earlier run of the app or by the CLI).
function lastSyncedAt(): string | null {
  if (googleLastSyncedAt === undefined) {
    try {
      const statePath = path.join(app.getPath('userData'), 'sync-state.json');
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as { lastSyncedAt?: unknown };
      googleLastSyncedAt = typeof parsed.lastSyncedAt === 'string' ? parsed.lastSyncedAt : null;
    } catch {
      googleLastSyncedAt = null;
    }
  }
  return googleLastSyncedAt;
}

// Starts a cycle, or joins the one already running.
function runGoogleSync(): Promise<SyncResult | undefined> {
  const prior = googleSyncRun;
  if (prior && sessions().isCurrent(prior.session)) return prior.promise;
  const entry: NonNullable<typeof googleSyncRun> = {
    promise: Promise.resolve(undefined),
    session: sessions().capture(),
  };
  entry.promise = (prior ? prior.promise.catch(() => undefined) : Promise.resolve(undefined))
    .then(() => runGoogleSyncCycle(entry.session))
    .finally(() => {
      if (googleSyncRun === entry) googleSyncRun = null;
      if (googleSyncRerunRequested && !googleSyncRun) {
        googleSyncRerunRequested = false;
        maybeAutoSync();
      }
    });
  googleSyncRun = entry;
  return entry.promise;
}

// `expected` is the sign-in the cycle was requested under. A cycle queued
// behind an older account's cycle does not run if the sign-in changed again
// while it waited; the request made under the newer sign-in runs instead.
async function runGoogleSyncCycle(expected: GoogleSession | null): Promise<SyncResult | undefined> {
  const { configService } = requireCtx();
  // Credentials and session come from the same persisted read, so a CLI
  // sign-out or switch since this process loaded config.json is honored.
  const snapshot = sessions().snapshot();
  if (!snapshot) {
    setLastError(NOT_SIGNED_IN_MESSAGE);
    return undefined;
  }
  const { session } = snapshot;
  if (
    !expected ||
    expected.accountKey !== session.accountKey ||
    expected.generation !== session.generation
  ) {
    return undefined;
  }
  // Shared status describes the current sign-in only; a cycle that finishes
  // after the account changed still answers its own callers but leaves the
  // status alone.
  const recordStatus = () => sessions().isCurrent(session);

  broadcastGoogleSyncStatus('syncing');
  try {
    const dataPath = app.getPath('userData');
    const driveClient = buildDriveClient(snapshot);
    const engine = new SyncEngine({
      driveClient,
      transcriptionsDir: getTranscriptionsDir(dataPath),
      syncStatePath: path.join(dataPath, 'sync-state.json'),
      recordingsDir: recordingsDirFor(dataPath),
      logger: (msg) => console.log(`[google-sync] ${msg}`),
      // Progress from a cycle whose sign-in has since changed would describe
      // the wrong account.
      onProgress: (event) => {
        if (recordStatus()) broadcastGoogleSyncProgress(event);
      },
      configSync: configService,
    });
    const result = await serializeStorage(async () => {
      const synced = await engine.syncOnce();
      try {
        await runAutomaticAudioOffload(driveClient, dataPath, session);
      } catch (error) {
        console.warn('[local-audio] automatic cleanup failed:', error);
        if (!isTransientDriveError(error)) {
          reportError(error, { operation: 'storage.autoOffload', severity: 'warning' });
        }
      }
      return synced;
    });
    if (syncChangedLocalNotes(result)) {
      const window = requireCtx().getMainWindow();
      if (window && !window.isDestroyed()) window.webContents.send('recordings-changed');
    }
    if (!recordStatus()) {
      // Ends any "Syncing..." shown for it without reporting its outcome as
      // the current account's.
      broadcastGoogleSyncStatus('idle');
      return result;
    }
    googleSyncDiskFullUntil = 0;
    googleLastSyncedAt = new Date().toISOString();
    googleLastSyncResult = result;
    setLastError(
      result.errors.length > 0 ? `Sync finished with ${result.errors.length} error(s)` : null,
    );
    broadcastGoogleSyncStatus(result.errors.length > 0 ? 'error' : 'success', { result });
    return result;
  } catch (error) {
    if (!recordStatus()) {
      broadcastGoogleSyncStatus('idle');
      return undefined;
    }
    if (isDiskFullError(error)) {
      console.error('Google Drive sync stopped: disk full:', error);
      googleSyncDiskFullUntil = Date.now() + GOOGLE_SYNC_DISK_FULL_BACKOFF_MS;
      reportError(error, {
        operation: 'drive.sync.disk-full',
        severity: 'warning',
        throttleMs: DISK_FULL_REPORT_THROTTLE_MS,
      });
      setLastError(GOOGLE_SYNC_DISK_FULL_MESSAGE);
      broadcastGoogleSyncStatus('error', { error: GOOGLE_SYNC_DISK_FULL_MESSAGE });
      return undefined;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error('Google Drive sync failed:', error);
    // Transient Google 5xx/429 and offline drops are noise, not actionable --
    // still surfaced to the user via the error status broadcast below.
    if (!isTransientDriveError(error)) {
      reportError(error, { operation: 'drive.sync', severity: 'error' });
    }
    setLastError(message);
    broadcastGoogleSyncStatus('error', { error: message });
    return undefined;
  } finally {
    googleSyncProgress = null;
  }
}

// Whether automatic sync should run, judged from config.json as persisted
// now rather than this process's cached copy: the CLI (`listener config set
// googleDriveEnabled`, `listener google login`) or another process can turn
// sync on or sign in after this process loaded its config, and the scheduler
// must pick that up without anyone opening or saving Settings.
function autoSyncAllowed(): boolean {
  return driveEnabled() && sessions().snapshot() !== null;
}

// Persisted settings, falling back to this process's cache when config.json
// cannot be read.
function driveEnabled(): boolean {
  const { configService } = requireCtx();
  return configService.readPersistedGoogleDriveEnabled() ?? configService.getGoogleDriveEnabled();
}

function offloadDays(): number {
  const { configService } = requireCtx();
  return (
    configService.readPersistedAudioOffloadAfterDays() ?? configService.getAudioOffloadAfterDays()
  );
}

// The one start/stop point for automatic sync. The periodic tick is armed
// once and stays armed for the life of the main process; each tick re-checks
// `autoSyncAllowed`, so enabling, disabling, signing in or out (here or in
// another process) takes effect on the next tick. A call while sync is
// allowed also schedules one cycle shortly after, so a toggle shows activity
// quickly.
export function refreshGoogleSyncTimer(): void {
  // Cancel any pending initial kick unconditionally. If sync is still allowed
  // it is re-armed below; if not, this prevents a stray timeout from
  // executing a sync the user thinks they disabled.
  if (googleSyncInitialKick) {
    clearTimeout(googleSyncInitialKick);
    googleSyncInitialKick = null;
  }
  if (!googleSyncTimer) {
    googleSyncTimer = setInterval(() => {
      autoSync({ periodic: true });
    }, GOOGLE_SYNC_INTERVAL_MS);
  }
  if (noteSchedulerState(autoSyncAllowed())) {
    googleSyncInitialKick = setTimeout(() => {
      googleSyncInitialKick = null;
      maybeAutoSync();
    }, GOOGLE_SYNC_INITIAL_DELAY_MS);
  }
}

function noteSchedulerState(allowed: boolean): boolean {
  if (allowed !== googleSyncSchedulerActive) {
    googleSyncSchedulerActive = allowed;
    console.log(allowed ? 'Google Drive sync timer started.' : 'Google Drive sync timer stopped.');
  }
  return allowed;
}

// Fire-and-forget sync trigger: the periodic tick, the post-transcription
// save path AND the meeting-delete path (so tombstone propagation kicks in
// promptly). Skips silently when sync is disabled or unauthenticated so the
// caller is never blocked on Drive availability. A trigger during a running
// cycle runs one more cycle after it, so its change is not left for the next
// tick.
export function maybeAutoSync(): void {
  autoSync({ periodic: false });
}

// A periodic tick during a running cycle of the current sign-in is skipped:
// that cycle already covers it, and asking for another would chain cycles
// back to back whenever one takes longer than the interval.
function autoSync({ periodic }: { periodic: boolean }): void {
  if (!noteSchedulerState(autoSyncAllowed())) return;
  if (Date.now() < googleSyncDiskFullUntil) return;
  if (googleSyncRun && sessions().isCurrent(googleSyncRun.session)) {
    if (!periodic) googleSyncRerunRequested = true;
    return;
  }
  void runGoogleSync();
}

// restoreAudio as a tracked background operation: a second download of the
// same recording or note while one runs joins it. The session is part of the
// identity, as for free.
function restoreTracked(target: { folderPath?: string; audioPath?: string }) {
  // restoreAudio acts on the note folder when one is given, so that wins
  // here too; both fields are part of the join identity.
  const named = target.folderPath ?? target.audioPath;
  if (!named) return restoreAudio(target);
  const resolved = operationTarget(named);
  return backgroundOperations.run(
    'local-audio-restore',
    resolved,
    () => restoreAudio(target),
    undefined,
    sessionJoinKey(
      sessions().capture(),
      JSON.stringify([
        target.folderPath ? operationTarget(target.folderPath) : null,
        target.audioPath ? operationTarget(target.audioPath) : null,
      ]),
    ),
  );
}

/** Downloads a cloud-only recording for main-owned work (see IpcContext.restoreCloudAudio). */
export function restoreRecordingAudio(audioPath: string) {
  return restoreTracked({ audioPath });
}

/**
 * Downloads a note's audio back from Drive (conventional "download on
 * demand"). Accepts the note folder or the recording path. Returns the local
 * path, already present or freshly restored.
 */
export async function restoreAudio(target: {
  folderPath?: string;
  audioPath?: string;
}): Promise<
  | { success: true; path: string; downloaded: boolean }
  | { success: false; error: string; code?: string }
> {
  const ctx = requireCtx();
  const dataPath = app.getPath('userData');
  let meeting: string | undefined;
  if (target.folderPath) {
    if (!ctx.isContainedTranscriptionPath(target.folderPath)) {
      return { success: false, error: 'Invalid meeting folder' };
    }
    meeting = path.basename(target.folderPath);
  } else if (typeof target.audioPath === 'string' && target.audioPath) {
    meeting = meetingsForAudio(dataPath, target.audioPath)[0];
  }
  if (!meeting) return { success: false, error: 'No meeting links this audio.', code: 'no-audio' };
  const snapshot = sessions().snapshot();
  if (!snapshot) {
    return {
      success: false,
      error: 'Sign in to Google Drive to download this audio.',
      code: 'signed-out',
    };
  }
  const controller = new AbortController();
  restoreControllers.add(controller);
  try {
    cleanupRestoreTemps(dataPath);
    const restored = await restoreLocalAudio({
      dataPath,
      driveClient: buildDriveClient(snapshot),
      shouldContinue: () => sessions().isCurrent(snapshot.session),
      meetingFolder: meeting,
      signal: controller.signal,
    });
    if (restored.downloaded) notifyLocalStorageChanged();
    return { success: true, path: restored.path, downloaded: restored.downloaded };
  } catch (error) {
    if (controller.signal.aborted) {
      return {
        success: false,
        error: 'Download cancelled: the Google sign-in changed.',
        code: 'cancelled',
      };
    }
    if (!(error instanceof AudioRestoreError) && !isTransientDriveError(error)) {
      reportError(error, { operation: 'storage.restore', severity: 'warning' });
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof AudioRestoreError ? { code: error.code } : {}),
    };
  } finally {
    restoreControllers.delete(controller);
  }
}

export function register(ctx: IpcContext): void {
  ctxRef = ctx;

  ipcMain.handle('local-storage-report', async () => {
    try {
      const dataPath = app.getPath('userData');
      return {
        success: true as const,
        report: buildLocalStorageReport(dataPath),
        // Persisted state, so a CLI sign-in or setting change shows here.
        signedIn: sessions().capture() !== null,
        syncEnabled: driveEnabled(),
        offloadAfterDays: offloadDays(),
      };
    } catch (error) {
      reportError(error, { operation: 'storage.report', severity: 'warning' });
      return {
        success: false as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  // Manual "free up space": removes local copies only (never Drive, never the
  // note). `paths` omitted = every recording whose copies verify.
  ipcMain.handle('local-audio-free', async (_, opts?: { paths?: unknown }) => {
    const snapshot = sessions().snapshot();
    if (!snapshot) {
      return { success: false as const, error: 'Sign in to Google Drive first.' };
    }
    const dataPath = app.getPath('userData');
    const recordingsDir = recordingsDirFor(dataPath);
    const paths = Array.isArray(opts?.paths)
      ? opts.paths.filter(
          (p): p is string =>
            typeof p === 'string' && path.dirname(path.resolve(p)) === path.resolve(recordingsDir),
        )
      : undefined;
    if (Array.isArray(opts?.paths) && paths && paths.length === 0) {
      return { success: false as const, error: 'Only app recordings can be removed.' };
    }
    const { session } = snapshot;
    // The same request (all, or the same set of recordings) while one runs
    // joins it, so a repeated click or a click after a reload does not queue
    // a second pass of Drive checks. The session is part of the identity: a
    // request after a sign-in change never receives the old account's result.
    const target = paths ? [...new Set(paths.map(operationTarget))].sort().join('\n') : 'all';
    return backgroundOperations.run(
      'local-audio-free',
      target,
      async () => {
        try {
          const result: ReclaimResult = await serializeStorage(() =>
            reclaimLocalAudio({
              dataPath,
              driveClient: buildDriveClient(snapshot),
              ...(paths ? { paths } : {}),
              isInUse: isAudioInUse,
              shouldContinue: () => sessions().isCurrent(session),
              logger: (msg) => console.log(`[local-audio] ${msg}`),
            }),
          );
          if (result.removed.length > 0) notifyLocalStorageChanged();
          return { success: true as const, result };
        } catch (error) {
          if (!isTransientDriveError(error)) {
            reportError(error, { operation: 'storage.free', severity: 'warning' });
          }
          return {
            success: false as const,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
      undefined,
      sessionJoinKey(session, target),
    );
  });

  ipcMain.handle(
    'local-audio-restore',
    async (_, opts?: { folderPath?: unknown; audioPath?: unknown }) =>
      restoreTracked({
        folderPath: typeof opts?.folderPath === 'string' ? opts.folderPath : undefined,
        audioPath: typeof opts?.audioPath === 'string' ? opts.audioPath : undefined,
      }),
  );

  ipcMain.handle('google-oauth-login', async () => {
    while (pendingGoogleLogin) {
      const prior = pendingGoogleLogin;
      prior.controller.abort();
      await prior.done;
    }

    const controller = new AbortController();
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    pendingGoogleLogin = { controller, done };

    const sendProgress = (phase: 'browser-opened' | 'progress', message?: string) => {
      const mainWindow = ctx.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('google-oauth-progress', { phase, message });
      }
    };

    try {
      const credentials = await loginGoogleOAuth({
        openUrl: async (url) => {
          await shell.openExternal(url);
          sendProgress('browser-opened');
        },
        onProgress: (message) => {
          console.log(`Google OAuth: ${message}`);
          sendProgress('progress', message);
        },
        signal: controller.signal,
      });
      await ctx.configService.signInGoogleOAuth(credentials);
      onGoogleSessionChanged();
      ctx.applyConfigSideEffects({ googleOAuth: credentials });
      ctx.broadcastConfigChanged();
      return { success: true as const, config: ctx.configService.getAllConfig() };
    } catch (error) {
      if (controller.signal.aborted) {
        return { success: false as const, error: 'Sign-in cancelled.', cancelled: true as const };
      }
      console.error('Google OAuth login failed:', error);
      reportError(error, { operation: 'oauth.google.login', severity: 'error' });
      return {
        success: false as const,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await new Promise((resolve) => setTimeout(resolve, PORT_RELEASE_CUSHION_MS));
      if (pendingGoogleLogin?.controller === controller) {
        pendingGoogleLogin = null;
      }
      resolveDone();
    }
  });

  ipcMain.handle('google-oauth-cancel', async () => {
    const prior = pendingGoogleLogin;
    if (prior) {
      prior.controller.abort();
      await prior.done;
    }
    return { success: true };
  });

  ipcMain.handle('google-oauth-clear', async () => {
    try {
      await ctx.configService.signOutGoogleOAuth();
      onGoogleSessionChanged();
      ctx.applyConfigSideEffects({ googleOAuth: undefined });
      ctx.broadcastConfigChanged();
      return { success: true, config: ctx.configService.getAllConfig() };
    } catch (error) {
      console.error('Google OAuth clear failed:', error);
      reportError(error, { operation: 'oauth.google.clear', severity: 'warning' });
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Joins a cycle already running (automatic or manual) and reports its
  // outcome, so a click during a periodic sync waits for that sync instead of
  // failing.
  ipcMain.handle('google-drive-sync-now', async () => {
    // The persisted sign-in, so a CLI sign-in or sign-out is honored.
    const session = sessions().capture();
    if (!session) {
      return { success: false as const, error: NOT_SIGNED_IN_MESSAGE };
    }
    const result = await runGoogleSync();
    if (!sessions().isCurrent(session)) {
      return {
        success: false as const,
        error: 'The Google sign-in changed during the sync. Sync again for the current account.',
      };
    }
    if (!result) {
      return {
        success: false as const,
        error: currentLastError() ?? 'Sync failed; see main process logs.',
      };
    }
    return { success: true as const, result, lastSyncedAt: lastSyncedAt() };
  });

  ipcMain.handle('google-drive-sync-status', async () => {
    return {
      inFlight: googleSyncRun !== null,
      lastSyncedAt: lastSyncedAt(),
      lastResult: googleLastSyncResult,
      lastError: currentLastError(),
      progress: googleSyncProgress,
      enabled: driveEnabled(),
      authenticated: sessions().capture() !== null,
    };
  });
}
