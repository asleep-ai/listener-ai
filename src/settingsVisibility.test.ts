import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AI_PROVIDERS,
  LIVE_STT_PROVIDERS,
  TRANSCRIPTION_PROVIDERS,
  resolveBatchSttProvider,
} from './aiProvider';
import {
  type ProviderChoices,
  credentialUsage,
  describeCredentialUse,
  visibleProviderSections,
} from './settingsVisibility';

const allChoices: ProviderChoices[] = AI_PROVIDERS.flatMap((aiProvider) =>
  TRANSCRIPTION_PROVIDERS.flatMap((transcriptionProvider) =>
    LIVE_STT_PROVIDERS.map((liveSttProvider) => ({
      aiProvider,
      transcriptionProvider,
      liveSttProvider,
    })),
  ),
);

const batchOf = (choices: ProviderChoices) =>
  resolveBatchSttProvider(choices.transcriptionProvider, choices.aiProvider).provider;

describe('credentialUsage', () => {
  it('always lists the summary provider and the resolved transcription backend', () => {
    for (const choices of allChoices) {
      const usage = credentialUsage(choices);
      const batch = batchOf(choices);
      assert.ok(usage[choices.aiProvider].includes('summaries'), JSON.stringify(choices));
      if (batch) {
        assert.ok(usage[batch].includes('transcription'), JSON.stringify(choices));
      } else {
        // Auto under ChatGPT transcribes nothing, so no credential claims it.
        for (const uses of Object.values(usage)) {
          assert.ok(!uses.includes('transcription'), JSON.stringify(choices));
        }
      }
    }
  });

  it('keeps the Gemini key reachable whenever any feature can use Gemini', () => {
    for (const choices of allChoices) {
      const usesGemini =
        choices.aiProvider === 'gemini' ||
        batchOf(choices) === 'gemini' ||
        choices.liveSttProvider !== 'chunked';
      assert.equal(visibleProviderSections(choices).gemini, usesGemini, JSON.stringify(choices));
    }
  });

  it('keeps ChatGPT sign-in reachable exactly when summaries use it', () => {
    for (const choices of allChoices) {
      assert.equal(
        visibleProviderSections(choices).chatgpt,
        choices.aiProvider === 'chatgpt',
        JSON.stringify(choices),
      );
    }
  });

  it('never routes audio through the ChatGPT sign-in', () => {
    for (const choices of allChoices) {
      assert.deepEqual(
        credentialUsage(choices).chatgpt,
        choices.aiProvider === 'chatgpt' ? ['summaries'] : [],
        JSON.stringify(choices),
      );
    }
  });

  it('shows Gemini when ChatGPT runs summaries but Gemini transcribes', () => {
    const choices: ProviderChoices = {
      aiProvider: 'chatgpt',
      transcriptionProvider: 'gemini',
      liveSttProvider: 'chunked',
    };
    assert.deepEqual(visibleProviderSections(choices), { gemini: true, chatgpt: true });
    assert.deepEqual(credentialUsage(choices).gemini, ['transcription', 'live captions']);
  });

  it('lists the OpenAI API key when it transcribes under ChatGPT summaries', () => {
    const choices: ProviderChoices = {
      aiProvider: 'chatgpt',
      transcriptionProvider: 'openai',
      liveSttProvider: 'chunked',
    };
    assert.deepEqual(visibleProviderSections(choices), { gemini: false, chatgpt: true });
    assert.deepEqual(credentialUsage(choices).openai, ['transcription', 'live captions']);
  });

  it('shows Gemini for Gemini Live under ChatGPT summaries', () => {
    const choices: ProviderChoices = {
      aiProvider: 'chatgpt',
      transcriptionProvider: 'auto',
      liveSttProvider: 'gemini',
    };
    assert.deepEqual(credentialUsage(choices).gemini, ['live captions']);
  });

  it('hides the unused section when every feature uses one provider', () => {
    assert.deepEqual(
      visibleProviderSections({
        aiProvider: 'chatgpt',
        transcriptionProvider: 'auto',
        liveSttProvider: 'chunked',
      }),
      { gemini: false, chatgpt: true },
    );
    assert.deepEqual(
      visibleProviderSections({
        aiProvider: 'gemini',
        transcriptionProvider: 'soniox',
        liveSttProvider: 'chunked',
      }),
      { gemini: true, chatgpt: false },
    );
  });

  it('routes explicit OpenAI and Soniox live providers to their keys with a Gemini fallback', () => {
    const openai = credentialUsage({
      aiProvider: 'chatgpt',
      transcriptionProvider: 'auto',
      liveSttProvider: 'openai',
    });
    assert.deepEqual(openai.openai, ['live captions']);
    assert.deepEqual(openai.gemini, ['live fallback']);
    const soniox = credentialUsage({
      aiProvider: 'gemini',
      transcriptionProvider: 'soniox',
      liveSttProvider: 'soniox',
    });
    assert.deepEqual(soniox.soniox, ['transcription', 'live captions']);
  });

  it('lists no transcription credential for a retired Codex transcription value', () => {
    const usage = credentialUsage({
      aiProvider: 'gemini',
      transcriptionProvider: 'codex',
      liveSttProvider: 'chunked',
    });
    assert.deepEqual(usage, { gemini: ['summaries'], chatgpt: [], openai: [], soniox: [] });
  });
});

