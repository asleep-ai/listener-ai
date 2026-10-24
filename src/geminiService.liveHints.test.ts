// GeminiService.generateLiveHints against pi-ai's faux provider: one
// completed text call on the configured route, no tools, strict parsing.
// No network and no real credentials.

import assert from 'node:assert/strict';
import { after, afterEach, describe, it } from 'node:test';
import { importEsm } from './esmImport';
import { ChatGPTBinding, type ChatGPTAuthLike } from './chatgptBinding';
import { GeminiService } from './geminiService';
import { LiveHintOutputError, type LiveHintGenerateRequest } from './liveHintEngine';
import { swapProviderForTest } from './piAiClient';
import { makeTempDir, rmDir } from './test-helpers';

type PiAiModule = typeof import('@earendil-works/pi-ai');
const loadPiAi = (): Promise<PiAiModule> => importEsm<PiAiModule>('@earendil-works/pi-ai');

let restore: (() => void) | undefined;
const dataPath = makeTempDir('live-hints-gemini');
afterEach(() => {
  restore?.();
  restore = undefined;
});
after(() => rmDir(dataPath));

async function fauxGoogle() {
  const pi = await loadPiAi();
  const faux = pi.fauxProvider({
    api: 'google-generative-ai',
    provider: 'google',
    models: [{ id: 'gemini-2.5-flash' }],
  });
  restore = await swapProviderForTest(faux.provider);
  return { pi, faux };
}

function service(): GeminiService {
  return new GeminiService({
    provider: 'gemini',
    apiKey: 'unused-for-faux',
    dataPath,
    proModel: 'gemini-2.5-flash',
    flashModel: 'gemini-2.5-flash',
  });
}

const request: LiveHintGenerateRequest = {
  intent: 'auto',
  items: [
    {
      key: 'S1',
      ref: 'live_1_1',
      state: 'final',
      text: 'Our RPO is fifteen minutes for orders.',
      offsetMs: 0,
      isNew: true,
    },
  ],
  recentHints: [],
};

