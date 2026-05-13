#!/usr/bin/env node

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as readline from 'readline';
import * as path from 'path';
import { type AgentScope, AgentService, type ConfigProposal } from './agentService';
import { isAiProvider } from './aiProvider';
import { extensionForMimeType } from './audioFormats';
import { type AppConfig, ConfigService } from './configService';
import { loginCodexOAuth } from './codexOAuth';
import { getDataPath } from './dataPath';
import { GeminiService } from './geminiService';
import {
  formatTimestamp,
  getTranscriptionsDir,
  listTranscriptions,
  parseFrontmatter,
  parseHighlightsField,
  parseLiveNotesField,
  readTranscription,
  sanitizeForPath,
  saveTranscription,
} from './outputService';
import { ALL_FIELDS, type SearchField, resolveFields, searchTranscriptions } from './searchService';
import { concatAudioFiles } from './services/audioConcatService';
import { FFmpegManager } from './services/ffmpegManager';

const SUPPORTED_EXTENSIONS = new Set([
  '.mp3',
  '.m4a',
  '.wav',
  '.ogg',
  '.flac',
  '.aac',
  '.wma',
  '.opus',
  '.webm',
]);

const VERSION = (() => {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

const USAGE_TEXT =
  'Usage: listener <file> [--output <dir>]    Transcribe an audio file into a meeting note\n' +
  '       listener transcript <file> [--output <path>] [--prompt <text>]\n' +
  '                                           Transcribe to plain text only (no summary)\n' +
  '       listener list [--limit <n>]         List past transcriptions\n' +
  '       listener show <ref>                 Print summary to stdout\n' +
  '       listener export <ref> [<path>] [--json] [--transcript]\n' +
  '                                           Export transcription\n' +
  '       listener search <query> [--limit <n>] [--transcript] [--field <name>]\n' +
  '                                           Search past transcriptions\n' +
  '       listener merge <ref1> <ref2> [<ref3>...] [--title <t>]\n' +
  '                                           Concat the source audio of two or more notes,\n' +
  '                                           re-transcribe end-to-end, and save as a new note\n' +
  '       listener ask <question> [--ref <ref>]\n' +
  '                                           Ask the AI agent about saved meetings or settings\n' +
  '       listener codex login|logout|status  Manage OpenAI Codex OAuth sign-in\n' +
  '       listener config list|get|set|unset|path\n' +
  '                                           Manage configuration\n' +
  '\n' +
  '<ref> is a number from `listener list` or a folder name.\n' +
  '\n' +
  'Options:\n' +
  '  --output, -o <path>\n' +
  '                   Parent directory for the output folder (transcribe);\n' +
  '                   destination file or directory (transcript)\n' +
  '  --prompt <text>  Override the default transcription instruction (transcript)\n' +
  '  --limit <n>      Max results (0 = all, default: 20)\n' +
  '  --json           Export as JSON instead of markdown\n' +
  '  --transcript     Include transcript body (export: append; search: widen scope)\n' +
  '  --field <name>   Restrict search to one of: title, summary, keyPoints, actionItems, transcript, all\n' +
  '  --version, -V    Print CLI version\n' +
  '  --help, -h       Show this help message\n';

function usageError(): never {
  process.stderr.write(USAGE_TEXT);
  process.exit(1);
}

function showHelp(): never {
  process.stdout.write(USAGE_TEXT);
  process.exit(0);
}

const KNOWN_CONFIG_KEYS = [
  'aiProvider',
  'geminiApiKey',
  'geminiModel',
  'geminiFlashModel',
  'codexModel',
  'codexTranscriptionModel',
  'notionApiKey',
  'notionDatabaseId',
  'autoMode',
  'meetingDetection',
  'displayDetection',
  'globalShortcut',
  'knownWords',
  'summaryPrompt',
  'maxRecordingMinutes',
  'recordingReminderMinutes',
  'minRecordingSeconds',
  'recordSystemAudio',
  'slackWebhookUrl',
  'slackAutoShare',
] as const;
type ConfigKey = (typeof KNOWN_CONFIG_KEYS)[number];

function isSensitiveKey(key: string): boolean {
  const lk = key.toLowerCase();
  return lk.includes('key') || lk.includes('webhook') || lk.includes('oauth');
}

function maskValue(key: string, value: unknown): string {
  if (value == null || value === '') return '(not set)';
  if (Array.isArray(value)) {
    if (value.length === 0) return '(none)';
    const joined = value.map((x) => String(x)).join(', ');
    return joined.length > 60 ? `${joined.slice(0, 57)}...` : joined;
  }
  const str = String(value);
  if (isSensitiveKey(key)) {
    return str.length > 4 ? `****${str.slice(-4)}` : '****';
  }
  if (str.length > 60) return `${str.slice(0, 57)}...`;
  return str;
}

function parseBool(key: string, v: string): boolean {
  if (v !== 'true' && v !== 'false') {
    process.stderr.write(`Error: ${key} must be "true" or "false"\n`);
    process.exit(1);
  }
  return v === 'true';
}

function parseNonNegInt(key: string, v: string): number {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n) || n < 0 || String(n) !== v.trim()) {
    process.stderr.write(`Error: ${key} must be a non-negative integer\n`);
    process.exit(1);
  }
  return n;
}

