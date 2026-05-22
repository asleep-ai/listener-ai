import * as fs from 'fs';
import * as path from 'path';
import { app, ipcMain } from 'electron';
import { saveTranscription } from '../outputService';
import { metadataService } from '../services/metadataService';
import { notificationService } from '../services/notificationService';
import type { IpcContext } from './types';

// In-flight transcriptions keyed by audio filePath. Each entry holds an
// AbortController whose signal is plumbed through geminiService and the
// underlying provider SDKs. `cancel-transcription` aborts the controller; the
// transcribe-audio handler catches the abort and resolves with
// `{ cancelled: true }` so the renderer can clean up without an alert.
const activeTranscriptions = new Map<string, AbortController>();

async function renameAudioFile(oldPath: string, suggestedTitle: string): Promise<string> {
  try {
    const dir = path.dirname(oldPath);
    const ext = path.extname(oldPath);
    const oldFileName = path.basename(oldPath, ext);

    // Extract timestamp from old filename (format: Untitled_Meeting_2025-07-10T01-34-07-679Z)
    const timestampMatch = oldFileName.match(/_(\d{4}-\d{2}-\d{2}T[\d-]+Z)$/);
    const timestamp = timestampMatch
      ? timestampMatch[1]
      : new Date().toISOString().replace(/[:.]/g, '-');

    // Sanitize the suggested title
    const sanitizedTitle = suggestedTitle
      .replace(/[<>:"/\\|?*]/g, '_') // Replace problematic characters
      .replace(/\s+/g, '_') // Replace spaces with underscores
      .trim();

    const newFileName = `${sanitizedTitle}_${timestamp}${ext}`;
    const newPath = path.join(dir, newFileName);

    // Rename the file
    await fs.promises.rename(oldPath, newPath);
    console.log(`Renamed file from ${oldFileName} to ${newFileName}`);

    return newPath;
  } catch (error) {
    console.error('Error renaming file:', error);
    return oldPath; // Return original path if rename fails
  }
}

export function register(ctx: IpcContext): void {
  ipcMain.handle('transcribe-audio', async (_, filePath: string, liveNotesRaw?: unknown) => {
    // Replace any prior controller for the same file so a re-trigger (e.g.
    // Regenerate) supersedes the previous run.
    activeTranscriptions.get(filePath)?.abort();
    const controller = new AbortController();
    activeTranscriptions.set(filePath, controller);
    const signal = controller.signal;

    const sendProgress = (percent: number, message: string) => {
      const win = ctx.getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('transcription-progress', { percent, message, filePath });
      }
    };

    try {
      console.log('Transcription requested for:', filePath);
      let liveNotes = ctx.sanitizeLiveNotes(liveNotesRaw);
      if (!liveNotes || liveNotes.length === 0) {
        // Fall back to whatever stop-recording persisted -- covers the
        // record-now-transcribe-later flow when auto-mode is off.
        try {
          const existing = await metadataService.getMetadata(filePath);
          const fromMetadata = ctx.sanitizeLiveNotes(existing?.liveNotes);
          if (fromMetadata && fromMetadata.length > 0) {
            liveNotes = fromMetadata;
          }
        } catch (err) {
          console.warn('Failed to read live notes from metadata:', err);
        }
      }

      sendProgress(0, 'Initializing AI service...');

      // Lazy get-or-create against the main-owned slot. Returns null only when
      // AI credentials are missing -- the slot lifecycle (reset on
      // applyConfigSideEffects) stays in main and isn't part of this surface.
      const geminiService = ctx.ensureGeminiService();
      if (!geminiService) {
        return { success: false, error: ctx.formatAiCredentialsError() };
      }

      sendProgress(10, 'Starting transcription...');

      console.log('Starting transcription...');

      const summaryPrompt = ctx.configService.getSummaryPrompt();
      const result = await geminiService.transcribeAudio(
        filePath,
        sendProgress,
        summaryPrompt,
        liveNotes,
        { signal },
      );
      console.log('Transcription completed successfully');
      console.log('Saving metadata for:', filePath);

      // Attach renderer-captured notes so downstream consumers (Notion upload,
      // re-render in the modal) can read them off the result object.
      if (liveNotes && liveNotes.length > 0) {
        result.liveNotes = liveNotes;
      }

      // Save transcription files (summary.md + transcript.md)
      const title = result.suggestedTitle || path.basename(filePath, path.extname(filePath));
      let transcriptionPath: string | undefined;
      try {
        transcriptionPath = saveTranscription({
          title,
          result,
          audioFilePath: filePath,
          dataPath: app.getPath('userData'),
          liveNotes,
        });
        console.log('Transcription saved to:', transcriptionPath);
        ctx.maybeAutoSync();
      } catch (error) {
        console.error('Failed to save transcription files:', error);
      }

      // Save metadata - slim if transcription files saved, inline fallback otherwise
      try {
        if (transcriptionPath) {
          await metadataService.saveMetadata(filePath, {
            title,
            suggestedTitle: result.suggestedTitle,
            transcriptionPath,
            customFields: result.customFields,
            liveNotes,
            transcribedAt: new Date().toISOString(),
          });
        } else {
          // Fallback: store inline data when file write failed
          await metadataService.saveMetadata(filePath, {
            title,
            suggestedTitle: result.suggestedTitle,
            transcript: result.transcript,
            summary: result.summary,
            keyPoints: result.keyPoints,
            actionItems: result.actionItems,
            customFields: result.customFields,
            liveNotes,
            transcribedAt: new Date().toISOString(),
          });
        }
        console.log('Metadata saved successfully');
      } catch (error) {
        console.error('Failed to save metadata:', error);
      }

      notificationService.notifyTranscriptionComplete(result.suggestedTitle || 'Meeting');

      // Check if we need to rename the file (if it was untitled)
      const fileName = path.basename(filePath);
      if (fileName.includes('Untitled_Meeting') && result.suggestedTitle) {
        const newFilePath = await renameAudioFile(filePath, result.suggestedTitle);

        // Move metadata to new file path
        const existingMetadata = await metadataService.getMetadata(filePath);
        if (existingMetadata) {
          await metadataService.deleteMetadata(filePath);
          await metadataService.saveMetadata(newFilePath, existingMetadata);
        }

        return { success: true, data: result, newFilePath, transcriptionPath };
      }

      return { success: true, data: result, transcriptionPath };
    } catch (error) {
      // Cancellation is a normal outcome -- skip the failure notification and
      // signal it cleanly so the renderer collapses the inline progress without
      // an error toast. Since every cancellation originates from `controller
      // .abort()` in this file, `signal.aborted` is the canonical check; matching
      // on error name/message would risk mis-classifying legitimate provider
      // failures whose body happens to contain "aborted".
      if (signal.aborted) {
        console.log('Transcription cancelled for:', filePath);
        return { success: false, cancelled: true as const };
      }
      console.error('Error transcribing audio:', error);
      notificationService.notifyTranscriptionFailed(
        'Transcription failed. Check the app for details.',
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        errorDetails: ctx.serializeTranscriptionError(error),
      };
    } finally {
      // Only clear if we're still the live controller for this file; a
      // superseding run will have replaced us already.
      if (activeTranscriptions.get(filePath) === controller) {
        activeTranscriptions.delete(filePath);
      }
    }
  });

  ipcMain.handle('cancel-transcription', async (_, filePath: string) => {
    const controller = activeTranscriptions.get(filePath);
    if (!controller) return { success: false, reason: 'not-running' as const };
    controller.abort();
    return { success: true };
  });
}
