// Regression guards for the wrapper layer. The first one is load-bearing: the
// initial cut of PR #138 routed Gemini summary calls through `complete()`,
// which silently drops `options.reasoning` (pi-ai's `streamGoogle` only reads
// `options.thinking?.enabled/level`). The result was a feature that
// dropdown-saved/persisted but produced identical Gemini output across all
// thinking levels. This test fails if a refactor reintroduces that bug.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { DEFAULT_GEMINI_MODEL } from './aiProvider';
import { completeSimple, getModel, swapProviderForTest } from './piAiClient';
import { importEsm } from './esmImport';

type PiAiModule = typeof import('@earendil-works/pi-ai');
const loadPiAi = (): Promise<PiAiModule> => importEsm<PiAiModule>('@earendil-works/pi-ai');

let restoreProviders: (() => void) | undefined;

afterEach(() => {
  restoreProviders?.();
  restoreProviders = undefined;
});

// Replace a provider on piAiClient's shared Models with a faux one. Unlike the
// retired /compat registry, the faux provider owns the catalog too, so any id
// the test resolves through getModel() must be listed in `models`.
async function installFaux(options: {
  api: string;
  provider: string;
  models?: { id: string; reasoning?: boolean }[];
}) {
  const pi = await loadPiAi();
  const faux = pi.fauxProvider(options);
  restoreProviders = await swapProviderForTest(faux.provider);
  return { pi, faux };
}

describe('piAiClient.completeSimple', () => {
  it('forwards `reasoning` through to the provider', async () => {
    const { pi, faux } = await installFaux({
      api: 'google-generative-ai',
      provider: 'google',
      models: [{ id: 'gemini-3.5-flash', reasoning: true }],
    });

    let captured: Record<string, unknown> | undefined;
    faux.setResponses([
      (_ctx, options) => {
        captured = options as Record<string, unknown>;
        return pi.fauxAssistantMessage('ok');
      },
    ]);

    const model = await getModel('gemini', 'gemini-3.5-flash');
    await completeSimple(
      model,
      { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] },
      { apiKey: 'unused-for-faux', reasoning: 'high' },
    );

    assert.equal(
      captured?.reasoning,
      'high',
      'completeSimple must forward `reasoning` -- regular complete() would drop it',
    );
  });

  it('preserves arbitrary options on Gemini provider', async () => {
    // adjustOptionsForModel spreads everything for non-ChatGPT providers; this
    // guards against a future change accidentally narrowing the passthrough.
    const { pi, faux } = await installFaux({
      api: 'google-generative-ai',
      provider: 'google',
      models: [{ id: 'gemini-3.5-flash', reasoning: true }],
    });

    let captured: Record<string, unknown> | undefined;
    faux.setResponses([
      (_ctx, options) => {
        captured = options as Record<string, unknown>;
        return pi.fauxAssistantMessage('ok');
      },
    ]);

    const model = await getModel('gemini', 'gemini-3.5-flash');
    await completeSimple(
      model,
      { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] },
      { apiKey: 'unused-for-faux', reasoning: 'medium', temperature: 0.2, maxTokens: 1024 },
    );

    assert.equal(captured?.reasoning, 'medium');
    assert.equal(captured?.temperature, 0.2);
    assert.equal(captured?.maxTokens, 1024);
  });
});

describe('piAiClient.getModel', () => {
  it('returns the bundled gemini-3.5-flash model', async () => {
    const model = await getModel('gemini', 'gemini-3.5-flash');

    assert.equal(model.id, 'gemini-3.5-flash');
    assert.equal((model as { provider: string }).provider, 'google');
    assert.equal((model as { reasoning: boolean }).reasoning, true);
  });

  it('falls back to the provider default for unknown ids', async () => {
    // pi-ai bumps retire catalog entries (0.84 dropped several gpt-5.x ids).
    // A stale configured id must not brick every summary/agent call: getModel
    // degrades to the provider default -- a real registry entry, so the
    // token/scope plumbing stays intact -- and warns.
    const model = await getModel('gemini', 'gemini-vaporware-9.9');

    assert.equal(model.id, DEFAULT_GEMINI_MODEL);
    assert.equal((model as { provider: string }).provider, 'google');
  });

  it('refuses ChatGPT models: they are account-discovered, never substituted', async () => {
    // The ChatGPT option-stripping and wire contract live in
    // chatgptResponses.test.ts, against the real transport.
    await assert.rejects(getModel('chatgpt', 'gpt-anything'), /signed-in account/);
  });
});

