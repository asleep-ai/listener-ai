import * as fs from 'fs';
import * as path from 'path';
import { app, ipcMain } from 'electron';
import { withMeetingLock } from '../meetingLock';
import { withNoteOperation } from '../noteOperationQueue';
import { META_JSON } from '../outputService';
import { saveRegeneratedTranscription } from '../regenerateTranscription';
import type { TranscriptionResult } from '../geminiService';
import { reportError } from '../sentry';
import { metadataService } from '../services/metadataService';
import { notificationService } from '../services/notificationService';
import {
  type TranscriptionJobExports,
  type TranscriptionJobHandle,
  transcriptionJobs,
} from '../transcriptionJobs';
import { sendNoteToSlack, uploadNoteToNotion } from './noteExports';
import type { IpcContext } from './types';

// In-flight transcriptions live in the main-owned job registry
// (src/transcriptionJobs.ts), keyed by every path that names the recording.
// Each job's AbortSignal is plumbed through geminiService and the underlying
// provider SDKs. `cancel-transcription` aborts it until the note is saved; the
// transcribe-audio handler catches the abort and resolves with
// `{ cancelled: true }` so the renderer can clean up without an alert. A second
// request for a running recording joins it instead of restarting it, so a
// reloaded renderer that lost its progress UI cannot abort the run by asking
// again.

// Optional third `transcribe-audio` argument. `autoExport` (auto mode) makes
// the job itself run the configured Notion upload and Slack send after the
// note is saved, so they happen even if the renderer that asked reloads.
interface TranscribeOptions {
  autoExport: boolean;
  recordingTitle?: string;
}

function sanitizeTranscribeOptions(raw: unknown): TranscribeOptions {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    autoExport: value.autoExport === true,
    ...(typeof value.recordingTitle === 'string'
      ? { recordingTitle: value.recordingTitle.slice(0, 500) }
      : {}),
  };
}

// Same rule the renderer's auto mode used: a placeholder recording title gives
// way to the AI-suggested one.
function pickMeetingTitle(recordingTitle: string, suggestedTitle?: string): string {
  const isPlaceholder = recordingTitle === '' || recordingTitle === 'Untitled_Meeting';
  if (isPlaceholder && suggestedTitle) return suggestedTitle;
  return recordingTitle || suggestedTitle || 'Untitled Meeting';
}

// Moves a recording without ever replacing another file. The hard link claims
// the destination atomically (EEXIST when the name is taken), and only then is
// the source name removed. Filesystems without hard links fall back to an
// exclusive copy, which fails the same way when the destination exists.
// `onCreated` runs once the destination is complete and ours, before the old
// name is removed.
async function moveWithoutOverwrite(
  source: string,
  destination: string,
  onCreated?: () => void,
): Promise<void> {
  try {
    await fs.promises.link(source, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'ENOSYS' && code !== 'EXDEV') {
      throw error;
    }
    await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  }
  onCreated?.();
  try {
    await fs.promises.unlink(source);
  } catch (error) {
    // Keep exactly one name for the recording.
    await fs.promises.unlink(destination).catch(() => {});
    throw error;
  }
}

async function renameAudioFile(
  oldPath: string,
  suggestedTitle: string,
  handle: TranscriptionJobHandle,
): Promise<string> {
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

    // A recording already holding the name keeps it, and this one keeps its
    // original name. (EEXIST from the move below still decides the race.)
    if (fs.existsSync(newPath)) {
      console.warn('Kept the original recording name: another recording has the new one.');
      return oldPath;
    }
    // Reserve the new name for this job before touching the filesystem. The
    // reservation is synchronous and private: no other job can take the name,
    // a request or cancel for it waits until the move settles, and nothing
    // reaches this job through the name until the file is ours. A name
    // another running job answers to (even one whose file does not exist
    // right now) is never touched.
    if (!handle.reservePath(newPath)) {
      console.warn('Kept the original recording name: another transcription owns the new one.');
      return oldPath;
    }
    try {
      await moveWithoutOverwrite(oldPath, newPath, () => handle.commitPath(newPath));
    } catch (error) {
      handle.removePath(newPath);
      throw error;
    }
    console.log(`Renamed file from ${oldFileName} to ${newFileName}`);

    return newPath;
  } catch (error) {
    console.error('Error renaming file:', error);
    return oldPath; // Return original path if rename fails
  }
}

