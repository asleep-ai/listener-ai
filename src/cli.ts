#!/usr/bin/env node

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as readline from 'readline';
import * as path from 'path';
import { type AgentScope, AgentService, type ConfigProposal } from './agentService';
import { GEMINI_THINKING_LEVELS, isAiProvider, normalizeGeminiThinkingLevel } from './aiProvider';
import { extensionForMimeType, mimeTypeForFile } from './audioFormats';
import { type AppConfig, ConfigService } from './configService';
import { loginCodexOAuth } from './codexOAuth';
import { getDataPath } from './dataPath';
import { GeminiService } from './geminiService';
import { loginGoogleOAuth, resolveGoogleAccessToken } from './googleOAuth';
import { GoogleDriveClient, uploadMeetingFolder } from './services/googleDriveService';
import { SyncEngine } from './services/syncEngine';
import {
  ACTION_ITEMS_FILE,
  HIGHLIGHTS_JSON_FILE,
  KEY_POINTS_FILE,
  META_JSON,
  NOTES_JSON_FILE,
  SUMMARY_FILE,
  TRANSCRIPT_FILE,
  autoMigrateLegacyOnStartup,
  formatSummary,
  formatTimestamp,
  getTranscriptionsDir,
  isV2Folder,
  listTranscriptions,
  migrateV1ToV2,
  readTranscription,
  sanitizeForPath,
  saveTranscription,
} from './outputService';
import { ALL_FIELDS, type SearchField, resolveFields, searchTranscriptions } from './searchService';
import { concatAudioFiles } from './services/audioConcatService';
import { FFmpegManager } from './services/ffmpegManager';
import { currentMonthString, formatUsd, monthRange, summarizeUsage } from './services/usageTracker';

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

/** Commands that don't trigger the one-shot v1->v2 startup migration:
 * - `config`/`codex` never touch the transcriptions directory.
 * - `migrate` IS the migration command itself; its own loop scans for v1
 *   folders. Running the startup auto-migrate first would convert everything
 *   to v2 before `--dry-run` could observe it. The `migrate` handler is
 *   responsible for any conversion it does. */
const COMMANDS_WITHOUT_DATA_ACCESS = new Set(['config', 'codex', 'migrate']);

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
  '       listener google login|logout|status Manage Google Drive OAuth sign-in\n' +
  '       listener google upload <ref>        Upload a meeting folder to Google Drive\n' +
  '       listener google sync                Sync all meetings to Google Drive (upload changes only)\n' +
  '       listener config list|get|set|unset|path\n' +
  '                                           Manage configuration\n' +
  '       listener usage [--month YYYY-MM] [--json]\n' +
  '                                           Show estimated API spend (best-effort, default: current month)\n' +
  '       listener migrate <ref> | --all [--dry-run]\n' +
  '                                           Migrate one or all transcription folders from the legacy\n' +
  '                                           single-summary.md layout to the v2 multi-file layout\n' +
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
  'geminiThinkingLevel',
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
    case 'geminiThinkingLevel': {
      const level = normalizeGeminiThinkingLevel(value);
      if (!level) {
        process.stderr.write(
          `Error: geminiThinkingLevel must be one of: ${GEMINI_THINKING_LEVELS.join(', ')}\n`,
        );
        process.exit(1);
      }
      config.setGeminiThinkingLevel(level);
      return;
    }
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
    // Persist refreshed tokens only when credentials are stored in config.json.
    // Env-only credentials must stay ephemeral; persisting them silently writes
    // env-provided OAuth tokens to disk on every refresh.
    onCodexOAuthUpdate: config.hasStoredCodexOAuth()
      ? (credentials) => config.setCodexOAuth(credentials)
      : undefined,
    dataPath,
    knownWords: config.getKnownWords(),
    proModel: config.getGeminiModel(),
    flashModel: config.getGeminiFlashModel(),
    thinkingLevel: config.getGeminiThinkingLevel(),
    codexModel: config.getCodexModel(),
    codexTranscriptionModel: config.getCodexTranscriptionModel(),
  });
}

