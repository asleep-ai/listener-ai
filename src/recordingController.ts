// Single authority for recording state in the main process.
//
// Capture runs in a hidden capture host renderer (src/captureHost.ts). The
// controller commands it, owns the recording file through the recorder, and
// finalizes the file itself, so a reload or loss of the visible window never
// ends or orphans a recording. Every stop -- the UI button, tray, shortcut,
// meeting end, max duration, quit -- goes through requestStop, which asks the
// host to flush and force-finalizes after a grace period when it does not.
// After a finalize the controller decides and starts auto mode.
//
// Dependencies are injected so the state machine runs under `node --test`.

import type { StopResult } from './simpleAudioRecorder';
import {
  RECORDING_NOTE_MAX_COUNT,
  RECORDING_NOTE_MAX_TEXT,
  RECORDING_STATE_VERSION,
  type CaptureHostEvent,
  type RecordingAutoModeOutcome,
  type RecordingCommandResult,
  type RecordingErrorCode,
  type RecordingNote,
  type RecordingResult,
  type RecordingStateSnapshot,
  type RecordingStopReason,
} from './recordingState';

export const DEFAULT_STOP_GRACE_MS = 10_000;

export interface CaptureHostPort {
  /** Create/load the host when needed, then send it the start command. */
  start(command: {
    sessionId: number;
    deviceId: string;
    recordSystemAudio: boolean;
  }): Promise<void>;
  /** Ask the host to flush MediaRecorder and release capture. */
  stop(sessionId: number): void;
  switchMic(sessionId: number, deviceId: string): void;
  /**
   * Destroy the host when it may still hold capture (forced finalize, start
   * cancelled or failed outside the host). A host that reported its own
   * cleanup stays loaded for the next recording. Safe to call repeatedly.
   */
  dispose(): void;
}

export interface RecordingRecorderPort {
  startRecording(
    title: string,
    mimeType: string,
  ): Promise<{ success: boolean; filePath?: string; error?: string }>;
  getActiveRecording(): { filePath: string; startedAtMs: number } | null;
  abortRecording(): Promise<void>;
}

export interface AutoModePort {
  enabled(): boolean;
  minSeconds(): number;
  /** Null when both credential gates pass; otherwise the skip message. */
  credentialIssue(): string | null;
  /** Admits the auto job and resolves with its id once admitted. */
  start(input: { filePath: string; title: string; notes: RecordingNote[] }): Promise<string>;
  /** True while an auto-mode job runs; a new recording waits for it. */
  isRunning(): boolean;
}

