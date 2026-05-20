// Covers env credential parsing, the OAuth-client-not-configured error path,
// and AbortSignal cancellation of an in-flight loginGoogleOAuth call. The full
// loopback-and-token-exchange happy path is exercised in Phase 2's Drive
// integration tests, where mocking the Google token endpoint pays off.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  getGoogleOAuthEnvCredentials,
  hasGoogleOAuthClientConfigured,
  hasGoogleOAuthEnvCredentials,
  loginGoogleOAuth,
} from './googleOAuth';

const GOOGLE_ENV_KEYS = [
  'GOOGLE_OAUTH_ACCESS_TOKEN',
  'GOOGLE_OAUTH_REFRESH_TOKEN',
  'GOOGLE_OAUTH_EXPIRES',
  'LISTENER_GOOGLE_OAUTH_CLIENT_ID',
  'LISTENER_GOOGLE_OAUTH_CLIENT_SECRET',
];
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const k of GOOGLE_ENV_KEYS) {
    savedEnv.set(k, process.env[k]);
    delete process.env[k];
  }
});

afterEach(() => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  savedEnv.clear();
});

describe('googleOAuth env credentials', () => {
  it('returns undefined when env vars are not set', () => {
    assert.equal(getGoogleOAuthEnvCredentials(), undefined);
    assert.equal(hasGoogleOAuthEnvCredentials(), false);
  });

  it('parses env credentials when both tokens are set', () => {
    process.env.GOOGLE_OAUTH_ACCESS_TOKEN = 'env-access';
    process.env.GOOGLE_OAUTH_REFRESH_TOKEN = 'env-refresh';
    process.env.GOOGLE_OAUTH_EXPIRES = String(Date.now() + 30 * 60_000);

    const creds = getGoogleOAuthEnvCredentials();
    assert.ok(creds, 'expected env credentials');
    assert.equal(creds!.access, 'env-access');
    assert.equal(creds!.refresh, 'env-refresh');
    assert.equal(hasGoogleOAuthEnvCredentials(), true);
  });

  it('defaults expires when not set', () => {
    process.env.GOOGLE_OAUTH_ACCESS_TOKEN = 'env-access';
    process.env.GOOGLE_OAUTH_REFRESH_TOKEN = 'env-refresh';

    const creds = getGoogleOAuthEnvCredentials();
    assert.ok(creds);
    assert.ok(creds!.expires > Date.now(), 'expected default expires to be future');
  });

  it('returns undefined when only access token is set', () => {
    process.env.GOOGLE_OAUTH_ACCESS_TOKEN = 'env-access';
    assert.equal(getGoogleOAuthEnvCredentials(), undefined);
  });

  it('returns undefined when only refresh token is set', () => {
    process.env.GOOGLE_OAUTH_REFRESH_TOKEN = 'env-refresh';
    assert.equal(getGoogleOAuthEnvCredentials(), undefined);
  });
});

describe('googleOAuth client config gate', () => {
  it('reports unconfigured when env vars are missing', () => {
    assert.equal(hasGoogleOAuthClientConfigured(), false);
  });

  it('reports configured when both client env vars are set', () => {
    process.env.LISTENER_GOOGLE_OAUTH_CLIENT_ID = 'test-id';
    process.env.LISTENER_GOOGLE_OAUTH_CLIENT_SECRET = 'test-secret';
    assert.equal(hasGoogleOAuthClientConfigured(), true);
  });

  it('reports unconfigured when only client id is set', () => {
    process.env.LISTENER_GOOGLE_OAUTH_CLIENT_ID = 'test-id';
    assert.equal(hasGoogleOAuthClientConfigured(), false);
  });
});

describe('loginGoogleOAuth error paths', () => {
  it('throws with actionable message when client credentials are missing', async () => {
    await assert.rejects(
      () => loginGoogleOAuth({ openUrl: () => {} }),
      /Google OAuth client not configured/,
    );
  });

  it('rejects immediately when signal is already aborted', async () => {
    process.env.LISTENER_GOOGLE_OAUTH_CLIENT_ID = 'test-id';
    process.env.LISTENER_GOOGLE_OAUTH_CLIENT_SECRET = 'test-secret';

    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () =>
        loginGoogleOAuth({
          openUrl: () => {},
          signal: controller.signal,
        }),
      /cancelled/i,
    );
  });

  it('rejects when signal aborts after openUrl is called', async () => {
    process.env.LISTENER_GOOGLE_OAUTH_CLIENT_ID = 'test-id';
    process.env.LISTENER_GOOGLE_OAUTH_CLIENT_SECRET = 'test-secret';

    const controller = new AbortController();
    let openUrlCalled = false;
    const promise = loginGoogleOAuth({
      openUrl: () => {
        openUrlCalled = true;
        // Fire abort on the next tick so the race in loginGoogleOAuth has
        // already started waiting for either the callback or the abort.
        setImmediate(() => controller.abort());
      },
      signal: controller.signal,
    });

    await assert.rejects(promise, /cancelled/i);
    assert.equal(openUrlCalled, true, 'expected openUrl to have been invoked');
  });
});
