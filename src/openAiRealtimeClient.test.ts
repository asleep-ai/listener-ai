import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildRealtimeClientSecretRequest,
  createOpenAiRealtimeClientConfig,
} from './openAiRealtimeClient';

describe('openAiRealtimeClient', () => {
  it('builds a transcription client-secret request', () => {
    const request = buildRealtimeClientSecretRequest({
      provider: 'openai',
      translate: false,
      openaiLiveTranscriptionModel: 'gpt-realtime-whisper',
      language: 'ko',
    });

    assert.equal(request?.endpoint, 'realtime');
    assert.equal(request?.url, 'https://api.openai.com/v1/realtime/client_secrets');
    assert.deepEqual(request?.body, {
      session: {
        type: 'transcription',
        audio: {
          input: {
            transcription: {
              model: 'gpt-realtime-whisper',
              language: 'ko',
              delay: 'low',
            },
            turn_detection: null,
          },
        },
      },
    });
  });

  it('builds a translation client-secret request', () => {
    const request = buildRealtimeClientSecretRequest({
      provider: 'openai',
      translate: true,
      openaiLiveTranslationModel: 'gpt-realtime-translate',
      translationLanguage: 'ja',
    });

    assert.equal(request?.endpoint, 'translation');
    assert.equal(request?.url, 'https://api.openai.com/v1/realtime/translations/client_secrets');
    assert.deepEqual(request?.body, {
      session: {
        model: 'gpt-realtime-translate',
        audio: {
          output: { language: 'ja' },
        },
      },
    });
  });

  it('uses the supplied OpenAI API key to create a WebRTC client config', async () => {
    let seenUrl = '';
    let seenAuth = '';
    let seenBody: unknown;
    const result = await createOpenAiRealtimeClientConfig(
      { provider: 'openai', translate: false },
      async () => ({ token: 'openai-api-key', source: 'apiKey' }),
      (async (url, init) => {
        seenUrl = String(url);
        const headers = new Headers(init?.headers);
        seenAuth = headers.get('authorization') ?? '';
        seenBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ value: 'ek_test' }), { status: 200 });
      }) as typeof fetch,
    );

    assert.equal(seenUrl, 'https://api.openai.com/v1/realtime/client_secrets');
    assert.equal(seenAuth, 'Bearer openai-api-key');
    assert.equal(
      (seenBody as { session?: { audio?: { input?: { transcription?: { model?: string } } } } })
        .session?.audio?.input?.transcription?.model,
      'gpt-realtime-whisper',
    );
    assert.deepEqual(result, {
      transport: 'webrtc',
      endpoint: 'realtime',
      clientSecret: 'ek_test',
    });
  });

  it('returns null when OpenAI live is not selected and no request should be made', async () => {
    let called = false;
    const result = await createOpenAiRealtimeClientConfig(
      { provider: 'gemini', geminiApiKey: 'gemini' },
      async () => ({ token: 'token', source: 'apiKey' }),
      (async () => {
        called = true;
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    );

    assert.equal(result, null);
    assert.equal(called, false);
  });

  it('surfaces upstream client-secret errors', async () => {
    await assert.rejects(
      () =>
        createOpenAiRealtimeClientConfig(
          { provider: 'openai' },
          async () => ({ token: 'token', source: 'apiKey' }),
          (async () =>
            new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), {
              status: 429,
              statusText: 'Too Many Requests',
            })) as typeof fetch,
        ),
      /quota exceeded/,
    );
  });
});
