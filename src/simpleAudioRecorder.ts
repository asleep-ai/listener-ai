import * as path from 'path';
import * as fs from 'fs';
import { extensionForMimeType } from './audioFormats';

// Lazy-load electron so unit tests (which inject recordingsDir) don't trigger a
// module-load failure outside the Electron runtime.
function defaultRecordingsDir(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { app } = require('electron') as typeof import('electron');
  return path.join(app.getPath('userData'), 'recordings');
}

// Audio capture runs in the renderer via `navigator.mediaDevices.getUserMedia()` and
// `MediaRecorder` (Chromium's audio path sits on Core Audio HAL directly and bypasses
// ffmpeg's `AVCaptureAudioDataOutput` that produced periodic ticks). The renderer
// streams encoded chunks to main as they arrive, and main appends them to a file
// handle. If the renderer crashes mid-session we still have a valid (truncated)
// WebM/Opus file on disk — the container tolerates truncation and ffmpeg can recover.
export type StopReason = 'empty';

export interface StopResult {
  success: boolean;
  filePath?: string;
  durationMs?: number;
  bytesWritten?: number;
  error?: string;
  reason?: StopReason;
}

export class SimpleAudioRecorder {
  private recordingsDir: string;
  private outputPath: string | null = null;
  private fileHandle: fs.promises.FileHandle | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private bytesWritten = 0;
  private appendError: Error | null = null;
  private startTime: number | null = null;
  private recordingActive = false;
  // Finalized result from the most recent stop/abort. Returned to a late caller
  // (e.g. renderer's stop invoke that races the 10s grace-window force-stop) so
  // it doesn't see a spurious "No recording in progress" error.
  private lastResult: StopResult | null = null;

  constructor(recordingsDir?: string) {
    this.recordingsDir = recordingsDir ?? defaultRecordingsDir();
    if (!fs.existsSync(this.recordingsDir)) {
      fs.mkdirSync(this.recordingsDir, { recursive: true });
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
    return path.join(this.recordingsDir, fileName);
  }

  async startRecording(
    meetingTitle: string,
    mimeType: string
  ): Promise<{ success: boolean; filePath?: string; error?: string }> {
    if (this.recordingActive) {
      return { success: false, error: 'Recording already in progress' };
    }
    // Flip the active flag synchronously so concurrent starts can't both pass the
    // guard while we're awaiting fs.promises.open.
    this.recordingActive = true;
    this.startTime = Date.now();
    this.lastResult = null;
    this.appendError = null;
    try {
      const extension = extensionForMimeType(mimeType);
      const outputPath = this.buildFilePath(meetingTitle || 'Untitled_Meeting', extension);
      this.fileHandle = await fs.promises.open(outputPath, 'w');
      this.outputPath = outputPath;
      this.bytesWritten = 0;
      this.writeChain = Promise.resolve();
      return { success: true, filePath: outputPath };
    } catch (error) {
      this.recordingActive = false;
      this.startTime = null;
      this.outputPath = null;
      this.fileHandle = null;
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  isRecording(): boolean {
    return this.recordingActive;
  }

  // Writes are serialized through `writeChain` so chunks stay in arrival order
  // even if multiple appendChunk calls overlap. Errors are latched into
  // `appendError` so stopRecording surfaces disk-full/EIO instead of returning
  // success on a truncated file.
  appendChunk(data: Buffer): void {
    if (!this.recordingActive || !this.fileHandle) return;
    const handle = this.fileHandle;
    this.writeChain = this.writeChain.then(async () => {
      if (this.appendError) return;
      try {
        // Loop in case write() performs a short write (rare on local fs but
        // FileHandle.write makes no contiguous-write guarantee).
        let offset = 0;
        while (offset < data.length) {
          const { bytesWritten } = await handle.write(data, offset, data.length - offset);
          if (bytesWritten <= 0) throw new Error('Zero-byte write');
          offset += bytesWritten;
          this.bytesWritten += bytesWritten;
        }
      } catch (error) {
        this.appendError = error instanceof Error ? error : new Error(String(error));
        console.error('Failed to append recording chunk:', this.appendError);
      }
    });
  }

  // Flush pending writes, close the handle, return the finalized path. Must await
  // `writeChain` BEFORE snapshotting bytesWritten — chunks queued just before stop
  // only increment the counter when their write resolves inside the chain.
  async stopRecording(): Promise<StopResult> {
    if (!this.recordingActive) {
      // Grace-timer or crash-path may have finalized already — return that result
      // so the late caller sees the saved file instead of a spurious error.
      if (this.lastResult) return this.lastResult;
      return { success: false, error: 'No recording in progress' };
    }
    this.recordingActive = false;
    const durationMs = this.startTime !== null ? Date.now() - this.startTime : undefined;
    const outputPath = this.outputPath;
    const handle = this.fileHandle;
    this.fileHandle = null;
    try {
      await this.writeChain;
      if (handle) await handle.close();
    } catch (error) {
      console.error('Failed to close recording file:', error);
    }

    const bytes = this.bytesWritten;
    const writeError = this.appendError;

    if (!outputPath) {
      const result: StopResult = { success: false, error: 'No output path was set' };
      this.lastResult = result;
      return result;
    }

    if (writeError) {
      // Keep the partial file around for debugging / recovery.
      const result: StopResult = {
        success: false,
        error: writeError.message,
        filePath: outputPath,
        durationMs,
        bytesWritten: bytes,
      };
      this.lastResult = result;
      return result;
    }

    if (bytes === 0) {
      try {
        await fs.promises.unlink(outputPath);
      } catch (error) {
        console.warn('Failed to remove empty recording file:', error);
      }
      this.outputPath = null;
      const result: StopResult = { success: false, reason: 'empty', durationMs };
      this.lastResult = result;
      return result;
    }

    console.log(`Recording saved: ${outputPath} (${bytes} bytes, ${durationMs ?? 'unknown'}ms)`);
    const result: StopResult = { success: true, filePath: outputPath, durationMs, bytesWritten: bytes };
    this.lastResult = result;
    return result;
  }

  // Close and delete the in-progress file. Used when the renderer fails to
  // construct MediaRecorder after main already opened the stream.
  async abortRecording(): Promise<void> {
    if (!this.recordingActive && !this.fileHandle) return;
    this.recordingActive = false;
    const handle = this.fileHandle;
    const outputPath = this.outputPath;
    this.fileHandle = null;
    try {
      await this.writeChain;
    } catch {
      // aborting — swallow
    }
    try {
      if (handle) await handle.close();
    } catch (error) {
      console.warn('Failed to close recording file during abort:', error);
    }
    if (outputPath) {
      try {
        await fs.promises.unlink(outputPath);
      } catch {
        // file may already be gone
      }
    }
    this.outputPath = null;
    this.lastResult = null;
  }
}
