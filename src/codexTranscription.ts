// Minimal wrapper around OpenAI's `/v1/audio/transcriptions` endpoint.
//
// We keep this here (rather than going through pi-ai) because pi-ai is a
// chat/tool-call unified API -- it has no audio transcription surface. The
// Codex transcription flow needs only a multipart POST, so a thin direct
// fetch is simpler than wedging audio into pi-ai's chat model.
//
// Format support: OpenAI accepts mp3, mp4, mpeg, mpga, m4a, wav, webm. Inputs
// outside that set are remuxed upstream in geminiService.ts via ffmpeg before
// reaching this helper.

import * as fs from 'fs';
import * as path from 'path';
import { mimeTypeForExtension } from './audioFormats';

const OPENAI_API_BASE_URL = 'https://api.openai.com/v1';

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

export async function transcribeCodexAudio(params: {
  getToken: CodexTokenProvider;
  audioFilePath: string;
  model: string;
  prompt?: string;
}): Promise<string> {
  const audioData = fs.readFileSync(params.audioFilePath);
  const ext = path.extname(params.audioFilePath);
  const form = new FormData();
  form.append('model', params.model.trim());
  if (params.prompt?.trim()) {
    form.append('prompt', params.prompt.trim());
  }
  form.append(
    'file',
    new Blob([audioData], { type: mimeTypeForExtension(ext) }),
    path.basename(params.audioFilePath),
  );

  const response = await fetch(`${OPENAI_API_BASE_URL}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await params.getToken()}` },
    body: form,
  });

  if (!response.ok) {
    // Truncate the error body so a verbose upstream response doesn't leak
    // headers/debug payload into logs and IPC error strings.
    const body = await response.text().catch(() => '');
    const trimmed = body.length > 500 ? `${body.slice(0, 500)}...` : body;
    throw new Error(
      `OpenAI transcription failed (${response.status} ${response.statusText})${trimmed ? `: ${trimmed}` : ''}`,
    );
  }

  const payload = (await response.json()) as { text?: unknown };
  if (typeof payload.text !== 'string' || payload.text.trim().length === 0) {
    throw new Error('OpenAI transcription response missing text');
  }
  return payload.text;
}
