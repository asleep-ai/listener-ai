// The capture host's readiness is bounded: a page that loads but never runs
// its script must fail the start (so the recording leaves "starting") instead
// of hanging. Electron's BrowserWindow is replaced by a minimal fake.

import assert from 'node:assert/strict';
import Module from 'node:module';
import { after, before, describe, it } from 'node:test';

type ModuleWithLoad = typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

class FakeWindow {
  destroyed = false;
  sent: unknown[] = [];
  private handlers = new Map<string, () => void>();
  webContents = {
    once: () => {},
    on: () => {},
    setWindowOpenHandler: () => {},
    send: (_channel: string, payload: unknown) => this.sent.push(payload),
  };
  constructor() {
    windows.push(this);
  }
  once(event: string, fn: () => void) {
    this.handlers.set(event, fn);
  }
  on(event: string, fn: () => void) {
    this.handlers.set(event, fn);
  }
  loadFile() {
    return Promise.resolve();
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
  }
}
const windows: FakeWindow[] = [];

describe('CaptureHostWindow readiness', () => {
  let originalLoad: ModuleWithLoad['_load'];
  let CaptureHostWindow: typeof import('./captureHost').CaptureHostWindow;

  before(() => {
    const moduleAny = Module as ModuleWithLoad;
    originalLoad = moduleAny._load;
    moduleAny._load = function (request: string, parent: NodeModule | null, isMain: boolean) {
      if (request === 'electron') return { BrowserWindow: FakeWindow };
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve('./captureHost')];
    ({ CaptureHostWindow } = require('./captureHost') as typeof import('./captureHost'));
  });

  after(() => {
    (Module as ModuleWithLoad)._load = originalLoad;
    delete require.cache[require.resolve('./captureHost')];
  });

  const host = (readyTimeoutMs: number) =>
    new CaptureHostWindow({
      preloadPath: '/preload.js',
      pagePath: '/capture.html',
      backgroundTestMode: true,
      onLost: () => {},
      onReleased: () => {},
      readyTimeoutMs,
    });

  it('fails a start when the page never becomes ready', async () => {
    const h = host(20);
    await assert.rejects(
      h.start({ sessionId: 1, deviceId: '', recordSystemAudio: false }),
      /did not become ready/,
    );
    assert.deepEqual(windows.at(-1)!.sent, [], 'no command sent to a page that is not ready');
  });

  it('a page that becomes ready in time receives the start command', async () => {
    const h = host(1_000);
    const start = h.start({ sessionId: 2, deviceId: 'mic', recordSystemAudio: false });
    h.markReady(windows.at(-1)!.webContents as never);
    await start;
    assert.equal((windows.at(-1)!.sent[0] as { type: string }).type, 'start');
  });
});
