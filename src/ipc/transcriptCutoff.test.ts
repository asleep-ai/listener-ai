import * as fs from 'fs';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as path from 'path';
import type { TranscriptCutoffApiResult } from '../electronApiTypes';
import type { TranscriptionResult } from '../geminiService';
import {
  META_JSON,
  TRANSCRIPT_FILE,
  getTranscriptionsDir,
  saveTranscription,
} from '../outputService';
import { makeTempDir, rmDir } from '../test-helpers';
import type { IpcContext } from './types';

// Drives the real `apply-transcript-cutoff` handler outside Electron with the
// same electron stub as transcription.test.ts.

type ModuleWithLoad = typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

const transcript = 'Speaker 1: agenda and decision.\nSpeaker 2: after-meeting small talk.';
const cutAt = transcript.indexOf('Speaker 2');

describe('apply-transcript-cutoff IPC', () => {
  let originalLoad: ModuleWithLoad['_load'];
  let handlers: Map<string, (...args: unknown[]) => unknown>;
  let dataPath: string;
  let summarized: string[];
  let release: (() => void) | null;

  beforeEach(() => {
    dataPath = makeTempDir('ipc-cutoff');
    handlers = new Map();
    summarized = [];
    release = null;
    const fakeElectron = {
      ipcMain: {
        handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
      },
      app: { getPath: () => dataPath },
    };
    const moduleAny = Module as ModuleWithLoad;
    originalLoad = moduleAny._load;
    moduleAny._load = function (request: string, parent: NodeModule | null, isMain: boolean) {
      if (request === 'electron') return fakeElectron;
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve('./transcriptCutoff')];
  });

  afterEach(() => {
    (Module as ModuleWithLoad)._load = originalLoad;
    delete require.cache[require.resolve('./transcriptCutoff')];
    rmDir(dataPath);
  });

  function register(opts: { withAi?: boolean; waitForRelease?: boolean } = {}): void {
    const ctx = {
      configService: { getSummaryPrompt: () => 'PROMPT' },
      ensureGeminiService: () =>
        opts.withAi === false
          ? null
          : {
              summarizeTranscript: async (text: string) => {
                summarized.push(text);
                if (opts.waitForRelease) {
                  await new Promise<void>((resolve) => {
                    release = resolve;
                  });
                }
                return {
                  transcript: text,
                  summary: 'Included-only summary.',
                  keyPoints: ['decision'],
                  actionItems: [],
                  emoji: '✂️',
                } as TranscriptionResult;
              },
            },
      maybeAutoSync: () => {},
      sanitizeLiveNotes: (raw: unknown) => (Array.isArray(raw) ? raw : undefined),
      formatAiCredentialsError: () => 'no credentials',
      isContainedTranscriptionPath: (p: string | undefined): p is string =>
        !!p && path.dirname(path.resolve(p)) === path.resolve(getTranscriptionsDir(dataPath)),
    } as unknown as IpcContext;
    const mod = require('./transcriptCutoff') as { register: (ctx: IpcContext) => void };
    mod.register(ctx);
  }

  function makeNote(): { folder: string; generationId: string } {
    const folder = saveTranscription({
      title: 'Sync',
      result: { transcript, summary: 'Full summary.', keyPoints: [], actionItems: [], emoji: '📝' },
      dataPath,
    });
    const meta = JSON.parse(fs.readFileSync(path.join(folder, META_JSON), 'utf-8'));
    return { folder, generationId: meta.generationId };
  }

  function apply(payload: unknown): Promise<TranscriptCutoffApiResult> {
    const handler = handlers.get('apply-transcript-cutoff');
    assert.ok(handler, 'apply-transcript-cutoff must be registered');
    return handler({}, payload) as Promise<TranscriptCutoffApiResult>;
  }

  it('returns the regenerated note with the full transcript and the saved cutoff', async () => {
    register();
    const { folder, generationId } = makeNote();
    const res = await apply({
      transcriptionPath: folder,
      expectedGenerationId: generationId,
      cutoffOffset: cutAt,
    });
    assert.equal(res.success, true);
    if (!res.success) return;
    assert.deepEqual(summarized, ['Speaker 1: agenda and decision.']);
    assert.equal(res.data.transcript, transcript);
    assert.equal(res.data.transcriptCutoff?.offset, cutAt);
    assert.equal(res.data.summary, 'Included-only summary.');
    assert.equal(res.data.title, 'Sync');
    assert.notEqual(res.data.generationId, generationId);
    assert.equal(fs.readFileSync(path.join(folder, TRANSCRIPT_FILE), 'utf-8'), `${transcript}\n`);
  });

  it('reads flagged notes from the recording sidecar when the note stores none', async () => {
    register();
    const audioFilePath = path.join(dataPath, 'recordings', 'legacy.webm');
    const folder = saveTranscription({
      title: 'Legacy',
      result: { transcript, summary: 'Full.', keyPoints: [], actionItems: [], emoji: '📝' },
      dataPath,
      audioFilePath,
    });
    const meta = JSON.parse(fs.readFileSync(path.join(folder, META_JSON), 'utf-8'));
    fs.mkdirSync(path.join(dataPath, 'metadata'), { recursive: true });
    fs.writeFileSync(
      path.join(dataPath, 'metadata', 'legacy.json'),
      JSON.stringify({
        filePath: audioFilePath,
        title: 'Legacy',
        timestamp: '2026-09-29T00:00:00.000Z',
        transcriptionPath: folder,
        liveNotes: [{ offsetMs: 1000, text: 'sidecar note' }],
      }),
    );
    const res = await apply({
      transcriptionPath: folder,
      expectedGenerationId: meta.generationId,
      cutoffOffset: null,
    });
    assert.equal(res.success, true);
    if (!res.success) return;
    assert.deepEqual(res.data.liveNotes, [{ offsetMs: 1000, text: 'sidecar note' }]);
    assert.equal(fs.existsSync(path.join(folder, 'notes.json')), false);
  });

  it('rejects paths outside transcriptions/, bad offsets, and missing AI credentials', async () => {
    register({ withAi: false });
    const { folder, generationId } = makeNote();
    const outside = await apply({
      transcriptionPath: dataPath,
      expectedGenerationId: generationId,
      cutoffOffset: cutAt,
    });
    assert.deepEqual(outside, { success: false, error: 'This note cannot be changed.' });
    const badOffset = await apply({
      transcriptionPath: folder,
      expectedGenerationId: generationId,
      cutoffOffset: '12',
    });
    assert.equal(badOffset.success, false);
    const noAi = await apply({
      transcriptionPath: folder,
      expectedGenerationId: generationId,
      cutoffOffset: cutAt,
    });
    assert.deepEqual(noAi, { success: false, error: 'no credentials' });
    assert.deepEqual(summarized, []);
  });

  it('refuses a second request for the same note while one is running', async () => {
    register({ waitForRelease: true });
    const { folder, generationId } = makeNote();
    const first = apply({
      transcriptionPath: folder,
      expectedGenerationId: generationId,
      cutoffOffset: cutAt,
    });
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    const second = await apply({
      transcriptionPath: folder,
      expectedGenerationId: generationId,
      cutoffOffset: null,
    });
    assert.equal(second.success, false);
    release!();
    assert.equal((await first).success, true);
  });
});
