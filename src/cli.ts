#!/usr/bin/env node

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { type AgentScope, AgentService, type ConfigProposal } from './agentService';
import { extensionForMimeType, mimeTypeForFile } from './audioFormats';
import {
  CONFIG_KEY_BY_NAME,
  type CliConfigKey,
  type ConfigKeyDefinition,
  KNOWN_CONFIG_KEYS,
} from './configKeys';
import { type AppConfig, ConfigService } from './configService';
import { openInBrowser } from './browserLauncher';
import { ChatGPTBinding } from './chatgptBinding';
import { ChatGPTAuthError, getChatGPTAuth, redactAuthorizeUrl } from './chatgptAuth';
import { CHATGPT_MANAGE_USAGE_URL } from './chatgptResponses';
import { LEGACY_CODEX_TRANSCRIPTION_MESSAGE } from './aiProvider';
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
  withTranscriptionSnapshot,
  repairMissingAudioFiles,
  repairRenamedRecordingSidecars,
  sanitizeForPath,
  saveTranscription,
} from './outputService';
import { ALL_FIELDS, type SearchField, resolveFields, searchTranscriptions } from './searchService';
import { withMeetingLock } from './meetingLock';
import { recoverInterruptedRegenerations } from './regenerateTranscription';
import { includedTranscript, reportNotesAtCutoff } from './transcriptCutoff';
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

const MEETING_READER_COMMANDS = new Set(['list', 'show', 'export', 'search', 'merge', 'ask']);
const COMMANDS_WITHOUT_MIGRATION = new Set([
  'config',
  'chatgpt',
  'codex',
  'migrate', // Its own handler must see v1 folders, including --dry-run.
  'transcript',
  'usage',
  'google',
]);

function commandUsesMeetingData(args: string[]): boolean {
  return (
    MEETING_READER_COMMANDS.has(args[0]) ||
    (args[0] === 'google' && (args[1] === 'upload' || args[1] === 'sync'))
  );
}

function commandNeedsMigration(args: string[]): boolean {
  // The default `listener <audio-file>` command writes a new meeting.
  return commandUsesMeetingData(args) || !COMMANDS_WITHOUT_MIGRATION.has(args[0]);
}

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
  '       listener chatgpt login [--new] [--enable-plan] | logout | status | models | accounts | use <id>\n' +
  '                                           Sign in with ChatGPT (plan usage for summaries and ask)\n' +
  '       listener codex login|logout|status  Deprecated alias of `listener chatgpt` (Codex sign-in was replaced)\n' +
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

export { KNOWN_CONFIG_KEYS };
type ConfigKey = CliConfigKey;

