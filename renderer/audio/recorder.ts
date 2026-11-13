// Recording controls for the visible window. Main's RecordingController owns
// recording state and a hidden capture host records the audio, so this module
// only subscribes: it renders the controller snapshot (timer derived from
// `startedAt`), sends start/stop requests, and on load reads the snapshot so
// a reloaded or recreated window reattaches to a running recording.

import type {
  RecordingError,
  RecordingErrorCode,
  RecordingResult,
  RecordingStateSnapshot,
} from '../../src/recordingState';
import { getDom, state } from '../state';
import {
  hideLiveNotesPanel,
  setLiveNotes,
  setLiveNotesAccepting,
  showLiveNotesPanel,
} from '../ui/live-notes';
import {
  clearLiveSessionLauncher,
  configureLiveSessionLauncher,
  stopLiveSessionCapture,
} from '../ui/live-session';
import { showNotification, showToast } from '../ui/notifications';
import { refreshRecordingsList } from '../ui/recordings-list';
import { onTranscriptionJobChange } from '../ui/transcription-jobs';
import { describeAutoExports, isActiveJob } from '../../src/transcriptionJobView';
import type { TranscriptionJobSnapshot } from '../electronAPI';

let appliedRevision = -1;
let snapshot: RecordingStateSnapshot | null = null;
// Errors and results this window has already presented (by id).
let seenErrorId = 0;
let seenResultId = 0;
// A start or stop this window requested presents its own outcome.
let localRequest = false;
let followedAutoJobId: string | null = null;

const AUTO_MODE_WAIT_MESSAGE =
  'Please wait for auto mode processing to complete before starting a new recording.';

function setAutoModeProcessing(processing: boolean): void {
  const { recordButton } = getDom();
  state.isAutoModeProcessing = processing;
  recordButton.style.opacity = processing ? '0.5' : '';
  recordButton.style.cursor = processing ? 'not-allowed' : '';
  updateButtonEnabled();
}

function updateButtonEnabled(): void {
  const { recordButton } = getDom();
  const phase = snapshot?.phase ?? 'idle';
  recordButton.disabled =
    phase === 'starting' ||
    phase === 'stopping' ||
    (phase === 'idle' && state.isAutoModeProcessing);
}

function scheduleReadyStatus(message?: string, ms = 5000): void {
  const { statusText } = getDom();
  setTimeout(() => {
    if (state.isRecording) return;
    if (message === undefined || statusText.textContent === message) {
      statusText.textContent = 'Ready to record';
    }
  }, ms);
}

function autoJobOutcome(job: Pick<TranscriptionJobSnapshot, 'status' | 'exports'>): string {
  if (job.status === 'succeeded') return describeAutoExports(job.exports);
  if (job.status === 'cancelled') return 'Auto mode: Transcription cancelled';
  return 'Auto mode: Transcription failed';
}

// Auto mode's transcription and Notion/Slack follow-ups run as one main-owned
// job that main starts after it finalizes the recording. This restores the
// processing state (also after a reload) and reports the outcome.
function followAutoJob(job: TranscriptionJobSnapshot): void {
  if (job.kind !== 'transcribe' || job.origin !== 'auto') return;
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
  if (job.status === 'succeeded') void refreshRecordingsList();
  scheduleReadyStatus();
}

export function startTimer(): void {
  const { recordingTime } = getDom();
  if (state.timerInterval) clearInterval(state.timerInterval);
  const tick = () => {
    if (state.recordingStartTime == null) return;
    const elapsed = Math.max(0, Math.floor((Date.now() - state.recordingStartTime) / 1000));
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    recordingTime.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };
  tick();
  state.timerInterval = setInterval(tick, 1000);
}

export function stopTimer(): void {
  const { recordingTime } = getDom();
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
  recordingTime.textContent = '00:00';
}

