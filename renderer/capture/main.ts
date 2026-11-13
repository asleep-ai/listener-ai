// Hidden recording capture host. Main (src/captureHost.ts) loads this page in
// a window that is never shown or focused and drives it with commands; the
// RecordingController owns all state. This page only runs the existing audio
// chain: getUserMedia -> Web Audio graph (+ system audio) -> MediaRecorder,
// streaming encoded chunks to main. Live captions ride on the same processed
// audio (./live.ts), so they too survive any change to the visible window.
//
// No alert/confirm here: every failure becomes an error code that the visible
// window presents when it can.

import type { CaptureHostCommand, RecordingErrorCode } from '../../src/recordingState';
import { buildProcessedStream, cleanupAudioState, pickRecordingMimeType } from '../audio/graph';
import { acquireMediaStream, attachTrackEndedHandlers, switchMicDevice } from '../audio/mic';
import { createSystemAudioSource } from '../audio/system-audio';
import { setupRendererLogger } from '../services/renderer-logger';
import {
  abortLiveCapture,
  handleLivePcmFrame,
  releaseLiveAudio,
  setLiveTranslate,
  startLiveCapture,
  stopLiveCapture,
} from './live';
import { initRendererSentry, reportError } from '../sentry';
import { state } from '../state';

initRendererSentry();
setupRendererLogger();

const host = window.electronAPI.captureHost;
let sessionId: number | null = null;
let stopping: Promise<void> | null = null;
// ondataavailable fires ~once/sec; report a stuck chunk forward once per session.
let reportedChunkForward = false;

function message(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function fail(id: number, code: RecordingErrorCode, text: string): void {
  abortLiveCapture();
  cleanupAudioState();
  state.isRecording = false;
  if (sessionId === id) sessionId = null;
  host.report({ type: 'error', sessionId: id, code, message: text });
}

async function start(command: Extract<CaptureHostCommand, { type: 'start' }>): Promise<void> {
  if (sessionId !== null) return;
  const id = command.sessionId;
  sessionId = id;
  stopping = null;
  reportedChunkForward = false;
  try {
    state.mediaStream = await acquireMediaStream(command.deviceId, () =>
      host.report({ type: 'mic-fallback', sessionId: id }),
    );
  } catch (error) {
    const name = error instanceof Error && error.name ? error.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      reportError(error, { operation: 'recording.start.permission-denied', severity: 'warning' });
      fail(id, 'permission-denied', 'Microphone access is required to record audio.');
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      reportError(error, { operation: 'recording.start.no-device', severity: 'warning' });
      fail(id, 'no-device', 'No microphone was detected.');
    } else {
      reportError(error, { operation: 'recording.start.getusermedia', severity: 'error' });
      fail(id, 'microphone', `Failed to access microphone: ${message(error)}`);
    }
    return;
  }

  state.recordingMimeType = pickRecordingMimeType();
  let recorder: MediaRecorder;
  try {
    const addSystemAudio = command.recordSystemAudio
      ? async (ctx: AudioContext) => {
          const { node, cleanup } = await createSystemAudioSource(ctx);
          state.systemAudioCleanup = cleanup;
          if (!node) host.report({ type: 'system-audio-fallback', sessionId: id });
          return node;
        }
      : null;
    const graph = await buildProcessedStream(state.mediaStream, addSystemAudio, handleLivePcmFrame);
    state.audioContext = graph.ctx;
    state.processedStream = graph.stream;
    state.sourceNode = graph.source;
    state.graphHead = graph.head;
    attachTrackEndedHandlers(state.mediaStream, () =>
      host.report({ type: 'track-ended', sessionId: id }),
    );
    recorder = state.recordingMimeType
      ? new MediaRecorder(state.processedStream, {
          mimeType: state.recordingMimeType,
          audioBitsPerSecond: 64000,
        })
      : new MediaRecorder(state.processedStream, { audioBitsPerSecond: 64000 });
    state.mediaRecorder = recorder;
  } catch (error) {
    reportError(error, { operation: 'recording.start.init', severity: 'error' });
    fail(id, 'init', `Failed to initialize recorder: ${message(error)}`);
    return;
  }

  // Main opens the output file before MediaRecorder starts, so the first
  // chunk has a file handle waiting for it.
  const opened = await host
    .open({ sessionId: id, mimeType: recorder.mimeType || state.recordingMimeType || 'audio/webm' })
    .catch((error) => ({ success: false, error: message(error) }));
  if (!opened.success || sessionId !== id) {
    cleanupAudioState();
    if (sessionId === id) sessionId = null;
    return;
  }

  state.chunkSendChain = Promise.resolve();
  recorder.ondataavailable = (event) => {
    if (!event.data || event.data.size === 0) return;
    const blob = event.data;
    state.chunkSendChain = state.chunkSendChain.then(async () => {
      try {
        host.sendChunk(await blob.arrayBuffer());
      } catch (err) {
        console.error('Failed to forward recording chunk:', err);
        if (!reportedChunkForward) {
          reportedChunkForward = true;
          reportError(err, { operation: 'recording.chunk-forward', severity: 'warning' });
        }
      }
    });
  };
  recorder.onerror = (event: Event) => {
    const err = (event as unknown as { error?: unknown }).error ?? event;
    console.error('MediaRecorder error:', err);
    reportError(err, { operation: 'recording.mediarecorder-error', severity: 'error' });
    const text = err instanceof Error && err.message ? err.message : 'Unknown error';
    // Chunks already sent stay in the file; main finalizes it.
    void state.chunkSendChain.then(() => fail(id, 'recorder-error', `Recording failed: ${text}`));
  };

  try {
    recorder.start(1000);
  } catch (error) {
    reportError(error, { operation: 'recording.start.recorder-start', severity: 'error' });
    fail(id, 'recorder-start', `Failed to start recorder: ${message(error)}`);
    return;
  }
  state.isRecording = true;
  host.report({ type: 'started', sessionId: id });
}