function isSensitiveKey(key: string): boolean {
  return CONFIG_KEY_BY_NAME[key]?.secret === true;
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

function parseEnum(key: ConfigKey, row: ConfigKeyDefinition, v: string): string {
  const values = row.values ?? [];
  // Only the keys whose CLI branch went through a `normalize*` helper accept a
  // differently-cased spelling; aiProvider and transcriptionProvider are exact.
  const candidate = row.cliNormalizesCase ? v.trim().toLowerCase() : v;
  if (!values.includes(candidate)) {
    process.stderr.write(
      `Error: ${row.cliEnumMessage ?? `${key} must be one of: ${values.join(', ')}`}\n`,
    );
    process.exit(1);
  }
  return candidate;
}

// Parses the raw argument per the key's declared kind, then writes through the
// single `updateConfig` path. That is equivalent to the typed setters it
// replaced: enum values are validated here before updateConfig re-validates
// them, the duration clamp is redundant after parseNonNegInt, and updateConfig
// applies the same summaryPrompt trim + default-elision as setSummaryPrompt.
function applyConfigSet(config: ConfigService, key: ConfigKey, value: string): void {
  const row = CONFIG_KEY_BY_NAME[key];
  let parsed: string | number | boolean | string[];
  switch (row.kind) {
    case 'bool':
      parsed = parseBool(key, value);
      break;
    case 'int':
      parsed = parseNonNegInt(key, value);
      break;
    case 'string[]':
      parsed = parseKnownWords(value);
      break;
    case 'enum':
      parsed = parseEnum(key, row, value);
      break;
    case 'string':
      parsed = value;
      break;
  }
  config.updateConfig({ [key]: parsed } as Partial<AppConfig>);
}

function formatAiCredentialsError(config: ConfigService): string {
  if (config.getAiProvider() === 'chatgpt') {
    const status = config.getChatGPTStatus();
    const legacy = config.hasLegacyCodexSignIn()
      ? 'Codex sign-in was replaced by Sign in with ChatGPT; the old Codex login is not reused.\n'
      : '';
    if (status.connected && !status.planEnabled) {
      return (
        'Error: ChatGPT plan usage was not granted for this sign-in.\n' +
        'Run `listener chatgpt login` again and allow plan usage, or set aiProvider back to gemini.\n'
      );
    }
    return (
      `Error: Not signed in with ChatGPT.\n${legacy}` +
      'Run `listener chatgpt login`, or set aiProvider back to gemini with a Gemini API key.\n'
    );
  }
  return (
    'Error: Gemini API key not found.\n' +
    'Set GEMINI_API_KEY env var, run `listener config set geminiApiKey <key>`, ' +
    'or run `listener chatgpt login` and `listener config set aiProvider chatgpt`.\n'
  );
}

// Credentials for the resolved transcription backend, which `transcriptionProvider`
// can point at a different vendor than `aiProvider`. Keyed on the backend, not
// on `aiProvider`, so `transcriptionProvider=openai` on a Gemini install is told
// to add an OpenAI API key rather than a Gemini key.
function formatTranscriptionCredentialsError(config: ConfigService): string {
  const resolution = config.getTranscriptionResolution();
  if (!resolution.provider) return `Error: ${resolution.message}\n`;
  switch (resolution.provider) {
    case 'soniox':
      return (
        'Error: Soniox API key not found.\n' +
        'Set SONIOX_API_KEY env var, run `listener config set sonioxApiKey <key>`, ' +
        'or run `listener config set transcriptionProvider auto`.\n'
      );
    case 'openai':
      return (
        'Error: transcriptionProvider is openai, but no OpenAI API key was found.\n' +
        'Set OPENAI_API_KEY env var or run `listener config set openaiApiKey <key>` ' +
        '(billed to your OpenAI API account, not a ChatGPT plan).\n'
      );
    default:
      return (
        'Error: transcriptionProvider is gemini, but no Gemini API key was found.\n' +
        'Set GEMINI_API_KEY env var, run `listener config set geminiApiKey <key>`, ' +
        'or run `listener config set transcriptionProvider auto`.\n'
      );
  }
}

// Transcription can run on a different backend than the rest of the pipeline
// (see `transcriptionProvider`), so a transcribing command needs both gates:
// `aiProvider` credentials, which the summary AND the per-segment quality judge
// both call, plus the transcription backend's own credentials.
async function requireTranscriptionCredentials(config: ConfigService): Promise<void> {
  await primeChatGPTStatus(config);
  if (!config.hasAiAuth()) {
    process.stderr.write(formatAiCredentialsError(config));
    process.exit(1);
  }
  if (config.hasTranscriptionAuth()) return;
  process.stderr.write(formatTranscriptionCredentialsError(config));
  process.exit(1);
}

// The CLI is one job per process, so the ChatGPT profile is pinned to the one
// active when the command started (primeChatGPTStatus) for every request.
function chatGPTBindingFor(config: ConfigService): ChatGPTBinding | undefined {
  if (config.getAiProvider() !== 'chatgpt') return undefined;
  return new ChatGPTBinding({
    model: config.getChatGPTModel(),
    profileId: config.getChatGPTStatus().profileId,
  });
}

// Read the ChatGPT sign-in status into the config's synchronous gates. Only
// touches the auth store when ChatGPT is the selected provider.
async function primeChatGPTStatus(config: ConfigService): Promise<void> {
  if (config.getAiProvider() !== 'chatgpt') return;
  try {
    config.setChatGPTStatus(await getChatGPTAuth().getStatus());
  } catch (error) {
    process.stderr.write(
      `Warning: could not read ChatGPT sign-in status: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

function createTranscriptionService(config: ConfigService, dataPath: string): GeminiService {
  return new GeminiService({
    provider: config.getAiProvider(),
    transcriptionProvider: config.resolveTranscriptionProvider(),
    apiKey: config.getGeminiApiKey(),
    sonioxApiKey: config.getSonioxApiKey(),
    openaiApiKey: config.getOpenAiApiKey(),
    openaiTranscriptionModel: config.getOpenAiTranscriptionModel(),
    chatgptBinding: chatGPTBindingFor(config),
    dataPath,
    knownWords: config.getKnownWords(),
    proModel: config.getGeminiModel(),
    flashModel: config.getGeminiFlashModel(),
    thinkingLevel: config.getGeminiThinkingLevel(),
  });
}

function createAgentService(config: ConfigService, dataPath: string): AgentService {
  return new AgentService({
    provider: config.getAiProvider(),
    apiKey: config.getGeminiApiKey(),
    chatgptBinding: chatGPTBindingFor(config),
    dataPath,
    configService: config,
  });
}

// DEPRECATED: `listener codex` predates Sign in with ChatGPT. It no longer
// runs the old Codex OAuth flow; login/status/logout redirect to `listener
// chatgpt` and everything else is refused.
async function handleCodex(args: string[]): Promise<void> {
  const sub = args[0];
  process.stderr.write(
    'Warning: `listener codex` is deprecated. Codex sign-in was replaced by Sign in with ChatGPT; ' +
      'the old Codex login is not reused. Use `listener chatgpt ' +
      (sub ?? 'login') +
      '`.\n',
  );
  if (sub !== 'login' && sub !== 'status' && sub !== 'logout') {
    process.stderr.write('Error: Usage: listener chatgpt login|logout|status\n');
    process.exit(1);
  }
  await handleChatGPT([sub]);
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    process.stderr.write(`Error: ${flag} requires a value\n`);
    process.exit(1);
  }
  return value;
}

function chatGPTFailure(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof ChatGPTAuthError ? ` (${error.code})` : '';
  process.stderr.write(`Error: ${message}${code}\n`);
  process.exit(1);
}

function printableAuthorizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.searchParams.delete('id_token_hint');
    return url.toString();
  } catch {
    return redactAuthorizeUrl(raw);
  }
}

async function handleChatGPT(args: string[]): Promise<void> {
  const sub = args[0];
  const dataPath = getDataPath();
  const config = new ConfigService(dataPath);
  const auth = getChatGPTAuth();
  const profileFlag = readFlag(args, '--profile');

  if (sub === 'status') {
    const status = await auth.getStatus().catch(chatGPTFailure);
    config.setChatGPTStatus(status);
    const stt = config.getTranscriptionResolution();
    process.stdout.write(`aiProvider=${config.getAiProvider()}\n`);
    process.stdout.write(`chatgptConnected=${status.connected}\n`);
    process.stdout.write(`chatgptPlanEnabled=${status.planEnabled}\n`);
    if (status.planState) process.stdout.write(`chatgptPlanState=${status.planState}\n`);
    if (status.profileId) process.stdout.write(`chatgptProfileId=${status.profileId}\n`);
    if (status.email) process.stdout.write(`chatgptEmail=${status.email}\n`);
    process.stdout.write(`chatgptModel=${config.getChatGPTModel() ?? ''}\n`);
    // Summary auth and transcription auth are independent gates.
    process.stdout.write(`summaryAuth=${config.hasAiAuth()}\n`);
    process.stdout.write(`transcriptionProvider=${stt.provider ?? ''}\n`);
    process.stdout.write(`transcriptionAuth=${config.hasTranscriptionAuth()}\n`);
    if (stt.provider === 'openai') {
      process.stdout.write('transcriptionBilling=openai-api-key\n');
    }
    if (stt.message) process.stdout.write(`transcriptionProviderIssue=${stt.message}\n`);
    process.stdout.write(`legacyCodexConfigured=${config.hasLegacyCodexConfig()}\n`);
    process.stdout.write(`manageUsage=${CHATGPT_MANAGE_USAGE_URL}\n`);
    return;
  }

  if (sub === 'logout') {
    const result = await auth.signOut(profileFlag).catch(chatGPTFailure);
    config.clearLegacyCodexSignIn();
    if (!result.signedIn) {
      process.stderr.write('No ChatGPT sign-in to remove.\n');
    } else if (result.revoked) {
      process.stderr.write('Signed out of ChatGPT and revoked the sign-in.\n');
    } else {
      process.stderr.write(
        'Signed out of ChatGPT locally, but OpenAI did not confirm the revocation' +
          (result.revocationError ? ` (${result.revocationError})` : '') +
          '. You can disconnect Listener.AI in ChatGPT Settings.\n',
      );
    }
    return;
  }

  if (sub === 'models') {
    const models = await auth.listModels(profileFlag).catch(chatGPTFailure);
    const selected = config.getChatGPTModel();
    for (const model of models) {
      const marker = model.slug === selected ? '*' : ' ';
      process.stdout.write(`${marker} ${model.slug}\t${model.display_name}\n`);
    }
    if (!selected && models.length > 0) {
      process.stderr.write(
        `No chatgptModel set; using the first listed (${models[0].slug}). ` +
          'Pick one with `listener config set chatgptModel <slug>`.\n',
      );
    }
    return;
  }

  if (sub === 'accounts') {
    const profiles = await auth.listProfiles().catch(chatGPTFailure);
    for (const profile of profiles) {
      process.stdout.write(
        `${profile.active ? '*' : ' '} ${profile.id}\t${profile.email ?? ''}\t` +
          `connected=${profile.connected} planEnabled=${profile.planEnabled}\n`,
      );
    }
    return;
  }

  if (sub === 'use') {
    const id = args[1];
    if (!id || id.startsWith('--')) {
      process.stderr.write('Error: Usage: listener chatgpt use <account-id>\n');
      process.exit(1);
    }
    const status = await auth.selectProfile(id).catch(chatGPTFailure);
    process.stderr.write(
      `Now using ChatGPT account ${status.email ?? status.profileId ?? id} for new work.\n`,
    );
    return;
  }

  if (sub !== 'login') {
    process.stderr.write(
      'Error: Unknown chatgpt command. Usage: listener chatgpt login|logout|status|models|accounts|use <id>\n',
    );
    process.exit(1);
  }

  // Ctrl+C cancels the pending browser sign-in and frees the loopback port.
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once('SIGINT', onSigint);
  try {
    const status = await auth.signIn({
      openBrowser: async (url) => {
        const opened = await openInBrowser(url);
        // Never print `id_token_hint`: it is optional for reauthorization,
        // so the printed URL drops it and still works.
        process.stderr.write(
          opened
            ? `Opened your browser to sign in with ChatGPT.\nIf it did not open, visit:\n${printableAuthorizeUrl(url)}\n`
            : `Open this URL in your browser to sign in with ChatGPT:\n${printableAuthorizeUrl(url)}\n`,
        );
      },
      onProgress: (message) => process.stderr.write(`${message}\n`),
      signal: controller.signal,
      newProfile: args.includes('--new'),
      profileId: profileFlag,
      requestPlanConsent: args.includes('--enable-plan'),
    });
    process.stderr.write(
      `Signed in with ChatGPT${status.email ? ` as ${status.email}` : ''}.\n` +
        (status.planEnabled
          ? 'You are using your ChatGPT plan for summaries and `listener ask`. Manage usage: ' +
            `${CHATGPT_MANAGE_USAGE_URL}\n`
          : 'Plan usage was not granted, so ChatGPT cannot run summaries. Sign in again and allow it.\n'),
    );
    if (status.planEnabled && !config.getChatGPTModel()) {
      // Pick the model explicitly and visibly rather than leaving it implicit.
      try {
        const models = await auth.listModels(status.profileId);
        if (models.length > 0) {
          config.setChatGPTModel(models[0].slug);
          process.stderr.write(
            `Using ChatGPT model ${models[0].slug} (first listed for this account). ` +
              'Change it with `listener chatgpt models` and `listener config set chatgptModel <slug>`.\n',
          );
        }
      } catch (error) {
        process.stderr.write(
          `Warning: could not list ChatGPT models: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
    if (config.getAiProvider() !== 'chatgpt') {
      process.stderr.write(
        'To use it, run `listener config set aiProvider chatgpt` ' +
          '(transcription then needs its own provider: gemini, openai, or soniox).\n',
      );
    }
  } catch (error) {
    if (controller.signal.aborted) {
      process.stderr.write('Sign-in cancelled.\n');
      process.exit(130);
    }
    chatGPTFailure(error);
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
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
  const files = await withMeetingLock(folderPath, () => {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    return entries
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
    configSync: config,
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

  // Retired Codex keys: say what replaced them instead of "Unknown key".
  const legacyKey = subArgs[1] ? LEGACY_CONFIG_KEYS[subArgs[1]] : undefined;
  if ((sub === 'get' || sub === 'set' || sub === 'unset') && legacyKey) {
    process.stderr.write(`Error: ${subArgs[1]} was removed. ${legacyKey}\n`);
    process.exit(1);
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
    if (key === 'aiProvider' && value.trim().toLowerCase() === 'codex') {
      // Kept as an intent alias; the old Codex tokens are never reused.
      config.updateConfig({ aiProvider: 'chatgpt' });
      process.stderr.write(
        'Warning: aiProvider "codex" was replaced by "chatgpt" (Sign in with ChatGPT). ' +
          'Set aiProvider=chatgpt; run `listener chatgpt login` to sign in.\n',
      );
      return;
    }
    if (key === 'transcriptionProvider' && value.trim().toLowerCase() === 'codex') {
      process.stderr.write(`Error: ${LEGACY_CODEX_TRANSCRIPTION_MESSAGE}\n`);
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

const LEGACY_CONFIG_KEYS: Record<string, string> = {
  codexModel:
    'ChatGPT models now come from your account: see `listener chatgpt models` and set `chatgptModel`.',
  codexTranscriptionModel:
    'OpenAI transcription now uses your OpenAI API key: set `openaiTranscriptionModel` ' +
    '(with transcriptionProvider=openai and openaiApiKey).',
};

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

// Local output keeps the full transcript when a saved cutoff no longer
// matches it (the app refuses Notion/Slack for such a note instead), so say
// that the report above it may cover only part of the transcript.
function warnTranscriptCutoffMismatch(data: { transcriptCutoffMismatch?: true }): void {
  if (!data.transcriptCutoffMismatch) return;
  process.stderr.write(
    `Warning: the saved transcript cutoff no longer matches ${TRANSCRIPT_FILE}, so the report may cover only part of the transcript. Set the cutoff again or restore the full transcript in the app.\n`,
  );
}

async function renderV2Markdown(folderPath: string): Promise<string | null> {
  const data = await readTranscription(folderPath);
  if (!data) return null;
  warnTranscriptCutoffMismatch(data);
  // The rendered report shows only the flagged notes its cutoff keeps.
  const notes = reportNotesAtCutoff(data);
  return formatSummary(data, data.title, data.mergedFrom, notes.liveNotes, notes.highlights);
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
    const exportDir = path.resolve(targetPath);
    fs.mkdirSync(exportDir, { recursive: true });
    await withMeetingLock(folderPath, () => copyExportedFiles(folderPath, exportDir));
    process.stderr.write(`Exported to ${exportDir}\n`);
    return;
  }

  if (json) {
    const data = await readTranscription(folderPath);
    if (!data) {
      process.stderr.write(`Error: could not read transcription at ${folderPath}\n`);
      process.exit(1);
    }
    warnTranscriptCutoffMismatch(data);
    const obj: Record<string, unknown> = {
      title: data.title || '',
      transcribedAt: data.transcribedAt || '',
      summary: data.summary || '',
      keyPoints: data.keyPoints ?? [],
      actionItems: data.actionItems ?? [],
      summarySections: data.summarySections ?? [],
      actionItemGroups: data.actionItemGroups ?? [],
      customFields: data.customFields ?? {},
      ...(data.liveNotes ? { liveNotes: data.liveNotes } : {}),
      ...(data.highlights ? { highlights: data.highlights } : {}),
      // Raw data: `transcript` stays the full text; the report above covers
      // only `transcript.slice(0, transcriptCutoff.offset)`.
      ...(data.transcriptCutoff ? { transcriptCutoff: data.transcriptCutoff } : {}),
    };
    if (includeTranscript) {
      obj.transcript = data.transcript || '';
    }
    process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  } else {
    const output = await withTranscriptionSnapshot(folderPath, {}, (data) => {
      if (!data) return null;
      warnTranscriptCutoffMismatch(data);
      const notes = reportNotesAtCutoff(data);
      let markdown = formatSummary(
        data,
        data.title,
        data.mergedFrom,
        notes.liveNotes,
        notes.highlights,
      );
      if (includeTranscript && data.transcriptCutoff) {
        // The rendered report covers only the text before the cutoff.
        markdown += `\n${includedTranscript(data.transcript, data.transcriptCutoff)}\n`;
        markdown += `\n_Transcript shown up to the report cutoff. The full transcript is kept in ${TRANSCRIPT_FILE}._\n`;
      } else if (includeTranscript) {
        const transcriptPath = path.join(folderPath, TRANSCRIPT_FILE);
        if (fs.existsSync(transcriptPath)) {
          markdown += `\n${fs.readFileSync(transcriptPath, 'utf-8')}`;
        }
      }
      return markdown;
    });
    if (output === null) {
      process.stderr.write(`Error: could not read transcription at ${folderPath}\n`);
      process.exit(1);
    }
    process.stdout.write(output);
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
  await requireTranscriptionCredentials(config);

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
  await primeChatGPTStatus(config);
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
      `  ${row.modelId.padEnd(28)} ${row.kind.padEnd(14)} ${String(row.count).padStart(4)}  ${row.billing === 'chatgpt-plan' ? 'ChatGPT plan' : formatUsd(row.usd)}\n`,
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
  await requireTranscriptionCredentials(config);

  // Soniox takes vocabulary out of band (`context.terms`) and has no prompt
  // surface at all, so a --prompt on that backend is silently dropped. Say so
  // once instead of letting the user wonder why the instruction had no effect.
  if (promptText && config.getTranscriptionResolution().provider === 'soniox') {
    process.stderr.write(
      'Warning: --prompt is ignored by the Soniox backend (it has no prompt parameter). ' +
        'Known words are still applied.\n',
    );
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
  // (`config`, `chatgpt`, `codex`, `usage`, `transcript`, `google login/logout/status`) so we don't pay the
  // dir-scan when it's irrelevant. Also skip when `LISTENER_SKIP_AUTO_MIGRATE`
  // is set -- the migrate-command tests use this to drive the explicit
  // `listener migrate` flow on un-migrated fixtures.
  if (commandNeedsMigration(args) && !process.env.LISTENER_SKIP_AUTO_MIGRATE) {
    try {
      await autoMigrateLegacyOnStartup(getDataPath());
    } catch (err) {
      process.stderr.write(
        `Error: legacy migration failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  }

  // Backfill notes whose meta.audioFile still names a pre-rename recording
  // (#209) so `merge` reads the real recording. Best-effort.
  if (commandUsesMeetingData(args)) {
    // The CLI may be the first reader after a GUI crash during Regenerate.
    // Restore the previous complete note before list/show/export/merge sees it.
    for (const folder of await recoverInterruptedRegenerations(getDataPath(), { strict: true })) {
      process.stderr.write(`Recovered interrupted regeneration: ${folder}\n`);
    }
    try {
      await repairRenamedRecordingSidecars(getDataPath());
      await repairMissingAudioFiles(getDataPath());
    } catch (err) {
      process.stderr.write(
        `Warning: audio path repair failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  if (args[0] === 'config') {
    handleConfig(args.slice(1));
    return;
  }

  if (args[0] === 'chatgpt') {
    await handleChatGPT(args.slice(1));
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
  await requireTranscriptionCredentials(config);

  const gemini = createTranscriptionService(config, dataPath);

  process.stderr.write(`Processing: ${filePath}\n`);

  const result = await gemini.transcribeAudio(
    filePath,
    (_percent, message) => {
      process.stderr.write(`  ${message}\n`);
    },
    config.getSummaryPrompt(),
  );

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
