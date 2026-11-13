// The only Google sign-in a packaged seed may carry: fixed non-token strings,
// an example.invalid address, and an expiry far enough ahead that no refresh
// request is attempted during a case (refresh starts within 60s of expiry).
export const SYNTHETIC_GOOGLE_OAUTH = Object.freeze({
  access: 'synthetic-not-a-token',
  refresh: 'synthetic-not-a-refresh',
  email: 'synthetic@example.invalid',
});

function isSyntheticGoogleOAuth(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== 'access,email,expires,refresh') return false;
  if (
    record.access !== SYNTHETIC_GOOGLE_OAUTH.access ||
    record.refresh !== SYNTHETIC_GOOGLE_OAUTH.refresh ||
    record.email !== SYNTHETIC_GOOGLE_OAUTH.email
  )
    return false;
  const now = Date.now();
  return (
    typeof record.expires === 'number' &&
    Number.isSafeInteger(record.expires) &&
    record.expires >= now + 10 * 60_000 &&
    record.expires <= now + 48 * 60 * 60_000
  );
}

// Test-only guards for an unmodified packaged executable. Installation happens
// after boot; this cannot prove that no OS activation occurred before it.
export function assertPackagedSeed(config: Record<string, unknown>, rootEntries: string[]): void {
  const allowedEntries = new Set([
    'recordings',
    'metadata',
    'transcriptions',
    'config.json',
    'sync-state.json',
    'fixture-before.json',
    'fixture-after.json',
  ]);
  for (const entry of rootEntries)
    if (!allowedEntries.has(entry)) throw new Error(`Unsafe packaged seed entry: ${entry}`);
  for (const key of [
    'googleDriveEnabled',
    'autoMode',
    'meetingDetection',
    'displayDetection',
    'recordSystemAudio',
  ])
    if (config[key] !== undefined && config[key] !== false)
      throw new Error(`Packaged seed must disable ${key}`);
  if (config.lastSeenVersion !== undefined && config.lastSeenVersion !== '')
    throw new Error('Packaged seeds must not trigger upgrade release-note fetching.');
  const syntheticKeys = new Set(['geminiApiKey', 'openaiApiKey', 'sonioxApiKey']);
  for (const [key, value] of Object.entries(config)) {
    if (!/api.?key|oauth|token|password|secret|webhook|auth/i.test(key)) continue;
    if (value === undefined || value === '') continue;
    if (syntheticKeys.has(key) && value === 'synthetic-unused-key') continue;
    if (
      key === 'codexOAuth' &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      Object.hasOwn(value, 'access') &&
      (value as { access?: unknown }).access === 'synthetic-not-a-token'
    )
      continue;
    // A synthetic Drive sign-in is allowed only while automatic sync is
    // explicitly off; Drive calls must go through an installed fake client.
    if (
      key === 'googleOAuth' &&
      config.googleDriveEnabled === false &&
      isSyntheticGoogleOAuth(value)
    )
      continue;
    throw new Error(`Credentials are forbidden in packaged seeds: ${key}`);
  }
}

// Self-contained for Playwright's app.evaluate serialization. Do not reference
// imports, module variables, or other exported functions from this body.
export type PackagedProofContext = {
  outputPath: string;
  caseName: string;
  caseOrder: number;
  artifactSha256: string;
};

