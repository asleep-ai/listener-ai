#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import { getDataPath } from './dataPath';
import { ConfigService } from './configService';
import { GeminiService, TranscriptionResult } from './geminiService';

function usage(): never {
  process.stderr.write(
    'Usage: listener <file> [--output <path>]\n' +
    '\n' +
    'Transcribe and summarize an audio file into a markdown report.\n' +
    '\n' +
    'Options:\n' +
    '  --output <path>  Custom output path for the markdown file\n'
  );
  process.exit(1);
}

function formatMarkdown(result: TranscriptionResult, title: string): string {
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

  if (result.transcript) {
    lines.push(`## Transcript\n`);
    lines.push(`${result.transcript}\n`);
  }

  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0].startsWith('-')) {
    usage();
  }

  // Parse arguments
  let filePath: string | undefined;
  let outputPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' && i + 1 < args.length) {
      outputPath = args[++i];
    } else if (!args[i].startsWith('-')) {
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

  // Determine output path
  if (!outputPath) {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath, path.extname(filePath));
    outputPath = path.join(dir, `${base}.md`);
  } else {
    outputPath = path.resolve(outputPath);
  }

  // Get API key
  const dataPath = getDataPath();
  const config = new ConfigService(dataPath);
  const apiKey = process.env['GEMINI_API_KEY'] || config.getGeminiApiKey();

  if (!apiKey) {
    process.stderr.write(
      'Error: Gemini API key not found.\n' +
      'Set GEMINI_API_KEY env var or configure via the Listener.AI app.\n'
    );
    process.exit(1);
  }

  // Transcribe
  const gemini = new GeminiService(apiKey, dataPath);

  process.stderr.write(`Processing: ${filePath}\n`);

  const result = await gemini.transcribeAudio(filePath, (_percent, message) => {
    process.stderr.write(`  ${message}\n`);
  });

  // Generate markdown
  const title = result.suggestedTitle || path.basename(filePath, path.extname(filePath));
  const markdown = formatMarkdown(result, title);

  // Write output
  fs.writeFileSync(outputPath, markdown, 'utf-8');
  process.stderr.write(`Done.\n`);

  // Print path to stdout for piping
  process.stdout.write(`${outputPath}\n`);
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
