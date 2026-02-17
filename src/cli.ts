#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import { getDataPath } from './dataPath';
import { ConfigService } from './configService';
import { GeminiService, TranscriptionResult } from './geminiService';

const SUPPORTED_EXTENSIONS = new Set([
  '.mp3', '.m4a', '.wav', '.ogg', '.flac', '.aac', '.wma', '.opus', '.webm',
]);

function usage(): never {
  process.stderr.write(
    'Usage: listener <file> [--output <dir>]\n' +
    '       listener config list|get|set|path\n' +
    '\n' +
    'Transcribe and summarize an audio file.\n' +
    'Creates a folder with transcript.md and summary.md.\n' +
    '\n' +
    'Requires FFmpeg installed on the system.\n' +
    '\n' +
    'Options:\n' +
    '  --output <dir>  Parent directory for the output folder\n' +
    '  --help          Show this help message\n' +
    '\n' +
    'Config commands:\n' +
    '  config list              Show all config values\n' +
    '  config get <key>         Get a specific value\n' +
    '  config set <key> <value> Set a value\n' +
    '  config path              Print config file path\n'
  );
  process.exit(1);
}

function sanitizeForPath(name: string): string {
  return name.replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
}

function formatTimestamp(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `${y}${m}${d}_${h}${min}${s}`;
}

function formatSummary(result: TranscriptionResult, title: string): string {
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

  return lines.join('\n');
}

function formatTranscript(result: TranscriptionResult, title: string): string {
  const lines: string[] = [];
  lines.push(`# ${title}\n`);
  lines.push(`${result.transcript}\n`);
  return lines.join('\n');
}

const KNOWN_CONFIG_KEYS = ['geminiApiKey', 'notionApiKey', 'notionDatabaseId', 'autoMode', 'globalShortcut'] as const;
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
    };
    setters[key](value);
    process.stderr.write(`Set ${key}\n`);
    return;
  }

  process.stderr.write(`Error: Unknown config command: ${sub}\n`);
  usage();
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

  // Default output parent to same directory as audio file
  if (!outputDir) {
    outputDir = path.dirname(filePath);
  } else {
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

  const gemini = new GeminiService(apiKey, dataPath);

  process.stderr.write(`Processing: ${filePath}\n`);

  const result = await gemini.transcribeAudio(filePath, (_percent, message) => {
    process.stderr.write(`  ${message}\n`);
  });

  // Create output folder: {title}_{timestamp}/
  const title = result.suggestedTitle || path.basename(filePath, path.extname(filePath));
  const folderName = `${sanitizeForPath(title)}_${formatTimestamp()}`;
  const folderPath = path.join(outputDir, folderName);
  fs.mkdirSync(folderPath, { recursive: true });

  // Write files
  fs.writeFileSync(path.join(folderPath, 'summary.md'), formatSummary(result, title), 'utf-8');
  fs.writeFileSync(path.join(folderPath, 'transcript.md'), formatTranscript(result, title), 'utf-8');

  process.stderr.write(`Done.\n`);

  // Print folder path to stdout for piping
  process.stdout.write(`${folderPath}\n`);
}

main().catch((err) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