function parseKnownWords(v: string): string[] {
  return v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function applyConfigSet(config: ConfigService, key: ConfigKey, value: string): void {
  switch (key) {
    case 'aiProvider': {
      if (!isAiProvider(value)) {
        process.stderr.write('Error: aiProvider must be "gemini" or "codex"\n');
        process.exit(1);
      }
      config.setAiProvider(value);
      return;
    }
    case 'geminiApiKey':
      config.setGeminiApiKey(value);
      return;
    case 'geminiModel':
      config.setGeminiModel(value);
      return;
    case 'geminiFlashModel':
      config.setGeminiFlashModel(value);
      return;
    case 'codexModel':
      config.setCodexModel(value);
      return;
    case 'codexTranscriptionModel':
      config.setCodexTranscriptionModel(value);
      return;
    case 'notionApiKey':
      config.setNotionApiKey(value);
      return;
    case 'notionDatabaseId':
      config.setNotionDatabaseId(value);
      return;
    case 'autoMode':
      config.setAutoMode(parseBool('autoMode', value));
      return;
    case 'meetingDetection':
      config.updateConfig({ meetingDetection: parseBool('meetingDetection', value) });
      return;
    case 'displayDetection':
      config.setDisplayDetection(parseBool('displayDetection', value));
      return;
    case 'globalShortcut':
      config.setGlobalShortcut(value);
      return;
    case 'knownWords':
      config.setKnownWords(parseKnownWords(value));
      return;
    case 'summaryPrompt':
      config.setSummaryPrompt(value);
      return;
    case 'maxRecordingMinutes':
      config.setMaxRecordingMinutes(parseNonNegInt('maxRecordingMinutes', value));
      return;
    case 'recordingReminderMinutes':
      config.setRecordingReminderMinutes(parseNonNegInt('recordingReminderMinutes', value));
      return;
    case 'minRecordingSeconds':
      config.setMinRecordingSeconds(parseNonNegInt('minRecordingSeconds', value));
      return;
    case 'recordSystemAudio':
      config.setRecordSystemAudio(parseBool('recordSystemAudio', value));
      return;
    case 'slackWebhookUrl':
      config.setSlackWebhookUrl(value);
      return;
    case 'slackAutoShare':
      config.setSlackAutoShare(parseBool('slackAutoShare', value));
      return;
  }
}

function formatAiCredentialsError(config: ConfigService): string {
  if (config.getAiProvider() === 'codex') {
    return (
      'Error: Codex OAuth is not configured.\n' +
      'Run `listener codex login` or set aiProvider back to gemini with a Gemini API key.\n'
    );
  }
  return (
    'Error: Gemini API key not found.\n' +
    'Set GEMINI_API_KEY env var, run `listener config set geminiApiKey <key>`, or run `listener codex login`.\n'
  );
}

function createTranscriptionService(config: ConfigService, dataPath: string): GeminiService {
  return new GeminiService({
    provider: config.getAiProvider(),
    apiKey: config.getGeminiApiKey(),
    codexOAuth: config.getCodexOAuth(),
    onCodexOAuthUpdate: (credentials) => config.setCodexOAuth(credentials),
    dataPath,
    knownWords: config.getKnownWords(),
    proModel: config.getGeminiModel(),
    flashModel: config.getGeminiFlashModel(),
    codexModel: config.getCodexModel(),
    codexTranscriptionModel: config.getCodexTranscriptionModel(),
  });
}

function createAgentService(config: ConfigService, dataPath: string): AgentService {
  return new AgentService({
    provider: config.getAiProvider(),
    apiKey: config.getGeminiApiKey(),
    codexOAuth: config.getCodexOAuth(),
    onCodexOAuthUpdate: (credentials) => config.setCodexOAuth(credentials),
    dataPath,
    configService: config,
    codexModel: config.getCodexModel(),
  });
}

function promptLine(message: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(`${message} `, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function handleCodex(args: string[]): Promise<void> {
  const sub = args[0];
  const dataPath = getDataPath();
  const config = new ConfigService(dataPath);

  if (sub === 'status') {
    process.stdout.write(`aiProvider=${config.getAiProvider()}\n`);
    process.stdout.write(`codexOAuthConfigured=${config.hasCodexOAuth()}\n`);
    process.stdout.write(`codexModel=${config.getCodexModel()}\n`);
    process.stdout.write(`codexTranscriptionModel=${config.getCodexTranscriptionModel()}\n`);
    return;
  }

  if (sub === 'logout') {
    config.clearCodexOAuth();
    process.stderr.write('Signed out of Codex OAuth.\n');
    return;
  }

  if (sub !== 'login') {
    process.stderr.write(
      'Error: Unknown codex command. Usage: listener codex login|logout|status\n',
    );
    process.exit(1);
  }

  const credentials = await loginCodexOAuth({
    openUrl: (url) => {
      process.stderr.write(`Open this URL in your browser:\n${url}\n`);
    },
    onPrompt: async (prompt) => await promptLine(prompt.message),
    onProgress: (message) => process.stderr.write(`${message}\n`),
  });
  config.setCodexOAuth(credentials);
  config.setAiProvider('codex');
  process.stderr.write('Signed in with Codex OAuth and set aiProvider=codex.\n');
}

function handleConfig(subArgs: string[]): void {
  const dataPath = getDataPath();
  const config = new ConfigService(dataPath);
  const sub = subArgs[0];

  if (!sub) {
    usageError();
  }

  if (sub === '--help' || sub === '-h') {
    showHelp();
  }

  if (sub === 'path') {
    process.stdout.write(`${config.getConfigPath()}\n`);
    return;
  }

  if (sub === 'list') {
    const all = config.getAllConfig();
    for (const key of KNOWN_CONFIG_KEYS) {
      const raw = all[key as keyof typeof all];
      process.stdout.write(`${key}=${maskValue(key, raw)}\n`);
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
    if (Array.isArray(val)) {
      process.stdout.write(`${val.join(',')}\n`);
    } else {
      process.stdout.write(`${val ?? ''}\n`);
    }
    return;
  }

  if (sub === 'set') {
    const key = subArgs[1] as ConfigKey;
    const value = subArgs[2];
    if (!key || value == null) {
      process.stderr.write(
        'Error: Missing key or value. Usage: listener config set <key> <value>\n',
      );
      process.exit(1);
    }
    if (!KNOWN_CONFIG_KEYS.includes(key)) {
      process.stderr.write(`Error: Unknown key: ${key}\n`);
      process.stderr.write(`Known keys: ${KNOWN_CONFIG_KEYS.join(', ')}\n`);
      process.exit(1);
    }
    applyConfigSet(config, key, value);
    process.stderr.write(`Set ${key}\n`);
    return;
  }

  if (sub === 'unset') {
    const key = subArgs[1] as ConfigKey;
    if (!key) {
      process.stderr.write('Error: Missing key. Usage: listener config unset <key>\n');
      process.exit(1);
    }
    if (!KNOWN_CONFIG_KEYS.includes(key)) {
      process.stderr.write(`Error: Unknown key: ${key}\n`);
      process.stderr.write(`Known keys: ${KNOWN_CONFIG_KEYS.join(', ')}\n`);
      process.exit(1);
    }
    config.unsetKey(key as keyof AppConfig);
    process.stderr.write(`Unset ${key}\n`);
    return;
  }

  process.stderr.write(`Error: Unknown config command: ${sub}\n`);
  usageError();
}

async function resolveRef(ref: string, dataPath: string): Promise<string> {
  if (/^\d+$/.test(ref)) {
    const index = Number.parseInt(ref, 10);
    const entries = await listTranscriptions(dataPath, 0);
    if (entries.length === 0) {
      process.stderr.write('Error: No transcriptions found.\n');
      process.exit(1);
    }
    if (index < 1 || index > entries.length) {
      process.stderr.write(
        `Error: Invalid index ${index}. Run 'listener list' to see available entries (1-${entries.length}).\n`,
      );
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

async function handleList(args: string[]): Promise<void> {
  const dataPath = getDataPath();
  let limit: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && i + 1 < args.length) {
      limit = Number.parseInt(args[++i], 10);
      if (Number.isNaN(limit) || limit < 0) {
        process.stderr.write('Error: --limit must be a non-negative integer\n');
        process.exit(1);
      }
    }
  }
  const entries = await listTranscriptions(dataPath, limit);
  if (entries.length === 0) {
    process.stderr.write('No transcriptions found.\n');
    return;
  }
  process.stdout.write(' #  Date        Title\n');
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const num = String(i + 1).padStart(2, ' ');
    const date = e.transcribedAt ? e.transcribedAt.slice(0, 10) : '          ';
    const title = e.title.length > 60 ? `${e.title.slice(0, 57)}...` : e.title;
    process.stdout.write(`${num}  ${date}  ${title}\n`);
  }
}

async function handleShow(args: string[]): Promise<void> {
  const ref = args[0];
  if (!ref) {
    process.stderr.write('Error: Missing ref. Usage: listener show <ref>\n');
    process.exit(1);
  }
  const dataPath = getDataPath();
  const folderPath = await resolveRef(ref, dataPath);
  const summaryPath = path.join(folderPath, 'summary.md');
  if (!fs.existsSync(summaryPath)) {
    process.stderr.write(`Error: summary.md not found in ${folderPath}\n`);
    process.exit(1);
  }
  const content = fs.readFileSync(summaryPath, 'utf-8');
  const { body } = parseFrontmatter(content);
  process.stdout.write(body);
}

async function handleExport(args: string[]): Promise<void> {
  let ref: string | undefined;
  let targetPath: string | undefined;
  let json = false;
  let includeTranscript = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') {
      json = true;
      continue;
    }
    if (args[i] === '--transcript') {
      includeTranscript = true;
      continue;
    }
    if (args[i].startsWith('-')) {
      process.stderr.write(`Error: Unknown option: ${args[i]}\n`);
      process.exit(1);
    }
    if (!ref) {
      ref = args[i];
      continue;
    }
    if (!targetPath) {
      targetPath = args[i];
    }
  }

  if (!ref) {
    process.stderr.write(
      'Error: Missing ref. Usage: listener export <ref> [<path>] [--json] [--transcript]\n',
    );
    process.exit(1);
  }

  const dataPath = getDataPath();
  const folderPath = await resolveRef(ref, dataPath);
  const summaryPath = path.join(folderPath, 'summary.md');

  if (!fs.existsSync(summaryPath)) {
    process.stderr.write(`Error: summary.md not found in ${folderPath}\n`);
    process.exit(1);
  }

  // Copy files to target path
  if (targetPath && (json || includeTranscript)) {
    process.stderr.write(
      'Error: --json and --transcript are only supported when writing to stdout (omit <path>)\n',
    );
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
        customFields =
          typeof meta.customFields === 'string'
            ? JSON.parse(meta.customFields as string)
            : (meta.customFields as Record<string, unknown>);
      } catch {
        /* ignore */
      }
    }
    const liveNotes = parseLiveNotesField(meta.liveNotes);
    const highlights = parseHighlightsField(meta.highlights);
    const obj: Record<string, unknown> = {
      title: meta.title || '',
      transcribedAt: meta.transcribedAt || '',
      summary: meta.summary || '',
      keyPoints: meta.keyPoints || [],
      actionItems: meta.actionItems || [],
      customFields,
      ...(liveNotes ? { liveNotes } : {}),
      ...(highlights ? { highlights } : {}),
    };
    if (includeTranscript) {
      obj.transcript = meta.transcript || '';
    }
    process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  } else {
    process.stdout.write(body);
    if (includeTranscript) {
      const transcriptPath = path.join(folderPath, 'transcript.md');
      if (fs.existsSync(transcriptPath)) {
        const transcriptContent = fs.readFileSync(transcriptPath, 'utf-8');
        process.stdout.write(`\n${transcriptContent}`);
      }
    }
  }
}

