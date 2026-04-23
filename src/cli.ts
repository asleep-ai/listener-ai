#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import { getDataPath } from './dataPath';
import { ConfigService } from './configService';
import { GeminiService } from './geminiService';
import { saveTranscription, listTranscriptions, parseFrontmatter, getTranscriptionsDir } from './outputService';
import { searchTranscriptions, resolveFields, ALL_FIELDS, type SearchField } from './searchService';

const SUPPORTED_EXTENSIONS = new Set([
  '.mp3', '.m4a', '.wav', '.ogg', '.flac', '.aac', '.wma', '.opus', '.webm',
]);

function usage(): never {
  process.stderr.write(
    'Usage: listener <file> [--output <dir>]    Transcribe an audio file\n' +
    '       listener list [--limit <n>]         List past transcriptions\n' +
    '       listener show <ref>                 Print summary to stdout\n' +
    '       listener export <ref> [<path>] [--json] [--transcript]\n' +
    '                                           Export transcription\n' +
    '       listener search <query> [--limit <n>] [--transcript] [--field <name>]\n' +
    '                                           Search past transcriptions\n' +
    '       listener config list|get|set|path   Manage configuration\n' +
    '\n' +
    '<ref> is a number from `listener list` or a folder name.\n' +
    '\n' +
    'Options:\n' +
    '  --output <dir>   Parent directory for the output folder\n' +
    '  --limit <n>      Max results (0 = all, default: 20)\n' +
    '  --json           Export as JSON instead of markdown\n' +
    '  --transcript     Include transcript body (export: append; search: widen scope)\n' +
    '  --field <name>   Restrict search to one of: title, summary, keyPoints, actionItems, transcript, all\n' +
    '  --help           Show this help message\n'
  );
  process.exit(1);
}

const KNOWN_CONFIG_KEYS = ['geminiApiKey', 'geminiModel', 'geminiFlashModel', 'notionApiKey', 'notionDatabaseId', 'autoMode', 'globalShortcut', 'minRecordingSeconds'] as const;
type ConfigKey = typeof KNOWN_CONFIG_KEYS[number];

function maskValue(key: string, value: string | undefined): string {
  if (value == null || value === '') return '(not set)';
  if (key.toLowerCase().includes('key')) {
    return value.length > 4 ? '****' + value.slice(-4) : '****';
  }
  return value;
}

function handleConfig(subArgs: string[]): void {
  const dataPath = getDataPath();
  const config = new ConfigService(dataPath);
  const sub = subArgs[0];

  if (!sub || sub === '--help') {
    usage();
  }

  if (sub === 'path') {
    process.stdout.write(`${config.getConfigPath()}\n`);
    return;
  }

  if (sub === 'list') {
    const all = config.getAllConfig();
    for (const key of KNOWN_CONFIG_KEYS) {
      const raw = all[key as keyof typeof all];
      const display = maskValue(key, raw == null ? undefined : String(raw));
      process.stdout.write(`${key}=${display}\n`);
    }
    return;
  }

  if (sub === 'get') {
    const key = subArgs[1] as ConfigKey;
    if (!key) {
      process.stderr.write('Error: Missing key. Usage: listener config get <key>\n');
      process.exit(1);
    }
    if (!KNOWN_CONFIG_KEYS.includes(key)) {
      process.stderr.write(`Error: Unknown key: ${key}\n`);
      process.stderr.write(`Known keys: ${KNOWN_CONFIG_KEYS.join(', ')}\n`);
      process.exit(1);
    }
    const all = config.getAllConfig();
    const val = all[key as keyof typeof all];
    process.stdout.write(`${val ?? ''}\n`);
    return;
  }

  if (sub === 'set') {
    const key = subArgs[1] as ConfigKey;
    const value = subArgs[2];
    if (!key || value == null) {
      process.stderr.write('Error: Missing key or value. Usage: listener config set <key> <value>\n');
      process.exit(1);
    }
    if (!KNOWN_CONFIG_KEYS.includes(key)) {
      process.stderr.write(`Error: Unknown key: ${key}\n`);
      process.stderr.write(`Known keys: ${KNOWN_CONFIG_KEYS.join(', ')}\n`);
      process.exit(1);
    }
    const setters: Record<ConfigKey, (v: string) => void> = {
      geminiApiKey: (v) => config.setGeminiApiKey(v),
      geminiModel: (v) => config.setGeminiModel(v),
      geminiFlashModel: (v) => config.setGeminiFlashModel(v),
      notionApiKey: (v) => config.setNotionApiKey(v),
      notionDatabaseId: (v) => config.setNotionDatabaseId(v),
      autoMode: (v) => {
        if (v !== 'true' && v !== 'false') {
          process.stderr.write('Error: autoMode must be "true" or "false"\n');
          process.exit(1);
        }
        config.setAutoMode(v === 'true');
      },
      globalShortcut: (v) => config.setGlobalShortcut(v),
      minRecordingSeconds: (v) => {
        const n = parseInt(v, 10);
        if (isNaN(n) || n < 0 || String(n) !== v.trim()) {
          process.stderr.write('Error: minRecordingSeconds must be a non-negative integer (0 disables)\n');
          process.exit(1);
        }
        config.setMinRecordingSeconds(n);
      },
    };
    setters[key](value);
    process.stderr.write(`Set ${key}\n`);
    return;
  }

  process.stderr.write(`Error: Unknown config command: ${sub}\n`);
  usage();
}

