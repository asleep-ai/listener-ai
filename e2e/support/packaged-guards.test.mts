import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { assertPackagedSeed, installPackagedGuards } from './packaged-guards.ts';

const ownedEvidence: string[] = [];
after(() => {
  for (const directory of ownedEvidence) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture(options: Record<string, unknown> = {}) {
  const evidenceDir = fs.mkdtempSync(path.join(tmpdir(), 'listener-guard-fixture-'));
  ownedEvidence.push(evidenceDir);
  const initialProofContext = {
    outputPath: path.join(evidenceDir, 'proof.json'),
    caseName: 'VM guard fixture',
    caseOrder: 0,
    artifactSha256: 'a'.repeat(64),
  };
  const context = createContext({
    process: {
      env: { NODE_ENV: 'test', LISTENER_BACKGROUND_TEST: '1' },
      platform: options.platform ?? 'darwin',
      versions: { electron: '43.3.0' },
      pid: 12345,
    },
    options,
    ownedFs: fs,
    ownedPath: path,
  });
  runInContext(
    `
    const calls = [];
    const original = (name) => (...args) => { calls.push(name); return args; };
    const listeners = new Map();
    class NativeWindow {
      constructor(options = {}) {
        this.id = options.id ?? 1;
        this.options = options;
        this.isVisible = () => !!options.visible;
        this.isFocused = () => !!options.focused;
        this.isFocusable = () => !!options.focusable;
        this.webContents = {
          isDevToolsOpened: () => !!options.devTools,
          openDevTools: original('devTools'),
        };
        for (const name of ['show', 'showInactive', 'focus', 'moveTop', 'restore'])
          this[name] = original('window.' + name);
      }
      static getAllWindows() { return windows.slice(); }
    }
    const windows = options.noWindows ? [] : [new NativeWindow(options)];
    if (options.extraWindow) windows.push(new NativeWindow({id: 2}));
    class Notification { show() { calls.push('notification.show'); } }
    class SystemAudioService { start() { calls.push('native system audio'); } }
    const transports = {
      'node:http': { request: original('http.request'), get: original('http.get') },
      'node:https': { request: original('https.request'), get: original('https.get') },
      'node:net': { connect: original('net.connect'), createConnection: original('net.createConnection') },
      'node:tls': { connect: original('tls.connect') },
    };
    process.mainModule = { require: (path) => {
      if (path === 'node:fs') return ownedFs;
      if (path === 'node:path') return ownedPath;
      if (transports[path]) return transports[path];
      if (path !== (options.appPath ?? '/verified/resources/app.asar') + '/dist/services/systemAudioService.js')
        throw new Error('Unexpected packaged module path');
      return { SystemAudioService };
    } };
    const session = {
      setPermissionRequestHandler: (handler) => { session.request = handler; },
      setPermissionCheckHandler: (handler) => { session.check = handler; },
      setDisplayMediaRequestHandler: (handler) => { session.display = handler; },
      webRequest: { onBeforeRequest: (_filter, handler) => { session.network = handler; } },
    };
    const app = {
      isPackaged: options.packaged !== false,
      getAppPath: () => options.appPath ?? '/verified/resources/app.asar',
      getPath: () => '/owned/disposable-data',
      focus: original('app.focus'),
      on: (event, handler) => { listeners.set(event, handler); },
      listeners: (event) => listeners.has(event) ? [listeners.get(event)] : [],
      dock: {
        isVisible: () => !!options.dockVisible,
        show: original('dock.show'), bounce: original('dock.bounce'),
      },
    };
    const shell = Object.fromEntries(['openExternal', 'openPath', 'showItemInFolder'].map(
      (name) => [name, original('shell.' + name)]));
    const dialog = Object.fromEntries([
      'showOpenDialog', 'showOpenDialogSync', 'showSaveDialog', 'showSaveDialogSync',
      'showMessageBox', 'showMessageBoxSync', 'showErrorBox',
    ].map((name) => [name, original('dialog.' + name)]));
    globalThis.fetch = original('fetch');
    globalThis.fixture = {
      calls, listeners, windows, NativeWindow, session, SystemAudioService, transports,
      electron: {
        app, shell, dialog, BrowserWindow: NativeWindow, Notification,
        systemPreferences: { askForMediaAccess: original('media') },
        desktopCapturer: { getSources: original('desktop') },
        globalShortcut: { register: original('shortcut'), registerAll: original('shortcuts') },
        session: { defaultSession: session },
      },
    };
    if (options.boundShortcutProxy) {
      const native = fixture.electron.globalShortcut;
      fixture.shortcutNative = native;
      fixture.electron.globalShortcut = new Proxy({}, {
        get: (_target, property) => {
          const value = native[property];
          return typeof value === 'function' ? value.bind(native) : value;
        },
        set: (_target, property, value) => options.rejectShortcutSet
          ? false : Reflect.set(native, property, value),
        ownKeys: () => Reflect.ownKeys(native),
        has: (_target, property) => property in native,
        getOwnPropertyDescriptor: (_target, property) => Reflect.getOwnPropertyDescriptor(native, property),
      });
    }
    `,
    context,
  );
  return {
    context,
    state: runInContext('fixture', context) as any,
    evidencePath: initialProofContext.outputPath,
    install(
      expected = '/verified/resources/app.asar',
      proofContext: unknown = initialProofContext,
    ) {
      context.expected = expected;
      context.initialProofContext = proofContext;
      return runInContext(
        `(${installPackagedGuards.toString()})(fixture.electron, { expectedAsar: expected, proofContext: initialProofContext })`,
        context,
      );
    },
  };
}

test('packaged guard serializes without imports and preserves native constructor and options', () => {
  const f = fixture();
  const constructor = f.state.electron.BrowserWindow;
  const options = f.state.windows[0].options;
  const proof = f.install();
  assert.equal(proof.phase, 'post-boot');
  assert.equal(proof.appPath, '/verified/resources/app.asar');
  assert.equal(proof.windowId, 1);
  assert.equal(proof.electronVersion, '43.3.0');
  assert.equal(f.state.electron.BrowserWindow, constructor);
  assert.equal(f.state.windows[0].options, options);
  assert.equal(f.state.calls.length, 0);
});

for (const [name, options] of [
  ['development app', { packaged: false }],
  ['wrong artifact', { appPath: '/different/app.asar' }],
  ['visible window', { visible: true }],
  ['focused window', { focused: true }],
  ['focusable window', { focusable: true }],
  ['DevTools', { devTools: true }],
  ['visible Dock', { dockVisible: true }],
  ['missing window', { noWindows: true }],
  ['extra window', { extraWindow: true }],
] as const) {
  test(`rejects ${name} before mutation`, () => {
    const f = fixture(options);
    const open = f.state.electron.shell.openExternal;
    const originalFetch = runInContext('fetch', f.context);
    assert.throws(() => f.install());
    assert.equal(f.state.electron.shell.openExternal, open);
    assert.equal(runInContext('fetch', f.context), originalFetch);
    assert.equal(runInContext('globalThis.__listenerTestNativeEffects', f.context), undefined);
    assert.equal(f.state.listeners.size, 0);
  });
}

test('rejects missing opt-in or unverified path before mutation', () => {
  for (const script of [
    `delete process.env.NODE_ENV`,
    `process.env.LISTENER_BACKGROUND_TEST = '0'`,
  ]) {
    const f = fixture();
    runInContext(script, f.context);
    assert.throws(() => f.install());
    assert.equal(runInContext('globalThis.__listenerTestNativeEffects', f.context), undefined);
  }
  const f = fixture();
  assert.throws(() => f.install('/verified/resources'));
});

test('missing mandatory capture guard rejects before mutation', () => {
  const f = fixture();
  const open = f.state.electron.shell.openExternal;
  f.state.SystemAudioService.prototype.start = undefined;
  assert.throws(() => f.install(), /Required packaged guard surface is missing/);
  assert.equal(f.state.electron.shell.openExternal, open);
  assert.equal(runInContext('globalThis.__listenerTestNativeEffects', f.context), undefined);
});

for (const platform of ['linux', 'win32']) {
  test(`${platform} without macOS permission API retains mandatory blockers and permission denial`, () => {
    const f = fixture({ platform });
    delete f.state.electron.systemPreferences.askForMediaAccess;
    f.install();
    runInContext('__listenerPackagedGuards.assertIntact()', f.context);
    for (const attempt of [
      () => f.state.electron.shell.openExternal('https://example.com'),
      () => f.state.electron.desktopCapturer.getSources({ types: ['screen'] }),
      () => new f.state.SystemAudioService().start(),
      () => f.state.transports['node:https'].request('https://example.com'),
      () => f.state.windows[0].show(),
    ]) {
      assert.throws(attempt, /Native effect forbidden/);
    }
    let permission: unknown;
    f.state.session.request({}, 'media', (allowed: unknown) => {
      permission = allowed;
    });
    assert.equal(permission, false);
    assert.equal(f.state.session.check(), false);
    assert.equal(runInContext('__listenerTestNativeEffects.length', f.context), 6);
    assert.equal(f.state.calls.length, 0);
    assert.throws(
      () => runInContext('__listenerPackagedGuards.restoreAndAssert()', f.context),
      /Mandatory packaged effect ledger was replaced or recorded an attempt/,
    );
  });
}

test('macOS requires its native permission API before installing hooks', () => {
  const f = fixture({ platform: 'darwin' });
  const open = f.state.electron.shell.openExternal;
  delete f.state.electron.systemPreferences.askForMediaAccess;
  assert.throws(() => f.install(), /Required packaged guard surface is missing: askForMediaAccess/);
  assert.equal(f.state.electron.shell.openExternal, open);
  assert.equal(f.state.listeners.size, 0);
  assert.equal(f.state.session.request, undefined);
  assert.equal(runInContext('globalThis.__listenerTestNativeEffects', f.context), undefined);
  assert.equal(runInContext('globalThis.__listenerPackagedGuards', f.context), undefined);
  assert.equal(f.state.calls.length, 0);
});

for (const shape of ['readonly', 'accessor', 'inherited'] as const) {
  test(`defines and restores a blocker over ${shape} method properties`, () => {
    const f = fixture();
    f.context.shape = shape;
    runInContext(
      `
      const surface = fixture.electron.shell;
      const nativeOpen = surface.openExternal;
      if (shape === 'readonly') {
        Object.defineProperty(surface, 'openExternal', {
          value: nativeOpen, writable: false, configurable: true,
        });
      } else if (shape === 'accessor') {
        Object.defineProperty(surface, 'openExternal', {
          get: () => nativeOpen, configurable: true,
        });
      } else {
        delete surface.openExternal;
        const prototype = {};
        Object.defineProperty(prototype, 'openExternal', {
          value: nativeOpen, writable: false, configurable: false,
        });
        Object.setPrototypeOf(surface, prototype);
      }
      `,
      f.context,
    );
    f.install();
    const surface = f.state.electron.shell;
    const blocker = surface.openExternal;
    const guards = runInContext('__listenerPackagedGuards', f.context);
    Object.defineProperty(surface, 'openExternal', { get: () => () => {}, configurable: true });
    assert.throws(() => guards.assertIntact(), /Mandatory packaged guard changed/);
    guards.restoreAndAssert();
    assert.equal(surface.openExternal, blocker);
    assert.equal(Object.getOwnPropertyDescriptor(surface, 'openExternal')?.value, blocker);
    assert.equal(f.state.calls.length, 0);
    assert.throws(() => surface.openExternal(), /shell.openExternal/);
    assert.equal(f.state.calls.length, 0);
  });
}

test('fixed own native-shaped method rejects before installing any guard', () => {
  const f = fixture();
  const open = f.state.electron.shell.openExternal;
  Object.defineProperty(f.state.electron.globalShortcut, 'register', {
    value: f.state.electron.globalShortcut.register,
    writable: false,
    configurable: false,
  });
  assert.throws(() => f.install(), /guard property cannot be replaced: register/);
  assert.equal(f.state.electron.shell.openExternal, open);
  assert.equal(runInContext('globalThis.__listenerTestNativeEffects', f.context), undefined);
});

test('Electron 43 bound Proxy installs and restores the underlying shortcut blocker', () => {
  const f = fixture({ boundShortcutProxy: true });
  const shortcut = f.state.electron.globalShortcut;
  assert.notEqual(shortcut.register, shortcut.register);
  f.install();
  const guards = runInContext('__listenerPackagedGuards', f.context);
  const blocker = Object.getOwnPropertyDescriptor(shortcut, 'register')!.value;
  assert.equal(f.state.shortcutNative.register, blocker);
  assert.notEqual(shortcut.register, blocker);
  guards.assertIntact();
  f.state.shortcutNative.register = () => {};
  assert.throws(() => guards.assertIntact(), /Mandatory packaged guard changed/);
  guards.restoreAndAssert();
  assert.equal(f.state.shortcutNative.register, blocker);
  guards.assertIntact();
  assert.throws(() => shortcut.register(), /shortcut.register/);
  assert.equal(f.state.calls.length, 0);
  assert.equal(runInContext('__listenerTestNativeEffects.length', f.context), 1);
});

test('rejected Proxy SET fails closed without a defineProperty fallback', () => {
  const f = fixture({ boundShortcutProxy: true, rejectShortcutSet: true });
  const native = f.state.shortcutNative.register;
  assert.throws(() => f.install(), /Could not set forwarded packaged guard/);
  assert.equal(f.state.shortcutNative.register, native);
  assert.equal(f.state.calls.length, 0);
});

test('all blocked native attempts are recorded and never reach originals', () => {
  const f = fixture();
  f.install();
  const e = f.state.electron;
  const attempts = [
    ...Object.values(e.shell),
    ...Object.values(e.dialog),
    e.systemPreferences.askForMediaAccess,
    e.desktopCapturer.getSources,
    f.state.SystemAudioService.prototype.start,
    e.Notification.prototype.show,
    e.globalShortcut.register,
    e.globalShortcut.registerAll,
    e.app.focus,
    e.app.dock.show,
    e.app.dock.bounce,
    runInContext('fetch', f.context),
    ...Object.values(f.state.transports).flatMap((module: any) => Object.values(module)),
    ...['show', 'showInactive', 'focus', 'moveTop', 'restore'].map(
      (name) => f.state.windows[0][name],
    ),
    f.state.windows[0].webContents.openDevTools,
  ] as (() => unknown)[];
  for (const attempt of attempts) assert.throws(() => attempt(), /Native effect forbidden/);
  assert.equal(runInContext('__listenerTestNativeEffects.length', f.context), attempts.length);
  assert.equal(f.state.calls.length, 0);
});

test('future native windows are wrapped and unsafe creation is a recorded failure', () => {
  const f = fixture();
  f.install();
  const safe = new f.state.NativeWindow({ id: 2 });
  f.state.listeners.get('browser-window-created')({}, safe);
  assert.throws(() => safe.show(), /window.show/);
  const unsafe = new f.state.NativeWindow({ id: 3, visible: true });
  assert.throws(
    () => f.state.listeners.get('browser-window-created')({}, unsafe),
    /unsafe future native window creation/,
  );
  assert.equal(unsafe.options.visible, true);
  assert.equal(f.state.calls.length, 0);
});

test('media permission and renderer network attempts are denied and recorded', () => {
  const f = fixture();
  f.install();
  let permission: unknown;
  f.state.session.request({}, 'media', (value: unknown) => {
    permission = value;
  });
  assert.equal(permission, false);
  assert.equal(f.state.session.check(), false);
  let display: unknown;
  f.state.session.display({}, (value: unknown) => {
    display = value;
  });
  assert.equal(Object.keys(display as object).length, 0);
  let network: any;
  f.state.session.network({}, (value: unknown) => {
    network = value;
  });
  assert.equal(network.cancel, true);
  assert.equal(runInContext('__listenerTestNativeEffects.length', f.context), 3);
});

test('omitting restore detects changed blocker and restoring reinstalls blocker identity', () => {
  const f = fixture();
  f.install();
  const guards = runInContext('__listenerPackagedGuards', f.context);
  const e = f.state.electron;
  const targets = [
    [e.shell, 'openExternal'],
    [e.dialog, 'showMessageBox'],
    [e.Notification.prototype, 'show'],
    [e.desktopCapturer, 'getSources'],
    [f.state.SystemAudioService.prototype, 'start'],
    [e.app.dock, 'show'],
    [e.globalShortcut, 'register'],
    [f.state.windows[0], 'focus'],
    [f.state.windows[0].webContents, 'openDevTools'],
    [f.state.transports['node:https'], 'request'],
    [f.state.session, 'setPermissionRequestHandler'],
    [f.state.session.webRequest, 'onBeforeRequest'],
  ] as const;
  const originalCallbacks = ['request', 'check', 'display', 'network'].map(
    (key) => f.state.session[key],
  );
  for (const [object, key] of targets) {
    const blocker = object[key];
    object[key] = () => {};
    assert.throws(() => guards.assertIntact(), /Mandatory packaged guard changed/);
    guards.restoreAndAssert();
    assert.equal(object[key], blocker);
    guards.assertIntact();
  }
  for (const [index, key] of ['request', 'check', 'display', 'network'].entries())
    assert.equal(f.state.session[key], originalCallbacks[index]);
  assert.equal(runInContext('__listenerTestNativeEffects.length', f.context), 0);
});

test('a recorded attempt or replaced ledger prevents restore without clearing evidence', () => {
  const attempted = fixture();
  attempted.install();
  const guards = runInContext('__listenerPackagedGuards', attempted.context);
  assert.throws(() => attempted.state.electron.shell.openExternal());
  assert.throws(() => guards.restoreAndAssert(), /effect ledger/);
  assert.equal(runInContext('__listenerTestNativeEffects.length', attempted.context), 1);
  const replaced = fixture();
  replaced.install();
  const originalGuards = runInContext('__listenerPackagedGuards', replaced.context);
  runInContext('__listenerTestNativeEffects = []', replaced.context);
  assert.throws(() => originalGuards.restoreAndAssert(), /effect ledger/);
});

test('native state and inspection identity are checked without correcting them', () => {
  const f = fixture();
  f.install();
  const guards = runInContext('__listenerPackagedGuards', f.context);
  f.state.windows[0].options.visible = true;
  assert.throws(() => guards.restoreAndAssert(), /window or Dock invariant/);
  assert.equal(f.state.windows[0].options.visible, true);
  f.state.windows[0].options.visible = false;
  f.state.windows[0].isVisible = () => false;
  assert.throws(() => guards.assertIntact(), /Native packaged identity/);
});

for (const [field, mutate] of [
  ['count', (state: any) => state.windows.push(new state.NativeWindow({ id: 2 }))],
  [
    'windowId',
    (state: any) => {
      state.windows[0].id = 2;
    },
  ],
  [
    'referenceMatches',
    (state: any) => {
      state.windows[0] = new state.NativeWindow({ id: 1 });
    },
  ],
  [
    'visible',
    (state: any) => {
      state.windows[0].options.visible = true;
    },
  ],
  [
    'focused',
    (state: any) => {
      state.windows[0].options.focused = true;
    },
  ],
  [
    'focusable',
    (state: any) => {
      state.windows[0].options.focusable = true;
    },
  ],
  [
    'devTools',
    (state: any) => {
      state.windows[0].options.devTools = true;
    },
  ],
  [
    'dockVisible',
    (state: any) => {
      state.windows[0].options.dockVisible = true;
    },
  ],
] as const) {
  test(`native invariant diagnostic identifies ${field}`, () => {
    const f = fixture();
    f.install();
    mutate(f.state);
    const guards = runInContext('__listenerPackagedGuards', f.context);
    assert.throws(
      () => guards.assertIntact(),
      (error: any) => {
        const prefix = 'Native packaged window or Dock invariant changed: ';
        assert.ok(error.message.startsWith(prefix));
        const diagnostic = JSON.parse(error.message.slice(prefix.length));
        assert.equal(diagnostic.matchedExpected[field], false);
        assert.equal(diagnostic.expected.windowId, 1);
        assert.equal(diagnostic.actual.count, f.state.windows.length);
        assert.deepEqual(
          diagnostic.actual.windowIds,
          Array.from(f.state.windows, (window: any) => window.id),
        );
        if (field === 'windowId') assert.equal(diagnostic.actual.windowIds[0], 2);
        else if (field === 'dockVisible') assert.equal(diagnostic.actual.dockVisible, true);
        else if (field !== 'count')
          assert.equal(
            diagnostic.actual.windows[0][field],
            field === 'referenceMatches' ? false : true,
          );
        return true;
      },
    );
    assert.equal(runInContext('__listenerTestNativeEffects.length', f.context), 0);
  });
}

test('permission-handler replacement is blocked and recorded', () => {
  const f = fixture();
  f.install();
  assert.throws(() => f.state.session.setPermissionRequestHandler(() => {}), /replacement/);
  assert.throws(
    () => runInContext('__listenerPackagedGuards.restoreAndAssert()', f.context),
    /effect ledger/,
  );
});

test('native stage history includes the failing screenshot state without correcting it', () => {
  const f = fixture();
  const proof = f.install();
  const guards = runInContext('__listenerPackagedGuards', f.context);
  guards.assertNativeState('before-screenshot');
  f.state.windows[0].options.visible = true;
  assert.throws(
    () => guards.assertNativeState('after-screenshot'),
    (error: any) => {
      const prefix = 'Native packaged window or Dock invariant changed: ';
      const diagnostic = JSON.parse(error.message.slice(prefix.length));
      assert.equal(diagnostic.stage, 'after-screenshot');
      assert.equal(diagnostic.matchedExpected.visible, false);
      assert.equal(diagnostic.actual.windows[0].visible, true);
      assert.deepEqual(
        diagnostic.observations.map((entry: any) => entry.stage),
        ['before-guard-install', 'after-install', 'before-screenshot', 'after-screenshot'],
      );
      assert.equal(diagnostic.observations.at(-1).matchedExpected.visible, false);
      return true;
    },
  );
  assert.equal(proof.observations.length, 4);
  assert.equal(f.state.windows[0].options.visible, true);
});

test('native observations allow fixture egress mocks while full integrity still requires restore', () => {
  const f = fixture();
  const proof = f.install();
  const guards = runInContext('__listenerPackagedGuards', f.context);
  f.state.electron.shell.openExternal = () => {};
  guards.assertNativeState('during-fixture-mock');
  assert.throws(() => guards.assertIntact('before-reset'), /Mandatory packaged guard changed/);
  guards.restoreAndAssert();
  assert.equal(proof.observations.at(-1).stage, 'after-guard-restore');
  guards.assertIntact('after-reset');
  assert.equal(proof.observations.at(-1).stage, 'after-reset');
  assert.equal(runInContext('__listenerTestNativeEffects.length', f.context), 0);
});

test('native stage observations retain the most recent twelve checks', () => {
  const f = fixture();
  const proof = f.install();
  const guards = runInContext('__listenerPackagedGuards', f.context);
  for (let index = 0; index < 20; index++) guards.assertNativeState(`step-${index}`);
  assert.equal(proof.observations.length, 12);
  assert.equal(proof.observations[0].stage, 'step-8');
  assert.equal(proof.observations.at(-1).stage, 'step-19');
});

test('native-only checks still reject inspection tampering and ledger attempts with stage context', () => {
  const tampered = fixture();
  tampered.install();
  const guards = runInContext('__listenerPackagedGuards', tampered.context);
  tampered.state.windows[0].isVisible = () => false;
  assert.throws(() => guards.assertNativeState('after-reset'), /identity.*after-reset/);
  const attempted = fixture();
  attempted.install();
  assert.throws(() => attempted.state.electron.shell.openExternal());
  assert.throws(
    () =>
      runInContext(
        '__listenerPackagedGuards.assertNativeState("after-screenshot")',
        attempted.context,
      ),
    /effect ledger.*after-screenshot/,
  );
});

test('owned evidence is synchronously persisted before native failure throws', () => {
  const evidence = fs.mkdtempSync(path.join(tmpdir(), 'listener-guard-proof-'));
  try {
    const f = fixture();
    f.install();
    const guards = runInContext('__listenerPackagedGuards', f.context);
    const outputPath = path.join(evidence, 'proof.json');
    guards.configureProof({
      outputPath,
      caseName: 'Synthetic same-email case',
      caseOrder: 11,
      artifactSha256: 'a'.repeat(64),
    });
    guards.assertNativeState('before-screenshot');
    f.state.windows[0].options.visible = true;
    assert.throws(
      () => guards.assertNativeState('after-screenshot'),
      (error: any) => {
        assert.match(error.message, /Native packaged window or Dock invariant changed/);
        const saved = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
        assert.equal(saved.pid, 12345);
        assert.equal(saved.windowId, 1);
        assert.equal(saved.appPath, '/verified/resources/app.asar');
        assert.equal(saved.electronVersion, '43.3.0');
        assert.equal(saved.artifactSha256, 'a'.repeat(64));
        assert.equal(saved.caseName, 'Synthetic same-email case');
        assert.equal(saved.caseOrder, 11);
        assert.equal(saved.stage, 'after-screenshot');
        assert.deepEqual(saved.failedFields, ['visible']);
        assert.deepEqual(saved.ledger, []);
        assert.equal(saved.ledgerIdentityMatches, true);
        assert.equal(saved.observations[0].caseName, 'VM guard fixture');
        assert.equal(saved.observations.at(-1).actual.windows[0].visible, true);
        return true;
      },
    );
    assert.equal(f.state.windows[0].options.visible, true);
    guards.configureProof({
      outputPath,
      caseName: 'Another synthetic case',
      caseOrder: 12,
      artifactSha256: 'a'.repeat(64),
    });
    const saved = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(saved.observations[0].caseName, 'VM guard fixture');
    assert.equal(saved.observations.at(-1).caseOrder, 11);
  } finally {
    fs.rmSync(evidence, { recursive: true, force: true });
  }
});

test('initial native failure is persisted before throwing without installing or correcting hooks', () => {
  const f = fixture({ visible: true });
  const original = f.state.electron.shell.openExternal;
  assert.throws(
    () => f.install(),
    (error: any) => {
      assert.match(error.message, /Native packaged window or Dock invariant changed/);
      const saved = JSON.parse(fs.readFileSync(f.evidencePath, 'utf8'));
      assert.equal(saved.stage, 'before-guard-install');
      assert.equal(saved.pid, 12345);
      assert.equal(saved.windowId, 1);
      assert.equal(saved.artifactSha256, 'a'.repeat(64));
      assert.equal(saved.caseName, 'VM guard fixture');
      assert.equal(saved.caseOrder, 0);
      assert.equal(saved.observations[0].actual.count, 1);
      assert.equal(saved.observations[0].actual.windows[0].visible, true);
      assert.deepEqual(saved.failedFields, ['visible']);
      assert.equal(saved.ledgerInstalled, false);
      assert.equal(saved.ledgerIdentityMatches, null);
      return true;
    },
  );
  assert.equal(f.state.electron.shell.openExternal, original);
  assert.equal(f.state.windows[0].options.visible, true);
  assert.equal(f.state.listeners.size, 0);
  assert.equal(runInContext('globalThis.__listenerTestNativeEffects', f.context), undefined);
});

test('invalid initial proof context rejects before snapshot, file output, or native hooks', () => {
  const f = fixture();
  const original = f.state.electron.shell.openExternal;
  assert.throws(
    () =>
      f.install('/verified/resources/app.asar', {
        outputPath: f.evidencePath,
        caseName: 'Invalid proof',
        caseOrder: 0,
        artifactSha256: 'not-a-hash',
      }),
    /stable artifact identity/,
  );
  assert.equal(fs.existsSync(f.evidencePath), false);
  assert.equal(f.state.electron.shell.openExternal, original);
  assert.equal(f.state.listeners.size, 0);
  assert.equal(runInContext('globalThis.__listenerTestNativeEffects', f.context), undefined);
});

test('proof output rejects disposable roots and changed artifact identity', () => {
  const evidence = fs.mkdtempSync(path.join(tmpdir(), 'listener-guard-proof-'));
  try {
    const f = fixture();
    f.install();
    const guards = runInContext('__listenerPackagedGuards', f.context);
    const context = {
      outputPath: path.join(evidence, 'proof.json'),
      caseName: 'Synthetic case',
      caseOrder: 1,
      artifactSha256: 'a'.repeat(64),
    };
    assert.throws(
      () => guards.configureProof({ ...context, outputPath: '/owned/disposable-data/proof.json' }),
      /outside the disposable app data root/,
    );
    assert.throws(() => guards.configureProof({ ...context, outputPath: 'relative.json' }));
    guards.configureProof(context);
    assert.throws(
      () => guards.configureProof({ ...context, artifactSha256: 'b'.repeat(64) }),
      /stable artifact identity/,
    );
  } finally {
    fs.rmSync(evidence, { recursive: true, force: true });
  }
});

test('future-window guard listener is restored without accumulating handlers', () => {
  const f = fixture();
  f.install();
  const guards = runInContext('__listenerPackagedGuards', f.context);
  const listener = f.state.listeners.get('browser-window-created');
  f.state.listeners.delete('browser-window-created');
  assert.throws(() => guards.assertIntact(), /Native packaged identity/);
  guards.restoreAndAssert();
  assert.equal(f.state.listeners.get('browser-window-created'), listener);
  guards.restoreAndAssert();
  assert.equal(f.state.listeners.size, 1);
});

test('packaged seed permits only exact synthetic credentials and seed entries', () => {
  assertPackagedSeed({}, []);
  assertPackagedSeed({ geminiApiKey: 'synthetic-unused-key', autoMode: false }, ['config.json']);
  assertPackagedSeed({ codexOAuth: { access: 'synthetic-not-a-token' } }, [
    'recordings',
    'metadata',
    'transcriptions',
    'fixture-before.json',
  ]);
  for (const config of [
    { geminiApiKey: 'real-key' },
    { geminiApiKey: 'synthetic-different-key' },
    { googleOAuth: { access_token: 'real' } },
    { codexOAuth: { access: 'synthetic-not-a-token', refresh: 'real' } },
    { notionApiKey: 'synthetic-unused-key' },
    { slackWebhookUrl: 'https://example.invalid' },
    { lastSeenVersion: '1.0.0' },
    ...[
      'googleDriveEnabled',
      'autoMode',
      'meetingDetection',
      'displayDetection',
      'recordSystemAudio',
    ].map((key) => ({ [key]: true })),
  ])
    assert.throws(() => assertPackagedSeed(config, []));
  for (const entry of ['chatgpt', 'auth.json', 'codex-cli', '../recordings', 'unknown'])
    assert.throws(() => assertPackagedSeed({}, [entry]));
});
