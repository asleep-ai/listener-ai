import type {
  AgentChatMessage,
  LiveSessionEvent,
  LiveSessionStartResult,
  LiveTranscriptSegment,
} from '../electronAPI';
import type { LivePcmFrame } from '../audio/graph';

const FALLBACK_SNIPPET_MS = 12_000;
const MIN_LIVE_BLOB_BYTES = 1024;

let panelEl: HTMLElement | null = null;
let startButtonEl: HTMLButtonElement | null = null;
let closeButtonEl: HTMLButtonElement | null = null;
let statusEl: HTMLElement | null = null;
let translateToggleEl: HTMLInputElement | null = null;
let translationColumnEl: HTMLElement | null = null;
let transcriptListEl: HTMLElement | null = null;
let translationListEl: HTMLElement | null = null;
let chatMessagesEl: HTMLElement | null = null;
let chatFormEl: HTMLFormElement | null = null;
let chatInputEl: HTMLInputElement | null = null;
let chatSendEl: HTMLButtonElement | null = null;

let activeSessionId: string | null = null;
let captureMode: 'streaming' | 'chunked' | null = null;
let liveRecorder: MediaRecorder | null = null;
let liveRecorderTimer: ReturnType<typeof setTimeout> | null = null;
let liveStartedAt = 0;
let liveWindowStartedAt = 0;
let liveWindowChunks: Blob[] = [];
let stoppingCapture = false;
let finalizingCapture = false;
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

function showPanel(): void {
  if (panelEl) panelEl.hidden = false;
}

function hidePanel(): void {
  if (panelEl) panelEl.hidden = true;
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
  showPanel();
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
  hasTranscript = false;
  hasInterimTranscript = false;
  hasInterimTranslation = false;
  interimTranslationEl = null;
  updateAskEnabled();
}

function updateTranslationVisibility(): void {
  const enabled = translateToggleEl?.checked !== false;
  if (translationColumnEl) translationColumnEl.hidden = !enabled;
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
    segment.transcript,
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
  updateAskEnabled();
}

function updateAskEnabled(): void {
  const enabled =
    !!activeSessionId &&
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
  setStatus(message);
  appendChatMessage('error', message);
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

  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
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
    setStatus(
      fallback.session.mode === 'streaming'
        ? `Listening with ${fallback.session.provider}...`
        : 'Listening with fallback...',
    );
    if (fallback.session.mode === 'chunked') {
      startFallbackWindow(fallbackStream, preferredMimeType);
    }
    updateAskEnabled();
    return;
  }
  reportRealtimeError(fallback.error);
  await window.electronAPI.stopLiveSession(sessionId).catch(() => {});
  if (activeSessionId === sessionId) {
    activeSessionId = null;
    captureMode = null;
  }
  updateAskEnabled();
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
        if (result.segment) renderSegment(result.segment);
        setStatus(stoppingCapture ? 'Finalizing live transcript...' : 'Listening with fallback...');
        return;
      }
      setStatus(result.error || 'Live transcript failed.');
    })
    .catch((err) => {
      if (stoppingCapture || activeSessionId !== sessionId) return;
      setStatus(err instanceof Error ? err.message : String(err));
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
    setStatus(result.error || 'Live session unavailable.');
    updateAskEnabled();
    return;
  }
  if (startVersion !== startCancellationVersion || !launcher) {
    await window.electronAPI.stopLiveSession(result.session.sessionId).catch(() => {});
    activeSessionId = null;
    captureMode = null;
    setStatus('Live session stopped.');
    updateAskEnabled();
    return;
  }
  activeSessionId = result.session.sessionId;
  captureMode = result.session.mode;
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
  if (startButtonEl) {
    startButtonEl.hidden = false;
    startButtonEl.disabled = false;
    startButtonEl.textContent = activeSessionId ? 'Open Live Transcript' : 'Live Transcript';
  }
}

export function clearLiveSessionLauncher(): void {
  startCancellationVersion++;
  launcher = null;
  if (startButtonEl) {
    startButtonEl.hidden = true;
    startButtonEl.disabled = true;
    startButtonEl.textContent = 'Live Transcript';
  }
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
  if (!activeSessionId || finalizingCapture) {
    if (opts.hidePanel) hidePanel();
    return;
  }
  finalizingCapture = true;
  const sessionId = activeSessionId;
  const mode = captureMode;
  setStatus('Finalizing live transcript...');
  updateAskEnabled();
  if (startButtonEl) startButtonEl.textContent = 'Live Transcript';
  try {
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
    activeSessionId = null;
  } finally {
    finalizingCapture = false;
  }
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
    askBusy = false;
    updateAskEnabled();
    chatInputEl?.focus();
  }
}

function handleLiveSessionEvent(event: LiveSessionEvent): void {
  if (event.sessionId !== activeSessionId) return;
  if (event.type === 'status') {
    setStatus(event.status);
  } else if (event.type === 'interim') {
    renderInterim(event.text, event.offsetMs);
  } else if (event.type === 'translationInterim') {
    renderTranslationInterim(event.text, event.offsetMs);
  } else if (event.type === 'segment') {
    renderSegment(event.segment);
  } else {
    setStatus(event.error);
    appendChatMessage('error', event.error);
  }
}

export function setupLiveSession(): void {
  panelEl = document.getElementById('liveSessionPanel');
  startButtonEl = document.getElementById('liveSessionStartButton') as HTMLButtonElement | null;
  closeButtonEl = document.getElementById('liveSessionCloseButton') as HTMLButtonElement | null;
  statusEl = document.getElementById('liveSessionStatus');
  translateToggleEl = document.getElementById('liveTranslateToggle') as HTMLInputElement | null;
  translationColumnEl = document.getElementById('liveTranslationColumn');
  transcriptListEl = document.getElementById('liveTranscriptList');
  translationListEl = document.getElementById('liveTranslationList');
  chatMessagesEl = document.getElementById('liveChatMessages');
  chatFormEl = document.getElementById('liveChatForm') as HTMLFormElement | null;
  chatInputEl = document.getElementById('liveChatInput') as HTMLInputElement | null;
  chatSendEl = document.getElementById('liveChatSend') as HTMLButtonElement | null;

  translateToggleEl?.addEventListener('change', updateTranslationVisibility);
  updateTranslationVisibility();

  startButtonEl?.addEventListener('click', () => {
    const button = startButtonEl;
    if (!button) return;
    if (activeSessionId) {
      showPanel();
      return;
    }
    if (!launcher) {
      showPanel();
      setStatus('Start recording before opening live transcript.');
      return;
    }
    const currentLauncher = launcher;
    button.disabled = true;
    void startLiveSession(
      currentLauncher.title,
      currentLauncher.fallbackStream,
      currentLauncher.preferredMimeType,
      currentLauncher.startVersion,
    ).finally(() => {
      button.disabled = false;
      button.textContent = activeSessionId ? 'Open Live Transcript' : 'Live Transcript';
    });
  });
  closeButtonEl?.addEventListener('click', () => {
    void stopLiveSessionCapture({ hidePanel: true });
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
}
