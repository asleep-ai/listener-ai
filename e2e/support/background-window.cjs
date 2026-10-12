// Test-only preload for Electron launches (`electron -r <this file> .`): keeps
// the app out of the user's way while Playwright drives it. Windows still
// render and take CDP input and screenshots, but they are created hidden, shown
// transparent without activation, never take focus, and skip DevTools; the app
// gets no Dock icon. Production code is untouched: the app's own
// `require('electron')` receives a BrowserWindow constructor proxy only here.
const Module = require('node:module');
const electron = require('electron');

if (process.platform === 'darwin') {
  electron.app.setActivationPolicy('accessory');
}

const BackgroundWindow = new Proxy(electron.BrowserWindow, {
  construct(target, [options = {}]) {
    const window = new target({ ...options, show: false });
    window.setOpacity(0);
    window.setSkipTaskbar(true);
    window.show = () => window.showInactive();
    window.focus = () => {};
    window.webContents.openDevTools = () => {};
    if (options.show !== false) window.showInactive();
    return window;
  },
  // Electron's static lookups must use the native constructor as their
  // receiver so real windows remain discoverable by Playwright and assertions.
  get(target, key) {
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

const patched = new Proxy(electron, {
  get: (target, key) => (key === 'BrowserWindow' ? BackgroundWindow : target[key]),
});
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === 'electron' ? patched : load.call(this, request, ...rest);
};
