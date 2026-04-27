import { type BrowserWindow, Menu, Tray, app, nativeImage } from 'electron';
import type { SimpleAudioRecorder } from './simpleAudioRecorder';

export class MenuBarManager {
  private tray: Tray | null = null;
  private isRecording = false;
  private mainWindow: BrowserWindow | null = null;
  private audioRecorder: SimpleAudioRecorder | null = null;
  private currentRecordingTitle = 'Quick Recording';

  init(mainWindow: BrowserWindow, audioRecorder: SimpleAudioRecorder) {
    this.mainWindow = mainWindow;
    this.audioRecorder = audioRecorder;

    try {
      this.createTray();
      this.setupWindowListeners();
    } catch (error) {
      console.error('Failed to initialize MenuBarManager:', error);
    }
  }

  private createTray() {
    const trayIcon = this.createTrayIcon('normal');

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

  private createTrayIcon(state: 'normal' | 'recording'): Electron.NativeImage {
    const size = process.platform === 'darwin' ? 44 : 32;
    const scale = process.platform === 'darwin' ? 2 : 1;
    const buf = Buffer.alloc(size * size * 4, 0); // RGBA, all transparent

    const setPixel = (x: number, y: number) => {
      if (x < 0 || x >= size || y < 0 || y >= size) return;
      const i = (y * size + x) * 4;
      buf[i] = 0; // R
      buf[i + 1] = 0; // G
      buf[i + 2] = 0; // B
      buf[i + 3] = 255; // A
    };

    const fillRect = (x: number, y: number, w: number, h: number) => {
      for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) setPixel(x + dx, y + dy);
    };

    const fillCircle = (cx: number, cy: number, r: number) => {
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) setPixel(cx + dx, cy + dy);
    };

    // "L" letterform
    const thick = Math.round(size * 0.23);
    const margin = Math.round(size * 0.18);
    const bottom = Math.round(size * 0.86);
    const right = Math.round(size * 0.77);

    fillRect(margin, margin, thick, bottom - margin); // vertical bar
    fillRect(margin, bottom - thick, right - margin, thick); // horizontal bar

    if (state === 'recording') {
      const dotR = Math.round(size * 0.09);
      fillCircle(right + dotR, bottom - dotR, dotR);
    }

    const image = nativeImage.createFromBuffer(buf, {
      width: size,
      height: size,
      scaleFactor: scale,
    });
    if (process.platform === 'darwin') {
      image.setTemplateImage(true);
    }
    return image;
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
      // Start recording in the background -- no show/focus so the window stays hidden
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
    this.tray.setImage(this.createTrayIcon(state));
  }

  private showContextMenu() {
    const menuItems: Electron.MenuItemConstructorOptions[] = [];

    if (this.isRecording) {
      menuItems.push({
        label: 'Stop Recording',
        click: () => this.stopRecording(),
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
      },
    });

    menuItems.push({ type: 'separator' });

    menuItems.push({
      label: 'Preferences...',
      click: () => {
        if (this.mainWindow) {
          this.mainWindow.show();
          this.mainWindow.webContents.send('open-config');
        }
      },
    });

    menuItems.push({ type: 'separator' });

    menuItems.push({
      label: 'Quit Listener.AI',
      click: () => {
        global.isQuitting = true;
        app.quit();
      },
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
