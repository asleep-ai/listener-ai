// Live-caption capture and transport, owned by the hidden capture host.
//
// Main's LiveCaptureRouter (src/liveCaptureRouter.ts) starts and stops this
// side with capture commands; LiveSessionService in main owns the session,
// its segments, hints and snapshot. This module only moves audio from the
// recording's processed stream to the provider path main selected:
//   - streaming providers (Gemini Live, Soniox): PCM frames to main,
//   - OpenAI Realtime: a WebRTC peer whose transcription events become
//     interim/final segments in main,
//   - chunked fallback: 12s MediaRecorder windows uploaded to main.
// The visible window only observes main's events, so its reload or loss never
// touches this capture. A stop flushes the tail (final WebRTC commit, last
// chunked window) before reporting `live-stopped`.

import type { CaptureHostLiveEvent, LiveCaptureStartCommand } from '../../src/recordingState';
import type { LivePcmFrame } from '../audio/graph';
import { reportError } from '../sentry';
import { state } from '../state';

const FALLBACK_SNIPPET_MS = 12_000;
const MIN_LIVE_BLOB_BYTES = 1024;
const FALLBACK_MIME_TYPE = 'audio/webm;codecs=opus';

type RealtimeClientConfig = NonNullable<LiveCaptureStartCommand['realtimeClient']>;
type RealtimeCallErrorDetails = {
  endpoint: RealtimeClientConfig['endpoint'];
  url: string;
  status: number;
  statusText: string;
  requestId?: string;
  body: string;
  sdpLength: number;
  audioTrackState: MediaStreamTrackState;
};

type RealtimeCallError = Error & { realtimeDetails?: RealtimeCallErrorDetails };

let liveId: string | null = null;
let captureMode: 'streaming' | 'chunked' | null = null;
let translate = true;
let liveStartedAt = 0;
// False once a stop began: no more PCM, no new chunked windows.
let capturing = false;
let detaching: Promise<void> | null = null;
// Resolves once live capture stopped taking audio (last chunked window
// recorded, WebRTC sender muted); its remote replies may still be pending.
let audioReleased: Promise<void> | null = null;
let stopping: Promise<void> | null = null;
let liveRecorder: MediaRecorder | null = null;
let liveRecorderTimer: ReturnType<typeof setTimeout> | null = null;
let liveWindowStartedAt = 0;
let liveWindowChunks: Blob[] = [];
let processingChain: Promise<void> = Promise.resolve();
let realtimePeer: RTCPeerConnection | null = null;
let realtimeDataChannel: RTCDataChannel | null = null;
let realtimeCommitTimer: ReturnType<typeof setInterval> | null = null;
let realtimeEndpoint: 'realtime' | 'translation' | null = null;
let realtimeInputTranscript = '';
let realtimeOutputTranscript = '';
let realtimeItemText = new Map<string, string>();
let realtimeActive = false;
let realtimeFailureHandled = false;
let realtimeTranslationFinalSent = false;
let realtimeFinalChain: Promise<void> = Promise.resolve();
// Transcription commits sent, commits the server acknowledged
// (`input_audio_buffer.committed`, or an empty-buffer error), and committed
// items whose transcription has not completed or failed yet. The final flush
// waits for all of them, not for whichever completion arrives first.
let realtimeCommitsSent = 0;
let realtimeCommitsAcked = 0;
let realtimeOpenItems = new Set<string>();

function report(event: CaptureHostLiveEvent): void {
  window.electronAPI.captureHost.reportLive(event);
}

function reportLiveError(sessionId: string, error: unknown, details?: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[live-capture] error:', message, details ?? error);
  report({ type: 'live-error', liveSessionId: sessionId, error: message });
}

function isCurrent(sessionId: string): boolean {
  return liveId === sessionId;
}

function offsetMs(): number {
  return Math.max(0, Date.now() - liveStartedAt);
}

