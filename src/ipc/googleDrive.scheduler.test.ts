// Automatic Drive sync is owned by main and must run with no window and no
// Settings interaction: the real googleDrive module is registered with no
// main window, its scheduler is started the way main.ts starts it at launch,
// and only mocked timers advance it. GoogleDriveClient's methods delegate to
// an in-memory Drive, so files are really transferred without the network.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import Module from 'node:module';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import type { TranscriptionResult } from '../geminiService';
import { saveTranscription } from '../outputService';
import { FakeDrive } from '../services/fakeDriveForTests';
import { GoogleDriveClient } from '../services/googleDriveService';
import { makeTempDir, rmDir } from '../test-helpers';
import type { IpcContext } from './types';

type ModuleWithLoad = typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

const result: TranscriptionResult = {
  transcript: 'Speech',
  summary: 'Summary',
  keyPoints: [],
  actionItems: [],
  emoji: '',
};
const DRIVE_METHODS = [
  'ensureFolder',
  'listFolder',
  'uploadFile',
  'getFile',
  'downloadFile',
  'trashFile',
  'deleteFile',
] as const;

type SyncModule = {
  register: (ctx: IpcContext) => void;
  refreshGoogleSyncTimer: () => void;
  maybeAutoSync: () => void;
};

type Status = {
  inFlight: boolean;
  authenticated: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
  enabled: boolean;
};