function resolveRef(ref: string, dataPath: string): string {
  if (/^\d+$/.test(ref)) {
    const index = parseInt(ref, 10);
    const entries = listTranscriptions(dataPath, 0);
    if (entries.length === 0) {
      process.stderr.write('Error: No transcriptions found.\n');
      process.exit(1);
    }
    if (index < 1 || index > entries.length) {
      process.stderr.write(`Error: Invalid index ${index}. Run 'listener list' to see available entries (1-${entries.length}).\n`);
      process.exit(1);
    }
    return entries[index - 1].folderPath;
  }
  const folderPath = path.join(getTranscriptionsDir(dataPath), ref);
  if (!fs.existsSync(folderPath)) {
    process.stderr.write(`Error: Folder not found: ${ref}\n`);
    process.exit(1);
  }
  return folderPath;
}

function handleList(args: string[]): void {
  const dataPath = getDataPath();
  let limit: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && i + 1 < args.length) {
      limit = parseInt(args[++i], 10);
      if (isNaN(limit) || limit < 0) {
        process.stderr.write('Error: --limit must be a non-negative integer\n');
        process.exit(1);
      }
    }
  }
  const entries = listTranscriptions(dataPath, limit);
  if (entries.length === 0) {
    process.stderr.write('No transcriptions found.\n');
    return;
  }
  process.stdout.write(' #  Date        Title\n');
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const num = String(i + 1).padStart(2, ' ');
    const date = e.transcribedAt ? e.transcribedAt.slice(0, 10) : '          ';
    const title = e.title.length > 60 ? e.title.slice(0, 57) + '...' : e.title;
    process.stdout.write(`${num}  ${date}  ${title}\n`);
  }
}

function handleShow(args: string[]): void {
  const ref = args[0];
  if (!ref) {
    process.stderr.write('Error: Missing ref. Usage: listener show <ref>\n');
    process.exit(1);
  }
  const dataPath = getDataPath();
  const folderPath = resolveRef(ref, dataPath);
  const summaryPath = path.join(folderPath, 'summary.md');
  if (!fs.existsSync(summaryPath)) {
    process.stderr.write(`Error: summary.md not found in ${folderPath}\n`);
    process.exit(1);
  }
  const content = fs.readFileSync(summaryPath, 'utf-8');
  const { body } = parseFrontmatter(content);
  process.stdout.write(body);
}

