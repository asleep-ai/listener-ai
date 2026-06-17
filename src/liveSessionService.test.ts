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
import { LiveSessionService, type LiveSessionEvent } from './liveSessionService';
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

describe('GeminiService live snippets', () => {
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
