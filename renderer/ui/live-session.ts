import type {
  AgentChatMessage,
  LiveSessionEvent,
  LiveSessionStartResult,
  LiveTranscriptSegment,
} from '../electronAPI';
import type { LivePcmFrame } from '../audio/graph';
import { reportError } from '../sentry';
import {
  describeLiveIndicator,
  type LiveIndicatorEndReason,
  type LiveIndicatorPhase,
  type LiveIndicatorView,
} from '../../src/liveSessionView';
import { setupLiveHints } from './live-hints';
import { setupLiveSessionLayout } from './live-session-layout';
import type { LiveHint, LiveHintSource, LiveHintsSnapshot } from '../../src/liveHintTypes';

const FALLBACK_SNIPPET_MS = 12_000;
const MIN_LIVE_BLOB_BYTES = 1024;

let panelEl: HTMLDialogElement | null = null;
let launcherEl: HTMLElement | null = null;
let startButtonEl: HTMLButtonElement | null = null;
let indicatorEl: HTMLElement | null = null;
let indicatorStatusEl: HTMLElement | null = null;
let indicatorDetailEl: HTMLElement | null = null;
let closeButtonEl: HTMLButtonElement | null = null;
let minimizeButtonEl: HTMLButtonElement | null = null;
let restartButtonEl: HTMLButtonElement | null = null;
let statusEl: HTMLElement | null = null;
let translateToggleEl: HTMLInputElement | null = null;
let transcriptListEl: HTMLElement | null = null;
let translationListEl: HTMLElement | null = null;
let chatMessagesEl: HTMLElement | null = null;
let chatFormEl: HTMLFormElement | null = null;
let chatInputEl: HTMLInputElement | null = null;
let chatSendEl: HTMLButtonElement | null = null;

let hints: ReturnType<typeof setupLiveHints> | null = null;
let hintModeReady = false;
const hintSources = new Map<string, LiveHintSource>();
let layout: ReturnType<typeof setupLiveSessionLayout> | null = null;
let activeSessionId: string | null = null;
let captureMode: 'streaming' | 'chunked' | null = null;
let liveRecorder: MediaRecorder | null = null;
let liveRecorderTimer: ReturnType<typeof setTimeout> | null = null;
let liveStartedAt = 0;
let liveWindowStartedAt = 0;
let liveWindowChunks: Blob[] = [];
let stoppingCapture = false;
let finalizingCapture = false;
let finalizeCapturePromise: Promise<void> | null = null;
let processingChain: Promise<void> = Promise.resolve();
let launcher: {
  title: string;
  fallbackStream: MediaStream;
  preferredMimeType: string;
  startVersion: number;
} | null = null;
let startCancellationVersion = 0;
let liveHistory: AgentChatMessage[] = [];
let askBusy = false;
let askInputComposing = false;
let hasTranscript = false;
let hasInterimTranscript = false;
let hasInterimTranslation = false;
let interimEl: HTMLElement | null = null;
let interimTranslationEl: HTMLElement | null = null;
let realtimePeer: RTCPeerConnection | null = null;
let realtimeDataChannel: RTCDataChannel | null = null;
let realtimeCommitTimer: ReturnType<typeof setInterval> | null = null;
let realtimeEndpoint: 'realtime' | 'translation' | null = null;
let realtimeInputTranscript = '';
let realtimeOutputTranscript = '';
let realtimeItemText = new Map<string, string>();
let realtimeRendererActive = false;
let realtimeFailureHandled = false;
let realtimeTranslationFinalSent = false;
let realtimeFinalChain: Promise<void> = Promise.resolve();
// Main-screen indicator state (see src/liveSessionView.ts).
let startingSession = false;
let startToken = 0;
let endedReason: LiveIndicatorEndReason | null = null;
let lastLiveError: string | null = null;
let captionIds = new Set<string>();
// A session main ended because the previous page reloaded or crashed; its
// remaining segment events are still rendered, read-only.
let recoveredSessionId: string | null = null;
const RECOVERED_STATUS =
  'Live captions ended when the window reloaded. This transcript is read-only.';

type RealtimeClientConfig = NonNullable<LiveSessionStartResult['realtimeClient']>;
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

function setStatus(text: string): void {
  if (statusEl) statusEl.textContent = text;
}

function indicatorPhase(): LiveIndicatorPhase {
  if (finalizingCapture) return 'finalizing';
  if (startingSession) return 'connecting';
  if (activeSessionId) return 'active';
  if (endedReason) return 'ended';
  return 'idle';
}

function currentIndicatorView(): LiveIndicatorView {
  return describeLiveIndicator({
    recording: !!launcher,
    phase: indicatorPhase(),
    endedReason,
    error: lastLiveError,
    captionCount: captionIds.size,
  });
}

function setTextIfChanged(el: HTMLElement | null, text: string): void {
  // The status line is a live region: rewriting the same text would repeat the
  // announcement, so only real phase changes reach assistive technology.
  if (el && el.textContent !== text) el.textContent = text;
}

// The single writer for the launcher, its status line, and the dialog's
// session controls.
function renderIndicator(): void {
  const view = currentIndicatorView();
  if (launcherEl) launcherEl.hidden = !view.visible;
  setTextIfChanged(startButtonEl, view.buttonLabel);
  if (indicatorEl) indicatorEl.dataset.tone = view.tone;
  setTextIfChanged(indicatorStatusEl, view.statusText);
  setTextIfChanged(indicatorDetailEl, view.detailText);

  const live = !!activeSessionId || startingSession || finalizingCapture;
  if (closeButtonEl) {
    closeButtonEl.hidden = !live;
    closeButtonEl.disabled = finalizingCapture;
  }
  if (restartButtonEl) restartButtonEl.hidden = live || !launcher;
  setTextIfChanged(minimizeButtonEl, live ? 'Minimize' : 'Close');
}

function focusIsInPanelOrLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || !!panelEl?.contains(active);
}

function focusInsidePanel(): void {
  const target = restartButtonEl && !restartButtonEl.hidden ? restartButtonEl : minimizeButtonEl;
  target?.focus();
}

// Opens the dialog. Only user actions call this (the launcher, Restart); a
// provider status or error never reopens a minimized dialog or moves focus.
function showPanel(): void {
  const panel = panelEl;
  if (!panel) return;
  renderIndicator();
  if (!panel.open) {
    panel.showModal();
    focusInsidePanel();
  }
}

function returnFocusToLauncher(): void {
  if (startButtonEl && launcherEl && !launcherEl.hidden) startButtonEl.focus();
}

// Minimize: hides the dialog and keeps the session running.
function minimizePanel(): void {
  const panel = panelEl;
  if (!panel?.open) return;
  const hadFocus = panel.contains(document.activeElement);
  panel.close();
  if (hadFocus) returnFocusToLauncher();
}

function hidePanel(): void {
  if (panelEl?.open) panelEl.close();
}

function clearList(el: HTMLElement | null, emptyText: string): void {
  if (!el) return;
  el.innerHTML = '';
  const empty = document.createElement('p');
  empty.className = 'live-session-empty';
  empty.textContent = emptyText;
  el.appendChild(empty);
}

function resetLiveUi(): void {
  recoveredSessionId = null;
  endedReason = null;
  lastLiveError = null;
  captionIds = new Set<string>();
  hintModeReady = false;
  // A new session starts on the hints view with Ask collapsed; minimize and
  // reopen keep whatever the user chose.
  layout?.reset();
  showPanel();
  hints?.reset(false);
  hintSources.clear();
  hints?.active(false);
  if (closeButtonEl) closeButtonEl.textContent = 'Stop live captions';
  clearList(transcriptListEl, 'Waiting for speech...');
  clearList(translationListEl, 'Waiting for transcript...');
  interimEl = null;
  if (chatMessagesEl) {
    chatMessagesEl.innerHTML = '';
    const empty = document.createElement('p');
    empty.className = 'chat-empty';
    empty.textContent = 'Ask about what has been heard so far.';
    chatMessagesEl.appendChild(empty);
  }
  liveHistory = [];
  askBusy = false;
  hasTranscript = false;
  hasInterimTranscript = false;
  hasInterimTranslation = false;
  interimTranslationEl = null;
  updateAskEnabled();
}

function updateTranslationVisibility(): void {
  const enabled = translateToggleEl?.checked !== false;
  // The layout owns caption-tab visibility; hiding the column here would fight it.
  layout?.setTranslationEnabled(enabled);
  if (activeSessionId) {
    window.electronAPI
      .setLiveSessionTranslate({ sessionId: activeSessionId, translate: enabled })
      .catch(() => {});
  }
}

