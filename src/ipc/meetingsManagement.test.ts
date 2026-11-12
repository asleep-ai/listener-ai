import assert from 'node:assert/strict';
import Module from 'node:module';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as fs from 'fs';
import * as path from 'path';
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

  beforeEach(() => {
    handlers = new Map();
    const fakeElectron: ElectronStub = {
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
      app: { getPath: () => userData },
      dialog: {},
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
