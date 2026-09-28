import * as fs from 'fs';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as path from 'path';
import type { TranscriptionResult } from '../geminiService';
import { META_JSON, readTranscription, repairMissingAudioFiles } from '../outputService';
import { makeTempDir, rmDir } from '../test-helpers';
import type { IpcContext } from './types';

// Drives the real `transcribe-audio` handler outside Electron (#209). The
// electron stub mirrors meetingsManagement.test.ts: `ipcMain.handle` records
// handlers, `app.getPath('userData')` points at a per-test temp dir (used by
// both saveTranscription and the lazily-resolved metadataService dir), and
// `Notification.isSupported()` is false so no OS notification fires.

type ModuleWithLoad = typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

type TranscribeResponse = {
  success: boolean;
  newFilePath?: string;
  transcriptionPath?: string;
  error?: string;
};

const TS = '2025-07-10T01-34-07-679Z';

const stubResult = (): TranscriptionResult => ({
  transcript: 'Speaker 1: hello',
  summary: 'A short sync.',
  keyPoints: ['point'],
  actionItems: ['action'],
  emoji: 'x',
  suggestedTitle: 'Weekly Sync',
});

describe('transcribe-audio save/rename ordering', () => {
  let originalLoad: ModuleWithLoad['_load'];
  let handlers: Map<string, (...args: unknown[]) => unknown>;
  let dataPath: string;
  let recordingsDir: string;
  let metadataDir: string;

  const freshModules = [
    './transcription',
    '../services/metadataService',
    '../services/notificationService',
  ];

  beforeEach(() => {
    dataPath = makeTempDir('ipc-transcription');
    recordingsDir = path.join(dataPath, 'recordings');
    metadataDir = path.join(dataPath, 'metadata');
    fs.mkdirSync(recordingsDir, { recursive: true });

    handlers = new Map();
    const fakeElectron = {
      ipcMain: {
        handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
      },
      app: { getPath: () => dataPath, emit: () => {} },
      Notification: { isSupported: () => false },
    };
    const moduleAny = Module as ModuleWithLoad;
    originalLoad = moduleAny._load;
    moduleAny._load = function (request: string, parent: NodeModule | null, isMain: boolean) {
      if (request === 'electron') return fakeElectron;
      return originalLoad.call(this, request, parent, isMain);
    };
    // Fresh copies so the metadataService singleton resolves this test's dir.
    for (const m of freshModules) delete require.cache[require.resolve(m)];
    const mod = require('./transcription') as { register: (ctx: IpcContext) => void };
    mod.register(makeCtx());
  });

  afterEach(() => {
    (Module as ModuleWithLoad)._load = originalLoad;
    for (const m of freshModules) delete require.cache[require.resolve(m)];
    rmDir(dataPath);
  });

  function makeCtx(result: TranscriptionResult = stubResult()): IpcContext {
    return {
      getMainWindow: () => null,
      configService: { getSummaryPrompt: () => undefined },
      ensureGeminiService: () => ({ transcribeAudio: async () => result }),
      maybeAutoSync: () => {},
      sanitizeLiveNotes: (raw: unknown) => (Array.isArray(raw) ? raw : undefined),
      formatAiCredentialsError: () => 'no credentials',
      serializeTranscriptionError: () => ({}),
    } as unknown as IpcContext;
  }

  async function transcribe(filePath: string): Promise<TranscribeResponse> {
    const handler = handlers.get('transcribe-audio');
    assert.ok(handler, 'transcribe-audio must be registered');
    return (await handler({}, filePath)) as TranscribeResponse;
  }

  function readMeta(folderPath: string) {
    return JSON.parse(fs.readFileSync(path.join(folderPath, META_JSON), 'utf-8'));
  }

  it('saves meta.audioFile as the renamed recording path', async () => {
    const untitled = path.join(recordingsDir, `Untitled_Meeting_${TS}.webm`);
    fs.writeFileSync(untitled, 'audio-bytes');
    // What stop-recording leaves behind for the record-now-transcribe-later flow.
    fs.mkdirSync(metadataDir, { recursive: true });
    fs.writeFileSync(
      path.join(metadataDir, `Untitled_Meeting_${TS}.json`),
      JSON.stringify({
        filePath: untitled,
        title: `Untitled_Meeting_${TS}`,
        timestamp: '2025-07-10T01:34:07.679Z',
        liveNotes: [{ offsetMs: 1000, text: 'kickoff' }],
      }),
    );

    const res = await transcribe(untitled);

    const renamed = path.join(recordingsDir, `Weekly_Sync_${TS}.webm`);
    assert.equal(res.success, true);
    assert.equal(res.newFilePath, renamed);
    assert.ok(res.transcriptionPath);
    assert.ok(!fs.existsSync(untitled), 'untitled recording is renamed');
    assert.equal(fs.readFileSync(renamed, 'utf-8'), 'audio-bytes');

    assert.equal(readMeta(res.transcriptionPath).audioFile, renamed);
    const data = await readTranscription(res.transcriptionPath);
    assert.equal(data?.audioFilePath, renamed);
    assert.deepEqual(data?.liveNotes, [{ offsetMs: 1000, text: 'kickoff' }]);

    // Sidecar written once at the final path, carrying stop-recording fields.
    assert.deepEqual(fs.readdirSync(metadataDir), [`Weekly_Sync_${TS}.json`]);
    const sidecar = JSON.parse(
      fs.readFileSync(path.join(metadataDir, `Weekly_Sync_${TS}.json`), 'utf-8'),
    );
    assert.equal(sidecar.filePath, renamed);
    assert.equal(sidecar.transcriptionPath, res.transcriptionPath);
    assert.deepEqual(sidecar.liveNotes, [{ offsetMs: 1000, text: 'kickoff' }]);

    // Nothing left for the legacy backfill to do.
    assert.deepEqual(await repairMissingAudioFiles(dataPath), {
      repaired: [],
      ambiguous: [],
      failed: [],
    });
  });

  it('keeps the original path for recordings that are not untitled', async () => {
    const named = path.join(recordingsDir, `Standup_${TS}.webm`);
    fs.writeFileSync(named, 'audio-bytes');

    const res = await transcribe(named);

    assert.equal(res.success, true);
    assert.equal(res.newFilePath, undefined);
    assert.ok(res.transcriptionPath);
    assert.ok(fs.existsSync(named));
    assert.equal(readMeta(res.transcriptionPath).audioFile, named);
    const sidecar = JSON.parse(
      fs.readFileSync(path.join(metadataDir, `Standup_${TS}.json`), 'utf-8'),
    );
    assert.equal(sidecar.filePath, named);
    assert.equal(sidecar.transcriptionPath, res.transcriptionPath);
  });

  it('keeps the original path when the rename fails', async () => {
    const untitled = path.join(recordingsDir, `Untitled_Meeting_${TS}.webm`);
    fs.writeFileSync(untitled, 'audio-bytes');
    // A non-empty directory at the target makes fs.rename fail.
    const blocker = path.join(recordingsDir, `Weekly_Sync_${TS}.webm`);
    fs.mkdirSync(blocker);
    fs.writeFileSync(path.join(blocker, 'keep'), 'x');

    const res = await transcribe(untitled);

    assert.equal(res.success, true);
    assert.equal(res.newFilePath, untitled);
    assert.ok(res.transcriptionPath);
    assert.equal(fs.readFileSync(untitled, 'utf-8'), 'audio-bytes');
    assert.equal(readMeta(res.transcriptionPath).audioFile, untitled);
    const sidecar = JSON.parse(
      fs.readFileSync(path.join(metadataDir, `Untitled_Meeting_${TS}.json`), 'utf-8'),
    );
    assert.equal(sidecar.transcriptionPath, res.transcriptionPath);
  });
});
