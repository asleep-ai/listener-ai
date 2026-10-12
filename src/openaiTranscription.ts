// Batch transcription through OpenAI's public `/v1/audio/transcriptions`
// endpoint, authenticated with a standard OpenAI API key (`openaiApiKey`).
//
// This replaces the old Codex path (`codexTranscription.ts`), which sent a
// borrowed Codex CLI OAuth bearer to the same endpoint. Sign in with ChatGPT
// cannot take over that job: its preview limitations state "Audio/video
// input, the Files upload API, and the transcription API are not supported
// by this flow" (developers.openai.com/siwc/token-sharing-open-source/
// preview-limitations). Transcription is therefore billed separately to the
// user's OpenAI API account, and a ChatGPT sign-in token must never reach
// this module.
//
// We keep this out of pi-ai because pi-ai has no audio surface; the endpoint
// needs only a multipart POST.
//
// Request shape per model, from the official speech-to-text guide
// (developers.openai.com/api/docs/guides/speech-to-text):
//   - `gpt-4o-transcribe-diarize` (default) returns `diarized_json` with
//     speaker-labeled segments, which we re-label onto the `참가자N`
//     convention the Gemini path uses. The guide says it "doesn't support
//     prompts" and that audio "longer than 30 seconds" needs
//     `chunking_strategy`, so `knownWords` and temperature are omitted.
//   - `gpt-transcribe` accepts `prompt` and takes `languages[]` instead of
//     the singular `language` ("Don't send both fields"). Temperature is not
//     documented for it, so it is not sent. No speaker labels.
//   - `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` and `whisper-1` accept
//     `prompt`, `language` and `temperature` and return `{text}`. No speaker
//     labels.
//
// Format support: OpenAI accepts mp3, mp4, mpeg, mpga, m4a, wav, webm, with a
// 25 MB file limit. Other inputs are remuxed upstream via ffmpeg, and larger
// ones are segmented upstream, before they reach this helper.

import * as fs from 'fs';
import * as path from 'path';
import { mimeTypeForExtension } from './audioFormats';
import { EmptyTranscriptionError, TranscriptionApiError } from './transcriptionErrors';

export {
  EmptyTranscriptionError,
  TranscriptionApiError,
  type TranscriptionApiErrorDetails,
} from './transcriptionErrors';

const OPENAI_API_BASE_URL = 'https://api.openai.com/v1';
const DIARIZE_MODEL_ID = 'gpt-4o-transcribe-diarize';
const GPT_TRANSCRIBE_MODEL_ID = 'gpt-transcribe';

export const DEFAULT_OPENAI_TRANSCRIPTION_MODEL = DIARIZE_MODEL_ID;

export const OPENAI_TRANSCRIPTION_EXTENSIONS = new Set([
  '.mp3',
  '.mp4',
  '.mpeg',
  '.mpga',
  '.m4a',
  '.wav',
  '.webm',
]);

export interface DiarizedSegment {
  speaker?: string;
  text?: string;
  start?: number;
  end?: number;
}

export interface TranscribeOpenAiAudioParams {
  /** Standard OpenAI API key. Never a ChatGPT sign-in token. */
  apiKey: string;
  audioFilePath: string;
  model: string;
  /** Vocabulary/style hint (`knownWords`). Ignored by the diarize model. */
  prompt?: string;
  /** ISO 639-1 language code (e.g. "ko"). Improves accuracy when set. */
  language?: string;
  /** Sent only to models that document it (not diarize, not gpt-transcribe). */
  temperature?: number;
  /** Cancellation signal, forwarded into the fetch so the in-flight upload
   *  aborts immediately (user cancel, or a sibling segment's 4xx). */
  signal?: AbortSignal;
}

export function isDiarizeModel(model: string): boolean {
  return model.trim() === DIARIZE_MODEL_ID;
}

/** Whether the model accepts `prompt`, the only channel for `knownWords`. */
export function supportsTranscriptionPrompt(model: string): boolean {
  return !isDiarizeModel(model);
}

/** Whether the model accepts `temperature`; the request drops it otherwise. */
export function supportsTemperature(model: string): boolean {
  const id = model.trim();
  return id !== DIARIZE_MODEL_ID && id !== GPT_TRANSCRIBE_MODEL_ID;
}

