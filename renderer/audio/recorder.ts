// Recording session orchestration: start/stop, MediaRecorder wiring, timer,
// auto-mode post-processing. Owns the click handler on the record button.

import { autoModeSkipMessage } from '../../src/aiProvider';
import { getDom, state } from '../state';
import { hideLiveNotesPanel, showLiveNotesPanel } from '../ui/live-notes';
import {
  clearLiveSessionLauncher,
  configureLiveSessionLauncher,
  handleLivePcmFrame,
  stopLiveSessionCapture,
} from '../ui/live-session';
import { showNotification, showToast } from '../ui/notifications';
import { refreshRecordingsList } from '../ui/recordings-list';
import { onTranscriptionJobChange } from '../ui/transcription-jobs';
import { describeAutoExports, isActiveJob } from '../../src/transcriptionJobView';
import type { TranscriptionJobSnapshot } from '../electronAPI';
import { reportError } from '../sentry';
import { buildProcessedStream, cleanupAudioState, pickRecordingMimeType } from './graph';
import { acquireMediaStream, attachTrackEndedHandlers } from './mic';
import { createSystemAudioSource } from './system-audio';

let stopRecordingInProgress = false;
// ondataavailable fires ~once/sec; latch so a stuck chunk-forward failure
// reports once per recording session instead of flooding Sentry.
let reportedChunkForward = false;