// Live hints send meeting speech as the prompt; an upstream error message can
// quote that prompt back. With `privateText` the wrapper must log and throw
// only codes and counts, never the provider's error text.
describe('piAiClient private request text', () => {
  const ECHO = 'SECRET-MEETING-SPEECH the acquisition closes on Friday';

  async function captureLogs<T>(
    fn: () => Promise<T>,
  ): Promise<{ lines: string[]; error: unknown }> {
    const lines: string[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    const sink = (...args: unknown[]) => lines.push(args.map(String).join(' '));
    console.log = sink;
    console.warn = sink;
    console.error = sink;
    let error: unknown;
    try {
      await fn();
    } catch (e) {
      error = e;
    } finally {
      Object.assign(console, original);
    }
    return { lines, error };
  }

  it('redacts a Gemini error message that echoes the prompt', async () => {
    const { pi, faux } = await installFaux({
      api: 'google-generative-ai',
      provider: 'google',
      models: [{ id: 'gemini-3.5-flash' }],
    });
    faux.setResponses([
      pi.fauxAssistantMessage('', { stopReason: 'error', errorMessage: `400 bad input: ${ECHO}` }),
    ]);
    const model = await getModel('gemini', 'gemini-3.5-flash');
    const { lines, error } = await captureLogs(() =>
      completeSimple(
        model,
        { messages: [{ role: 'user', content: ECHO, timestamp: Date.now() }] },
        { apiKey: 'unused-for-faux' },
        { kind: 'live-hints', privateText: true },
      ),
    );
    assert.ok(error instanceof Error, 'the failure still throws');
    assert.ok(!error.message.includes('SECRET-MEETING-SPEECH'), error.message);
    assert.ok(lines.length > 0, 'the call is still logged');
    for (const line of lines) assert.ok(!line.includes('SECRET-MEETING-SPEECH'), line);
    assert.ok(
      lines.some((l) => /errorChars=\d+/.test(l)),
      'logs the error length instead',
    );
  });

  it('redacts a ChatGPT error message that echoes the prompt, keeping its code', async () => {
    const { pi, faux } = await installFaux({
      api: 'openai-responses',
      provider: 'chatgpt',
      models: [{ id: 'gpt-test' }],
    });
    faux.setResponses([
      pi.fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: `(429): subscription_sharing_usage_limit_exceeded ${ECHO}`,
      }),
    ]);
    const model = faux.getModel('gpt-test')!;
    const { lines, error } = await captureLogs(() =>
      completeSimple(
        model,
        { messages: [{ role: 'user', content: ECHO, timestamp: Date.now() }] },
        { apiKey: 'unused-for-faux' },
        { kind: 'live-hints', privateText: true },
      ),
    );
    assert.ok(error instanceof Error);
    assert.equal((error as { code?: string }).code, 'usage_limit_exceeded');
    assert.ok(!error.message.includes('SECRET-MEETING-SPEECH'), error.message);
    for (const line of lines) assert.ok(!line.includes('SECRET-MEETING-SPEECH'), line);
  });

  it('keeps the provider error text for other tasks', async () => {
    const { pi, faux } = await installFaux({
      api: 'google-generative-ai',
      provider: 'google',
      models: [{ id: 'gemini-3.5-flash' }],
    });
    faux.setResponses([
      pi.fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'quota exhausted' }),
    ]);
    const model = await getModel('gemini', 'gemini-3.5-flash');
    const { error } = await captureLogs(() =>
      completeSimple(
        model,
        { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] },
        { apiKey: 'unused-for-faux' },
        { kind: 'summary' },
      ),
    );
    assert.match((error as Error).message, /quota exhausted/);
  });
});
