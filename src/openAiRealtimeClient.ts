import type { LiveRealtimeClientConfig } from './liveSessionService';
import type { LiveSttProviderConfig } from './liveSttProvider';

export type OpenAiRealtimeBearerSource = 'apiKey';

export interface OpenAiRealtimeBearer {
  token: string;
  source: OpenAiRealtimeBearerSource;
}

export type OpenAiRealtimeBearerProvider = (
  config: LiveSttProviderConfig,
) => Promise<OpenAiRealtimeBearer | null>;

type RealtimeClientSecretResponse = {
  value?: string;
  error?: { message?: string; code?: string };
};

export function formatRealtimeClientSecretError(
  response: Pick<Response, 'status' | 'statusText'>,
  payload: RealtimeClientSecretResponse | string,
): string {
  if (typeof payload !== 'string') {
    const message = payload.error?.message?.trim();
    if (message) return message;
  }
  if (typeof payload === 'string' && payload.trim()) return payload.trim();
  return `${response.status} ${response.statusText}`.trim();
}

export function buildRealtimeClientSecretRequest(config: LiveSttProviderConfig): {
  endpoint: LiveRealtimeClientConfig['endpoint'];
  url: string;
  body: unknown;
} | null {
  if (config.provider === 'chunked' || config.provider === 'gemini') return null;

  const translate = config.translate !== false;
  if (translate) {
    return {
      endpoint: 'translation',
      url: 'https://api.openai.com/v1/realtime/translations/client_secrets',
      body: {
        session: {
          model: config.openaiLiveTranslationModel || 'gpt-realtime-translate',
          audio: {
            output: { language: config.translationLanguage?.trim() || 'ko' },
          },
        },
      },
    };
  }

  return {
    endpoint: 'realtime',
    url: 'https://api.openai.com/v1/realtime/client_secrets',
    body: {
      session: {
        type: 'transcription',
        audio: {
          input: {
            transcription: {
              model: config.openaiLiveTranscriptionModel || 'gpt-realtime-whisper',
              ...(config.language?.trim() ? { language: config.language.trim() } : {}),
              delay: 'low',
            },
            turn_detection: null,
          },
        },
      },
    },
  };
}

export async function createOpenAiRealtimeClientConfig(
  config: LiveSttProviderConfig,
  getBearer: OpenAiRealtimeBearerProvider,
  fetchImpl: typeof fetch = fetch,
): Promise<LiveRealtimeClientConfig | null> {
  const request = buildRealtimeClientSecretRequest(config);
  if (!request) return null;

  const bearer = await getBearer(config);
  if (!bearer?.token.trim()) return null;

  const response = await fetchImpl(request.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearer.token.trim()}`,
      'Content-Type': 'application/json',
      'OpenAI-Safety-Identifier': 'listener-ai-local',
    },
    body: JSON.stringify(request.body),
  });
  const text = await response.text();
  let payload: RealtimeClientSecretResponse | string = text;
  try {
    payload = JSON.parse(text) as RealtimeClientSecretResponse;
  } catch {
    // Keep raw text for the error message below.
  }
  if (!response.ok || typeof payload === 'string' || !payload.value) {
    throw new Error(
      `OpenAI Realtime client secret failed: ${formatRealtimeClientSecretError(response, payload)}`,
    );
  }
  return {
    transport: 'webrtc',
    endpoint: request.endpoint,
    clientSecret: payload.value,
  };
}
