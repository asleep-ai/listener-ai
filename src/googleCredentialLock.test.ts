// Cross-process serialization of Google sign-in writes: a refreshed-token
// write-back and a sign-out/switch made by another process never interleave,
// so a slow refresh cannot resurrect a signed-out (or replaced) account.
// Each case runs a real second process holding the shared lock.

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { ConfigService } from './configService';
import { GoogleSessionTracker } from './services/googleSession';
import { makeTempDir, rmDir } from './test-helpers';

const A = { email: 'a@x', refresh: 'ra', access: 'access-a', expires: Date.now() + 1e9 };
const A2 = { ...A, access: 'access-a-refreshed' };
const B = { email: 'b@x', refresh: 'rb', access: 'access-b', expires: Date.now() + 1e9 };

const sessionModule = path.join(__dirname, 'services', 'googleSession.js');
const configModule = path.join(__dirname, 'configService.js');

// Child: takes the credential lock, reports "locked", waits for a line on
// stdin, runs `body` inside the lock, then releases and exits.
function holdLock(dataPath: string, body: string): Promise<ChildProcess> {
  const script = `
    const { withGoogleCredentialLock } = require(${JSON.stringify(sessionModule)});
    const { ConfigService } = require(${JSON.stringify(configModule)});
    const dataPath = process.argv[1];
    withGoogleCredentialLock(dataPath, () => new Promise((resolve) => {
      process.stdout.write('locked\\n');
      process.stdin.once('data', () => { ${body}; resolve(); });
    })).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
  `;
  const child = spawn(process.execPath, ['-e', script, dataPath], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, NODE_ENV: 'test' },
  });
  return new Promise((resolve) => child.stdout!.once('data', () => resolve(child)));
}

async function release(child: ChildProcess): Promise<void> {
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.stdin!.write('go\n');
  await exited;
}

function track<T>(promise: Promise<T>) {
  const state = { settled: false };
  promise.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );
  return state;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Google credential lock across processes', () => {
  it("a refresh waiting behind another process's sign-out is not written back", async () => {
    const dataPath = makeTempDir('cred-lock-signout');
    try {
      const app = new ConfigService(dataPath);
      app.setGoogleOAuth(A);
      const child = await holdLock(dataPath, `new ConfigService(dataPath).clearGoogleOAuth()`);
      const pending = app.persistRefreshedGoogleOAuth('a@x', A2);
      const state = track(pending);
      await pause(400);
      assert.equal(state.settled, false, 'the refresh waits for the lock');
      await release(child);
      assert.equal(await pending, false);
      assert.equal(new ConfigService(dataPath).hasStoredGoogleOAuth(), false, 'still signed out');
    } finally {
      rmDir(dataPath);
    }
  });

  it('a refresh through the session tracker does not overwrite a switch to another account', async () => {
    const dataPath = makeTempDir('cred-lock-switch');
    try {
      const app = new ConfigService(dataPath);
      app.setGoogleOAuth(A);
      const { withGoogleCredentialLock } = await import('./services/googleSession');
      const tracker = new GoogleSessionTracker(
        () => app.readPersistedGoogleOAuth(),
        () => app.readPersistedStoredGoogleOAuth(),
        (action) => withGoogleCredentialLock(dataPath, action),
      );
      const session = tracker.snapshot()!.session;
      const child = await holdLock(
        dataPath,
        `new ConfigService(dataPath).setGoogleOAuth(${JSON.stringify(B)})`,
      );
      const pending = tracker.persistRefreshed(session, A2, (v) => app.setGoogleOAuth(v));
      await pause(300);
      await release(child);
      assert.equal(await pending, false);
      assert.equal(new ConfigService(dataPath).readPersistedStoredGoogleOAuth()?.email, 'b@x');
    } finally {
      rmDir(dataPath);
    }
  });

  it('a sign-out waits for an in-flight refresh write and wins', async () => {
    const dataPath = makeTempDir('cred-lock-order');
    try {
      const app = new ConfigService(dataPath);
      app.setGoogleOAuth(A);
      // Another process is mid-refresh: it holds the lock and writes A2.
      const child = await holdLock(
        dataPath,
        `new ConfigService(dataPath).setGoogleOAuth(${JSON.stringify(A2)})`,
      );
      const signOut = app.signOutGoogleOAuth();
      const state = track(signOut);
      await pause(400);
      assert.equal(state.settled, false, 'sign-out waits for the refresh to finish');
      await release(child);
      await signOut;
      assert.equal(new ConfigService(dataPath).hasStoredGoogleOAuth(), false);
    } finally {
      rmDir(dataPath);
    }
  });

  it('refreshed tokens are written for the same stored account and never for env-only sign-ins', async () => {
    const dataPath = makeTempDir('cred-lock-same');
    try {
      const app = new ConfigService(dataPath);
      assert.equal(await app.persistRefreshedGoogleOAuth('a@x', A2), false, 'nothing stored');
      assert.equal(new ConfigService(dataPath).hasStoredGoogleOAuth(), false);
      await app.signInGoogleOAuth(A);
      assert.equal(await app.persistRefreshedGoogleOAuth('a@x', A2), true);
      assert.equal(
        new ConfigService(dataPath).readPersistedStoredGoogleOAuth()?.access,
        'access-a-refreshed',
      );
    } finally {
      rmDir(dataPath);
    }
  });
});
