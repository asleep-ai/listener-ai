import type { BrowserWindow } from 'electron';
import type { ConfigService } from '../configService';
import type { GeminiService, TranscriptionErrorPayload } from '../geminiService';
import type { LiveNote } from '../outputService';
import type { NotificationService } from '../services/notificationService';
import type { FFmpegManager } from '../services/ffmpegManager';

// Context handed to every src/ipc/<domain>.ts module's register() entry point.
//
// This is the seam between main.ts (which still owns process-wide state -- the
// main window handle, the GeminiService cache slot, the Drive sync trigger) and
// the per-domain IPC handlers that have been split out of main.ts.
//
// Discipline: only add a field here when an IPC module that this PR is
// extracting actually consumes it. Pre-emptively widening the surface forces
// every future caller of registerAllIpc() to wire up plumbing for handlers
// that haven't moved yet -- which leads to half-initialised contexts and
// silent nulls. Each domain extraction adds its own dependencies as it lands.
export interface IpcContext {
  getMainWindow(): BrowserWindow | null;
  configService: ConfigService;
  notificationService: NotificationService;
  ffmpegManager: FFmpegManager;
  // GeminiService is module-cached in main.ts and re-created on relevant
  // config changes (model, provider, OAuth). Handlers that may be the first
  // caller after a config flip use this to get-or-create instead of reaching
  // for a stale reference. Returns null when AI credentials are missing.
  ensureGeminiService(): GeminiService | null;
  // Fire-and-forget Google Drive sync trigger. No-ops when sync is disabled
  // or unauthenticated; safe to call from any handler that mutates a meeting
  // (save, merge, delete) so tombstones / new content propagate promptly.
  maybeAutoSync(): void;
  // Defense in depth: validates that a renderer-supplied transcription folder
  // path lives inside the transcriptions directory before any fs write hits it.
  isContainedTranscriptionPath(folderPath: string | undefined): folderPath is string;
  // Formats the provider-aware "you need credentials" message so handlers
  // can surface a consistent error string regardless of aiProvider.
  formatAiCredentialsError(): string;
  // Renderer-facing classification of provider errors (network/auth/quota/etc).
  // Used by the transcription cluster so the inline progress UI can route
  // users to the right remediation (settings dialog, retry, ffmpeg installer).
  serializeTranscriptionError(error: unknown): TranscriptionErrorPayload;
  // Validates and clips raw live-notes payloads (renderer or metadata source)
  // before they flow into Gemini prompts or get persisted.
  sanitizeLiveNotes(raw: unknown): LiveNote[] | undefined;
}
