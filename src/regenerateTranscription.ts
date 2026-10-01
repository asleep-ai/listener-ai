import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import type { TranscriptionResult } from './geminiService';
import { withMeetingLock } from './meetingLock';
import {
  ACTION_ITEMS_FILE,
  HIGHLIGHTS_JSON_FILE,
  KEY_POINTS_FILE,
  type LiveNote,
  META_JSON,
  META_SCHEMA_VERSION,
  type MeetingMetaV2,
  NOTES_JSON_FILE,
  SUMMARY_FILE,
  type SaveTranscriptionOptions,
  TRANSCRIPT_FILE,
  formatBullets,
  getTranscriptionsDir,
  readTranscription,
  saveTranscription,
} from './outputService';
import {
  type TranscriptCutoff,
  createTranscriptCutoff,
  fingerprintTranscript,
  splitNotesAtCutoff,
  splitTranscriptAtCutoff,
} from './transcriptCutoff';
import type { LostSegment } from './transcriptQuality';

// Content files swapped by a regenerate, in `writeV2Files` order. meta.json is
// handled separately and always swapped LAST so a folder only reports the new
// note once every content file has landed.
const NOTE_CONTENT_FILES = [
  SUMMARY_FILE,
  KEY_POINTS_FILE,
  ACTION_ITEMS_FILE,
  TRANSCRIPT_FILE,
  NOTES_JSON_FILE,
  HIGHLIGHTS_JSON_FILE,
];
const NOTE_FILES = [...NOTE_CONTENT_FILES, META_JSON];
// A fresh transcription owns these fields. Other keys may come from a newer
// schema or integration and must survive a regenerate of an older client.
// `exports` is intentionally reset: it describes delivery of the old content.
const TRANSCRIPTION_META_KEYS = new Set([
  'schemaVersion',
  'title',
  'suggestedTitle',
  'emoji',
  'transcribedAt',
  'generationId',
  'audioFile',
  'cost',
  'customFields',
  'summarySections',
  'actionItemGroups',
  'merge',
  'exports',
  // The offset points into the previous transcript text, which a fresh
  // transcription replaces.
  'transcriptCutoff',
]);

// Scratch folders live directly under dataPath (same filesystem as
// transcriptions/, so renames are atomic) and outside anything that lists or
// syncs notes.
const SCRATCH_PREFIX = '.regenerate-';
const SWAP_MARKER = 'swap.json';
// Staging + swap take milliseconds (the transcription itself runs before the
// scratch folder exists), so an older scratch folder is a leftover even if its
// recorded pid now belongs to an unrelated live process.
const LIVE_SCRATCH_MAX_AGE_MS = 10 * 60 * 1000;

interface SwapMarker {
  pid: number;
  /** Set once the backup is complete, right before the first rename. */
  target?: string;
  /** Staged note folder, relative to the scratch folder. */
  staged?: string;
}

export interface RegenerateTranscriptionOptions extends Omit<
  SaveTranscriptionOptions,
  'outputDir' | 'mergedFrom'
> {
  /** Note folder currently linked to the recording (sidecar `transcriptionPath`). */
  previousFolderPath?: string;
  /** Test hook: called after each file lands in the target folder. */
  onFileSwapped?: (filename: string) => void;
}

/**
 * Save a re-transcription of a recording, replacing the note it is already
 * linked to instead of leaving that note behind as a stale copy.
 *
 * The new note is fully written to a scratch folder under `dataPath` first,
 * so a failed transcription or write never touches the previous note. The
 * files are then renamed into the existing folder one by one (meta.json
 * last), keeping the folder name stable: Drive sync keys meetings on folder
 * name, so this syncs as an update rather than delete + re-upload, and merged
 * notes that reference this folder in `merge.sourceIds` stay valid. If a
 * rename fails, the previous files are restored from a backup taken before
 * the swap; if the process dies mid-swap, `recoverInterruptedRegenerations`
 * restores them on the next app start.
 *
 * Falls back to a plain `saveTranscription` (new folder) when there is no
 * replaceable previous note: missing, not a current-schema v2 folder, or not
 * a direct child of this data path's transcriptions directory. The fallback
 * never modifies the previous path.
 */
