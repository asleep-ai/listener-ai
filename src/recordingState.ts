// Recording state shared by main (RecordingController), the hidden capture
// host and the visible UI. Pure types and helpers: no Electron imports, so the
// renderer bundles can import it.
//
// The snapshot is additive and versioned. `revision` increases on every change
// so a subscriber can drop an event older than a snapshot it already read.

export const RECORDING_STATE_VERSION = 1;

export type RecordingPhase = 'idle' | 'starting' | 'recording' | 'stopping';

/** Who or what ended the recording. Additive: readers must tolerate new values. */
export type RecordingStopReason =
  | 'user'
  | 'tray'
  | 'shortcut'
  | 'meeting-end'
  | 'max-duration'
  | 'track-ended'
  | 'recorder-error'
  | 'host-lost'
  | 'quit';

/** Additive: readers must tolerate new codes. */
export type RecordingErrorCode =
  | 'busy'
  | 'auto-mode-busy'
  | 'quitting'
  | 'cancelled'
  | 'permission-denied'
  | 'no-device'
  | 'microphone'
  | 'init'
  | 'open-failed'
  | 'recorder-start'
  | 'recorder-error'
  | 'host-lost'
  | 'empty'
  | 'save-failed';

export interface RecordingNote {
  offsetMs: number;
  text: string;
}

export type RecordingAutoModeOutcome =
  | { status: 'off' }
  | { status: 'skipped'; message: string }
  | { status: 'started'; jobId: string }
  | { status: 'failed'; message: string };

export interface RecordingResult {
  /** Revision at which this result was produced; identifies it across events. */
  id: number;
  success: boolean;
  title: string;
  stopReason: RecordingStopReason;
  filePath?: string;
  durationMs?: number;
  reason?: 'empty';
  error?: string;
  liveHintsSaveError?: string;
  autoMode: RecordingAutoModeOutcome;
}

export interface RecordingError {
  /** Revision at which the error was raised; identifies it across events. */
  id: number;
  code: RecordingErrorCode;
  message: string;
}

export interface RecordingStateSnapshot {
  version: typeof RECORDING_STATE_VERSION;
  revision: number;
  phase: RecordingPhase;
  title?: string;
  /** Epoch ms when the recording file was opened; the UI timer derives from it. */
  startedAt?: number;
  filePath?: string;
  notes: RecordingNote[];
  /** Set while stopping, so the UI can say why. */
  stopReason?: RecordingStopReason;
  /** System audio was requested but the recording continues with the mic only. */
  systemAudioFallback?: boolean;
  lastResult?: RecordingResult;
  lastError?: RecordingError;
}

export interface RecordingCommandResult {
  success: boolean;
  code?: RecordingErrorCode;
  error?: string;
}

/**
 * Starts live-caption capture on the running recording's processed audio.
 * `realtimeClient` carries the OpenAI Realtime client secret main obtained;
 * it goes to the hidden host only, never to the visible window.
 */
export interface LiveCaptureStartCommand {
  type: 'live-start';
  liveSessionId: string;
  mode: 'streaming' | 'chunked';
  translate: boolean;
  /** Epoch ms the live session started; caption offsets are relative to it. */
  startedAtMs: number;
  realtimeClient?: {
    transport: 'webrtc';
    endpoint: 'realtime' | 'translation';
    clientSecret: string;
  };
}

/** Main -> capture host commands. */
export type CaptureHostCommand =
  | { type: 'start'; sessionId: number; deviceId: string; recordSystemAudio: boolean }
  | { type: 'stop'; sessionId: number }
  | { type: 'switch-mic'; sessionId: number; deviceId: string }
  | LiveCaptureStartCommand
  /** Flush the live tail (WebRTC commit, last chunked window), then report `live-stopped`. */
  | { type: 'live-stop'; liveSessionId: string }
  | { type: 'live-translate'; liveSessionId: string; translate: boolean };

/** Capture host -> main events. */
export type CaptureHostEvent =
  | { type: 'started'; sessionId: number }
  | { type: 'stopped'; sessionId: number }
  | { type: 'error'; sessionId: number; code: RecordingErrorCode; message: string }
  | { type: 'track-ended'; sessionId: number }
  | { type: 'system-audio-fallback'; sessionId: number }
  | { type: 'mic-fallback'; sessionId: number }
  | { type: 'mic-switched'; sessionId: number; success: boolean };

/** Capture host -> main live-caption events. */
export type CaptureHostLiveEvent =
  /** Capture for this live session is released and its last uploads settled. */
  | { type: 'live-stopped'; liveSessionId: string }
  /** A transport problem the session survives (shown as a live error). */
  | { type: 'live-error'; liveSessionId: string; error: string }
  /** Capture cannot continue (realtime failed and no fallback); main ends the session. */
  | { type: 'live-failed'; liveSessionId: string; error: string };

export const RECORDING_NOTE_MAX_TEXT = 2000;
export const RECORDING_NOTE_MAX_COUNT = 500;