function resetRealtimeState(): void {
  if (realtimeCommitTimer) {
    clearInterval(realtimeCommitTimer);
    realtimeCommitTimer = null;
  }
  realtimeInputTranscript = '';
  realtimeOutputTranscript = '';
  realtimeItemText = new Map<string, string>();
  realtimeEndpoint = null;
  realtimeActive = false;
  realtimeTranslationFinalSent = false;
  realtimeFinalChain = Promise.resolve();
  realtimeCommitsSent = 0;
  realtimeCommitsAcked = 0;
  realtimeOpenItems = new Set<string>();
}

function sendRealtimeCommit(events: RTCDataChannel): void {
  realtimeCommitsSent++;
  events.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
}

function realtimeCommitsDrained(): boolean {
  return realtimeCommitsAcked >= realtimeCommitsSent && realtimeOpenItems.size === 0;
}

function reportRealtimeError(sessionId: string, error: unknown, details?: unknown): void {
  const callDetails = getRealtimeErrorDetails(error);
  reportError(error, {
    operation: 'live.realtime',
    severity: 'error',
    extra: callDetails
      ? { status: callDetails.status, requestId: callDetails.requestId }
      : undefined,
  });
  reportLiveError(sessionId, error, details);
}

function getRealtimeErrorDetails(error: unknown): RealtimeCallErrorDetails | undefined {
  if (error && typeof error === 'object' && 'realtimeDetails' in error) {
    return (error as RealtimeCallError).realtimeDetails;
  }
  return undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendRealtimeInterim(sessionId: string, text: string, translation = false): void {
  if (!text.trim()) return;
  window.electronAPI.updateLiveSessionInterim({
    sessionId,
    text,
    translation,
    offsetMs: offsetMs(),
  });
}

async function sendRealtimeFinal(
  sessionId: string,
  text: string,
  translation?: string,
): Promise<void> {
  const transcript = text.trim();
  const translated = translation?.trim() || '';
  if (!transcript && !translated) return;
  await window.electronAPI.completeLiveSessionSegment({
    sessionId,
    text: transcript || translated,
    sourceMissing: !transcript,
    translation: translated || undefined,
    offsetMs: offsetMs(),
    durationMs: 0,
  });
}

function handleRealtimeMessage(sessionId: string, raw: string): void {
  let payload: {
    type?: string;
    item_id?: string;
    delta?: string;
    transcript?: string;
    error?: { message?: string; type?: string; code?: string; param?: string };
  };
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  if (payload.type === 'input_audio_buffer.committed') {
    realtimeCommitsAcked++;
    if (payload.item_id) realtimeOpenItems.add(payload.item_id);
    return;
  }
  if (payload.type === 'conversation.item.input_audio_transcription.failed') {
    if (payload.item_id) realtimeOpenItems.delete(payload.item_id);
    return;
  }
  if (payload.type === 'error' && payload.error?.code === 'input_audio_buffer_commit_empty') {
    // A commit with nothing buffered: acknowledged, nothing to transcribe.
    realtimeCommitsAcked++;
    return;
  }
  if (payload.type === 'error') {
    reportRealtimeError(sessionId, payload.error?.message || 'OpenAI Realtime error.', payload);
    return;
  }
  if (payload.type === 'conversation.item.input_audio_transcription.delta') {
    const itemId = payload.item_id || 'current';
    const text = `${realtimeItemText.get(itemId) ?? ''}${payload.delta ?? ''}`.trim();
    realtimeItemText.set(itemId, text);
    realtimeInputTranscript = text;
    sendRealtimeInterim(sessionId, text);
    return;
  }
  if (payload.type === 'conversation.item.input_audio_transcription.completed') {
    const itemId = payload.item_id || 'current';
    const text = (payload.transcript || realtimeItemText.get(itemId) || '').trim();
    realtimeItemText.delete(itemId);
    realtimeOpenItems.delete(itemId);
    realtimeInputTranscript = '';
    realtimeFinalChain = realtimeFinalChain.then(() => sendRealtimeFinal(sessionId, text));
    return;
  }
  if (payload.type === 'session.input_transcript.delta') {
    realtimeInputTranscript = `${realtimeInputTranscript}${payload.delta ?? ''}`.trim();
    sendRealtimeInterim(sessionId, realtimeInputTranscript);
    return;
  }
  if (payload.type === 'session.output_transcript.delta') {
    realtimeOutputTranscript = `${realtimeOutputTranscript}${payload.delta ?? ''}`.trim();
    sendRealtimeInterim(sessionId, realtimeOutputTranscript, true);
    return;
  }
  if (payload.type === 'session.closed' && realtimeEndpoint === 'translation') {
    realtimeTranslationFinalSent = true;
    realtimeFinalChain = sendRealtimeFinal(
      sessionId,
      realtimeInputTranscript,
      realtimeOutputTranscript,
    );
  }
}

async function startRealtimeWebRtc(
  sessionId: string,
  client: RealtimeClientConfig,
  stream: MediaStream,
): Promise<void> {
  await stopRealtimeWebRtc();
  // A stop or a replacement can land during any await below; a peer created
  // for a session that is no longer captured must not keep the audio.
  const superseded = () => !isCurrent(sessionId) || !capturing;
  if (superseded()) return;
  resetRealtimeState();
  realtimeFailureHandled = false;
  const track = stream.getAudioTracks()[0];
  if (!track) throw new Error('Live Realtime needs an audio track.');

  const peer = new RTCPeerConnection();
  realtimePeer = peer;
  realtimeEndpoint = client.endpoint;
  realtimeActive = true;
  peer.addTrack(track, stream);
  peer.ontrack = () => {
    // Translation sessions may return audio; Listener.AI only displays text.
  };
  peer.onconnectionstatechange = () => {
    if (peer.connectionState === 'failed') {
      // Failure after the SDP handshake succeeded: fall back instead of freezing
      // captions (realtimeActive otherwise blocks PCM from reaching main).
      void fallbackFromRealtimeFailure(sessionId, new Error('OpenAI Realtime connection failed.'));
    }
  };

  const events = peer.createDataChannel('oai-events');
  realtimeDataChannel = events;
  events.onmessage = (event) => handleRealtimeMessage(sessionId, String(event.data));
  events.onerror = () => reportRealtimeError(sessionId, 'OpenAI Realtime event channel failed.');
  if (client.endpoint === 'realtime') {
    // gpt-realtime-whisper transcription sessions disable turn detection, so the
    // server never auto-commits the input buffer. Commit on an interval to keep
    // incremental transcription events flowing (mirrors the WebSocket fallback).
    events.onopen = () => {
      realtimeCommitTimer = setInterval(() => {
        if (events.readyState === 'open') sendRealtimeCommit(events);
      }, 2_000);
    };
  }

  const abandon = (): void => {
    if (realtimePeer === peer) {
      realtimePeer = null;
      realtimeDataChannel = null;
      resetRealtimeState();
    }
    peer.close();
  };
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  if (superseded()) return abandon();
  const callsUrl =
    client.endpoint === 'translation'
      ? 'https://api.openai.com/v1/realtime/translations/calls'
      : 'https://api.openai.com/v1/realtime/calls';
  const response = await fetch(callsUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${client.clientSecret}`,
      'Content-Type': 'application/sdp',
    },
    body: offer.sdp || '',
  });
  const answerSdp = await response.text();
  if (superseded()) return abandon();
  if (!response.ok) {
    const details: RealtimeCallErrorDetails = {
      endpoint: client.endpoint,
      url: callsUrl,
      status: response.status,
      statusText: response.statusText,
      requestId: response.headers.get('x-request-id') ?? undefined,
      body: answerSdp.slice(0, 1_000),
      sdpLength: offer.sdp?.length ?? 0,
      audioTrackState: track.readyState,
    };
    const message =
      `OpenAI Realtime ${client.endpoint} call failed ` +
      `(${response.status} ${response.statusText || 'HTTP error'}): ` +
      (answerSdp.trim() || '<empty response>');
    const error = new Error(message) as RealtimeCallError;
    error.realtimeDetails = details;
    throw error;
  }
  await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  if (superseded()) return abandon();
}

async function stopRealtimeWebRtc(sessionId?: string): Promise<void> {
  const peer = realtimePeer;
  const events = realtimeDataChannel;
  if (realtimeCommitTimer) {
    clearInterval(realtimeCommitTimer);
    realtimeCommitTimer = null;
  }
  if (sessionId && realtimeEndpoint === 'translation' && !realtimeTranslationFinalSent) {
    // Translation sessions flush their final output in response to
    // `session.close`; wait for `session.closed` (or a 1.5s cap) before tearing
    // down so the last translated segment isn't lost.
    if (events?.readyState === 'open') {
      events.send(JSON.stringify({ type: 'session.close' }));
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_500);
        const previous = events.onmessage;
        events.onmessage = (event) => {
          previous?.call(events, event);
          try {
            const payload = JSON.parse(String(event.data)) as { type?: string };
            if (payload.type === 'session.closed') {
              clearTimeout(timer);
              resolve();
            }
          } catch {
            // ignore
          }
        };
      });
    }
    await realtimeFinalChain.catch(() => {});
    if (!realtimeTranslationFinalSent) {
      await sendRealtimeFinal(sessionId, realtimeInputTranscript, realtimeOutputTranscript);
    }
  } else if (sessionId && realtimeEndpoint === 'realtime' && events?.readyState === 'open') {
    // Transcription sessions disable turn detection, so flush the buffered tail
    // with a final commit, then wait until every commit sent so far was
    // acknowledged and every committed item's transcription completed or
    // failed (each completion queues its final via handleRealtimeMessage). An
    // earlier interval commit completing first must not end the wait before
    // the final commit's own item. Capped at 1.5s.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_500);
      const previous = events.onmessage;
      events.onmessage = (event) => {
        previous?.call(events, event);
        if (realtimeCommitsDrained()) {
          clearTimeout(timer);
          resolve();
        }
      };
      sendRealtimeCommit(events);
    });
    await realtimeFinalChain.catch(() => {});
  }
  realtimeDataChannel = null;
  realtimePeer = null;
  if (peer) peer.close();
  resetRealtimeState();
}

async function fallbackFromRealtimeFailure(sessionId: string, error: unknown): Promise<void> {
  if (!isCurrent(sessionId) || !capturing || realtimeFailureHandled) return;
  realtimeFailureHandled = true;
  realtimeActive = false;
  reportRealtimeError(sessionId, error, getRealtimeErrorDetails(error));
  await stopRealtimeWebRtc(sessionId).catch(() => {});
  if (!isCurrent(sessionId) || !capturing) return;
  const fallback = await window.electronAPI
    .handleLiveRealtimeFailure({ sessionId, error: getErrorMessage(error) })
    .catch((err) => ({ success: false as const, error: getErrorMessage(err) }));
  if (!isCurrent(sessionId) || !capturing) return;
  if (fallback.success) {
    captureMode = fallback.session.mode;
    if (captureMode === 'chunked') startFallbackWindow(sessionId);
    return;
  }
  // Main ends the session; this side stops capturing it now.
  capturing = false;
  report({ type: 'live-failed', liveSessionId: sessionId, error: fallback.error });
}

function queueFallbackBlob(
  blob: Blob,
  windowOffsetMs: number,
  durationMs: number,
  sessionId: string,
): void {
  if (blob.size < MIN_LIVE_BLOB_BYTES) return;
  const translateChunk = translate;
  processingChain = processingChain
    .catch(() => {})
    .then(async () => {
      if (!isCurrent(sessionId)) return;
      const audioData = await blob.arrayBuffer();
      if (!isCurrent(sessionId)) return;
      // A successful upload's segment reaches the window as a main event.
      const result = await window.electronAPI.processLiveAudioChunk({
        sessionId,
        audioData,
        mimeType: blob.type || 'audio/webm',
        offsetMs: windowOffsetMs,
        durationMs,
        translate: translateChunk,
      });
      if (!result.success && isCurrent(sessionId)) {
        reportLiveError(sessionId, result.error || 'Live transcript failed.');
      }
    })
    .catch((err) => {
      if (isCurrent(sessionId)) reportLiveError(sessionId, err);
    });
}

function startFallbackWindow(sessionId: string): void {
  const stream = state.processedStream;
  if (!isCurrent(sessionId) || !capturing || captureMode !== 'chunked' || !stream) return;
  if (typeof MediaRecorder === 'undefined') {
    reportLiveError(sessionId, 'Live fallback is unavailable in this browser.');
    return;
  }
  liveWindowChunks = [];
  liveWindowStartedAt = Date.now();

  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType: FALLBACK_MIME_TYPE });
  } catch {
    recorder = new MediaRecorder(stream);
  }

  liveRecorder = recorder;
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) liveWindowChunks.push(event.data);
  };
  recorder.onstop = () => {
    const chunks = liveWindowChunks;
    const windowOffsetMs = Math.max(0, liveWindowStartedAt - liveStartedAt);
    const durationMs = Math.max(0, Date.now() - liveWindowStartedAt);
    liveWindowChunks = [];
    liveRecorder = null;
    if (capturing && isCurrent(sessionId) && chunks.length > 0) {
      queueFallbackBlob(
        new Blob(chunks, { type: recorder.mimeType || FALLBACK_MIME_TYPE }),
        windowOffsetMs,
        durationMs,
        sessionId,
      );
    }
    if (capturing && isCurrent(sessionId) && captureMode === 'chunked') {
      startFallbackWindow(sessionId);
    }
  };
  recorder.start();
  liveRecorderTimer = setTimeout(() => {
    if (recorder.state === 'recording') recorder.stop();
  }, FALLBACK_SNIPPET_MS);
}

function stopActiveFallbackRecorder(sessionId: string, upload: boolean): Promise<void> {
  if (liveRecorderTimer) {
    clearTimeout(liveRecorderTimer);
    liveRecorderTimer = null;
  }
  const recorder = liveRecorder;
  if (!recorder || recorder.state === 'inactive') return Promise.resolve();
  return new Promise((resolve) => {
    // Final flush: queue this last window (the normal onstop refuses once
    // capture stopped) and do NOT restart another window.
    recorder.onstop = () => {
      const chunks = liveWindowChunks;
      const windowOffsetMs = Math.max(0, liveWindowStartedAt - liveStartedAt);
      const durationMs = Math.max(0, Date.now() - liveWindowStartedAt);
      liveWindowChunks = [];
      liveRecorder = null;
      if (upload && chunks.length > 0) {
        queueFallbackBlob(
          new Blob(chunks, { type: recorder.mimeType || '' }),
          windowOffsetMs,
          durationMs,
          sessionId,
        );
      }
      resolve();
    };
    recorder.stop();
  });
}

/** The recording graph's PCM tap: streaming providers receive it through main. */
export function handleLivePcmFrame(frame: LivePcmFrame): void {
  if (!liveId || captureMode !== 'streaming' || !capturing || realtimeActive) return;
  const durationMs = Math.round((frame.frames / frame.sampleRate) * 1000);
  window.electronAPI.sendLivePcmChunk({
    sessionId: liveId,
    audioData: frame.audioData,
    sampleRate: frame.sampleRate,
    channelCount: frame.channelCount,
    offsetMs: Math.max(0, Date.now() - liveStartedAt - durationMs),
    durationMs,
    sequence: frame.sequence,
  });
}

export async function startLiveCapture(command: LiveCaptureStartCommand): Promise<void> {
  // Main stops (and flushes) a previous session before starting another.
  if (liveId) abortLiveCapture();
  const sessionId = command.liveSessionId;
  liveId = sessionId;
  captureMode = command.mode;
  translate = command.translate;
  liveStartedAt = command.startedAtMs || Date.now();
  capturing = true;
  detaching = null;
  audioReleased = null;
  stopping = null;
  processingChain = Promise.resolve();
  const stream = state.processedStream;
  if (!stream) {
    capturing = false;
    report({
      type: 'live-failed',
      liveSessionId: sessionId,
      error: 'Live captions need a running recording.',
    });
    return;
  }
  if (command.realtimeClient) {
    try {
      await startRealtimeWebRtc(sessionId, command.realtimeClient, stream);
    } catch (error) {
      await fallbackFromRealtimeFailure(sessionId, error);
    }
    return;
  }
  if (captureMode === 'chunked') startFallbackWindow(sessionId);
}

// Releases the audio side first, promptly: the last chunked window is
// recorded and queued, and the WebRTC sender stops sending (the track itself
// is the recording's and is not stopped here). Then the remote tail drains:
// the final WebRTC commit and its completion. A recording stop waits only for
// the release before tearing the graph down, so audio is never captured
// after Stop while remote replies are pending.
function detach(sessionId: string): Promise<void> {
  detaching ??= (async () => {
    capturing = false;
    const released = (async () => {
      muteRealtimeAudio();
      await stopActiveFallbackRecorder(sessionId, true);
    })();
    audioReleased = released;
    await released;
    await stopRealtimeWebRtc(sessionId).catch((error) => reportLiveError(sessionId, error));
  })();
  return detaching;
}

function muteRealtimeAudio(): void {
  for (const sender of realtimePeer?.getSenders() ?? []) {
    if (sender.track) void sender.replaceTrack(null).catch(() => {});
  }
}

/** Flushes the tail, waits for queued uploads, then reports `live-stopped`. */
export function stopLiveCapture(sessionId: string): Promise<void> {
  if (!isCurrent(sessionId)) {
    // Already gone (failed, aborted or replaced); confirm so main does not wait.
    report({ type: 'live-stopped', liveSessionId: sessionId });
    return Promise.resolve();
  }
  stopping ??= (async () => {
    await detach(sessionId);
    await processingChain.catch(() => {});
    if (isCurrent(sessionId)) {
      liveId = null;
      captureMode = null;
    }
    report({ type: 'live-stopped', liveSessionId: sessionId });
  })();
  return stopping;
}

/**
 * Before the recording graph goes away: live capture stops taking audio (its
 * last chunked window is recorded). Resolves without waiting for remote
 * replies, which keep draining toward `live-stopped`.
 */
export function releaseLiveAudio(): Promise<void> {
  if (!liveId) return Promise.resolve();
  void detach(liveId);
  return audioReleased ?? Promise.resolve();
}

export function setLiveTranslate(sessionId: string, value: boolean): void {
  if (isCurrent(sessionId)) translate = value;
}

/** Capture failed underneath live captions: drop everything without a flush. */
export function abortLiveCapture(): void {
  capturing = false;
  liveId = null;
  captureMode = null;
  if (liveRecorderTimer) {
    clearTimeout(liveRecorderTimer);
    liveRecorderTimer = null;
  }
  const recorder = liveRecorder;
  liveRecorder = null;
  liveWindowChunks = [];
  if (recorder && recorder.state !== 'inactive') {
    recorder.onstop = null;
    recorder.stop();
  }
  const peer = realtimePeer;
  realtimePeer = null;
  realtimeDataChannel = null;
  peer?.close();
  resetRealtimeState();
}