export function saveRegeneratedTranscription(opts: RegenerateTranscriptionOptions): string {
  const { previousFolderPath, onFileSwapped, ...saveOpts } = opts;
  const target = resolveReplaceableFolder(saveOpts.dataPath, previousFolderPath);
  // A stale sidecar must not let this recording overwrite another recording's
  // note. Older notes without audioFile keep the existing replacement path.
  if (
    !target ||
    (target.meta.audioFile &&
      saveOpts.audioFilePath &&
      path.resolve(target.meta.audioFile) !== path.resolve(saveOpts.audioFilePath))
  ) {
    return saveTranscription(saveOpts);
  }

  const scratch = fs.mkdtempSync(path.join(saveOpts.dataPath, SCRATCH_PREFIX));
  const markerPath = path.join(scratch, SWAP_MARKER);
  writeMarker(markerPath, { pid: process.pid });
  let keepScratch = false;
  try {
    const staged = saveTranscription({
      ...saveOpts,
      outputDir: path.join(scratch, 'new'),
      // Regenerating re-transcribes the same audio, so a merged note stays merged.
      mergedFrom: target.meta.merge?.sourceIds,
    });

    const stagedMetaPath = path.join(staged, META_JSON);
    const stagedMeta = JSON.parse(fs.readFileSync(stagedMetaPath, 'utf-8')) as MeetingMetaV2;
    const unknownMeta = Object.fromEntries(
      Object.entries(target.meta).filter(([key]) => !TRANSCRIPTION_META_KEYS.has(key)),
    );
    fs.writeFileSync(
      stagedMetaPath,
      `${JSON.stringify({ ...unknownMeta, ...stagedMeta }, null, 2)}\n`,
      'utf-8',
    );

    // Truncate instead of deleting files the new result no longer produces:
    // the sync engine downloads a file that is missing locally but still on
    // Drive, which would bring the old content back. Readers treat an empty
    // file the same as an absent one.
    for (const name of NOTE_CONTENT_FILES) {
      if (
        fs.existsSync(path.join(target.folderPath, name)) &&
        !fs.existsSync(path.join(staged, name))
      ) {
        fs.writeFileSync(path.join(staged, name), '', 'utf-8');
      }
    }

    swapStagedFiles(scratch, markerPath, staged, target.folderPath, {
      onFileSwapped,
      onRestoreFailed: () => {
        keepScratch = true;
      },
    });
    return target.folderPath;
  } finally {
    if (!keepScratch) fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Back up the target's note files, then rename each staged file into it
 * (meta.json last). A failed rename restores the backup and rethrows; the
 * marker lets `recoverInterruptedRegenerations` do the same after a crash.
 * `onRestoreFailed` fires when even the restore failed, so the caller keeps
 * the scratch folder holding the backup. Files absent from `staged` are left
 * untouched in the target.
 */
function swapStagedFiles(
  scratch: string,
  markerPath: string,
  staged: string,
  targetFolder: string,
  hooks: { onFileSwapped?: (filename: string) => void; onRestoreFailed: () => void },
): void {
  const backup = path.join(scratch, 'backup');
  fs.mkdirSync(backup);
  for (const name of NOTE_FILES) {
    const src = path.join(targetFolder, name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backup, name));
  }

  writeMarker(markerPath, {
    pid: process.pid,
    target: targetFolder,
    staged: path.relative(scratch, staged),
  });
  const swapped: string[] = [];
  try {
    for (const name of NOTE_FILES) {
      const src = path.join(staged, name);
      if (!fs.existsSync(src)) continue;
      fs.renameSync(src, path.join(targetFolder, name));
      swapped.push(name);
      hooks.onFileSwapped?.(name);
    }
  } catch (err) {
    try {
      restoreFromBackup(targetFolder, backup, swapped);
    } catch (restoreErr) {
      hooks.onRestoreFailed();
      console.error(
        `Failed to restore ${targetFolder} after a failed note update; previous files kept at ${backup}:`,
        restoreErr,
      );
    }
    throw err;
  }
}

export const NOTE_CHANGED_ERROR = 'This note changed. Reopen it and try again.';

export interface ApplyTranscriptCutoffOptions {
  dataPath: string;
  folderPath: string;
  /** Generation the caller showed the user; the change is refused if the note moved on. */
  expectedGenerationId: string | null;
  /** Offset into the stored transcript where the excluded tail begins; null restores the full transcript. */
  cutoffOffset: number | null;
  /**
   * Flagged notes kept outside the note folder (the recording's metadata
   * sidecar). Used only when the note itself stores none, so older recordings
   * keep their highlights through a cutoff change.
   */
  fallbackLiveNotes?: LiveNote[];
  /** Rebuild the report from transcript text alone. Never re-transcribes audio. */
  summarize: (
    transcript: string,
    context: { liveNotes?: LiveNote[]; lostSegments: LostSegment[] },
  ) => Promise<TranscriptionResult>;
  now?: Date;
  /** Test hook: called after each file lands in the note folder. */
  onFileSwapped?: (filename: string) => void;
}

export interface ApplyTranscriptCutoffResult {
  generationId: string;
  transcriptCutoff?: TranscriptCutoff;
  /** Flagged notes the cutoff left out of the report (see `splitNotesAtCutoff`). */
  excludedNotes: number;
}

/**
 * Set, move or remove a saved note's transcript tail cutoff, and regenerate
 * the report (summary, key points, action items, highlights and custom
 * fields) from the included text. transcript.md, notes.json and the audio are
 * left untouched, so the cutoff can always be moved or removed later.
 *
 * The note gets a new `generationId`, so an upload or send prepared from the
 * previous report is refused. A Notion page uploaded before the change is not
 * modified; it moves to `exports.notionSuperseded` so the app can say the
 * page shows the older report, and the next upload creates a new page.
 * Internal transcript-quality diagnostics describe the transcription, not
 * the report, and are kept as they were.
 *
 * Flagged notes are timed while the cutoff is a text position, so with a
 * cutoff only notes the transcript's segment headers prove to precede it
 * feed the summary and highlights (`splitNotesAtCutoff`); the rest, and every
 * note when there are no headers, are left out rather than placed by guess.
 * The stored notes are untouched and return when the cutoff is removed. A
 * note that stores no notes at all keeps its existing highlights file: there
 * is nothing to rebuild it from, and no evidence to discard it on.
 */
export async function applyTranscriptCutoff(
  opts: ApplyTranscriptCutoffOptions,
): Promise<ApplyTranscriptCutoffResult> {
  if (!resolveReplaceableFolder(opts.dataPath, opts.folderPath)) {
    throw new Error('This note cannot be changed.');
  }
  const note = await readTranscription(opts.folderPath);
  if (!note) throw new Error('This note could not be read.');
  if ((note.generationId ?? null) !== opts.expectedGenerationId) {
    throw new Error(NOTE_CHANGED_ERROR);
  }

  const now = opts.now ?? new Date();
  const cutoff =
    opts.cutoffOffset === null
      ? undefined
      : createTranscriptCutoff(note.transcript, opts.cutoffOffset, now);
  const quality = note.customFields?.transcriptQuality;
  const sourceNotes = note.liveNotes ?? opts.fallbackLiveNotes;
  const notes = splitNotesAtCutoff(note.transcript, cutoff?.offset ?? null, sourceNotes ?? []);
  // Lost segments are numbered like the headers, so with header evidence the
  // coverage notice can skip segments that lie wholly in the excluded tail.
  const lostSegments = parseLostSegments(quality).filter(
    (lost) => !notes.cutoffSegment || lost.segment <= notes.cutoffSegment.segment,
  );
  const result = await opts.summarize(splitTranscriptAtCutoff(note.transcript, cutoff).included, {
    liveNotes: sourceNotes ? notes.included : undefined,
    lostSegments,
  });

  return withMeetingLock(opts.folderPath, () => {
    // The report took a while; the note may have been regenerated, synced or
    // deleted meanwhile. Only write over the exact content it was built from.
    const target = resolveReplaceableFolder(opts.dataPath, opts.folderPath);
    if (!target || (target.meta.generationId ?? null) !== opts.expectedGenerationId) {
      throw new Error(NOTE_CHANGED_ERROR);
    }
    const transcriptPath = path.join(target.folderPath, TRANSCRIPT_FILE);
    const transcript = fs.existsSync(transcriptPath)
      ? fs.readFileSync(transcriptPath, 'utf-8').trim()
      : '';
    if (fingerprintTranscript(transcript) !== fingerprintTranscript(note.transcript)) {
      throw new Error(NOTE_CHANGED_ERROR);
    }

    const customFields: Record<string, unknown> = { ...result.customFields };
    delete customFields.transcriptQuality;
    if (quality !== undefined) customFields.transcriptQuality = quality;

    const meta: MeetingMetaV2 = { ...target.meta, generationId: randomUUID() };
    const suggestedTitle = result.suggestedTitle?.trim();
    if (suggestedTitle) {
      // Follow the new report only when the previous title was itself the AI
      // suggestion. Preserve titles that the user chose or changed.
      if (meta.title === meta.suggestedTitle) meta.title = suggestedTitle;
      meta.suggestedTitle = suggestedTitle;
    }
    setOrDelete(meta, 'emoji', result.emoji || undefined);
    setOrDelete(
      meta,
      'summarySections',
      result.summarySections?.length ? result.summarySections : undefined,
    );
    setOrDelete(
      meta,
      'actionItemGroups',
      result.actionItemGroups?.length ? result.actionItemGroups : undefined,
    );
    // Stored even when empty: the regenerated report owns its custom fields,
    // and an explicit `{}` keeps readers from falling back to the recording
    // sidecar, which still holds the fields of an older report.
    meta.customFields = customFields;
    setOrDelete(meta, 'transcriptCutoff', cutoff);
    if (meta.exports?.notion) {
      const { notion, ...rest } = meta.exports;
      meta.exports = {
        ...rest,
        notionSuperseded: { pageUrl: notion.pageUrl, supersededAt: now.toISOString() },
      };
    }

    const highlights = result.highlights?.length ? result.highlights : undefined;
    const files: Record<string, string | null> = {
      [SUMMARY_FILE]: result.summary ? `${result.summary.trim()}\n` : '',
      [KEY_POINTS_FILE]: result.keyPoints?.length ? formatBullets(result.keyPoints) : null,
      [ACTION_ITEMS_FILE]: result.actionItems?.length ? formatBullets(result.actionItems) : null,
      // Without source notes the highlights cannot be rebuilt; a file absent
      // from `files` is left as it is in the note folder.
      ...(sourceNotes
        ? { [HIGHLIGHTS_JSON_FILE]: highlights ? `${JSON.stringify(highlights, null, 2)}\n` : null }
        : {}),
      [META_JSON]: `${JSON.stringify(meta, null, 2)}\n`,
    };

    const scratch = fs.mkdtempSync(path.join(opts.dataPath, SCRATCH_PREFIX));
    const markerPath = path.join(scratch, SWAP_MARKER);
    writeMarker(markerPath, { pid: process.pid });
    let keepScratch = false;
    try {
      const staged = path.join(scratch, 'new');
      fs.mkdirSync(staged);
      for (const [name, content] of Object.entries(files)) {
        // Truncate, never delete, a file the new report no longer produces:
        // Drive sync would otherwise download the old copy back.
        if (content !== null) {
          fs.writeFileSync(path.join(staged, name), content, 'utf-8');
        } else if (fs.existsSync(path.join(target.folderPath, name))) {
          fs.writeFileSync(path.join(staged, name), '', 'utf-8');
        }
      }
      swapStagedFiles(scratch, markerPath, staged, target.folderPath, {
        onFileSwapped: opts.onFileSwapped,
        onRestoreFailed: () => {
          keepScratch = true;
        },
      });
    } finally {
      if (!keepScratch) fs.rmSync(scratch, { recursive: true, force: true });
    }
    return {
      generationId: meta.generationId as string,
      ...(cutoff ? { transcriptCutoff: cutoff } : {}),
      excludedNotes: notes.excluded.length,
    };
  });
}

function setOrDelete<K extends keyof MeetingMetaV2>(
  meta: MeetingMetaV2,
  key: K,
  value: MeetingMetaV2[K] | undefined,
): void {
  if (value === undefined) delete meta[key];
  else meta[key] = value;
}

/** Lost-segment records persisted under customFields.transcriptQuality, if well-formed. */
function parseLostSegments(quality: unknown): LostSegment[] {
  const raw = (quality as { lostSegments?: unknown } | undefined)?.lostSegments;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is LostSegment =>
      !!item &&
      typeof item === 'object' &&
      Number.isFinite((item as LostSegment).segment) &&
      Number.isFinite((item as LostSegment).start) &&
      Number.isFinite((item as LostSegment).end),
  );
}

