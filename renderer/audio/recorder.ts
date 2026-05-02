// Recording session orchestration: start/stop, MediaRecorder wiring, timer,
// auto-mode post-processing. Owns the click handler on the record button.

import { getDom, state } from '../state';
import { showNotification, showToast } from '../ui/notifications';
import { refreshRecordingsList } from '../ui/recordings-list';
import { buildProcessedStream, cleanupAudioState, pickRecordingMimeType } from './graph';
import { acquireMediaStream, attachTrackEndedHandlers } from './mic';
import { createSystemAudioSource } from './system-audio';

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
      if (
        confirm(
          'Microphone access is required to record audio.\n\nOpen System Settings to grant permission?',
        )
      ) {
        await window.electronAPI.openMicrophoneSettings();
      }
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      if (confirm('No microphone was detected.\n\nOpen System Settings to check input devices?')) {
        await window.electronAPI.openMicrophoneSettings();
      }
    } else {
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
  let graph;
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
    graph = await buildProcessedStream(state.mediaStream, addSystemAudio);
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
  state.mediaRecorder.ondataavailable = (event) => {
    if (!event.data || event.data.size === 0) return;
    const blob = event.data;
    state.chunkSendChain = state.chunkSendChain.then(async () => {
      try {
        const buf = await blob.arrayBuffer();
        window.electronAPI.sendRecordingChunk(buf);
      } catch (err) {
        console.error('Failed to forward recording chunk:', err);
      }
    });
  };
  state.mediaRecorder.onerror = (event: Event) => {
    const err = (event as unknown as { error?: unknown }).error ?? event;
    console.error('MediaRecorder error:', err);
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
    alert(
      `Failed to start recorder: ${error instanceof Error && error.message ? error.message : String(error)}`,
    );
    return;
  }

  state.isRecording = true;
  state.recordingStartTime = Date.now();

  recordButton.textContent = 'Stop Recording';
  recordButton.classList.add('recording');
  statusIndicator.classList.add('recording');
  statusText.textContent = 'Recording...';
  recordingTime.classList.add('active');

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
}

function pickMeetingTitle(recordingTitle: string, suggestedTitle?: string): string {
  const isPlaceholder = recordingTitle === '' || recordingTitle === 'Untitled_Meeting';
  if (isPlaceholder && suggestedTitle) return suggestedTitle;
  return recordingTitle || suggestedTitle || 'Untitled Meeting';
}

export async function processAutoMode(
  audioPath: string | undefined,
  recordingTitle: string,
  durationMs: number | undefined,
): Promise<void> {
  const { autoModeToggle, recordButton, statusText } = getDom();
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

  state.isAutoModeProcessing = true;
  recordButton.disabled = true;
  recordButton.style.opacity = '0.5';
  recordButton.style.cursor = 'not-allowed';
  statusText.textContent = 'Auto mode: Processing recording...';

  try {
    console.log('Auto mode: Starting transcription...');
    const transcriptionResult = await window.electronAPI.transcribeAudio(audioPath);

    if (transcriptionResult.success) {
      console.log('Auto mode: Transcription complete');

      let finalAudioPath = audioPath;
      if (transcriptionResult.newFilePath) {
        finalAudioPath = transcriptionResult.newFilePath;
        console.log('Auto mode: File renamed to:', finalAudioPath);
      }

      const finalTitle = pickMeetingTitle(
        recordingTitle,
        transcriptionResult.data.suggestedTitle,
      );

      let notionUrl: string | undefined;
      let notionError: string | undefined;
      let notionConfigured = false;

      if (config.notionApiKey && config.notionDatabaseId) {
        notionConfigured = true;
        console.log('Auto mode: Uploading to Notion...');

        const uploadResult = await window.electronAPI.uploadToNotion({
          title: finalTitle,
          transcriptionData: transcriptionResult.data,
          audioFilePath: finalAudioPath,
          transcriptionPath: transcriptionResult.transcriptionPath,
        });

        if (uploadResult.success) {
          notionUrl = uploadResult.url;
          statusText.textContent = 'Auto mode: Successfully uploaded to Notion!';
          if (uploadResult.url) {
            window.electronAPI.openExternal(uploadResult.url);
          }
        } else {
          notionError = uploadResult.error || 'Unknown error';
          statusText.textContent = 'Auto mode: Failed to upload to Notion';
          console.error('Auto mode: Notion upload failed:', uploadResult.error);
        }
      }

      if (config.slackWebhookUrl && config.slackAutoShare) {
        console.log('Auto mode: Sending to Slack...');
        const slackResult = await window.electronAPI.sendToSlack({
          title: finalTitle,
          transcriptionData: transcriptionResult.data,
          transcriptionPath: transcriptionResult.transcriptionPath,
          notionUrl,
          notionError,
        });
        if (slackResult.success) {
          statusText.textContent = notionConfigured
            ? 'Auto mode: Sent to Notion and Slack.'
            : 'Auto mode: Sent to Slack.';
        } else {
          statusText.textContent = 'Auto mode: Failed to send to Slack';
          console.error('Auto mode: Slack send failed:', slackResult.error);
        }
      } else if (!notionConfigured) {
        statusText.textContent =
          'Auto mode: Transcription complete (Notion/Slack not configured)';
      }

      await refreshRecordingsList();
    } else {
      statusText.textContent = 'Auto mode: Transcription failed';
      console.error('Auto mode: Transcription failed:', transcriptionResult.error);
    }
  } catch (error) {
    statusText.textContent = 'Auto mode: Error processing recording';
    console.error('Auto mode error:', error);
    if (error instanceof Error) {
      console.error('Error details:', error.message, error.stack);
    }
  } finally {
    state.isAutoModeProcessing = false;
    recordButton.disabled = false;
    recordButton.style.opacity = '';
    recordButton.style.cursor = '';
  }

  setTimeout(() => {
    statusText.textContent = 'Ready to record';
  }, 5000);
}

export async function handleRecordingStopped(
  audioPath: string | undefined,
  durationMs: number | undefined,
): Promise<void> {
  const { meetingTitle } = getDom();
  resetRecordingUI();
  const recordingTitle = meetingTitle.value.trim() || 'Untitled_Meeting';
  meetingTitle.value = '';
  await refreshRecordingsList();
  await processAutoMode(audioPath, recordingTitle, durationMs);
}

export async function stopRecording(): Promise<void> {
  // If the recorder already transitioned to inactive on its own (e.g. USB mic
  // unplugged, stream ended, Chromium force-stopped encoding), still unwind the
  // session so the next recording isn't blocked by stuck state.
  if (!state.mediaRecorder || state.mediaRecorder.state === 'inactive') {
    cleanupAudioState();
    try {
      const result = await window.electronAPI.stopRecording();
      if (result?.success) {
        await handleRecordingStopped(result.filePath, result.durationMs);
        return;
      }
    } catch {
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
    cleanupAudioState();

    const result = await window.electronAPI.stopRecording();

    if (result.success) {
      await handleRecordingStopped(result.filePath, result.durationMs);
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
