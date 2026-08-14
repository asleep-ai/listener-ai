import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  type CodexOAuthCredentials,
  resetCodexRuntime,
  resolveCodexAccessToken,
  runCodexOAuthPrompt,
} from './codexOAuth';

describe('resolveCodexAccessToken', () => {
  // The credential store is shared per process; isolate each test from
  // whatever a previous test seeded.
  beforeEach(() => {
    resetCodexRuntime();
  });

  it('derives a bearer token through the pi-ai provider auth contract', async () => {
    let changed = false;
    const token = await resolveCodexAccessToken({
      credentials: {
        access: 'fresh-access-token',
        refresh: 'refresh-token',
        expires: Date.now() + 60 * 60_000,
      },
      onCredentialsChanged: () => {
        changed = true;
      },
    });

    assert.equal(token, 'fresh-access-token');
    assert.equal(changed, false);
  });

  it('trusts the shared store over stale caller credentials', async () => {
    await resolveCodexAccessToken({
      credentials: {
        access: 'fresh-access-token',
        refresh: 'fresh-refresh',
        expires: Date.now() + 60 * 60_000,
      },
    });

    // A second caller still holding a pre-rotation copy must receive the
    // store's fresher credentials via the change callback -- not overwrite
    // the store and resurrect an already-rotated refresh token.
    let broadcast: CodexOAuthCredentials | undefined;
    const token = await resolveCodexAccessToken({
      credentials: {
        access: 'stale-access-token',
        refresh: 'stale-refresh',
        expires: Date.now() + 60_000,
      },
      onCredentialsChanged: (next) => {
        broadcast = next;
      },
    });

    assert.equal(token, 'fresh-access-token');
    assert.equal(broadcast?.access, 'fresh-access-token');
    assert.equal(broadcast?.refresh, 'fresh-refresh');
  });
});

describe('runCodexOAuthPrompt', () => {
  it('keeps the Electron browser flow pending until pi-ai resolves the loopback race', async () => {
    const controller = new AbortController();
    let settled = false;
    const prompt = runCodexOAuthPrompt(undefined, {
      type: 'manual_code',
      message: 'Complete login in the browser.',
      signal: controller.signal,
    }).finally(() => {
      settled = true;
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);

    controller.abort();
    await assert.rejects(prompt, /cancelled/i);
  });

  it('forwards manual authorization input for the CLI flow', async () => {
    const result = await runCodexOAuthPrompt(
      async ({ message }) => {
        assert.match(message, /browser/i);
        return 'manual-code';
      },
      { type: 'manual_code', message: 'Complete login in your browser.' },
    );

    assert.equal(result, 'manual-code');
  });

  it('forwards an abort signal so interactive prompts can tear themselves down', async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const prompt = runCodexOAuthPrompt(
      async ({ signal }) => {
        received = signal;
        // Model a readline question: pending until answered or torn down.
        return await new Promise<string>(() => {});
      },
      {
        type: 'manual_code',
        message: 'Complete login in your browser.',
        signal: controller.signal,
      },
    );

    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(received, 'onPrompt received the combined abort signal');
    assert.equal(received?.aborted, false);

    controller.abort();
    await assert.rejects(prompt, /cancelled/i);
    assert.equal(received?.aborted, true, 'the prompt can observe the abort and close stdin');
  });
});
