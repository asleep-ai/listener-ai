import * as path from 'path';
import { app, ipcMain, shell } from 'electron';
import {
  type GoogleOAuthCredentials,
  loginGoogleOAuth,
  resolveGoogleAccessToken,
} from '../googleOAuth';
import { getTranscriptionsDir } from '../outputService';
import { GoogleDriveClient } from '../services/googleDriveService';
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

function buildDriveClient(credentials: GoogleOAuthCredentials): GoogleDriveClient {
  const { configService } = requireCtx();
  return new GoogleDriveClient({
    getAccessToken: async () => {
      const token = await resolveGoogleAccessToken({
        credentials,
        onCredentialsChanged: (next) => {
          // Same gate as the Codex side: never silently persist refreshed
          // tokens that originated from env vars.
          if (configService.hasStoredGoogleOAuth()) {
            configService.setGoogleOAuth(next);
          }
        },
      });
      if (!token) throw new Error('Failed to resolve Google access token.');
      return token;
    },
  });
}

async function runGoogleSync(): Promise<SyncResult | undefined> {
  if (googleSyncInFlight) return undefined;
  const { configService } = requireCtx();
  const credentials = configService.getGoogleOAuth();
  if (!credentials) return undefined;

  googleSyncInFlight = true;
  broadcastGoogleSyncStatus('syncing');
  try {
    const dataPath = app.getPath('userData');
    const engine = new SyncEngine({
      driveClient: buildDriveClient(credentials),
      transcriptionsDir: getTranscriptionsDir(dataPath),
      syncStatePath: path.join(dataPath, 'sync-state.json'),
      logger: (msg) => console.log(`[google-sync] ${msg}`),
      onProgress: broadcastGoogleSyncProgress,
      configSync: configService,
    });
    const result = await engine.syncOnce();
    googleLastSyncedAt = new Date().toISOString();
    googleLastSyncResult = result;
    broadcastGoogleSyncStatus(result.errors.length > 0 ? 'error' : 'success', { result });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Google Drive sync failed:', error);
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

export function register(ctx: IpcContext): void {
  ctxRef = ctx;

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
      ctx.configService.setGoogleOAuth(credentials);
      ctx.applyConfigSideEffects({ googleOAuth: credentials });
      ctx.broadcastConfigChanged();
      return { success: true as const, config: ctx.configService.getAllConfig() };
    } catch (error) {
      if (controller.signal.aborted) {
        return { success: false as const, error: 'Sign-in cancelled.', cancelled: true as const };
      }
      console.error('Google OAuth login failed:', error);
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
      ctx.configService.clearGoogleOAuth();
      ctx.applyConfigSideEffects({ googleOAuth: undefined });
      ctx.broadcastConfigChanged();
      return { success: true, config: ctx.configService.getAllConfig() };
    } catch (error) {
      console.error('Google OAuth clear failed:', error);
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