/**
 * Startup recovery for regenerates that died mid-swap (crash, force quit,
 * power loss). A scratch folder whose swap never reached meta.json has its
 * target restored from the backup, so the previous note comes back whole
 * rather than as a mix of old and new files. Scratch folders from finished
 * or never-started swaps are just removed. Folders owned by another live
 * process are skipped. Returns the note folders that were restored.
 */
export async function recoverInterruptedRegenerations(
  dataPath: string,
  options: { strict?: boolean } = {},
): Promise<string[]> {
  let entries: string[];
  try {
    entries = fs.readdirSync(dataPath).filter((name) => name.startsWith(SCRATCH_PREFIX));
  } catch {
    return [];
  }

  const restored: string[] = [];
  for (const entry of entries) {
    const scratch = path.join(dataPath, entry);
    try {
      const markerPath = path.join(scratch, SWAP_MARKER);
      const marker = readMarker(markerPath);
      // The prefix alone does not prove this directory belongs to us. Keep
      // unknown user data, including a scratch folder whose marker was never
      // completed before a crash.
      if (!marker) continue;
      if (
        marker.pid !== process.pid &&
        isProcessAlive(marker.pid) &&
        Date.now() - fs.statSync(markerPath).mtimeMs < LIVE_SCRATCH_MAX_AGE_MS
      ) {
        if (options.strict) {
          throw new Error(`Meeting regeneration is in progress at ${scratch}`);
        }
        continue;
      }

      if (marker.target) {
        const staged = marker.staged ? path.join(scratch, marker.staged) : undefined;
        if (!staged?.startsWith(scratch + path.sep)) {
          throw new Error('Invalid regeneration staging path');
        }
        if (!resolveReplaceableFolder(dataPath, marker.target)) {
          throw new Error(`Cannot verify regeneration target ${marker.target}`);
        }
        await withMeetingLock(marker.target, () => {
          // Another startup may have recovered and removed this scratch folder
          // while we waited for the same target lock.
          if (!fs.existsSync(scratch)) return;
          if (!resolveReplaceableFolder(dataPath, marker.target!)) {
            throw new Error(`Cannot verify regeneration target ${marker.target}`);
          }
          if (fs.existsSync(path.join(staged, META_JSON))) {
            restoreFromBackup(marker.target!, path.join(scratch, 'backup'), NOTE_FILES);
            restored.push(marker.target!);
          }
          fs.rmSync(scratch, { recursive: true, force: true });
        });
        continue;
      }
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch (err) {
      console.warn(`Failed to recover interrupted regenerate at ${scratch}:`, err);
      if (options.strict) throw err;
    }
  }
  return restored;
}

/** Put `names` in `folderPath` back to their backed-up state: restore files
 * that existed before the swap and remove ones that did not. */
function restoreFromBackup(folderPath: string, backup: string, names: string[]): void {
  if (!fs.existsSync(path.join(backup, META_JSON))) {
    throw new Error(`Regeneration backup is missing meta.json: ${backup}`);
  }
  for (const name of names) {
    const saved = path.join(backup, name);
    const dest = path.join(folderPath, name);
    if (fs.existsSync(saved)) fs.copyFileSync(saved, dest);
    else fs.rmSync(dest, { force: true });
  }
}

function resolveReplaceableFolder(
  dataPath: string,
  folderPath: string | undefined,
): { folderPath: string; meta: MeetingMetaV2 } | null {
  if (!folderPath) return null;
  const resolved = path.resolve(folderPath);
  try {
    // A symlinked entry could route the renames to another note or outside
    // transcriptions/; only replace a real directory there.
    if (fs.lstatSync(resolved).isSymbolicLink()) return null;
    const real = fs.realpathSync(resolved);
    if (path.dirname(real) !== fs.realpathSync(getTranscriptionsDir(dataPath))) return null;
    const meta = JSON.parse(fs.readFileSync(path.join(real, META_JSON), 'utf-8'));
    if (!meta || meta.schemaVersion !== META_SCHEMA_VERSION) return null;
    return { folderPath: resolved, meta: meta as MeetingMetaV2 };
  } catch {
    return null;
  }
}

function writeMarker(markerPath: string, marker: SwapMarker): void {
  const tmp = `${markerPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(marker), 'utf-8');
  fs.renameSync(tmp, markerPath);
}

function readMarker(markerPath: string): SwapMarker | null {
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
    return marker && typeof marker.pid === 'number' ? (marker as SwapMarker) : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
