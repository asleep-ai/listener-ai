import * as fs from 'fs';
import * as path from 'path';
import type { HighlightEntry, TranscriptionResult } from './geminiService';
import type { CostSnapshot } from './services/usageTracker';

/** One timestamped note captured while recording. Empty `text` = bare flag. */
export interface LiveNote {
  offsetMs: number;
  text: string;
}

/**
 * Format a millisecond offset as `mm:ss` (or `hh:mm:ss` when the offset crosses
 * one hour) — used by every Highlights-rendering sink (summary.md, Notion,
 * modal, CLI) and by the Gemini prompt so the LLM sees the same coordinate
 * system as the saved output.
 */
export function formatOffsetTimestamp(offsetMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(offsetMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0
    ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

export function sanitizeForPath(name: string): string {
  return name
    .replace(/[\/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatTimestamp(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `${y}${m}${d}_${h}${min}${s}`;
}

// ---------- v2 storage layout ----------
//
// v2 folder layout (one file per semantic field, no frontmatter, no duplication):
//   <ts24>_<title>/
//     meta.json           structured metadata (always present)
//     summary.md          plain summary text (no headings, no frontmatter)
//     key-points.md       bullet list (`- item` per line)
//     action-items.md     bullet list
//     transcript.md       plain transcript text (no `# title` heading)
//     notes.json          live notes (optional)
//     highlights.json     AI-enriched highlights (optional)
//     <audio file>        original recording (optional, path stored in meta)
//
// v1 (legacy) layout is one summary.md with YAML frontmatter + rendered body
// plus a transcript.md. v1 folders are detected by absence of meta.json and
// are read/updated through the original code paths.

export const META_JSON = 'meta.json';
export const SUMMARY_FILE = 'summary.md';
export const KEY_POINTS_FILE = 'key-points.md';
export const ACTION_ITEMS_FILE = 'action-items.md';
export const TRANSCRIPT_FILE = 'transcript.md';
export const NOTES_JSON_FILE = 'notes.json';
export const HIGHLIGHTS_JSON_FILE = 'highlights.json';

export const META_SCHEMA_VERSION = 1;

/** Prefix used for the per-startup v1->v2 migration backup directory.
 * Lives at the data-path root (not under transcriptions/) so Drive sync
 * never sees it. Garbage-collected by `gcLegacyBackups`. */
export const V1_BACKUP_DIR_PREFIX = '.v1-backup-';

/** Suffix used for in-folder v1 snapshots during migration. The v1
 * summary.md / transcript.md are renamed to `<file>.v1-bak` so the
 * destructive v2 writes can't lose data on crash; the originals are
 * restored by `restoreV1BakIfPresent` if a retry finds them lingering. */
const V1_BAK_SUFFIX = '.v1-bak';

/** Files that `migrateV1ToV2` destructively overwrites; the per-folder
 * crash-recovery + backup logic both iterate this list. */
const V1_BAK_FILES = [SUMMARY_FILE, TRANSCRIPT_FILE] as const;

/** Persisted shape of meta.json. Unknown keys are preserved on read/write. */
export interface MeetingMetaV2 {
  schemaVersion: number;
  title: string;
  suggestedTitle?: string;
  emoji?: string;
  transcribedAt: string; // canonical ISO 8601 UTC, e.g. 2026-05-20T10:30:15.123Z
  audioFile?: string; // absolute path (kept compatible with v1.audioFilePath)
  cost?: CostSnapshot;
  customFields?: Record<string, unknown>;
  merge?: { sourceIds: string[] };
  exports?: {
    notion?: { pageUrl: string; uploadedAt?: string };
    slack?: { sentAt?: string; error?: string | null };
  };
  // Forward-compat: writers preserve unknown keys.
  [unknownKey: string]: unknown;
}

/**
 * Format the current time as a 24-character filesystem-safe ISO 8601 UTC stamp.
 * Layout: YYYY-MM-DDTHH-MM-SS.mmmZ -- the `:` separators are replaced with `-`
 * so the string is usable as a folder-name component on macOS/Windows/Linux.
 * The total length is always 24 chars, which is exploited by `splitV2FolderName`.
 */
export function formatV2Timestamp(date: Date = new Date()): string {
  // Date#toISOString -> 2026-05-20T10:30:15.123Z. Replace `:` (forbidden on
  // Windows, awkward on macOS APFS exports) with `-`.
  return date.toISOString().replace(/:/g, '-');
}

/** Sanitize a user-supplied title for use inside a folder-name component. */
export function sanitizeV2Title(raw: string): string {
  let s = raw.normalize('NFC');
  // Filesystem-forbidden characters
  s = s.replace(/[\/\\:*?"<>|]/g, '_');
  // NUL byte handled via string split to dodge oxlint no-control-regex
  s = s.split('\u0000').join('_');
  // Collapse all whitespace runs to single underscore
  s = s.replace(/\s+/g, '_');
  // Collapse runs of underscores produced by adjacent replacements into one
  s = s.replace(/_+/g, '_');
  // Strip leading/trailing dots (Windows quirk) and underscores
  s = s.replace(/^[._]+/, '').replace(/[._]+$/, '');
  // Hard cap to keep the full folder name under platform limits
  if (s.length > 100) s = s.slice(0, 100).replace(/_+$/, '');
  // Last-ditch fallback so the folder name is never just the timestamp
  return s.length > 0 ? s : 'meeting';
}

/**
 * Split a v2 folder name into its timestamp prefix and title suffix. Returns
 * null when the name doesn't follow the v2 convention (e.g. a legacy folder).
 */
export function splitV2FolderName(name: string): { ts: string; title: string } | null {
  if (name.length < 26) return null; // 24 ts + '_' + at least 1 title char
  if (name[24] !== '_') return null;
  const ts = name.slice(0, 24);
  // Cheap structural check: 4 digits, -, 2 digits, -, 2 digits, T, 2 digits, -, 2 digits, -, 2 digits, ., 3 digits, Z
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/.test(ts)) return null;
  return { ts, title: name.slice(25) };
}

/** Convert the FS-safe 24-char timestamp back into a canonical ISO 8601 string. */
export function v2TimestampToIso(ts: string): string {
  // YYYY-MM-DDTHH-MM-SS.mmmZ -> YYYY-MM-DDTHH:MM:SS.mmmZ.
  // We only rewrite the `-` separators inside the time portion (after position 10),
  // never the ones inside the date portion.
  return `${ts.slice(0, 10)}T${ts.slice(11, 13)}:${ts.slice(14, 16)}:${ts.slice(17)}`;
}

/** Detect whether a folder uses the v2 layout (meta.json present). */
export function isV2Folder(folderPath: string): boolean {
  try {
    return fs.statSync(path.join(folderPath, META_JSON)).isFile();
  } catch {
    return false;
  }
}

/** Collapse all whitespace (incl. newlines) so a bullet survives `- item`
 * round-trip; an embedded newline would otherwise split into two bullets. */
function normalizeBulletItem(item: string): string {
  return item.replace(/\s+/g, ' ').trim();
}

/** Parse a `- item` markdown bullet list back into a string array. */
export function parseBullets(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())
    .filter((l) => l.length > 0);
}

/** Render an array of bullets back into markdown. */
function formatBullets(items: string[]): string {
  return items.map((item) => `- ${normalizeBulletItem(item)}`).join('\n') + '\n';
}

/** Convert camelCase key to a display label: "keyDecisions" -> "Key Decisions" */
export function camelToLabel(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (s: string) => s.toUpperCase())
    .trim();
}

/** Subset of TranscriptionResult / ReadTranscriptionResult that formatSummary
 * actually consumes -- intentionally loose so both shapes (writer-side
 * TranscriptionResult and reader-side ReadTranscriptionResult) satisfy it. */
export type FormatSummaryInput = {
  summary?: string;
  keyPoints?: string[];
  actionItems?: string[];
  customFields?: Record<string, unknown>;
};

export function formatSummary(
  result: FormatSummaryInput,
  title: string,
  mergedFrom?: string[],
  liveNotes?: LiveNote[],
  highlights?: HighlightEntry[],
): string {
  const lines: string[] = [];
  lines.push(`# ${title}\n`);

  if (mergedFrom?.length) {
    lines.push('## Sources\n');
    lines.push(
      `Merged from ${mergedFrom.length} recording${mergedFrom.length === 1 ? '' : 's'}:\n`,
    );
    for (const src of mergedFrom) {
      lines.push(`- ${src}`);
    }
    lines.push('');
  }

  if (result.summary) {
    lines.push('## Summary\n');
    lines.push(`${result.summary}\n`);
  }

  if (result.keyPoints?.length) {
    lines.push('## Key Points\n');
    for (const point of result.keyPoints) {
      lines.push(`- ${point}`);
    }
    lines.push('');
  }

  if (result.actionItems?.length) {
    lines.push('## Action Items\n');
    for (const item of result.actionItems) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  // Prefer the AI-enriched "highlights" view when present -- it carries the
  // same user notes plus per-moment subtitle/bullets. Fall back to the bare
  // bullet list of liveNotes when Gemini didn't produce highlights.
  const enriched = highlights && highlights.length > 0 ? highlights : null;
  if (enriched || liveNotes?.length) {
    lines.push('## 🗒️ Highlights\n');
    if (enriched) {
      for (const h of enriched) {
        const ts = formatOffsetTimestamp(h.offsetMs);
        const title = (h.userText ?? '').trim();
        lines.push(title ? `### [${ts}] ${title}` : `### [${ts}] 🏴`);
        if (h.subtitle?.trim()) {
          lines.push(`*${h.subtitle.trim()}*`);
        }
        if (h.bullets?.length) {
          lines.push('');
          for (const b of h.bullets) lines.push(`- ${b}`);
        }
        lines.push('');
      }
    } else {
      for (const note of liveNotes!) {
        const ts = formatOffsetTimestamp(note.offsetMs);
        const text = note.text?.trim();
        lines.push(text ? `- [${ts}] ${text}` : `- [${ts}] 🏴`);
      }
      lines.push('');
    }
  }

  if (result.customFields) {
    for (const [key, value] of Object.entries(result.customFields)) {
      const label = camelToLabel(key);
      lines.push(`## ${label}\n`);
      if (Array.isArray(value)) {
        for (const item of value) {
          lines.push(`- ${String(item)}`);
        }
      } else if (typeof value === 'string') {
        lines.push(value);
      } else {
        lines.push(JSON.stringify(value, null, 2));
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

export function formatTranscript(result: TranscriptionResult, title: string): string {
  const lines: string[] = [];
  lines.push(`# ${title}\n`);
  lines.push(`${result.transcript}\n`);
  return lines.join('\n');
}

interface SummaryFrontmatter {
  title: string;
  suggestedTitle?: string;
  summary: string;
  transcript: string;
  keyPoints?: string[];
  actionItems?: string[];
  customFields?: Record<string, unknown>;
  audioFilePath?: string;
  transcribedAt: string;
  emoji?: string;
  mergedFrom?: string[];
  liveNotes?: LiveNote[];
  highlights?: HighlightEntry[];
  notionPageUrl?: string;
  slackSentAt?: string;
  slackError?: string;
  cost?: CostSnapshot;
}

function buildFrontmatter(meta: SummaryFrontmatter): string {
  const lines: string[] = ['---'];
  lines.push(`title: ${yamlQuote(meta.title)}`);
  lines.push(`transcribedAt: ${yamlQuote(meta.transcribedAt)}`);
  if (meta.suggestedTitle) {
    lines.push(`suggestedTitle: ${yamlQuote(meta.suggestedTitle)}`);
  }
  lines.push(`summary: ${yamlQuote(meta.summary)}`);
  lines.push(`transcript: ${yamlQuote(meta.transcript)}`);
  if (meta.keyPoints?.length) {
    lines.push('keyPoints:');
    for (const p of meta.keyPoints) lines.push(`  - ${yamlQuote(p)}`);
  }
  if (meta.actionItems?.length) {
    lines.push('actionItems:');
    for (const a of meta.actionItems) lines.push(`  - ${yamlQuote(a)}`);
  }
  if (meta.customFields && Object.keys(meta.customFields).length > 0) {
    lines.push(`customFields: ${yamlQuote(JSON.stringify(meta.customFields))}`);
  }
  if (meta.audioFilePath) {
    lines.push(`audioFilePath: ${yamlQuote(meta.audioFilePath)}`);
  }
  if (meta.emoji) {
    lines.push(`emoji: ${yamlQuote(meta.emoji)}`);
  }
  if (meta.mergedFrom?.length) {
    lines.push('mergedFrom:');
    for (const src of meta.mergedFrom) lines.push(`  - ${yamlQuote(src)}`);
  }
  if (meta.liveNotes?.length) {
    lines.push(`liveNotes: ${yamlQuote(JSON.stringify(meta.liveNotes))}`);
  }
  if (meta.highlights?.length) {
    lines.push(`highlights: ${yamlQuote(JSON.stringify(meta.highlights))}`);
  }
  if (meta.notionPageUrl) {
    lines.push(`notionPageUrl: ${yamlQuote(meta.notionPageUrl)}`);
  }
  if (meta.slackSentAt) {
    lines.push(`slackSentAt: ${yamlQuote(meta.slackSentAt)}`);
  }
  if (meta.slackError) {
    lines.push(`slackError: ${yamlQuote(meta.slackError)}`);
  }
  if (meta.cost && meta.cost.breakdown.length > 0) {
    lines.push(`cost: ${yamlQuote(JSON.stringify(meta.cost))}`);
  }
  lines.push('---');
  return lines.join('\n');
}

/** Minimal YAML quoting: wrap in double quotes if value contains special chars */
function yamlQuote(value: string): string {
  if (/[:#\[\]{}&*!|>'"%@`,\n\r]/.test(value) || value.startsWith('-') || value.startsWith(' ')) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
  }
  return value;
}

export function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  // Normalize line endings
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { meta: {}, body: normalized };
  }
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) {
    return { meta: {}, body: normalized };
  }
  const yamlBlock = normalized.slice(4, end);
  const body = normalized.slice(end + 4).trimStart();

  const meta: Record<string, unknown> = {};
  let currentArrayKey: string | null = null;
  let currentArray: string[] = [];

  for (const line of yamlBlock.split('\n')) {
    const arrayItem = line.match(/^ {2}- (.+)$/);
    if (arrayItem && currentArrayKey) {
      currentArray.push(yamlUnquote(arrayItem[1]));
      continue;
    }

    // Flush previous array
    if (currentArrayKey) {
      meta[currentArrayKey] = currentArray;
      currentArrayKey = null;
      currentArray = [];
    }

    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    if (rawValue === '') {
      // Next lines will be array items
      currentArrayKey = key;
      currentArray = [];
    } else {
      meta[key] = yamlUnquote(rawValue);
    }
  }

  // Flush trailing array
  if (currentArrayKey) {
    meta[currentArrayKey] = currentArray;
  }

  return { meta, body };
}

export function parseLiveNotesField(raw: unknown): LiveNote[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return undefined;
    const notes: LiveNote[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const offsetMs = Number((item as { offsetMs?: unknown }).offsetMs);
      const text = (item as { text?: unknown }).text;
      if (!Number.isFinite(offsetMs)) continue;
      notes.push({
        offsetMs: Math.max(0, Math.floor(offsetMs)),
        text: typeof text === 'string' ? text : '',
      });
    }
    return notes.length > 0 ? notes : undefined;
  } catch (e) {
    console.warn('Failed to parse liveNotes from frontmatter:', e);
    return undefined;
  }
}

export function parseHighlightsField(raw: unknown): HighlightEntry[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return undefined;
    const entries: HighlightEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const offsetMs = Number((item as { offsetMs?: unknown }).offsetMs);
      if (!Number.isFinite(offsetMs)) continue;
      const userText = (item as { userText?: unknown }).userText;
      const subtitle = (item as { subtitle?: unknown }).subtitle;
      const bullets = (item as { bullets?: unknown }).bullets;
      entries.push({
        offsetMs: Math.max(0, Math.floor(offsetMs)),
        userText: typeof userText === 'string' ? userText : '',
        subtitle: typeof subtitle === 'string' && subtitle.trim().length > 0 ? subtitle : undefined,
        bullets: Array.isArray(bullets)
          ? bullets.map((b) => (typeof b === 'string' ? b : '')).filter((b) => b.length > 0)
          : undefined,
      });
    }
    return entries.length > 0 ? entries : undefined;
  } catch (e) {
    console.warn('Failed to parse highlights from frontmatter:', e);
    return undefined;
  }
}

function yamlUnquote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  return value;
}

export function getTranscriptionsDir(dataPath: string): string {
  return path.join(dataPath, 'transcriptions');
}

export interface SaveTranscriptionOptions {
  title: string;
  result: TranscriptionResult;
  audioFilePath?: string;
  outputDir?: string; // override parent dir (for CLI --output)
  dataPath: string; // app data path (default location)
  mergedFrom?: string[]; // source folder names when this note was created by merging others
  liveNotes?: LiveNote[]; // timestamped notes captured during recording
  now?: Date; // test hook for deterministic v2 folder timestamps
}

function getResultHighlights(result: TranscriptionResult): HighlightEntry[] | undefined {
  return result.highlights && result.highlights.length > 0 ? result.highlights : undefined;
}

/**
 * Save a transcription using the v2 folder layout. Returns the created folder path.
 *
 * New writes always use v2. Existing v1 folders on disk continue to be read via
 * the dispatch in `readTranscription` and updated via `updateTranscriptionStatus`.
 */
export function saveTranscription(opts: SaveTranscriptionOptions): string {
  const parentDir = opts.outputDir ?? getTranscriptionsDir(opts.dataPath);
  const now = opts.now ?? new Date();
  const ts = formatV2Timestamp(now);
  const titleSlug = sanitizeV2Title(opts.title);

  fs.mkdirSync(parentDir, { recursive: true });

  // Bump the timestamp ms when two saves race within the same millisecond.
  // mkdir is the atomic claim; existsSync would TOCTOU.
  const tsBase = now.getTime();
  let usedTs = ts;
  let folderPath = path.join(parentDir, `${usedTs}_${titleSlug}`);
  for (let attempt = 0; ; attempt++) {
    try {
      fs.mkdirSync(folderPath);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (attempt >= 1000) {
        throw new Error('saveTranscription: could not find a free folder name after 1000 attempts');
      }
      usedTs = formatV2Timestamp(new Date(tsBase + attempt + 1));
      folderPath = path.join(parentDir, `${usedTs}_${titleSlug}`);
    }
  }

  writeV2Files(folderPath, {
    transcribedAt: v2TimestampToIso(usedTs),
    title: opts.title,
    result: opts.result,
    audioFilePath: opts.audioFilePath,
    mergedFrom: opts.mergedFrom,
    liveNotes: opts.liveNotes,
  });

  return folderPath;
}

/** Inputs accepted by `writeV2Files`. Decoupled from `SaveTranscriptionOptions`
 * because migration also calls this with values it lifted from a v1 folder. */
interface V2WriteInputs {
  transcribedAt: string;
  title: string;
  result: TranscriptionResult;
  audioFilePath?: string;
  mergedFrom?: string[];
  liveNotes?: LiveNote[];
  /** Optional pre-existing exports (carried over by migration). */
  exports?: MeetingMetaV2['exports'];
}

/** Write the full v2 file set into an existing folder. Overwrites whatever's there. */
function writeV2Files(folderPath: string, inputs: V2WriteInputs): void {
  const highlights = getResultHighlights(inputs.result);

  const meta: MeetingMetaV2 = {
    schemaVersion: META_SCHEMA_VERSION,
    title: inputs.title,
    transcribedAt: inputs.transcribedAt,
  };
  if (inputs.result.suggestedTitle) meta.suggestedTitle = inputs.result.suggestedTitle;
  if (inputs.result.emoji) meta.emoji = inputs.result.emoji;
  if (inputs.audioFilePath) meta.audioFile = inputs.audioFilePath;
  if (inputs.result.cost && inputs.result.cost.breakdown.length > 0) meta.cost = inputs.result.cost;
  if (inputs.result.customFields && Object.keys(inputs.result.customFields).length > 0) {
    meta.customFields = inputs.result.customFields;
  }
  if (inputs.mergedFrom?.length) {
    meta.merge = { sourceIds: inputs.mergedFrom };
  }
  if (inputs.exports) meta.exports = inputs.exports;

  // Intentional: an empty summary string still writes an empty summary.md so
  // existence checks elsewhere see a "the meeting was saved" file. Same for
  // transcript.md. Other optional files (key-points, action-items, notes,
  // highlights) are absent when their data is empty.
  writeOrRemove(
    folderPath,
    SUMMARY_FILE,
    inputs.result.summary ? `${inputs.result.summary.trim()}\n` : '',
  );
  writeOrRemove(
    folderPath,
    KEY_POINTS_FILE,
    inputs.result.keyPoints?.length ? formatBullets(inputs.result.keyPoints) : null,
  );
  writeOrRemove(
    folderPath,
    ACTION_ITEMS_FILE,
    inputs.result.actionItems?.length ? formatBullets(inputs.result.actionItems) : null,
  );
  writeOrRemove(
    folderPath,
    TRANSCRIPT_FILE,
    inputs.result.transcript ? `${inputs.result.transcript.trim()}\n` : '',
  );
  writeOrRemove(
    folderPath,
    NOTES_JSON_FILE,
    inputs.liveNotes?.length ? `${JSON.stringify(inputs.liveNotes, null, 2)}\n` : null,
  );
  writeOrRemove(
    folderPath,
    HIGHLIGHTS_JSON_FILE,
    highlights?.length ? `${JSON.stringify(highlights, null, 2)}\n` : null,
  );

  // meta.json LAST and ATOMIC: it is the v2 sentinel (`isV2Folder`). Use
  // write-to-tmp + rename so a crash mid-write leaves either the old file
  // (no meta.json yet -> still v1) or the new file fully landed (-> v2) --
  // never a truncated meta.json that fools `isV2Folder` but breaks JSON parse.
  writeAtomic(path.join(folderPath, META_JSON), `${JSON.stringify(meta, null, 2)}\n`);
}

/** Write `content` to `folderPath/filename` when non-null, otherwise ensure
 * any stale copy is gone. Used by the v2 writer + migration so the on-disk
 * file set always matches the in-memory record. */
function writeOrRemove(folderPath: string, filename: string, content: string | null): void {
  const target = path.join(folderPath, filename);
  if (content === null) {
    fs.rmSync(target, { force: true });
  } else {
    fs.writeFileSync(target, content, 'utf-8');
  }
}

/** Write `content` to `targetPath` via a `.tmp` sibling + rename so the
 * write is atomic on POSIX (the rename is a single inode swap on the same
 * filesystem). Used for files whose mid-write truncation would corrupt the
 * data model -- currently just meta.json (the v2 sentinel). */
function writeAtomic(targetPath: string, content: string): void {
  const tmp = `${targetPath}.tmp`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, targetPath);
}

/**
 * Write a transcription using the legacy v1 layout (summary.md with YAML
 * frontmatter + rendered body). Only used by test fixtures and migration
 * rollback; production writes always go through `saveTranscription` (v2).
 */
export function __saveTranscriptionLegacyV1ForTests(opts: SaveTranscriptionOptions): string {
  const parentDir = opts.outputDir ?? getTranscriptionsDir(opts.dataPath);
  const folderName = `${sanitizeForPath(opts.title)}_${formatTimestamp()}`;
  const folderPath = path.join(parentDir, folderName);
  fs.mkdirSync(folderPath, { recursive: true });

  const transcribedAt = new Date().toISOString();

  const highlights = getResultHighlights(opts.result);
  const frontmatter = buildFrontmatter({
    title: opts.title,
    suggestedTitle: opts.result.suggestedTitle,
    summary: opts.result.summary,
    transcript: opts.result.transcript,
    keyPoints: opts.result.keyPoints,
    actionItems: opts.result.actionItems,
    customFields: opts.result.customFields,
    audioFilePath: opts.audioFilePath,
    transcribedAt,
    emoji: opts.result.emoji,
    mergedFrom: opts.mergedFrom,
    liveNotes: opts.liveNotes,
    highlights,
    cost: opts.result.cost,
  });
  const summaryBody = formatSummary(
    opts.result,
    opts.title,
    opts.mergedFrom,
    opts.liveNotes,
    highlights,
  );
  fs.writeFileSync(
    path.join(folderPath, 'summary.md'),
    `${frontmatter}\n\n${summaryBody}`,
    'utf-8',
  );
  fs.writeFileSync(
    path.join(folderPath, 'transcript.md'),
    formatTranscript(opts.result, opts.title),
    'utf-8',
  );

  return folderPath;
}

export interface TranscriptionEntry {
  folderPath: string;
  folderName: string;
  title: string;
  transcribedAt: string;
}

/**
 * List transcription folders sorted by most-recent-first. Reads meta.json
 * for each folder. Folders without meta.json (i.e. unmigrated v1 folders --
 * shouldn't exist at runtime because `autoMigrateLegacyOnStartup` runs first)
 * are silently skipped.
 */
export async function listTranscriptions(
  dataPath: string,
  limit?: number,
): Promise<TranscriptionEntry[]> {
  const dir = getTranscriptionsDir(dataPath);
  let dirents: fs.Dirent[];
  try {
    dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const entries: TranscriptionEntry[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const entry = await listEntryFromV2Meta(path.join(dir, dirent.name), dirent.name);
    if (entry) entries.push(entry);
  }

  entries.sort((a, b) => (b.transcribedAt || '').localeCompare(a.transcribedAt || ''));

  const max = limit === 0 ? entries.length : (limit ?? 20);
  return entries.slice(0, max);
}

async function listEntryFromV2Meta(
  folderPath: string,
  folderName: string,
): Promise<TranscriptionEntry | null> {
  try {
    const raw = await fs.promises.readFile(path.join(folderPath, META_JSON), 'utf-8');
    const meta = JSON.parse(raw) as MeetingMetaV2;
    return {
      folderPath,
      folderName,
      title: meta.title || folderName,
      transcribedAt: meta.transcribedAt || folderNameToTimestamp(folderName),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    console.warn(`listTranscriptions: failed to read v2 meta for ${folderName}:`, err);
    return null;
  }
}

/** Recover an ISO-ish timestamp from a folder name as last-resort fallback. */
function folderNameToTimestamp(name: string): string {
  // v2 prefix: YYYY-MM-DDTHH-MM-SS.mmmZ
  const v2 = splitV2FolderName(name);
  if (v2) return v2TimestampToIso(v2.ts);
  // v1 suffix: _YYYYMMDD_HHMMSS
  const tsMatch = name.match(/(\d{8}_\d{6})$/);
  if (tsMatch) {
    const s = tsMatch[1];
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}`;
  }
  return '';
}

export interface ReadTranscriptionResult {
  title: string;
  suggestedTitle?: string;
  transcript: string;
  summary: string;
  keyPoints?: string[];
  actionItems?: string[];
  customFields?: Record<string, unknown>;
  audioFilePath?: string;
  transcribedAt?: string;
  emoji?: string;
  mergedFrom?: string[];
  liveNotes?: LiveNote[];
  highlights?: HighlightEntry[];
  notionPageUrl?: string;
  slackSentAt?: string;
  slackError?: string;
  cost?: CostSnapshot;
}

/**
 * Read transcription data from a transcription folder.
 *
 * Dispatches by format: v2 folders (presence of meta.json) are stitched from
 * the per-field files; legacy v1 folders fall back to the frontmatter parser.
 * Either way the returned shape is identical so all upstream code is
 * format-agnostic.
 */
export interface ReadTranscriptionOptions {
  /** Skip transcript.md / frontmatter.transcript -- callers that filter
   * transcript out (e.g. default search scope) can avoid loading the largest
   * file in the folder. The returned `transcript` field will be an empty
   * string. */
  skipTranscript?: boolean;
}

/**
 * Read a transcription folder (v2 layout only). At runtime the
 * `autoMigrateLegacyOnStartup` pass guarantees every folder has been
 * converted, so this reader never sees a v1 folder. If meta.json is missing
 * we return null with a warning -- the caller should treat that as "corrupt
 * or unrecognised meeting" rather than try to read frontmatter.
 */
export async function readTranscription(
  folderPath: string,
  opts: ReadTranscriptionOptions = {},
): Promise<ReadTranscriptionResult | null> {
  let metaRaw: string;
  try {
    metaRaw = await fs.promises.readFile(path.join(folderPath, META_JSON), 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      console.warn(
        `readTranscription: meta.json missing at ${folderPath} -- folder may be unmigrated v1 or corrupt.`,
      );
      return null;
    }
    throw e;
  }

  try {
    const meta = JSON.parse(metaRaw) as MeetingMetaV2;

    // Reject anything that isn't exactly the current version: future versions
    // could break our reader, and `0` / `NaN` / negatives are hand-edit
    // corruption signals -- safer to bail than to silently write defaults back.
    if (typeof meta.schemaVersion !== 'number' || meta.schemaVersion !== META_SCHEMA_VERSION) {
      console.warn(
        `readTranscription: unknown meta.json schemaVersion ${meta.schemaVersion} in ${folderPath}`,
      );
      return null;
    }

    const [summary, keyPointsText, actionItemsText, transcript, notesRaw, highlightsRaw] =
      await Promise.all([
        readOptionalFile(path.join(folderPath, SUMMARY_FILE)),
        readOptionalFile(path.join(folderPath, KEY_POINTS_FILE)),
        readOptionalFile(path.join(folderPath, ACTION_ITEMS_FILE)),
        opts.skipTranscript
          ? Promise.resolve(null)
          : readOptionalFile(path.join(folderPath, TRANSCRIPT_FILE)),
        readOptionalFile(path.join(folderPath, NOTES_JSON_FILE)),
        readOptionalFile(path.join(folderPath, HIGHLIGHTS_JSON_FILE)),
      ]);

    const keyPoints = keyPointsText ? parseBullets(keyPointsText) : undefined;
    const actionItems = actionItemsText ? parseBullets(actionItemsText) : undefined;

    let liveNotes: LiveNote[] | undefined;
    if (notesRaw) {
      try {
        liveNotes = parseLiveNotesField(JSON.parse(notesRaw));
      } catch (e) {
        console.warn(`Failed to parse notes.json in ${folderPath}:`, e);
      }
    }

    let highlights: ReadTranscriptionResult['highlights'];
    if (highlightsRaw) {
      try {
        highlights = parseHighlightsField(JSON.parse(highlightsRaw));
      } catch (e) {
        console.warn(`Failed to parse highlights.json in ${folderPath}:`, e);
      }
    }

    return {
      title: meta.title || path.basename(folderPath),
      suggestedTitle: meta.suggestedTitle,
      transcript: (transcript ?? '').trim(),
      summary: (summary ?? '').trim(),
      keyPoints: keyPoints && keyPoints.length > 0 ? keyPoints : undefined,
      actionItems: actionItems && actionItems.length > 0 ? actionItems : undefined,
      customFields: meta.customFields,
      audioFilePath: meta.audioFile,
      transcribedAt: meta.transcribedAt,
      emoji: meta.emoji,
      mergedFrom: meta.merge?.sourceIds,
      liveNotes,
      highlights,
      notionPageUrl: meta.exports?.notion?.pageUrl,
      slackSentAt: meta.exports?.slack?.sentAt,
      slackError: meta.exports?.slack?.error ?? undefined,
      cost: meta.cost,
    };
  } catch (e) {
    console.warn(`Failed to read v2 transcription at ${folderPath}:`, e);
    return null;
  }
}

/** Migration-only reader: parses a v1 summary.md (YAML frontmatter) into the
 * shared shape so `migrateV1ToV2` can lift the data forward. Not exported --
 * runtime reads always go through the v2 `readTranscription`. */
async function readV1Transcription(folderPath: string): Promise<ReadTranscriptionResult | null> {
  try {
    const summaryPath = path.join(folderPath, 'summary.md');

    const summaryContent = await fs.promises.readFile(summaryPath, 'utf-8');
    const { meta } = parseFrontmatter(summaryContent);

    let customFields: Record<string, unknown> | undefined;
    if (meta.customFields) {
      try {
        customFields =
          typeof meta.customFields === 'string'
            ? JSON.parse(meta.customFields as string)
            : (meta.customFields as Record<string, unknown>);
      } catch (e) {
        console.warn('Failed to parse customFields from frontmatter:', e);
      }
    }

    const liveNotes = parseLiveNotesField(meta.liveNotes);
    const highlights = parseHighlightsField(meta.highlights);
    const cost = parseCostField(meta.cost);

    // `parseFrontmatter` can return an empty array for `summary:` / `transcript:`
    // value lines that are blank (hand-edited or malformed v1 file); coerce
    // non-strings to '' so the v2 writer's `.trim()` doesn't blow up.
    return {
      title: asString(meta.title) || path.basename(folderPath),
      suggestedTitle: meta.suggestedTitle as string | undefined,
      transcript: asString(meta.transcript),
      summary: asString(meta.summary),
      keyPoints: meta.keyPoints as string[] | undefined,
      actionItems: meta.actionItems as string[] | undefined,
      customFields,
      audioFilePath: meta.audioFilePath as string | undefined,
      transcribedAt: meta.transcribedAt as string | undefined,
      emoji: meta.emoji as string | undefined,
      mergedFrom: meta.mergedFrom as string[] | undefined,
      liveNotes,
      highlights,
      notionPageUrl: meta.notionPageUrl as string | undefined,
      slackSentAt: meta.slackSentAt as string | undefined,
      slackError: meta.slackError as string | undefined,
      cost,
    };
  } catch {
    return null;
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(filePath, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

function parseCostField(raw: unknown): CostSnapshot | undefined {
  if (!raw) return undefined;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const usd = Number((parsed as { usd?: unknown }).usd);
    if (!Number.isFinite(usd)) return undefined;
    const breakdownRaw = (parsed as { breakdown?: unknown }).breakdown;
    const breakdown = Array.isArray(breakdownRaw)
      ? (breakdownRaw as CostSnapshot['breakdown'])
      : [];
    const modelUnknown = Boolean((parsed as { modelUnknown?: unknown }).modelUnknown);
    return modelUnknown ? { usd, breakdown, modelUnknown } : { usd, breakdown };
  } catch (e) {
    console.warn('Failed to parse cost from frontmatter:', e);
    return undefined;
  }
}

export interface TranscriptionStatusUpdate {
  notionPageUrl?: string | null;
  slackSentAt?: string | null;
  slackError?: string | null;
}

/**
 * Update tracking fields (Notion URL, Slack send status) in a v2 folder's
 * meta.json. Pass `null` to clear a field, `undefined` to leave unchanged.
 * Touches only meta.json -- the content files (summary.md, transcript.md,
 * etc.) keep their existing mtime so Drive sync only re-uploads the one file
 * that actually changed.
 */
export async function updateTranscriptionStatus(
  folderPath: string,
  updates: TranscriptionStatusUpdate,
): Promise<void> {
  const metaPath = path.join(folderPath, META_JSON);
  const raw = await fs.promises.readFile(metaPath, 'utf-8');
  const meta = JSON.parse(raw) as MeetingMetaV2;

  // `exports` is reserved as a CommonJS module local; use a different name.
  const exportsMeta = { ...meta.exports } as NonNullable<MeetingMetaV2['exports']>;
  applyV2Notion(exportsMeta, updates.notionPageUrl);
  applyV2Slack(exportsMeta, 'sentAt', updates.slackSentAt);
  applyV2Slack(exportsMeta, 'error', updates.slackError);

  if (Object.keys(exportsMeta).length === 0) {
    delete meta.exports;
  } else {
    meta.exports = exportsMeta;
  }

  // Atomic write so a crash never leaves a truncated meta.json behind.
  writeAtomic(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
}

function applyV2Notion(
  exportsMeta: NonNullable<MeetingMetaV2['exports']>,
  value: string | null | undefined,
): void {
  if (value === undefined) return;
  if (value === null || value === '') {
    delete exportsMeta.notion;
    return;
  }
  exportsMeta.notion = { ...exportsMeta.notion, pageUrl: value };
}

function applyV2Slack(
  exportsMeta: NonNullable<MeetingMetaV2['exports']>,
  key: 'sentAt' | 'error',
  value: string | null | undefined,
): void {
  if (value === undefined) return;
  const slack = { ...exportsMeta.slack };
  if (value === null || value === '') {
    delete slack[key];
  } else {
    slack[key] = value;
  }
  if (Object.keys(slack).length === 0) {
    delete exportsMeta.slack;
  } else {
    exportsMeta.slack = slack;
  }
}

/**
 * Migrate a v1 folder to the v2 layout in-place. Idempotent: returns false
 * when the folder is already v2.
 *
 * Why: the folder name is preserved (Drive sync keys change detection on
 * folder identity, so a rename would force a full re-upload).
 *
 * Crash safety: the v1 summary.md / transcript.md are renamed to in-folder
 * `.v1-bak` siblings BEFORE any v2 writes, so a crash anywhere in the loop
 * leaves the v1 originals recoverable. The `.v1-bak` files are deleted only
 * after `meta.json` (the v2 sentinel) lands. On retry, the migration sees no
 * `meta.json` and the `.v1-bak` files signal "previous attempt crashed" --
 * we restore the originals before re-reading.
 */
export async function migrateV1ToV2(folderPath: string): Promise<boolean> {
  if (isV2Folder(folderPath)) return false;

  // Recover from a previous-attempt crash: if `.v1-bak` siblings exist (v2
  // sentinel absent, body files overwritten), restore them before reading.
  restoreV1BakIfPresent(folderPath);

  const v1 = await readV1Transcription(folderPath);
  if (!v1) {
    throw new Error(`migrateV1ToV2: could not read v1 folder at ${folderPath}`);
  }

  // Prefer the v1 frontmatter date; fall back to the folder-name suffix;
  // last-ditch use now.
  const transcribedAt =
    v1.transcribedAt ||
    folderNameToTimestamp(path.basename(folderPath)) ||
    new Date().toISOString();

  // transcript.md is the user-visible source; prefer it over frontmatter.transcript
  // in case a user hand-edited only the markdown side.
  let transcriptText = v1.transcript;
  try {
    const transcriptRaw = fs.readFileSync(path.join(folderPath, TRANSCRIPT_FILE), 'utf-8');
    const cleaned = transcriptRaw.replace(/^# [^\n]*\n+/, '').trim();
    if (cleaned.length > 0) transcriptText = cleaned;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  const result: TranscriptionResult = {
    transcript: transcriptText,
    summary: v1.summary,
    keyPoints: v1.keyPoints ?? [],
    actionItems: v1.actionItems ?? [],
    emoji: v1.emoji ?? '',
    customFields: v1.customFields,
    suggestedTitle: v1.suggestedTitle,
    highlights: v1.highlights,
    cost: v1.cost,
  };

  const exportsMeta: MeetingMetaV2['exports'] = {};
  if (v1.notionPageUrl) exportsMeta.notion = { pageUrl: v1.notionPageUrl };
  if (v1.slackSentAt || v1.slackError) {
    exportsMeta.slack = {};
    if (v1.slackSentAt) exportsMeta.slack.sentAt = v1.slackSentAt;
    if (v1.slackError) exportsMeta.slack.error = v1.slackError;
  }

  // Rename v1 originals to `.v1-bak` siblings (atomic on POSIX) so the
  // upcoming destructive writeV2Files cannot lose data on crash. On retry
  // we'd see no meta.json + .v1-bak present and restore above.
  for (const name of V1_BAK_FILES) {
    renameIfExists(path.join(folderPath, name), path.join(folderPath, `${name}${V1_BAK_SUFFIX}`));
  }

  writeV2Files(folderPath, {
    transcribedAt,
    title: v1.title,
    result,
    audioFilePath: v1.audioFilePath,
    mergedFrom: v1.mergedFrom,
    liveNotes: v1.liveNotes,
    exports: Object.keys(exportsMeta).length > 0 ? exportsMeta : undefined,
  });

  // meta.json landed -- safe to drop the .v1-bak siblings.
  for (const name of V1_BAK_FILES) {
    fs.rmSync(path.join(folderPath, `${name}${V1_BAK_SUFFIX}`), { force: true });
  }

  return true;
}

function renameIfExists(src: string, dst: string): void {
  try {
    fs.renameSync(src, dst);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

/** If a previous `migrateV1ToV2` crashed mid-write the folder is in a hybrid
 * state: no `meta.json`, body files possibly partly overwritten, and the
 * pre-write `.v1-bak` siblings still present. Restore the .v1-bak files back
 * to their canonical names so the next attempt sees a clean v1 folder. */
function restoreV1BakIfPresent(folderPath: string): void {
  for (const name of V1_BAK_FILES) {
    const bak = path.join(folderPath, `${name}${V1_BAK_SUFFIX}`);
    const target = path.join(folderPath, name);
    if (!fs.existsSync(bak)) continue;
    fs.rmSync(target, { force: true });
    fs.renameSync(bak, target);
  }
}

export interface AutoMigrateResult {
  /** Folder names that were migrated this run. */
  migrated: string[];
  /** Folders that were already v2 and skipped. */
  alreadyV2: number;
  /** Absolute path to the backup directory, if any migration occurred. */
  backupDir?: string;
}

export interface AutoMigrateOptions {
  now?: Date;
  onProgress?: (current: number, total: number, folderName: string) => void;
}

/**
 * Scan the transcriptions directory for legacy v1 folders, snapshot each
 * one's destructively-overwritten files into a sibling `.v1-backup-<ts>/`
 * directory, then convert every v1 folder to v2 in place.
 *
 * Atomicity contract: if any individual migration throws, the function
 * propagates -- the caller MUST refuse to continue startup. A partial
 * migration would leave some folders v1 (unreadable to the v2-only runtime)
 * and others v2, which is worse than not migrating at all.
 *
 * The backup directory lives under `dataPath/` (NOT under `transcriptions/`)
 * so the Google Drive sync engine never sees it.
 */
export async function autoMigrateLegacyOnStartup(
  dataPath: string,
  opts: AutoMigrateOptions = {},
): Promise<AutoMigrateResult> {
  const transcriptionsDir = getTranscriptionsDir(dataPath);
  let dirents: fs.Dirent[];
  try {
    dirents = await fs.promises.readdir(transcriptionsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { migrated: [], alreadyV2: 0 };
    }
    throw err;
  }

  // Per-folder isV2Folder is one statSync (~10us on SSD); a name-pattern
  // shortcut was considered and rejected because a v1 folder that happens to
  // have a v2-shaped name (manual rename, restored backup, name collision
  // with the v2 convention) would be falsely skipped and silently dropped at
  // read time.
  const v1Folders: string[] = [];
  let alreadyV2 = 0;
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    if (d.name.startsWith('.')) continue; // skip prior backup directories
    const folderPath = path.join(transcriptionsDir, d.name);
    if (isV2Folder(folderPath)) {
      alreadyV2 += 1;
    } else {
      v1Folders.push(folderPath);
    }
  }

  if (v1Folders.length === 0) {
    return { migrated: [], alreadyV2 };
  }

  const now = opts.now ?? new Date();
  const backupDir = path.join(dataPath, `${V1_BACKUP_DIR_PREFIX}${formatV2Timestamp(now)}`);
  fs.mkdirSync(backupDir, { recursive: true });

  const migrated: string[] = [];
  for (let i = 0; i < v1Folders.length; i++) {
    const folderPath = v1Folders[i];
    const folderName = path.basename(folderPath);
    opts.onProgress?.(i + 1, v1Folders.length, folderName);
    snapshotV1Files(folderPath, path.join(backupDir, folderName));
    await migrateV1ToV2(folderPath);
    migrated.push(folderName);
  }

  return { migrated, alreadyV2, backupDir };
}

/** Copy the files that `migrateV1ToV2` destructively overwrites into a
 * backup directory so the operation is recoverable. summary.md is replaced
 * (frontmatter dropped) and transcript.md may have its leading `# title`
 * stripped; everything else is additive. */
function snapshotV1Files(folderPath: string, backupTargetDir: string): void {
  fs.mkdirSync(backupTargetDir, { recursive: true });
  for (const name of V1_BAK_FILES) {
    const src = path.join(folderPath, name);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(backupTargetDir, name));
    }
  }
}

/** Remove `.v1-backup-*` directories older than `retentionDays` days.
 * Returns the number of backups removed. */
export async function gcLegacyBackups(dataPath: string, retentionDays = 30): Promise<number> {
  let dirents: fs.Dirent[];
  try {
    dirents = await fs.promises.readdir(dataPath, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    if (!d.name.startsWith(V1_BACKUP_DIR_PREFIX)) continue;
    const full = path.join(dataPath, d.name);
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoffMs) {
        fs.rmSync(full, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      // ignore -- the backup is either gone or the user pulled it out
    }
  }
  return removed;
}
