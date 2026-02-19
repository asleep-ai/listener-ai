import * as fs from 'fs';
import * as path from 'path';
import type { TranscriptionResult } from './geminiService';

export function sanitizeForPath(name: string): string {
  return name.replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
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

export function formatSummary(result: TranscriptionResult, title: string): string {
  const lines: string[] = [];
  lines.push(`# ${title}\n`);

  if (result.summary) {
    lines.push(`## Summary\n`);
    lines.push(`${result.summary}\n`);
  }

  if (result.keyPoints?.length) {
    lines.push(`## Key Points\n`);
    for (const point of result.keyPoints) {
      lines.push(`- ${point}`);
    }
    lines.push('');
  }

  if (result.actionItems?.length) {
    lines.push(`## Action Items\n`);
    for (const item of result.actionItems) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  if (result.customFields) {
    for (const [key, value] of Object.entries(result.customFields)) {
      const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, (s: string) => s.toUpperCase()).trim();
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
}

function buildFrontmatter(meta: SummaryFrontmatter): string {
  const lines: string[] = ['---'];
  lines.push(`title: ${yamlQuote(meta.title)}`);
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
  lines.push(`transcribedAt: ${yamlQuote(meta.transcribedAt)}`);
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
  content = content.replace(/\r\n/g, '\n');
  if (!content.startsWith('---\n')) {
    return { meta: {}, body: content };
  }
  const end = content.indexOf('\n---', 4);
  if (end === -1) {
    return { meta: {}, body: content };
  }
  const yamlBlock = content.slice(4, end);
  const body = content.slice(end + 4).trimStart();

  const meta: Record<string, unknown> = {};
  let currentArrayKey: string | null = null;
  let currentArray: string[] = [];

  for (const line of yamlBlock.split('\n')) {
    const arrayItem = line.match(/^  - (.+)$/);
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
    return value.slice(1, -1)
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
  dataPath: string;   // app data path (default location)
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
  });
  const summaryBody = formatSummary(opts.result, opts.title);
  fs.writeFileSync(path.join(folderPath, 'summary.md'), `${frontmatter}\n\n${summaryBody}`, 'utf-8');

  // transcript.md
  fs.writeFileSync(path.join(folderPath, 'transcript.md'), formatTranscript(opts.result, opts.title), 'utf-8');

  return folderPath;
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
}

/**
 * Read transcription data from a transcription folder.
 * Returns raw data from frontmatter (machine-readable), not the markdown body.
 */
export function readTranscription(folderPath: string): ReadTranscriptionResult | null {
  try {
    const summaryPath = path.join(folderPath, 'summary.md');

    if (!fs.existsSync(summaryPath)) return null;

    const summaryContent = fs.readFileSync(summaryPath, 'utf-8');
    const { meta } = parseFrontmatter(summaryContent);

    // Parse customFields from frontmatter (stored as JSON string)
    let customFields: Record<string, unknown> | undefined;
    if (meta.customFields) {
      try {
        customFields = typeof meta.customFields === 'string'
          ? JSON.parse(meta.customFields as string)
          : meta.customFields as Record<string, unknown>;
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
    };
  } catch {
    return null;
  }
}
