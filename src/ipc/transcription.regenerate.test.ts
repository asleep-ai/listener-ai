import * as fs from 'fs';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as path from 'path';
import type { TranscriptionResult } from '../geminiService';
import { getTranscriptionsDir, readTranscription } from '../outputService';
import { makeTempDir, rmDir } from '../test-helpers';
import type { IpcContext } from './types';

// Drives the real `transcribe-audio` handler with electron stubbed out (same
// `Module._load` interception as meetingsManagement.test.ts) and a fake
// GeminiService, against a temp userData dir. Covers issue #213: running it a
// second time for the same recording (the Regenerate button) must replace the
// linked note, not leave the previous one behind.

type Handler = (...args: unknown[]) => Promise<unknown>;
type ModuleWithLoad = typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
type TranscribeFn = (
  filePath: string,
  onProgress: unknown,
  summaryPrompt: unknown,
  liveNotes: unknown,
  opts: { signal: AbortSignal },
) => Promise<TranscriptionResult>;

// Modules that capture `electron` (or the metadata dir) at load time; reloaded
// per test so they bind to the stub and the current temp dir.
const RELOAD = [
  './transcription',
  '../services/metadataService',
  '../services/notificationService',
];

function resultFor(label: string): TranscriptionResult {
  return {
    transcript: `Speaker A: ${label} transcript.`,
    summary: `${label} summary.`,
    keyPoints: [`${label} point`],
    actionItems: [],
    emoji: '📝',
    suggestedTitle: `${label} Title`,
  } as TranscriptionResult;
}

describe('transcribe-audio regenerate (#213)', () => {
  let dataPath: string;
  let audioPath: string;
  let handlers: Map<string, Handler>;
  let originalLoad: ModuleWithLoad['_load'];
  let transcribe: TranscribeFn;

  beforeEach(() => {
    dataPath = makeTempDir('ipc-transcription');
    fs.mkdirSync(path.join(dataPath, 'recordings'));
    audioPath = path.join(dataPath, 'recordings', 'Weekly_Sync_2026-01-01T00-00-00-000Z.webm');
    fs.writeFileSync(audioPath, 'audio');

    handlers = new Map();
    const fakeElectron = {
      ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) },
      app: { getPath: () => dataPath, emit: () => {} },
      Notification: { isSupported: () => false },
    };
    const moduleAny = Module as ModuleWithLoad;
    originalLoad = moduleAny._load;
    moduleAny._load = function (request: string, parent: NodeModule | null, isMain: boolean) {
      if (request === 'electron') return fakeElectron;
      return originalLoad.call(this, request, parent, isMain);
    };
    for (const m of RELOAD) delete require.cache[require.resolve(m)];

    const transcriptionsRoot = getTranscriptionsDir(dataPath);
    const ctx = {
      getMainWindow: () => null,
      configService: { getSummaryPrompt: () => '' },
      ensureGeminiService: () => ({
        transcribeAudio: (...args: Parameters<TranscribeFn>) => transcribe(...args),
      }),
      maybeAutoSync: () => {},
      isContainedTranscriptionPath: (p: string | undefined): p is string =>
        typeof p === 'string' && path.resolve(p).startsWith(transcriptionsRoot + path.sep),
      formatAiCredentialsError: () => 'no credentials',
      serializeTranscriptionError: () => ({}),
      sanitizeLiveNotes: () => undefined,
    } as unknown as IpcContext;
    const mod = require('./transcription') as { register: (ctx: IpcContext) => void };
    mod.register(ctx);
  });

  afterEach(() => {
    (Module as ModuleWithLoad)._load = originalLoad;
    for (const m of RELOAD) delete require.cache[require.resolve(m)];
    rmDir(dataPath);
  });

  const run = (): Promise<{ success: boolean; cancelled?: boolean; transcriptionPath?: string }> =>
    handlers.get('transcribe-audio')!(undefined, audioPath) as Promise<{
      success: boolean;
      cancelled?: boolean;
      transcriptionPath?: string;
    }>;
  const noteFolders = () => fs.readdirSync(getTranscriptionsDir(dataPath));
  const linkedPath = (): string | undefined => {
    const sidecar = path.join(dataPath, 'metadata', `${path.basename(audioPath, '.webm')}.json`);
    return JSON.parse(fs.readFileSync(sidecar, 'utf-8')).transcriptionPath;
  };

  it('regenerating leaves exactly one note, linked to the recording, with the new content', async () => {
    transcribe = async () => resultFor('First');
    const first = await run();
    assert.equal(first.success, true);

    transcribe = async () => resultFor('Second');
    const second = await run();
    assert.equal(second.success, true);

    assert.equal(noteFolders().length, 1, `expected one note, found ${noteFolders().join(', ')}`);
    assert.equal(second.transcriptionPath, first.transcriptionPath);
    assert.equal(linkedPath(), first.transcriptionPath);
    const read = await readTranscription(linkedPath()!);
    assert.equal(read?.summary, 'Second summary.');
    assert.equal(read?.title, 'Second Title');
  });

  it('a failed regenerate keeps the previous note and link', async () => {
    transcribe = async () => resultFor('First');
    const first = await run();

    transcribe = async () => {
      throw new Error('provider down');
    };
    const second = await run();
    assert.equal(second.success, false);

    assert.equal(noteFolders().length, 1);
    assert.equal(linkedPath(), first.transcriptionPath);
    const read = await readTranscription(first.transcriptionPath!);
    assert.equal(read?.summary, 'First summary.');
  });

  it('a regenerate whose save fails keeps the previous note and leaves the sidecar untouched', async () => {
    transcribe = async () => resultFor('First');
    const first = await run();
    const sidecar = path.join(dataPath, 'metadata', `${path.basename(audioPath, '.webm')}.json`);
    const sidecarBefore = fs.readFileSync(sidecar, 'utf-8');

    // Read-only note folder: the swap's first rename fails.
    fs.chmodSync(first.transcriptionPath!, 0o555);
    try {
      transcribe = async () => resultFor('Second');
      const second = (await run()) as { success: boolean; error?: string };
      assert.equal(second.success, false);
      assert.match(second.error ?? '', /previous note was kept/);
    } finally {
      fs.chmodSync(first.transcriptionPath!, 0o755);
    }

    assert.equal(fs.readFileSync(sidecar, 'utf-8'), sidecarBefore);
    assert.equal(noteFolders().length, 1);
    const read = await readTranscription(first.transcriptionPath!);
    assert.equal(read?.summary, 'First summary.');
  });

  it('a cancelled regenerate never replaces the previous note, even if the provider still resolves', async () => {
    transcribe = async () => resultFor('First');
    const first = await run();

    // Provider that ignores the abort signal and returns a result anyway.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    transcribe = async () => {
      await gate;
      return resultFor('Cancelled');
    };
    const pending = run();
    await handlers.get('cancel-transcription')!(undefined, audioPath);
    release();
    const second = await pending;
    assert.equal(second.cancelled, true);

    assert.equal(noteFolders().length, 1);
    assert.equal(linkedPath(), first.transcriptionPath);
    const read = await readTranscription(first.transcriptionPath!);
    assert.equal(read?.summary, 'First summary.');
  });
});
