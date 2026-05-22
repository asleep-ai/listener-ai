import assert from 'node:assert/strict';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import Module from 'node:module';
import { afterEach, beforeEach, describe, it } from 'node:test';
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

  beforeEach(() => {
    handlers = new Map();
    const fakeElectron: ElectronStub = {
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
      app: { getPath: () => '/tmp/listener-ai-test' },
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
    // eslint-disable-next-line @typescript-eslint/no-require-imports
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

  it('registers delete-meeting, export-recording-m4a, and merge-recordings channels', () => {
    assert.ok(registerFn, 'register should be importable');
    registerFn!({
      getMainWindow: () => null,
      configService: {} as IpcContext['configService'],
      notificationService: {} as IpcContext['notificationService'],
      ffmpegManager: {} as IpcContext['ffmpegManager'],
      ensureGeminiService: () => null,
      maybeAutoSync: () => {},
      isContainedTranscriptionPath: (p): p is string => typeof p === 'string',
      formatAiCredentialsError: () => 'no credentials',
    });
    assert.deepEqual([...handlers.keys()].sort(), [
      'delete-meeting',
      'export-recording-m4a',
      'merge-recordings',
    ]);
  });
});
