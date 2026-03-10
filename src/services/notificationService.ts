import { Notification, BrowserWindow, app } from 'electron';

export class NotificationService {
  private mainWindow: BrowserWindow | null = null;

  setMainWindow(window: BrowserWindow) {
    this.mainWindow = window;
  }

  private shouldNotify(): boolean {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return true;
    if (!this.mainWindow.isVisible()) return true;
    if (!this.mainWindow.isFocused()) return true;
    return false;
  }

  private notify(title: string, body: string): void {
    if (!this.shouldNotify()) return;
    if (!Notification.isSupported()) return;

    const notification = new Notification({ title, body });
    notification.on('click', () => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.show();
        this.mainWindow.focus();
      } else {
        app.emit('activate');
      }
    });
    notification.show();
  }

  notifyRecordingStarted(title: string) {
    this.notify('Recording Started', title);
  }

  notifyRecordingStopped() {
    this.notify('Recording Stopped', 'Your recording has been saved.');
  }

  notifyTranscriptionComplete(title: string) {
    this.notify('Transcription Complete', title);
  }

  notifyTranscriptionFailed(error: string) {
    this.notify('Transcription Failed', error);
  }

  notifyUploadComplete(title: string) {
    this.notify('Uploaded to Notion', title);
  }

  notifyUploadFailed(error: string) {
    this.notify('Notion Upload Failed', error);
  }

  notifyMeetingDetected(appName: string) {
    this.notify('Meeting Detected', appName);
  }

  notifyMeetingEnded(appName: string) {
    this.notify('Meeting Ended', appName);
  }
}

export const notificationService = new NotificationService();