export interface RecordingControllerDeps {
  host: CaptureHostPort;
  recorder: RecordingRecorderPort;
  /**
   * Closes the file and saves live hints; `liveDrain` waits for late live
   * finals. `onClosed` runs right after the audio closes, before that drain,
   * so state that must survive a bounded quit is persisted first.
   */
  finalizeFile(
    liveDrain?: Promise<unknown>,
    onClosed?: (filePath: string) => Promise<void>,
  ): Promise<StopResult>;
  /** Post-finalize file work (header remux). Errors are swallowed by the caller. */
  afterFinalize?(filePath: string): Promise<void>;
  saveNotes(filePath: string, notes: RecordingNote[]): Promise<void>;
  captureSettings(): { deviceId: string; recordSystemAudio: boolean };
  autoMode: AutoModePort;
  isQuitting(): boolean;
  /** Ends a live-caption session riding this recording; resolves when drained. */
  beginLiveDrain?(): Promise<unknown> | undefined;
  onSessionStarted?(info: { title: string; filePath: string }): void;
  onSessionEnded?(result: RecordingResult): void;
  emit(snapshot: RecordingStateSnapshot): void;
  reportError?(error: unknown, operation: string): void;
  now?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export interface StopOptions {
  graceMs?: number;
  /** False skips auto mode (quit). */
  autoMode?: boolean;
}

type OpenResult = { success: boolean; filePath?: string; error?: string };

type Session = {
  id: number;
  title: string;
  filePath?: string;
  startedAt?: number;
  notes: RecordingNote[];
  stopReason?: RecordingStopReason;
  stopAutoMode: boolean;
  liveDrain?: Promise<unknown>;
  graceTimer?: unknown;
  resolveStart?: (result: RecordingCommandResult) => void;
  startPromise?: Promise<RecordingCommandResult>;
  /** A failed start is cleaning up (host disposed, file being aborted). */
  failing?: boolean;
  /** The output file open requested by the host, while it is pending. */
  opening?: Promise<OpenResult>;
  stopPromise?: Promise<RecordingResult>;
  resolveStop?: (result: RecordingResult) => void;
  finalizing?: Promise<RecordingResult>;
  pendingError?: { code: RecordingErrorCode; message: string };
  micSwitch?: (ok: boolean) => void;
  systemAudioFallback?: boolean;
  /** The host reported it released capture ('stopped' or a host 'error'). */
  hostReleased?: boolean;
};

const START_ERROR_MESSAGES: Partial<Record<RecordingErrorCode, string>> = {
  busy: 'Recording already in progress',
  'auto-mode-busy':
    'Please wait for auto mode processing to complete before starting a new recording.',
  quitting: 'Listener.AI is quitting.',
  cancelled: 'Recording start was cancelled.',
  'host-lost': 'The recording process stopped unexpectedly.',
};

export function decideAutoModeSkip(input: {
  enabled: boolean;
  quitting: boolean;
  allowed: boolean;
  success: boolean;
  filePath?: string;
  durationMs?: number;
  minSeconds: number;
  credentialIssue: string | null;
}): RecordingAutoModeOutcome | 'start' {
  if (!input.enabled || input.quitting || !input.allowed) return { status: 'off' };
  if (!input.success || !input.filePath) return { status: 'off' };
  const min = input.minSeconds;
  if (min > 0 && typeof input.durationMs === 'number' && input.durationMs < min * 1000) {
    const actual = Math.floor(input.durationMs / 1000);
    return { status: 'skipped', message: `Auto mode: Skipped (${actual}s < ${min}s minimum)` };
  }
  if (input.credentialIssue) return { status: 'skipped', message: input.credentialIssue };
  return 'start';
}

export class RecordingController {
  private readonly deps: RecordingControllerDeps;
  private revision = 0;
  private nextSessionId = 0;
  private session: Session | null = null;
  private phase: RecordingStateSnapshot['phase'] = 'idle';
  private lastResult?: RecordingResult;
  private lastError?: RecordingStateSnapshot['lastError'];