async function handleSearch(args: string[]): Promise<void> {
  const VALID_FIELDS = [...ALL_FIELDS, 'all'] as const;
  let query: string | undefined;
  let limit = 20;
  let includeTranscript = false;
  let field: SearchField | 'all' | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--limit' && i + 1 < args.length) {
      const n = Number.parseInt(args[++i], 10);
      if (Number.isNaN(n) || n < 0) {
        process.stderr.write('Error: --limit must be a non-negative integer\n');
        process.exit(1);
      }
      limit = n;
      continue;
    }
    if (a === '--transcript') {
      includeTranscript = true;
      continue;
    }
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
    if (!query) {
      query = a;
      continue;
    }
    process.stderr.write(`Error: Unexpected argument: ${a} (quote multi-word queries)\n`);
    process.exit(1);
  }

  if (!query || query.trim() === '') {
    process.stderr.write(
      'Error: Missing query. Usage: listener search <query> [--limit <n>] [--transcript] [--field <name>]\n',
    );
    process.exit(1);
  }

  const dataPath = getDataPath();
  const fields = resolveFields({ field, includeTranscript });
  const hits = await searchTranscriptions(dataPath, { query, fields, limit });

  if (hits.length === 0) {
    process.stderr.write('No results.\n');
    return;
  }

  for (const hit of hits) {
    const date = hit.entry.transcribedAt ? hit.entry.transcribedAt.slice(0, 10) : '          ';
    const title = hit.data.title.length > 60 ? `${hit.data.title.slice(0, 57)}...` : hit.data.title;
    process.stdout.write(`${date}  ${title}\n`);
    process.stdout.write(`  ref:     ${hit.entry.folderName}\n`);
    process.stdout.write(`  matches: ${hit.matchedFields.join(', ')}\n`);
    if (hit.snippet) {
      process.stdout.write(`  ${hit.snippet}\n`);
    }
    process.stdout.write('\n');
  }
}

