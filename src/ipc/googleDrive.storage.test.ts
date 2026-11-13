// Handler-level wiring of the automatic local audio policy: the real
// `google-drive-sync-now` handler syncs, then applies `audioOffloadAfterDays`
// with the session it started under. Electron is stubbed; GoogleDriveClient's
// methods delegate to an in-memory Drive so nothing touches the network.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import Module from 'node:module';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { TranscriptionResult } from '../geminiService';
import { saveTranscription } from '../outputService';
import { FakeDrive } from '../services/fakeDriveForTests';
import { GoogleDriveClient } from '../services/googleDriveService';
import { makeTempDir, rmDir } from '../test-helpers';
import type { IpcContext } from './types';

type ModuleWithLoad = typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

const DAY = 24 * 60 * 60 * 1000;
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

describe('automatic local audio removal after sync (IPC wiring)', () => {
  let originalLoad: ModuleWithLoad['_load'];
  let originals: Record<string, unknown>;
  let handlers: Map<string, (...args: unknown[]) => unknown>;
  let dataPath: string;
  let drive: FakeDrive;
  let days: number;
  let enabled: boolean;
  let creds: { email: string; refresh: string; access: string; expires: number } | undefined;
  // What config.json says now when it differs from this process's cache.
  let persistedOverride: typeof creds | null | undefined;

  beforeEach(() => {
    dataPath = makeTempDir('ipc-storage');
    fs.mkdirSync(path.join(dataPath, 'recordings'), { recursive: true });
    drive = new FakeDrive();
    days = 0;
    enabled = true;
    persistedOverride = undefined;
    creds = { email: 'a@example.com', refresh: 'ra', access: 'x', expires: Date.now() + 1e9 };
    handlers = new Map();

    originals = {};
    const proto = GoogleDriveClient.prototype as unknown as Record<string, unknown>;
    for (const name of DRIVE_METHODS) {
      originals[name] = proto[name];
      proto[name] = (...args: unknown[]) =>
        (drive as unknown as Record<string, (...a: unknown[]) => unknown>)[name](...args);
    }

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
    const mod = require('./googleDrive') as { register: (ctx: IpcContext) => void };
    const configService = {
      getGoogleOAuth: () => creds,
      readPersistedGoogleOAuth: () => (persistedOverride === undefined ? creds : persistedOverride),
      readPersistedStoredGoogleOAuth: () =>
        persistedOverride === undefined ? creds : persistedOverride,
      hasGoogleOAuth: () => !!creds,
      hasStoredGoogleOAuth: () => false,
      getGoogleDriveEnabled: () => enabled,
      getAudioOffloadAfterDays: () => days,
      getKnownWords: () => [],
      setKnownWords: () => {},
    };
    mod.register({
      getMainWindow: () => null,
      configService: configService as unknown as IpcContext['configService'],
      isAudioInUse: () => false,
    } as unknown as IpcContext);
  });

  afterEach(() => {
    (Module as ModuleWithLoad)._load = originalLoad;
    delete require.cache[require.resolve('./googleDrive')];
    const proto = GoogleDriveClient.prototype as unknown as Record<string, unknown>;
    for (const name of DRIVE_METHODS) proto[name] = originals[name];
    rmDir(dataPath);
  });

  function oldRecording(name: string, ageDays: number): string {
    const p = path.join(dataPath, 'recordings', name);
    fs.writeFileSync(p, Buffer.from(`${name} bytes `.repeat(30)));
    const t = new Date(Date.now() - ageDays * DAY);
    fs.utimesSync(p, t, t);
    saveTranscription({ title: name, result, audioFilePath: p, dataPath });
    return p;
  }

  const syncNow = async () =>
    (await handlers.get('google-drive-sync-now')!({})) as { success: boolean; error?: string };

  it('default Never keeps every recording after sync', async () => {
    const audio = oldRecording('Old_2026-01-01T00-00-00-000Z.webm', 400);
    assert.equal((await syncNow()).success, true);
    assert.equal(drive.byName(path.basename(audio)).length, 1, 'uploaded');
    assert.ok(fs.existsSync(audio));
  });

  it('a saved policy removes old backed-up audio after sync, and the next sync keeps the copy', async () => {
    days = 30;
    const old = oldRecording('Old_2026-01-01T00-00-00-000Z.webm', 40);
    const recent = oldRecording('Recent_2026-01-02T00-00-00-000Z.webm', 1);
    assert.equal((await syncNow()).success, true);
    assert.equal(fs.existsSync(old), false);
    assert.ok(fs.existsSync(recent));

    const uploads = drive.uploads.length;
    assert.equal((await syncNow()).success, true);
    assert.equal(drive.uploads.length, uploads);
    assert.deepEqual(drive.trashCalls, []);
    assert.equal(drive.byName(path.basename(old)).length, 1);
  });

  it('the policy is not applied when sync is turned off', async () => {
    days = 30;
    enabled = false;
    const audio = oldRecording('Old_2026-01-01T00-00-00-000Z.webm', 40);
    assert.equal((await syncNow()).success, true);
    assert.ok(fs.existsSync(audio));
  });

  it('an account switch during the sync stops automatic removal', async () => {
    days = 30;
    const audio = oldRecording('Old_2026-01-01T00-00-00-000Z.webm', 40);
    drive.uploadHook = () => {
      creds = { email: 'b@example.com', refresh: 'rb', access: 'y', expires: Date.now() + 1e9 };
    };
    await syncNow();
    assert.ok(fs.existsSync(audio));
  });

  it('a sign-out during the sync stops automatic removal', async () => {
    days = 30;
    const audio = oldRecording('Old_2026-01-01T00-00-00-000Z.webm', 40);
    drive.uploadHook = () => {
      creds = undefined;
    };
    await syncNow();
    assert.ok(fs.existsSync(audio));
  });

  it('turning the setting off during the sync stops automatic removal', async () => {
    days = 30;
    const audio = oldRecording('Old_2026-01-01T00-00-00-000Z.webm', 40);
    drive.uploadHook = () => {
      days = 0;
    };
    await syncNow();
    assert.ok(fs.existsSync(audio));
  });

  it('manual free removes verified audio and restore downloads it back', async () => {
    const audio = oldRecording('Manual_2026-01-01T00-00-00-000Z.webm', 1);
    const bytes = fs.readFileSync(audio);
    await syncNow();
    const freed = (await handlers.get('local-audio-free')!({}, { paths: [audio] })) as {
      success: boolean;
      result: { removed: unknown[] };
    };
    assert.equal(freed.success, true);
    assert.equal(freed.result.removed.length, 1);
    assert.equal(fs.existsSync(audio), false);
    const restored = (await handlers.get('local-audio-restore')!({}, { audioPath: audio })) as {
      success: boolean;
      path: string;
    };
    assert.equal(restored.success, true);
    assert.equal(restored.path, audio);
    assert.deepEqual(fs.readFileSync(audio), bytes);
  });

  it('manual free rejects paths outside recordings/', async () => {
    const res = (await handlers.get('local-audio-free')!({}, { paths: ['/etc/hosts'] })) as {
      success: boolean;
    };
    assert.equal(res.success, false);
  });

  it('a sign-out in another process before the sync starts stops all Drive work', async () => {
    days = 30;
    const audio = oldRecording('Old_2026-01-01T00-00-00-000Z.webm', 40);
    persistedOverride = null; // the CLI signed out; this process still caches A
    const res = await syncNow();
    assert.equal(res.success, false);
    assert.equal(drive.uploads.length, 0);
    assert.ok(fs.existsSync(audio));
    const freed = (await handlers.get('local-audio-free')!({}, { paths: [audio] })) as {
      success: boolean;
    };
    assert.equal(freed.success, false);
    assert.ok(fs.existsSync(audio));
  });
});