async function flushAndStop(id: number): Promise<void> {
  // Capture ends at once, whoever asked for the stop: live captions stop
  // taking audio (their last chunked window is recorded, the WebRTC sender is
  // muted) in parallel with the recorder's final chunk. Their remote tail
  // (final commit, uploads) drains afterwards without the graph.
  const liveReleased = releaseLiveAudio().catch((error) =>
    console.warn('Live capture flush failed:', error),
  );
  const recorder = state.mediaRecorder;
  if (recorder && recorder.state !== 'inactive') {
    // MediaRecorder.stop() flushes the final chunk via ondataavailable before
    // onstop. Awaiting chunkSendChain puts every chunk on the IPC queue before
    // 'stopped'; Electron delivers one sender's messages in order.
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    try {
      recorder.stop();
      await stopped;
    } catch (error) {
      console.warn('MediaRecorder stop failed:', error);
    }
  }
  await state.chunkSendChain.catch(() => {});
  await liveReleased;
  cleanupAudioState();
  state.isRecording = false;
  if (sessionId === id) sessionId = null;
  host.report({ type: 'stopped', sessionId: id });
}

host.onCommand((command) => {
  switch (command.type) {
    case 'start':
      void start(command).catch((error) => {
        reportError(error, { operation: 'recording.start', severity: 'error' });
        fail(command.sessionId, 'init', `Failed to initialize recorder: ${message(error)}`);
      });
      return;
    case 'stop':
      if (sessionId !== command.sessionId) {
        // Already gone (failed or stopped); confirm so main does not wait.
        host.report({ type: 'stopped', sessionId: command.sessionId });
        return;
      }
      stopping ??= flushAndStop(command.sessionId);
      return;
    case 'switch-mic':
      if (sessionId !== command.sessionId) return;
      void switchMicDevice(command.deviceId, () =>
        host.report({ type: 'track-ended', sessionId: command.sessionId }),
      ).then((success) =>
        host.report({ type: 'mic-switched', sessionId: command.sessionId, success }),
      );
      return;
    case 'live-start':
      void startLiveCapture(command).catch((error) => {
        reportError(error, { operation: 'live.capture-start', severity: 'error' });
        host.reportLive({
          type: 'live-failed',
          liveSessionId: command.liveSessionId,
          error: message(error),
        });
      });
      return;
    case 'live-stop':
      void stopLiveCapture(command.liveSessionId);
      return;
    case 'live-translate':
      setLiveTranslate(command.liveSessionId, command.translate);
      return;
    default:
      return;
  }
});

host.ready();