async function promptYesNo(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stderr.write(`${message} [y/N] `);
    const stdin = process.stdin;
    const onData = (chunk: Buffer) => {
      stdin.off('data', onData);
      stdin.pause();
      const answer = chunk.toString('utf-8').trim().toLowerCase();
      resolve(answer === 'y' || answer === 'yes');
    };
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function handleMerge(args: string[]): Promise<void> {
  const refs: string[] = [];
  let title: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--title' && i + 1 < args.length) {
      title = args[++i];
      continue;
    }
    if (a.startsWith('-')) {
      process.stderr.write(`Error: Unknown option: ${a}\n`);
      process.exit(1);
    }
    refs.push(a);
  }

  if (refs.length < 2) {
    process.stderr.write(
      'Error: merge requires at least 2 refs. Usage: listener merge <ref1> <ref2> [<ref3>...] [--title <t>]\n',
    );
    process.exit(1);
  }

  const dataPath = getDataPath();
  const config = new ConfigService(dataPath);
  if (!config.hasAiAuth()) {
    process.stderr.write(formatAiCredentialsError(config));
    process.exit(1);
  }

  // Resolve every ref to a folder + audio path before doing any expensive work
  // so an early failure (missing audio) doesn't waste a partial concat.
  const sources: Array<{ folderName: string; audioPath: string }> = [];
  for (const ref of refs) {
    const folderPath = await resolveRef(ref, dataPath);
    const data = await readTranscription(folderPath);
    if (!data || !data.audioFilePath) {
      process.stderr.write(
        `Error: ${ref} has no audioFilePath in its frontmatter; cannot include it in a merge.\n`,
      );
      process.exit(1);
    }
    if (!fs.existsSync(data.audioFilePath)) {
      process.stderr.write(`Error: source audio missing for ${ref}: ${data.audioFilePath}\n`);
      process.exit(1);
    }
    sources.push({ folderName: path.basename(folderPath), audioPath: data.audioFilePath });
  }

  const ffmpegManager = new FFmpegManager(dataPath);
  const ffmpegPath = await ffmpegManager.ensureFFmpeg();
  if (!ffmpegPath) {
    process.stderr.write(
      'Error: ffmpeg not found. Install ffmpeg or run a transcription in the GUI to download it.\n',
    );
    process.exit(1);
  }

  const safeTitle = sanitizeForPath(title?.trim() || 'Merged Meeting') || 'Merged Meeting';
  const recordingsDir = path.join(dataPath, 'recordings');
  fs.mkdirSync(recordingsDir, { recursive: true });
  // UUID suffix avoids filename collision when two CLI merges with the same
  // title start in the same second (formatTimestamp is second-granularity).
  const mergedAudioPath = path.join(
    recordingsDir,
    `${safeTitle}_${formatTimestamp()}_${randomUUID().slice(0, 8)}.${extensionForMimeType('audio/webm')}`,
  );

  process.stderr.write(`Merging ${sources.length} recordings...\n`);
  await concatAudioFiles({
    ffmpegPath,
    inputPaths: sources.map((s) => s.audioPath),
    outputPath: mergedAudioPath,
  });
  process.stderr.write(`  -> ${mergedAudioPath}\n`);

  const gemini = createTranscriptionService(config, dataPath);

  process.stderr.write('Transcribing merged recording...\n');
  const result = await gemini.transcribeAudio(
    mergedAudioPath,
    (_percent, message) => {
      process.stderr.write(`  ${message}\n`);
    },
    config.getSummaryPrompt(),
  );

  // User-supplied --title wins; Gemini's suggestion is the fallback.
  const finalTitle = title?.trim() || result.suggestedTitle || 'Merged Meeting';
  const folderPath = saveTranscription({
    title: finalTitle,
    result,
    audioFilePath: mergedAudioPath,
    dataPath,
    mergedFrom: sources.map((s) => s.folderName),
  });

  process.stderr.write('Done.\n');
  process.stdout.write(`${folderPath}\n`);
}

