// TEST-ONLY. Keeps unpackaged Electron E2E runs in the background.
//
// e2e/support/launch.ts loads this file into the Electron main process with
// `-r` ahead of the app's own entry (`.`), so it runs before dist/main.js
// requires `electron`. NODE_OPTIONS is not an option here: Playwright removes
// it from the environment it launches Electron with.
//
// - Windows are created hidden (`show: false`), skip the taskbar, and keep
//   timers and animation frames running (`backgroundThrottling: false`).
// - show / showInactive / focus / moveTop on app windows do nothing, so no
//   product code path (tray, dock click, notification click) can raise one.
// - DevTools, which unpackaged launches open in their own window, stay closed.
// - On macOS the test app leaves the Dock and Cmd-Tab.
//
// Product code and the packaged smoke test (e2e/smoke.spec.ts) do not use
// this; Playwright drives the hidden pages over CDP as usual.

'use strict';

const Module = require('module');
const electron = require('electron');

const { app } = electron;

// Named BrowserWindow on purpose: Electron's BrowserWindow.getAllWindows()
// (used by the app and the tests) only lists windows whose constructor is
// named BrowserWindow.
const HiddenBrowserWindow = class BrowserWindow extends electron.BrowserWindow {
  constructor(options = {}) {
    super({
      ...options,
      show: false,
      skipTaskbar: true,
      webPreferences: { ...(options.webPreferences || {}), backgroundThrottling: false },
    });
    this.hiddenForE2E = true;
  }

  show() {}

  showInactive() {}

  focus() {}

  moveTop() {}
};

// What `require('electron')` returns to the app: the real module, except for
// BrowserWindow. Getters keep every other export live.
const hiddenElectron = {};
for (const key of Object.getOwnPropertyNames(electron)) {
  Object.defineProperty(hiddenElectron, key, {
    enumerable: true,
    get: () => (key === 'BrowserWindow' ? HiddenBrowserWindow : electron[key]),
  });
}

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'electron') return hiddenElectron;
  return originalLoad.call(this, request, parent, isMain);
};

app.on('web-contents-created', (_event, contents) => {
  contents.openDevTools = () => {};
});

if (process.platform === 'darwin') {
  app.whenReady().then(() => {
    app.setActivationPolicy('accessory');
    app.dock?.hide();
  });
}

// Lets a test confirm the helper ran before the app's main module was loaded.
const mainModule = require('path').join('dist', 'main.js');
globalThis.__listenerHiddenE2E = {
  loadedBeforeMain: !Object.keys(require.cache).some((file) => file.endsWith(mainModule)),
};
