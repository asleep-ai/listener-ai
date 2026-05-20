// Regression guards for the wrapper layer. The first one is load-bearing: the
// initial cut of PR #138 routed Gemini summary calls through `complete()`,
// which silently drops `options.reasoning` (pi-ai's `streamGoogle` only reads
// `options.thinking?.enabled/level`). The result was a feature that
// dropdown-saved/persisted but produced identical Gemini output across all
// thinking levels. This test fails if a refactor reintroduces that bug.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { complete, completeSimple, getModel } from './piAiClient';
import { importEsm } from './esmImport';

type PiAiModule = typeof import('@earendil-works/pi-ai');
const loadPiAi = (): Promise<PiAiModule> => importEsm<PiAiModule>('@earendil-works/pi-ai');

let registration: import('@earendil-works/pi-ai').FauxProviderRegistration | undefined;

afterEach(() => {
  registration?.unregister();
  registration = undefined;
});

describe('piAiClient.completeSimple', () => {
  it('forwards `reasoning` through to the provider', async () => {
    const pi = await loadPiAi();
    registration = pi.registerFauxProvider({ api: 'google-generative-ai', provider: 'google' });

    let captured: Record<string, unknown> | undefined;
    registration.setResponses([
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
    // adjustOptionsForModel spreads everything for non-Codex providers; this
    // guards against a future change accidentally narrowing the passthrough.
    const pi = await loadPiAi();
    registration = pi.registerFauxProvider({ api: 'google-generative-ai', provider: 'google' });

    let captured: Record<string, unknown> | undefined;
    registration.setResponses([
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

describe('piAiClient.complete', () => {
  it('strips temperature on Codex but forwards other options', async () => {
    // pi-ai's openai-codex-responses provider rejects sampling params; the
    // wrapper has to drop them. This pins that contract.
    const pi = await loadPiAi();
    registration = pi.registerFauxProvider({
      api: 'openai-codex-responses',
      provider: 'openai-codex',
    });

    let captured: Record<string, unknown> | undefined;
    registration.setResponses([
      (_ctx, options) => {
        captured = options as Record<string, unknown>;
        return pi.fauxAssistantMessage('ok');
      },
    ]);

    const model = registration.getModel();
    await complete(
      model,
      { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] },
      { apiKey: 'unused-for-faux', temperature: 0.5, reasoningEffort: 'xhigh' },
    );

    assert.equal(captured?.temperature, undefined, 'temperature must be stripped for Codex');
    assert.equal(captured?.reasoningEffort, 'xhigh');
  });
});

describe('piAiClient.getModel CUSTOM_GOOGLE_MODELS fallback', () => {
  it('returns a synthesized entry for gemini-3.5-flash when pi-ai registry lacks it', async () => {
    // pi-ai 0.74.0's registry doesn't have gemini-3.5-flash. We override via
    // CUSTOM_GOOGLE_MODELS so the user-configured default keeps working. When
    // pi-ai catches up, the registered entry wins and this test continues to
    // pass (override happens to match upstream's shape).
    const model = await getModel('gemini', 'gemini-3.5-flash');

    assert.equal(model.id, 'gemini-3.5-flash');
    assert.equal((model as { provider: string }).provider, 'google');
    assert.equal((model as { reasoning: boolean }).reasoning, true);
  });

  it('throws for unknown ids on the codex provider', async () => {
    // No fallback for Codex -- token/scope plumbing requires a real registry
    // entry, so unknown ids should surface loudly instead of silently failing
    // at the network layer.
    await assert.rejects(() => getModel('codex', 'gpt-vaporware-9.9'), /Unknown pi-ai model/);
  });
});
