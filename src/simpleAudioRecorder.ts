import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';

// Audio capture runs in the renderer via `navigator.mediaDevices.getUserMedia()`
// and `MediaRecorder` (Chromium's audio path, which sits on Core Audio HAL directly
// and bypasses ffmpeg's `AVCaptureAudioDataOutput` that produced periodic ticks).
// This class only tracks per-session state and writes the final encoded blob to disk.
export class SimpleAudioRecorder {
  private outputPath: string | null = null;
  private startTime: number | null = null;
  private recordingActive = false;
  private meetingTitle: string | null = null;

  constructor() {
    const recordingsDir = path.join(app.getPath('userData'), 'recordings');
    if (!fs.existsSync(recordingsDir)) {
      fs.mkdirSync(recordingsDir, { recursive: true });
    }
  }

  private buildFilePath(meetingTitle: string, extension: string): string {
    const base = this.startTime ? new Date(this.startTime) : new Date();
    const timestamp = base.toISOString().replace(/[:.]/g, '-');
    const sanitizedTitle = meetingTitle
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/\s+/g, '_')
      .trim();
    const ext = extension.startsWith('.') ? extension : `.${extension}`;
    const fileName = `${sanitizedTitle}_${timestamp}${ext}`;
    return path.join(app.getPath('userData'), 'recordings', fileName);
  }

  // Called by the main process when the renderer signals recording has begun.
  // The renderer owns the actual capture; we only reserve state and the clock.
  startRecording(meetingTitle: string): { success: boolean; error?: string } {
    if (this.recordingActive) {
      return { success: false, error: 'Recording already in progress' };
    }
    this.meetingTitle = meetingTitle;
    this.startTime = Date.now();
    this.recordingActive = true;
    this.outputPath = null;
    return { success: true };
  }

  isRecording(): boolean {
    return this.recordingActive;
  }

  // Mark the session as stopped. File write happens separately via saveRecording().
  // Returns a result compatible with the previous API so tray/auto-stop flows keep working.
  stopRecording(): { success: boolean; durationMs?: number; filePath?: string } {
    if (!this.recordingActive) {
      return { success: false };
    }
    const durationMs = this.startTime !== null ? Date.now() - this.startTime : undefined;
    this.recordingActive = false;
    return { success: true, durationMs, filePath: this.outputPath ?? undefined };
  }

  // Persist encoded audio bytes from the renderer to disk. `extension` should match
  // the container the renderer chose (e.g. 'webm', 'm4a', 'ogg'). Async to avoid
  // blocking the main thread on multi-MB writes.
  async saveRecording(
    meetingTitle: string,
    data: Buffer,
    extension: string,
    durationMs: number
  ): Promise<{ success: boolean; filePath?: string; durationMs?: number; error?: string }> {
    try {
      const outputPath = this.buildFilePath(meetingTitle || this.meetingTitle || 'Untitled_Meeting', extension);
      await fs.promises.writeFile(outputPath, data);
      const stats = await fs.promises.stat(outputPath);
      console.log(`Recording saved: ${outputPath} (${stats.size} bytes, ${durationMs}ms)`);
      this.outputPath = outputPath;
      return { success: true, filePath: outputPath, durationMs };
    } catch (error) {
      console.error('Failed to save recording:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