function enterRecordingUi(next: RecordingStateSnapshot): void {
  const { recordButton, statusIndicator, statusText, recordingTime } = getDom();
  state.isRecording = true;
  state.recordingStartTime = next.startedAt ?? Date.now();
  recordButton.textContent = 'Stop Recording';
  recordButton.classList.add('recording');
  statusIndicator.classList.add('recording');
  statusText.textContent = 'Recording...';
  recordingTime.classList.add('active');
  showLiveNotesPanel();
  startTimer();
  // Live captions ride on the recording's audio inside the capture host;
  // this window only offers the launcher.
  configureLiveSessionLauncher(next.title ?? 'Untitled_Meeting');
}

export function resetRecordingUI(): void {
  const { recordButton, statusIndicator, statusText, recordingTime } = getDom();
  state.isRecording = false;
  state.recordingStartTime = null;
  stopTimer();
  recordButton.textContent = 'Start Recording';
  recordButton.classList.remove('recording');
  statusIndicator.classList.remove('recording');
  statusText.textContent = 'Ready to record';
  recordingTime.classList.remove('active');
  hideLiveNotesPanel();
  clearLiveSessionLauncher();
}

async function presentError(code: RecordingErrorCode, message: string): Promise<void> {
  switch (code) {
    case 'busy':
    case 'cancelled':
    case 'quitting':
      return;
    case 'permission-denied':
      if (
        confirm(
          'Microphone access is required to record audio.\n\nOpen System Settings to grant permission?',
        )
      ) {
        await window.electronAPI.openMicrophoneSettings();
      }
      return;
    case 'no-device':
      if (confirm('No microphone was detected.\n\nOpen System Settings to check input devices?')) {
        await window.electronAPI.openMicrophoneSettings();
      }
      return;
    default:
      alert(message);
  }
}

// An error this window did not request (tray, shortcut, meeting trigger, a
// capture failure mid-recording) is presented interactively only while the
// window is visible; otherwise it stays on the status line.
function presentRemoteError(error: RecordingError): void {
  if (error.code === 'busy' || error.code === 'cancelled' || error.code === 'quitting') return;
  const { statusText } = getDom();
  if (document.visibilityState === 'visible') {
    void presentError(error.code, error.message);
    return;
  }
  statusText.textContent = error.message;
  showNotification(error.message, 'error');
  scheduleReadyStatus(error.message, 8000);
}

function presentResult(result: RecordingResult): void {
  const { statusText } = getDom();
  if (result.liveHintsSaveError) showNotification(result.liveHintsSaveError, 'error');
  const auto = result.autoMode;
  if (auto.status === 'skipped') {
    console.log(auto.message);
    statusText.textContent = auto.message;
    // A missing credential names the setting to change; the length floor is quiet.
    const credential = !auto.message.startsWith('Auto mode: Skipped (');
    if (credential) showNotification(auto.message, 'error');
    scheduleReadyStatus(auto.message, credential ? 8000 : 5000);
  } else if (auto.status === 'failed') {
    statusText.textContent = auto.message;
    scheduleReadyStatus(auto.message);
  } else if (auto.status === 'started') {
    if (!followedAutoJobId || followedAutoJobId === auto.jobId) {
      followedAutoJobId = auto.jobId;
      setAutoModeProcessing(true);
      if (statusText.textContent === 'Ready to record')
        statusText.textContent = 'Auto mode: Processing recording...';
    }
  }
}