export async function transcribeOpenAiAudio(params: TranscribeOpenAiAudioParams): Promise<string> {
  const apiKey = params.apiKey.trim();
  if (!apiKey) {
    throw new Error('OpenAI API key is not configured for transcription');
  }
  const audioData = await fs.promises.readFile(params.audioFilePath);
  const ext = path.extname(params.audioFilePath);
  const model = params.model.trim();
  const diarize = isDiarizeModel(model);
  const prompt = supportsTranscriptionPrompt(model) ? params.prompt?.trim() : undefined;
  const temperature = supportsTemperature(model) ? params.temperature : undefined;

  const form = new FormData();
  form.append('model', model);
  if (params.language) {
    form.append(model === GPT_TRANSCRIBE_MODEL_ID ? 'languages[]' : 'language', params.language);
  }
  if (diarize) {
    form.append('response_format', 'diarized_json');
    form.append('chunking_strategy', 'auto');
  }
  if (prompt) {
    form.append('prompt', prompt);
  }
  if (temperature !== undefined) {
    form.append('temperature', String(temperature));
  }
  form.append(
    'file',
    new Blob([audioData], { type: mimeTypeForExtension(ext) }),
    path.basename(params.audioFilePath),
  );

  const sizeMB = (audioData.byteLength / (1024 * 1024)).toFixed(2);
  const startedAt = Date.now();
  console.log(
    `[openai-transcribe] -> ${path.basename(params.audioFilePath)} ${sizeMB}MB model=${model}${
      diarize ? ' diarize=true' : prompt ? ` prompt=${prompt.length}chars` : ''
    }${params.language ? ` lang=${params.language}` : ''}${
      temperature !== undefined ? ` temp=${temperature}` : ''
    }`,
  );

  const response = await fetch(`${OPENAI_API_BASE_URL}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: params.signal,
  });
  console.log(
    `[openai-transcribe] <- ${Date.now() - startedAt}ms status=${response.status} ${response.statusText}`,
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    let parsed: { error?: { message?: string; type?: string; code?: string } } | undefined;
    try {
      parsed = JSON.parse(body);
    } catch {
      // body wasn't JSON -- treat as opaque text
    }
    throw new TranscriptionApiError(
      parsed?.error?.message ||
        `OpenAI transcription failed (${response.status} ${response.statusText})`,
      {
        status: response.status,
        statusText: response.statusText,
        requestId: response.headers.get('x-request-id') ?? undefined,
        errorType: parsed?.error?.type,
        errorCode: parsed?.error?.code,
        rawBody: body.length > 1500 ? `${body.slice(0, 1500)}...` : body,
      },
    );
  }

  if (diarize) {
    const payload = (await response.json()) as { segments?: DiarizedSegment[] };
    return formatDiarizedSegments(payload.segments);
  }

  const payload = (await response.json()) as { text?: unknown };
  if (typeof payload.text !== 'string') {
    throw new Error('OpenAI transcription response missing text');
  }
  if (payload.text.trim().length === 0) {
    throw new EmptyTranscriptionError('OpenAI transcription returned no speech');
  }
  return payload.text;
}

// Re-label OpenAI's raw speaker ids (capital letters by default, or the names
// supplied via `known_speaker_names[]`) onto our `참가자N` convention in
// first-seen order. Empty segments are dropped; consecutive segments from the
// same speaker merge onto one line.
export function formatDiarizedSegments(segments?: DiarizedSegment[]): string {
  if (!segments) {
    throw new Error('OpenAI diarized transcription response missing segments');
  }
  if (segments.length === 0) {
    throw new EmptyTranscriptionError('OpenAI diarized transcription returned no segments');
  }

  const speakerIdx = new Map<string, number>();
  let nextIdx = 1;
  const lines: string[] = [];
  let activeLabel: string | undefined;
  let activeBuffer = '';

  for (const seg of segments) {
    const text = (seg.text ?? '').trim();
    if (!text) continue;
    const rawSpeaker = seg.speaker ?? 'unknown';
    let idx = speakerIdx.get(rawSpeaker);
    if (idx === undefined) {
      idx = nextIdx++;
      speakerIdx.set(rawSpeaker, idx);
    }
    const label = `참가자${idx}`;
    if (label === activeLabel) {
      activeBuffer += ` ${text}`;
    } else {
      if (activeLabel !== undefined) lines.push(`${activeLabel}: ${activeBuffer}`);
      activeLabel = label;
      activeBuffer = text;
    }
  }
  if (activeLabel !== undefined) lines.push(`${activeLabel}: ${activeBuffer}`);

  if (lines.length === 0) {
    throw new EmptyTranscriptionError(
      'OpenAI diarized transcription had segments but no usable text',
    );
  }
  return lines.join('\n\n');
}