describe('automatic Drive sync with no window and Settings never opened', () => {
  let originalLoad: ModuleWithLoad['_load'];
  let originals: Record<string, unknown>;
  let handlers: Map<string, (...args: unknown[]) => unknown>;
  let dataPath: string;
  let drive: FakeDrive;
  let mod: SyncModule;
  // What this process cached when it loaded config.json, and what the file
  // says now (another process such as the CLI may have changed it).
  let cachedEnabled: boolean;
  let persistedEnabled: boolean;
  type Creds = { email: string; refresh: string; access: string; expires: number };
  // `creds` is config.json now; `cachedCreds` is what this process loaded.
  let creds: Creds | undefined;
  let cachedCreds: Creds | undefined;
  // Status events a window would receive; null means no window at all.
  let sent: Array<{ channel: string; payload: { phase?: string } }> | null;
  // When set, Drive listing waits for it, holding a cycle in flight.
  let listGate: Promise<void> | null;
  let listError: Error | null;
  let settingsIpcCalls: string[];

  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    dataPath = makeTempDir('ipc-sync-scheduler');
    fs.mkdirSync(path.join(dataPath, 'recordings'), { recursive: true });
    drive = new FakeDrive();
    cachedEnabled = true;
    persistedEnabled = true;
    creds = { email: 'a@example.com', refresh: 'ra', access: 'x', expires: Date.now() + 1e9 };
    cachedCreds = creds;
    sent = null;
    listGate = null;
    listError = null;
    settingsIpcCalls = [];
    handlers = new Map();

    originals = {};
    const proto = GoogleDriveClient.prototype as unknown as Record<string, unknown>;
    const fake = drive as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const name of DRIVE_METHODS) {
      originals[name] = proto[name];
      proto[name] = (...args: unknown[]) => fake[name](...args);
    }
    proto.listFolder = async (...args: unknown[]) => {
      if (listGate) await listGate;
      if (listError) {
        const error = listError;
        listError = null;
        throw error;
      }
      return fake.listFolder(...args);
    };

    const fakeElectron = {
      ipcMain: {
        handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
      },
      app: { getPath: () => dataPath },
      shell: {},
    };
    const moduleAny = Module as ModuleWithLoad;
    originalLoad = moduleAny._load;
    moduleAny._load = function (request: string, parent: NodeModule | null, isMain: boolean) {
      if (request === 'electron') return fakeElectron;
      return originalLoad.call(this, request, parent, isMain);
    };
    const modPath = require.resolve('./googleDrive');
    delete require.cache[modPath];
    mod = require('./googleDrive') as SyncModule;
    const configService = {
      getGoogleOAuth: () => cachedCreds,
      readPersistedGoogleOAuth: () => creds ?? null,
      readPersistedStoredGoogleOAuth: () => creds,
      hasGoogleOAuth: () => !!cachedCreds,
      hasStoredGoogleOAuth: () => false,
      getGoogleDriveEnabled: () => cachedEnabled,
      readPersistedGoogleDriveEnabled: () => persistedEnabled,
      getAudioOffloadAfterDays: () => 0,
      getKnownWords: () => [],
      setKnownWords: () => {},
    };
    mod.register({
      getMainWindow: () =>
        sent
          ? {
              isDestroyed: () => false,
              webContents: {
                send: (channel: string, payload: { phase?: string }) =>
                  sent!.push({ channel, payload }),
              },
            }
          : null,
      configService: configService as unknown as IpcContext['configService'],
      isAudioInUse: () => false,
      applyConfigSideEffects: () => settingsIpcCalls.push('applyConfigSideEffects'),
      broadcastConfigChanged: () => settingsIpcCalls.push('broadcastConfigChanged'),
    } as unknown as IpcContext);
  });

  afterEach(() => {
    mock.timers.reset();
    (Module as ModuleWithLoad)._load = originalLoad;
    delete require.cache[require.resolve('./googleDrive')];
    const proto = GoogleDriveClient.prototype as unknown as Record<string, unknown>;
    for (const name of DRIVE_METHODS) proto[name] = originals[name];
    rmDir(dataPath);
  });

  function note(title: string): string {
    const audio = path.join(dataPath, 'recordings', `${title}_2026-01-01T00-00-00-000Z.webm`);
    fs.writeFileSync(audio, Buffer.from(`${title} bytes `.repeat(30)));
    saveTranscription({ title, result, audioFilePath: audio, dataPath });
    return path.basename(audio);
  }

  const status = async () => (await handlers.get('google-drive-sync-status')!({})) as Status;

  // Lets the async sync cycle (real file I/O, mocked timers) run to the end.
  async function settle(): Promise<void> {
    // Real-time deadline (Date is not mocked): under a loaded full test run a
    // cycle's file I/O can take many event-loop turns.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setImmediate(resolve));
      if (!(await status()).inFlight) return;
    }
    throw new Error('sync cycle did not settle');
  }

  it('the launch kick and the periodic tick transfer files with no window or Settings', async () => {
    const first = note('First');
    mod.refreshGoogleSyncTimer(); // what main.ts does at launch
    assert.equal(drive.uploads.length, 0, 'nothing runs before the initial delay');

    mock.timers.tick(5_000);
    await settle();
    assert.equal(drive.byName(first).length, 1, 'initial cycle uploaded the recording');
    const afterFirst = (await status()).lastSyncedAt;
    assert.ok(afterFirst, 'the completed cycle is recorded');

    const second = note('Second');
    mock.timers.tick(60_000);
    await settle();
    assert.equal(drive.byName(second).length, 1, 'the periodic tick uploaded the new note');
    assert.deepEqual(settingsIpcCalls, [], 'no Settings path was involved');
  });

  it('picks up sync enabled by another process without a Settings save', async () => {
    cachedEnabled = false;
    persistedEnabled = false;
    const audio = note('Later');
    mod.refreshGoogleSyncTimer();
    mock.timers.tick(5_000);
    mock.timers.tick(60_000);
    await settle();
    assert.equal(drive.uploads.length, 0, 'disabled: nothing transferred');

    persistedEnabled = true; // `listener config set googleDriveEnabled true`; cache still false
    mock.timers.tick(60_000);
    await settle();
    assert.equal(drive.byName(audio).length, 1, 'the next tick synced');
  });

  it('stops automatic transfers when sync is disabled elsewhere', async () => {
    mod.refreshGoogleSyncTimer();
    mock.timers.tick(5_000);
    await settle();
    const uploads = drive.uploads.length;
    persistedEnabled = false;
    note('AfterDisable');
    mock.timers.tick(60_000);
    await settle();
    assert.equal(drive.uploads.length, uploads);
  });

  it('Sync now during a running cycle joins it and reports the same result', async () => {
    note('Joined');
    let release!: () => void;
    listGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mod.refreshGoogleSyncTimer();
    mock.timers.tick(5_000);
    assert.equal((await status()).inFlight, true);

    const manual = handlers.get('google-drive-sync-now')!({}) as Promise<{
      success: boolean;
      result?: { uploaded: string[] };
    }>;
    listGate = null;
    release();
    const res = await manual;
    assert.equal(res.success, true);
    assert.ok(res.result!.uploaded.length > 0, 'the joined cycle result is returned');
    const uploads = drive.uploads.length;
    await settle();
    assert.equal(drive.uploads.length, uploads, 'no second cycle re-uploaded');
  });

  it('a save during a running cycle gets one more cycle instead of waiting a tick', async () => {
    note('Before');
    let release!: () => void;
    listGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mod.refreshGoogleSyncTimer();
    mock.timers.tick(5_000);
    const later = note('DuringCycle');
    mod.maybeAutoSync(); // post-transcription save trigger
    listGate = null;
    release();
    await settle();
    await settle();
    assert.equal(drive.byName(later).length, 1);
  });

  it('keeps the last failure for a reconnecting window until a cycle succeeds', async () => {
    note('Err');
    listError = new Error('Drive said no');
    mod.refreshGoogleSyncTimer();
    mock.timers.tick(5_000);
    await settle();
    let s = await status();
    assert.ok(s.lastError, 'the failure is kept for the next status read');

    const manual = (await handlers.get('google-drive-sync-now')!({})) as { success: boolean };
    assert.equal(manual.success, true);
    s = await status();
    assert.equal(s.lastError, null);
    assert.ok(s.lastSyncedAt);
  });

  it('reports the last completed cycle recorded on disk after a restart', async () => {
    fs.writeFileSync(
      path.join(dataPath, 'sync-state.json'),
      JSON.stringify({
        version: 1,
        meetings: {},
        tombstones: {},
        lastSyncedAt: '2026-11-13T12:50:35.372Z',
      }),
    );
    assert.equal((await status()).lastSyncedAt, '2026-11-13T12:50:35.372Z');
  });

  it('a CLI sign-in after launch is honored by status and Sync now', async () => {
    creds = undefined;
    cachedCreds = undefined;
    note('CliSignIn');
    assert.equal((await status()).authenticated, false);
    creds = { email: 'b@example.com', refresh: 'rb', access: 'y', expires: Date.now() + 1e9 };
    // This process still caches no sign-in.
    assert.equal((await status()).authenticated, true);
    const res = (await handlers.get('google-drive-sync-now')!({})) as { success: boolean };
    assert.equal(res.success, true);
  });

  it('a CLI sign-out after launch is honored by status and Sync now', async () => {
    creds = undefined; // cachedCreds still holds the old sign-in
    assert.equal((await status()).authenticated, false);
    const res = (await handlers.get('google-drive-sync-now')!({})) as {
      success: boolean;
      error?: string;
    };
    assert.equal(res.success, false);
    assert.equal(drive.uploads.length, 0);
  });

  it('Sync now after an account switch waits for its own cycle, never the old account result', async () => {
    sent = [];
    note('Switch');
    let release!: () => void;
    listGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mod.refreshGoogleSyncTimer();
    mock.timers.tick(5_000); // account A's cycle starts and waits on Drive
    await new Promise((resolve) => setImmediate(resolve));
    const cyclesBefore = sent.filter((e) => e.payload.phase === 'syncing').length;
    assert.equal(cyclesBefore, 1);

    creds = { email: 'b@example.com', refresh: 'rb', access: 'y', expires: Date.now() + 1e9 };
    const manual = handlers.get('google-drive-sync-now')!({}) as Promise<{ success: boolean }>;
    listGate = null;
    release();
    const res = await manual;
    assert.equal(res.success, true);
    assert.equal(
      sent.filter((e) => e.payload.phase === 'syncing').length,
      2,
      'a second cycle ran for account B',
    );
    const finished = sent.filter(
      (e) => e.payload.phase === 'success' || e.payload.phase === 'error',
    );
    assert.equal(finished.length, 1, "account A's outcome was not published as current status");
  });

  it('an old account cycle stops publishing progress once the sign-in changes', async () => {
    sent = [];
    note('ProgressA');
    let release!: () => void;
    listGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mod.refreshGoogleSyncTimer();
    mock.timers.tick(5_000);
    await new Promise((resolve) => setImmediate(resolve));
    creds = { email: 'b@example.com', refresh: 'rb', access: 'y', expires: Date.now() + 1e9 };
    const atSwitch = sent.length;
    listGate = null;
    release();
    await settle();
    assert.deepEqual(
      sent.slice(atSwitch).map((e) => [e.channel, e.payload.phase]),
      [['google-sync-status', 'idle']],
      'no progress or outcome from account A after the switch, only the end of "Syncing"',
    );
  });

  it('a request queued under a sign-in that changed again does not run under the newer one', async () => {
    sent = [];
    note('Queued');
    let release!: () => void;
    listGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mod.refreshGoogleSyncTimer();
    mock.timers.tick(5_000); // account A's cycle waits on Drive
    await new Promise((resolve) => setImmediate(resolve));

    creds = { email: 'b@example.com', refresh: 'rb', access: 'y', expires: Date.now() + 1e9 };
    const forB = handlers.get('google-drive-sync-now')!({}) as Promise<{ success: boolean }>;
    creds = { email: 'c@example.com', refresh: 'rc', access: 'z', expires: Date.now() + 1e9 };
    const forC = handlers.get('google-drive-sync-now')!({}) as Promise<{ success: boolean }>;
    listGate = null;
    release();
    assert.equal((await forB).success, false, 'B was replaced by C before it could run');
    assert.equal((await forC).success, true);
    assert.equal(
      sent.filter((e) => e.payload.phase === 'syncing').length,
      2,
      'only A and C cycles ran',
    );
  });

  it('periodic ticks during a long cycle start no extra cycle; a save still gets exactly one', async () => {
    sent = [];
    note('Long');
    let release!: () => void;
    listGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mod.refreshGoogleSyncTimer();
    mock.timers.tick(5_000);
    mock.timers.tick(60_000); // ticks while the cycle runs
    mock.timers.tick(60_000);
    listGate = null;
    release();
    await settle();
    const cycles = () => sent!.filter((e) => e.payload.phase === 'syncing').length;
    assert.equal(cycles(), 1, 'ticks during the cycle did not chain another');

    listGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mock.timers.tick(60_000); // next cycle starts and waits
    await new Promise((resolve) => setImmediate(resolve));
    note('SavedMeanwhile');
    mod.maybeAutoSync(); // a save during it
    mock.timers.tick(60_000);
    listGate = null;
    release();
    await settle();
    await settle();
    assert.equal(cycles(), 3, 'the save got exactly one more cycle');
  });

  it('does not show the previous account failure after a sign-in change elsewhere', async () => {
    note('ErrA');
    listError = new Error('A failed');
    mod.refreshGoogleSyncTimer();
    mock.timers.tick(5_000);
    await settle();
    assert.ok((await status()).lastError);
    creds = { email: 'b@example.com', refresh: 'rb', access: 'y', expires: Date.now() + 1e9 };
    assert.equal((await status()).lastError, null);
  });
});
