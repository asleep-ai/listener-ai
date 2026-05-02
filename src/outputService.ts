import * as fs from 'fs';
import * as path from 'path';
import type { TranscriptionResult } from './geminiService';

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

/** Convert camelCase key to a display label: "keyDecisions" -> "Key Decisions" */
export function camelToLabel(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (s: string) => s.toUpperCase())
    .trim();
}

export function formatSummary(
  result: TranscriptionResult,
  title: string,
  mergedFrom?: string[],
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
  notionPageUrl?: string;
  slackSentAt?: string;
  slackError?: string;
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
  if (meta.notionPageUrl) {
    lines.push(`notionPageUrl: ${yamlQuote(meta.notionPageUrl)}`);
  }
  if (meta.slackSentAt) {
    lines.push(`slackSentAt: ${yamlQuote(meta.slackSentAt)}`);
  }
  if (meta.slackError) {
    lines.push(`slackError: ${yamlQuote(meta.slackError)}`);
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
}

/**
 * Save transcription as summary.md + transcript.md in a timestamped folder.
 * Returns the created folder path.
 */
export function saveTranscription(opts: SaveTranscriptionOptions): string {
  const parentDir = opts.outputDir ?? getTranscriptionsDir(opts.dataPath);
  const folderName = `${sanitizeForPath(opts.title)}_${formatTimestamp()}`;
  const folderPath = path.join(parentDir, folderName);
  fs.mkdirSync(folderPath, { recursive: true });

  const transcribedAt = new Date().toISOString();

  // summary.md with frontmatter (stores all raw data for machine reading)
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
  });
  const summaryBody = formatSummary(opts.result, opts.title, opts.mergedFrom);
  fs.writeFileSync(
    path.join(folderPath, 'summary.md'),
    `${frontmatter}\n\n${summaryBody}`,
    'utf-8',
  );

  // transcript.md
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
 * List transcription folders sorted by most-recent-first.
 * Performs a lightweight line scan of each summary.md to extract only title and transcribedAt.
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
    const name = dirent.name;
    const folderPath = path.join(dir, name);
    const summaryPath = path.join(folderPath, 'summary.md');

    let title = name;
    let transcribedAt = '';

    // Lightweight line scan -- read only frontmatter, not the full file
    let fileHandle: fs.promises.FileHandle;
    try {
      fileHandle = await fs.promises.open(summaryPath, 'r');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    try {
      const buf = Buffer.alloc(2048);
      const { bytesRead } = await fileHandle.read(buf, 0, 2048, 0);
      const head = buf.toString('utf-8', 0, bytesRead);

      for (const line of head.split('\n')) {
        const titleMatch = line.match(/^title:\s*(.+)$/);
        if (titleMatch) title = yamlUnquote(titleMatch[1]);
        const dateMatch = line.match(/^transcribedAt:\s*(.+)$/);
        if (dateMatch) transcribedAt = yamlUnquote(dateMatch[1]);
        // Stop after closing frontmatter delimiter
        if (line === '---' && transcribedAt) break;
      }
    } finally {
      await fileHandle.close();
    }

    // Fall back to folder name timestamp suffix (e.g. _20260219_143000)
    if (!transcribedAt) {
      const tsMatch = name.match(/(\d{8}_\d{6})$/);
      if (tsMatch) {
        const s = tsMatch[1];
        transcribedAt = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}`;
      }
    }

    entries.push({ folderPath, folderName: name, title, transcribedAt });
  }

  entries.sort((a, b) => (b.transcribedAt || '').localeCompare(a.transcribedAt || ''));

  const max = limit === 0 ? entries.length : (limit ?? 20);
  return entries.slice(0, max);
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
  notionPageUrl?: string;
  slackSentAt?: string;
  slackError?: string;
}

/**
 * Read transcription data from a transcription folder.
 * Returns raw data from frontmatter (machine-readable), not the markdown body.
 */
export async function readTranscription(
  folderPath: string,
): Promise<ReadTranscriptionResult | null> {
  try {
    const summaryPath = path.join(folderPath, 'summary.md');

    const summaryContent = await fs.promises.readFile(summaryPath, 'utf-8');
    const { meta } = parseFrontmatter(summaryContent);

    // Parse customFields from frontmatter (stored as JSON string)
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

    return {
      title: (meta.title as string) || path.basename(folderPath),
      suggestedTitle: meta.suggestedTitle as string | undefined,
      transcript: (meta.transcript as string) || '',
      summary: (meta.summary as string) || '',
      keyPoints: meta.keyPoints as string[] | undefined,
      actionItems: meta.actionItems as string[] | undefined,
      customFields,
      audioFilePath: meta.audioFilePath as string | undefined,
      transcribedAt: meta.transcribedAt as string | undefined,
      emoji: meta.emoji as string | undefined,
      mergedFrom: meta.mergedFrom as string[] | undefined,
      notionPageUrl: meta.notionPageUrl as string | undefined,
      slackSentAt: meta.slackSentAt as string | undefined,
      slackError: meta.slackError as string | undefined,
    };
  } catch {
    return null;
  }
}

export interface TranscriptionStatusUpdate {
  notionPageUrl?: string | null;
  slackSentAt?: string | null;
  slackError?: string | null;
}

/**
 * Update tracking fields (Notion URL, Slack send status) in summary.md frontmatter
 * without rewriting the markdown body. Pass `null` to clear a field, `undefined` to leave unchanged.
 */
export async function updateTranscriptionStatus(
  folderPath: string,
  updates: TranscriptionStatusUpdate,
): Promise<void> {
  const summaryPath = path.join(folderPath, 'summary.md');
  const content = await fs.promises.readFile(summaryPath, 'utf-8');
  const { meta, body } = parseFrontmatter(content);

  // Recover customFields shape (parseFrontmatter returns it as a JSON string)
  let customFields: Record<string, unknown> | undefined;
  if (meta.customFields) {
    try {
      customFields =
        typeof meta.customFields === 'string'
          ? JSON.parse(meta.customFields as string)
          : (meta.customFields as Record<string, unknown>);
    } catch {
      customFields = undefined;
    }
  }

  // Spread first so any unknown frontmatter keys (added by future writers, or
  // by hand-edits) survive the round-trip; named fields override with proper
  // typing and defaults.
  const merged: SummaryFrontmatter = {
    ...(meta as unknown as Partial<SummaryFrontmatter>),
    title: (meta.title as string) || path.basename(folderPath),
    summary: (meta.summary as string) || '',
    transcript: (meta.transcript as string) || '',
    transcribedAt: (meta.transcribedAt as string) || new Date().toISOString(),
    customFields,
  };

  applyStatusUpdate(merged, 'notionPageUrl', updates.notionPageUrl);
  applyStatusUpdate(merged, 'slackSentAt', updates.slackSentAt);
  applyStatusUpdate(merged, 'slackError', updates.slackError);

  const frontmatter = buildFrontmatter(merged);
  await fs.promises.writeFile(summaryPath, `${frontmatter}\n\n${body}`, 'utf-8');
}

function applyStatusUpdate(
  meta: SummaryFrontmatter,
  key: 'notionPageUrl' | 'slackSentAt' | 'slackError',
  value: string | null | undefined,
): void {
  if (value === undefined) return;
  if (value === null || value === '') {
    delete meta[key];
    return;
  }
  meta[key] = value;
}