export async function startRecording(): Promise<void> {
  const { recordButton, statusIndicator, statusText, recordingTime, meetingTitle } = getDom();

  if (state.isAutoModeProcessing) {
    alert('Please wait for auto mode processing to complete before starting a new recording.');
    return;
  }

  const title = meetingTitle.value.trim() || 'Untitled_Meeting';

  // Acquire the mic before telling main, so permission prompts don't leave main state dangling.
  let preferredDeviceId = '';
  try {
    const cfg = await window.electronAPI.getConfig();
    preferredDeviceId = typeof cfg.audioDeviceId === 'string' ? cfg.audioDeviceId : '';
  } catch (error) {
    console.warn('Could not read audioDeviceId from config:', error);
  }
  try {
    state.mediaStream = await acquireMediaStream(preferredDeviceId);
  } catch (error) {
    const name = error instanceof Error && error.name ? error.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      reportError(error, { operation: 'recording.start.permission-denied', severity: 'warning' });
      if (
        confirm(
          'Microphone access is required to record audio.\n\nOpen System Settings to grant permission?',
        )
      ) {
        await window.electronAPI.openMicrophoneSettings();
      }
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      reportError(error, { operation: 'recording.start.no-device', severity: 'warning' });
      if (confirm('No microphone was detected.\n\nOpen System Settings to check input devices?')) {
        await window.electronAPI.openMicrophoneSettings();
      }
    } else {
      reportError(error, { operation: 'recording.start.getusermedia', severity: 'error' });
      alert(
        `Failed to access microphone: ${error instanceof Error && error.message ? error.message : String(error)}`,
      );
    }
    return;
  }

  state.recordingMimeType = pickRecordingMimeType();

  // Permission was validated at toggle time; start the system-audio source now so
  // PCM chunks start flowing (audiotee on macOS, getDisplayMedia on Win/Linux).
  const recordSystemAudioToggle = document.getElementById(
    'recordSystemAudioToggle',
  ) as HTMLInputElement | null;
  const useSystemAudio = !!recordSystemAudioToggle?.checked;

  // Open the output stream in main BEFORE starting MediaRecorder so the first chunk
  // has a file handle waiting for it. Build the Web Audio graph up front (without
  // calling start) — if construction fails we haven't touched main state yet.
  let graph: Awaited<ReturnType<typeof buildProcessedStream>>;
  try {
    const addSystemAudio = useSystemAudio
      ? async (ctx: AudioContext) => {
          const { node, cleanup } = await createSystemAudioSource(ctx);
          state.systemAudioCleanup = cleanup;
          if (!node) {
            showNotification('System audio capture failed -- recording mic only.', 'error');
          }
          return node;
        }
      : null;
    graph = await buildProcessedStream(state.mediaStream, addSystemAudio, handleLivePcmFrame);
    state.audioContext = graph.ctx;
    state.processedStream = graph.stream;
    state.sourceNode = graph.source;
    state.graphHead = graph.head;
    attachTrackEndedHandlers(state.mediaStream);
    state.mediaRecorder = state.recordingMimeType
      ? new MediaRecorder(state.processedStream, {
          mimeType: state.recordingMimeType,
          audioBitsPerSecond: 64000,
        })
      : new MediaRecorder(state.processedStream, { audioBitsPerSecond: 64000 });
  } catch (error) {
    cleanupAudioState();
    reportError(error, { operation: 'recording.start.init', severity: 'error' });
    alert(
      `Failed to initialize recorder: ${error instanceof Error && error.message ? error.message : String(error)}`,
    );
    return;
  }

  try {
    const result = await window.electronAPI.startRecording({
      title,
      mimeType: state.mediaRecorder.mimeType || state.recordingMimeType || 'audio/webm',
    });
    if (!result.success) {
      cleanupAudioState();
      alert(`Failed to start recording: ${result.error || 'Unknown error'}`);
      return;
    }
  } catch (error) {
    cleanupAudioState();
    alert(`Failed to start recording: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  state.chunkSendChain = Promise.resolve();
  reportedChunkForward = false;
  state.mediaRecorder.ondataavailable = (event) => {
    if (!event.data || event.data.size === 0) return;
    const blob = event.data;
    state.chunkSendChain = state.chunkSendChain.then(async () => {
      try {
        const buf = await blob.arrayBuffer();
        window.electronAPI.sendRecordingChunk(buf);
      } catch (err) {
        console.error('Failed to forward recording chunk:', err);
        if (!reportedChunkForward) {
          reportedChunkForward = true;
          reportError(err, { operation: 'recording.chunk-forward', severity: 'warning' });
        }
      }
    });
  };
  state.mediaRecorder.onerror = (event: Event) => {
    const err = (event as unknown as { error?: unknown }).error ?? event;
    console.error('MediaRecorder error:', err);
    reportError(err, { operation: 'recording.mediarecorder-error', severity: 'error' });
    void stopLiveSessionCapture();
    cleanupAudioState();
    resetRecordingUI();
    window.electronAPI.stopRecording().catch(() => {});
    const message = err instanceof Error && err.message ? err.message : 'Unknown error';
    alert(`Recording failed: ${message}`);
  };

  try {
    state.mediaRecorder.start(1000);
  } catch (error) {
    await window.electronAPI.abortRecording().catch(() => {});
    cleanupAudioState();
    reportError(error, { operation: 'recording.start.recorder-start', severity: 'error' });
    alert(
      `Failed to start recorder: ${error instanceof Error && error.message ? error.message : String(error)}`,
    );
    return;
  }
  state.isRecording = true;
  state.recordingStartTime = Date.now();
  configureLiveSessionLauncher(
    title,
    state.processedStream,
    state.mediaRecorder.mimeType || state.recordingMimeType || 'audio/webm',
  );

  recordButton.textContent = 'Stop Recording';
  recordButton.classList.add('recording');
  statusIndicator.classList.add('recording');
  statusText.textContent = 'Recording...';
  recordingTime.classList.add('active');
  showLiveNotesPanel();

  startTimer();
}

export function resetRecordingUI(): void {
  const { recordButton, statusIndicator, statusText, recordingTime } = getDom();
  state.isRecording = false;
  stopTimer();
  recordButton.textContent = 'Start Recording';
  recordButton.classList.remove('recording');
  statusIndicator.classList.remove('recording');
  statusText.textContent = 'Ready to record';
  recordingTime.classList.remove('active');
  hideLiveNotesPanel();
  clearLiveSessionLauncher();
}

// True while this renderer awaits its own auto-mode transcription. An auto job
// seen only through job state (this window reloaded mid-run) is followed by
// `followAutoJob` instead.
let localAutoRunInFlight = false;
let followedAutoJobId: string | null = null;

function setAutoModeProcessing(processing: boolean): void {
  const { recordButton } = getDom();
  state.isAutoModeProcessing = processing;
  recordButton.disabled = processing;
  recordButton.style.opacity = processing ? '0.5' : '';
  recordButton.style.cursor = processing ? 'not-allowed' : '';
}

function scheduleReadyStatus(): void {
  const { statusText } = getDom();
  setTimeout(() => {
    statusText.textContent = 'Ready to record';
  }, 5000);
}

function autoJobOutcome(job: Pick<TranscriptionJobSnapshot, 'status' | 'exports'>): string {
  if (job.status === 'succeeded') return describeAutoExports(job.exports);
  if (job.status === 'cancelled') return 'Auto mode: Transcription cancelled';
  return 'Auto mode: Transcription failed';
}

// Auto mode's transcription and Notion/Slack follow-ups run as one main-owned
// job. After a reload this restores the processing state and reports the
// outcome when the job ends.
function followAutoJob(job: TranscriptionJobSnapshot): void {
  if (job.kind !== 'transcribe' || job.origin !== 'auto' || localAutoRunInFlight) return;
  const { statusText } = getDom();
  if (isActiveJob(job)) {
    if (followedAutoJobId && followedAutoJobId !== job.id) return;
    followedAutoJobId = job.id;
    setAutoModeProcessing(true);
    statusText.textContent =
      job.phase === 'exporting'
        ? 'Auto mode: Sending to Notion/Slack...'
        : 'Auto mode: Processing recording...';
    return;
  }
  if (followedAutoJobId !== job.id) return;
  followedAutoJobId = null;
  statusText.textContent = autoJobOutcome(job);
  setAutoModeProcessing(false);
  scheduleReadyStatus();
}

export async function processAutoMode(
  audioPath: string | undefined,
  recordingTitle: string,
  durationMs: number | undefined,
  liveNotes?: Array<{ offsetMs: number; text: string }>,
): Promise<void> {
  const { autoModeToggle, statusText } = getDom();
  if (!autoModeToggle.checked || !audioPath) return;

  const config = await window.electronAPI.getConfig();
  const minSeconds = Number(config.minRecordingSeconds) || 0;
  if (minSeconds > 0 && typeof durationMs === 'number' && durationMs < minSeconds * 1000) {
    const actualSeconds = Math.floor(durationMs / 1000);
    const message = `Auto mode: Skipped (${actualSeconds}s < ${minSeconds}s minimum)`;
    console.log(message);
    statusText.textContent = message;
    setTimeout(() => {
      if (!state.isRecording && statusText.textContent === message) {
        statusText.textContent = 'Ready to record';
      }
    }, 5000);
    return;
  }

  // Pre-flight both credential gates. Auto mode runs unattended right after a
  // recording stops, so a backend with no key would otherwise surface as a
  // generic "Transcription failed" only after the upload/ffmpeg work, with
  // nothing on screen naming the setting that has to change.
  const configCheck = await window.electronAPI.checkConfig();
  if (!configCheck.hasAiAuth || !configCheck.hasTranscriptionAuth) {
    const message = autoModeSkipMessage(configCheck);
    console.warn(message);
    statusText.textContent = message;
    showNotification(message, 'error');
    setTimeout(() => {
      if (!state.isRecording && statusText.textContent === message) {
        statusText.textContent = 'Ready to record';
      }
    }, 8000);
    return;
  }

  localAutoRunInFlight = true;
  setAutoModeProcessing(true);
  statusText.textContent = 'Auto mode: Processing recording...';

  try {
    console.log('Auto mode: Starting transcription...');
    // Main runs the configured Notion upload and Slack send as part of this
    // job (and opens the Notion page), so they still happen if this window
    // reloads before the job ends.
    const transcriptionResult = await window.electronAPI.transcribeAudio(audioPath, liveNotes, {
      autoExport: true,
      recordingTitle,
    });

    if (transcriptionResult.success) {
      console.log('Auto mode: Transcription complete');
      if (transcriptionResult.newFilePath) {
        console.log('Auto mode: File renamed to:', transcriptionResult.newFilePath);
      }
      if (transcriptionResult.exports?.notion?.status === 'failed') {
        console.error('Auto mode: Notion upload failed:', transcriptionResult.exports.notion.error);
      }
      if (transcriptionResult.exports?.slack?.status === 'failed') {
        console.error('Auto mode: Slack send failed:', transcriptionResult.exports.slack.error);
      }
      statusText.textContent = describeAutoExports(transcriptionResult.exports);

      await refreshRecordingsList();
    } else {
      statusText.textContent = autoJobOutcome({
        status: transcriptionResult.cancelled ? 'cancelled' : 'failed',
      });
      console.error('Auto mode: Transcription failed:', transcriptionResult.error);
    }
  } catch (error) {
    statusText.textContent = 'Auto mode: Error processing recording';
    console.error('Auto mode error:', error);
    if (error instanceof Error) {
      console.error('Error details:', error.message, error.stack);
    }
    reportError(error, { operation: 'recording.auto-mode', severity: 'error' });
  } finally {
    localAutoRunInFlight = false;
    setAutoModeProcessing(false);
  }

  scheduleReadyStatus();
}

export async function handleRecordingStopped(
  audioPath: string | undefined,
  durationMs: number | undefined,
  liveNotes?: Array<{ offsetMs: number; text: string }>,
): Promise<void> {
  const { meetingTitle } = getDom();
  resetRecordingUI();
  const recordingTitle = meetingTitle.value.trim() || 'Untitled_Meeting';
  meetingTitle.value = '';
  await refreshRecordingsList();
  await processAutoMode(audioPath, recordingTitle, durationMs, liveNotes);
}

export async function stopRecording(): Promise<void> {
  if (stopRecordingInProgress) return;
  stopRecordingInProgress = true;
  const { recordButton } = getDom();
  recordButton.disabled = true;

  try {
    // Snapshot live notes before they get cleared by the UI reset. Passed to
    // main so they're persisted alongside the audio file regardless of whether
    // auto-mode kicks off transcription right away, and forwarded into the
    // auto-mode path so transcribe-audio gets them without re-reading state.
    const liveNotesSnapshot = state.liveNotes.length > 0 ? state.liveNotes.slice() : undefined;
    const liveNotesPayload = liveNotesSnapshot ? { liveNotes: liveNotesSnapshot } : undefined;

    // If the recorder already transitioned to inactive on its own (e.g. USB mic
    // unplugged, stream ended, Chromium force-stopped encoding), still unwind the
    // session so the next recording isn't blocked by stuck state.
    if (!state.mediaRecorder || state.mediaRecorder.state === 'inactive') {
      await stopLiveSessionCapture({ hidePanel: true });
      cleanupAudioState();
      try {
        const result = await window.electronAPI.stopRecording(liveNotesPayload);
        if (result?.success) {
          await handleRecordingStopped(result.filePath, result.durationMs, liveNotesSnapshot);
          return;
        }
      } catch (error) {
        reportError(error, { operation: 'recording.stop.finalize-inactive', severity: 'error' });
        // fall through to UI reset
      }
      resetRecordingUI();
      return;
    }

    try {
      // MediaRecorder.stop() flushes the final chunk via ondataavailable before
      // firing onstop. We then await chunkSendChain so every in-flight arrayBuffer()
      // conversion lands on main's IPC queue before stop-recording invoke — Electron
      // multiplexes all IPC over one Mojo pipe, preserving delivery order.
      const recorder = state.mediaRecorder;
      const stopped = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
      });
      recorder.stop();
      await stopped;
      await state.chunkSendChain;
      await stopLiveSessionCapture({ hidePanel: true });
      cleanupAudioState();

      const result = await window.electronAPI.stopRecording(liveNotesPayload);

      if (result.success) {
        await handleRecordingStopped(result.filePath, result.durationMs, liveNotesSnapshot);
      } else if (result.reason === 'empty') {
        alert('No audio captured.');
        resetRecordingUI();
      } else {
        alert(`Failed to save recording: ${result.error || 'Unknown error'}`);
        resetRecordingUI();
      }
    } catch (error) {
      alert(`Failed to stop recording: ${error instanceof Error ? error.message : String(error)}`);
      cleanupAudioState();
      resetRecordingUI();
    }
  } finally {
    stopRecordingInProgress = false;
    if (!state.isAutoModeProcessing) recordButton.disabled = false;
  }
}

export function startTimer(): void {
  const { recordingTime } = getDom();
  state.timerInterval = setInterval(() => {
    if (state.recordingStartTime == null) return;
    const elapsed = Math.floor((Date.now() - state.recordingStartTime) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    recordingTime.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }, 1000);
}

export function stopTimer(): void {
  const { recordingTime } = getDom();
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
  recordingTime.textContent = '00:00';
}

// Wires up the record-button click + tray IPC handlers + auto-stop notifier.
// Called once from main.ts after initDom().
export function setupRecorder(): void {
  const { recordButton } = getDom();

  onTranscriptionJobChange(({ job }) => followAutoJob(job));

  // Setup record button listener
  recordButton.addEventListener('click', async () => {
    if (!state.isRecording) {
      startRecording();
    } else {
      stopRecording();
    }
  });

  // Setup tray icon event handlers
  window.electronAPI.onTrayStartRecording(() => {
    // Programmatically click the record button if not recording
    if (!state.isRecording) {
      recordButton.click();
    }
  });

  window.electronAPI.onTrayStopRecording(() => {
    // Programmatically click the record button if recording
    if (state.isRecording) {
      recordButton.click();
    }
  });

  // Listen for recording status updates
  window.electronAPI.onRecordingStatus((status) => {
    console.log('Recording status:', status);
  });

  if (window.electronAPI.onRecordingAutoStopped) {
    window.electronAPI.onRecordingAutoStopped(async () => {
      showToast('Recording auto-stopped - reached time limit');
      if (state.isRecording) {
        await stopRecording();
      }
    });
  }
}
