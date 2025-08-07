import { autoUpdater } from 'electron-updater';
import { BrowserWindow, dialog, app } from 'electron';

export class AutoUpdaterService {
  private mainWindow: BrowserWindow | null = null;
  private updateAvailable = false;
  private updateDownloaded = false;

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
      this.updateAvailable = true;
      this.sendStatusToWindow('update-available', info);
      
      dialog.showMessageBox(this.mainWindow || new BrowserWindow({ show: false }), {
        type: 'info',
        title: 'Update Available',
        message: `A new version (${info.version}) is available. Would you like to download it now?`,
        detail: `Current version: ${app.getVersion()}\nNew version: ${info.version}`,
        buttons: ['Download', 'Later'],
        defaultId: 0,
        cancelId: 1
      }).then((result) => {
        if (result.response === 0) {
          autoUpdater.downloadUpdate();
        }
      });
    });

    autoUpdater.on('update-not-available', () => {
      console.log('Update not available');
      this.sendStatusToWindow('update-not-available');
    });

    autoUpdater.on('error', (err) => {
      console.error('Update error:', err);
      this.sendStatusToWindow('update-error', err.message);
    });

    autoUpdater.on('download-progress', (progressObj) => {
      console.log(`Download progress: ${progressObj.percent.toFixed(2)}%`);
      this.sendStatusToWindow('download-progress', progressObj);
    });

    autoUpdater.on('update-downloaded', (info) => {
      console.log('Update downloaded:', info);
      this.updateDownloaded = true;
      this.sendStatusToWindow('update-downloaded', info);
      
      dialog.showMessageBox(this.mainWindow || new BrowserWindow({ show: false }), {
        type: 'info',
        title: 'Update Ready',
        message: 'Update downloaded. The application will restart to apply the update.',
        detail: `Version ${info.version} has been downloaded and will be installed after restart.`,
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
        cancelId: 1
      }).then((result) => {
        if (result.response === 0) {
          autoUpdater.quitAndInstall();
        }
      });
    });
  }

  private sendStatusToWindow(event: string, data?: any) {
    if (this.mainWindow) {
      this.mainWindow.webContents.send('update-status', { event, data });
    }
  }

  public checkForUpdates() {
    if (this.isDevelopment()) return;
    
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.error('Failed to check for updates:', err);
    });
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
        buttons: ['OK']
      });
      return;
    }

    autoUpdater.checkForUpdates().then(() => {
      if (!this.updateAvailable) {
        dialog.showMessageBox(this.mainWindow || new BrowserWindow({ show: false }), {
          type: 'info',
          title: 'No Updates',
          message: 'You are running the latest version.',
          detail: `Current version: ${app.getVersion()}`,
          buttons: ['OK']
        });
      }
    }).catch((err) => {
      dialog.showErrorBox('Update Check Failed', `Failed to check for updates: ${err.message}`);
    });
  }

}

export const autoUpdaterService = new AutoUpdaterService();