export function register(ctx: IpcContext): void {
  // Every job change reaches whichever renderer is currently loaded. Events are
  // never a reason to show or focus the window (Background Recording Policy).
  transcriptionJobs.subscribe((job) => {
    const win = ctx.getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('transcription-job-changed', job);
  });

  ipcMain.handle('get-transcription-jobs', () => transcriptionJobs.list());

  ipcMain.handle(
    'transcribe-audio',
    async (_, filePath: string, liveNotesRaw?: unknown, optionsRaw?: unknown) => {
      if (typeof filePath !== 'string' || !filePath) {
        return { success: false, error: 'Invalid audio file path' };
      }
      const options = sanitizeTranscribeOptions(optionsRaw);
      // Admitted synchronously, so a cancel sent right after the request
      // reaches it. A duplicate joins the running job even while its cancel is
      // still rolling back, and gets the same cancelled result; a new run can
      // start once the job has ended. A path still being created by another
      // job's rename is waited out first (no-op otherwise).
      if (transcriptionJobs.pendingReservation(filePath)) await settleReservations(filePath);
      const { job, joined, promise } = transcriptionJobs.start(
        {
          kind: 'transcribe',
          origin: options.autoExport ? 'auto' : 'manual',
          filePath,
          ...(options.recordingTitle ? { title: options.recordingTitle } : {}),
        },
        (handle) => runTranscription(ctx, filePath, liveNotesRaw, handle),
        (result, handle) => {
          if (!result.success || !('data' in result) || !result.data || handle.origin !== 'auto')
            return result;
          return runAutoExports(ctx, handle, {
            recordingTitle: handle.requestedTitle,
            result: result.data,
            audioFilePath: result.newFilePath ?? filePath,
            transcriptionPath: result.transcriptionPath,
            generationId: result.generationId,
          }).then((exports) => ({ ...result, exports }));
        },
      );
      if (joined) console.log('Joining the transcription already running for:', filePath);
      const result = await promise;
      return { ...result, jobId: job.id, ...(joined ? { joined: true as const } : {}) };
    },
  );

  ipcMain.handle('cancel-transcription', async (_, filePath: string) => {
    if (typeof filePath !== 'string' || !filePath) {
      return { success: false as const, reason: 'not-running' as const };
    }
    if (transcriptionJobs.pendingReservation(filePath)) await settleReservations(filePath);
    return transcriptionJobs.cancel(filePath);
  });
}

// Waits while another job's rename is still creating `filePath`, so neither a
// request nor a cancel can read a half-created file or reach a job that only
// tried to take the name. Callers only await it when a reservation is
// pending, so otherwise admission stays synchronous and a cancel sent right
// after a request still reaches it.
async function settleReservations(filePath: string): Promise<void> {
  for (
    let pending = transcriptionJobs.pendingReservation(filePath);
    pending;
    pending = transcriptionJobs.pendingReservation(filePath)
  ) {
    await pending;
  }
}

