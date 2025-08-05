import { Tray, Menu, nativeImage, app, BrowserWindow, Notification } from 'electron';
import path from 'path';
import { SimpleAudioRecorder } from './simpleAudioRecorder';
import { UpdateService } from './services/updateService';


export class MenuBarManager {
  private tray: Tray | null = null;
  private isRecording = false;
  private mainWindow: BrowserWindow | null = null;
  private audioRecorder: SimpleAudioRecorder | null = null;
  private updateService: UpdateService | null = null;
  private currentRecordingTitle = 'Quick Recording';

  constructor() { }

  init(mainWindow: BrowserWindow, audioRecorder: SimpleAudioRecorder, updateService?: UpdateService) {
    this.mainWindow = mainWindow;
    this.audioRecorder = audioRecorder;
    this.updateService = updateService || null;

    try {
      this.createTray();
      this.setupWindowListeners();
    } catch (error) {
      console.error('Failed to initialize MenuBarManager:', error);
    }
  }

  private createTray() {
    const iconPath = this.getIconPath('normal');

    // Check if icon file exists
    const fs = require('fs');
    if (!fs.existsSync(iconPath)) {
      console.error('Tray icon file not found:', iconPath);
      return;
    }

    const icon = nativeImage.createFromPath(iconPath);

    // Verify icon loaded successfully
    if (icon.isEmpty()) {
      console.error('ERROR: Icon is empty after loading from:', iconPath);
      return;
    }

    // Resize the icon to appropriate tray size
    const trayIcon = icon.resize({
      width: process.platform === 'darwin' ? 22 : 16,
      height: process.platform === 'darwin' ? 22 : 16
    });

    // On macOS, we need to set the icon as template for proper dark mode support
    if (process.platform === 'darwin') {
      trayIcon.setTemplateImage(true);
    }

    try {
      this.tray = new Tray(trayIcon);
      this.updateTooltip();
      console.log('Tray created successfully');
    } catch (err) {
      console.error('Failed to create tray:', err);
      return;
    }

    // Single click behavior
    this.tray.on('click', () => {
      if (process.platform === 'win32') {
        // On Windows, single click shows menu
        this.showContextMenu();
      } else {
        // On macOS, single click toggles recording
        this.handleTrayClick();
      }
    });

    // Right click behavior
    this.tray.on('right-click', () => {
      this.showContextMenu();
    });

    // Double click on Windows
    if (process.platform === 'win32') {
      this.tray.on('double-click', () => {
        this.handleTrayClick();
      });
    }
  }

  private setupWindowListeners() {
    if (!this.mainWindow) return;

    // Show window when activated (macOS dock click)
    app.on('activate', () => {
      if (this.mainWindow && !this.mainWindow.isVisible()) {
        this.mainWindow.show();
      }
    });
  }

  private getIconPath(state: 'normal' | 'recording'): string {
    // Get the app root directory
    const { app } = require('electron');
    const appPath = app.getAppPath();
    const assetsPath = path.join(appPath, 'assets');

    // Use the main icon - we'll resize it for the tray
    return path.join(assetsPath, 'icon.png');
  }

  private updateTooltip() {
    if (!this.tray) return;
    const tooltip = this.isRecording
      ? `Listener.AI - Recording "${this.currentRecordingTitle}"`
      : 'Listener.AI - Click to start recording';
    this.tray.setToolTip(tooltip);
  }

  private async handleTrayClick() {
    if (this.isRecording) {
      // If recording, stop it
      await this.stopRecording();
    } else {
      // If not recording, start quick recording
      await this.startQuickRecording();
    }
  }

  async startQuickRecording() {
    // Instead of starting recording directly, send a message to the renderer
    // to click the start button, which will handle all the logic
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      // Show the window if it's hidden
      if (!this.mainWindow.isVisible()) {
        this.mainWindow.show();
      }

      // Tell the renderer to start recording
      this.mainWindow.webContents.send('tray-start-recording');
    }
  }

  async stopRecording() {
    // Instead of stopping recording directly, send a message to the renderer
    // to click the stop button, which will handle all the logic
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      // Tell the renderer to stop recording
      this.mainWindow.webContents.send('tray-stop-recording');
    }
  }

  private updateTrayIcon(state: 'normal' | 'recording') {
    if (!this.tray) return;

    const iconPath = this.getIconPath(state);
    const icon = nativeImage.createFromPath(iconPath);

    if (icon.isEmpty()) return;

    // Resize the icon
    const trayIcon = icon.resize({
      width: process.platform === 'darwin' ? 22 : 16,
      height: process.platform === 'darwin' ? 22 : 16
    });

    if (process.platform === 'darwin') {
      trayIcon.setTemplateImage(true);
    }

    this.tray.setImage(trayIcon);
  }

  private showContextMenu() {
    const menuItems: Electron.MenuItemConstructorOptions[] = [];

    if (this.isRecording) {
      menuItems.push({
        label: 'Stop Recording',
        click: () => this.stopRecording()
      });
      menuItems.push({ type: 'separator' });
    }

    menuItems.push({
      label: 'Open Listener.AI',
      click: () => {
        if (this.mainWindow) {
          this.mainWindow.show();
          this.mainWindow.focus();
        }
      }
    });

    menuItems.push({ type: 'separator' });

    menuItems.push({
      label: 'Preferences...',
      click: () => {
        if (this.mainWindow) {
          this.mainWindow.show();
          this.mainWindow.webContents.send('open-config');
        }
      }
    });

    menuItems.push({ type: 'separator' });

    // Only show Check for Updates if updateService is available
    if (this.updateService) {
      menuItems.push({
        label: 'Check for Updates...',
        click: async () => {
          try {
            const result = await this.updateService!.checkForUpdate(true); // Bypass stability for manual checks
            console.log('[MenuBar] Manual update check result:', result);

            if (!result.hasUpdate) {
              // Show notification that app is up to date
              new Notification({
                title: 'Listener.AI',
                body: `You're running the latest version (${result.currentVersion})`
              }).show();
            }
            // If there's an update, the notification will be shown automatically
          } catch (error) {
            console.error('[MenuBar] Error checking for updates:', error);
            new Notification({
              title: 'Update Check Failed',
              body: 'Unable to check for updates. Please try again later.'
            }).show();
          }
        }
      });

      menuItems.push({ type: 'separator' });
    }

    menuItems.push({
      label: 'Quit Listener.AI',
      click: () => {
        global.isQuitting = true;
        app.quit();
      }
    });

    const contextMenu = Menu.buildFromTemplate(menuItems);
    this.tray?.popUpContextMenu(contextMenu);
  }

  public updateRecordingState(isRecording: boolean, title?: string) {
    this.isRecording = isRecording;
    if (title) {
      this.currentRecordingTitle = title;
    }
    this.updateTrayIcon(isRecording ? 'recording' : 'normal');
    this.updateTooltip();
  }

  public destroy() {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}