  constructor(deps: RecordingControllerDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  snapshot(): RecordingStateSnapshot {
    const s = this.session;
    return {
      version: RECORDING_STATE_VERSION,
      revision: this.revision,
      phase: this.phase,
      ...(s ? { title: s.title } : {}),
      ...(s?.startedAt !== undefined ? { startedAt: s.startedAt } : {}),
      ...(s?.filePath ? { filePath: s.filePath } : {}),
      notes: s ? s.notes.map((n) => ({ ...n })) : [],
      ...(s?.stopReason && this.phase === 'stopping' ? { stopReason: s.stopReason } : {}),
      ...(s?.systemAudioFallback ? { systemAudioFallback: true } : {}),
      ...(this.lastResult ? { lastResult: { ...this.lastResult } } : {}),
      ...(this.lastError ? { lastError: { ...this.lastError } } : {}),
    };
  }

  isIdle(): boolean {
    return this.phase === 'idle';
  }

  /** The active session id, or null. Used to validate host messages. */
  activeSessionId(): number | null {
    return this.session?.id ?? null;
  }

  private changed(): void {
    this.revision += 1;
    try {
      this.deps.emit(this.snapshot());
    } catch (error) {
      this.deps.reportError?.(error, 'recording.state-emit');
    }
  }

  private setError(code: RecordingErrorCode, message: string): void {
    this.lastError = { id: this.revision + 1, code, message };
  }

  requestStart(input: { title?: string } = {}): Promise<RecordingCommandResult> {
    if (this.session?.startPromise && this.phase === 'starting') return this.session.startPromise;
    const refuse = (code: RecordingErrorCode): Promise<RecordingCommandResult> =>
      Promise.resolve({ success: false, code, error: START_ERROR_MESSAGES[code] });
    if (this.phase !== 'idle') return refuse('busy');
    if (this.deps.isQuitting()) return refuse('quitting');
    if (this.deps.autoMode.isRunning()) return refuse('auto-mode-busy');

    const title = (input.title ?? '').trim() || 'Untitled_Meeting';
    const session: Session = {
      id: ++this.nextSessionId,
      title,
      notes: [],
      stopAutoMode: true,
    };
    session.startPromise = new Promise((resolve) => {
      session.resolveStart = resolve;
    });
    this.session = session;
    this.phase = 'starting';
    this.lastError = undefined;
    this.changed();

    const settings = this.deps.captureSettings();
    this.deps.host
      .start({
        sessionId: session.id,
        deviceId: settings.deviceId,
        recordSystemAudio: settings.recordSystemAudio,
      })
      .catch((error) => {
        this.deps.reportError?.(error, 'recording.host-start');
        void this.failStart(
          session.id,
          'init',
          `Failed to initialize recorder: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    return session.startPromise;
  }

  /** The host built its graph and asks main to open the output file. */
  async hostOpen(sessionId: number, mimeType: string): Promise<RecordingCommandResult> {
    const s = this.session;
    if (!s || s.id !== sessionId || this.phase !== 'starting' || s.filePath || s.failing) {
      return { success: false, code: 'cancelled', error: START_ERROR_MESSAGES.cancelled };
    }
    // One open per start. A duplicate request while one is pending is refused
    // without touching the owned open, which a failing start waits for and
    // whose file it aborts; replacing it would leak that file.
    if (s.opening) {
      return { success: false, code: 'busy', error: 'The recording file is already opening.' };
    }
    // Kept on the session so a start that fails while the file is opening
    // waits for this open (and aborts its file) before giving up its slot.
    const opening: Promise<OpenResult> = this.deps.recorder
      .startRecording(s.title, mimeType || 'audio/webm')
      .catch((error: unknown) => ({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    s.opening = opening;
    const opened = await opening;
    if (s.failing || this.session !== s || this.phase !== 'starting') {
      // Cancelled while the file was opening. A failing start's cleanup waits
      // for this open and aborts the file itself, before any new start can
      // open its own; aborting here could hit that new recording.
      if (opened.success && !s.failing) await this.deps.recorder.abortRecording().catch(() => {});
      return { success: false, code: 'cancelled', error: START_ERROR_MESSAGES.cancelled };
    }
    if (!opened.success || !opened.filePath) {
      const message = `Failed to start recording: ${opened.error || 'Unknown error'}`;
      void this.failStart(sessionId, 'open-failed', message);
      return { success: false, code: 'open-failed', error: message };
    }
    s.filePath = opened.filePath;
    s.startedAt = this.now();
    return { success: true };
  }

  hostEvent(event: CaptureHostEvent): void {
    const s = this.session;
    if (!s || s.id !== event.sessionId) return;
    switch (event.type) {
      case 'started': {
        if (this.phase !== 'starting' || !s.filePath || s.failing) return;
        this.phase = 'recording';
        this.deps.onSessionStarted?.({ title: s.title, filePath: s.filePath });
        this.changed();
        s.resolveStart?.({ success: true });
        s.resolveStart = undefined;
        return;
      }
      case 'stopped':
        s.hostReleased = true;
        if (this.phase === 'stopping') void this.finalize(s);
        return;
      case 'error': {
        // The host tears its capture down before reporting an error.
        s.hostReleased = true;
        if (this.phase === 'starting') {
          void this.failStart(s.id, event.code, event.message);
          return;
        }
        // Capture died mid-recording: keep what was written, like the old
        // MediaRecorder onerror path (stop-recording, then alert).
        s.pendingError = { code: event.code, message: event.message };
        if (this.phase === 'recording') {
          s.stopReason = 'recorder-error';
          this.phase = 'stopping';
          s.liveDrain = this.deps.beginLiveDrain?.();
          s.stopPromise = this.newStopPromise(s);
        }
        void this.finalize(s);
        return;
      }
      case 'track-ended':
        if (this.phase === 'recording') void this.requestStop('track-ended');
        return;
      case 'system-audio-fallback':
        s.systemAudioFallback = true;
        this.changed();
        return;
      case 'mic-switched':
        s.micSwitch?.(event.success);
        s.micSwitch = undefined;
        return;
      default:
        return;
    }
  }

  private newStopPromise(s: Session): Promise<RecordingResult> {
    return new Promise<RecordingResult>((resolve) => {
      s.resolveStop = resolve;
    });
  }

  private async failStart(
    sessionId: number,
    code: RecordingErrorCode,
    message: string,
  ): Promise<void> {
    const s = this.session;
    if (!s || s.id !== sessionId || this.phase !== 'starting' || s.failing) return;
    // The session (and phase 'starting') stays until cleanup completes, so a
    // start requested meanwhile joins this failing one instead of opening a
    // new host or file that this cleanup would then dispose or abort. The host
    // is disposed first, synchronously, while it is still this session's.
    s.failing = true;
    if (!s.hostReleased) this.deps.host.dispose();
    // An open still in flight finishes first; whatever it opened is aborted
    // here, while this start still owns the recorder.
    const opened = s.opening ? await s.opening : undefined;
    if (s.filePath || opened?.success) await this.deps.recorder.abortRecording().catch(() => {});
    this.session = null;
    this.phase = 'idle';
    this.setError(code, message);
    this.changed();
    s.resolveStart?.({ success: false, code, error: message });
    s.resolveStart = undefined;
  }

  requestStop(
    reason: RecordingStopReason = 'user',
    opts: StopOptions = {},
  ): Promise<RecordingResult | null> {
    const s = this.session;
    if (!s) return Promise.resolve(null);
    if (this.phase === 'starting') {
      void this.failStart(s.id, 'cancelled', START_ERROR_MESSAGES.cancelled!);
      return Promise.resolve(null);
    }
    if (opts.autoMode === false) s.stopAutoMode = false;
    if (this.phase === 'stopping' && s.stopPromise) return s.stopPromise;
    s.stopReason = reason;
    this.phase = 'stopping';
    s.stopPromise = this.newStopPromise(s);
    s.liveDrain = this.deps.beginLiveDrain?.();
    this.changed();
    const graceMs = opts.graceMs ?? DEFAULT_STOP_GRACE_MS;
    const setTimer = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    s.graceTimer = setTimer(() => {
      s.graceTimer = undefined;
      if (this.session === s && !s.finalizing) {
        console.warn('Capture host did not finish stopping; finalizing the partial file');
        void this.finalize(s);
      }
    }, graceMs);
    try {
      this.deps.host.stop(s.id);
    } catch (error) {
      this.deps.reportError?.(error, 'recording.host-stop');
      void this.finalize(s);
    }
    return s.stopPromise;
  }

  /** The host renderer crashed or its window was destroyed. */
  hostLost(
    detail = 'The recording process stopped unexpectedly.',
  ): Promise<RecordingResult | null> {
    const s = this.session;
    if (!s) return Promise.resolve(null);
    if (this.phase === 'starting') {
      void this.failStart(s.id, 'host-lost', detail);
      return Promise.resolve(null);
    }
    if (this.phase === 'recording') {
      s.stopReason = 'host-lost';
      s.pendingError = { code: 'host-lost', message: detail };
      this.phase = 'stopping';
      s.stopPromise = this.newStopPromise(s);
      s.liveDrain = this.deps.beginLiveDrain?.();
      this.changed();
    }
    void this.finalize(s);
    return s.stopPromise ?? Promise.resolve(null);
  }

  addNote(input: { text?: unknown; offsetMs?: unknown }): RecordingCommandResult {
    const s = this.session;
    if (!s || this.phase !== 'recording' || s.startedAt === undefined) {
      return { success: false, error: 'Not recording' };
    }
    if (s.notes.length >= RECORDING_NOTE_MAX_COUNT)
      return { success: false, error: 'Too many notes' };
    const elapsed = Math.max(0, this.now() - s.startedAt);
    const requested = Number(input.offsetMs);
    const offsetMs =
      Number.isFinite(requested) && requested >= 0
        ? Math.min(Math.floor(requested), elapsed)
        : elapsed;
    const text =
      typeof input.text === 'string' ? input.text.trim().slice(0, RECORDING_NOTE_MAX_TEXT) : '';
    s.notes.push({ offsetMs, text });
    this.changed();
    return { success: true };
  }

  switchMic(deviceId: string): Promise<boolean> {
    const s = this.session;
    if (!s || this.phase !== 'recording') return Promise.resolve(false);
    s.micSwitch?.(false);
    return new Promise<boolean>((resolve) => {
      s.micSwitch = resolve;
      try {
        this.deps.host.switchMic(s.id, deviceId);
      } catch {
        s.micSwitch = undefined;
        resolve(false);
      }
    });
  }

  private finalize(s: Session): Promise<RecordingResult> {
    if (s.finalizing) return s.finalizing;
    s.finalizing = this.runFinalize(s);
    return s.finalizing;
  }

  private async runFinalize(s: Session): Promise<RecordingResult> {
    if (s.graceTimer !== undefined) {
      (this.deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(
        s.graceTimer,
      );
      s.graceTimer = undefined;
    }
    const stopReason = s.stopReason ?? 'user';
    let stop: StopResult;
    // Notes are the user's own words: saved as soon as the audio closes, not
    // after a live-caption drain that a bounded quit may cut short.
    const saveNotes = async (filePath: string) => {
      if (s.notes.length === 0) return;
      try {
        await this.deps.saveNotes(filePath, s.notes);
      } catch (error) {
        this.deps.reportError?.(error, 'recording.saveLiveNotes');
      }
    };
    try {
      stop = await this.deps.finalizeFile(s.liveDrain, saveNotes);
    } catch (error) {
      this.deps.reportError?.(error, 'recording.finalize');
      stop = { success: false, error: error instanceof Error ? error.message : String(error) };
    }
    // A host that did not confirm its cleanup may still hold the mic or
    // system audio: destroy it. The next recording loads a fresh one.
    if (!s.hostReleased) this.deps.host.dispose();

    if (stop.success && stop.filePath) {
      try {
        await this.deps.afterFinalize?.(stop.filePath);
      } catch (error) {
        this.deps.reportError?.(error, 'recording.after-finalize');
      }
    }

    const decision = decideAutoModeSkip({
      enabled: this.deps.autoMode.enabled(),
      quitting: this.deps.isQuitting(),
      allowed: s.stopAutoMode && stopReason !== 'quit',
      success: stop.success,
      filePath: stop.filePath,
      durationMs: stop.durationMs,
      minSeconds: this.deps.autoMode.minSeconds(),
      credentialIssue: stop.success && stop.filePath ? this.deps.autoMode.credentialIssue() : null,
    });
    let autoMode: RecordingAutoModeOutcome;
    if (decision === 'start') {
      try {
        const jobId = await this.deps.autoMode.start({
          filePath: stop.filePath!,
          title: s.title,
          notes: s.notes.map((n) => ({ ...n })),
        });
        autoMode = { status: 'started', jobId };
      } catch (error) {
        this.deps.reportError?.(error, 'recording.auto-mode');
        autoMode = {
          status: 'failed',
          message: `Auto mode: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    } else {
      autoMode = decision;
    }

    const result: RecordingResult = {
      id: this.revision + 1,
      success: stop.success,
      title: s.title,
      stopReason,
      ...(stop.filePath ? { filePath: stop.filePath } : {}),
      ...(typeof stop.durationMs === 'number' ? { durationMs: stop.durationMs } : {}),
      ...(stop.reason ? { reason: stop.reason } : {}),
      ...(stop.error ? { error: stop.error } : {}),
      ...(stop.liveHintsSaveError ? { liveHintsSaveError: stop.liveHintsSaveError } : {}),
      autoMode,
    };
    if (this.session === s) {
      this.session = null;
      this.phase = 'idle';
    }
    this.lastResult = result;
    if (s.pendingError) this.setError(s.pendingError.code, s.pendingError.message);
    else if (!stop.success && stop.reason === 'empty') this.setError('empty', 'No audio captured.');
    else if (!stop.success)
      this.setError('save-failed', `Failed to save recording: ${stop.error || 'Unknown error'}`);
    s.micSwitch?.(false);
    try {
      this.deps.onSessionEnded?.(result);
    } catch (error) {
      this.deps.reportError?.(error, 'recording.session-ended');
    }
    this.changed();
    s.resolveStop?.(result);
    return result;
  }
}
