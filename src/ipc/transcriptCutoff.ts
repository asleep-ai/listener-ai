import * as path from 'path';
import { app, ipcMain } from 'electron';
import type { TranscriptCutoffApiResult } from '../electronApiTypes';
import { withNoteOperation } from '../noteOperationQueue';
import { type LiveNote, readTranscription } from '../outputService';
import { applyTranscriptCutoff } from '../regenerateTranscription';
import { reportError } from '../sentry';
import { metadataService } from '../services/metadataService';
import type { IpcContext } from './types';

// One report regeneration per note at a time; a second request while the
// first is still summarizing would be refused at save time anyway. The
// regeneration itself, from reading the note to the final read-back, runs in
// the note's operation queue, so it waits for an in-flight Notion upload or
// Slack send of the same note (whose page it then marks superseded) and holds
// back exports requested meanwhile until the new report is saved.
const activeCutoffs = new Set<string>();

export function register(ctx: IpcContext): void {
  ipcMain.handle(
    'apply-transcript-cutoff',
    async (
      _,
      data: {
        transcriptionPath: string;
        expectedGenerationId: string | null;
        cutoffOffset: number | null;
      },
    ): Promise<TranscriptCutoffApiResult> => {
      const folderPath = data?.transcriptionPath;
      if (!ctx.isContainedTranscriptionPath(folderPath)) {
        return { success: false, error: 'This note cannot be changed.' };
      }
      const cutoffOffset = data.cutoffOffset;
      if (cutoffOffset !== null && !Number.isInteger(cutoffOffset)) {
        return { success: false, error: 'The cutoff point is outside the transcript.' };
      }
      const key = path.resolve(folderPath);
      if (activeCutoffs.has(key)) {
        return { success: false, error: 'The report for this note is already being regenerated.' };
      }
      const geminiService = ctx.ensureGeminiService();
      if (!geminiService) {
        return { success: false, error: ctx.formatAiCredentialsError() };
      }

      activeCutoffs.add(key);
      try {
        return await withNoteOperation(folderPath, () =>
          regenerate(
            ctx,
            geminiService,
            folderPath,
            data.expectedGenerationId ?? null,
            cutoffOffset,
          ),
        );
      } finally {
        activeCutoffs.delete(key);
      }
    },
  );
}

async function regenerate(
  ctx: IpcContext,
  geminiService: NonNullable<ReturnType<IpcContext['ensureGeminiService']>>,
  folderPath: string,
  expectedGenerationId: string | null,
  cutoffOffset: number | null,
): Promise<TranscriptCutoffApiResult> {
  try {
    const summaryPrompt = ctx.configService.getSummaryPrompt();
    const fallbackLiveNotes = await sidecarLiveNotes(ctx, folderPath);
    await applyTranscriptCutoff({
      dataPath: app.getPath('userData'),
      folderPath,
      expectedGenerationId,
      cutoffOffset,
      fallbackLiveNotes,
      summarize: (transcript, context) =>
        geminiService.summarizeTranscript(transcript, {
          customSummaryPrompt: summaryPrompt,
          liveNotes: context.liveNotes,
          lostSegments: context.lostSegments,
        }),
    });
    ctx.maybeAutoSync();

    const note = await readTranscription(folderPath);
    if (!note) return { success: false, error: 'This note could not be read.' };
    return {
      success: true,
      data: {
        generationId: note.generationId ?? null,
        title: note.title,
        suggestedTitle: note.suggestedTitle,
        transcript: note.transcript,
        summary: note.summary,
        keyPoints: note.keyPoints,
        actionItems: note.actionItems,
        summarySections: note.summarySections,
        actionItemGroups: note.actionItemGroups,
        customFields: note.customFields,
        emoji: note.emoji,
        liveNotes: note.liveNotes ?? fallbackLiveNotes,
        highlights: note.highlights,
        notionPageUrl: note.notionPageUrl,
        supersededNotionPageUrl: note.supersededNotionPageUrl,
        slackSentAt: note.slackSentAt,
        transcriptCutoff: note.transcriptCutoff,
      },
    };
  } catch (error) {
    console.error('Failed to apply transcript cutoff:', error);
    reportError(error, { operation: 'transcription.cutoff', severity: 'warning' });
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Older recordings keep their flagged notes only in the recording's metadata
// sidecar (get-metadata shows those too). Best effort: a missing or unreadable
// sidecar means no notes.
async function sidecarLiveNotes(
  ctx: IpcContext,
  folderPath: string,
): Promise<LiveNote[] | undefined> {
  try {
    const note = await readTranscription(folderPath);
    if (!note?.audioFilePath) return undefined;
    const sidecar = await metadataService.getMetadata(note.audioFilePath);
    const notes = ctx.sanitizeLiveNotes(sidecar?.liveNotes);
    return notes && notes.length > 0 ? notes : undefined;
  } catch {
    return undefined;
  }
}