async function runTranscription(
  ctx: IpcContext,
  filePath: string,
  liveNotesRaw: unknown,
  handle: TranscriptionJobHandle,
) {
  const signal = handle.signal;
  let renamedAudioPath: string | undefined;
  let noteCommitted = false;

  const sendProgress = (percent: number, message: string) => {
    handle.progress(percent, message);
    const win = ctx.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('transcription-progress', {
        percent,
        message,
        filePath,
        jobId: handle.id,
      });
    }
  };

  try {
    console.log('Transcription requested for:', filePath);
    let existing: Awaited<ReturnType<typeof metadataService.getMetadata>> = null;
    try {
      existing = await metadataService.getMetadata(filePath);
    } catch (err) {
      console.warn('Failed to read recording metadata:', err);
    }
    const previousNoteWasPresent =
      !!existing?.transcriptionPath &&
      fs.existsSync(path.join(existing.transcriptionPath, META_JSON));
    let liveNotes = ctx.sanitizeLiveNotes(liveNotesRaw);
    if (!liveNotes || liveNotes.length === 0) {
      // Fall back to whatever stop-recording persisted -- covers the
      // record-now-transcribe-later flow when auto-mode is off.
      const fromMetadata = ctx.sanitizeLiveNotes(existing?.liveNotes);
      if (fromMetadata && fromMetadata.length > 0) {
        liveNotes = fromMetadata;
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
    // A cancel that lands after the provider already returned must not save.
    signal.throwIfAborted();
    console.log('Transcription completed successfully');
    console.log('Saving metadata for:', filePath);

    // Attach renderer-captured notes so downstream consumers (Notion upload,
    // re-render in the modal) can read them off the result object.
    if (liveNotes && liveNotes.length > 0) {
      result.liveNotes = liveNotes;
    }

    // Rename an untitled recording BEFORE its first save so meta.audioFile
    // and the sidecar both reference the final path (#209). A Regenerate
    // already has a linked note: keep its audio path stable until the note
    // replacement succeeds, including when saving fails (#213).
    const renameTitle =
      !existing?.transcriptionPath && path.basename(filePath).includes('Untitled_Meeting')
        ? result.suggestedTitle
        : undefined;
    let audioFilePath = filePath;
    if (renameTitle) {
      audioFilePath = await renameAudioFile(filePath, renameTitle, handle);
      if (audioFilePath !== filePath) {
        renamedAudioPath = audioFilePath;
        // Carry the stop-recording sidecar (live notes) over to the renamed
        // audio. Delete the old one only after the copy lands.
        try {
          const existingMetadata = await metadataService.getMetadata(filePath);
          if (existingMetadata) {
            await metadataService.saveMetadata(audioFilePath, existingMetadata);
            await metadataService.deleteMetadata(filePath);
          }
        } catch (error) {
          console.error('Failed to move metadata to renamed audio:', error);
        }
      }
    }

    // Save transcription files. When the recording already has a note
    // (Regenerate), it is replaced in place only once the new one is fully
    // written, so a failure here leaves the previous note linked and intact.
    const title = result.suggestedTitle || path.basename(filePath, path.extname(filePath));
    let transcriptionPath: string | undefined;
    let generationId: string | null | undefined;
    let metadataHandledUnderLock = false;
    const lockPath =
      previousNoteWasPresent &&
      existing?.transcriptionPath &&
      ctx.isContainedTranscriptionPath(existing.transcriptionPath)
        ? existing.transcriptionPath
        : undefined;
    try {
      const save = async () => {
        // A cancel can arrive during the awaited rename, sidecar move, or
        // wait for an in-flight Drive sync of this note.
        signal.throwIfAborted();
        if (
          previousNoteWasPresent &&
          existing?.transcriptionPath &&
          !fs.existsSync(path.join(existing.transcriptionPath, META_JSON))
        ) {
          throw new Error('The linked note was deleted while regeneration was running.');
        }
        const savedPath = saveRegeneratedTranscription({
          title,
          result,
          audioFilePath,
          dataPath: app.getPath('userData'),
          liveNotes,
          previousFolderPath: existing?.transcriptionPath,
        });
        // Commit boundary: the note is on disk, so a cancel from here on is
        // refused instead of reporting a cancellation that did not happen.
        handle.commit();
        generationId =
          JSON.parse(fs.readFileSync(path.join(savedPath, META_JSON), 'utf-8')).generationId ??
          null;
        if (lockPath) {
          metadataHandledUnderLock = true;
          try {
            await metadataService.saveMetadata(audioFilePath, {
              title,
              suggestedTitle: result.suggestedTitle,
              transcriptionPath: savedPath,
              customFields: result.customFields,
              liveNotes,
              transcribedAt: new Date().toISOString(),
            });
            console.log('Metadata saved successfully');
          } catch (error) {
            console.error('Failed to save metadata:', error);
          }
        }
        return savedPath;
      };
      // A linked note is replaced in the same per-note queue as Notion/Slack
      // exports, so an export in flight records its status against the note
      // it published before the replacement, and one requested meanwhile
      // reads the new note (or is refused as stale) afterwards.
      transcriptionPath = lockPath
        ? await withNoteOperation(lockPath, () => withMeetingLock(lockPath, save, { signal }), {
            signal,
          })
        : await save();
      noteCommitted = true;
      console.log('Transcription saved to:', transcriptionPath);
      ctx.maybeAutoSync();
    } catch (error) {
      if (signal.aborted) throw error;
      console.error('Failed to save transcription files:', error);
      reportError(error, { operation: 'transcription.save', severity: 'warning' });
    }

    if (!transcriptionPath && existing?.transcriptionPath) {
      // Leave the sidecar alone when regeneration did not save a new note;
      // never pair it with inline fields from an uncommitted result.
      const deletedDuringRun =
        previousNoteWasPresent && !fs.existsSync(path.join(existing.transcriptionPath, META_JSON));
      return {
        success: false,
        error: deletedDuringRun
          ? 'The linked note was deleted during regeneration. No new note was saved.'
          : 'Could not save the regenerated note. The previous note was kept.',
      };
    }

    // The outcome is decided from here on (the inline fallback below is the
    // saved result when the note files could not be written).
    handle.commit();

    // Save metadata - slim if transcription files saved, inline fallback otherwise
    try {
      if (!metadataHandledUnderLock) {
        if (transcriptionPath) {
          await metadataService.saveMetadata(audioFilePath, {
            title,
            suggestedTitle: result.suggestedTitle,
            transcriptionPath,
            customFields: result.customFields,
            liveNotes,
            transcribedAt: new Date().toISOString(),
          });
        } else {
          // Fallback: store inline data when file write failed
          await metadataService.saveMetadata(audioFilePath, {
            title,
            suggestedTitle: result.suggestedTitle,
            transcript: result.transcript,
            summary: result.summary,
            keyPoints: result.keyPoints,
            actionItems: result.actionItems,
            ...(result.summarySections ? { summarySections: result.summarySections } : {}),
            ...(result.actionItemGroups ? { actionItemGroups: result.actionItemGroups } : {}),
            customFields: result.customFields,
            liveNotes,
            transcribedAt: new Date().toISOString(),
          });
        }
        console.log('Metadata saved successfully');
      }
    } catch (error) {
      console.error('Failed to save metadata:', error);
    }

    notificationService.notifyTranscriptionComplete(result.suggestedTitle || 'Meeting');

    if (renameTitle) {
      handle.update({ newFilePath: audioFilePath });
    }

    if (renameTitle) {
      return {
        success: true,
        data: result,
        newFilePath: audioFilePath,
        transcriptionPath,
        generationId,
      };
    }

    return {
      success: true,
      data: result,
      transcriptionPath,
      generationId,
    };
  } catch (error) {
    // Cancellation is a normal outcome -- skip the failure notification and
    // signal it cleanly so the renderer collapses the inline progress without
    // an error toast. Since every cancellation originates from the job
    // registry's `cancel()`, `signal.aborted` is the canonical check; matching
    // on error name/message would risk mis-classifying legitimate provider
    // failures whose body happens to contain "aborted".
    if (signal.aborted) {
      if (renamedAudioPath && !noteCommitted) {
        try {
          // Audio first, and never over a recording that took the original
          // name meanwhile: when that fails, the audio and its sidecar both
          // stay under the renamed path and the caller gets `newFilePath`.
          const restoredFrom = renamedAudioPath;
          await moveWithoutOverwrite(restoredFrom, filePath);
          renamedAudioPath = undefined;
          const movedMetadata = await metadataService.getMetadata(restoredFrom);
          if (movedMetadata) {
            await metadataService.saveMetadata(filePath, movedMetadata);
            await metadataService.deleteMetadata(restoredFrom);
          }
        } catch (rollbackError) {
          console.error('Failed to restore cancelled recording rename:', rollbackError);
        }
      }
      console.log('Transcription cancelled for:', filePath);
      return {
        success: false,
        cancelled: true as const,
        ...(renamedAudioPath ? { newFilePath: renamedAudioPath } : {}),
      };
    }
    console.error('Error transcribing audio:', error);
    reportError(error, { operation: 'transcription', severity: 'error' });
    notificationService.notifyTranscriptionFailed(
      'Transcription failed. Check the app for details.',
    );
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      errorDetails: ctx.serializeTranscriptionError(error),
    };
  }
}