function createAgentService(config: ConfigService, dataPath: string): AgentService {
  return new AgentService({
    provider: config.getAiProvider(),
    apiKey: config.getGeminiApiKey(),
    codexOAuth: config.getCodexOAuth(),
    // See note in createTranscriptionService(): persist only for stored creds.
    onCodexOAuthUpdate: config.hasStoredCodexOAuth()
      ? (credentials) => config.setCodexOAuth(credentials)
      : undefined,
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

async function handleGoogle(args: string[]): Promise<void> {
  const sub = args[0];
  const dataPath = getDataPath();
  const config = new ConfigService(dataPath);

  if (sub === 'status') {
    const creds = config.getGoogleOAuth();
    process.stdout.write(`googleOAuthConfigured=${config.hasGoogleOAuth()}\n`);
    process.stdout.write(`googleOAuthStored=${config.hasStoredGoogleOAuth()}\n`);
    if (creds?.email) {
      process.stdout.write(`googleAccountEmail=${creds.email}\n`);
    }
    return;
  }

  if (sub === 'logout') {
    config.clearGoogleOAuth();
    process.stderr.write('Signed out of Google Drive OAuth.\n');
    return;
  }

  if (sub === 'upload') {
    await handleGoogleUpload(args.slice(1), config, dataPath);
    return;
  }

  if (sub === 'sync') {
    await handleGoogleSync(config, dataPath);
    return;
  }

  if (sub !== 'login') {
    process.stderr.write(
      'Error: Unknown google command. Usage: listener google login|logout|status|upload|sync\n',
    );
    process.exit(1);
  }

  const credentials = await loginGoogleOAuth({
    openUrl: (url) => {
      process.stderr.write(`Open this URL in your browser:\n${url}\n`);
    },
    onProgress: (message) => process.stderr.write(`${message}\n`),
  });
  config.setGoogleOAuth(credentials);
  const accountSuffix = credentials.email ? ` as ${credentials.email}` : '';
  process.stderr.write(`Signed in with Google Drive OAuth${accountSuffix}.\n`);
}

async function handleGoogleUpload(
  args: string[],
  config: ConfigService,
  dataPath: string,
): Promise<void> {
  const ref = args[0];
  if (!ref) {
    process.stderr.write('Error: Missing ref. Usage: listener google upload <ref>\n');
    process.exit(1);
  }

  const credentials = config.getGoogleOAuth();
  if (!credentials) {
    process.stderr.write(
      'Error: Not signed in to Google Drive. Run `listener google login` first.\n',
    );
    process.exit(1);
  }

  const folderPath = await resolveRef(ref, dataPath);
  const folderName = path.basename(folderPath);

  // Gather every regular file in the meeting folder. Drive mirrors the local
  // layout, so anything in the folder (summary, transcript, audio, optional
  // attachments) goes up. Hidden files (.DS_Store etc.) are skipped.
  const entries = fs.readdirSync(folderPath, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => {
      const filePath = path.join(folderPath, e.name);
      const content = fs.readFileSync(filePath);
      return {
        name: e.name,
        content,
        mimeType: mimeTypeForFile(e.name),
      };
    });

  if (files.length === 0) {
    process.stderr.write(`Error: No files to upload in ${folderPath}\n`);
    process.exit(1);
  }

  const client = new GoogleDriveClient({
    getAccessToken: async () => {
      const token = await resolveGoogleAccessToken({
        credentials,
        onCredentialsChanged: (next) => {
          // Only persist rotated tokens if the original came from disk -- env-
          // sourced creds should not silently leak into config.json. Mirrors
          // the Codex pattern.
          if (config.hasStoredGoogleOAuth()) config.setGoogleOAuth(next);
        },
      });
      if (!token) throw new Error('Failed to resolve Google access token.');
      return token;
    },
  });

  process.stderr.write(`Uploading "${folderName}" (${files.length} files) to Google Drive...\n`);
  const result = await uploadMeetingFolder({
    client,
    meetingFolderName: folderName,
    files,
  });

  process.stderr.write(`Uploaded to Listener.AI/${folderName}/:\n`);
  for (const f of result.uploaded) {
    process.stderr.write(`  - ${f.name} (${f.id})\n`);
  }
}

async function handleGoogleSync(config: ConfigService, dataPath: string): Promise<void> {
  const credentials = config.getGoogleOAuth();
  if (!credentials) {
    process.stderr.write(
      'Error: Not signed in to Google Drive. Run `listener google login` first.\n',
    );
    process.exit(1);
  }

  const client = new GoogleDriveClient({
    getAccessToken: async () => {
      const token = await resolveGoogleAccessToken({
        credentials,
        onCredentialsChanged: (next) => {
          if (config.hasStoredGoogleOAuth()) config.setGoogleOAuth(next);
        },
      });
      if (!token) throw new Error('Failed to resolve Google access token.');
      return token;
    },
  });

  const engine = new SyncEngine({
    driveClient: client,
    transcriptionsDir: getTranscriptionsDir(dataPath),
    syncStatePath: path.join(dataPath, 'sync-state.json'),
    logger: (msg) => process.stderr.write(`${msg}\n`),
  });

  process.stderr.write('Syncing meetings with Google Drive...\n');
  const result = await engine.syncOnce();

  process.stderr.write(
    `Done. Uploaded ${result.uploaded.length}, downloaded ${result.downloaded.length}, ` +
      `skipped ${result.skipped.length}, conflicts ${result.conflicts.length}, ` +
      `deleted ${result.deleted.length}, tombstoned ${result.tombstoned.length}, errors ${result.errors.length}.\n`,
  );
  for (const item of result.uploaded) process.stderr.write(`  + ${item}\n`);
  for (const item of result.downloaded) process.stderr.write(`  v ${item}\n`);
  for (const item of result.conflicts)
    process.stderr.write(`  ! conflict (LWW + backup): ${item}\n`);
  for (const item of result.tombstoned) process.stderr.write(`  - tombstoned: ${item}\n`);
  for (const item of result.deleted) process.stderr.write(`  x applied deletion: ${item}\n`);
  if (result.errors.length > 0) {
    process.stderr.write('\nErrors:\n');
    for (const e of result.errors) {
      process.stderr.write(`  x ${e.meeting}${e.file ? `/${e.file}` : ''}: ${e.error}\n`);
    }
    process.exit(1);
  }
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

  const md = await renderV2Markdown(folderPath);
  if (md === null) {
    process.stderr.write(`Error: could not read transcription at ${folderPath}\n`);
    process.exit(1);
  }
  process.stdout.write(md);
}

async function renderV2Markdown(folderPath: string): Promise<string | null> {
  const data = await readTranscription(folderPath);
  if (!data) return null;
  return formatSummary(data, data.title, data.mergedFrom, data.liveNotes, data.highlights);
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

  // meta.json is the v2 sentinel. Fires when migration was skipped
  // (`LISTENER_SKIP_AUTO_MIGRATE`) or the folder is corrupt.
  if (!isV2Folder(folderPath)) {
    process.stderr.write(`Error: ${META_JSON} not found in ${folderPath}\n`);
    process.exit(1);
  }

  if (targetPath && (json || includeTranscript)) {
    process.stderr.write(
      'Error: --json and --transcript are only supported when writing to stdout (omit <path>)\n',
    );
    process.exit(1);
  }
  if (targetPath) {
    targetPath = path.resolve(targetPath);
    fs.mkdirSync(targetPath, { recursive: true });
    copyExportedFiles(folderPath, targetPath);
    process.stderr.write(`Exported to ${targetPath}\n`);
    return;
  }

  if (json) {
    const data = await readTranscription(folderPath);
    if (!data) {
      process.stderr.write(`Error: could not read transcription at ${folderPath}\n`);
      process.exit(1);
    }
    const obj: Record<string, unknown> = {
      title: data.title || '',
      transcribedAt: data.transcribedAt || '',
      summary: data.summary || '',
      keyPoints: data.keyPoints ?? [],
      actionItems: data.actionItems ?? [],
      customFields: data.customFields ?? {},
      ...(data.liveNotes ? { liveNotes: data.liveNotes } : {}),
      ...(data.highlights ? { highlights: data.highlights } : {}),
    };
    if (includeTranscript) {
      obj.transcript = data.transcript || '';
    }
    process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  } else {
    const md = await renderV2Markdown(folderPath);
    if (md === null) {
      process.stderr.write(`Error: could not read transcription at ${folderPath}\n`);
      process.exit(1);
    }
    process.stdout.write(md);
    if (includeTranscript) {
      const transcriptPath = path.join(folderPath, TRANSCRIPT_FILE);
      if (fs.existsSync(transcriptPath)) {
        const transcriptContent = fs.readFileSync(transcriptPath, 'utf-8');
        process.stdout.write(`\n${transcriptContent}`);
      }
    }
  }
}

/** Whitelist known files so audio + ad-hoc artifacts stay local. */
function copyExportedFiles(folderPath: string, targetPath: string): void {
  const candidates = [
    META_JSON,
    SUMMARY_FILE,
    KEY_POINTS_FILE,
    ACTION_ITEMS_FILE,
    TRANSCRIPT_FILE,
    NOTES_JSON_FILE,
    HIGHLIGHTS_JSON_FILE,
  ];
  for (const name of candidates) {
    const src = path.join(folderPath, name);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(targetPath, name));
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

async function handleMigrate(args: string[]): Promise<void> {
  let dryRun = false;
  let all = false;
  let ref: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (a === '--all') {
      all = true;
      continue;
    }
    if (a.startsWith('-')) {
      process.stderr.write(`Error: Unknown option: ${a}\n`);
      process.exit(1);
    }
    if (!ref) {
      ref = a;
      continue;
    }
    process.stderr.write(`Error: Unexpected argument: ${a}\n`);
    process.exit(1);
  }

  if (!ref && !all) {
    process.stderr.write(
      'Error: Missing target. Usage: listener migrate <ref> | --all [--dry-run]\n',
    );
    process.exit(1);
  }
  if (ref && all) {
    process.stderr.write('Error: pass either <ref> or --all, not both.\n');
    process.exit(1);
  }

  const dataPath = getDataPath();
  const targets: { folderPath: string; folderName: string }[] = [];
  if (all) {
    // Use a direct readdir, NOT `listTranscriptions`: the v2-only lister
    // filters out folders without meta.json, which is exactly the set we
    // want to migrate.
    const transcriptionsDir = getTranscriptionsDir(dataPath);
    let dirents: fs.Dirent[] = [];
    try {
      dirents = fs.readdirSync(transcriptionsDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    for (const d of dirents) {
      if (!d.isDirectory()) continue;
      if (d.name.startsWith('.')) continue; // skip backup directories
      const folderPath = path.join(transcriptionsDir, d.name);
      targets.push({ folderPath, folderName: d.name });
    }
  } else {
    const folderPath = await resolveRef(ref!, dataPath);
    targets.push({ folderPath, folderName: path.basename(folderPath) });
  }

  let needsMigration = 0;
  let alreadyV2 = 0;
  let failed = 0;
  for (const t of targets) {
    if (isV2Folder(t.folderPath)) {
      alreadyV2 += 1;
      if (dryRun) process.stdout.write(`skip (already v2)  ${t.folderName}\n`);
      continue;
    }
    if (dryRun) {
      needsMigration += 1;
      process.stdout.write(`would migrate      ${t.folderName}\n`);
      continue;
    }
    try {
      await migrateV1ToV2(t.folderPath);
      needsMigration += 1;
      process.stdout.write(`migrated           ${t.folderName}\n`);
    } catch (err) {
      failed += 1;
      process.stderr.write(
        `failed             ${t.folderName}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  const verb = dryRun ? 'to migrate' : 'migrated';
  const summary = `${dryRun ? 'dry-run: ' : ''}${needsMigration} ${verb}, ${alreadyV2} skipped, ${failed} failed (of ${targets.length} total).\n`;
  process.stderr.write(summary);
  if (failed > 0) process.exit(1);
}

async function handleUsage(args: string[]): Promise<void> {
  let month: string | undefined;
  let asJson = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--month' && i + 1 < args.length) {
      month = args[++i];
      continue;
    }
    if (a === '--json') {
      asJson = true;
      continue;
    }
    process.stderr.write(`Error: Unknown option: ${a}\n`);
    process.exit(1);
  }

  const resolvedMonth = month?.trim() || currentMonthString();
  let range: { since: string; until: string };
  try {
    range = monthRange(resolvedMonth);
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const summary = summarizeUsage(range);

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ month: resolvedMonth, ...summary }, null, 2)}\n`);
    return;
  }

  process.stdout.write(`Usage for ${resolvedMonth}\n`);
  process.stdout.write(`Total: ${formatUsd(summary.totalUsd)}  (${summary.count} call(s))\n`);
  if (summary.byModel.length === 0) {
    process.stdout.write('No API calls recorded.\n');
    return;
  }
  process.stdout.write('\n');
  for (const row of summary.byModel) {
    process.stdout.write(
      `  ${row.modelId.padEnd(28)} ${row.kind.padEnd(14)} ${String(row.count).padStart(4)}  ${formatUsd(row.usd)}\n`,
    );
  }
  if (summary.modelUnknownCount > 0) {
    process.stdout.write(
      `\nNote: ${summary.modelUnknownCount} call(s) used a model not in the price table (counted as $0).\n`,
    );
  }
  process.stdout.write(
    '\nBest-effort estimate. Your Google Cloud / OpenAI invoice is the source of truth.\n',
  );
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

  // One-shot v1 -> v2 migration is the runtime's responsibility on every
  // entry point. Skip for commands that don't touch the transcriptions dir
  // (`config`, `codex`, `google login/logout/status`) so we don't pay the
  // dir-scan when it's irrelevant. Also skip when `LISTENER_SKIP_AUTO_MIGRATE`
  // is set -- the migrate-command tests use this to drive the explicit
  // `listener migrate` flow on un-migrated fixtures.
  if (!COMMANDS_WITHOUT_DATA_ACCESS.has(args[0]) && !process.env.LISTENER_SKIP_AUTO_MIGRATE) {
    try {
      await autoMigrateLegacyOnStartup(getDataPath());
    } catch (err) {
      process.stderr.write(
        `Error: legacy migration failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  }

  if (args[0] === 'config') {
    handleConfig(args.slice(1));
    return;
  }

  if (args[0] === 'codex') {
    await handleCodex(args.slice(1));
    return;
  }

  if (args[0] === 'google') {
    await handleGoogle(args.slice(1));
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

  if (args[0] === 'usage') {
    await handleUsage(args.slice(1));
    return;
  }

  if (args[0] === 'migrate') {
    await handleMigrate(args.slice(1));
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