async function handleAsk(args: string[]): Promise<void> {
  let question: string | undefined;
  let ref: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--ref' && i + 1 < args.length) {
      ref = args[++i];
      continue;
    }
    if (a.startsWith('-')) {
      process.stderr.write(`Error: Unknown option: ${a}\n`);
      process.exit(1);
    }
    if (!question) {
      question = a;
      continue;
    }
    process.stderr.write(`Error: Unexpected argument: ${a} (quote multi-word questions)\n`);
    process.exit(1);
  }

  if (!question || question.trim() === '') {
    process.stderr.write('Error: Missing question. Usage: listener ask <question> [--ref <ref>]\n');
    process.exit(1);
  }

  const dataPath = getDataPath();
  const config = new ConfigService(dataPath);
  if (!config.hasAiAuth()) {
    process.stderr.write(formatAiCredentialsError(config));
    process.exit(1);
  }

  let scope: AgentScope = { kind: 'all' };
  if (ref) {
    const folderPath = await resolveRef(ref, dataPath);
    scope = { kind: 'single', folderName: path.basename(folderPath) };
  }

  const agent = createAgentService(config, dataPath);

  const confirm = async (proposal: ConfigProposal): Promise<boolean> => {
    process.stderr.write('\n');
    return promptYesNo(`Proposed change -> ${proposal.description}\nApply?`);
  };

  const result = await agent.run({ question, scope, confirm });
  process.stdout.write(`${result.answer}\n`);
  if (result.appliedActions.length > 0) {
    process.stderr.write('\nApplied:\n');
    for (const action of result.appliedActions) {
      process.stderr.write(
        `  ${action.key}: ${JSON.stringify(action.previousValue ?? null)} -> ${JSON.stringify(action.value)}\n`,
      );
    }
  }
}

