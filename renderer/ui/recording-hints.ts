import type {
  LiveHint,
  LiveHintRevisionEntry,
  LiveHintSource,
  RecordingLiveHintsV1,
} from '../../src/liveHintTypes';

const renderedHistory = new WeakMap<HTMLElement, RecordingLiveHintsV1>();

const messages: Record<string, string> = {
  'Loading saved AI hints...': '저장된 AI 힌트를 불러오는 중…',
  'Saved AI hints could not be loaded.': '저장된 AI 힌트를 불러오지 못했습니다.',
};

function text(tag: string, value: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
}

function time(offset: number): string {
  const seconds = Math.max(0, Math.floor(offset / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function bulb(): HTMLElement {
  const icon = document.createElementNS(
    'http://www.w3.org/2000/svg',
    'svg',
  ) as unknown as HTMLElement;
  icon.classList.add('recording-hint-icon');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute(
    'd',
    'M9 18h6m-5 3h4m-2-20a7 7 0 0 0-4 12.75c.7.48 1 1.2 1 2.25h6c0-1.05.3-1.77 1-2.25A7 7 0 0 0 12 1Z',
  );
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  icon.append(path as unknown as HTMLElement);
  return icon;
}

function evidence(parent: HTMLElement, sources: LiveHintSource[], offset: number): void {
  if (!sources.length) return;
  const details = document.createElement('details');
  details.className = 'recording-hint-source';
  details.append(text('summary', '근거 자막'));
  for (const source of sources) {
    const qualification = source.uncertain ? ' · 자막이 불확실할 수 있음' : '';
    details.append(text('p', `${time(offset + source.offsetMs)}${qualification} — ${source.text}`));
  }
  parent.append(details);
}

function content(parent: HTMLElement, cue: LiveHint | LiveHintRevisionEntry, offset: number): void {
  const warning =
    cue.sourceState === 'retracted'
      ? '원문 자막이 정정되어 이 힌트는 더 이상 근거가 없습니다.'
      : cue.sourceState === 'draft'
        ? '확정 전 자막을 바탕으로 한 힌트입니다.'
        : '';
  if (warning) {
    const notice = text('p', warning);
    notice.className = 'recording-hint-warning';
    parent.append(notice);
  }
  parent.append(text('p', cue.text));
  if (cue.detail) parent.append(text('p', cue.detail));
  evidence(parent, cue.sources ?? [], offset);
}

/** Read-only and inert until selected: rendering never changes focus or sends AI requests. */
export function renderRecordingHints(
  history?: RecordingLiveHintsV1,
  message?: string,
): HTMLElement | null {
  const tabs = document.querySelector('#transcriptionModal .transcription-tabs');
  const panes = document.querySelector('#transcriptionModal .tab-content');
  if (!tabs || !panes) return null;
  const button =
    (document.getElementById('recordingHintsTab') as HTMLButtonElement | null) ??
    document.createElement('button');
  button.type = 'button';
  button.id = 'recordingHintsTab';
  button.classList.add('tab-button', 'dynamic');
  button.dataset.tab = 'recordingHints';
  button.textContent = 'AI 힌트';
  const pane = document.getElementById('recordingHints') ?? document.createElement('div');
  pane.id = 'recordingHints';
  pane.classList.add('tab-pane', 'dynamic', 'markdown-body');
  pane.setAttribute('aria-labelledby', button.id);
  if (history && renderedHistory.get(pane) === history) return pane;
  if (history) renderedHistory.set(pane, history);
  else renderedHistory.delete(pane);
  pane.replaceChildren();
  if (history?.truncated || history?.sessions.some((session) => session.truncated)) {
    const notice = text(
      'p',
      '저장 공간 제한으로 힌트 일부가 보존되지 않았습니다. 이 목록은 일부만 표시됩니다.',
    );
    notice.className = 'recording-hints-notice';
    pane.append(notice);
  }
  const cues = (history?.sessions ?? [])
    .flatMap((session) =>
      session.hints.map((hint) => ({
        hint,
        offset: session.recordingOffsetMs,
        anchor: session.recordingOffsetMs + (hint.anchorOffsetMs ?? hint.offsetMs),
      })),
    )
    .sort((a, b) => a.anchor - b.anchor);
  if (!cues.length) {
    const emptyMessage = message
      ? (messages[message] ?? message)
      : '이 녹음에는 저장된 AI 힌트가 없습니다.';
    const empty = text('p', emptyMessage);
    empty.className = 'recording-hints-empty';
    pane.append(empty);
  }
  for (const { hint, offset, anchor } of cues) {
    const entry = document.createElement('details');
    entry.className = 'recording-hint';
    const summary = document.createElement('summary');
    summary.className = 'recording-hint-summary';
    const title = text('span', hint.title || hint.text);
    title.className = 'recording-hint-title';
    summary.append(bulb(), title);
    if (hint.sourceState === 'retracted') {
      const correction = text('span', '자막 수정');
      correction.className = 'recording-hint-correction';
      summary.append(correction);
      summary.setAttribute('aria-label', `${hint.title || hint.text}, 자막 수정, ${time(anchor)}`);
    }
    const timestamp = text('time', time(anchor));
    timestamp.className = 'recording-hint-time';
    summary.append(timestamp);
    entry.append(summary);
    const provenance = (hint.basis ?? []).map(
      (basis) =>
        ({
          transcript: '대화 내용 기반',
          'model-knowledge': '일반 지식 기반 · 실제 대화와 맞는지 확인하세요',
          suggestion: 'AI 제안',
        })[basis],
    );
    if (provenance.length) {
      const details = document.createElement('details');
      details.className = 'recording-hint-provenance';
      details.append(text('summary', '힌트 정보'));
      details.append(text('p', provenance.join(' · ')));
      entry.append(details);
    }
    content(entry, hint, offset);
    if (hint.history?.length) {
      const previous = document.createElement('details');
      previous.className = 'recording-hint-revisions';
      previous.append(text('summary', `이전 내용 (${hint.history.length})`));
      for (const revision of hint.history) {
        const version = document.createElement('section');
        version.append(
          text(
            'h4',
            `${time(offset + revision.producedOffsetMs)} · 이전 문구${revision.title ? `: ${revision.title}` : ''}`,
          ),
        );
        content(version, revision, offset);
        previous.append(version);
      }
      entry.append(previous);
    }
    pane.append(entry);
  }
  if (!button.parentElement)
    tabs.insertBefore(button, tabs.querySelector('[data-tab="transcript"]'));
  if (!pane.parentElement) panes.insertBefore(pane, document.getElementById('transcript'));
  return pane;
}
