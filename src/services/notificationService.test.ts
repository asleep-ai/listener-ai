import * as fs from 'fs';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as path from 'path';
import { makeTempDir, rmDir } from '../test-helpers';
import type { IpcContext } from '../ipc/types';

// Background test runs hide the window, which is exactly when the service
// would otherwise notify. These tests swap in an Electron stub whose
// Notification is "supported" and records every construction, show() and
// click wiring, so a suppression gap shows up as a recorded notification
// instead of an OS banner.

type ModuleWithLoad = typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

type Recorded = { title?: string; shown: boolean; listeners: Map<string, () => void> };

type ServiceModule = typeof import('./notificationService');

describe('NotificationService background suppression', () => {
  let originalLoad: ModuleWithLoad['_load'];
  let created: Recorded[];
  let windowCalls: string[];
  let handlers: Map<string, (...args: unknown[]) => unknown>;
  let dataPath: string;

  const freshModules = ['./notificationService', '../ipc/transcription', './metadataService'];

  beforeEach(() => {
    created = [];
    windowCalls = [];
    handlers = new Map();
    dataPath = makeTempDir('notification-service');
    class FakeNotification {
      static isSupported() {
        return true;
      }
      private readonly record: Recorded;
      constructor(options: { title?: string }) {
        this.record = { title: options.title, shown: false, listeners: new Map() };
        created.push(this.record);
      }
      on(event: string, listener: () => void) {
        this.record.listeners.set(event, listener);
        return this;
      }
      show() {
        this.record.shown = true;
      }
    }
    const fakeElectron = {
      Notification: FakeNotification,
      app: { getPath: () => dataPath, emit: (event: string) => windowCalls.push(`app:${event}`) },
      ipcMain: {
        handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
      },
    };
    const moduleAny = Module as ModuleWithLoad;
    originalLoad = moduleAny._load;
    moduleAny._load = function (request: string, parent: NodeModule | null, isMain: boolean) {
      if (request === 'electron') return fakeElectron;
      return originalLoad.call(this, request, parent, isMain);
    };
    for (const m of freshModules) delete require.cache[require.resolve(m)];
  });

  afterEach(() => {
    (Module as ModuleWithLoad)._load = originalLoad;
    for (const m of freshModules) delete require.cache[require.resolve(m)];
    rmDir(dataPath);
  });

  function loadService(): ServiceModule {
    return require('./notificationService') as ServiceModule;
  }

  function hiddenWindow() {
    return {
      isDestroyed: () => false,
      isVisible: () => false,
      isFocused: () => false,
      show: () => windowCalls.push('show'),
      focus: () => windowCalls.push('focus'),
    } as unknown as import('electron').BrowserWindow;
  }

  // Every public notify* method, discovered from the prototype so a method
  // added later is covered without editing this list.
  function notifyAll(service: InstanceType<ServiceModule['NotificationService']>): unknown[] {
    const names = Object.getOwnPropertyNames(Object.getPrototypeOf(service)).filter((name) =>
      name.startsWith('notify'),
    );
    assert.ok(names.length >= 10, `expected the full notify surface, got ${names.join(', ')}`);
    return names.map((name) =>
      (service as unknown as Record<string, (...args: unknown[]) => unknown>)[name](
        name === 'notifyDisplayDetected' ? () => windowCalls.push('allow') : 'x',
      ),
    );
  }

  it('posts nothing and wires no click activation while suppressed', () => {
    const { NotificationService } = loadService();
    const service = new NotificationService();
    service.setMainWindow(hiddenWindow());
    service.setSuppressed(true);

    const results = notifyAll(service);

    assert.equal(created.length, 0);
    assert.deepEqual(windowCalls, []);
    assert.ok(results.every((result) => result === undefined || result === null));
  });

  it('keeps production behavior for every notify method when not suppressed', () => {
    const { NotificationService } = loadService();
    const service = new NotificationService();
    service.setMainWindow(hiddenWindow());

    const results = notifyAll(service);

    assert.equal(created.length, results.length);
    assert.ok(created.every((n) => n.shown && n.listeners.has('click')));
    // The display prompt returns its notification so main can keep it alive.
    assert.ok(results.some((result) => result !== undefined && result !== null));
  });

  it('keeps production behavior when not suppressed: hidden window notifies, click shows it', () => {
    const { NotificationService } = loadService();
    const service = new NotificationService();
    service.setMainWindow(hiddenWindow());

    service.notifyTranscriptionFailed('boom');

    assert.equal(created.length, 1);
    assert.equal(created[0].title, 'Transcription Failed');
    assert.equal(created[0].shown, true);
    created[0].listeners.get('click')?.();
    assert.deepEqual(windowCalls, ['show', 'focus']);
  });

  it('a failed transcribe-audio run in background mode posts no notification', async () => {
    // The path e2e/chatgpt-integration.spec.ts drives: a text-only ChatGPT
    // setup has a service, its transcription refuses, and the handler's
    // failure branch notifies.
    const { notificationService } = loadService();
    const mod = require('../ipc/transcription') as { register: (ctx: IpcContext) => void };
    mod.register({
      getMainWindow: () => null,
      configService: { getSummaryPrompt: () => undefined },
      ensureGeminiService: () => ({
        transcribeAudio: async () => {
          throw new Error('Sign in with ChatGPT cannot transcribe audio. Choose a provider.');
        },
      }),
      maybeAutoSync: () => {},
      sanitizeLiveNotes: () => undefined,
      formatAiCredentialsError: () => 'no credentials',
      serializeTranscriptionError: () => ({}),
    } as unknown as IpcContext);
    const handler = handlers.get('transcribe-audio');
    assert.ok(handler);
    const audio = path.join(dataPath, 'recording.webm');
    fs.writeFileSync(audio, 'not audio');

    notificationService.setSuppressed(true);
    const suppressed = (await handler({}, audio)) as { success: boolean };
    assert.equal(suppressed.success, false);
    assert.equal(created.length, 0);

    // Control: the same failure outside background mode does notify, so the
    // assertion above is not vacuous.
    notificationService.setSuppressed(false);
    await handler({}, audio);
    assert.equal(created.length, 1);
    assert.equal(created[0].title, 'Transcription Failed');
  });
});
