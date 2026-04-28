import { BrowserWindow, app, dialog, shell } from 'electron';
import { autoUpdater } from 'electron-updater';

const RELEASES_URL = 'https://github.com/asleep-ai/listener-ai/releases/latest';
const PERIODIC_CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000;

export type UpdateState =
  | { type: 'idle' }
  | { type: 'available'; version: string }
  | { type: 'downloading'; version?: string; percent: number }
  | { type: 'downloaded'; version: string };

export class AutoUpdaterService {
  private mainWindow: BrowserWindow | null = null;
  private updateState: UpdateState = { type: 'idle' };
  private periodicTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.setupAutoUpdater();
  }

  setMainWindow(window: BrowserWindow) {
    this.mainWindow = window;
  }

  private setupAutoUpdater() {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    if (this.isDevelopment()) {
      console.log('Auto-updater disabled in development mode');
      return;
    }

    autoUpdater.on('checking-for-update', () => {
      console.log('Checking for updates...');
      this.sendStatusToWindow('checking-for-update');
    });

    autoUpdater.on('update-available', (info) => {
      console.log('Update available:', info);
      this.updateState = { type: 'available', version: info.version };
      this.sendStatusToWindow('update-available', info);
    });

    autoUpdater.on('update-not-available', () => {
      console.log('Update not available');
      // Only emit on transition — a previously-advertised update was rolled back.
      // Idle→idle ticks from the periodic check don't need to wake the renderer.
      if (this.updateState.type === 'available') {
        this.updateState = { type: 'idle' };
        this.sendStatusToWindow('update-not-available');
      }
    });

    autoUpdater.on('error', (err) => {
      console.error('Update error:', err);
      const wasDownloading = this.updateState.type === 'downloading';
      this.updateState = { type: 'idle' };
      this.sendStatusToWindow('update-error', err.message);
      if (wasDownloading) {
        this.showUpdateFailedDialog(err.message);
      }
    });

    autoUpdater.on('download-progress', (progressObj) => {
      console.log(`Download progress: ${progressObj.percent.toFixed(2)}%`);
      const version = this.currentVersion();
      this.updateState = { type: 'downloading', version, percent: progressObj.percent };
      this.sendStatusToWindow('download-progress', { ...progressObj, version });
    });

    autoUpdater.on('update-downloaded', (info) => {
      console.log('Update downloaded:', info);
      this.updateState = { type: 'downloaded', version: info.version };
      this.sendStatusToWindow('update-downloaded', info);
      this.showRestartPrompt(info.version);
    });
  }

  private showRestartPrompt(version: string) {
    dialog
      .showMessageBox(this.mainWindow || new BrowserWindow({ show: false }), {
        type: 'info',
        title: 'Update Ready',
        message: 'Update downloaded. The application will restart to apply the update.',
        detail: `Version ${version} has been downloaded and will be installed after restart.`,
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
        cancelId: 1,
      })
      .then((result) => {
        if (result.response === 0) {
          this.quitAndInstall();
        }
      });
  }

  private sendStatusToWindow(event: string, data?: any) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('update-status', { event, data });
    }
  }

  private currentVersion(): string | undefined {
    const state = this.updateState;
    if (state.type === 'idle') return undefined;
    return state.version;
  }

  public checkForUpdates() {
    if (this.isDevelopment()) return;

    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.error('Failed to check for updates:', err);
    });
  }

  public startPeriodicCheck(intervalMs: number = PERIODIC_CHECK_INTERVAL_MS) {
    if (this.isDevelopment()) return;
    if (this.periodicTimer) return;

    this.periodicTimer = setInterval(() => {
      if (this.updateState.type === 'downloading' || this.updateState.type === 'downloaded') {
        return;
      }
      this.checkForUpdates();
    }, intervalMs);
  }

  public stopPeriodicCheck() {
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
  }

  public getUpdateState(): UpdateState {
    return this.updateState;
  }

  public downloadUpdate() {
    if (this.updateState.type !== 'available') return;

    const version = this.updateState.version;
    const isDev = this.isDevelopment();

    dialog
      .showMessageBox(this.mainWindow || new BrowserWindow({ show: false }), {
        type: 'info',
        title: 'Update Available',
        message: `A new version (${version}) is available. Would you like to download it now?`,
        detail: `Current version: ${app.getVersion()}\nNew version: ${version}`,
        buttons: ['Download', 'Later'],
        defaultId: 0,
        cancelId: 1,
      })
      .then((result) => {
        if (result.response !== 0) return;
        if (this.updateState.type !== 'available') return;

        this.updateState = { type: 'downloading', version, percent: 0 };
        this.sendStatusToWindow('download-progress', { percent: 0, version });

        if (isDev) {
          this.simulateFakeDownload();
          return;
        }

        autoUpdater.downloadUpdate().catch((err) => {
          console.error('Failed to download update:', err);
        });
      });
  }

  private simulateFakeDownload() {
    const steps = [25, 60, 90, 100];
    steps.forEach((percent, idx) => {
      setTimeout(
        () => {
          if (this.updateState.type !== 'downloading') return;
          if (percent < 100) {
            this.simulateUpdateEvent('download-progress', { percent });
          } else {
            const version =
              this.updateState.type === 'downloading' ? this.updateState.version : '9.9.9';
            this.simulateUpdateEvent('update-downloaded', { version });
          }
        },
        (idx + 1) * 500,
      );
    });
  }

  public quitAndInstall() {
    if (this.isDevelopment()) return;
    if (this.updateState.type !== 'downloaded') return;

    // Prevent the macOS close handler's hide-instead-of-quit fallback from
    // intercepting the window close that quitAndInstall triggers.
    global.isQuitting = true;
    autoUpdater.quitAndInstall();
  }

  public simulateUpdateEvent(event: string, data?: any) {
    if (!this.isDevelopment()) {
      console.warn('[autoUpdater] simulateUpdateEvent ignored outside development mode');
      return;
    }

    switch (event) {
      case 'update-available': {
        const version = data?.version ?? '9.9.9';
        this.updateState = { type: 'available', version };
        this.sendStatusToWindow('update-available', { version });
        break;
      }
      case 'download-progress': {
        const version = this.currentVersion();
        const percent = data?.percent ?? 0;
        this.updateState = { type: 'downloading', version, percent };
        this.sendStatusToWindow('download-progress', { percent, version });
        break;
      }
      case 'update-downloaded': {
        const version =
          data?.version ??
          (this.updateState.type === 'downloading' ? this.updateState.version : undefined) ??
          '9.9.9';
        this.updateState = { type: 'downloaded', version };
        this.sendStatusToWindow('update-downloaded', { version });
        this.showRestartPrompt(version);
        break;
      }
      case 'update-error': {
        this.updateState = { type: 'idle' };
        this.sendStatusToWindow('update-error', String(data ?? 'Simulated error'));
        break;
      }
      case 'reset': {
        this.updateState = { type: 'idle' };
        this.sendStatusToWindow('update-not-available');
        break;
      }
      default:
        console.warn(`[autoUpdater] simulateUpdateEvent: unknown event "${event}"`);
    }
  }

  private isDevelopment(): boolean {
    return process.env.NODE_ENV === 'development' || app.isPackaged === false;
  }

  public checkForUpdatesManually() {
    if (this.isDevelopment()) {
      dialog.showMessageBox(this.mainWindow || new BrowserWindow({ show: false }), {
        type: 'info',
        title: 'Development Mode',
        message: 'Auto-update is disabled in development mode.',
        buttons: ['OK'],
      });
      return;
    }

    autoUpdater
      .checkForUpdates()
      .then(() => {
        if (this.updateState.type === 'idle') {
          dialog.showMessageBox(this.mainWindow || new BrowserWindow({ show: false }), {
            type: 'info',
            title: 'No Updates',
            message: 'You are running the latest version.',
            detail: `Current version: ${app.getVersion()}`,
            buttons: ['OK'],
          });
        }
      })
      .catch((err) => {
        this.showUpdateFailedDialog(err.message);
      });
  }

  private showUpdateFailedDialog(errorMessage: string) {
    dialog
      .showMessageBox(this.mainWindow || new BrowserWindow({ show: false }), {
        type: 'error',
        title: 'Update Failed',
        message: 'Failed to update automatically.',
        detail: `${errorMessage}\n\nYou can download the latest version manually from GitHub.`,
        buttons: ['Open GitHub Releases', 'Later'],
        defaultId: 0,
        cancelId: 1,
      })
      .then((result) => {
        if (result.response === 0) {
          shell.openExternal(RELEASES_URL);
        }
      });
  }
}

export const autoUpdaterService = new AutoUpdaterService();
