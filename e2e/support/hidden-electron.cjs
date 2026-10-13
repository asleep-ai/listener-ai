// TEST-ONLY preload, installed before the development app entry.
// Native constructors remain native so enumeration cannot pass vacuously.
'use strict';
if (process.env.NODE_ENV !== 'test' || process.env.LISTENER_BACKGROUND_TEST !== '1') {
  throw new Error('Hidden Electron preload requires explicit background test mode.');
}
const Module = require('node:module');
const electron = require('electron');
const { app } = electron;
const effects = [];
globalThis.__listenerTestNativeEffects = effects;
const forbidden =
  (name) =>
  (..._args) => {
    effects.push(name);
    throw new Error(`Native effect forbidden in background tests: ${name}`);
  };
for (const name of ['openExternal', 'openPath', 'showItemInFolder'])
  electron.shell[name] = forbidden(`shell.${name}`);
for (const name of [
  'showOpenDialog',
  'showOpenDialogSync',
  'showSaveDialog',
  'showSaveDialogSync',
  'showMessageBox',
  'showMessageBoxSync',
  'showErrorBox',
])
  electron.dialog[name] = forbidden(`dialog.${name}`);
electron.systemPreferences.askForMediaAccess = forbidden('media permission');
globalThis.fetch = forbidden('unmocked provider fetch');
if (process.platform === 'darwin') app.setActivationPolicy('accessory');
app.whenReady().then(() => {
  electron.session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    effects.push(`permission:${permission}`);
    callback(false);
  });
  electron.session.defaultSession.setPermissionCheckHandler(() => false);
  if (process.platform === 'darwin') app.dock?.hide();
});
const HiddenBrowserWindow = new Proxy(electron.BrowserWindow, {
  construct(target, [options = {}]) {
    if (options.show !== false || options.focusable !== false)
      effects.push('unsafe native window creation options');
    const window = new target({
      ...options,
      show: false,
      focusable: false,
      skipTaskbar: true,
      webPreferences: { ...options.webPreferences, backgroundThrottling: false },
    });
    window.hiddenForE2E = true;
    for (const name of ['show', 'showInactive', 'focus', 'moveTop', 'restore'])
      window[name] = () => {
        if (!globalThis.__listenerAllowWindowGuardProbe) effects.push(`window.${name}`);
      };
    window.webContents.openDevTools = () => {};
    return window;
  },
  get(target, key) {
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
const hiddenElectron = new Proxy(electron, {
  get: (target, key) => (key === 'BrowserWindow' ? HiddenBrowserWindow : target[key]),
});
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  return request === 'electron' ? hiddenElectron : originalLoad.call(this, request, parent, isMain);
};
app.on('web-contents-created', (_event, contents) => {
  contents.openDevTools = () => {};
});
const mainModule = require('node:path').join('dist', 'main.js');
globalThis.__listenerHiddenE2E = {
  loadedBeforeMain: !Object.keys(require.cache).some((file) => file.endsWith(mainModule)),
};