function handleExport(args: string[]): void {
  let ref: string | undefined;
  let targetPath: string | undefined;
  let json = false;
  let includeTranscript = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') { json = true; continue; }
    if (args[i] === '--transcript') { includeTranscript = true; continue; }
    if (args[i].startsWith('-')) {
      process.stderr.write(`Error: Unknown option: ${args[i]}\n`);
      process.exit(1);
    }
    if (!ref) { ref = args[i]; continue; }
    if (!targetPath) { targetPath = args[i]; continue; }
  }

  if (!ref) {
    process.stderr.write('Error: Missing ref. Usage: listener export <ref> [<path>] [--json] [--transcript]\n');
    process.exit(1);
  }

  const dataPath = getDataPath();
  const folderPath = resolveRef(ref, dataPath);
  const summaryPath = path.join(folderPath, 'summary.md');

  if (!fs.existsSync(summaryPath)) {
    process.stderr.write(`Error: summary.md not found in ${folderPath}\n`);
    process.exit(1);
  }

  // Copy files to target path
  if (targetPath && (json || includeTranscript)) {
    process.stderr.write('Error: --json and --transcript are only supported when writing to stdout (omit <path>)\n');
    process.exit(1);
  }
  if (targetPath) {
    targetPath = path.resolve(targetPath);
    fs.mkdirSync(targetPath, { recursive: true });
    fs.copyFileSync(summaryPath, path.join(targetPath, 'summary.md'));
    const transcriptPath = path.join(folderPath, 'transcript.md');
    if (fs.existsSync(transcriptPath)) {
      fs.copyFileSync(transcriptPath, path.join(targetPath, 'transcript.md'));
    }
    process.stderr.write(`Exported to ${targetPath}\n`);
    return;
  }

  // Output to stdout
  const content = fs.readFileSync(summaryPath, 'utf-8');
  const { meta, body } = parseFrontmatter(content);

  if (json) {
    let customFields: Record<string, unknown> = {};
    if (meta.customFields) {
      try {
        customFields = typeof meta.customFields === 'string'
          ? JSON.parse(meta.customFields as string)
          : meta.customFields as Record<string, unknown>;
      } catch { /* ignore */ }
    }
    const obj: Record<string, unknown> = {
      title: meta.title || '',
      transcribedAt: meta.transcribedAt || '',
      summary: meta.summary || '',
      keyPoints: meta.keyPoints || [],
      actionItems: meta.actionItems || [],
      customFields,
    };
    if (includeTranscript) {
      obj.transcript = meta.transcript || '';
    }
    process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  } else {
    process.stdout.write(body);
    if (includeTranscript) {
      const transcriptPath = path.join(folderPath, 'transcript.md');
      if (fs.existsSync(transcriptPath)) {
        const transcriptContent = fs.readFileSync(transcriptPath, 'utf-8');
        process.stdout.write('\n' + transcriptContent);
      }
    }
  }
}

