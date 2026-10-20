import * as fs from 'fs';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as path from 'path';
import type { AgentRunOptions, AgentRunResult, AgentService } from './agentService';
import {
  GeminiService,
  type TranscriptionOptions,
  type TranscriptionResult,
} from './geminiService';
import {
  LiveChunkedCaptionsUnavailableError,
  LiveSessionEndedError,
  LiveSessionService,
  type LiveSessionEvent,
} from './liveSessionService';
import type { LiveSttCallbacks, LiveSttSession } from './liveSttProvider';
import type { RecordInput } from './services/usageTracker';
import { makeTempDir, rmDir } from './test-helpers';

let workDir: string;

beforeEach(() => {
  workDir = makeTempDir('live-session');
});

afterEach(() => {
  rmDir(workDir);
});

function makeAudioBytes(): Uint8Array {
  return new Uint8Array(2048).fill(7);
}

function chunkedConfig() {
  return { provider: 'chunked' as const };
}

describe('LiveSessionService', () => {
  it('transcribes a live audio chunk, translates it, and stores a snapshot', async () => {
    const tempPathsSeen: string[] = [];
    const fakeGemini = {
      async transcribeLiveSnippet(filePath: string): Promise<string> {
        assert.equal(fs.existsSync(filePath), true);
        tempPathsSeen.push(filePath);
        return 'Speaker 1: Hello everyone.';
      },
      async translateText(text: string): Promise<string> {
        assert.equal(text, 'Speaker 1: Hello everyone.');
        return '참가자1: 모두 안녕하세요.';
      },
    };
    const service = new LiveSessionService({
      getDataPath: () => workDir,
      ensureGeminiService: () => fakeGemini as unknown as GeminiService,
      getAgentService: () => null,
      formatAiCredentialsError: () => 'missing credentials',
      getLiveSttConfig: chunkedConfig,
    });

    const session = await service.start({ title: 'Bonjour', translate: false });
    const segment = await service.processAudioChunk({
      sessionId: session.sessionId,
      audioData: makeAudioBytes(),
      mimeType: 'audio/webm',
      offsetMs: 12_000,
      durationMs: 11_500,
      translate: true,
    });

    assert.ok(segment);
    assert.equal(segment.transcript, 'Speaker 1: Hello everyone.');
    assert.equal(segment.translation, '참가자1: 모두 안녕하세요.');
    const snapshot = service.snapshot();
    assert.equal(snapshot?.transcript, 'Speaker 1: Hello everyone.');
    assert.equal(snapshot?.translation, '참가자1: 모두 안녕하세요.');
    assert.equal(tempPathsSeen.length, 1);
    assert.equal(fs.existsSync(tempPathsSeen[0]), false);
  });

  it('answers questions against the accumulated live transcript', async () => {
    let scopeSeen: AgentRunOptions['scope'] | undefined;
    const fakeGemini = {
      async transcribeLiveSnippet(): Promise<string> {
        return 'Participant: The launch is on Friday.';
      },
      async translateText(): Promise<string> {
        return '참가자: 출시는 금요일입니다.';
      },
    };
    const fakeAgent = {
      async run(opts: AgentRunOptions): Promise<AgentRunResult> {
        scopeSeen = opts.scope;
        return {
          answer: 'Friday.',
          appliedActions: [],
          history: [
            { role: 'user', text: opts.question },
            { role: 'model', text: 'Friday.' },
          ],
        };
      },
    };
    const service = new LiveSessionService({
      getDataPath: () => workDir,
      ensureGeminiService: () => fakeGemini as unknown as GeminiService,
      getAgentService: () => fakeAgent as unknown as AgentService,
      formatAiCredentialsError: () => 'missing credentials',
      getLiveSttConfig: chunkedConfig,
    });

    const session = await service.start({ title: 'Planning' });
    await service.processAudioChunk({
      sessionId: session.sessionId,
      audioData: makeAudioBytes(),
      mimeType: 'audio/webm',
      offsetMs: 0,
      durationMs: 12_000,
    });

    const result = await service.ask({
      sessionId: session.sessionId,
      question: 'When is launch?',
    });

    assert.equal(result.answer, 'Friday.');
    assert.equal(scopeSeen?.kind, 'live');
    if (scopeSeen?.kind === 'live') {
      assert.equal(scopeSeen.title, 'Planning');
      assert.match(scopeSeen.transcript, /launch is on Friday/);
      assert.match(scopeSeen.translation ?? '', /금요일/);
    }
  });

  it('rejects live questions before any transcript exists', async () => {
    const service = new LiveSessionService({
      getDataPath: () => workDir,
      ensureGeminiService: () => null,
      getAgentService: () => null,
      formatAiCredentialsError: () => 'missing credentials',
      getLiveSttConfig: chunkedConfig,
    });

    const session = await service.start();
    await assert.rejects(
      () => service.ask({ sessionId: session.sessionId, question: 'Anything?' }),
      /No live transcript/,
    );
  });

  it('ignores tiny empty chunks', async () => {
    let called = false;
    const service = new LiveSessionService({
      getDataPath: () => workDir,
      ensureGeminiService: () =>
        ({
          async transcribeLiveSnippet(): Promise<string> {
            called = true;
            return 'should not happen';
          },
        }) as unknown as GeminiService,
      getAgentService: () => null,
      formatAiCredentialsError: () => 'missing credentials',
      getLiveSttConfig: chunkedConfig,
    });

    const session = await service.start();
    const result = await service.processAudioChunk({
      sessionId: session.sessionId,
      audioData: new Uint8Array(10),
      mimeType: 'audio/webm',
      offsetMs: 0,
      durationMs: 10,
    });

    assert.equal(result, null);
    assert.equal(called, false);
    assert.equal(service.snapshot()?.segments.length, 0);
    assert.equal(fs.existsSync(path.join(workDir, 'live-snippets')), false);
  });

  it('ignores fallback chunks that arrive after the live session is stopped', async () => {
    let called = false;
    const service = new LiveSessionService({
      getDataPath: () => workDir,
      ensureGeminiService: () =>
        ({
          async transcribeLiveSnippet(): Promise<string> {
            called = true;
            return 'should not happen';
          },
        }) as unknown as GeminiService,
      getAgentService: () => null,
      formatAiCredentialsError: () => 'missing credentials',
      getLiveSttConfig: chunkedConfig,
    });

    const session = await service.start();
    await service.stop(session.sessionId);
    const result = await service.processAudioChunk({
      sessionId: session.sessionId,
      audioData: makeAudioBytes(),
      mimeType: 'audio/webm',
      offsetMs: 0,
      durationMs: 12_000,
    });

    assert.equal(result, null);
    assert.equal(called, false);
    assert.equal(service.snapshot()?.segments.length, 0);
  });

  it('aborts an in-flight fallback transcription when the live session stops', async () => {
    let started!: () => void;
    let seenSignal: AbortSignal | undefined;
    const transcriptionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fakeGemini = {
      transcribeLiveSnippet(
        _filePath: string,
        opts: { signal?: AbortSignal } = {},
      ): Promise<string> {
        seenSignal = opts.signal;
        started();
        return new Promise<string>((_resolve, reject) => {
          if (opts.signal?.aborted) {
            const error = new Error('Aborted');
            error.name = 'AbortError';
            reject(error);
            return;
          }
          opts.signal?.addEventListener(
            'abort',
            () => {
              const error = new Error('Aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        });
      },
      async translateText(): Promise<string> {
        return 'should not happen';
      },
    };
    const service = new LiveSessionService({
      getDataPath: () => workDir,
      ensureGeminiService: () => fakeGemini as unknown as GeminiService,
      getAgentService: () => null,
      formatAiCredentialsError: () => 'missing credentials',
      getLiveSttConfig: chunkedConfig,
    });

    const session = await service.start();
    const processing = service.processAudioChunk({
      sessionId: session.sessionId,
      audioData: makeAudioBytes(),
      mimeType: 'audio/webm',
      offsetMs: 0,
      durationMs: 12_000,
      translate: true,
    });
    await transcriptionStarted;
    await service.stop(session.sessionId);

    assert.equal(await processing, null);
    assert.equal(seenSignal?.aborted, true);
    assert.equal(service.snapshot()?.segments.length, 0);
  });

  it('streams PCM frames into the live provider and emits interim/final transcript events', async () => {
    let callbacks: LiveSttCallbacks | undefined;
    const sentSequences: number[] = [];
    const events: LiveSessionEvent[] = [];
    const fakeGemini = {
      async translateText(text: string): Promise<string> {
        assert.equal(text, 'Speaker: Bonjour.');
        return '발화자: 안녕하세요.';
      },
    };
    const fakeStream: LiveSttSession = {
      provider: 'openai',
      kind: 'translation',
      sendPcm(frame) {
        sentSequences.push(frame.sequence);
      },
      async close() {},
    };
    const service = new LiveSessionService({
      getDataPath: () => workDir,
      ensureGeminiService: () => fakeGemini as unknown as GeminiService,
      getAgentService: () => null,
      formatAiCredentialsError: () => 'missing credentials',
      getLiveSttConfig: () => ({ provider: 'openai', openaiApiKey: 'oa' }),
      emitEvent: (event) => events.push(event),
      createLiveSttSession: async (_config, cbs) => {
        callbacks = cbs;
        return fakeStream;
      },
    });

    const session = await service.start({ title: 'Live', translate: true });
    assert.equal(session.mode, 'streaming');
    service.appendPcm({
      sessionId: session.sessionId,
      audioData: makeAudioBytes(),
      sampleRate: 48_000,
      channelCount: 1,
      offsetMs: 0,
      durationMs: 100,
      sequence: 7,
    });
    callbacks?.onInterim({ text: 'Speaker: Bon', offsetMs: 500 });
    callbacks?.onTranslationInterim?.({ text: '발화자: 안녕', offsetMs: 600 });
    callbacks?.onFinal({
      text: 'Speaker: Bonjour.',
      offsetMs: 1_000,
      durationMs: 800,
      translation: '발화자: 안녕하세요.',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(sentSequences, [7]);
    assert.equal(service.snapshot()?.interimTranscript, '');
    assert.equal(service.snapshot()?.interimTranslation, '');
    assert.match(service.snapshot()?.transcript ?? '', /Bonjour/);
    assert.match(service.snapshot()?.translation ?? '', /안녕하세요/);
    assert.ok(events.some((event) => event.type === 'interim' && /Bon/.test(event.text)));
    assert.ok(
      events.some((event) => event.type === 'translationInterim' && /안녕/.test(event.text)),
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === 'segment' && event.segment.translation?.includes('안녕하세요') === true,
      ),
    );
  });

  it('starts a Gemini Live stream in auto mode when a Gemini key is configured', async () => {
    const fakeStream: LiveSttSession = {
      provider: 'gemini',
      kind: 'translation',
      sendPcm() {},
      async close() {},
    };
    const service = new LiveSessionService({
      getDataPath: () => workDir,
      ensureGeminiService: () => null,
      getAgentService: () => null,
      formatAiCredentialsError: () => 'missing credentials',
      getLiveSttConfig: () => ({ provider: 'auto', geminiApiKey: 'gemini-key' }),
      createLiveSttSession: async () => fakeStream,
    });

    const session = await service.start({ title: 'Live', translate: true });

    assert.equal(session.mode, 'streaming');
    assert.equal(session.provider, 'gemini');
  });

  it('starts a renderer Realtime client when a client secret config is available', async () => {
    const service = new LiveSessionService({
      getDataPath: () => workDir,
      ensureGeminiService: () => null,
      getAgentService: () => null,
      formatAiCredentialsError: () => 'missing credentials',
      getLiveSttConfig: () => ({ provider: 'openai' }),
      createRealtimeClientConfig: async () => ({
        transport: 'webrtc',
        endpoint: 'translation',
        clientSecret: 'ek_test',
      }),
      createLiveSttSession: async () => {
        throw new Error('server stream should not be used');
      },
    });

    const session = await service.start({ title: 'Live', translate: true });

    assert.equal(session.mode, 'streaming');
    assert.equal(session.provider, 'openai');
    assert.equal(session.realtimeClient?.transport, 'webrtc');
    assert.equal(session.realtimeClient?.endpoint, 'translation');
  });

  it('falls back to Gemini when OpenAI is selected but no OpenAI API key is available', async () => {
    let streamConfig: unknown;
    const fakeStream: LiveSttSession = {
      provider: 'gemini',
      kind: 'translation',
      sendPcm() {},
      async close() {},
    };
    const service = new LiveSessionService({
      getDataPath: () => workDir,
      ensureGeminiService: () => null,
      getAgentService: () => null,
      formatAiCredentialsError: () => 'missing credentials',
      getLiveSttConfig: () => ({
        provider: 'openai',
        geminiApiKey: 'gemini-key',
      }),
      createRealtimeClientConfig: async () => null,
      createLiveSttSession: async (config) => {
        if (config.provider === 'openai') throw new Error('OpenAI API key is not configured.');
        streamConfig = config;
        return fakeStream;
      },
    });

    const session = await service.start({ title: 'Live', translate: true });

    assert.equal(session.mode, 'streaming');
    assert.equal(session.provider, 'gemini');
    assert.equal(session.realtimeClient, undefined);
    assert.equal((streamConfig as { provider?: string }).provider, 'gemini');
  });

  it('records OpenAI Realtime usage when a renderer Realtime session stops', async () => {
    let now = Date.parse('2026-06-16T02:00:00.000Z');
    const usage: RecordInput[] = [];
    const service = new LiveSessionService({
      getDataPath: () => workDir,
      ensureGeminiService: () => null,
      getAgentService: () => null,
      formatAiCredentialsError: () => 'missing credentials',
      getLiveSttConfig: () => ({
        provider: 'openai',
        openaiLiveTranslationModel: 'gpt-realtime-translate',
      }),
      now: () => now,
      recordUsage: (input) => {
        usage.push(input);
      },
      createRealtimeClientConfig: async () => ({
        transport: 'webrtc',
        endpoint: 'translation',
        clientSecret: 'ek_test',
      }),
    });

    const session = await service.start({ title: 'Live', translate: true });
    now += 90_000;
    await service.stop(session.sessionId);

    assert.equal(usage.length, 1);
    assert.equal(usage[0].modelId, 'gpt-realtime-translate');
    assert.equal(usage[0].kind, 'realtime');
    assert.equal(usage[0].usage.audioSeconds, 90);
  });

  it('falls back from renderer Realtime to Gemini streaming when the WebRTC call fails', async () => {
    let streamConfig: unknown;
    const events: LiveSessionEvent[] = [];
    const fakeStream: LiveSttSession = {
      provider: 'gemini',
      kind: 'translation',
      sendPcm() {},
      async close() {},
    };
    const service = new LiveSessionService({
      getDataPath: () => workDir,
      ensureGeminiService: () => null,
      getAgentService: () => null,
      formatAiCredentialsError: () => 'missing credentials',
      getLiveSttConfig: () => ({
        provider: 'auto',
        geminiApiKey: 'gemini-key',
      }),
      emitEvent: (event) => events.push(event),
      createRealtimeClientConfig: async () => ({
        transport: 'webrtc',
        endpoint: 'translation',
        clientSecret: 'ek_test',
      }),
      createLiveSttSession: async (config) => {
        streamConfig = config;
        return fakeStream;
      },
    });

    const session = await service.start({ title: 'Live', translate: true });
    const fallback = await service.fallbackFromRealtime({
      sessionId: session.sessionId,
      error: '500 Internal Server Error',
    });

    assert.equal(fallback.mode, 'streaming');
    assert.equal(fallback.provider, 'gemini');
    assert.equal(fallback.realtimeClient, undefined);
    assert.equal((streamConfig as { provider?: string }).provider, 'gemini');
    assert.ok(events.some((event) => event.type === 'error' && /500/.test(event.error)));
    assert.ok(
      events.some(
        (event) => event.type === 'status' && /using gemini live transcription/i.test(event.status),
      ),
    );
  });

  it('names the failed provider once in the start-failure fallback status', async () => {
    // The configured provider failed and the fallback landed on the same one,
    // so naming it on both sides would read as a contradiction.
    let attempts = 0;
    const events: LiveSessionEvent[] = [];
    const fakeStream: LiveSttSession = {
      provider: 'gemini',
      kind: 'transcription',
      sendPcm() {},
      async close() {},
    };
    const service = new LiveSessionService({
      getDataPath: () => workDir,
      ensureGeminiService: () => null,
      getAgentService: () => null,
      formatAiCredentialsError: () => 'missing credentials',
      getLiveSttConfig: () => ({ provider: 'gemini', geminiApiKey: 'gemini-key' }),
      emitEvent: (event) => events.push(event),
      createLiveSttSession: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('gemini live connect failed');
        return fakeStream;
      },
    });

    await service.start({ title: 'Live', translate: false });

    const status = events.find(
      (event) => event.type === 'status' && /unavailable/.test(event.status),
    );
    assert.ok(status && status.type === 'status');
    assert.equal(status.status, 'Live provider unavailable; using Gemini live transcription.');
  });

  it('records Gemini Live usage when a streaming provider session stops', async () => {
    let now = Date.parse('2026-06-16T03:00:00.000Z');
    const usage: RecordInput[] = [];
    const fakeStream: LiveSttSession = {
      provider: 'gemini',
      kind: 'translation',
      sendPcm() {},
      async close() {},
    };
    const service = new LiveSessionService({
      getDataPath: () => workDir,
      ensureGeminiService: () => null,
      getAgentService: () => null,
      formatAiCredentialsError: () => 'missing credentials',
      getLiveSttConfig: () => ({ provider: 'auto', geminiApiKey: 'gemini-key' }),
      now: () => now,
      recordUsage: (input) => {
        usage.push(input);
      },
      createLiveSttSession: async () => fakeStream,
    });

    const session = await service.start({ title: 'Live', translate: true });
    now += 60_000;
    await service.stop(session.sessionId);

    assert.equal(usage.length, 1);
    assert.equal(usage[0].modelId, 'gemini-3.5-live-translate-preview');
    assert.equal(usage[0].kind, 'realtime');
    assert.equal(usage[0].usage.audioSeconds, 60);
  });

  it('records Soniox realtime usage for an explicitly selected Soniox session', async () => {
    let now = Date.parse('2026-06-16T03:00:00.000Z');
    let realtimeClientRequests = 0;
    const usage: RecordInput[] = [];
    const fakeStream: LiveSttSession = {
      provider: 'soniox',
      kind: 'translation',
      sendPcm() {},
      async close() {},
    };
    const service = new LiveSessionService({
      getDataPath: () => workDir,
      ensureGeminiService: () => null,
      getAgentService: () => null,
      formatAiCredentialsError: () => 'missing credentials',
      getLiveSttConfig: () => ({ provider: 'soniox', sonioxApiKey: 'soniox-key' }),
      now: () => now,
      recordUsage: (input) => {
        usage.push(input);
      },
      createRealtimeClientConfig: async () => {
        realtimeClientRequests++;
        return null;
      },
      createLiveSttSession: async () => fakeStream,
    });

    const session = await service.start({ title: 'Live', translate: true });
    now += 30_000;
    await service.stop(session.sessionId);

    // Soniox never routes through the OpenAI realtime client-secret path.
    assert.equal(realtimeClientRequests, 0);
    assert.equal(session.provider, 'soniox');
    assert.equal(usage.length, 1);
    assert.equal(usage[0].modelId, 'stt-rt-v5');
    assert.equal(usage[0].kind, 'realtime');
    assert.equal(usage[0].usage.audioSeconds, 30);
  });

  it('never calls Gemini translation for a Soniox translation stream', async () => {
    let translateCalls = 0;
    const fakeGemini = {
      async translateText(): Promise<string> {
        translateCalls++;
        return '번역';
      },
    };
    const makeService = (stream: LiveSttSession) => {
      let streamCallbacks: LiveSttCallbacks | undefined;
      const service = new LiveSessionService({
        getDataPath: () => workDir,
        ensureGeminiService: () => fakeGemini as unknown as GeminiService,
        getAgentService: () => null,
        formatAiCredentialsError: () => 'missing credentials',
        getLiveSttConfig: () => ({ provider: stream.provider, sonioxApiKey: 'soniox-key' }),
        createLiveSttSession: async (_config, callbacks) => {
          streamCallbacks = callbacks;
          return stream;
        },
      });
      return { service, finals: () => streamCallbacks };
    };

    const soniox = makeService({
      provider: 'soniox',
      kind: 'translation',
      sendPcm() {},
      async close() {},
    });
    await soniox.service.start({ title: 'Live', translate: true });
    // A Soniox final with no translation attached must still not cost a
    // Gemini call -- the one-way translation stream is the only source (D6).
    soniox.finals()?.onFinal({ text: 'Good morning' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(translateCalls, 0);

    // Control: the Gemini/OpenAI streams keep the per-final fallback.
    const gemini = makeService({
      provider: 'gemini',
      kind: 'translation',
      sendPcm() {},
      async close() {},
    });
    await gemini.service.start({ title: 'Live', translate: true });
    gemini.finals()?.onFinal({ text: 'Good morning' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(translateCalls, 1);
  });

  it('never selects Soniox in auto mode, even when only a Soniox key is configured', async () => {
    const service = new LiveSessionService({
      getDataPath: () => workDir,
      ensureGeminiService: () => null,
      getAgentService: () => null,
      formatAiCredentialsError: () => 'missing credentials',
      getLiveSttConfig: () => ({ provider: 'auto', sonioxApiKey: 'soniox-key' }),
    });

    const session = await service.start({ title: 'Live' });

    assert.equal(session.mode, 'chunked');
    assert.equal(session.provider, 'chunked');
  });

  it('surfaces a missing Soniox key when Soniox is explicitly selected', async () => {
    const service = new LiveSessionService({
      getDataPath: () => workDir,
      ensureGeminiService: () => null,
      getAgentService: () => null,
      formatAiCredentialsError: () => 'missing credentials',
      getLiveSttConfig: () => ({ provider: 'soniox' }),
    });

    await assert.rejects(
      () => service.start({ title: 'Live' }),
      /Soniox API key is not configured/,
    );
  });

  it('falls back to Gemini in auto mode when OpenAI WebRTC setup fails', async () => {
    let streamConfig: unknown;
    const fakeStream: LiveSttSession = {
      provider: 'gemini',
      kind: 'translation',
      sendPcm() {},
      async close() {},
    };
    const events: LiveSessionEvent[] = [];
    const service = new LiveSessionService({
      getDataPath: () => workDir,
      ensureGeminiService: () => null,
      getAgentService: () => null,
      formatAiCredentialsError: () => 'missing credentials',
      getLiveSttConfig: () => ({
        provider: 'auto',
        openaiApiKey: 'oa',
        geminiApiKey: 'gemini-key',
      }),
      emitEvent: (event) => events.push(event),
      createRealtimeClientConfig: async () => {
        throw new Error('client secret failed');
      },
      createLiveSttSession: async (config) => {
        streamConfig = config;
        return fakeStream;
      },
    });

    const session = await service.start({ title: 'Live', translate: true });

    assert.equal(session.mode, 'streaming');
    assert.equal(session.provider, 'gemini');
    assert.equal((streamConfig as { openaiApiKey?: string }).openaiApiKey, undefined);
    assert.ok(events.some((event) => event.type === 'error' && /client secret/.test(event.error)));
  });

  it('surfaces OpenAI WebRTC setup failure when OpenAI is explicitly selected', async () => {
    const service = new LiveSessionService({
      getDataPath: () => workDir,
      ensureGeminiService: () => null,
      getAgentService: () => null,
      formatAiCredentialsError: () => 'missing credentials',
      getLiveSttConfig: () => ({
        provider: 'openai',
        openaiApiKey: 'oa',
        geminiApiKey: 'gemini-key',
      }),
      createRealtimeClientConfig: async () => {
        throw new Error('client secret failed');
      },
      createLiveSttSession: async () => {
        throw new Error('server stream should not be used');
      },
    });

    await assert.rejects(() => service.start({ title: 'Live' }), /client secret failed/);
  });

  it('stores renderer Realtime interim and final transcript events', async () => {
    const events: LiveSessionEvent[] = [];
    const service = new LiveSessionService({
      getDataPath: () => workDir,
      ensureGeminiService: () => null,
      getAgentService: () => null,
      formatAiCredentialsError: () => 'missing credentials',
      getLiveSttConfig: () => ({ provider: 'openai' }),
      emitEvent: (event) => events.push(event),
      createRealtimeClientConfig: async () => ({
        transport: 'webrtc',
        endpoint: 'translation',
        clientSecret: 'ek_test',
      }),
    });

    const session = await service.start({ title: 'Live', translate: true });
    service.receiveInterim({
      sessionId: session.sessionId,
      text: 'Speaker: Bonjour',
      offsetMs: 500,
    });
    service.receiveInterim({
      sessionId: session.sessionId,
      text: '발화자: 안녕하세요',
      translation: true,
      offsetMs: 700,
    });
    service.receiveFinalTranscript({
      sessionId: session.sessionId,
      text: 'Speaker: Bonjour.',
      translation: '발화자: 안녕하세요.',
      offsetMs: 1_000,
      durationMs: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const snapshot = service.snapshot();
    assert.equal(snapshot?.interimTranscript, '');
    assert.equal(snapshot?.interimTranslation, '');
    assert.match(snapshot?.transcript ?? '', /Bonjour/);
    assert.match(snapshot?.translation ?? '', /안녕하세요/);
    assert.ok(events.some((event) => event.type === 'interim' && /Bonjour/.test(event.text)));
    assert.ok(
      events.some((event) => event.type === 'translationInterim' && /안녕하세요/.test(event.text)),
    );
    assert.ok(events.some((event) => event.type === 'segment'));
  });
});

// Issue #182 guards: exact-duplicate live finals inside a short temporal
// window are suppressed (a provider stuck on silence emits the same phrase
// every window), while different text, expired windows, and short natural
// acknowledgements always pass through. Flagged-but-kept finals carry a
// `quality` marker instead of being deleted.
describe('LiveSessionService duplicate suppression and quality flags', () => {
  function makeChunkedService(opts: { transcripts: string[]; now?: () => number }): {
    service: LiveSessionService;
    calls: () => number;
  } {
    let call = 0;
    const fakeGemini = {
      async transcribeLiveSnippet(): Promise<string> {
        const text = opts.transcripts[Math.min(call, opts.transcripts.length - 1)];
        call++;
        return text;
      },
      async translateText(): Promise<string> {
        return '번역';
      },
    };
    const service = new LiveSessionService({
      getDataPath: () => workDir,
      ensureGeminiService: () => fakeGemini as unknown as GeminiService,
      getAgentService: () => null,
      formatAiCredentialsError: () => 'missing credentials',
      getLiveSttConfig: chunkedConfig,
      now: opts.now,
    });
    return { service, calls: () => call };
  }

  function pushChunk(
    service: LiveSessionService,
    sessionId: string,
    offsetMs: number,
  ): ReturnType<LiveSessionService['processAudioChunk']> {
    return service.processAudioChunk({
      sessionId,
      audioData: makeAudioBytes(),
      mimeType: 'audio/webm',
      offsetMs,
      durationMs: 12_000,
      translate: false,
    });
  }

  it('suppresses an exact duplicate chunked final within the temporal window', async () => {
    const { service } = makeChunkedService({
      transcripts: ['참가자1: 시청해주셔서 감사합니다.'],
    });
    const session = await service.start({ title: 'Loop', translate: false });

    const first = await pushChunk(service, session.sessionId, 0);
    const second = await pushChunk(service, session.sessionId, 12_000);

    assert.ok(first, 'first occurrence must be kept');
    assert.equal(second, null, 'exact duplicate within window must be suppressed');
    assert.equal(service.snapshot()?.segments.length, 1);
  });

  it('keeps an identical final again once the temporal window has expired', async () => {
    let nowMs = 0;
    const { service } = makeChunkedService({
      transcripts: ['참가자1: 다음 안건으로 넘어가겠습니다.'],
      now: () => nowMs,
    });
    const session = await service.start({ title: 'Window', translate: false });

    const first = await pushChunk(service, session.sessionId, 0);
    nowMs = 31_000;
    const second = await pushChunk(service, session.sessionId, 31_000);

    assert.ok(first);
    assert.ok(second, 'duplicate outside the 30s window must be kept');
    assert.equal(service.snapshot()?.segments.length, 2);
  });

  it('keeps different consecutive finals and short repeated acknowledgements', async () => {
    const { service } = makeChunkedService({
      transcripts: ['참가자1: 안건을 공유드립니다.', '참가자1: 맞아요.', '참가자1: 맞아요.'],
    });
    const session = await service.start({ title: 'Acks', translate: false });

    assert.ok(await pushChunk(service, session.sessionId, 0));
    assert.ok(await pushChunk(service, session.sessionId, 12_000));
    assert.ok(
      await pushChunk(service, session.sessionId, 24_000),
      'speaker labels must not push short acknowledgements above the length floor',
    );
    assert.equal(service.snapshot()?.segments.length, 3);
  });

  it('suppresses duplicate streaming finals through receiveFinalTranscript', async () => {
    const events: LiveSessionEvent[] = [];
    const service = new LiveSessionService({
      getDataPath: () => workDir,
      ensureGeminiService: () => null,
      getAgentService: () => null,
      formatAiCredentialsError: () => 'missing credentials',
      getLiveSttConfig: chunkedConfig,
      emitEvent: (event) => events.push(event),
    });
    const session = await service.start({ title: 'Streaming', translate: false });

    service.receiveFinalTranscript({
      sessionId: session.sessionId,
      text: 'Speaker: Thank you for watching.',
      offsetMs: 1_000,
    });
    service.receiveFinalTranscript({
      sessionId: session.sessionId,
      text: 'Speaker: Thank you for watching.',
      offsetMs: 3_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(service.snapshot()?.segments.length, 1);
    assert.equal(events.filter((event) => event.type === 'segment').length, 1);
  });

  it('marks a flagged repetition-loop final as uncertain instead of deleting it', async () => {
    const loopText = Array(5).fill('참가자1: 시청해주셔서 감사합니다.').join('\n');
    const { service } = makeChunkedService({ transcripts: [loopText] });
    const session = await service.start({ title: 'Flagged', translate: false });

    const segment = await pushChunk(service, session.sessionId, 0);

    assert.ok(segment, 'flagged text is kept, not dropped');
    assert.equal(segment.quality?.flagged, true);
    assert.ok((segment.quality?.reasons.length ?? 0) > 0);
  });

  it('leaves clean finals unmarked', async () => {
    const { service } = makeChunkedService({
      transcripts: ['참가자1: 오늘 회의를 시작하겠습니다.'],
    });
    const session = await service.start({ title: 'Clean', translate: false });

    const segment = await pushChunk(service, session.sessionId, 0);

    assert.ok(segment);
    assert.equal(segment.quality, undefined);
  });
});

describe('LiveSessionService chunked captions without text-provider credentials', () => {
  function transcriptionOnlyFake(transcript: string) {
    return {
      async transcribeLiveSnippet(): Promise<string> {
        return transcript;
      },
      async translateText(): Promise<string> {
        throw new Error('a transcription-only service must not be asked to translate');
      },
    } as unknown as GeminiService;
  }

  it('captions with translation off through the transcription-only service', async () => {
    const service = new LiveSessionService({
      getDataPath: () => workDir,
      ensureGeminiService: () => null,
      ensureTranscriptionService: () => transcriptionOnlyFake('참가자1: 시작하겠습니다.'),
      getChunkedCaptionsIssue: () => null,
      getAgentService: () => null,
      formatAiCredentialsError: () => 'Not signed in with ChatGPT.',
      getLiveSttConfig: chunkedConfig,
    });

    const session = await service.start({ title: 'Live', translate: false });
    assert.equal(session.mode, 'chunked');
    const segment = await service.processAudioChunk({
      sessionId: session.sessionId,
      audioData: makeAudioBytes(),
      mimeType: 'audio/webm',
      offsetMs: 0,
      durationMs: 12_000,
      translate: false,
    });

    assert.equal(segment?.transcript, '참가자1: 시작하겠습니다.');
    assert.equal(segment?.translation, undefined);
    assert.equal(segment?.translationError, undefined);
  });

  it('keeps the caption and names the missing text provider when translation is turned on', async () => {
    const service = new LiveSessionService({
      getDataPath: () => workDir,
      ensureGeminiService: () => null,
      ensureTranscriptionService: () => transcriptionOnlyFake('참가자1: 다음 안건입니다.'),
      getChunkedCaptionsIssue: () => null,
      getAgentService: () => null,
      formatAiCredentialsError: () => 'Not signed in with ChatGPT.',
      getLiveSttConfig: chunkedConfig,
    });

    const session = await service.start({ title: 'Live', translate: false });
    const segment = await service.processAudioChunk({
      sessionId: session.sessionId,
      audioData: makeAudioBytes(),
      mimeType: 'audio/webm',
      offsetMs: 0,
      durationMs: 12_000,
      translate: true,
    });

    assert.equal(segment?.transcript, '참가자1: 다음 안건입니다.');
    assert.equal(segment?.translationError, 'Not signed in with ChatGPT.');
  });

  it('ends the session instead of announcing chunked captions after Realtime fails with no usable batch backend', async () => {
    const events: LiveSessionEvent[] = [];
    const activeChanges: boolean[] = [];
    let transcribeCalls = 0;
    const service = new LiveSessionService({
      getDataPath: () => workDir,
      ensureGeminiService: () => null,
      ensureTranscriptionService: () => {
        transcribeCalls += 1;
        return null;
      },
      getChunkedCaptionsIssue: () => 'Choose a transcription service.',
      getAgentService: () => null,
      formatAiCredentialsError: () => 'missing credentials',
      // OpenAI key only: the realtime fallbacks are all OpenAI and fail.
      getLiveSttConfig: () => ({ provider: 'auto', openaiApiKey: 'sk-openai' }),
      emitEvent: (event) => events.push(event),
      onActiveChange: (active) => activeChanges.push(active),
      createRealtimeClientConfig: async () => ({
        transport: 'webrtc',
        endpoint: 'realtime',
        clientSecret: 'ek_test',
      }),
      createLiveSttSession: async () => {
        throw new Error('OpenAI WebSocket failed');
      },
    });

    const session = await service.start({ title: 'Live', translate: false });
    assert.equal(session.mode, 'streaming');
    await assert.rejects(
      service.fallbackFromRealtime({ sessionId: session.sessionId, error: 'ICE failed' }),
      (error: unknown) =>
        error instanceof LiveChunkedCaptionsUnavailableError &&
        /Choose a transcription service\./.test(error.message),
    );

    assert.equal(service.snapshot()?.active, false);
    assert.deepEqual(activeChanges, [true, false]);
    assert.equal(
      events.some((event) => event.type === 'status' && /chunked fallback/i.test(event.status)),
      false,
      'chunked captions are never announced',
    );
    const late = await service.processAudioChunk({
      sessionId: session.sessionId,
      audioData: makeAudioBytes(),
      mimeType: 'audio/webm',
      offsetMs: 0,
      durationMs: 12_000,
    });
    assert.equal(late, null);
    assert.equal(transcribeCalls, 0);
  });

  it('still falls back to chunked captions after Realtime fails when the batch backend can run', async () => {
    const service = new LiveSessionService({
      getDataPath: () => workDir,
      ensureGeminiService: () => null,
      getChunkedCaptionsIssue: () => null,
      getAgentService: () => null,
      formatAiCredentialsError: () => 'missing credentials',
      getLiveSttConfig: () => ({ provider: 'auto', openaiApiKey: 'sk-openai' }),
      createRealtimeClientConfig: async () => ({
        transport: 'webrtc',
        endpoint: 'realtime',
        clientSecret: 'ek_test',
      }),
      createLiveSttSession: async () => {
        throw new Error('OpenAI WebSocket failed');
      },
    });

    const session = await service.start({ title: 'Live', translate: false });
    const fallback = await service.fallbackFromRealtime({ sessionId: session.sessionId });
    assert.equal(fallback.mode, 'chunked');
    assert.equal(service.snapshot()?.active, true);
  });

  it('refuses to start on chunked captions when the realtime setup fails and the batch backend cannot run', async () => {
    const events: LiveSessionEvent[] = [];
    const service = new LiveSessionService({
      getDataPath: () => workDir,
      ensureGeminiService: () => null,
      getChunkedCaptionsIssue: () => 'Choose a transcription service.',
      getAgentService: () => null,
      formatAiCredentialsError: () => 'missing credentials',
      getLiveSttConfig: () => ({ provider: 'auto', openaiApiKey: 'sk-openai' }),
      emitEvent: (event) => events.push(event),
      createRealtimeClientConfig: async () => {
        throw new Error('client secret failed');
      },
      // auto without a usable OpenAI key and no Gemini key: no stream.
      createLiveSttSession: async () => null,
    });

    await assert.rejects(
      service.start({ title: 'Live', translate: false }),
      LiveChunkedCaptionsUnavailableError,
    );
    assert.equal(service.snapshot()?.active, false);
    assert.equal(
      events.some((event) => event.type === 'status' && /chunked fallback/i.test(event.status)),
      false,
    );
  });
});

describe('GeminiService live snippets', () => {
  it('builds a transcription-only service without text credentials and refuses text tasks', async () => {
    assert.throws(
      () =>
        new GeminiService({
          provider: 'gemini',
          transcriptionProvider: 'openai',
          openaiApiKey: 'sk-openai',
          dataPath: workDir,
          proModel: 'm',
          flashModel: 'm',
        }),
      /Gemini API key is required/,
    );
    for (const provider of ['gemini', 'chatgpt'] as const) {
      const service = new GeminiService({
        provider,
        transcriptionProvider: 'openai',
        openaiApiKey: 'sk-openai',
        transcriptionOnly: true,
        dataPath: workDir,
        proModel: 'm',
        flashModel: 'm',
      });
      await assert.rejects(service.translateText('hello'), /transcription only/);
    }
  });

  it('transcribes a live snippet on a transcription-only service with no text call', async () => {
    const audioPath = path.join(workDir, 'live.webm');
    fs.writeFileSync(audioPath, Buffer.alloc(2048, 7));
    const service = new GeminiService({
      provider: 'chatgpt',
      transcriptionProvider: 'openai',
      openaiApiKey: 'sk-openai',
      transcriptionOnly: true,
      dataPath: workDir,
      proModel: 'm',
      flashModel: 'm',
    });
    const internals = service as unknown as {
      getAudioDuration(): Promise<number>;
      batchSttBackend: { transcribe(): Promise<string> };
      judgeTranscriptQuality(): Promise<never>;
      cleanupTranscriptQuality(): Promise<never>;
    };
    internals.getAudioDuration = async () => 12;
    let sttCalls = 0;
    internals.batchSttBackend.transcribe = async () => {
      sttCalls += 1;
      return '참가자1: 안녕하세요.';
    };
    internals.judgeTranscriptQuality = async () => {
      throw new Error('no judge call on a live snippet');
    };
    internals.cleanupTranscriptQuality = async () => {
      throw new Error('no cleanup call on a live snippet');
    };

    assert.equal(await service.transcribeLiveSnippet(audioPath), '참가자1: 안녕하세요.');
    assert.equal(sttCalls, 1);
  });

  it('does not apply knownWords to live snippet prompts and drops the no-speech sentinel', async () => {
    const service = new GeminiService({
      provider: 'gemini',
      apiKey: 'test-key',
      dataPath: workDir,
      knownWords: ['에이슬립', '이동헌'],
      proModel: 'gemini-test-pro',
      flashModel: 'gemini-test-flash',
    });
    const originalTranscribeAudio = service.transcribeAudio.bind(service);
    let seenOptions: TranscriptionOptions | undefined;
    service.transcribeAudio = async (
      ...args: Parameters<GeminiService['transcribeAudio']>
    ): Promise<TranscriptionResult> => {
      seenOptions = args[4];
      return {
        transcript: '[NO_SPEECH]',
        summary: '',
        keyPoints: [],
        actionItems: [],
        emoji: '',
      };
    };

    try {
      const result = await service.transcribeLiveSnippet('/tmp/fake-live.webm');

      assert.equal(result, '');
      assert.equal(seenOptions?.includeGlossary, false);
      assert.doesNotMatch(seenOptions?.transcriptionPrompt ?? '', /에이슬립|이동헌/);
      assert.match(seenOptions?.transcriptionPrompt ?? '', /NO_SPEECH/);
    } finally {
      service.transcribeAudio = originalTranscribeAudio;
    }
  });
});

describe('LiveSessionService renderer-lost teardown', () => {
  function makeStreamingService(opts: {
    close?: () => Promise<void>;
    onCallbacks?: (callbacks: LiveSttCallbacks) => void;
    now?: () => number;
    usage?: RecordInput[];
    activeChanges?: boolean[];
  }) {
    let closeCalls = 0;
    const fakeStream: LiveSttSession = {
      provider: 'gemini',
      kind: 'translation',
      sendPcm() {},
      async close() {
        closeCalls++;
        await opts.close?.();
      },
    };
    const service = new LiveSessionService({
      getDataPath: () => workDir,
      ensureGeminiService: () => null,
      getAgentService: () => null,
      formatAiCredentialsError: () => 'missing credentials',
      getLiveSttConfig: () => ({ provider: 'gemini', geminiApiKey: 'gemini-key' }),
      now: opts.now,
      recordUsage: (input) => opts.usage?.push(input),
      onActiveChange: (active) => opts.activeChanges?.push(active),
      createLiveSttSession: async (_config, callbacks) => {
        opts.onCallbacks?.(callbacks);
        return fakeStream;
      },
    });
    return { service, closeCalls: () => closeCalls };
  }

  it('closes the provider while active, keeps the flushed final, and records usage once', async () => {
    let now = Date.parse('2026-10-20T01:00:00.000Z');
    let callbacks: LiveSttCallbacks | undefined;
    const usage: RecordInput[] = [];
    const activeChanges: boolean[] = [];
    const { service, closeCalls } = makeStreamingService({
      now: () => now,
      usage,
      activeChanges,
      onCallbacks: (cbs) => {
        callbacks = cbs;
      },
      // The provider flushes its last final while closing.
      close: async () => {
        callbacks?.onFinal({ text: 'Speaker: last words.', offsetMs: 2_000, durationMs: 500 });
      },
    });

    const session = await service.start({ title: 'Live', translate: false });
    assert.equal(service.isActive(), true);
    now += 30_000;
    const snapshot = await service.stopActive('renderer-lost');

    assert.equal(closeCalls(), 1);
    assert.equal(snapshot?.sessionId, session.sessionId);
    assert.equal(snapshot?.active, false);
    assert.equal(snapshot?.endedReason, 'renderer-lost');
    assert.match(snapshot?.transcript ?? '', /last words/);
    assert.equal(usage.length, 1);
    assert.equal(usage[0].usage.audioSeconds, 30);
    assert.deepEqual(activeChanges, [true, false]);
    assert.equal(service.isActive(), false);

    // A late renderer stop for the same id neither closes again nor re-bills.
    await service.stop(session.sessionId);
    assert.equal(closeCalls(), 1);
    assert.equal(usage.length, 1);
    assert.equal(service.snapshot()?.endedReason, 'renderer-lost');
  });

  it('reports the session inactive as soon as a stop begins', async () => {
    let releaseClose: () => void = () => {};
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const { service } = makeStreamingService({ close: () => closeGate });

    await service.start({ title: 'Live' });
    const stopping = service.stopActive('renderer-lost');
    // A reloaded page fetching the snapshot now must not see a running session.
    assert.equal(service.snapshot()?.active, false);
    assert.equal(service.snapshot()?.endedReason, 'renderer-lost');
    assert.equal(service.isActive(), false);
    releaseClose();
    await stopping;
  });

  it('shares one close between a renderer stop and a renderer-lost teardown', async () => {
    let releaseClose: () => void = () => {};
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const usage: RecordInput[] = [];
    let now = Date.parse('2026-10-20T01:00:00.000Z');
    const { service, closeCalls } = makeStreamingService({
      close: () => closeGate,
      usage,
      now: () => now,
    });

    const session = await service.start({ title: 'Live' });
    now += 10_000;
    const userStop = service.stop(session.sessionId);
    const lostStop = service.stopActive('renderer-lost');
    releaseClose();
    const [userSnapshot, lostSnapshot] = await Promise.all([userStop, lostStop]);

    assert.equal(closeCalls(), 1);
    assert.equal(usage.length, 1);
    // Renderer loss during the drain retains finals for reload recovery.
    assert.equal(userSnapshot?.endedReason, 'renderer-lost');
    assert.equal(lostSnapshot?.endedReason, 'renderer-lost');
  });

  it('is a no-op with no session or after the session stopped', async () => {
    const { service, closeCalls } = makeStreamingService({});
    assert.equal(await service.stopActive('renderer-lost'), null);

    const session = await service.start({ title: 'Live' });
    const stopped = await service.stop(session.sessionId);
    assert.equal(stopped?.endedReason, 'user');
    assert.equal(await service.stopActive('renderer-lost'), null);
    assert.equal(closeCalls(), 1);
    assert.equal(service.snapshot()?.endedReason, 'user');
  });

  it('leaves endedReason absent while a session runs', async () => {
    const { service } = makeStreamingService({});
    await service.start({ title: 'Live' });
    const snapshot = service.snapshot();
    assert.equal(snapshot?.active, true);
    assert.equal('endedReason' in (snapshot ?? {}), false);
  });

  it('closes a provider that finishes connecting after the renderer was lost', async () => {
    let releaseCreate: () => void = () => {};
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let createCalls = 0;
    let closeCalls = 0;
    const activeChanges: boolean[] = [];
    const service = new LiveSessionService({
      getDataPath: () => workDir,
      ensureGeminiService: () => null,
      getAgentService: () => null,
      formatAiCredentialsError: () => 'missing credentials',
      getLiveSttConfig: () => ({ provider: 'gemini', geminiApiKey: 'gemini-key' }),
      onActiveChange: (active) => activeChanges.push(active),
      createLiveSttSession: async () => {
        createCalls++;
        await createGate;
        return {
          provider: 'gemini',
          kind: 'translation',
          sendPcm() {},
          async close() {
            closeCalls++;
          },
        };
      },
    });

    const starting = service.start({ title: 'Live' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sessionId = service.snapshot()?.sessionId;
    // The window reloads while the provider is still connecting.
    const lost = await service.stopActive('renderer-lost');
    assert.equal(lost?.sessionId, sessionId);
    assert.equal(lost?.active, false);
    releaseCreate();

    await assert.rejects(starting, LiveSessionEndedError);
    // Adopted nowhere and closed, and no fallback provider was tried.
    assert.equal(createCalls, 1);
    assert.equal(closeCalls, 1);
    assert.equal(service.isActive(), false);
    assert.equal(service.snapshot()?.endedReason, 'renderer-lost');
    assert.deepEqual(activeChanges, []);
  });

  it('ends a start quietly when the provider fails after the renderer was lost', async () => {
    let failCreate: (error: Error) => void = () => {};
    const createGate = new Promise<never>((_resolve, reject) => {
      failCreate = reject;
    });
    const events: LiveSessionEvent[] = [];
    let createCalls = 0;
    const service = new LiveSessionService({
      getDataPath: () => workDir,
      ensureGeminiService: () => null,
      getAgentService: () => null,
      formatAiCredentialsError: () => 'missing credentials',
      getLiveSttConfig: () => ({ provider: 'gemini', geminiApiKey: 'gemini-key' }),
      emitEvent: (event) => events.push(event),
      createLiveSttSession: async () => {
        createCalls++;
        if (createCalls === 1) return createGate;
        throw new Error('Unexpected fallback attempt');
      },
    });

    const starting = service.start({ title: 'Live' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await service.stopActive('renderer-lost');
    failCreate(new Error('socket closed'));

    // Expected, not a provider failure to report.
    await assert.rejects(starting, LiveSessionEndedError);
    assert.equal(createCalls, 1);
    assert.equal(service.isActive(), false);
    assert.equal(service.snapshot()?.endedReason, 'renderer-lost');
    assert.ok(
      !events.some((event) => event.type === 'status' && /Listening/.test(event.status)),
      'a stopped session must not announce captions',
    );
  });

  it('replaces a session through its in-flight stop without a second close', async () => {
    let releaseClose: () => void = () => {};
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let gateNextClose = true;
    let closeCalls = 0;
    const service = new LiveSessionService({
      getDataPath: () => workDir,
      ensureGeminiService: () => null,
      getAgentService: () => null,
      formatAiCredentialsError: () => 'missing credentials',
      getLiveSttConfig: () => ({ provider: 'gemini', geminiApiKey: 'gemini-key' }),
      createLiveSttSession: async () => ({
        provider: 'gemini',
        kind: 'translation',
        sendPcm() {},
        async close() {
          closeCalls++;
          if (gateNextClose) {
            gateNextClose = false;
            await closeGate;
          }
        },
      }),
    });

    const first = await service.start({ title: 'First' });
    const stopping = service.stopActive('renderer-lost');
    const replacing = service.start({ title: 'Second' });
    releaseClose();
    const [stopped, second] = await Promise.all([stopping, replacing]);

    assert.equal(closeCalls, 1);
    // The stop reports its own session, not the replacement.
    assert.equal(stopped?.sessionId, first.sessionId);
    assert.equal(stopped?.endedReason, 'renderer-lost');
    assert.notEqual(second.sessionId, first.sessionId);
    assert.equal(service.snapshot()?.sessionId, second.sessionId);
    assert.equal(service.snapshot()?.active, true);
    assert.equal(service.isActive(), true);
  });

  it('invalidates a replacement waiting on an old stop when its renderer is lost', async () => {
    let releaseClose: () => void = () => {};
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const { service, closeCalls } = makeStreamingService({ close: () => closeGate });
    const first = await service.start({ title: 'First' });
    const replacing = service.start({ title: 'Owner lost during drain' });
    const lost = service.stopActive('renderer-lost');
    releaseClose();
    await assert.rejects(replacing, LiveSessionEndedError);
    const snapshot = await lost;
    assert.equal(closeCalls(), 1);
    assert.equal(snapshot?.sessionId, first.sessionId);
    assert.equal(snapshot?.endedReason, 'renderer-lost');
    assert.equal(service.isActive(), false);
    assert.equal(service.snapshot()?.sessionId, first.sessionId);
  });

  it('refuses Realtime fallback while its session is draining', async () => {
    let releaseClose: () => void = () => {};
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const { service, closeCalls } = makeStreamingService({ close: () => closeGate });
    const session = await service.start();
    const stopping = service.stop(session.sessionId);
    await assert.rejects(
      service.fallbackFromRealtime({ sessionId: session.sessionId }),
      LiveSessionEndedError,
    );
    releaseClose();
    await stopping;
    assert.equal(closeCalls(), 1);
  });

  it('does not continue Realtime fallback after its pending provider fails following stop', async () => {
    let failCreate: (error: Error) => void = () => {};
    const gate = new Promise<never>((_resolve, reject) => {
      failCreate = reject;
    });
    let createCalls = 0;
    const events: LiveSessionEvent[] = [];
    const service = new LiveSessionService({
      getDataPath: () => workDir,
      ensureGeminiService: () => null,
      getAgentService: () => null,
      formatAiCredentialsError: () => 'missing credentials',
      getLiveSttConfig: () => ({ provider: 'auto', openaiApiKey: 'key', geminiApiKey: 'key' }),
      emitEvent: (event) => events.push(event),
      createRealtimeClientConfig: async () => ({
        transport: 'webrtc',
        endpoint: 'realtime',
        clientSecret: 'test',
      }),
      createLiveSttSession: async () => {
        createCalls++;
        if (createCalls === 1) return gate;
        return null;
      },
    });
    const session = await service.start();
    const fallingBack = service.fallbackFromRealtime({ sessionId: session.sessionId });
    await service.stopActive('renderer-lost');
    failCreate(new Error('Provider failed after stop'));
    await assert.rejects(fallingBack, LiveSessionEndedError);
    assert.equal(createCalls, 1);
    assert.equal(
      events.some((event) => event.type === 'status' && /using/.test(event.status)),
      false,
    );
    await assert.rejects(
      service.fallbackFromRealtime({ sessionId: session.sessionId }),
      LiveSessionEndedError,
    );
  });

  it('does not report a session that failed to start as active', async () => {
    const activeChanges: boolean[] = [];
    const service = new LiveSessionService({
      getDataPath: () => workDir,
      ensureGeminiService: () => null,
      getAgentService: () => null,
      formatAiCredentialsError: () => 'missing credentials',
      getLiveSttConfig: () => ({ provider: 'soniox' }),
      onActiveChange: (active) => activeChanges.push(active),
    });

    await assert.rejects(() => service.start({ title: 'Live' }), /Soniox API key/);
    assert.equal(service.isActive(), false);
    assert.equal(service.snapshot()?.active, false);
    assert.deepEqual(activeChanges, []);
    assert.equal(await service.stopActive('renderer-lost'), null);
  });
});
