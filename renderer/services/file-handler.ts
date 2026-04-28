// File handling utilities for drag-drop, clipboard paste, and file dialog.
//
// Migrated from `js/fileHandler.js` (loaded as a global script that assigned
// `window.fileHandler`). `setupFileHandler()` preserves the global side
// effect for legacy.ts callers; `getFileHandler()` exposes the singleton to
// new typed callers.

import type { ElectronAPI } from '../electronAPI';

type SaveAudioFileResult = Awaited<ReturnType<ElectronAPI['saveAudioFileBase64']>>;
type CopyAudioFileResult = Awaited<ReturnType<ElectronAPI['copyAudioFile']>>;
type SelectAudioFileResult = Awaited<ReturnType<ElectronAPI['selectAudioFile']>>;

/**
 * Result of a single file ingestion (drag-drop, paste, or dialog selection).
 * `processAudioFile`/`saveAudioFileBase64`/`copyAudioFile` all share this
 * shape: success boolean plus optional `filePath` / `error` message.
 */
export type ProcessAudioFileResult = SaveAudioFileResult & CopyAudioFileResult;

/**
 * Subset of the browser `File` interface plus an optional `path` populated by
 * the Electron file dialog. The renderer accepts both real `File` objects
 * (drag-drop / clipboard) and synthesized objects from `selectFileViaDialog`.
 */
