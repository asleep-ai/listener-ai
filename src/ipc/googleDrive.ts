import * as path from 'path';
import { app, ipcMain, shell } from 'electron';
import {
  type GoogleOAuthCredentials,
  loginGoogleOAuth,
  resolveGoogleAccessToken,
} from '../googleOAuth';
import { syncChangedLocalNotes } from '../meetingList';
import { getTranscriptionsDir } from '../outputService';
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
let googleSyncInFlight = false;
let googleLastSyncedAt: string | null = null;
let googleLastSyncResult: SyncResult | null = null;
// Most recent progress event from the currently-running sync. Cleared when
// the cycle finishes so getGoogleSyncStatus doesn't surface a stale "Syncing
// 7/12" pill after a sync error and the next modal open.
let googleSyncProgress: SyncProgressEvent | null = null;
const GOOGLE_SYNC_INTERVAL_MS = 60_000;
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
      lastSyncedAt: googleLastSyncedAt,
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
  const { configService } = requireCtx();
  const days = configService.getAudioOffloadAfterDays();
  if (days <= 0 || !configService.getGoogleDriveEnabled()) return;
  // The client verifies against the account the sync started under; stop if
  // that is no longer the signed-in session.
  if (!sessions().isCurrent(session)) return;
  const result = await reclaimLocalAudio({
    dataPath,
    driveClient,
    olderThanDays: days,
    isInUse: isAudioInUse,
    shouldContinue: () =>
      configService.getAudioOffloadAfterDays() === days &&
      configService.getGoogleDriveEnabled() &&
      sessions().isCurrent(session),
    logger: (msg) => console.log(`[local-audio] ${msg}`),
  });
  if (result.removed.length > 0) {
    console.log(
      `[local-audio] Automatic cleanup removed ${result.removed.length} local recording(s), ${result.freedBytes} bytes.`,
    );
    notifyLocalStorageChanged();
  }
}

async function runGoogleSync(): Promise<SyncResult | undefined> {
  if (googleSyncInFlight) return undefined;
  const { configService } = requireCtx();
  // Credentials and session come from the same persisted read, so a CLI
  // sign-out or switch since this process loaded config.json is honored.
  const snapshot = sessions().snapshot();
  if (!snapshot) return undefined;
  const { session } = snapshot;

  googleSyncInFlight = true;
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
      onProgress: broadcastGoogleSyncProgress,
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
    googleLastSyncedAt = new Date().toISOString();
    googleLastSyncResult = result;
    broadcastGoogleSyncStatus(result.errors.length > 0 ? 'error' : 'success', { result });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Google Drive sync failed:', error);
    // Transient Google 5xx/429 and offline drops are noise, not actionable --
    // still surfaced to the user via the error status broadcast below.
    if (!isTransientDriveError(error)) {
      reportError(error, { operation: 'drive.sync', severity: 'error' });
    }
    broadcastGoogleSyncStatus('error', { error: message });
    return undefined;
  } finally {
    googleSyncInFlight = false;
    googleSyncProgress = null;
  }
}

export function refreshGoogleSyncTimer(): void {
  const { configService } = requireCtx();
  const shouldRun = configService.getGoogleDriveEnabled() && configService.hasGoogleOAuth();

  // Cancel any pending initial kick unconditionally. If shouldRun is still
  // true we'll re-arm it below; if not, this prevents a stray timeout from
  // executing a sync the user thinks they disabled.
  if (googleSyncInitialKick) {
    clearTimeout(googleSyncInitialKick);
    googleSyncInitialKick = null;
  }

  if (shouldRun && !googleSyncTimer) {
    // Run one cycle shortly after toggle so the user sees activity quickly,
    // then continue on the regular interval. Both callbacks route through
    // maybeAutoSync, which re-checks the enabled flag at fire time as a
    // defense in depth against config changes between schedule and execution.
    googleSyncInitialKick = setTimeout(() => {
      googleSyncInitialKick = null;
      maybeAutoSync();
    }, GOOGLE_SYNC_INITIAL_DELAY_MS);
    googleSyncTimer = setInterval(() => {
      maybeAutoSync();
    }, GOOGLE_SYNC_INTERVAL_MS);
    console.log('Google Drive sync timer started.');
  } else if (!shouldRun && googleSyncTimer) {
    clearInterval(googleSyncTimer);
    googleSyncTimer = null;
    console.log('Google Drive sync timer stopped.');
  }
}

// Fire-and-forget sync trigger. Skips silently when sync is disabled or
// unauthenticated so the caller is never blocked on Drive availability.
// Used by the post-transcription save path AND the meeting-delete path so
// tombstone propagation kicks in promptly.
export function maybeAutoSync(): void {
  const { configService } = requireCtx();
  if (!configService.getGoogleDriveEnabled()) return;
  if (!configService.hasGoogleOAuth()) return;
  void runGoogleSync();
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
        signedIn: ctx.configService.hasGoogleOAuth(),
        syncEnabled: ctx.configService.getGoogleDriveEnabled(),
        offloadAfterDays: ctx.configService.getAudioOffloadAfterDays(),
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
  });

  ipcMain.handle(
    'local-audio-restore',
    async (_, opts?: { folderPath?: unknown; audioPath?: unknown }) =>
      restoreAudio({
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

  ipcMain.handle('google-drive-sync-now', async () => {
    if (!ctx.configService.hasGoogleOAuth()) {
      return { success: false as const, error: 'Not signed in to Google Drive.' };
    }
    const result = await runGoogleSync();
    if (!result) {
      return {
        success: false as const,
        error: googleSyncInFlight
          ? 'A sync is already in progress.'
          : 'Sync failed; see main process logs.',
      };
    }
    return { success: true as const, result, lastSyncedAt: googleLastSyncedAt };
  });

  ipcMain.handle('google-drive-sync-status', async () => {
    return {
      inFlight: googleSyncInFlight,
      lastSyncedAt: googleLastSyncedAt,
      lastResult: googleLastSyncResult,
      progress: googleSyncProgress,
      enabled: ctx.configService.getGoogleDriveEnabled(),
      authenticated: ctx.configService.hasGoogleOAuth(),
    };
  });
}
