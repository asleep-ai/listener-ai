import assert from 'node:assert/strict';
import Module from 'node:module';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { liveReadLeases } from '../services/localAudioStorage';
import { makeTempDir, rmDir } from '../test-helpers';
import type { IpcContext } from './types';

// Intercepts CJS `require('electron')` so the meetingsManagement module --
// which static-imports `ipcMain`, `app`, and `dialog` from electron -- loads
// outside an Electron runtime. The mocked ipcMain just records each
// `handle()` call so we can assert that register() wires up the three
// channels the rest of the codebase expects (renderer preload calls them by
// these exact string names; a typo here would silently break the GUI).
//
// We use a deferred require for meetingsManagement so it picks up the
// intercepted loader. A normal top-of-file import would resolve before
// beforeEach runs.
type ElectronStub = {
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => void };
  app: { getPath: () => string };
  dialog: Record<string, unknown>;
};

type ModuleWithLoad = typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

describe('meetingsManagement.register', () => {
  let originalLoad: ModuleWithLoad['_load'];
  let handlers: Map<string, (...args: unknown[]) => unknown>;
  let registerFn: ((ctx: IpcContext) => void) | null = null;
  let userData = '/tmp/listener-ai-test';
  let dialogStub: Record<string, unknown> = {};

  beforeEach(() => {
    handlers = new Map();
    const fakeElectron: ElectronStub = {
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
      app: { getPath: () => userData },
      dialog: dialogStub,
    };
    const moduleAny = Module as ModuleWithLoad;
    originalLoad = moduleAny._load;
    moduleAny._load = function (request: string, parent: NodeModule | null, isMain: boolean) {
      if (request === 'electron') return fakeElectron;
      return originalLoad.call(this, request, parent, isMain);
    };
    // Force a fresh require so the module body re-runs against the
    // intercepted loader (relevant when other tests in the suite have
    // already required the real electron stub).
    const mPath = require.resolve('./meetingsManagement');
    delete require.cache[mPath];
    const mod = require('./meetingsManagement') as { register: (ctx: IpcContext) => void };
    registerFn = mod.register;
  });

  afterEach(() => {
    const moduleAny = Module as ModuleWithLoad;
    moduleAny._load = originalLoad;
    // Drop the cache entry so production callers (and other test files)
    // require the module against the real loader.
    const mPath = require.resolve('./meetingsManagement');
    delete require.cache[mPath];
    registerFn = null;
  });

  function makeCtx(activeRecordingPath?: string): IpcContext {
    return {
      getMainWindow: () => null,
      configService: {} as IpcContext['configService'],
      notificationService: {} as IpcContext['notificationService'],
      ffmpegManager: {} as IpcContext['ffmpegManager'],
      ensureGeminiService: () => null,
      maybeAutoSync: () => {},
      isContainedTranscriptionPath: (p): p is string => typeof p === 'string',
      formatAiCredentialsError: () => 'no credentials',
      serializeTranscriptionError: () => ({ message: 'stub' }) as never,
      sanitizeLiveNotes: () => undefined,
      applyConfigSideEffects: () => {},
      broadcastConfigChanged: () => {},
      getNotionService: () => null,
      getSlackService: () => null,
      openExternal: () => {},
      getActiveRecordingPath: () => activeRecordingPath,
    };
  }

  it('registers delete-meeting, export-recording-m4a, and merge-recordings channels', () => {
    assert.ok(registerFn, 'register should be importable');
    registerFn!(makeCtx());
    assert.deepEqual([...handlers.keys()].sort(), [
      'delete-meeting',
      'export-recording-m4a',
      'merge-recordings',
    ]);
  });

  it('M4A export holds a read lease from the save dialog until it settles', async () => {
    const dataPath = makeTempDir('export-lease');
    userData = dataPath;
    try {
      const recordings = path.join(dataPath, 'recordings');
      fs.mkdirSync(recordings, { recursive: true });
      const src = path.join(recordings, 'Talk_2026-01-01T00-00-00-000Z.webm');
      fs.writeFileSync(src, 'audio');
      let leasesDuringDialog = -1;
      dialogStub.showSaveDialog = async () => {
        leasesDuringDialog = liveReadLeases(dataPath, src);
        return { canceled: true };
      };
      registerFn!({
        getMainWindow: () => null,
        ffmpegManager: { ensureFFmpeg: async () => '/usr/bin/false' },
      } as unknown as IpcContext);
      const result = await handlers.get('export-recording-m4a')!({}, src);
      assert.deepEqual(result, { canceled: true });
      assert.equal(leasesDuringDialog, 1, 'source leased while the dialog is open');
      assert.equal(liveReadLeases(dataPath, src), 0, 'lease released on cancel');
    } finally {
      delete dialogStub.showSaveDialog;
      userData = '/tmp/listener-ai-test';
      rmDir(dataPath);
    }
  });

  // A recording kept only in Google Drive: the destination is asked for
  // first, then main downloads and encodes without needing the window.
  it('M4A export of cloud-only audio asks for the destination before downloading', async () => {
    const dataPath = makeTempDir('export-cloud');
    userData = dataPath;
    const order: string[] = [];
    try {
      const recordings = path.join(dataPath, 'recordings');
      fs.mkdirSync(recordings, { recursive: true });
      const src = path.join(recordings, 'Cloud_2026-01-01T00-00-00-000Z.webm'); // not on disk
      dialogStub.showSaveDialog = async () => {
        order.push('dialog');
        return { canceled: false, filePath: path.join(dataPath, 'out.m4a') };
      };
      registerFn!({
        getMainWindow: () => null,
        ffmpegManager: { ensureFFmpeg: async () => '/usr/bin/false' },
        restoreCloudAudio: async (p: string) => {
          order.push('download');
          fs.writeFileSync(p, 'audio');
          return { success: true, path: p };
        },
      } as unknown as IpcContext);
      const result = (await handlers.get('export-recording-m4a')!({}, src)) as {
        success: boolean;
      };
      assert.deepEqual(order, ['dialog', 'download']);
      assert.ok(fs.existsSync(src), 'downloaded into place');
      assert.equal(result.success, false, '/usr/bin/false stands in for a failing encode');
    } finally {
      delete dialogStub.showSaveDialog;
      userData = '/tmp/listener-ai-test';
      rmDir(dataPath);
    }
  });

  // The restore can return another verified file than the requested path (a
  // numbered name when other audio took it). The encode reads that file,
  // under a lease, and never the other audio now at the requested path.
  it('M4A export of cloud-only audio encodes the file the restore returns', async () => {
    const dataPath = makeTempDir('export-cloud-numbered');
    userData = dataPath;
    let exported: Promise<{ success: boolean }> | undefined;
    try {
      const recordings = path.join(dataPath, 'recordings');
      fs.mkdirSync(recordings, { recursive: true });
      const src = path.join(recordings, 'Cloud_2026-01-01T00-00-00-000Z.webm'); // not on disk
      const restoredPath = path.join(recordings, 'Cloud_2026-01-01T00-00-00-000Z (2).webm');
      const log = path.join(dataPath, 'ffmpeg-input.txt');
      const go = path.join(dataPath, 'ffmpeg-go');
      // Stands in for ffmpeg: records its input, waits for the test to look
      // at the leases, then writes the output.
      const ffmpeg = path.join(dataPath, 'fake-ffmpeg.sh');
      fs.writeFileSync(
        ffmpeg,
        [
          '#!/bin/sh',
          'while [ $# -gt 0 ]; do',
          `  if [ "$1" = -i ]; then printf %s "$2" > '${log}'; fi`,
          '  last="$1"; shift',
          'done',
          `while [ ! -e '${go}' ]; do sleep 0.02; done`,
          ': > "$last"',
        ].join('\n'),
        { mode: 0o755 },
      );
      dialogStub.showSaveDialog = async () => ({
        canceled: false,
        filePath: path.join(dataPath, 'out.m4a'),
      });
      registerFn!({
        getMainWindow: () => null,
        ffmpegManager: { ensureFFmpeg: async () => ffmpeg },
        restoreCloudAudio: async () => {
          fs.writeFileSync(src, 'unrelated audio');
          fs.writeFileSync(restoredPath, 'note audio');
          return { success: true, path: restoredPath };
        },
      } as unknown as IpcContext);
      exported = handlers.get('export-recording-m4a')!({}, src) as Promise<{
        success: boolean;
      }>;
      const deadline = Date.now() + 5000;
      // The fake creates the log before writing it: wait for the content.
      while (!(fs.existsSync(log) && fs.statSync(log).size > 0) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(fs.readFileSync(log, 'utf-8'), fs.realpathSync(restoredPath));
      assert.equal(liveReadLeases(dataPath, restoredPath), 1, 'encode is leased');
      fs.writeFileSync(go, '');
      const result = await exported;
      assert.equal(result.success, true);
      assert.equal(liveReadLeases(dataPath, restoredPath), 0, 'lease released');
      assert.equal(fs.readFileSync(src, 'utf-8'), 'unrelated audio');
    } finally {
      fs.writeFileSync(path.join(dataPath, 'ffmpeg-go'), '');
      await exported?.catch(() => {});
      delete dialogStub.showSaveDialog;
      userData = '/tmp/listener-ai-test';
      rmDir(dataPath);
    }
  });

  // Under a symlinked data directory, a merge input's realpath is outside the
  // data path as configured, so a lease keyed on it is skipped. Every input,
  // including a restored copy at a numbered name (which the merge job's
  // sourcePaths do not list), is leased by its lexical path while concat reads it.
  it('merge leases every input, including a numbered restored copy, under a symlinked data path', async () => {
    const root = makeTempDir('merge-symlink');
    const real = path.join(root, 'real');
    fs.mkdirSync(path.join(real, 'recordings'), { recursive: true });
    const dataPath = path.join(root, 'link');
    fs.symlinkSync(real, dataPath, 'dir');
    userData = dataPath;
    const concat = require('../services/audioConcatService') as {
      concatAudioFiles: (o: { inputPaths: string[]; outputPath: string }) => Promise<void>;
    };
    const originalConcat = concat.concatAudioFiles;
    try {
      const recordings = path.join(dataPath, 'recordings');
      const local = path.join(recordings, 'Local_2026-01-01T00-00-00-000Z.webm');
      fs.writeFileSync(local, 'local audio');
      const cloud = path.join(recordings, 'Cloud_2026-01-01T00-00-00-000Z.webm'); // not on disk
      const restored = path.join(recordings, 'Cloud_2026-01-01T00-00-00-000Z (2).webm');
      let during: { inputs: string[]; local: number; restored: number } | undefined;
      concat.concatAudioFiles = async ({ inputPaths, outputPath }) => {
        during = {
          inputs: inputPaths,
          local: liveReadLeases(dataPath, local),
          restored: liveReadLeases(dataPath, restored),
        };
        fs.writeFileSync(outputPath, 'merged');
      };
      registerFn!({
        ...makeCtx(),
        configService: { getSummaryPrompt: () => '' } as unknown as IpcContext['configService'],
        notificationService: {
          notifyTranscriptionComplete: () => {},
          notifyTranscriptionFailed: () => {},
        } as unknown as IpcContext['notificationService'],
        ensureGeminiService: () =>
          ({
            transcribeAudio: async () => ({
              transcript: 'Speaker 1: merged.',
              summary: 'Merged summary.',
              keyPoints: [],
              actionItems: [],
              emoji: '📝',
              suggestedTitle: 'Merged',
            }),
          }) as unknown as ReturnType<IpcContext['ensureGeminiService']>,
        ffmpegManager: {
          ensureFFmpeg: async () => '/ffmpeg',
        } as unknown as IpcContext['ffmpegManager'],
        restoreCloudAudio: async (p: string) => {
          // Other audio took the requested name; the note's bytes went to (2).
          fs.writeFileSync(p, 'unrelated audio');
          fs.writeFileSync(restored, 'note audio');
          return { success: true, path: restored };
        },
      });
      const result = (await handlers.get('merge-recordings')!(
        {},
        { paths: [local, cloud], title: 'M' },
      )) as { success: boolean };
      assert.equal(result.success, true);
      assert.deepEqual(during, {
        inputs: [fs.realpathSync(local), fs.realpathSync(restored)],
        local: 1,
        restored: 1,
      });
      assert.equal(liveReadLeases(dataPath, restored), 0, 'leases released');
      assert.equal(fs.readFileSync(cloud, 'utf-8'), 'unrelated audio');
    } finally {
      concat.concatAudioFiles = originalConcat;
      userData = '/tmp/listener-ai-test';
      rmDir(root);
    }
  });

  // Deleting the row of the recording still being written loses the
  // recording; its transcription then hits ENOENT (a reachable cause
  // consistent with LISTENER-AI-Q's breadcrumbs).
  it('refuses to delete the recording that is still being written', async () => {
    userData = makeTempDir('delete-active');
    try {
      const recordings = path.join(userData, 'recordings');
      fs.mkdirSync(recordings, { recursive: true });
      const active = path.join(recordings, 'Untitled_Meeting_2026-10-29T12-32-34-850Z.webm');
      const finished = path.join(recordings, 'Untitled_Meeting_2026-10-29T11-58-37-967Z.webm');
      fs.writeFileSync(active, Buffer.alloc(16, 1));
      fs.writeFileSync(finished, Buffer.alloc(16, 1));
      registerFn!(makeCtx(active));
      const remove = handlers.get('delete-meeting')!;

      const refused = (await remove({}, active)) as { success: boolean; error?: string };
      assert.equal(refused.success, false);
      assert.match(refused.error ?? '', /still in progress/);
      assert.equal(fs.existsSync(active), true);

      // Another spelling of the same path is refused too.
      const respelled = path.join(recordings, '..', 'recordings', path.basename(active));
      assert.equal(((await remove({}, respelled)) as { success: boolean }).success, false);
      assert.equal(fs.existsSync(active), true);

      // A finished recording still deletes while another one is recording.
      const removed = (await remove({}, finished)) as { success: boolean };
      assert.equal(removed.success, true);
      assert.equal(fs.existsSync(finished), false);
    } finally {
      rmDir(userData);
      userData = '/tmp/listener-ai-test';
    }
  });
});
