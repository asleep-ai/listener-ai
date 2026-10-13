import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createContext, runInContext } from 'node:vm';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  statSync,
  readdirSync,
  symlinkSync,
  watch,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  OwnedSession,
  assertCleanReset,
  assertSingleHiddenWindow,
  bounded,
  clearOwnedFixtureData,
} from './reusable-lifecycle.ts';
import { classifyCase } from './case-policy.ts';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('fixture cleanup preserves directory inodes and the live recordings watcher across cases', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'listener-owned-watch-'));
  clearOwnedFixtureData(directory, true);
  const protectedNames = ['recordings', 'metadata', 'transcriptions'];
  const inodes = protectedNames.map((name) => statSync(join(directory, name)).ino);
  const events = new Map<string, () => void>();
  const watcher = watch(join(directory, 'recordings'), (_event, name) => {
    if (name) events.get(name.toString())?.();
  });
  try {
    // The two modes are the exact operations used by seed() and finish().
    for (const includeConfig of [true, false]) {
      writeFileSync(join(directory, 'config.json'), '{}');
      for (const name of protectedNames)
        writeFileSync(join(directory, name, 'previous-case'), 'synthetic');
      clearOwnedFixtureData(directory, includeConfig);
      assert.deepEqual(
        protectedNames.map((name) => statSync(join(directory, name)).ino),
        inodes,
      );
      for (const name of protectedNames) assert.deepEqual(readdirSync(join(directory, name)), []);
      assert.equal(existsSync(join(directory, 'config.json')), !includeConfig);
      const file = `new-merge-${includeConfig}.webm`;
      const seen = deferred();
      events.set(file, () => seen.resolve());
      writeFileSync(join(directory, 'recordings', file), 'synthetic audio');
      await bounded(seen.promise, 2_000, 'Existing watcher observes a new merged recording');
    }
  } finally {
    watcher.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('fixture cleanup rejects a protected directory symlink before deleting any synthetic data', () => {
  const directory = mkdtempSync(join(tmpdir(), 'listener-owned-symlink-'));
  const target = mkdtempSync(join(tmpdir(), 'listener-owned-symlink-target-'));
  try {
    clearOwnedFixtureData(directory);
    const sentinel = join(directory, 'recordings', 'keep-until-validation');
    writeFileSync(sentinel, 'synthetic');
    writeFileSync(join(target, 'keep-target'), 'synthetic target');
    rmSync(join(directory, 'metadata'), { recursive: true });
    symlinkSync(target, join(directory, 'metadata'), 'dir');
    assert.throws(() => clearOwnedFixtureData(directory), /metadata/);
    assert.equal(readFileSync(sentinel, 'utf8'), 'synthetic');
    assert.equal(readFileSync(join(target, 'keep-target'), 'utf8'), 'synthetic target');
    rmSync(target, { recursive: true });
    assert.throws(() => clearOwnedFixtureData(directory), /metadata/);
    assert.equal(readFileSync(sentinel, 'utf8'), 'synthetic');
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('one owned resource survives repeated acquisition and closes exactly once', async () => {
  const resource = { id: 1 };
  let creates = 0;
  let initializes = 0;
  let disposals = 0;
  const owner = new OwnedSession(
    async () => {
      creates++;
      return resource;
    },
    async () => {
      disposals++;
    },
  );
  const initialize = async () => {
    initializes++;
  };
  assert.equal(await owner.acquire(initialize), resource);
  assert.equal(await owner.acquire(initialize), resource);
  assert.equal(creates, 1);
  assert.equal(initializes, 1);
  await owner.close();
  await owner.close();
  assert.equal(disposals, 1);
  await assert.rejects(owner.acquire(initialize), /unavailable/);
});

test('concurrent acquisition cannot expose a resource before initialization finishes', async () => {
  const created = deferred<{ id: number }>();
  const entered = deferred();
  const ready = deferred();
  const owner = new OwnedSession(
    () => created.promise,
    async () => {},
  );
  const first = owner.acquire(async () => {
    entered.resolve();
    await ready.promise;
  });
  try {
    await assert.rejects(
      owner.acquire(async () => {}),
      /Concurrent/,
    );
    created.resolve({ id: 1 });
    await entered.promise;
    await assert.rejects(
      owner.acquire(async () => {}),
      /Concurrent/,
    );
  } finally {
    ready.resolve();
    await first;
    await owner.close();
  }
});

for (const stage of ['initialize', 'reset'] as const) {
  test(`${stage} failure disposes its resource and refuses a replacement launch`, async () => {
    let creates = 0;
    let disposals = 0;
    const owner = new OwnedSession(
      async () => {
        creates++;
        return { id: 1 };
      },
      async () => {
        disposals++;
      },
    );
    const failure = new Error(`${stage} broke`);
    if (stage === 'initialize') {
      await assert.rejects(
        owner.acquire(async () => {
          throw failure;
        }),
        (error) => error === failure,
      );
    } else {
      await owner.acquire(async () => {});
      await assert.rejects(
        owner.reset(async () => {
          throw failure;
        }),
        (error) => error === failure,
      );
    }
    await assert.rejects(
      owner.acquire(async () => {}),
      /unavailable/,
    );
    await owner.close();
    assert.equal(creates, 1);
    assert.equal(disposals, 1);
  });
}

test('case reset clears persisted fixtures and mock behavior; omitted reset fails the same checks', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'listener-owned-reset-'));
  const config = join(directory, 'config.json');
  const sentinel = join(directory, 'previous-case');
  const original = () => 'original';
  const state = { invoke: original };
  const owner = new OwnedSession(
    async () => state,
    async () => {},
  );
  const assertClean = () => {
    assert.equal(existsSync(sentinel), false);
    assert.deepEqual(JSON.parse(readFileSync(config, 'utf8')), { autoMode: false });
    assert.equal(state.invoke(), 'original');
  };
  try {
    await owner.acquire(async () => {});
    writeFileSync(sentinel, 'previous case data');
    writeFileSync(config, JSON.stringify({ autoMode: true }));
    state.invoke = () => 'previous mock';
    assert.throws(assertClean, assert.AssertionError);
    await owner.reset(async (resource) => {
      rmSync(sentinel);
      writeFileSync(config, JSON.stringify({ autoMode: false }));
      resource.invoke = original;
    });
    assertClean();
  } finally {
    await owner.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const committed of [false, true]) {
  test(`reset waits for ${committed ? 'committed completion' : 'precommit cancellation'} before deleting fixtures`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'listener-owned-job-'));
    const sentinel = join(directory, 'job-input');
    writeFileSync(sentinel, 'job data');
    const settled = deferred();
    const draining = deferred();
    let cancelled = false;
    const owner = new OwnedSession(
      async () => ({ committed }),
      async () => {},
    );
    try {
      await owner.acquire(async () => {});
      const resetting = owner.reset(async (job) => {
        cancelled = !job.committed;
        draining.resolve();
        await settled.promise;
        rmSync(sentinel);
      });
      await draining.promise;
      assert.equal(cancelled, !committed);
      assert.equal(existsSync(sentinel), true);
      settled.resolve();
      await resetting;
      assert.equal(existsSync(sentinel), false);
    } finally {
      settled.resolve();
      await owner.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('a drain timeout poisons the owned session and disposes it without deleting live fixture data', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'listener-owned-timeout-'));
  const sentinel = join(directory, 'job-input');
  writeFileSync(sentinel, 'still owned by job');
  let disposals = 0;
  const owner = new OwnedSession(
    async () => ({}),
    async () => {
      disposals++;
    },
  );
  try {
    await owner.acquire(async () => {});
    await assert.rejects(
      owner.reset(async () => {
        await bounded(new Promise<void>(() => {}), 10, 'job drain');
        rmSync(sentinel);
      }),
      /job drain exceeded 10ms/,
    );
    assert.equal(existsSync(sentinel), true);
    assert.equal(disposals, 1);
    await assert.rejects(
      owner.acquire(async () => {}),
      /unavailable/,
    );
  } finally {
    await owner.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('hidden window proof rejects missing, additional, visible, focused, developer-tools and replaced windows', () => {
  const hidden = { id: 7, visible: false, focused: false, focusable: false, devTools: false };
  assert.equal(assertSingleHiddenWindow([hidden], 7), 7);
  for (const windows of [
    [],
    [hidden, { ...hidden, id: 8 }],
    [{ ...hidden, visible: true }],
    [{ ...hidden, focused: true }],
    [{ ...hidden, devTools: true }],
    [{ ...hidden, focusable: true }],
    [{ ...hidden, id: 8 }],
  ])
    assert.throws(() => assertSingleHiddenWindow(windows, 7), /same single hidden/);
});

test('clean reset proof rejects each independent contamination and an omitted reset, then accepts restored state', () => {
  const clean = {
    activeJobs: 0,
    pendingInvocations: 0,
    configMatches: true,
    mocksRestored: true,
    dataEmpty: true,
  };
  assert.doesNotThrow(() => assertCleanReset(clean));
  for (const dirty of [
    { activeJobs: 1 },
    { pendingInvocations: 1 },
    { configMatches: false },
    { mocksRestored: false },
    { dataEmpty: false },
  ])
    assert.throws(() => assertCleanReset({ ...clean, ...dirty }), /Test isolation failed/);
  const previousCase = {
    activeJobs: 1,
    pendingInvocations: 1,
    configMatches: false,
    mocksRestored: false,
    dataEmpty: false,
  };
  assert.throws(() => assertCleanReset(previousCase), /Test isolation failed/);
  Object.assign(previousCase, clean);
  assert.doesNotThrow(() => assertCleanReset(previousCase));
});

test('case policy keeps warm behavioral suites separate from fresh startup and opt-in visual contracts', () => {
  for (const [file, group] of [
    ['settings.spec.ts', 'settings'],
    ['transcript-cutoff.spec.ts', 'cutoff'],
    ['transcription-reload.spec.ts', 'reload'],
    ['chatgpt-integration.spec.ts', 'chatgpt'],
  ]) {
    const policy = classifyCase(`/repo/e2e/${file}`, 'ordinary behavior');
    assert.equal(policy.kind, 'shared');
    assert.equal(policy.group, group);
    assert.ok(policy.reason);
  }
  for (const [file, title, group] of [
    ['settings.spec.ts', 'captures every Settings tab for visual review', 'settings-shots'],
    [
      'chatgpt-integration.spec.ts',
      'startup without credentials opens without AI setup prompt',
      'chatgpt-startup',
    ],
    ['hidden-launch.spec.ts', 'hidden from creation', 'hidden-startup'],
    ['smoke.spec.ts', 'packaged app boots without crashing', 'package-smoke'],
  ]) {
    const policy = classifyCase(`C:\\repo\\e2e\\${file}`, title);
    assert.equal(policy.kind, 'fresh');
    assert.equal(policy.group, group);
    assert.ok(policy.reason);
  }
  assert.throws(
    () => classifyCase('new-suite.spec.ts', 'unknown case'),
    /Unclassified Electron test/,
  );
});

test('failed initialization kills and reaps only its actually owned Node child PID', async () => {
  let child: ChildProcess | undefined;
  let pid: number | undefined;
  let exited: Promise<unknown[]> | undefined;
  let disposedPid: number | undefined;
  const failure = new Error('initialization failed after process creation');
  const owner = new OwnedSession(
    async () => {
      child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      });
      exited = once(child, 'exit');
      await once(child, 'spawn');
      pid = child.pid;
      assert.ok(pid);
      assert.doesNotThrow(() => process.kill(pid!, 0));
      return { child, pid, exited };
    },
    async (resource) => {
      disposedPid = resource.pid;
      assert.equal(resource.child.kill('SIGTERM'), true);
      await bounded(resource.exited, 2_000, 'Owned Node child shutdown');
    },
  );
  try {
    await assert.rejects(
      owner.acquire(async () => {
        throw failure;
      }),
      (error) => error === failure,
    );
    assert.equal(disposedPid, pid);
    assert.ok(child);
    assert.equal(child.signalCode, 'SIGTERM');
    assert.throws(
      () => process.kill(pid!, 0),
      (error: unknown) =>
        !!error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH',
    );
    await assert.rejects(
      owner.acquire(async () => {}),
      /unavailable/,
    );
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await bounded(exited!, 2_000, 'Owned Node child fallback shutdown');
    }
    await owner.close();
  }
});

const hiddenPreload = readFileSync(new URL('./hidden-electron.cjs', import.meta.url), 'utf8');

test('hidden preload rejects either missing opt-in before loading Electron or installing hooks', () => {
  for (const env of [
    { NODE_ENV: 'development', LISTENER_BACKGROUND_TEST: '1' },
    { NODE_ENV: 'test' },
  ]) {
    let requireCalls = 0;
    const context = createContext({
      process: { env },
      require: () => {
        requireCalls++;
        throw new Error('require must not run');
      },
    });
    assert.throws(() => runInContext(hiddenPreload, context), /explicit background test mode/);
    assert.equal(requireCalls, 0);
    assert.equal(context.__listenerHiddenE2E, undefined);
    assert.equal(context.__listenerTestNativeEffects, undefined);
  }
});

test('actual hidden preload preserves native enumeration and blocks native I/O before app code', async () => {
  let nativeCalls = 0;
  const native = () => {
    nativeCalls++;
  };
  const windows: NativeWindow[] = [];
  class NativeWindow {
    options: Record<string, any>;
    webContents = { openDevTools: native };
    show = native;
    showInactive = native;
    focus = native;
    moveTop = native;
    restore = native;
    constructor(options: Record<string, any>) {
      this.options = options;
      windows.push(this);
    }
    static getAllWindows() {
      assert.equal(this, NativeWindow);
      return windows;
    }
  }
  let requestPermission: (...args: any[]) => void;
  let checkPermission: () => boolean;
  const shell = Object.fromEntries(
    ['openExternal', 'openPath', 'showItemInFolder'].map((name) => [name, native]),
  );
  const dialog = Object.fromEntries(
    [
      'showOpenDialog',
      'showOpenDialogSync',
      'showSaveDialog',
      'showSaveDialogSync',
      'showMessageBox',
      'showMessageBoxSync',
      'showErrorBox',
    ].map((name) => [name, native]),
  );
  const electron = {
    BrowserWindow: NativeWindow,
    shell,
    dialog,
    systemPreferences: { askForMediaAccess: native },
    app: { whenReady: () => Promise.resolve(), on: () => {} },
    session: {
      defaultSession: {
        setPermissionRequestHandler: (handler: typeof requestPermission) => {
          requestPermission = handler;
        },
        setPermissionCheckHandler: (handler: typeof checkPermission) => {
          checkPermission = handler;
        },
      },
    },
  };
  const module = {
    _load: (name: string) => {
      assert.equal(name, 'electron');
      return electron;
    },
  };
  const require = Object.assign(
    (name: string): any => {
      if (name === 'node:module') return module;
      if (name === 'node:path') return { join };
      return module._load(name);
    },
    { cache: {} },
  );
  const context = createContext({
    process: { env: { NODE_ENV: 'test', LISTENER_BACKGROUND_TEST: '1' }, platform: 'linux' },
    require,
    fetch: native,
  });
  runInContext(hiddenPreload, context);
  await Promise.resolve();
  const patched = require('electron');
  const window = new patched.BrowserWindow({ show: true, focusable: true });
  assert.equal(patched.BrowserWindow.getAllWindows().length, 1);
  assert.equal(patched.BrowserWindow.getAllWindows()[0], window);
  assert.equal(window.options.show, false);
  assert.equal(window.options.focusable, false);
  assert.equal(window.options.skipTaskbar, true);
  assert.equal(window.options.webPreferences.backgroundThrottling, false);
  assert.equal(window.hiddenForE2E, true);
  for (const name of ['show', 'showInactive', 'focus', 'moveTop', 'restore']) window[name]();
  window.webContents.openDevTools();
  const windowEffects = [
    'unsafe native window creation options',
    'window.show',
    'window.showInactive',
    'window.focus',
    'window.moveTop',
    'window.restore',
  ];
  assert.deepEqual(Array.from(context.__listenerTestNativeEffects), windowEffects);
  context.__listenerAllowWindowGuardProbe = true;
  try {
    for (const name of ['show', 'showInactive', 'focus', 'moveTop', 'restore']) window[name]();
    assert.deepEqual(Array.from(context.__listenerTestNativeEffects), windowEffects);
  } finally {
    delete context.__listenerAllowWindowGuardProbe;
  }
  for (const effect of [
    ...Object.values(shell),
    ...Object.values(dialog),
    electron.systemPreferences.askForMediaAccess,
    context.fetch,
  ])
    assert.throws(() => effect('test'), /Native effect forbidden/);
  const expectedEffects = [
    ...windowEffects,
    'shell.openExternal',
    'shell.openPath',
    'shell.showItemInFolder',
    'dialog.showOpenDialog',
    'dialog.showOpenDialogSync',
    'dialog.showSaveDialog',
    'dialog.showSaveDialogSync',
    'dialog.showMessageBox',
    'dialog.showMessageBoxSync',
    'dialog.showErrorBox',
    'media permission',
    'unmocked provider fetch',
  ];
  assert.deepEqual(Array.from(context.__listenerTestNativeEffects), expectedEffects);
  let permitted: boolean | undefined;
  requestPermission!(null, 'media', (value: boolean) => {
    permitted = value;
  });
  assert.equal(permitted, false);
  assert.equal(checkPermission!(), false);
  assert.deepEqual(Array.from(context.__listenerTestNativeEffects), [
    ...expectedEffects,
    'permission:media',
  ]);
  assert.equal(nativeCalls, 0);
  assert.equal(context.__listenerHiddenE2E.loadedBeforeMain, true);
});