async function handleTranscript(args: string[]): Promise<void> {
  let filePath: string | undefined;
  let outputArg: string | undefined;
  let promptText: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '--output' || a === '-o') && i + 1 < args.length) {
      outputArg = args[++i];
      continue;
    }
    if (a === '--prompt' && i + 1 < args.length) {
      promptText = args[++i];
      continue;
    }
    if (a.startsWith('-')) {
      process.stderr.write(`Error: Unknown option: ${a}\n`);
      process.exit(1);
    }
    if (filePath) {
      process.stderr.write(`Error: Unexpected argument: ${a}\n`);
      process.exit(1);
    }
    filePath = a;
  }

  if (!filePath) {
    process.stderr.write(
      'Error: No audio file specified. Usage: listener transcript <file> [--output <path>] [--prompt <text>]\n',
    );
    process.exit(1);
  }

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

  const dataPath = getDataPath();
  const config = new ConfigService(dataPath);
  if (!config.hasAiAuth()) {
    process.stderr.write(formatAiCredentialsError(config));
    process.exit(1);
  }

  // Resolve --output before the expensive transcription so we fail fast on a
  // bad path. Existing directory => <dir>/<basename>.transcript.md.
  // Anything else => the path itself, treated as a file.
  let outputPath: string | undefined;
  if (outputArg) {
    const resolved = path.resolve(outputArg);
    let isDir = false;
    try {
      isDir = fs.statSync(resolved).isDirectory();
    } catch {
      // ENOENT or similar: treat as a file path, validated below.
    }
    if (isDir) {
      outputPath = path.join(resolved, `${path.basename(filePath, ext)}.transcript.md`);
    } else {
      outputPath = resolved;
      const parent = path.dirname(outputPath);
      if (!fs.existsSync(parent)) {
        process.stderr.write(`Error: Output directory does not exist: ${parent}\n`);
        process.exit(1);
      }
    }
  }

  const gemini = createTranscriptionService(config, dataPath);

  process.stderr.write(`Processing: ${filePath}\n`);

  const result = await gemini.transcribeAudio(
    filePath,
    (_percent, message) => {
      process.stderr.write(`  ${message}\n`);
    },
    undefined,
    undefined,
    { transcriptOnly: true, transcriptionPrompt: promptText },
  );

  if (outputPath) {
    fs.writeFileSync(outputPath, result.transcript, 'utf-8');
    process.stderr.write('Done.\n');
    process.stdout.write(`${outputPath}\n`);
  } else {
    // Wait for the OS to drain the write before returning, so multi-MB
    // transcripts piped to a slow consumer are not truncated on process exit.
    const out = result.transcript.endsWith('\n') ? result.transcript : `${result.transcript}\n`;
    await new Promise<void>((resolve) => process.stdout.write(out, () => resolve()));
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--version') || args.includes('-V')) {
    process.stdout.write(`listener ${VERSION}\n`);
    return;
  }

  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
  }

  if (args.length === 0) {
    usageError();
  }

  if (args[0] === 'config') {
    handleConfig(args.slice(1));
    return;
  }

  if (args[0] === 'codex') {
    await handleCodex(args.slice(1));
    return;
  }

  if (args[0] === 'list') {
    await handleList(args.slice(1));
    return;
  }

  if (args[0] === 'show') {
    await handleShow(args.slice(1));
    return;
  }

  if (args[0] === 'export') {
    await handleExport(args.slice(1));
    return;
  }

  if (args[0] === 'search') {
    await handleSearch(args.slice(1));
    return;
  }

  if (args[0] === 'merge') {
    await handleMerge(args.slice(1));
    return;
  }

  if (args[0] === 'ask') {
    await handleAsk(args.slice(1));
    return;
  }

  if (args[0] === 'transcript') {
    await handleTranscript(args.slice(1));
    return;
  }

  // Parse arguments
  let filePath: string | undefined;
  let outputDir: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--output' || args[i] === '-o') && i + 1 < args.length) {
      outputDir = args[++i];
    } else if (args[i].startsWith('-')) {
      process.stderr.write(`Error: Unknown option: ${args[i]}\n`);
      usageError();
    } else {
      filePath = args[i];
    }
  }

  if (!filePath) {
    process.stderr.write('Error: No audio file specified.\n');
    usageError();
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

  const dataPath = getDataPath();
  const config = new ConfigService(dataPath);
  if (!config.hasAiAuth()) {
    process.stderr.write(formatAiCredentialsError(config));
    process.exit(1);
  }

  const gemini = createTranscriptionService(config, dataPath);

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

  process.stderr.write('Done.\n');

  // Print folder path to stdout for piping
  process.stdout.write(`${folderPath}\n`);
}

main().catch((err) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