export interface AudioFileLike {
  name: string;
  size: number;
  type: string;
  /** Only present when the file came from the Electron dialog (not drag-drop). */
  path?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export class FileHandler {
  private readonly validTypes: ReadonlySet<string> = new Set([
    'audio/mp3',
    'audio/mpeg',
    'audio/mp4',
    'audio/x-m4a',
    'audio/m4a',
    'audio/wav',
    'audio/x-wav',
    'audio/wave',
    'audio/webm',
    'audio/ogg',
    'audio/opus',
    'audio/flac',
    'audio/aac',
  ]);

  private readonly validExtensions: ReadonlySet<string> = new Set([
    '.mp3',
    '.m4a',
    '.wav',
    '.webm',
    '.ogg',
    '.opus',
    '.flac',
    '.aac',
  ]);

  private readonly extensionMimes: Readonly<Record<string, string>> = {
    '.mp3': 'audio/mp3',
    '.m4a': 'audio/mp4',
    '.wav': 'audio/wav',
    '.webm': 'audio/webm',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.flac': 'audio/flac',
    '.aac': 'audio/aac',
  };

  private readonly maxSize: number = 500 * 1024 * 1024;
  private readonly chunkSize: number = 0x8000;

  // Validate file before processing
  validateFile(file: AudioFileLike | null | undefined): true {
    if (!file) {
      throw new Error('No file provided');
    }

    if (file.size > this.maxSize) {
      const sizeMB = (file.size / 1024 / 1024).toFixed(2);
      throw new Error(`File too large: ${sizeMB}MB (maximum: 500MB)`);
    }

    if (file.size === 0) {
      throw new Error('File is empty');
    }

    if (!file.name) {
      throw new Error('Invalid file: no filename');
    }

    const fileExtension = file.name.toLowerCase().substring(file.name.lastIndexOf('.'));
    const hasValidType = !!file.type && this.validTypes.has(file.type);
    const hasValidExtension = !!fileExtension && this.validExtensions.has(fileExtension);

    if (!hasValidType && !hasValidExtension) {
      throw new Error(
        'Please select a supported audio file (MP3, M4A, WAV, WebM, OGG, Opus, FLAC, AAC)',
      );
    }

    return true;
  }

  // Process audio file based on available data
  async processAudioFile(file: AudioFileLike): Promise<ProcessAudioFileResult> {
    try {
      this.validateFile(file);

      let result: ProcessAudioFileResult;

      // Check if file.path exists (only from file dialog)
      if (file.path) {
        // File dialog provides path for efficient copying
        result = await window.electronAPI.copyAudioFile({
          sourcePath: file.path,
          name: file.name,
        });
      } else {
        // Use base64 encoding (for drag-drop and clipboard paste)
        result = await this.transferViaBase64(file);
      }

      return result;
    } catch (error) {
      console.error('Error processing audio file:', error);
      throw error;
    }
  }

  // Transfer file via base64 encoding (optimized)
  async transferViaBase64(file: AudioFileLike): Promise<SaveAudioFileResult> {
    // Read file as buffer
    const buffer = await file.arrayBuffer();
    if (!buffer || buffer.byteLength === 0) {
      throw new Error('Failed to read file contents');
    }

    // Try FileReader API first (more efficient for large files)
    try {
      const base64Data = await this.arrayBufferToBase64(buffer);
      return await window.electronAPI.saveAudioFileBase64({
        name: file.name,
        dataBase64: base64Data,
      });
    } catch {
      // Fallback to manual conversion
      const uint8Array = new Uint8Array(buffer);
      let binary = '';

      for (let i = 0; i < uint8Array.length; i += this.chunkSize) {
        const chunk = uint8Array.subarray(i, i + this.chunkSize);
        binary += String.fromCharCode.apply(null, Array.from(chunk));
      }

      const base64Data = btoa(binary);
      return await window.electronAPI.saveAudioFileBase64({
        name: file.name,
        dataBase64: base64Data,
      });
    }
  }

  // Efficient ArrayBuffer to Base64 using FileReader
  arrayBufferToBase64(buffer: ArrayBuffer): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const blob = new Blob([buffer]);
      const reader = new FileReader();

      reader.onloadend = () => {
        // Extract base64 from data URL
        const result = reader.result;
        if (typeof result !== 'string') {
          reject(new Error('FileReader returned non-string result'));
          return;
        }
        const base64 = result.split(',')[1];
        if (base64 === undefined) {
          reject(new Error('FileReader returned malformed data URL'));
          return;
        }
        resolve(base64);
      };

      reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
      reader.readAsDataURL(blob);
    });
  }

  // Open file dialog and process selected file
  async selectFileViaDialog(): Promise<ProcessAudioFileResult | null> {
    const result: SelectAudioFileResult = await window.electronAPI.selectAudioFile();

    if (result.success && result.filePath) {
      // Get file info from main process
      const fileInfo = await window.electronAPI.getFileInfo(result.filePath);

      if (fileInfo.exists && fileInfo.name !== undefined && fileInfo.size !== undefined) {
        const name = fileInfo.name;
        const ext = name.toLowerCase().substring(name.lastIndexOf('.'));
        const fileWithPath: AudioFileLike = {
          name,
          path: result.filePath,
          size: fileInfo.size,
          type: this.extensionMimes[ext] ?? 'application/octet-stream',
          arrayBuffer: () => {
            throw new Error('arrayBuffer() not available for dialog-selected files');
          },
        };

        return await this.processAudioFile(fileWithPath);
      } else {
        throw new Error('Failed to get file info');
      }
    }

    return null;
  }

  // Extract title from filename (remove extension)
  extractTitle(filePath: string | { name: string }): string {
    const fileName = typeof filePath === 'string' ? filePath.split(/[/\\]/).pop() : filePath.name;
    return fileName ? fileName.replace(/\.[^/.]+$/, '') : 'Untitled';
  }
}

let instance: FileHandler | null = null;

/**
 * Create the singleton FileHandler and assign `window.fileHandler` for legacy
 * callers in `renderer/legacy.ts`. Idempotent.
 */
export function setupFileHandler(): void {
  if (!instance) {
    instance = new FileHandler();
  }
  window.fileHandler = instance;
}

/** Return the singleton FileHandler, creating it if `setupFileHandler` has not run yet. */
export function getFileHandler(): FileHandler {
  if (!instance) {
    instance = new FileHandler();
  }
  return instance;
}
