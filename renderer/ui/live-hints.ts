import {
  hintAnchor,
  hintTitle,
  orderHints,
  retainHints,
  type HintPresentation,
} from '../../src/liveHintPresentation';

/** Shared presentation for provider events and explicitly labelled example replay. */
export interface HintView extends HintPresentation {
  kind: string;
  basis?: string;
  retracted?: boolean;
  draft?: boolean;
  sources: readonly { id: string; label: string; offsetMs?: number; draft?: boolean }[];
  simulated?: boolean;
  suggestion?: boolean;
}

export function setupLiveHints(actions: {
  source: (id: string, returnToHint: () => void) => void;
}) {
  let automaticEnabled = true;
  const count = document.getElementById('liveHintsCount')!;
  const status = document.getElementById('liveHintsStatus')!;
  const errorStatus = document.getElementById('liveHintsError')!;
  const evidenceStatus = document.getElementById('liveHintsEvidenceStatus')!;
  const current = document.getElementById('liveHintsCurrent')!;
  const preview = document.getElementById('liveHintPreview')!;
  const previewAnnouncement = document.getElementById('liveHintPreviewAnnouncement')!;
  const previewMeta = document.getElementById('liveHintPreviewMeta')!;
  const previewTitle = document.getElementById('liveHintPreviewTitle')!;
  const previewText = document.getElementById('liveHintPreviewText')!;
  const previewDismiss = document.getElementById('liveHintPreviewDismiss')!;
  preview.setAttribute('aria-live', 'off');
  const cards = new Map<string, HTMLLIElement>();
  let cues: HintView[] = [];
  let active = false;
  let deferredText = false;
  let previewId: string | null = null;
  let previewReturnFocus: HTMLElement | null = null;
  let previewQueue: string[] = [];
  let previewTimer: ReturnType<typeof setInterval> | undefined;
  let previewRemaining = 0;
  let previewTick = 0;
  let previewPaused = false;
  let previewHovered = false;
  let actionError = '';
  let engineNotice = '';
  function revealAncestors(node: HTMLElement) {
    let parent = node.parentElement;
    while (parent) {
      if (parent instanceof HTMLDetailsElement) parent.open = true;
      parent = parent.parentElement;
    }
  }
  const sessionDialog = document.getElementById('liveSessionPanel') as HTMLDialogElement;
  function placePreview() {
    const parent = sessionDialog.open ? sessionDialog : document.body;
    if (preview.parentElement !== parent) parent.append(preview);
    if (previewAnnouncement.parentElement !== parent) parent.append(previewAnnouncement);
  }
  // A modal dialog makes its siblings inert; keep the nonmodal popup interactive.
  const dialogObserver = new MutationObserver(() => {
    if (!previewId) return;
    placePreview();
    if (!preview.matches(':popover-open')) preview.showPopover();
  });
  dialogObserver.observe(sessionDialog, { attributes: true, attributeFilter: ['open'] });
  function clearPreview(clearQueue = true) {
    if (previewTimer !== undefined) clearInterval(previewTimer);
    previewTimer = undefined;
    if (preview.matches(':popover-open')) preview.hidePopover();
    preview.hidden = true;
    previewAnnouncement.textContent = '';
    previewMeta.textContent = '';
    previewTitle.textContent = '';
    previewText.textContent = '';
    previewId = null;
    previewReturnFocus = null;
    previewHovered = false;
    if (clearQueue) previewQueue = [];
  }
  function isPreviewPaused() {
    const selection = window.getSelection();
    return (
      previewHovered ||
      preview.contains(document.activeElement) ||
      Boolean(selection && !selection.isCollapsed && selection.containsNode(preview, true))
    );
  }
  function updatePreview(cue: HintView) {
    const anchor = hintAnchor(cue);
    text(
      previewMeta,
      [
        cue.simulated ? '모의 응답' : '새 힌트',
        cue.suggestion ? '제안' : '',
        anchor === undefined ? '' : elapsed(anchor),
      ]
        .filter(Boolean)
        .join(' · '),
    );
    text(previewTitle, hintTitle(cue));
    text(previewText, cue.text);
  }
  function showNextPreview() {
    if (!active || previewId) return;
    let next: HintView | undefined;
    while (previewQueue.length && !next) {
      const id = previewQueue.shift();
      next = cues.find((cue) => cue.id === id && !cue.retracted);
    }
    if (!next) return;
    previewReturnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    previewId = next.id;
    preview.hidden = false;
    updatePreview(next);
    placePreview();
    preview.showPopover();
    previewAnnouncement.textContent = `새 힌트 · ${hintTitle(next)}. ${next.text}`;
    previewRemaining = 5000;
    previewTick = performance.now();
    previewPaused = isPreviewPaused();
    previewTimer = setInterval(() => {
      const now = performance.now();
      const paused = isPreviewPaused();
      // Never count time spent reading with a pointer, keyboard or text selection.
      if (!previewPaused && !paused) previewRemaining -= now - previewTick;
      previewTick = now;
      previewPaused = paused;
      if (previewRemaining <= 0) {
        clearPreview(false);
        showNextPreview();
      }
    }, 100);
  }
  preview.addEventListener('pointerenter', () => {
    previewHovered = true;
  });
  preview.addEventListener('pointerleave', () => {
    previewHovered = false;
  });
  previewDismiss.addEventListener('click', () => {
    const id = previewId;
    const previous = previewReturnFocus;
    clearPreview(false);
    const canFocus = (node: HTMLElement | null | undefined): node is HTMLElement =>
      !!node?.isConnected &&
      node !== document.body &&
      !node.closest('[inert], [hidden], dialog:not([open])') &&
      node.checkVisibility();
    const fallback = cards.get(id || '')?.querySelector<HTMLElement>('summary');
    const control = Array.from(
      document.querySelectorAll<HTMLElement>('#liveSessionPanel button, #liveSessionLauncher'),
    ).find(canFocus);
    if (canFocus(previous)) previous.focus({ preventScroll: true });
    else if (canFocus(fallback)) fallback.focus({ preventScroll: true });
    else control?.focus({ preventScroll: true });
    showNextPreview();
  });
  const renderError = () => {
    const message = actionError || engineNotice;
    errorStatus.textContent = message;
    errorStatus.hidden = !message;
  };
  const setStatus = (text: string, notice = '') => {
    if (status.textContent !== text) status.textContent = text;
    engineNotice = notice;
    renderError();
  };
  const pending = () => {
    setStatus('자동 힌트 설정 확인 중…');
  };
  document.addEventListener('selectionchange', () => {
    if (deferredText && window.getSelection()?.isCollapsed) {
      deferredText = false;
      render();
      const currentPreview = cues.find((cue) => cue.id === previewId);
      if (currentPreview) updatePreview(currentPreview);
    }
  });
  function text(node: HTMLElement, value: string) {
    if (node.textContent === value) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.containsNode(node, true)) {
      deferredText = true;
      return;
    }
    node.textContent = value;
  }
  function elapsed(offset: number) {
    const seconds = Math.floor(offset / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }
  function card(cue: HintView): HTMLLIElement {
    let row = cards.get(cue.id);
    if (!row) {
      row = document.createElement('li');
      const details = document.createElement('details');
      details.className = 'live-hint';
      details.dataset.hintId = cue.id;
      // New arrivals use the transient preview; history stays calm until opened.
      details.open = false;
      for (const tag of ['summary', 'p', 'p', 'p', 'details'] as const)
        details.append(document.createElement(tag));
      const summary = details.firstElementChild as HTMLElement;
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('aria-hidden', 'true');
      icon.classList.add('live-hint-icon');
      const bulb = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      bulb.setAttribute(
        'd',
        'M9 18h6m-5 3h4m-5.8-6.2A7 7 0 1 1 15.8 15.8c-.9.7-1.3 1.3-1.5 2.2h-4.6c-.2-.9-.6-1.5-1.5-2.2Z',
      );
      icon.append(bulb);
      const title = document.createElement('span');
      title.className = 'live-hint-title';
      const correction = document.createElement('span');
      correction.className = 'live-hint-correction';
      correction.textContent = '자막 수정';
      correction.hidden = true;
      summary.append(icon, title, correction, document.createElement('time'));
      const sourceDetails = details.children[4] as HTMLDetailsElement;
      sourceDetails.dataset.hintSourceDetails = '';
      const sourceSummary = document.createElement('summary');
      sourceSummary.textContent = '원문 보기';
      const qualification = document.createElement('p');
      qualification.dataset.hintQualification = '';
      const sourceButtons = document.createElement('div');
      sourceButtons.dataset.hintSources = '';
      sourceDetails.append(sourceSummary, qualification, sourceButtons);
      const warning = document.createElement('p');
      warning.dataset.hintWarning = '';
      details.append(warning);
      const versions = document.createElement('details');
      versions.dataset.hintVersions = '';
      versions.append(document.createElement('summary'), document.createElement('ol'));
      details.append(versions);
      row.append(details);
      cards.set(cue.id, row);
    }
    const details = row.firstElementChild as HTMLDetailsElement;
    const [summary, body, detail, provenance, sources] = Array.from(
      details.children,
    ) as HTMLElement[];
    const anchor = hintAnchor(cue);
    text(summary.querySelector<HTMLElement>('.live-hint-title')!, hintTitle(cue));
    const time = summary.querySelector('time')!;
    time.textContent = anchor === undefined ? '시각 없음' : elapsed(anchor);
    summary.querySelector<HTMLElement>('.live-hint-correction')!.hidden = !cue.retracted;
    summary.setAttribute(
      'aria-label',
      `${hintTitle(cue)}${cue.retracted ? ' · 자막 수정 · 확인 필요' : ''} · ${anchor === undefined ? '시각 없음' : elapsed(anchor)}`,
    );
    text(body, cue.text);
    text(detail, cue.detail && cue.detail !== cue.text ? cue.detail : '');
    detail.hidden = !detail.textContent;
    text(
      provenance,
      [
        cue.simulated ? '모의 응답' : '',
        cue.suggestion ? '제안' : '',
        cue.updatedOffsetMs === undefined ? '' : '내용 업데이트됨',
      ]
        .filter(Boolean)
        .join(' · '),
    );
    provenance.hidden = true;
    text(
      sources.querySelector<HTMLElement>('[data-hint-qualification]')!,
      [
        cue.draft ? '아직 인식 중인 자막입니다. 내용이 바뀌면 힌트도 수정될 수 있습니다.' : '',
        cue.basis,
      ]
        .filter(Boolean)
        .join(' '),
    );
    const sourceContainer = sources.querySelector<HTMLElement>('[data-hint-sources]')!;
    // Evidence status must update even while the reader selects the cue wording.
    const warning = details.querySelector<HTMLElement>('[data-hint-warning]')!;
    const warningText = cue.retracted ? '자막이 정정되어 이 힌트를 다시 확인해야 합니다.' : '';
    if (warning.textContent !== warningText) warning.textContent = warningText;
    warning.hidden = !warningText;
    const oldSources = new Map(
      Array.from(sources.querySelectorAll<HTMLButtonElement>('button')).map((button) => [
        button.dataset.sourceId!,
        button,
      ]),
    );
    const sourceButtons = cue.sources.map((source) => {
      let jump = oldSources.get(source.id);
      if (!jump) {
        jump = document.createElement('button');
        jump.type = 'button';
        jump.dataset.hintAction = 'source';
        jump.dataset.sourceId = source.id;
        jump.addEventListener('click', () =>
          actions.source(source.id, () => {
            const target = cards.get(cue.id)?.querySelector<HTMLElement>('summary');
            if (target) revealAncestors(target);
            target?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
            target?.focus({ preventScroll: true });
          }),
        );
      }
      text(jump, `원문 · ${source.label}`);
      return jump;
    });
    reconcile(sourceContainer, sourceButtons);
    const versions = details.querySelector<HTMLDetailsElement>('[data-hint-versions]')!;
    versions.hidden = !cue.history?.length;
    text(versions.firstElementChild as HTMLElement, `이전 내용 (${cue.history?.length || 0})`);
    const versionList = versions.lastElementChild as HTMLOListElement;
    const previousVersions = new Map(
      Array.from(versionList.children).map((node) => [
        (node as HTMLElement).dataset.revision!,
        node as HTMLElement,
      ]),
    );
    reconcile(
      versionList,
      (cue.history || []).map((entry) => {
        let item = previousVersions.get(String(entry.revision));
        if (!item) {
          item = document.createElement('li');
          item.dataset.revision = String(entry.revision);
          item.append(document.createElement('p'), document.createElement('div'));
        }
        const versionAnchor = hintAnchor({
          id: cue.id,
          text: entry.text,
          anchorOffsetMs: entry.anchorOffsetMs,
          sources: entry.sources || [],
        });
        let versionWarning = item.querySelector<HTMLElement>('[data-version-warning]');
        if (!versionWarning) {
          versionWarning = document.createElement('p');
          versionWarning.dataset.versionWarning = '';
          item.insertBefore(versionWarning, item.lastElementChild);
        }
        const versionWarningText =
          entry.sourceState === 'retracted'
            ? '자막이 정정되어 이 힌트를 다시 확인해야 합니다.'
            : entry.sourceState === 'draft'
              ? '아직 인식 중인 자막을 참고한 내용입니다.'
              : '';
        if (versionWarning.textContent !== versionWarningText)
          versionWarning.textContent = versionWarningText;
        versionWarning.hidden = !versionWarningText;
        text(
          item.firstElementChild as HTMLElement,
          [
            versionAnchor === undefined ? '원문 시각 없음' : elapsed(versionAnchor),
            entry.title,
            entry.text,
            entry.detail,
          ]
            .filter(Boolean)
            .join('\n\n'),
        );
        const sourceList = item.lastElementChild as HTMLElement;
        const existing = new Map(
          Array.from(sourceList.querySelectorAll<HTMLButtonElement>('button')).map((button) => [
            button.dataset.sourceId!,
            button,
          ]),
        );
        reconcile(
          sourceList,
          (entry.sources || []).map((source) => {
            let button = existing.get(source.id);
            if (!button) {
              button = document.createElement('button');
              button.type = 'button';
              button.dataset.hintAction = 'source';
              button.dataset.sourceId = source.id;
              button.addEventListener('click', () =>
                actions.source(source.id, () => {
                  if (button) revealAncestors(button);
                  button?.focus({ preventScroll: true });
                  button?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
                }),
              );
            }
            text(button, `원문 · ${source.label}`);
            return button;
          }),
        );
        return item;
      }),
    );
    return row;
  }
  /** Reuse keyed nodes, avoiding detach/reinsert for already ordered cards. */
  function reconcile(parent: HTMLElement, nodes: HTMLElement[]) {
    const keep = new Set(nodes);
    for (const child of Array.from(parent.children))
      if (!keep.has(child as HTMLElement)) child.remove();
    nodes.forEach((node, index) => {
      if (parent.children[index] !== node)
        parent.insertBefore(node, parent.children[index] || null);
    });
  }
  function render() {
    const focused = document.activeElement as HTMLElement | null;
    const focusedHintId = focused?.closest<HTMLElement>('[data-hint-id]')?.dataset.hintId;
    const selection = window.getSelection();
    const selectionState =
      selection?.anchorNode && selection.focusNode
        ? {
            anchor: selection.anchorNode,
            anchorOffset: selection.anchorOffset,
            focus: selection.focusNode,
            focusOffset: selection.focusOffset,
          }
        : null;
    const panel = document.getElementById('liveSessionPanel')!;
    const scroll = [panel, ...Array.from(panel.querySelectorAll<HTMLElement>('*'))]
      .filter(
        (node) => node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth,
      )
      .map((node) => ({ node, top: node.scrollTop, left: node.scrollLeft }));
    const matches = orderHints(cues);
    reconcile(current, matches.map(card));
    text(count, matches.length ? `${matches.length}개 힌트` : '아직 힌트가 없습니다.');
    if (focused?.isConnected && document.activeElement !== focused)
      focused.focus({ preventScroll: true });
    else if (focused && !focused.isConnected && focusedHintId)
      cards
        .get(focusedHintId)
        ?.querySelector<HTMLElement>('summary')
        ?.focus({ preventScroll: true });
    const textControlFocused = focused?.matches('input, textarea') || focused?.isContentEditable;
    const selectionRegion = selectionState?.anchor.parentElement?.closest(
      '.live-hints-rail, #liveTranscriptList',
    );
    if (
      !textControlFocused &&
      selectionRegion?.contains(selectionState?.focus || null) &&
      selection &&
      selectionState?.anchor.isConnected &&
      selectionState.focus.isConnected
    ) {
      selection.setBaseAndExtent(
        selectionState.anchor,
        selectionState.anchorOffset,
        selectionState.focus,
        selectionState.focusOffset,
      );
    }
    scroll.forEach(({ node, top, left }) => {
      node.scrollTop = top;
      node.scrollLeft = left;
    });
  }
  return {
    dispose() {
      active = false;
      clearPreview();
      dialogObserver.disconnect();
    },
    enabled: () => automaticEnabled,
    status: setStatus,
    notice(message: string) {
      actionError = message;
      renderError();
    },
    pending,
    mode(value: boolean) {
      automaticEnabled = value;
      if (!value) clearPreview();
    },
    active(value: boolean) {
      active = value;
      if (!value) clearPreview();
    },
    reset(example = false) {
      clearPreview();
      cues = [];
      cards.clear();
      deferredText = false;
      evidenceStatus.textContent = '';
      actionError = engineNotice = '';
      automaticEnabled = true;
      render();
      if (example) setStatus('모의 응답 · 대화 중 자동 생성');
      else pending();
    },
    add(cue: HintView, options: { replay?: boolean } = {}) {
      const existing = cues.findIndex((item) => item.id === cue.id);
      const contentUpdated =
        existing >= 0 && cue.updatedOffsetMs !== cues[existing].updatedOffsetMs;
      const evidenceRetracted = existing >= 0 && cue.retracted && !cues[existing].retracted;
      const historyRetracted =
        existing >= 0 &&
        cue.history?.some(
          (entry) =>
            entry.sourceState === 'retracted' &&
            cues[existing].history?.find((previous) => previous.revision === entry.revision)
              ?.sourceState !== 'retracted',
        );
      if (existing >= 0) cues[existing] = cue;
      else cues = retainHints([cue, ...cues], new Set());
      const retained = new Set(cues.map((item) => item.id));
      for (const id of cards.keys())
        if (!retained.has(id)) {
          cards.get(id)?.remove();
          cards.delete(id);
        }
      render();
      if (previewId === cue.id) {
        // Source invalidation must remove a stale preview immediately.
        if (cue.retracted) {
          clearPreview(false);
          showNextPreview();
        } else updatePreview(cue);
      } else if (existing < 0 && !options.replay && !cue.retracted && active) {
        previewQueue.push(cue.id);
        // Bursts remain in history; avoid replaying an increasingly stale backlog.
        previewQueue = previewQueue.slice(-2);
        showNextPreview();
      }
      if (evidenceRetracted || historyRetracted)
        evidenceStatus.textContent = `자막이 정정되어 ‘${hintTitle(cue)}’ 힌트를 다시 확인해야 합니다.`;
      else if (existing < 0 && !options.replay && !previewId)
        setStatus(cue.simulated ? '모의 힌트 도착 · 대화 듣는 중' : '새 힌트 도착');
      else if (contentUpdated) setStatus('힌트 내용 업데이트됨');
    },
  };
}