function handleSearch(args: string[]): void {
  const VALID_FIELDS = [...ALL_FIELDS, 'all'] as const;
  let query: string | undefined;
  let limit = 20;
  let includeTranscript = false;
  let field: SearchField | 'all' | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--limit' && i + 1 < args.length) {
      const n = parseInt(args[++i], 10);
      if (isNaN(n) || n < 0) {
        process.stderr.write('Error: --limit must be a non-negative integer\n');
        process.exit(1);
      }
      limit = n;
      continue;
    }
    if (a === '--transcript') { includeTranscript = true; continue; }
    if (a === '--field' && i + 1 < args.length) {
      const v = args[++i];
      if (!(VALID_FIELDS as readonly string[]).includes(v)) {
        process.stderr.write(`Error: --field must be one of: ${VALID_FIELDS.join(', ')}\n`);
        process.exit(1);
      }
      field = v as SearchField | 'all';
      continue;
    }
    if (a.startsWith('-')) {
      process.stderr.write(`Error: Unknown option: ${a}\n`);
      process.exit(1);
    }
    if (!query) { query = a; continue; }
    process.stderr.write(`Error: Unexpected argument: ${a} (quote multi-word queries)\n`);
    process.exit(1);
  }

  if (!query || query.trim() === '') {
    process.stderr.write('Error: Missing query. Usage: listener search <query> [--limit <n>] [--transcript] [--field <name>]\n');
    process.exit(1);
  }

  const dataPath = getDataPath();
  const fields = resolveFields({ field, includeTranscript });
  const hits = searchTranscriptions(dataPath, { query, fields, limit });

  if (hits.length === 0) {
    process.stderr.write('No results.\n');
    return;
  }

  for (const hit of hits) {
    const date = hit.entry.transcribedAt ? hit.entry.transcribedAt.slice(0, 10) : '          ';
    const title = hit.data.title.length > 60 ? hit.data.title.slice(0, 57) + '...' : hit.data.title;
    process.stdout.write(`${date}  ${title}\n`);
    process.stdout.write(`  ref:     ${hit.entry.folderName}\n`);
    process.stdout.write(`  matches: ${hit.matchedFields.join(', ')}\n`);
    if (hit.snippet) {
      process.stdout.write(`  ${hit.snippet}\n`);
    }
    process.stdout.write('\n');
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    usage();
  }

  if (args[0] === 'config') {
    handleConfig(args.slice(1));
    return;
  }

  if (args[0] === 'list') {
    handleList(args.slice(1));
    return;
  }

  if (args[0] === 'show') {
    handleShow(args.slice(1));
    return;
  }

  if (args[0] === 'export') {
    handleExport(args.slice(1));
    return;
  }

  if (args[0] === 'search') {
    handleSearch(args.slice(1));
    return;
  }

  // Parse arguments
  let filePath: string | undefined;
  let outputDir: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' && i + 1 < args.length) {
      outputDir = args[++i];
    } else if (args[i].startsWith('-')) {
      process.stderr.write(`Error: Unknown option: ${args[i]}\n`);
      usage();
    } else {
      filePath = args[i];
    }
  }

  if (!filePath) {
    process.stderr.write('Error: No audio file specified.\n');
    usage();
  }

  // Resolve to absolute path
  filePath = path.resolve(filePath);

  if (!fs.existsSync(filePath)) {
    process.stderr.write(`Error: File not found: ${filePath}\n`);
    process.exit(1);
  }

  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    process.stderr.write(`Error: Unsupported file type: ${ext}\n`);
    process.stderr.write(`Supported formats: ${[...SUPPORTED_EXTENSIONS].join(', ')}\n`);
    process.exit(1);
  }

  // Resolve --output if provided
  if (outputDir) {
    outputDir = path.resolve(outputDir);
  }

  // Get API key
  const dataPath = getDataPath();
  const config = new ConfigService(dataPath);
  const apiKey = config.getGeminiApiKey();

  if (!apiKey) {
    process.stderr.write(
      'Error: Gemini API key not found.\n' +
      'Set GEMINI_API_KEY env var or configure via the Listener.AI app.\n'
    );
    process.exit(1);
  }

  const gemini = new GeminiService({
    apiKey,
    dataPath,
    knownWords: config.getKnownWords(),
    proModel: config.getGeminiModel(),
    flashModel: config.getGeminiFlashModel(),
  });

  process.stderr.write(`Processing: ${filePath}\n`);

  const result = await gemini.transcribeAudio(filePath, (_percent, message) => {
    process.stderr.write(`  ${message}\n`);
  });

  const title = result.suggestedTitle || path.basename(filePath, path.extname(filePath));

  const folderPath = saveTranscription({
    title,
    result,
    audioFilePath: filePath,
    outputDir,
    dataPath,
  });

  process.stderr.write(`Done.\n`);

  // Print folder path to stdout for piping
  process.stdout.write(`${folderPath}\n`);
}

main().catch((err) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
