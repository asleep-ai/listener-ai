import * as fs from 'fs';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as path from 'path';
import { spawnSync } from 'node:child_process';
import type { TranscriptionResult } from '../geminiService';
import {
  META_JSON,
  readTranscription,
  repairMissingAudioFiles,
  repairRenamedRecordingSidecars,
} from '../outputService';
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

  it('restores the original recording and sidecar when cancelled during the rename', async () => {
    const untitled = path.join(recordingsDir, `Untitled_Meeting_${TS}.webm`);
    const renamed = path.join(recordingsDir, `Weekly_Sync_${TS}.webm`);
    fs.writeFileSync(untitled, 'audio-bytes');
    fs.mkdirSync(metadataDir);
    const oldSidecar = path.join(metadataDir, `Untitled_Meeting_${TS}.json`);
    fs.writeFileSync(oldSidecar, JSON.stringify({ filePath: untitled, title: 'Untitled' }));

    const service = require('../services/metadataService').metadataService as {
      saveMetadata: (file: string, metadata: unknown) => Promise<void>;
    };
    const originalSave = service.saveMetadata.bind(service);
    let signalReady!: () => void;
    let releaseSave!: () => void;
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    service.saveMetadata = async (file, metadata) => {
      if (file === renamed) {
        signalReady();
        await gate;
      }
      await originalSave(file, metadata);
    };

    try {
      const pending = transcribe(untitled);
      await ready;
      await handlers.get('cancel-transcription')!({}, untitled);
      releaseSave();
      const result = (await pending) as TranscribeResponse & { cancelled?: boolean };
      assert.equal(result.cancelled, true);
      assert.ok(fs.existsSync(untitled));
      assert.ok(!fs.existsSync(renamed));
      assert.ok(fs.existsSync(oldSidecar));
      const notesDir = path.join(dataPath, 'transcriptions');
      assert.ok(!fs.existsSync(notesDir) || fs.readdirSync(notesDir).length === 0);
    } finally {
      releaseSave();
    }
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

  it('recovers a sidecar when the process exits between audio rename and metadata move', async () => {
    const untitled = path.join(recordingsDir, `Untitled_Meeting_${TS}.webm`);
    const renamed = path.join(recordingsDir, `Weekly_Sync_${TS}.webm`);
    fs.writeFileSync(untitled, 'audio-bytes');
    fs.mkdirSync(metadataDir);
    const oldSidecar = path.join(metadataDir, `Untitled_Meeting_${TS}.json`);
    fs.writeFileSync(
      oldSidecar,
      JSON.stringify({
        filePath: untitled,
        title: 'Untitled',
        liveNotes: [{ offsetMs: 1000, text: 'keep' }],
      }),
    );

    const child = spawnSync(process.execPath, [
      '-e',
      `require('fs').renameSync(${JSON.stringify(untitled)}, ${JSON.stringify(renamed)}); process.exit(7)`,
    ]);
    assert.equal(child.status, 7);
    assert.ok(!fs.existsSync(untitled));
    assert.ok(fs.existsSync(oldSidecar));

    const repaired = await repairRenamedRecordingSidecars(dataPath);
    const newSidecar = path.join(metadataDir, `Weekly_Sync_${TS}.json`);
    assert.deepEqual(repaired.repaired, [{ from: oldSidecar, to: newSidecar }]);
    assert.ok(!fs.existsSync(oldSidecar));
    const metadata = JSON.parse(fs.readFileSync(newSidecar, 'utf-8'));
    assert.equal(metadata.filePath, renamed);
    assert.deepEqual(metadata.liveNotes, [{ offsetMs: 1000, text: 'keep' }]);
  });

  it('leaves a missing sidecar path alone when two renamed recordings match', async () => {
    const untitled = path.join(recordingsDir, `Untitled_Meeting_${TS}.webm`);
    fs.writeFileSync(path.join(recordingsDir, `First_${TS}.webm`), 'first');
    fs.writeFileSync(path.join(recordingsDir, `Second_${TS}.webm`), 'second');
    fs.mkdirSync(metadataDir);
    const oldSidecar = path.join(metadataDir, `Untitled_Meeting_${TS}.json`);
    fs.writeFileSync(oldSidecar, JSON.stringify({ filePath: untitled, liveNotes: ['keep'] }));

    const repair = await repairRenamedRecordingSidecars(dataPath);
    assert.deepEqual(repair.repaired, []);
    assert.deepEqual(repair.ambiguous, [oldSidecar]);
    assert.ok(fs.existsSync(oldSidecar));
  });

  it('keeps both sidecars when their linked notes conflict', async () => {
    const untitled = path.join(recordingsDir, `Untitled_Meeting_${TS}.webm`);
    const renamed = path.join(recordingsDir, `Weekly_Sync_${TS}.webm`);
    fs.writeFileSync(renamed, 'audio');
    fs.mkdirSync(metadataDir);
    const oldSidecar = path.join(metadataDir, `Untitled_Meeting_${TS}.json`);
    const newSidecar = path.join(metadataDir, `Weekly_Sync_${TS}.json`);
    fs.writeFileSync(
      oldSidecar,
      JSON.stringify({ filePath: untitled, transcriptionPath: 'note-a' }),
    );
    fs.writeFileSync(
      newSidecar,
      JSON.stringify({ filePath: renamed, transcriptionPath: 'note-b' }),
    );

    const repair = await repairRenamedRecordingSidecars(dataPath);
    assert.deepEqual(repair.repaired, []);
    assert.deepEqual(repair.ambiguous, [oldSidecar]);
    assert.ok(fs.existsSync(oldSidecar));
    assert.ok(fs.existsSync(newSidecar));
  });
});
