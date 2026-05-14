// Minimal wrapper around OpenAI's `/v1/audio/transcriptions` endpoint.
//
// We keep this here (rather than going through pi-ai) because pi-ai is a
// chat/tool-call unified API -- it has no audio transcription surface. The
// Codex transcription flow needs only a multipart POST, so a thin direct
// fetch is simpler than wedging audio into pi-ai's chat model.
//
// Two output shapes, branched on model id:
//   - `gpt-4o-transcribe-diarize` (default) returns `diarized_json` with
//     speaker-labeled segments. We re-label "Speaker 0/1/..." onto the
//     same `참가자N` convention the Gemini path uses so downstream code
//     (summarization, transcript.md, Notion) doesn't have to care which
//     transcription engine produced the text. This model rejects `prompt`,
//     so user-supplied glossaries (`knownWords`) are dropped on this path.
//   - `gpt-4o-transcribe` (and `whisper-1`) return `{text}` and accept
//     `prompt` for vocabulary biasing, but produce no speaker labels.
//
// Format support: OpenAI accepts mp3, mp4, mpeg, mpga, m4a, wav, webm. Inputs
// outside that set are remuxed upstream in geminiService.ts via ffmpeg before
// reaching this helper.

import * as fs from 'fs';
import * as path from 'path';
import { mimeTypeForExtension } from './audioFormats';

const OPENAI_API_BASE_URL = 'https://api.openai.com/v1';
const DIARIZE_MODEL_ID = 'gpt-4o-transcribe-diarize';

export const OPENAI_TRANSCRIPTION_EXTENSIONS = new Set([
  '.mp3',
  '.mp4',
  '.mpeg',
  '.mpga',
  '.m4a',
  '.wav',
  '.webm',
]);

export type CodexTokenProvider = () => Promise<string>;

export interface DiarizedSegment {
  speaker?: string;
  text?: string;
  start?: number;
  end?: number;
}

export interface TranscribeCodexAudioParams {
  getToken: CodexTokenProvider;
  audioFilePath: string;
  model: string;
  /** Vocabulary/style hint. Ignored when model is `gpt-4o-transcribe-diarize`. */
  prompt?: string;
  /** ISO 639-1 language code (e.g. "ko"). Improves accuracy when set. */
  language?: string;
}

export function isDiarizeModel(model: string): boolean {
  return model.trim() === DIARIZE_MODEL_ID;
}

export async function transcribeCodexAudio(params: TranscribeCodexAudioParams): Promise<string> {
  const audioData = fs.readFileSync(params.audioFilePath);
  const ext = path.extname(params.audioFilePath);
  const model = params.model.trim();
  const diarize = isDiarizeModel(model);

  const form = new FormData();
  form.append('model', model);
  if (params.language) {
    form.append('language', params.language);
  }
  if (diarize) {
    // Required for the diarize model. `chunking_strategy=auto` lets OpenAI
    // split long audio internally while keeping speaker identity coherent
    // across chunks -- so we can hand it a whole 50-minute meeting (subject
    // to the 25MB file-size limit upstream).
    form.append('response_format', 'diarized_json');
    form.append('chunking_strategy', 'auto');
  } else if (params.prompt?.trim()) {
    form.append('prompt', params.prompt.trim());
  }
  form.append(
    'file',
    new Blob([audioData], { type: mimeTypeForExtension(ext) }),
    path.basename(params.audioFilePath),
  );

  const sizeMB = (audioData.byteLength / (1024 * 1024)).toFixed(2);
  const startedAt = Date.now();
  console.log(
    `[codex-transcribe] -> ${path.basename(params.audioFilePath)} ${sizeMB}MB model=${model}${
      diarize ? ' diarize=true' : params.prompt ? ` prompt=${params.prompt.length}chars` : ''
    }${params.language ? ` lang=${params.language}` : ''}`,
  );

  const response = await fetch(`${OPENAI_API_BASE_URL}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await params.getToken()}` },
    body: form,
  });
  const elapsed = Date.now() - startedAt;
  console.log(
    `[codex-transcribe] <- ${elapsed}ms status=${response.status} ${response.statusText}`,
  );

  if (!response.ok) {
    // Truncate the error body so a verbose upstream response doesn't leak
    // headers/debug payload into logs and IPC error strings.
    const body = await response.text().catch(() => '');
    const trimmed = body.length > 500 ? `${body.slice(0, 500)}...` : body;
    throw new Error(
      `OpenAI transcription failed (${response.status} ${response.statusText})${trimmed ? `: ${trimmed}` : ''}`,
    );
  }

  if (diarize) {
    const payload = (await response.json()) as { segments?: DiarizedSegment[] };
    return formatDiarizedSegments(payload.segments);
  }

  const payload = (await response.json()) as { text?: unknown };
  if (typeof payload.text !== 'string' || payload.text.trim().length === 0) {
    throw new Error('OpenAI transcription response missing text');
  }
  return payload.text;
}

// Re-label OpenAI's raw speaker ids ("Speaker 0", "Speaker 1", or the names
// supplied via `known_speaker_names[]` if used) onto our `참가자N` convention,
// matching the format Gemini emits when prompted for speaker labels. Empty
// segments are dropped; consecutive segments from the same speaker are merged
// onto a single line so downstream consumers don't see one speaker split into
// 30+ "참가자1: ..." stubs.
export function formatDiarizedSegments(segments?: DiarizedSegment[]): string {
  if (!segments || segments.length === 0) {
    throw new Error('OpenAI diarized transcription returned no segments');
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
    throw new Error('OpenAI diarized transcription had segments but no usable text');
  }
  return lines.join('\n\n');
}