function applySnapshot(next: RecordingStateSnapshot): void {
  if (next.revision <= appliedRevision) return;
  appliedRevision = next.revision;
  const previous = snapshot;
  snapshot = next;
  const { statusText, meetingTitle } = getDom();

  if ((next.phase === 'recording' || next.phase === 'stopping') && !state.isRecording) {
    enterRecordingUi(next);
  }
  if (state.isRecording) setLiveNotes(next.notes);
  // Notes are taken only while main is recording; from 'stopping' on, main
  // refuses them, so the panel stops offering it at once.
  setLiveNotesAccepting(next.phase === 'recording');
  if (next.phase === 'stopping' && previous?.phase !== 'stopping') {
    statusText.textContent = 'Saving recording...';
    if (next.stopReason === 'track-ended')
      showToast('Mic disconnected — stopping recording', 'error');
    // Main ends live captions with the recording; finish this side's capture.
    void stopLiveSessionCapture({ hidePanel: true });
  }
  if (next.systemAudioFallback && !previous?.systemAudioFallback && next.phase !== 'idle') {
    showNotification('System audio capture failed -- recording mic only.', 'error');
  }
  if (next.phase === 'idle' && state.isRecording) {
    resetRecordingUI();
    meetingTitle.value = '';
    window.electronAPI.setRecordingTitleDraft('');
    void refreshRecordingsList();
  }
  if (next.lastResult && next.lastResult.id > seenResultId) {
    const fresh = seenResultId !== 0 || previous !== null;
    seenResultId = next.lastResult.id;
    if (fresh) presentResult(next.lastResult);
  }
  if (next.lastError && next.lastError.id > seenErrorId) {
    const fresh = seenErrorId !== 0 || previous !== null;
    seenErrorId = next.lastError.id;
    if (fresh && !localRequest) presentRemoteError(next.lastError);
  }
  updateButtonEnabled();
}

export async function startRecording(): Promise<void> {
  if (localRequest || (snapshot && snapshot.phase !== 'idle')) return;
  const { meetingTitle } = getDom();
  if (state.isAutoModeProcessing) {
    alert(AUTO_MODE_WAIT_MESSAGE);
    return;
  }
  localRequest = true;
  try {
    const result = await window.electronAPI.requestRecordingStart({
      title: meetingTitle.value.trim() || 'Untitled_Meeting',
    });
    if (!result.success && result.code) await presentError(result.code, result.error ?? '');
  } catch (error) {
    alert(`Failed to start recording: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    localRequest = false;
  }
}

export async function stopRecording(): Promise<void> {
  if (localRequest || snapshot?.phase !== 'recording') return;
  localRequest = true;
  const { recordButton } = getDom();
  recordButton.disabled = true;
  try {
    // Main stops capture at once; live captions drain their tail in main
    // (late finals still reach the hint history) and this window follows
    // through the 'stopping' snapshot. Awaiting the live drain here first
    // kept recording audio after Stop, and a reload during it lost the stop.
    const { result, error } = await window.electronAPI.requestRecordingStop();
    if (!result) {
      if (error) console.warn('Stop recording:', error);
    } else if (!result.success && result.reason === 'empty') {
      alert('No audio captured.');
    } else if (!result.success && result.stopReason === 'user') {
      alert(`Failed to save recording: ${result.error || 'Unknown error'}`);
    }
  } catch (error) {
    alert(`Failed to stop recording: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    localRequest = false;
    updateButtonEnabled();
  }
}

// Wires the record button, the recording-state subscription and the
// auto-stop notice. Called once from main.ts after initDom().
export function setupRecorder(): void {
  const { recordButton, meetingTitle } = getDom();

  onTranscriptionJobChange(({ job }) => followAutoJob(job));

  recordButton.addEventListener('click', () => {
    if (!snapshot || snapshot.phase === 'idle') void startRecording();
    else void stopRecording();
  });

  // Tray, shortcut and meeting starts use the title typed here, as before.
  meetingTitle.addEventListener('input', () => {
    window.electronAPI.setRecordingTitleDraft(meetingTitle.value.trim());
  });

  window.electronAPI.onRecordingStateChanged(applySnapshot);
  window.electronAPI.onRecordingAutoStopped(() => {
    showToast('Recording auto-stopped - reached time limit');
  });
  window.electronAPI.onRecordingNotice((notice) => {
    if (notice.kind === 'mic-fallback')
      showToast('Preferred mic unavailable — using system default');
  });

  // Subscribed first, so nothing between the read and the subscription is lost;
  // revisions already applied are ignored.
  void window.electronAPI
    .getRecordingState()
    .then(applySnapshot)
    .catch((error) => console.warn('Could not read recording state:', error));
  window.electronAPI.setRecordingTitleDraft(meetingTitle.value.trim());
}