// Auto mode's follow-ups, owned by the job so a renderer reload cannot drop
// them. Uses the same guarded operations as the export IPC (generation check,
// cutoff rules, per-note queue). A Notion failure is still passed to Slack, and
// each destination's outcome is recorded separately.
async function runAutoExports(
  ctx: IpcContext,
  handle: TranscriptionJobHandle,
  input: {
    recordingTitle?: string;
    result: TranscriptionResult;
    audioFilePath: string;
    transcriptionPath?: string;
    generationId?: string | null;
  },
): Promise<TranscriptionJobExports> {
  const exports: TranscriptionJobExports = {};
  const notionConfigured = !!ctx.getNotionService();
  const slackConfigured =
    !!ctx.configService.getSlackWebhookUrl() && ctx.configService.getSlackAutoShare();
  if (!notionConfigured && !slackConfigured) return exports;

  const title = pickMeetingTitle(input.recordingTitle ?? '', input.result.suggestedTitle);
  const generation =
    input.generationId !== undefined ? { expectedGenerationId: input.generationId } : {};
  const report = () => handle.update({ exports: { ...exports } });
  handle.update({ phase: 'exporting' });

  let notionUrl: string | undefined;
  let notionError: string | undefined;
  if (notionConfigured) {
    exports.notion = { status: 'running' };
    report();
    handle.progress(100, 'Uploading to Notion...');
    const upload = await uploadNoteToNotion(ctx, {
      title,
      transcriptionData: input.result,
      audioFilePath: input.audioFilePath,
      transcriptionPath: input.transcriptionPath,
      ...generation,
    });
    if (upload.success) {
      notionUrl = upload.url;
      exports.notion = { status: 'succeeded', ...(upload.url ? { url: upload.url } : {}) };
      if (upload.url) {
        try {
          ctx.openExternal(upload.url);
        } catch (error) {
          console.error('Failed to open the Notion page:', error);
        }
      }
    } else {
      notionError = upload.error || 'Unknown error';
      exports.notion = { status: 'failed', error: notionError };
      console.error('Auto mode: Notion upload failed:', notionError);
    }
    report();
  }

  if (slackConfigured) {
    exports.slack = { status: 'running' };
    report();
    handle.progress(100, 'Sending to Slack...');
    const sent = await sendNoteToSlack(ctx, {
      title,
      transcriptionData: input.result,
      transcriptionPath: input.transcriptionPath,
      ...generation,
      notionUrl,
      notionError,
    });
    exports.slack = sent.success
      ? { status: 'succeeded' }
      : { status: 'failed', error: ('error' in sent && sent.error) || 'Unknown error' };
    if (!sent.success) console.error('Auto mode: Slack send failed:', exports.slack.error);
    report();
  }
  return exports;
}