describe('chunked live captions', () => {
  it('use the resolved batch backend, not the summary provider', () => {
    const usage = credentialUsage({
      aiProvider: 'chatgpt',
      transcriptionProvider: 'soniox',
      liveSttProvider: 'chunked',
    });
    assert.deepEqual(usage.soniox, ['transcription', 'live captions']);
    assert.deepEqual(usage.chatgpt, ['summaries']);
    assert.deepEqual(usage.gemini, []);
  });

  it('follow the summary provider when transcription is set to follow Gemini', () => {
    const usage = credentialUsage({
      aiProvider: 'gemini',
      transcriptionProvider: 'auto',
      liveSttProvider: 'chunked',
    });
    assert.deepEqual(usage.gemini, ['summaries', 'transcription', 'live captions']);
  });

  it('list no caption credential when Auto under ChatGPT transcribes nothing', () => {
    const usage = credentialUsage({
      aiProvider: 'chatgpt',
      transcriptionProvider: 'auto',
      liveSttProvider: 'chunked',
    });
    assert.deepEqual(usage, { gemini: [], chatgpt: ['summaries'], openai: [], soniox: [] });
  });

  it('never list OpenAI as a Soniox fallback', () => {
    const usage = credentialUsage({
      aiProvider: 'gemini',
      transcriptionProvider: 'auto',
      liveSttProvider: 'soniox',
    });
    assert.deepEqual(usage.openai, []);
  });
});

describe('auto live captions', () => {
  it('list both streaming keys and need neither, for every summary/transcription pair', () => {
    for (const choices of allChoices.filter((c) => c.liveSttProvider === 'auto')) {
      const usage = credentialUsage(choices);
      assert.ok(usage.openai.includes('live captions'), JSON.stringify(choices));
      assert.ok(usage.gemini.includes('live captions'), JSON.stringify(choices));
      assert.ok(!usage.soniox.includes('live captions'), JSON.stringify(choices));
      assert.ok(!usage.chatgpt.includes('live captions'), JSON.stringify(choices));
    }
  });

  it('name the batch backend that takes over as 12s chunks without a streaming key', () => {
    for (const choices of allChoices.filter((c) => c.liveSttProvider === 'auto')) {
      const batch = batchOf(choices);
      if (!batch) continue;
      const uses = credentialUsage(choices)[batch];
      assert.ok(
        uses.includes('live captions') || uses.includes('live fallback'),
        JSON.stringify(choices),
      );
    }
  });

  it('describe a Soniox backend as the caption fallback under ChatGPT summaries', () => {
    const usage = credentialUsage({
      aiProvider: 'chatgpt',
      transcriptionProvider: 'soniox',
      liveSttProvider: 'auto',
    });
    assert.deepEqual(usage.soniox, ['transcription', 'live fallback']);
    assert.deepEqual(usage.chatgpt, ['summaries']);
    assert.equal(
      describeCredentialUse(usage.soniox),
      'Used for transcribing recordings and live captions when the chosen live provider is unavailable.',
    );
  });

  it('do not list a Gemini backend twice, since Gemini Live already covers captions', () => {
    const usage = credentialUsage({
      aiProvider: 'chatgpt',
      transcriptionProvider: 'gemini',
      liveSttProvider: 'auto',
    });
    assert.deepEqual(usage.gemini, ['transcription', 'live captions']);
    assert.deepEqual(usage.chatgpt, ['summaries']);
  });
});

describe('describeCredentialUse', () => {
  it('says when a credential is unused', () => {
    assert.equal(describeCredentialUse([]), 'Not used by your current choices.');
  });

  it('joins uses in plain language', () => {
    assert.equal(describeCredentialUse(['summaries']), 'Used for summaries and Ask Listener.');
    assert.equal(
      describeCredentialUse(['summaries', 'transcription', 'live captions']),
      'Used for summaries and Ask Listener, transcribing recordings and live captions.',
    );
  });
});
