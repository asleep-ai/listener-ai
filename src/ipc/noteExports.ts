import { randomUUID } from 'crypto';
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
import { backgroundOperations, operationTarget, privateJoinKey } from './backgroundOperations';
import type { IpcContext } from './types';

const CUTOFF_MISMATCH_UPLOAD_ERROR =
  'The saved transcript cutoff no longer matches this transcript. Open the Transcript tab and set the cutoff again, or restore the full transcript, before uploading.';
const CUTOFF_MISMATCH_SEND_ERROR =
  'The saved transcript cutoff no longer matches this transcript. Open the Transcript tab and set the cutoff again, or restore the full transcript, before sending.';

export interface NotionUploadRequest {
  title: string;
  transcriptionData: any;
  audioFilePath?: string;
  transcriptionPath?: string;
  expectedGenerationId?: string | null;
}

export interface SlackSendRequest {
  title: string;
  transcriptionData: any;
  transcriptionPath?: string;
  expectedGenerationId?: string | null;
  notionUrl?: string;
  notionError?: string;
}

// Notion upload and Slack send. For a saved note, everything from reading its
// generation to recording the export status runs inside `withNoteOperation`,
// so a transcript cutoff change for the same note waits for the export to
// finish (and then marks its Notion page superseded), and an export requested
// while a cutoff is regenerating waits and then sees the new report.
//
// The IPC handlers and main-owned auto-mode follow-ups (src/ipc/transcription.ts)
// share these two functions, so both paths get the same generation, cutoff and
// queue guards.
export function register(ctx: IpcContext): void {
  ipcMain.handle('upload-to-notion', (_, data: NotionUploadRequest) =>
    uploadNoteToNotion(ctx, data),
  );
  ipcMain.handle('send-to-slack', (_, data: SlackSendRequest) => sendNoteToSlack(ctx, data));
}

// Only a request that names the generation it expects (a click in the open
// note, including after a reload, and auto mode's follow-ups, which pass the
// generation they just saved) joins a running export of that same
// generation. Requests with the same generation, title and destination
// describe the same publication, so an auto-mode upload and a click on the
// same note produce one page. A request without an expectation means
// "whatever is stored when its turn in the note's queue comes", which may be
// a report a queued Regenerate or cutoff has not written yet, so it never
// joins: it gets a unique identity and is only tracked. `null` (a legacy note
// expected to have no generation) is an expectation like any other.
function expectation(expected: string | null | undefined): unknown {
  return expected === undefined ? { unjoinable: randomUUID() } : expected;
}

export async function uploadNoteToNotion(
  ctx: IpcContext,
  data: NotionUploadRequest,
): Promise<{ success: boolean; url?: string; error?: string }> {
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
      if (ctx.isContainedTranscriptionPath(data.transcriptionPath) && generation === undefined) {
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
      if (generation !== undefined && ctx.isContainedTranscriptionPath(data.transcriptionPath)) {
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

    // A saved note's upload publishes what is stored, whatever the caller
    // sent, so a second request to the same database (a click after a
    // reload) joins the running upload instead of creating a second page.
    // The generation the caller expects is part of the identity: a stale
    // request is refused on its own and never takes a current one down with
    // it.
    const folder = data.transcriptionPath;
    if (!ctx.isContainedTranscriptionPath(folder)) return await upload();
    const target = operationTarget(folder);
    return await backgroundOperations.run(
      'notion-upload',
      target,
      () => withNoteOperation(folder, upload),
      undefined,
      privateJoinKey(
        target,
        expectation(data.expectedGenerationId),
        data.title,
        ctx.configService.getNotionApiKey(),
        ctx.configService.getNotionDatabaseId(),
      ),
    );
  } catch (error) {
    console.error('Error uploading to Notion:', error);
    reportError(error, { operation: 'notion.upload', severity: 'error' });
    ctx.notificationService.notifyUploadFailed('Upload failed. Check the app for details.');
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function sendNoteToSlack(ctx: IpcContext, data: SlackSendRequest) {
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
      if (ctx.isContainedTranscriptionPath(data.transcriptionPath) && generation === undefined) {
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
      if (generation !== undefined && ctx.isContainedTranscriptionPath(data.transcriptionPath)) {
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

      if (generation !== undefined && ctx.isContainedTranscriptionPath(data.transcriptionPath)) {
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

    // Same as Notion: a repeated send of a saved note to the same webhook
    // joins the running one, so the channel gets one message.
    const folder = data.transcriptionPath;
    if (!ctx.isContainedTranscriptionPath(folder)) return await send();
    const target = operationTarget(folder);
    return await backgroundOperations.run(
      'slack-send',
      target,
      () => withNoteOperation(folder, send),
      undefined,
      privateJoinKey(
        target,
        expectation(data.expectedGenerationId),
        data.title,
        ctx.configService.getSlackWebhookUrl(),
        data.notionUrl ?? null,
        data.notionError ?? null,
      ),
    );
  } catch (error) {
    console.error('Error sending to Slack:', error);
    reportError(error, { operation: 'slack.send', severity: 'error' });
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
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