describe('GeminiService.generateLiveHints', () => {
  it('returns title, topic, update and the held-cue keep list from the same call', async () => {
    const { pi, faux } = await fauxGoogle();
    let system = '';
    faux.setResponses([
      (context) => {
        system = context.systemPrompt ?? '';
        return pi.fauxAssistantMessage(
          '{"hints":[{"kind":"term","title":"RPO","text":"RPO: 15 minutes for orders","topic":"Recovery","update":"C1","sourceRefs":["S1"],"basis":["transcript"]}],"keep":[]}',
        );
      },
    ]);
    const cues = await service().generateLiveHints({
      ...request,
      recentCues: [{ key: 'C1', hintId: 'live_x_hint_1', kind: 'term', text: 'RPO' }],
      heldCues: [{ key: 'R1', kind: 'question', text: 'Ask: is it fifteen?' }],
    });
    assert.deepEqual(cues.keep, []);
    assert.equal(cues[0].title, 'RPO');
    assert.equal(cues[0].topic, 'Recovery');
    assert.equal(cues[0].update, 'live_x_hint_1');
    assert.match(system, /"keep"/);
  });

  it('makes one tool-free text call on the configured model and returns validated cues', async () => {
    const { pi, faux } = await fauxGoogle();
    let seen: { tools?: unknown; system?: string; model?: string } = {};
    faux.setResponses([
      (context, _options, _state, model) => {
        seen = { tools: context.tools, system: context.systemPrompt, model: model.id };
        return pi.fauxAssistantMessage(
          '{"hints":[{"kind":"term","text":"RPO: recovery point objective","sourceRefs":["S1"],"basis":["transcript","model-knowledge"]}]}',
        );
      },
    ]);
    const cues = await service().generateLiveHints(request);
    assert.deepEqual(cues, [
      {
        kind: 'term',
        text: 'RPO: recovery point objective',
        detail: undefined,
        refs: ['live_1_1'],
        basis: ['transcript', 'model-knowledge'],
      },
    ]);
    assert.equal(faux.state.callCount, 1);
    assert.equal(seen.model, 'gemini-2.5-flash');
    assert.ok(!seen.tools || (Array.isArray(seen.tools) && seen.tools.length === 0), 'no tools');
    assert.match(seen.system ?? '', /untrusted data/);
  });

  it('rejects an incomplete (length-truncated) response instead of using partial text', async () => {
    const { pi, faux } = await fauxGoogle();
    faux.setResponses([
      pi.fauxAssistantMessage('{"hints":[{"kind":"term"', { stopReason: 'length' }),
    ]);
    await assert.rejects(() => service().generateLiveHints(request), LiveHintOutputError);
  });

  it('rejects malformed output and source references that were not sent', async () => {
    const { pi, faux } = await fauxGoogle();
    faux.setResponses([
      pi.fauxAssistantMessage('Here are some hints: RPO means...'),
      pi.fauxAssistantMessage(
        '{"hints":[{"kind":"term","text":"x","sourceRefs":["S7"],"basis":["transcript"]}]}',
      ),
    ]);
    await assert.rejects(() => service().generateLiveHints(request), /not JSON/);
    await assert.rejects(() => service().generateLiveHints(request), /unknown excerpt/);
  });

  it('honours an already-aborted signal without calling the provider', async () => {
    const { faux } = await fauxGoogle();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => service().generateLiveHints(request, { signal: controller.signal }));
    assert.equal(faux.state.callCount, 0);
  });

  it('uses Luna for hints and preserves the configured model and account for other tasks', async () => {
    const pi = await loadPiAi();
    const faux = pi.fauxProvider({
      api: 'openai-responses',
      provider: 'chatgpt',
      models: [{ id: 'gpt-6-luna' }, { id: 'gpt-account-model' }],
    });
    restore = await swapProviderForTest(faux.provider);
    const seen: { model: string; key: string | undefined }[] = [];
    faux.setResponses(
      ['{"hints":[]}', 'translated'].map(
        (text) =>
          (
            _context: unknown,
            options: { apiKey?: string } | undefined,
            _state: unknown,
            model: { id: string },
          ) => {
            seen.push({ model: model.id, key: options?.apiKey });
            return Object.assign(pi.fauxAssistantMessage(text), { rawStopReason: 'completed' });
          },
      ),
    );
    let opened = 0;
    const auth: ChatGPTAuthLike = {
      getStatus: async () => ({ connected: true, planEnabled: true, profileId: 'pinned-profile' }),
      openSession: async (profileId) => {
        opened++;
        assert.equal(profileId, 'pinned-profile');
        return {
          profileId,
          getAccessToken: async () => 'siwc-access-token',
          listModels: async () => [
            { slug: 'gpt-account-model', display_name: 'Configured model' },
            { slug: 'gpt-6-luna', display_name: 'Luna' },
          ],
          isActive: () => true,
          endRejectedSession: async () => false,
        };
      },
    };
    const chatgpt = new GeminiService({
      provider: 'chatgpt',
      chatgptBinding: new ChatGPTBinding({ model: 'gpt-account-model', auth }),
      dataPath,
      proModel: 'gemini-should-not-be-used',
      flashModel: 'gemini-should-not-be-used',
    });
    assert.deepEqual(await chatgpt.generateLiveHints(request), []);
    assert.equal(await chatgpt.translateText('source'), 'translated');
    assert.deepEqual(seen, [
      { model: 'gpt-6-luna', key: 'siwc-access-token' },
      { model: 'gpt-account-model', key: 'siwc-access-token' },
    ]);
    assert.equal(opened, 1, 'both routes use the same bound sign-in');
  });

  it('refuses unavailable Luna without substituting the configured model', async () => {
    const { faux } = await fauxGoogle();
    const auth: ChatGPTAuthLike = {
      getStatus: async () => ({ connected: true, planEnabled: true, profileId: 'p1' }),
      openSession: async () => ({
        profileId: 'p1',
        getAccessToken: async () => 'unused',
        listModels: async () => [{ slug: 'gpt-account-model', display_name: 'Configured model' }],
        isActive: () => true,
        endRejectedSession: async () => false,
      }),
    };
    const chatgpt = new GeminiService({
      provider: 'chatgpt',
      chatgptBinding: new ChatGPTBinding({ model: 'gpt-account-model', auth }),
      dataPath,
      proModel: 'unused',
      flashModel: 'unused',
    });
    await assert.rejects(chatgpt.generateLiveHints(request), /gpt-6-luna.*not available/);
    assert.equal(faux.state.callCount, 0);
  });

  it('never logs or rethrows provider error text that echoes the source speech', async () => {
    const { pi, faux } = await fauxGoogle();
    const echo = 'Our RPO is fifteen minutes for orders.';
    faux.setResponses([
      pi.fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: `400 invalid request near "${echo}"`,
      }),
    ]);
    const lines: string[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    const sink = (...args: unknown[]) => lines.push(args.map(String).join(' '));
    Object.assign(console, { log: sink, warn: sink, error: sink });
    let error: unknown;
    try {
      await service().generateLiveHints(request);
    } catch (e) {
      error = e;
    } finally {
      Object.assign(console, original);
    }
    assert.ok(error instanceof Error, 'the failure still surfaces');
    assert.ok(!error.message.includes('fifteen minutes'), error.message);
    for (const line of lines) assert.ok(!line.includes('fifteen minutes'), line);
  });

  it('refuses on a transcription-only service (no text route, no fallback)', async () => {
    const transcriptionOnly = new GeminiService({
      provider: 'chatgpt',
      transcriptionOnly: true,
      transcriptionProvider: 'openai',
      openaiApiKey: 'unused',
      dataPath,
      proModel: 'unused',
      flashModel: 'unused',
    });
    await assert.rejects(() => transcriptionOnly.generateLiveHints(request), /transcription only/);
  });
});
