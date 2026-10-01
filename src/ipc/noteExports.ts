import { ipcMain } from 'electron';
import { withNoteOperation } from '../noteOperationQueue';
import {
  type ReadTranscriptionResult,
  readTranscription,
  readTranscriptionGeneration,
  updateTranscriptionStatus,
} from '../outputService';
import { reportError } from '../sentry';
import { metadataService } from '../services/metadataService';
import {
  exportPayloadFromNote,
  titleForSavedReport,
  withIncludedTranscript,
} from '../transcriptCutoff';
import type { IpcContext } from './types';

const CUTOFF_MISMATCH_UPLOAD_ERROR =
  'The saved transcript cutoff no longer matches this transcript. Open the Transcript tab and set the cutoff again, or restore the full transcript, before uploading.';
const CUTOFF_MISMATCH_SEND_ERROR =
  'The saved transcript cutoff no longer matches this transcript. Open the Transcript tab and set the cutoff again, or restore the full transcript, before sending.';

// Notion upload and Slack send. For a saved note, everything from reading its
// generation to recording the export status runs inside `withNoteOperation`,
// so a transcript cutoff change for the same note waits for the export to
// finish (and then marks its Notion page superseded), and an export requested
// while a cutoff is regenerating waits and then sees the new report.
export function register(ctx: IpcContext): void {
  ipcMain.handle(
    'upload-to-notion',
    async (
      _,
      data: {
        title: string;
        transcriptionData: any;
        audioFilePath?: string;
        transcriptionPath?: string;
        expectedGenerationId?: string | null;
      },
    ) => {
      try {
        console.log('Uploading to Notion:', data.title);

        const notionService = ctx.getNotionService();
        if (!notionService) {
          return { success: false, error: 'Notion configuration not found' };
        }

        const upload = async () => {
          let uploadTitle = data.title;
          const generation = ctx.isContainedTranscriptionPath(data.transcriptionPath)
            ? await readTranscriptionGeneration(data.transcriptionPath).catch(() => undefined)
            : undefined;
          if (
            ctx.isContainedTranscriptionPath(data.transcriptionPath) &&
            generation === undefined
          ) {
            return {
              success: false,
              error: 'This note could not be read. Reopen it before uploading.',
            };
          }
          if (
            ctx.isContainedTranscriptionPath(data.transcriptionPath) &&
            data.expectedGenerationId !== undefined &&
            generation !== data.expectedGenerationId
          ) {
            return { success: false, error: 'This note changed. Reopen it before uploading.' };
          }

          // What leaves the app is decided here, not by the renderer payload: a
          // saved note is re-read so Notion gets its current report and only the
          // transcript text before its tail cutoff.
          if (data.transcriptionData?.transcriptCutoffMismatch === true) {
            return { success: false, error: CUTOFF_MISMATCH_UPLOAD_ERROR };
          }
          let transcriptionData = withIncludedTranscript(data.transcriptionData ?? {});
          if (
            generation !== undefined &&
            ctx.isContainedTranscriptionPath(data.transcriptionPath)
          ) {
            const stored = await readTranscription(data.transcriptionPath);
            if (!stored || (stored.generationId ?? null) !== generation) {
              return { success: false, error: 'This note changed. Reopen it before uploading.' };
            }
            // Fail closed: never guess where the report ends.
            if (stored.transcriptCutoffMismatch) {
              return { success: false, error: CUTOFF_MISMATCH_UPLOAD_ERROR };
            }
            transcriptionData = exportPayloadFromNote(transcriptionData, stored);
            uploadTitle = await savedReportTitle(data.title, data.audioFilePath, stored);
          }

          const result = await notionService.createMeetingNote(
            `${uploadTitle} by L.AI`,
            new Date(),
            transcriptionData,
            data.audioFilePath,
          );

          if (
            result.success &&
            result.url &&
            generation !== undefined &&
            ctx.isContainedTranscriptionPath(data.transcriptionPath)
          ) {
            try {
              await updateTranscriptionStatus(
                data.transcriptionPath,
                {
                  notionPageUrl: result.url,
                },
                generation,
              );
            } catch (error) {
              console.error('Failed to persist Notion URL to transcription:', error);
              reportError(error, { operation: 'notion.persistUrl', severity: 'warning' });
            }
          } else if (!result.success) {
            reportError(new Error('Notion upload reported failure'), {
              operation: 'notion.upload',
              severity: 'error',
            });
          }

          ctx.notificationService.notifyUploadComplete(uploadTitle);
          return result;
        };

        return ctx.isContainedTranscriptionPath(data.transcriptionPath)
          ? await withNoteOperation(data.transcriptionPath, upload)
          : await upload();
      } catch (error) {
        console.error('Error uploading to Notion:', error);
        reportError(error, { operation: 'notion.upload', severity: 'error' });
        ctx.notificationService.notifyUploadFailed('Upload failed. Check the app for details.');
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  ipcMain.handle(
    'send-to-slack',
    async (
      _,
      data: {
        title: string;
        transcriptionData: any;
        transcriptionPath?: string;
        expectedGenerationId?: string | null;
        notionUrl?: string;
        notionError?: string;
      },
    ) => {
      try {
        console.log('Sending to Slack:', data.title);

        const service = ctx.getSlackService();
        if (!service) {
          return { success: false, error: 'Slack webhook URL is not configured' };
        }

        const send = async () => {
          const generation = ctx.isContainedTranscriptionPath(data.transcriptionPath)
            ? await readTranscriptionGeneration(data.transcriptionPath).catch(() => undefined)
            : undefined;
          if (
            ctx.isContainedTranscriptionPath(data.transcriptionPath) &&
            generation === undefined
          ) {
            return {
              success: false,
              error: 'This note could not be read. Reopen it before sending.',
            };
          }
          if (
            ctx.isContainedTranscriptionPath(data.transcriptionPath) &&
            data.expectedGenerationId !== undefined &&
            generation !== data.expectedGenerationId
          ) {
            return { success: false, error: 'This note changed. Reopen it before sending.' };
          }

          // For a historical resend, use the original meeting time from frontmatter
          // so the Slack message shows when the meeting actually happened, not now.
          let meetingDate = new Date();
          let title = data.title;
          let transcriptionData = data.transcriptionData;
          if (transcriptionData?.transcriptCutoffMismatch === true) {
            return { success: false, error: CUTOFF_MISMATCH_SEND_ERROR };
          }
          if (
            generation !== undefined &&
            ctx.isContainedTranscriptionPath(data.transcriptionPath)
          ) {
            const stored = await readTranscription(data.transcriptionPath).catch(() => null);
            if (!stored || (stored.generationId ?? null) !== generation) {
              return { success: false, error: 'This note changed. Reopen it before sending.' };
            }
            if (stored.transcriptCutoffMismatch) {
              return { success: false, error: CUTOFF_MISMATCH_SEND_ERROR };
            }
            if (stored?.transcribedAt) {
              const parsed = new Date(stored.transcribedAt);
              if (!Number.isNaN(parsed.getTime())) meetingDate = parsed;
            }
            // Send the report as saved (it may have been regenerated for a
            // transcript cutoff), not whatever copy the renderer still holds,
            // under the same title a Notion upload of it would get.
            transcriptionData = exportPayloadFromNote(transcriptionData ?? {}, stored);
            title = await savedReportTitle(data.title, stored.audioFilePath, stored);
          }

          const result = await service.sendMeetingSummary({
            title,
            date: meetingDate,
            result: transcriptionData,
            notionUrl: data.notionUrl,
            notionError: data.notionError,
          });

          if (
            generation !== undefined &&
            ctx.isContainedTranscriptionPath(data.transcriptionPath)
          ) {
            try {
              // Preserve the previous successful slackSentAt on a failed resend;
              // only the error field reflects the new failure.
              await updateTranscriptionStatus(
                data.transcriptionPath,
                {
                  ...(result.success ? { slackSentAt: result.sentAt } : {}),
                  slackError: result.success ? null : result.error,
                },
                generation,
              );
            } catch (error) {
              console.error('Failed to persist Slack status to transcription:', error);
              reportError(error, { operation: 'slack.persistStatus', severity: 'warning' });
            }
          }

          if (!result.success) {
            reportError(new Error(result.error), { operation: 'slack.send', severity: 'error' });
          }

          return result;
        };

        return ctx.isContainedTranscriptionPath(data.transcriptionPath)
          ? await withNoteOperation(data.transcriptionPath, send)
          : await send();
      } catch (error) {
        console.error('Error sending to Slack:', error);
        reportError(error, { operation: 'slack.send', severity: 'error' });
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: message };
      }
    },
  );
}

// The title a saved report is published under: the regenerated report title
// when the visible title is still the AI suggestion the recording was saved
// with, otherwise the visible (user-chosen) title.
async function savedReportTitle(
  visibleTitle: string,
  audioFilePath: string | undefined,
  stored: ReadTranscriptionResult,
): Promise<string> {
  const sidecar = audioFilePath ? await metadataService.getMetadata(audioFilePath) : null;
  return sidecar?.suggestedTitle
    ? titleForSavedReport(visibleTitle, sidecar.suggestedTitle, stored.title)
    : stored.title;
}
