import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { app, dialog, ipcMain } from 'electron';
import { extensionForMimeType } from '../audioFormats';
import { formatTimestamp, sanitizeForPath, saveTranscription } from '../outputService';
import { concatAudioFiles } from '../services/audioConcatService';
import { metadataService } from '../services/metadataService';
import type { IpcContext } from './types';

const execFileAsync = promisify(execFile);

// Single-flight gate for `merge-recordings`. A second click while a merge is
// running returns `{ code: 'merge-busy' }` rather than racing against the
// in-flight one for the shared GeminiService and the merged-output filename
// slot. Lives at module scope (not on ctx) because this state is local to
// this handler set and shouldn't leak into the IpcContext surface.
let mergeInFlight = false;

export function register(ctx: IpcContext): void {
  // Permanently removes a meeting: audio file, metadata JSON, and the
  // transcription folder (if one exists). Containment-checks every path
  // before touching disk so a buggy or compromised renderer can't aim
  // fs.rmSync at arbitrary locations. Triggers a Drive sync immediately
  // afterward so the Phase 3C tombstone propagation kicks in -- otherwise
  // the user wouldn't see the deletion mirrored on their other devices
  // until the next 60s timer tick.
  ipcMain.handle('delete-meeting', async (_, audioFilePath: string) => {
    try {
      if (!audioFilePath || typeof audioFilePath !== 'string') {
        return { success: false as const, error: 'Invalid audio file path' };
      }
      const recordingsDir = path.join(app.getPath('userData'), 'recordings');
      const resolved = path.resolve(audioFilePath);
      if (!resolved.startsWith(recordingsDir + path.sep)) {
        return { success: false as const, error: 'Path is outside the recordings directory' };
      }

      // Pull metadata first so we know whether to clean up a transcription
      // folder. Missing metadata is fine (raw recording never transcribed).
      const meta = await metadataService.getMetadata(resolved);
      if (meta?.transcriptionPath && ctx.isContainedTranscriptionPath(meta.transcriptionPath)) {
        try {
          fs.rmSync(meta.transcriptionPath, { recursive: true, force: true });
        } catch (err) {
          console.error('Failed to remove transcription folder:', err);
          // Continue -- audio cleanup still useful even if folder rm partially failed.
        }
      }

      try {
        fs.rmSync(resolved, { force: true });
      } catch (err) {
        console.error('Failed to remove audio file:', err);
      }

      await metadataService.deleteMetadata(resolved);

      // Refresh the renderer's list immediately; auto-sync to Drive in the
      // background so the deletion propagates to other devices via tombstone.
      const mainWindow = ctx.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('recordings-changed');
      }
      ctx.maybeAutoSync();

      return { success: true as const };
    } catch (error) {
      console.error('delete-meeting failed:', error);
      return {
        success: false as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle('export-recording-m4a', async (_, srcPath: string) => {
    try {
      if (!srcPath || typeof srcPath !== 'string') {
        return { success: false, error: 'Invalid source path' };
      }
      // Containment: the renderer is trusted today, but bound srcPath to the
      // recordings directory so a future renderer bug can't transcode arbitrary
      // local files. realpath resolves symlinks before the prefix check.
      const recordingsDir = path.join(app.getPath('userData'), 'recordings');
      let resolvedSrc: string;
      try {
        resolvedSrc = await fs.promises.realpath(srcPath);
      } catch {
        return { success: false, error: 'Source recording not found' };
      }
      const resolvedRoot = await fs.promises.realpath(recordingsDir).catch(() => recordingsDir);
      if (!resolvedSrc.startsWith(resolvedRoot + path.sep)) {
        return { success: false, error: 'Source path is outside the recordings directory' };
      }

      const ffmpegPath = await ctx.ffmpegManager.ensureFFmpeg();
      if (!ffmpegPath) {
        return {
          success: false,
          code: 'ffmpeg-missing',
          error: 'FFmpeg is required for M4A export.',
        };
      }

      const baseName = path.basename(resolvedSrc, path.extname(resolvedSrc));
      const dialogOptions = {
        title: 'Export recording as M4A',
        defaultPath: `${baseName}.m4a`,
        filters: [{ name: 'M4A Audio', extensions: ['m4a'] }],
      };
      const mainWindow = ctx.getMainWindow();
      const saveResult = mainWindow
        ? await dialog.showSaveDialog(mainWindow, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);
      if (saveResult.canceled || !saveResult.filePath) {
        return { canceled: true };
      }
      const destPath = saveResult.filePath;
      // Write to a sibling temp file and atomically rename on success so a
      // failed encode never overwrites the user's picked path with a partial.
      const tmpPath = `${destPath}.partial`;

      try {
        // Force -f ipod (M4A muxer) because the `.partial` extension defeats
        // ffmpeg's format-by-extension detection otherwise.
        await execFileAsync(ffmpegPath, [
          '-y',
          '-loglevel',
          'error',
          '-i',
          resolvedSrc,
          '-vn',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-movflags',
          '+faststart',
          '-f',
          'ipod',
          tmpPath,
        ]);
        await fs.promises.rename(tmpPath, destPath);
      } catch (encodeError) {
        await fs.promises.unlink(tmpPath).catch(() => {});
        throw encodeError;
      }

      return { success: true, path: destPath };
    } catch (error) {
      console.error('Error exporting M4A:', error);
      // execFileAsync rejections carry stderr on the error object — surface it
      // so renderer-side toasts aren't reduced to "Command failed".
      const stderr = (error as { stderr?: string } | null)?.stderr;
      const baseMessage = error instanceof Error ? error.message : String(error);
      const message = stderr ? `${baseMessage.split('\n')[0]} — ${stderr.trim()}` : baseMessage;
      return { success: false, error: message };
    }
  });

  // Merge multiple recordings: concat audio files, then run the standard
  // transcription pipeline on the merged file. Originals are left untouched.
  // Resolves source folder names from per-recording metadata so the merged note's
  // `mergedFrom` frontmatter (and "Sources" body section) can reference them.
  //
  // Single-flight: a second click while a merge is running returns
  // `{ code: 'merge-busy' }` rather than racing against the in-flight one for
  // the shared geminiService and the merged-output filename slot.
  ipcMain.handle('merge-recordings', async (_, opts: { paths: string[]; title?: string }) => {
    if (mergeInFlight) {
      return {
        success: false,
        code: 'merge-busy',
        error: 'Another merge is already running. Wait for it to finish.',
      };
    }
    mergeInFlight = true;
    const sendProgress = (percent: number, message: string) => {
      const mainWindow = ctx.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('transcription-progress', { percent, message });
      }
    };
    try {
      const inputPaths = Array.isArray(opts?.paths) ? opts.paths : [];
      if (inputPaths.length < 2) {
        return { success: false, error: 'At least 2 recordings are required to merge' };
      }

      // Ensure recordings dir exists before realpath so symlink resolution can't
      // throw on a fresh install. Containment: every input must then resolve
      // inside that directory.
      const recordingsDir = path.join(app.getPath('userData'), 'recordings');
      await fs.promises.mkdir(recordingsDir, { recursive: true });
      const resolvedRoot = await fs.promises.realpath(recordingsDir);
      const resolvedInputs: string[] = [];
      for (const p of inputPaths) {
        if (typeof p !== 'string' || !p) {
          return { success: false, error: 'Invalid input path' };
        }
        let resolved: string;
        try {
          resolved = await fs.promises.realpath(p);
        } catch {
          return { success: false, error: `Recording not found: ${path.basename(p)}` };
        }
        if (!resolved.startsWith(resolvedRoot + path.sep)) {
          return { success: false, error: 'Source path is outside the recordings directory' };
        }
        resolvedInputs.push(resolved);
      }

      const geminiService = ctx.ensureGeminiService();
      if (!geminiService) {
        return { success: false, error: ctx.formatAiCredentialsError() };
      }

      const ffmpegPath = await ctx.ffmpegManager.ensureFFmpeg();
      if (!ffmpegPath) {
        return {
          success: false,
          code: 'ffmpeg-missing',
          error: 'FFmpeg is required to merge recordings.',
        };
      }

      const rawTitle = opts.title?.trim() || 'Merged Meeting';
      const safeTitle = sanitizeForPath(rawTitle) || 'Merged Meeting';
      // Always emit webm/opus -- matches MediaRecorder native output and survives
      // the stream-copy fast path when all inputs are also webm. UUID suffix
      // avoids collisions when two merges with the same title start in the same
      // second (formatTimestamp is second-granularity).
      const mergedExt = extensionForMimeType('audio/webm');
      const mergedAudioPath = path.join(
        recordingsDir,
        `${safeTitle}_${formatTimestamp()}_${randomUUID().slice(0, 8)}.${mergedExt}`,
      );

      sendProgress(5, 'Merging audio files...');

      // Run the metadata lookup concurrently with the ffmpeg concat -- they're
      // independent and concat is the long pole, so the metadata reads are free.
      // Recordings without a transcription contribute nothing to mergedFrom; we
      // also drop entries whose transcription folder no longer exists on disk
      // so the merged note's Sources section never references stale ghosts.
      const [, metas] = await Promise.all([
        concatAudioFiles({ ffmpegPath, inputPaths: resolvedInputs, outputPath: mergedAudioPath }),
        Promise.all(resolvedInputs.map((p) => metadataService.getMetadata(p))),
      ]);
      const sourceFolders = metas
        .filter((m): m is NonNullable<typeof m> => !!m?.transcriptionPath)
        .filter((m) => fs.existsSync(m.transcriptionPath!))
        .map((m) => path.basename(m.transcriptionPath!));

      sendProgress(15, 'Transcribing merged recording...');

      // Compress the transcription progress into 15-95% to leave room for the
      // concat phase at the start and the save phase at the end.
      const progressCallback = (percent: number, message: string) => {
        sendProgress(15 + Math.round(percent * 0.8), message);
      };

      const summaryPrompt = ctx.configService.getSummaryPrompt();
      const result = await geminiService.transcribeAudio(
        mergedAudioPath,
        progressCallback,
        summaryPrompt,
      );

      // User-supplied title takes precedence; only fall back to Gemini's
      // suggestion when the user didn't provide one. Gemini almost always
      // returns a suggestedTitle, so the previous order silently overrode the
      // user's --title flag / dialog input.
      const finalTitle = opts.title?.trim() || result.suggestedTitle || rawTitle;
      let transcriptionPath: string;
      try {
        transcriptionPath = saveTranscription({
          title: finalTitle,
          result,
          audioFilePath: mergedAudioPath,
          dataPath: app.getPath('userData'),
          mergedFrom: sourceFolders,
        });
        ctx.maybeAutoSync();
      } catch (error) {
        console.error('Failed to save merged transcription files:', error);
        const message = error instanceof Error ? error.message : String(error);
        ctx.notificationService.notifyTranscriptionFailed(
          'Merge failed: could not save the transcription.',
        );
        return { success: false, error: `Failed to save merged transcription: ${message}` };
      }

      try {
        await metadataService.saveMetadata(mergedAudioPath, {
          title: finalTitle,
          suggestedTitle: result.suggestedTitle,
          transcriptionPath,
          customFields: result.customFields,
          transcribedAt: new Date().toISOString(),
        });
      } catch (error) {
        // Metadata write is best-effort -- the transcription folder is the
        // source of truth. Log and continue rather than fail the merge.
        console.error('Failed to save merged metadata:', error);
      }

      sendProgress(100, 'Merge complete');

      ctx.notificationService.notifyTranscriptionComplete(finalTitle);
      return {
        success: true,
        data: result,
        mergedAudioPath,
        transcriptionPath,
        mergedFrom: sourceFolders,
      };
    } catch (error) {
      console.error('Error merging recordings:', error);
      const stderr = (error as { stderr?: string } | null)?.stderr;
      const baseMessage = error instanceof Error ? error.message : String(error);
      const message = stderr ? `${baseMessage.split('\n')[0]} — ${stderr.trim()}` : baseMessage;
      ctx.notificationService.notifyTranscriptionFailed('Merge failed. Check the app for details.');
      return { success: false, error: message };
    } finally {
      mergeInFlight = false;
    }
  });
}