export function installPackagedGuards(
  electron: typeof import('electron'),
  input: { expectedAsar: string; proofContext: PackagedProofContext },
): {
  phase: 'post-boot';
  appPath: string;
  windowId: number | null;
  captureWindowId: number | null;
  electronVersion: string | undefined;
  observations: unknown[];
  pid: number;
  artifactSha256?: string;
} {
  const { expectedAsar, proofContext } = input;
  const { app, BrowserWindow, shell, dialog, systemPreferences, desktopCapturer, globalShortcut } =
    electron;
  if (
    !app.isPackaged ||
    typeof expectedAsar !== 'string' ||
    !/[\\/]app\.asar$/.test(expectedAsar) ||
    app.getAppPath() !== expectedAsar ||
    process.env.NODE_ENV !== 'test' ||
    process.env.LISTENER_BACKGROUND_TEST !== '1'
  )
    throw new Error('Packaged guards require the verified ASAR and explicit background test mode.');
  const windows = BrowserWindow.getAllWindows();
  // The main window the invariants hold to: the boot window, or the one a
  // case adopted after deliberately destroying it (adoptMainWindow).
  let pinnedMain = windows[0];
  const roleOfUrl = (url: unknown): 'main' | 'capture' | null => {
    if (typeof url !== 'string') return null;
    const path = url.split(/[?#]/)[0];
    if (path.endsWith('/renderer/index.html')) return 'main';
    if (path.endsWith('/renderer/capture.html')) return 'capture';
    return null;
  };
  if ((globalThis as any).__listenerPackagedGuardProof)
    throw new Error('Packaged guards must be installed once per owned process.');

  const effects: string[] = [];
  let ledgerInstalled = false;
  const proof = {
    phase: 'post-boot' as const,
    appPath: app.getAppPath(),
    windowId: windows[0]?.id ?? null,
    // The hidden recording capture host, pinned when first observed.
    captureWindowId: null as number | null,
    electronVersion: process.versions?.electron,
    observations: [] as unknown[],
    pid: process.pid,
    artifactSha256: undefined as string | undefined,
  };
  let context: PackagedProofContext | undefined;
  const persist = (stage: string, failedFields: string[] = []) => {
    if (!context) return;
    process.mainModule!.require('node:fs').writeFileSync(
      context.outputPath,
      JSON.stringify(
        {
          ...proof,
          caseName: context.caseName,
          caseOrder: context.caseOrder,
          stage,
          failedFields,
          ledger: [...effects],
          ledgerInstalled,
          ledgerIdentityMatches: ledgerInstalled
            ? (globalThis as any).__listenerTestNativeEffects === effects
            : null,
        },
        null,
        2,
      ) + '\n',
    );
  };
  const configureProof = (next: PackagedProofContext) => {
    const path = process.mainModule!.require('node:path') as typeof import('node:path');
    if (
      !next ||
      typeof next.outputPath !== 'string' ||
      !path.isAbsolute(next.outputPath) ||
      typeof next.caseName !== 'string' ||
      !next.caseName ||
      !Number.isInteger(next.caseOrder) ||
      next.caseOrder < 0 ||
      !/^[a-f0-9]{64}$/i.test(next.artifactSha256) ||
      (proof.artifactSha256 !== undefined && proof.artifactSha256 !== next.artifactSha256)
    )
      throw new Error(
        'Packaged proof requires an absolute evidence path and stable artifact identity.',
      );
    const relative = path.relative(app.getPath('userData'), next.outputPath);
    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)))
      throw new Error('Packaged proof must survive outside the disposable app data root.');
    context = { ...next };
    proof.artifactSha256 = next.artifactSha256;
    process
      .mainModule!.require('node:fs')
      .mkdirSync(path.dirname(next.outputPath), { recursive: true });
    persist('proof-configured');
  };
  configureProof(proofContext);
  observeNativeState('before-guard-install', windows, {
    url: (window) => window.webContents.getURL(),
    visible: (window) => window.isVisible(),
    focused: (window) => window.isFocused(),
    focusable: (window) => window.isFocusable(),
    devTools: (window) => window.webContents.isDevToolsOpened(),
    dockVisible: () => {
      if (!app.dock) throw new Error('Native Dock API is unavailable.');
      return app.dock.isVisible();
    },
  });

  // Validate required surfaces before changing any method or global.
  // macOS audiotee capture bypasses Electron's session permission handlers.
  const systemAudio = process.mainModule!.require(
    `${expectedAsar}/dist/services/systemAudioService.js`,
  ).SystemAudioService;
  // These exported entry points cover unmocked Node clients used by the
  // reviewed offline paths. Cached native references are not an OS firewall.
  const http = process.mainModule!.require('node:http');
  const https = process.mainModule!.require('node:https');
  const net = process.mainModule!.require('node:net');
  const tls = process.mainModule!.require('node:tls');
  const methods: Array<[any, string, string]> = [
    ...['openExternal', 'openPath', 'showItemInFolder'].map((name): [any, string, string] => [
      shell,
      name,
      `shell.${name}`,
    ]),
    ...[
      'showOpenDialog',
      'showOpenDialogSync',
      'showSaveDialog',
      'showSaveDialogSync',
      'showMessageBox',
      'showMessageBoxSync',
      'showErrorBox',
    ].map((name): [any, string, string] => [dialog, name, `dialog.${name}`]),
    [desktopCapturer, 'getSources', 'desktop capture'],
    [systemAudio?.prototype, 'start', 'system audio capture'],
    [electron.Notification.prototype, 'show', 'notification.show'],
    [globalShortcut, 'register', 'shortcut.register'],
    [globalShortcut, 'registerAll', 'shortcut.registerAll'],
    [app, 'focus', 'app.focus'],
    [globalThis, 'fetch', 'unmocked provider fetch'],
    [http, 'request', 'http.request'],
    [http, 'get', 'http.get'],
    [https, 'request', 'https.request'],
    [https, 'get', 'https.get'],
    [net, 'connect', 'net.connect'],
    [net, 'createConnection', 'net.createConnection'],
    [tls, 'connect', 'tls.connect'],
  ];
  // Electron exposes this native permission prompt only on macOS.
  if (process.platform === 'darwin')
    methods.push([systemPreferences, 'askForMediaAccess', 'media permission']);
  if (app.dock) methods.push([app.dock, 'show', 'dock.show'], [app.dock, 'bounce', 'dock.bounce']);
  const assertReplaceable = (object: any, key: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (
      descriptor
        ? !descriptor.configurable && !('value' in descriptor && descriptor.writable)
        : !Object.isExtensible(object)
    )
      throw new Error(`Required packaged guard property cannot be replaced: ${key}`);
  };
  for (const [object, key] of methods) {
    if (typeof object?.[key] !== 'function')
      throw new Error(`Required packaged guard surface is missing: ${key}`);
    assertReplaceable(object, key);
  }
  (globalThis as any).__listenerTestNativeEffects = effects;
  ledgerInstalled = true;
  const forbidden =
    (name: string) =>
    (..._args: unknown[]) => {
      effects.push(name);
      throw new Error(`Native effect forbidden in background tests: ${name}`);
    };
  const guards: Array<[any, string, (...args: any[]) => unknown, PropertyDescriptor, boolean]> = [];
  const install = (object: any, key: string, blocker: (...args: any[]) => unknown) => {
    assertReplaceable(object, key);
    const original = Object.getOwnPropertyDescriptor(object, key);
    const descriptor = {
      value: blocker,
      writable: true,
      enumerable: original?.enumerable ?? true,
      configurable: original?.configurable ?? true,
    };
    // Explicit definition handles configurable read-only properties/accessors
    // and inherited methods. A fixed own property remains a hard rejection.
    // Electron 43 globalShortcut forwards SET and descriptor reads to its
    // native instance, but GET creates a fresh bound function. defineProperty
    // writes only its proxy target, so this one surface must use SET instead.
    const forwarded = object === globalShortcut;
    if (forwarded) {
      if (!Reflect.set(object, key, blocker))
        throw new Error(`Could not set forwarded packaged guard: ${key}`);
    } else {
      Object.defineProperty(object, key, descriptor);
    }
    const installed = Object.getOwnPropertyDescriptor(object, key);
    if (installed?.value !== blocker || (!forwarded && object[key] !== blocker))
      throw new Error(`Could not install packaged guard: ${key}`);
    guards.push([object, key, blocker, installed, forwarded]);
  };
  for (const [object, key, label] of methods) {
    install(object, key, forbidden(label));
  }
  const wrap = (window: Electron.BrowserWindow) => {
    for (const name of ['show', 'showInactive', 'focus', 'moveTop', 'restore'] as const)
      install(window, name, forbidden(`window.${name}`));
    install(window.webContents, 'openDevTools', forbidden('window.openDevTools'));
  };
  windows.forEach(wrap);
  const onWindow = (_event: unknown, window: Electron.BrowserWindow) => {
    wrap(window);
    if (window.isVisible() || window.isFocused() || window.isFocusable())
      forbidden('unsafe future native window creation')();
  };
  app.on('browser-window-created', onWindow);
  const session = electron.session.defaultSession;
  const setRequest = session.setPermissionRequestHandler;
  const setCheck = session.setPermissionCheckHandler;
  const setDisplay = session.setDisplayMediaRequestHandler;
  const setNetwork = session.webRequest.onBeforeRequest;
  const request: Parameters<typeof setRequest>[0] = (_contents, permission, callback) => {
    effects.push(`permission:${permission}`);
    callback(false);
  };
  const check: Parameters<typeof setCheck>[0] = () => false;
  const display: Parameters<typeof setDisplay>[0] = (_request, callback) => {
    effects.push('display media permission');
    callback({});
  };
  const network = (_details: unknown, callback: (response: { cancel: boolean }) => void) => {
    effects.push('unmocked renderer network');
    callback({ cancel: true });
  };
  const reinstallCallbacks = () => {
    setRequest.call(session, request);
    setCheck.call(session, check);
    setDisplay.call(session, display);
    Reflect.apply(setNetwork, session.webRequest, [
      { urls: ['http://*/*', 'https://*/*'] },
      network,
    ]);
  };
  reinstallCallbacks();
  // Electron does not expose getters for installed permission/network handlers.
  // Protect the setters and reinstall the captured callbacks after each case.
  install(session, 'setPermissionRequestHandler', forbidden('permission handler replacement'));
  install(session, 'setPermissionCheckHandler', forbidden('permission check replacement'));
  install(session, 'setDisplayMediaRequestHandler', forbidden('display media handler replacement'));
  install(session.webRequest, 'onBeforeRequest', forbidden('network handler replacement'));
  (globalThis as any).__listenerPackagedGuardProof = proof;
  const nativeLookups = {
    allWindows: BrowserWindow.getAllWindows,
    appPath: app.getAppPath,
    dock: app.dock,
    dockVisible: app.dock?.isVisible,
    visible: windows[0].isVisible,
    focused: windows[0].isFocused,
    focusable: windows[0].isFocusable,
    devTools: windows[0].webContents.isDevToolsOpened,
    url: windows[0].webContents.getURL,
    on: app.on,
    listeners: app.listeners,
  };
  const assertLedger = (stage = 'guard-ledger') => {
    if ((globalThis as any).__listenerTestNativeEffects !== effects || effects.length) {
      persist(stage, ['ledger']);
      throw new Error(
        `Mandatory packaged effect ledger was replaced or recorded an attempt: ${JSON.stringify({
          stage,
          observations: proof.observations,
        })}`,
      );
    }
  };
  // A fixture may deliberately replace provider/shell methods. This narrower
  // observation still checks the ledger and unmodified native inspection paths.
  const assertNativeState = (stage = 'native-state') => {
    assertLedger(stage);
    if (
      electron.BrowserWindow !== BrowserWindow ||
      BrowserWindow.getAllWindows !== nativeLookups.allWindows ||
      app.getAppPath !== nativeLookups.appPath ||
      app.getAppPath() !== expectedAsar ||
      !app.isPackaged ||
      app.dock !== nativeLookups.dock ||
      app.dock?.isVisible !== nativeLookups.dockVisible ||
      pinnedMain.isVisible !== nativeLookups.visible ||
      pinnedMain.isFocused !== nativeLookups.focused ||
      pinnedMain.isFocusable !== nativeLookups.focusable ||
      pinnedMain.webContents.isDevToolsOpened !== nativeLookups.devTools ||
      pinnedMain.webContents.getURL !== nativeLookups.url ||
      app.on !== nativeLookups.on ||
      app.listeners !== nativeLookups.listeners ||
      !nativeLookups.listeners.call(app, 'browser-window-created').includes(onWindow) ||
      process.env.NODE_ENV !== 'test' ||
      process.env.LISTENER_BACKGROUND_TEST !== '1'
    ) {
      persist(stage, ['nativeIdentity']);
      throw new Error(
        `Native packaged identity or background opt-in changed: ${JSON.stringify({
          stage,
          observations: proof.observations,
        })}`,
      );
    }
    observeNativeState(stage, nativeLookups.allWindows.call(BrowserWindow), {
      url: (window) => nativeLookups.url.call(window.webContents),
      visible: (window) => nativeLookups.visible.call(window),
      focused: (window) => nativeLookups.focused.call(window),
      focusable: (window) => nativeLookups.focusable.call(window),
      devTools: (window) => nativeLookups.devTools.call(window.webContents),
      dockVisible: () => nativeLookups.dockVisible!.call(app.dock),
    });
  };
  // Windows are identified by role: the boot main window (same reference and
  // ID) and at most one hidden recording capture host, pinned at the ID it
  // was first seen with. Every window must be hidden, unfocused,
  // non-focusable and without DevTools; any other window fails.
  function observeNativeState(
    stage: string,
    current: Electron.BrowserWindow[],
    queries: {
      url(window: Electron.BrowserWindow): string;
      visible(window: Electron.BrowserWindow): boolean;
      focused(window: Electron.BrowserWindow): boolean;
      focusable(window: Electron.BrowserWindow): boolean;
      devTools(window: Electron.BrowserWindow): boolean;
      dockVisible(): boolean;
    },
  ): void {
    const read = <T>(query: () => T): T | { error: string } => {
      try {
        return query();
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    };
    const roleOf = roleOfUrl;
    const snapshot = {
      expected: {
        count: 1,
        captureCountMax: 1,
        windowId: proof.windowId,
        captureWindowId: proof.captureWindowId,
        referenceMatches: true,
        visible: false,
        focused: false,
        focusable: false,
        devTools: false,
        dockVisible: process.platform === 'darwin' ? false : null,
      },
      actual: {
        count: current.length,
        windowIds: current.map((window) => window.id),
        windows: current.map((window) => {
          const url = read(() => queries.url(window));
          return {
            id: window.id,
            role: roleOf(url),
            referenceMatches: window === pinnedMain,
            visible: read(() => queries.visible(window)),
            focused: read(() => queries.focused(window)),
            focusable: read(() => queries.focusable(window)),
            devTools: read(() => queries.devTools(window)),
          };
        }),
        dockVisible: process.platform === 'darwin' ? read(() => queries.dockVisible()) : null,
      },
    };
    const all = snapshot.actual.windows;
    const mains = all.filter((w) => w.role === 'main');
    const captures = all.filter((w) => w.role === 'capture');
    const main = mains[0];
    const capture = captures[0];
    const matchedExpected = {
      count:
        mains.length === 1 &&
        captures.length <= 1 &&
        mains.length + captures.length === all.length,
      windowId: main?.id === proof.windowId,
      referenceMatches: main?.referenceMatches === true,
      captureWindowId:
        !capture || proof.captureWindowId === null || capture.id === proof.captureWindowId,
      visible: all.length > 0 && all.every((w) => w.visible === false),
      focused: all.length > 0 && all.every((w) => w.focused === false),
      focusable: all.length > 0 && all.every((w) => w.focusable === false),
      devTools: all.length > 0 && all.every((w) => w.devTools === false),
      dockVisible: process.platform !== 'darwin' || snapshot.actual.dockVisible === false,
    };
    if (capture && proof.captureWindowId === null && matchedExpected.captureWindowId)
      proof.captureWindowId = capture.id;
    const observation = {
      stage,
      caseName: context?.caseName,
      caseOrder: context?.caseOrder,
      ...snapshot,
      matchedExpected,
    };
    proof.observations.push(observation);
    if (proof.observations.length > 12) proof.observations.shift();
    const failedFields = Object.entries(matchedExpected)
      .filter(([, matched]) => !matched)
      .map(([field]) => field);
    persist(stage, failedFields);
    if (failedFields.length)
      throw new Error(
        `Native packaged window or Dock invariant changed: ${JSON.stringify({
          ...observation,
          observations: proof.observations,
        })}`,
      );
  }
  const assertIntact = (stage = 'assert-intact') => {
    assertLedger(stage);
    for (const [object, key, blocker, descriptor, forwarded] of guards) {
      const current = Object.getOwnPropertyDescriptor(object, key);
      if (
        current?.value !== blocker ||
        current.configurable !== descriptor.configurable ||
        current.writable !== descriptor.writable ||
        current.enumerable !== descriptor.enumerable ||
        (!forwarded && object[key] !== blocker)
      ) {
        persist(stage, [`guard:${key}`]);
        throw new Error(`Mandatory packaged guard changed: ${key}`);
      }
    }
    assertNativeState(stage);
  };
  const restoreAndAssert = () => {
    assertLedger();
    for (const [object, key, blocker, descriptor, forwarded] of guards) {
      if (forwarded) {
        if (!Reflect.set(object, key, blocker))
          throw new Error(`Could not restore forwarded packaged guard: ${key}`);
      } else {
        Object.defineProperty(object, key, descriptor);
      }
    }
    if (!nativeLookups.listeners.call(app, 'browser-window-created').includes(onWindow))
      Reflect.apply(nativeLookups.on, app, ['browser-window-created', onWindow]);
    reinstallCallbacks();
    assertIntact('after-guard-restore');
  };
  Object.defineProperty(globalThis, '__listenerPackagedGuards', {
    value: Object.freeze({
      restoreAndAssert,
      assertIntact,
      assertNativeState,
      configureProof,
      // A test that deliberately crashed the capture host releases its pinned
      // ID; the next host is pinned when observed.
      releaseCaptureHost: () => {
        proof.captureWindowId = null;
        persist('capture-host-released');
      },
      // A case that deliberately destroyed the main window (Windows/Linux
      // close) adopts its replacement. Refused while the pinned main window
      // still exists or unless exactly one main window exists now; the
      // replacement must then pass every hidden-window invariant.
      adoptMainWindow: () => {
        const current = nativeLookups.allWindows.call(BrowserWindow);
        if (current.includes(pinnedMain)) {
          persist('main-window-adopt-refused', ['mainWindowAlive']);
          throw new Error('The pinned main window still exists; only a destroyed one is replaced.');
        }
        const mains = current.filter(
          (window) => roleOfUrl(nativeLookups.url.call(window.webContents)) === 'main',
        );
        if (mains.length !== 1) {
          persist('main-window-adopt-refused', ['mainWindowCount']);
          throw new Error(`Expected exactly one replacement main window, found ${mains.length}.`);
        }
        pinnedMain = mains[0];
        proof.windowId = pinnedMain.id;
        assertIntact('main-window-adopted');
      },
    }),
    writable: false,
    configurable: false,
  });
  assertIntact('after-install');
  return proof;
}
