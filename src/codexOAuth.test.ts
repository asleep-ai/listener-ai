import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveCodexAccessToken, runCodexOAuthPrompt } from './codexOAuth';

describe('resolveCodexAccessToken', () => {
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
});
