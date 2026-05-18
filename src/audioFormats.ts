export const SUPPORTED_AUDIO_EXTENSIONS = [
  '.mp3',
  '.m4a',
  '.wav',
  '.webm',
  '.ogg',
  '.opus',
  '.flac',
  '.aac',
] as const;

const MIME_FOR_EXTENSION: Record<string, string> = {
  '.mp3': 'audio/mp3',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
};

const EXTENSION_FOR_MIME: Record<string, string> = {
  'audio/mp3': 'mp3',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'm4a',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/flac': 'flac',
};

export function mimeTypeForExtension(ext: string): string {
  const normalized = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  return MIME_FOR_EXTENSION[normalized] ?? 'audio/mp3';
}

export function extensionForMimeType(mimeType: string): string {
  const base = mimeType.split(';')[0].trim().toLowerCase();
  return EXTENSION_FOR_MIME[base] ?? 'webm';
}

export function isSupportedAudioExtension(ext: string): boolean {
  const normalized = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  return (SUPPORTED_AUDIO_EXTENSIONS as readonly string[]).includes(normalized);
}

// Transient files the transcription pipeline writes alongside user recordings:
//   - `<base>_segment_NNN.<ext>` from ffmpeg's segment muxer (NNN = `%03d`)
//   - `<base>_codex_<Date.now()>.webm` from `prepareAudioForProvider` when a
//     non-OpenAI-supported source extension (.ogg/.flac/.aac/.opus) needs to
//     be remuxed before hitting `/v1/audio/transcriptions`
// Used by the recordings watcher to suppress mid-transcription refreshes that
// would wipe the inline progress row, and by `get-recordings` so these temp
// files don't appear as ghost recordings while a transcribe is in flight.
const TRANSCRIPTION_TEMP_FILE_PATTERN = /(?:_segment_\d{3}|_codex_\d+)\.[A-Za-z0-9]+$/;

export function isTranscriptionTempFile(filename: string): boolean {
  return TRANSCRIPTION_TEMP_FILE_PATTERN.test(filename);
}