function formatOffset(offsetMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(offsetMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function removeEmpty(el: HTMLElement | null): void {
  const empty = el?.querySelector('.live-session-empty, .chat-empty');
  empty?.remove();
}

function makeLiveTextItem(
  offsetMs: number,
  text: string,
  className: string,
  id?: string,
): HTMLElement {
  const item = document.createElement('article');
  item.tabIndex = -1;
  item.className = `live-session-item ${className}`;
  if (id) item.dataset.liveSegmentId = id;
  const time = document.createElement('span');
  time.className = 'live-session-time';
  time.textContent = formatOffset(offsetMs);
  const body = document.createElement('p');
  body.className = 'live-session-text';
  body.textContent = text.trim();
  item.appendChild(time);
  item.appendChild(body);
  return item;
}

function upsertLiveText(
  el: HTMLElement | null,
  id: string,
  offsetMs: number,
  text: string,
  className: string,
): void {
  if (!el || !text.trim()) return;
  removeEmpty(el);
  let item = el.querySelector<HTMLElement>(`[data-live-segment-id="${CSS.escape(id)}"]`);
  if (!item) {
    item = makeLiveTextItem(offsetMs, text, className, id);
    el.appendChild(item);
  } else {
    item.className = `live-session-item ${className}`;
    const time = item.querySelector<HTMLElement>('.live-session-time');
    const body = item.querySelector<HTMLElement>('.live-session-text');
    if (time) time.textContent = formatOffset(offsetMs);
    if (body) body.textContent = text.trim();
  }
  el.scrollTop = el.scrollHeight;
}

function renderInterim(text: string, offsetMs = Math.max(0, Date.now() - liveStartedAt)): void {
  if (!transcriptListEl) return;
  if (!text.trim()) {
    interimEl?.remove();
    interimEl = null;
    hasInterimTranscript = false;
    updateAskEnabled();
    return;
  }
  removeEmpty(transcriptListEl);
  if (!interimEl) {
    interimEl = makeLiveTextItem(offsetMs, text, 'live-session-item-interim');
    interimEl.setAttribute('aria-label', '인식 중…');
    const draft = document.createElement('span');
    draft.className = 'live-source-draft-label';
    draft.textContent = '인식 중…';
    interimEl.prepend(draft);
    transcriptListEl.appendChild(interimEl);
  } else {
    const time = interimEl.querySelector<HTMLElement>('.live-session-time');
    const body = interimEl.querySelector<HTMLElement>('.live-session-text');
    if (time) time.textContent = formatOffset(offsetMs);
    if (body) body.textContent = text.trim();
  }
  hasInterimTranscript = true;
  transcriptListEl.scrollTop = transcriptListEl.scrollHeight;
  updateAskEnabled();
}

function renderTranslationInterim(
  text: string,
  offsetMs = Math.max(0, Date.now() - liveStartedAt),
): void {
  if (!translationListEl || translateToggleEl?.checked === false) return;
  if (!text.trim()) {
    interimTranslationEl?.remove();
    interimTranslationEl = null;
    hasInterimTranslation = false;
    updateAskEnabled();
    return;
  }
  removeEmpty(translationListEl);
  if (!interimTranslationEl) {
    interimTranslationEl = makeLiveTextItem(offsetMs, text, 'live-session-item-interim');
    translationListEl.appendChild(interimTranslationEl);
  } else {
    const time = interimTranslationEl.querySelector<HTMLElement>('.live-session-time');
    const body = interimTranslationEl.querySelector<HTMLElement>('.live-session-text');
    if (time) time.textContent = formatOffset(offsetMs);
    if (body) body.textContent = text.trim();
  }
  hasInterimTranslation = true;
  translationListEl.scrollTop = translationListEl.scrollHeight;
  updateAskEnabled();
}

function renderSegment(segment: LiveTranscriptSegment): void {
  interimEl?.remove();
  interimEl = null;
  hasInterimTranscript = false;
  interimTranslationEl?.remove();
  interimTranslationEl = null;
  hasInterimTranslation = false;
  upsertLiveText(
    transcriptListEl,
    segment.id,
    segment.offsetMs,
    segment.sourceMissing ? `원문 없음 · 번역 결과\n${segment.transcript}` : segment.transcript,
    'live-session-item-source',
  );
  if (segment.translation) {
    upsertLiveText(
      translationListEl,
      segment.id,
      segment.offsetMs,
      segment.translation,
      'live-session-item-translation',
    );
  } else if (segment.translationError && translateToggleEl?.checked !== false) {
    upsertLiveText(
      translationListEl,
      segment.id,
      segment.offsetMs,
      `Translation failed: ${segment.translationError}`,
      'live-session-item-error',
    );
  }
  hasTranscript = true;
  captionIds.add(segment.id);
  updateAskEnabled();
  renderIndicator();
}

function updateAskEnabled(): void {
  const enabled =
    !!activeSessionId &&
    !finalizingCapture &&
    (hasTranscript || hasInterimTranscript || hasInterimTranslation) &&
    !askBusy;
  if (chatInputEl) chatInputEl.disabled = !enabled;
  if (chatSendEl) chatSendEl.disabled = !enabled;
}

function appendChatMessage(role: 'user' | 'model' | 'error', text: string): HTMLElement | null {
  if (!chatMessagesEl) return null;
  removeEmpty(chatMessagesEl);
  const el = document.createElement('div');
  el.className = `chat-message chat-${role}`;
  el.textContent = text;
  chatMessagesEl.appendChild(el);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  return el;
}

function appendPendingChat(): HTMLElement | null {
  if (!chatMessagesEl) return null;
  removeEmpty(chatMessagesEl);
  const el = document.createElement('div');
  el.className = 'chat-message chat-model chat-pending';
  el.textContent = 'Thinking...';
  chatMessagesEl.appendChild(el);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  return el;
}

function realtimeOffsetMs(): number {
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
  realtimeRendererActive = false;
  realtimeTranslationFinalSent = false;
  realtimeFinalChain = Promise.resolve();
}

function reportRealtimeError(error: unknown, details?: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[live-realtime] error:', message, details ?? error);
  const callDetails = getRealtimeErrorDetails(error);
  reportError(error, {
    operation: 'live.realtime',
    severity: 'error',
    extra: callDetails
      ? { status: callDetails.status, requestId: callDetails.requestId }
      : undefined,
  });
  setStatus(message);
  appendChatMessage('error', message);
  lastLiveError = message;
  renderIndicator();
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
    offsetMs: realtimeOffsetMs(),
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
    offsetMs: realtimeOffsetMs(),
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
  if (payload.type === 'error') {
    reportRealtimeError(payload.error?.message || 'OpenAI Realtime error.', payload);
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
  preferredMimeType: string,
): Promise<void> {
  await stopRealtimeWebRtc();
  // Stop Live or a recording stop can land during any await below; a peer
  // created for a session that is no longer running must not keep the mic.
  const superseded = () => activeSessionId !== sessionId || finalizingCapture;
  if (superseded()) return;
  resetRealtimeState();
  realtimeFailureHandled = false;
  const track = stream.getAudioTracks()[0];
  if (!track) throw new Error('Live Realtime needs an audio track.');

  const peer = new RTCPeerConnection();
  realtimePeer = peer;
  realtimeEndpoint = client.endpoint;
  realtimeRendererActive = true;
  peer.addTrack(track, stream);
  peer.ontrack = () => {
    // Translation sessions may return audio; Listener.AI only displays text.
  };
  peer.onconnectionstatechange = () => {
    if (peer.connectionState === 'failed') {
      // Failure after the SDP handshake succeeded: fall back instead of freezing
      // captions (realtimeRendererActive otherwise blocks PCM from reaching main).
      void fallbackFromRealtimeFailure(
        sessionId,
        new Error('OpenAI Realtime connection failed.'),
        stream,
        preferredMimeType,
      );
    }
  };

  const events = peer.createDataChannel('oai-events');
  realtimeDataChannel = events;
  events.onmessage = (event) => handleRealtimeMessage(sessionId, String(event.data));
  events.onerror = () => reportRealtimeError('OpenAI Realtime event channel failed.');
  if (client.endpoint === 'realtime') {
    // gpt-realtime-whisper transcription sessions disable turn detection, so the
    // server never auto-commits the input buffer. Commit on an interval to keep
    // incremental transcription events flowing (mirrors the WebSocket fallback).
    events.onopen = () => {
      realtimeCommitTimer = setInterval(() => {
        if (events.readyState === 'open') {
          events.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        }
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
  setStatus('Listening with OpenAI Realtime...');
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
    // with a final commit and wait for the completion event (which queues the
    // final segment via handleRealtimeMessage) before tearing down.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_500);
      const previous = events.onmessage;
      events.onmessage = (event) => {
        previous?.call(events, event);
        try {
          const payload = JSON.parse(String(event.data)) as { type?: string };
          if (payload.type === 'conversation.item.input_audio_transcription.completed') {
            clearTimeout(timer);
            resolve();
          }
        } catch {
          // ignore
        }
      };
      events.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    });
    await realtimeFinalChain.catch(() => {});
  }
  realtimeDataChannel = null;
  realtimePeer = null;
  if (peer) peer.close();
  resetRealtimeState();
}

async function fallbackFromRealtimeFailure(
  sessionId: string,
  error: unknown,
  fallbackStream: MediaStream,
  preferredMimeType: string,
): Promise<void> {
  if (activeSessionId !== sessionId || realtimeFailureHandled) return;
  realtimeFailureHandled = true;
  realtimeRendererActive = false;
  reportRealtimeError(error, getRealtimeErrorDetails(error));
  await stopRealtimeWebRtc(sessionId).catch(() => {});
  if (activeSessionId !== sessionId) return;
  const fallback = await window.electronAPI.handleLiveRealtimeFailure({
    sessionId,
    error: getErrorMessage(error),
  });
  if (activeSessionId !== sessionId) return;
  if (fallback.success) {
    captureMode = fallback.session.mode;
    lastLiveError = null;
    setStatus(
      fallback.session.mode === 'streaming'
        ? `Listening with ${fallback.session.provider}...`
        : 'Listening with fallback...',
    );
    if (fallback.session.mode === 'chunked') {
      startFallbackWindow(fallbackStream, preferredMimeType);
    }
    updateAskEnabled();
    renderIndicator();
    return;
  }
  reportRealtimeError(fallback.error);
  await window.electronAPI.stopLiveSession(sessionId).catch(() => {});
  if (activeSessionId === sessionId) {
    activeSessionId = null;
    captureMode = null;
    endedReason = 'failed';
    lastLiveError = fallback.error;
  }
  updateAskEnabled();
  renderIndicator();
}

function queueFallbackBlob(
  blob: Blob,
  offsetMs: number,
  durationMs: number,
  sessionId: string,
): void {
  if (blob.size < MIN_LIVE_BLOB_BYTES) return;
  const translate = translateToggleEl?.checked !== false;
  processingChain = processingChain
    .catch(() => {})
    .then(async () => {
      if (stoppingCapture || activeSessionId !== sessionId) return;
      setStatus('Processing fallback audio...');
      const audioData = await blob.arrayBuffer();
      if (stoppingCapture || activeSessionId !== sessionId) return;
      const result = await window.electronAPI.processLiveAudioChunk({
        sessionId,
        audioData,
        mimeType: blob.type || 'audio/webm',
        offsetMs,
        durationMs,
        translate,
      });
      if (stoppingCapture || activeSessionId !== sessionId) return;
      if (activeSessionId !== sessionId) return;
      if (result.success) {
        lastLiveError = null;
        if (result.segment) renderSegment(result.segment);
        setStatus(stoppingCapture ? 'Finalizing live transcript...' : 'Listening with fallback...');
        renderIndicator();
        return;
      }
      setStatus(result.error || 'Live transcript failed.');
      lastLiveError = result.error || 'Live transcript failed.';
      renderIndicator();
    })
    .catch((err) => {
      if (stoppingCapture || activeSessionId !== sessionId) return;
      setStatus(err instanceof Error ? err.message : String(err));
      lastLiveError = err instanceof Error ? err.message : String(err);
      renderIndicator();
    });
}

function startFallbackWindow(stream: MediaStream, preferredMimeType: string): void {
  if (!activeSessionId || stoppingCapture || captureMode !== 'chunked') return;
  liveWindowChunks = [];
  liveWindowStartedAt = Date.now();

  let recorder: MediaRecorder;
  try {
    recorder = preferredMimeType
      ? new MediaRecorder(stream, { mimeType: preferredMimeType })
      : new MediaRecorder(stream);
  } catch {
    recorder = new MediaRecorder(stream);
  }

  liveRecorder = recorder;
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) liveWindowChunks.push(event.data);
  };
  recorder.onstop = () => {
    const sessionId = activeSessionId;
    const chunks = liveWindowChunks;
    const offsetMs = Math.max(0, liveWindowStartedAt - liveStartedAt);
    const durationMs = Math.max(0, Date.now() - liveWindowStartedAt);
    liveWindowChunks = [];
    liveRecorder = null;
    if (!stoppingCapture && sessionId && chunks.length > 0) {
      queueFallbackBlob(
        new Blob(chunks, { type: recorder.mimeType || preferredMimeType }),
        offsetMs,
        durationMs,
        sessionId,
      );
    }
    if (!stoppingCapture && activeSessionId && captureMode === 'chunked') {
      startFallbackWindow(stream, preferredMimeType);
    }
  };
  recorder.start();
  liveRecorderTimer = setTimeout(() => {
    if (recorder.state === 'recording') recorder.stop();
  }, FALLBACK_SNIPPET_MS);
}

function stopActiveFallbackRecorder(sessionId: string): Promise<void> {
  if (liveRecorderTimer) {
    clearTimeout(liveRecorderTimer);
    liveRecorderTimer = null;
  }
  const recorder = liveRecorder;
  if (!recorder || recorder.state === 'inactive') return Promise.resolve();
  return new Promise((resolve) => {
    // Final flush: queue this last window (the normal onstop refuses once we
    // begin tearing down) and do NOT restart another window.
    recorder.onstop = () => {
      const chunks = liveWindowChunks;
      const offsetMs = Math.max(0, liveWindowStartedAt - liveStartedAt);
      const durationMs = Math.max(0, Date.now() - liveWindowStartedAt);
      liveWindowChunks = [];
      liveRecorder = null;
      if (sessionId && chunks.length > 0) {
        queueFallbackBlob(
          new Blob(chunks, { type: recorder.mimeType || '' }),
          offsetMs,
          durationMs,
          sessionId,
        );
      }
      resolve();
    };
    recorder.stop();
  });
}

async function finalizeStoppedSession(
  sessionId: string,
  chain: Promise<void>,
  opts: { hidePanel?: boolean } = {},
): Promise<void> {
  let result: Awaited<ReturnType<typeof window.electronAPI.stopLiveSession>>;
  try {
    result = await window.electronAPI.stopLiveSession(sessionId);
  } catch (err) {
    result = { success: false, error: err instanceof Error ? err.message : String(err) };
  }
  await chain.catch(() => {});
  captureMode = null;
  stoppingCapture = false;
  updateAskEnabled();
  if (result.success) {
    setStatus(opts.hidePanel ? 'Live session stopped.' : 'Live transcript ready.');
  } else {
    setStatus(result.error || 'Live session stopped.');
  }
  if (opts.hidePanel) hidePanel();
}

export async function startLiveSession(
  title: string,
  fallbackStream: MediaStream,
  preferredMimeType: string,
  expectedStartVersion = startCancellationVersion,
): Promise<void> {
  const token = ++startToken;
  startingSession = true;
  renderIndicator();
  try {
    await startLiveSessionNow(title, fallbackStream, preferredMimeType, expectedStartVersion);
  } finally {
    if (startToken === token) startingSession = false;
    renderIndicator();
  }
}

async function startLiveSessionNow(
  title: string,
  fallbackStream: MediaStream,
  preferredMimeType: string,
  expectedStartVersion: number,
): Promise<void> {
  let startVersion = expectedStartVersion;
  if (activeSessionId) {
    const oldSessionId = activeSessionId;
    await stopLiveSessionCapture();
    if (activeSessionId === oldSessionId) activeSessionId = null;
    startVersion = startCancellationVersion;
  }
  resetLiveUi();
  stoppingCapture = false;
  processingChain = Promise.resolve();
  liveStartedAt = Date.now();
  const result = await window.electronAPI.startLiveSession({
    title,
    translate: translateToggleEl?.checked !== false,
  });
  if (!result.success) {
    activeSessionId = null;
    captureMode = null;
    if (startVersion === startCancellationVersion) {
      endedReason = 'failed';
      lastLiveError = result.error || 'Live session unavailable.';
    }
    setStatus(result.error || 'Live session unavailable.');
    updateAskEnabled();
    return;
  }
  if (startVersion !== startCancellationVersion || !launcher) {
    await window.electronAPI.stopLiveSession(result.session.sessionId).catch(() => {});
    activeSessionId = null;
    captureMode = null;
    endedReason = 'user';
    setStatus('Live session stopped.');
    updateAskEnabled();
    return;
  }
  activeSessionId = result.session.sessionId;
  captureMode = result.session.mode;
  const startedSessionId = activeSessionId;
  hints?.pending();
  try {
    const { snapshot } = await window.electronAPI.getLiveSessionSnapshot();
    if (activeSessionId !== startedSessionId || startVersion !== startCancellationVersion) return;
    if (snapshot?.sessionId === startedSessionId && snapshot.hints)
      renderHintSnapshot(snapshot.hints);
  } catch {
    // Normal hint status events keep the panel current if the initial snapshot fails.
  }
  if (activeSessionId !== startedSessionId || startVersion !== startCancellationVersion) return;
  hints?.active(hintModeReady);
  if (!hintModeReady) hints?.pending();
  setStatus(
    result.session.mode === 'streaming'
      ? `Listening with ${result.session.provider}...`
      : 'Listening with fallback...',
  );
  if (result.session.realtimeClient) {
    const sessionId = result.session.sessionId;
    try {
      await startRealtimeWebRtc(
        sessionId,
        result.session.realtimeClient,
        fallbackStream,
        preferredMimeType,
      );
    } catch (error) {
      await fallbackFromRealtimeFailure(sessionId, error, fallbackStream, preferredMimeType);
    }
    return;
  }
  if (result.session.mode === 'chunked') {
    if (typeof MediaRecorder === 'undefined') {
      setStatus('Live fallback is unavailable in this browser.');
      lastLiveError = 'Live fallback is unavailable in this browser.';
      return;
    }
    startFallbackWindow(fallbackStream, preferredMimeType);
  }
  updateAskEnabled();
}

export function configureLiveSessionLauncher(
  title: string,
  fallbackStream: MediaStream,
  preferredMimeType: string,
): void {
  startCancellationVersion++;
  launcher = { title, fallbackStream, preferredMimeType, startVersion: startCancellationVersion };
  renderIndicator();
}

export function clearLiveSessionLauncher(): void {
  startCancellationVersion++;
  launcher = null;
  renderIndicator();
}

export function handleLivePcmFrame(frame: LivePcmFrame): void {
  if (!activeSessionId || captureMode !== 'streaming' || stoppingCapture || realtimeRendererActive)
    return;
  const durationMs = Math.round((frame.frames / frame.sampleRate) * 1000);
  const offsetMs = Math.max(0, Date.now() - liveStartedAt - durationMs);
  window.electronAPI.sendLivePcmChunk({
    sessionId: activeSessionId,
    audioData: frame.audioData,
    sampleRate: frame.sampleRate,
    channelCount: frame.channelCount,
    offsetMs,
    durationMs,
    sequence: frame.sequence,
  });
}

export async function stopLiveSessionCapture(opts: { hidePanel?: boolean } = {}): Promise<void> {
  startCancellationVersion++;
  if (launcher) launcher.startVersion = startCancellationVersion;
  if (finalizeCapturePromise) {
    if (opts.hidePanel) hidePanel();
    renderIndicator();
    await finalizeCapturePromise;
    return;
  }
  if (!activeSessionId) {
    if (opts.hidePanel) hidePanel();
    renderIndicator();
    return;
  }
  finalizingCapture = true;
  finalizeCapturePromise = finishLiveSessionCapture(activeSessionId, opts);
  try {
    await finalizeCapturePromise;
  } finally {
    finalizeCapturePromise = null;
  }
}

async function finishLiveSessionCapture(sessionId: string, opts: { hidePanel?: boolean }): Promise<void> {
  const mode = captureMode;
  setStatus('Finalizing live transcript...');
  updateAskEnabled();
  renderIndicator();
  try {
    hints?.active(false);
    try {
      const stopped = await window.electronAPI.beginLiveSessionStop(sessionId);
      if (!stopped.success) hints?.status(stopped.error);
    } catch (error) {
      hints?.status(error instanceof Error ? error.message : String(error));
    }
    await stopRealtimeWebRtc(sessionId);
    if (mode === 'chunked') {
      // Flush the in-progress window and let any queued/in-flight fallback work
      // finish while the main session is still active, so the final captions
      // aren't dropped.
      await stopActiveFallbackRecorder(sessionId);
      await processingChain.catch(() => {});
    }
    stoppingCapture = true;
    processingChain = Promise.resolve();
    // Keep activeSessionId set through stopLiveSession: closing a streaming
    // provider in main flushes its final `segment` events, and
    // handleLiveSessionEvent drops any event whose sessionId != activeSessionId.
    await finalizeStoppedSession(sessionId, Promise.resolve(), opts);
    if (activeSessionId === sessionId) {
      activeSessionId = null;
      endedReason = 'user';
      hints?.active(false);
    }
  } finally {
    finalizingCapture = false;
    updateAskEnabled();
    renderIndicator();
  }
  // Stop hides itself; keep keyboard focus inside the open dialog.
  if (panelEl?.open && focusIsInPanelOrLost()) focusInsidePanel();
}

async function submitLiveQuestion(question: string): Promise<void> {
  if (!activeSessionId || !question.trim() || askBusy) return;
  const sessionId = activeSessionId;
  askBusy = true;
  updateAskEnabled();
  appendChatMessage('user', question);
  if (chatInputEl) chatInputEl.value = '';
  const pending = appendPendingChat();
  try {
    const result = await window.electronAPI.askLiveSession({
      sessionId,
      question,
      history: liveHistory,
    });
    if (activeSessionId !== sessionId) return;
    pending?.remove();
    if (result.success) {
      appendChatMessage('model', result.result.answer || '(no answer)');
      liveHistory = result.result.history || liveHistory;
    } else {
      appendChatMessage('error', result.error || 'Live question failed.');
    }
  } catch (err) {
    if (activeSessionId !== sessionId) return;
    pending?.remove();
    appendChatMessage('error', err instanceof Error ? err.message : String(err));
  } finally {
    if (activeSessionId === sessionId) {
      askBusy = false;
      updateAskEnabled();
      const askPanel = document.getElementById('liveSessionAsk') as HTMLDetailsElement | null;
      if (panelEl?.open && askPanel?.open) chatInputEl?.focus();
    }
  }
}

function renderHint(hint: LiveHint, replay = false): void {
  hint.sources.forEach((source) => hintSources.set(source.ref, source));
  for (const ref of hintSources.keys()) {
    if (ref.startsWith(`${hint.id}:revision:`)) hintSources.delete(ref);
  }
  const kinds = {
    term: '용어',
    answer: '답변 참고',
    question: '확인 질문',
    action: '할 일 후보',
    'catch-up': '놓친 내용',
  };
  const bases = {
    transcript: '대화 내용을 참고했습니다.',
    'model-knowledge': '대화 밖의 설명이 포함되어 있으니 확인해 주세요.',
    suggestion: '아직 결정되지 않은 제안입니다.',
  };
  hints?.add(
    {
      id: hint.id,
      title: hint.title,
      topicId: hint.topic?.id,
      topicLabel: hint.topic?.label,
      anchorOffsetMs: hint.anchorOffsetMs,
      offsetMs: hint.offsetMs,
      updatedOffsetMs: hint.updatedOffsetMs,
      history: hint.history?.map((entry) => ({
        ...entry,
        sources: entry.sources?.map((source) => {
          const id = `${hint.id}:revision:${entry.revision}:${source.ref}`;
          hintSources.set(id, source);
          return {
            id,
            offsetMs: source.offsetMs,
            label: `${source.uncertain ? '불확실 원문 · ' : ''}${formatOffset(source.offsetMs)} ${Array.from(source.text).slice(0, 45).join('')}`,
            draft: source.state === 'draft',
          };
        }),
      })),
      text: hint.text,
      detail: hint.detail,
      kind: kinds[hint.kind],
      suggestion: hint.basis.includes('suggestion'),
      basis: hint.basis.map((basis) => bases[basis]).join(' · '),
      retracted: hint.sourceState === 'retracted',
      draft: hint.sourceState === 'draft',
      simulated: hint.example,
      sources: hint.sources.map((source) => ({
        id: source.ref,
        offsetMs: source.offsetMs,
        label: `${source.uncertain ? '불확실 원문 · ' : ''}${formatOffset(source.offsetMs)} ${Array.from(source.text).slice(0, 45).join('')}`,
        draft: source.state === 'draft',
      })),
    },
    { replay },
  );
}

// readOnly: a renderer-lost session recovered after a reload. Its hints only
// update the retained history; controls, launcher status and retry prompts
// belong to the next live session.
function renderHintSnapshot(snapshot: LiveHintsSnapshot, readOnly = false): void {
  for (const hint of snapshot.hints) renderHint(hint, true);
  renderHintStatus(snapshot.status, readOnly);
}

function renderHintStatus(status: LiveHintsSnapshot['status'], readOnly = false): void {
  if (!readOnly) hintModeReady = true;
  if (!readOnly && activeSessionId && !stoppingCapture && !finalizingCapture && status.state !== 'stopped')
    hints?.active(true);
  const labels = {
    off: '자동 생성 꺼짐',
    listening: '대화 듣는 중',
    generating: '힌트 생성 중 · 자막은 계속 표시됩니다',
    paused: '자동 생성 대기',
    limited: '요청 한도 도달',
    unavailable: '힌트 사용 불가 · 자막은 계속 표시됩니다',
    stopped: '힌트 생성 종료',
  };
  hints?.mode(status.mode === 'auto');
  hints?.status(
    `${status.example ? '모의 응답 · ' : ''}${labels[status.state]}${status.reason ? ` · ${status.reason}` : ''} · 요청 ${status.callsLastHour}/${status.callsPerHourLimit}`,
    readOnly
      ? ''
      : status.state === 'unavailable'
        ? '힌트를 불러오지 못했습니다. AI 연결이 복구되면 자동으로 다시 시도합니다.'
        : status.state === 'limited'
          ? '힌트 요청 한도에 도달했습니다. 잠시 후 자동으로 다시 시작합니다.'
          : status.state === 'paused' && status.reason
            ? '원문 자막을 사용할 수 없어 힌트 생성을 기다리고 있습니다.'
            : '',
  );
}

function jumpToHintSource(id: string, returnToHint?: () => void): void {
  if (!transcriptListEl) return;
  let item = transcriptListEl.querySelector<HTMLElement>(
    `[data-live-segment-id="${CSS.escape(id)}"]`,
  );
  const source = hintSources.get(id);
  if (!item && source) {
    item = makeLiveTextItem(
      source.offsetMs,
      `${source.state === 'draft' ? '인식 중이던 자막' : '인용 원문'}\n${source.text}`,
      'live-session-item-source',
      id,
    );
    transcriptListEl.append(item);
  }
  transcriptListEl.querySelectorAll('[data-hint-return]').forEach((button) => button.remove());
  if (item && returnToHint) {
    const back = document.createElement('button');
    back.type = 'button';
    back.dataset.hintReturn = '';
    back.textContent = '힌트로 돌아가기';
    back.addEventListener('click', () => {
      // Reveal the hints tab before live-hints moves focus back to the card.
      layout?.showHints();
      returnToHint();
    });
    item.append(back);
  }
  if (!item) return;
  // A hidden tab panel can neither scroll nor take focus.
  layout?.showSource();
  item.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  item.focus({ preventScroll: true });
}

function handleLiveSessionEvent(event: LiveSessionEvent): void {
  if (recoveredSessionId && event.sessionId === recoveredSessionId && !activeSessionId) {
    // Finals flushed while main closed the provider after the reload. The
    // first one can arrive after an empty snapshot.
    if (event.type === 'segment') {
      renderSegment(event.segment);
      setStatus(RECOVERED_STATUS);
    } else if (event.type === 'hint' || event.type === 'hintUpdated') {
      // Late hints only update the retained history: no preview, no controls.
      renderHint(event.hint, true);
    } else if (event.type === 'hintStatus') {
      renderHintStatus(event.status, true);
    }
    return;
  }
  if (event.sessionId !== activeSessionId) return;
  if (event.type === 'hint' || event.type === 'hintUpdated') {
    renderHint(event.hint);
  } else if (event.type === 'hintStatus') {
    renderHintStatus(event.status);
  } else if (event.type === 'status') {
    lastLiveError = null;
    setStatus(event.status);
    renderIndicator();
  } else if (event.type === 'interim') {
    renderInterim(event.text, event.offsetMs);
  } else if (event.type === 'translationInterim') {
    renderTranslationInterim(event.text, event.offsetMs);
  } else if (event.type === 'segment') {
    lastLiveError = null;
    renderSegment(event.segment);
  } else if (event.type === 'error') {
    // Update the indicator only: a minimized dialog stays closed and focus
    // stays where the user left it.
    lastLiveError = event.error;
    setStatus(event.error);
    appendChatMessage('error', event.error);
    renderIndicator();
  }
}

// After a reload, main has already ended the session the previous page was
// capturing (endedReason 'renderer-lost'). Offer what it kept, read-only.
async function restoreRendererLostSession(): Promise<void> {
  let response: Awaited<ReturnType<typeof window.electronAPI.getLiveSessionSnapshot>>;
  try {
    response = await window.electronAPI.getLiveSessionSnapshot();
  } catch {
    return;
  }
  const snapshot = response?.snapshot;
  if (!snapshot || snapshot.active || snapshot.endedReason !== 'renderer-lost') return;
  // The user may have started a new session while the snapshot was in flight.
  if (activeSessionId || startingSession || finalizingCapture || captionIds.size > 0) return;
  // Claim the session even when it has no segments yet: main may still flush
  // finals while it closes the provider. An empty recovery stays hidden (see
  // describeLiveIndicator) until a segment arrives.
  recoveredSessionId = snapshot.sessionId;
  endedReason = 'renderer-lost';
  lastLiveError = null;
  for (const segment of snapshot.segments) renderSegment(segment);
  // Retained hints replay silently; the hint controls stay disabled.
  if (snapshot.hints) renderHintSnapshot(snapshot.hints, true);
  if (snapshot.segments.length > 0) setStatus(RECOVERED_STATUS);
  renderIndicator();
}

export function setupLiveSession(): void {
  panelEl = document.getElementById('liveSessionPanel') as HTMLDialogElement | null;
  launcherEl = document.getElementById('liveSessionLauncher');
  startButtonEl = document.getElementById('liveSessionStartButton') as HTMLButtonElement | null;
  indicatorEl = document.getElementById('liveSessionIndicator');
  indicatorStatusEl = document.getElementById('liveSessionIndicatorStatus');
  indicatorDetailEl = document.getElementById('liveSessionIndicatorDetail');
  closeButtonEl = document.getElementById('liveSessionCloseButton') as HTMLButtonElement | null;
  minimizeButtonEl = document.getElementById(
    'liveSessionMinimizeButton',
  ) as HTMLButtonElement | null;
  restartButtonEl = document.getElementById('liveSessionRestartButton') as HTMLButtonElement | null;
  statusEl = document.getElementById('liveSessionStatus');
  translateToggleEl = document.getElementById('liveTranslateToggle') as HTMLInputElement | null;
  transcriptListEl = document.getElementById('liveTranscriptList');
  translationListEl = document.getElementById('liveTranslationList');
  chatMessagesEl = document.getElementById('liveChatMessages');
  chatFormEl = document.getElementById('liveChatForm') as HTMLFormElement | null;
  chatInputEl = document.getElementById('liveChatInput') as HTMLInputElement | null;
  chatSendEl = document.getElementById('liveChatSend') as HTMLButtonElement | null;
  layout = setupLiveSessionLayout();

  hints = setupLiveHints({
    source: jumpToHintSource,
  });
  hints.active(false);
  translateToggleEl?.addEventListener('change', updateTranslationVisibility);
  updateTranslationVisibility();

  startButtonEl?.addEventListener('click', () => {
    if (currentIndicatorView().opensDialog) {
      showPanel();
      return;
    }
    if (!launcher) {
      showPanel();
      setStatus('Start recording before opening live captions.');
      return;
    }
    startFromLauncher();
  });
  restartButtonEl?.addEventListener('click', startFromLauncher);
  // Stop ends captions but keeps the dialog open on the final transcript;
  // Minimize (or Escape) only hides the dialog.
  closeButtonEl?.addEventListener('click', () => {
    void stopLiveSessionCapture();
  });
  minimizeButtonEl?.addEventListener('click', minimizePanel);
  panelEl?.addEventListener('keydown', (event) => {
    // Escape while composing Hangul cancels the composition, not the dialog.
    if (event.key === 'Escape' && (event.isComposing || askInputComposing)) {
      event.preventDefault();
    }
  });
  panelEl?.addEventListener('cancel', (event) => {
    // Escape minimizes; the default close would skip focus return.
    event.preventDefault();
    if (askInputComposing) return;
    minimizePanel();
  });
  panelEl?.addEventListener('close', () => {
    // Also covers a close the browser forces without a cancel event.
    if (focusIsInPanelOrLost()) returnFocusToLauncher();
    renderIndicator();
  });

  chatInputEl?.addEventListener('compositionstart', () => {
    askInputComposing = true;
  });
  chatInputEl?.addEventListener('compositionend', () => {
    askInputComposing = false;
  });
  chatInputEl?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.isComposing) {
      event.preventDefault();
    }
  });
  chatFormEl?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (askInputComposing) return;
    void submitLiveQuestion(chatInputEl?.value.trim() || '');
  });
  window.electronAPI.onLiveSessionEvent(handleLiveSessionEvent);
  updateAskEnabled();
  renderIndicator();
  void restoreRendererLostSession();
}

function startFromLauncher(): void {
  const current = launcher;
  if (!current || startingSession || finalizingCapture) return;
  void startLiveSession(
    current.title,
    current.fallbackStream,
    current.preferredMimeType,
    current.startVersion,
  );
}
