// Live-caption dialog and main-screen launcher. A pure observer: capture and
// transport (PCM, the OpenAI Realtime peer, chunked uploads) run in the hidden
// capture host, routed by main, and LiveSessionService in main owns the
// session. This window requests start/stop, renders main's events, and on load
// reattaches to a running session from the snapshot, so a reload, crash or a
// recreated window never ends or restarts captions.
import type {
  AgentChatMessage,
  LiveSessionEvent,
  LiveSessionSnapshot,
  LiveTranscriptSegment,
} from '../electronAPI';
import {
  describeLiveIndicator,
  type LiveIndicatorEndReason,
  type LiveIndicatorPhase,
  type LiveIndicatorView,
} from '../../src/liveSessionView';
import { setupLiveHints } from './live-hints';
import { setupLiveSessionLayout } from './live-session-layout';
import type { LiveHint, LiveHintSource, LiveHintsSnapshot } from '../../src/liveHintTypes';

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
let liveStartedAt = 0;
let finalizingCapture = false;
let finalizeCapturePromise: Promise<void> | null = null;
let launcher: {
  title: string;
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
// Main-screen indicator state (see src/liveSessionView.ts).
let startingSession = false;
let startToken = 0;
let endedReason: LiveIndicatorEndReason | null = null;
let lastLiveError: string | null = null;
let captionIds = new Set<string>();
// A session main ended because the capture host crashed or closed; its
// remaining segment events are still rendered, read-only.
let recoveredSessionId: string | null = null;
const RECOVERED_STATUS =
  'Live captions ended when audio capture stopped. This transcript is read-only.';

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

async function finalizeStoppedSession(
  sessionId: string,
  opts: { hidePanel?: boolean } = {},
): Promise<LiveSessionSnapshot | null> {
  let result: Awaited<ReturnType<typeof window.electronAPI.stopLiveSession>>;
  try {
    // Main fences hints, lets the capture host flush its tail (final WebRTC
    // commit, last chunked window), then closes the provider.
    result = await window.electronAPI.stopLiveSession(sessionId);
  } catch (err) {
    result = { success: false, error: err instanceof Error ? err.message : String(err) };
  }
  updateAskEnabled();
  if (result.success) {
    setStatus(opts.hidePanel ? 'Live session stopped.' : 'Live transcript ready.');
  } else {
    setStatus(result.error || 'Live session stopped.');
  }
  if (opts.hidePanel) hidePanel();
  return result.success ? result.snapshot : null;
}

export async function startLiveSession(
  title: string,
  expectedStartVersion = startCancellationVersion,
): Promise<void> {
  const token = ++startToken;
  startingSession = true;
  renderIndicator();
  try {
    await startLiveSessionNow(title, expectedStartVersion);
  } finally {
    if (startToken === token) startingSession = false;
    renderIndicator();
  }
}

async function startLiveSessionNow(title: string, expectedStartVersion: number): Promise<void> {
  let startVersion = expectedStartVersion;
  if (activeSessionId) {
    const oldSessionId = activeSessionId;
    await stopLiveSessionCapture();
    if (activeSessionId === oldSessionId) activeSessionId = null;
    startVersion = startCancellationVersion;
  }
  resetLiveUi();
  liveStartedAt = Date.now();
  // Main starts the session and hands its capture to the hidden capture host.
  const result = await window.electronAPI.startLiveSession({
    title,
    translate: translateToggleEl?.checked !== false,
  });
  if (!result.success) {
    activeSessionId = null;
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
    endedReason = 'user';
    setStatus('Live session stopped.');
    updateAskEnabled();
    return;
  }
  activeSessionId = result.session.sessionId;
  liveStartedAt = Date.parse(result.session.startedAt) || liveStartedAt;
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
  updateAskEnabled();
}

export function configureLiveSessionLauncher(title: string): void {
  startCancellationVersion++;
  launcher = { title, startVersion: startCancellationVersion };
  renderIndicator();
}

export function clearLiveSessionLauncher(): void {
  startCancellationVersion++;
  launcher = null;
  renderIndicator();
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

async function finishLiveSessionCapture(
  sessionId: string,
  opts: { hidePanel?: boolean },
): Promise<void> {
  setStatus('Finalizing live transcript...');
  updateAskEnabled();
  renderIndicator();
  try {
    hints?.active(false);
    // Keep activeSessionId set through stopLiveSession: closing a streaming
    // provider in main flushes its final `segment` events, and
    // handleLiveSessionEvent drops any event whose sessionId != activeSessionId.
    const stopped = await finalizeStoppedSession(sessionId, opts);
    // The stop's snapshot holds every final, including the tail the capture
    // host flushed during the stop; its segment events can reach this window
    // after the reply, when they no longer match the active session.
    if (stopped?.sessionId === sessionId) {
      for (const segment of stopped.segments) renderSegment(segment);
    }
    if (activeSessionId === sessionId) {
      activeSessionId = null;
      hints?.active(false);
      if (stopped?.endedReason === 'renderer-lost') {
        // This stop joined main's teardown after the capture host was lost.
        recoveredSessionId = sessionId;
        endedReason = 'renderer-lost';
        setStatus(RECOVERED_STATUS);
      } else {
        endedReason = 'user';
      }
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

// readOnly: a session that ended with its capture host. Its hints only
// update the retained history; controls, launcher status and retry prompts
// belong to the next live session.
function renderHintSnapshot(snapshot: LiveHintsSnapshot, readOnly = false): void {
  for (const hint of snapshot.hints) renderHint(hint, true);
  renderHintStatus(snapshot.status, readOnly);
}

function renderHintStatus(status: LiveHintsSnapshot['status'], readOnly = false): void {
  if (!readOnly) hintModeReady = true;
  if (!readOnly && activeSessionId && !finalizingCapture && status.state !== 'stopped')
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
    // Finals flushed while main closed the provider after the capture host
    // was lost. The first one can arrive after an empty snapshot.
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
  } else if (event.type === 'ended') {
    endFromMain(event);
  }
}

// Main ended the session this window shows without a Stop from here: a
// recording stop from the tray, shortcut or quit, a capture failure, or the
// loss of the capture host. This window's own Stop finishes its own state.
function endFromMain(event: Extract<LiveSessionEvent, { type: 'ended' }>): void {
  if (finalizingCapture || event.sessionId !== activeSessionId) return;
  activeSessionId = null;
  interimEl?.remove();
  interimEl = null;
  hasInterimTranscript = false;
  interimTranslationEl?.remove();
  interimTranslationEl = null;
  hasInterimTranslation = false;
  hints?.active(false);
  if (event.error) {
    endedReason = 'failed';
    lastLiveError = event.error;
    setStatus(event.error);
  } else if (event.reason === 'renderer-lost') {
    // Late finals and hint revisions still render, read-only.
    recoveredSessionId = event.sessionId;
    endedReason = 'renderer-lost';
    lastLiveError = null;
    setStatus(RECOVERED_STATUS);
  } else {
    endedReason = 'user';
    setStatus('Live session stopped.');
  }
  updateAskEnabled();
  renderIndicator();
}

// A reloaded or recreated window reattaches to the session main keeps
// running in the capture host: same session, captions, hints, Ask and Stop.
// The dialog stays closed and focus stays put until the user opens it.
function reattachActiveSession(snapshot: LiveSessionSnapshot): void {
  activeSessionId = snapshot.sessionId;
  liveStartedAt = Date.parse(snapshot.startedAt) || Date.now();
  recoveredSessionId = null;
  endedReason = null;
  lastLiveError = null;
  if (translateToggleEl) translateToggleEl.checked = snapshot.translate;
  layout?.setTranslationEnabled(snapshot.translate);
  for (const segment of snapshot.segments) renderSegment(segment);
  if (snapshot.interimTranscript) renderInterim(snapshot.interimTranscript);
  if (snapshot.interimTranslation) renderTranslationInterim(snapshot.interimTranslation);
  if (snapshot.hints) renderHintSnapshot(snapshot.hints);
  hints?.active(hintModeReady);
  if (!hintModeReady) hints?.pending();
  setStatus(
    snapshot.mode === 'streaming'
      ? `Listening with ${snapshot.provider}...`
      : 'Listening with fallback...',
  );
  updateAskEnabled();
  renderIndicator();
}

// After a reload, reattach to a running session; a session that ended with
// its capture host (endedReason 'renderer-lost') is offered read-only.
async function restoreLiveSession(): Promise<void> {
  let response: Awaited<ReturnType<typeof window.electronAPI.getLiveSessionSnapshot>>;
  try {
    response = await window.electronAPI.getLiveSessionSnapshot();
  } catch {
    return;
  }
  const snapshot = response?.snapshot;
  if (!snapshot) return;
  // The user may have started a new session while the snapshot was in flight.
  if (activeSessionId || startingSession || finalizingCapture || captionIds.size > 0) return;
  if (snapshot.active) {
    reattachActiveSession(snapshot);
    return;
  }
  if (snapshot.endedReason !== 'renderer-lost') return;
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
  void restoreLiveSession();
}

function startFromLauncher(): void {
  const current = launcher;
  if (!current || startingSession || finalizingCapture) return;
  void startLiveSession(current.title, current.startVersion);
}
