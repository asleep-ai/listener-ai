type LayoutTab = {
  button: HTMLButtonElement;
  panel: HTMLElement;
};

export function setupLiveSessionLayout() {
  const narrow = window.matchMedia('(max-width: 900px)');
  const listeners = new AbortController();
  const getTab = (buttonId: string, panelId: string): LayoutTab | null => {
    const button = document.getElementById(buttonId);
    const panel = document.getElementById(panelId);
    return button instanceof HTMLButtonElement && panel ? { button, panel } : null;
  };
  const hints = getTab('liveSessionHintsTab', 'liveSessionHints');
  const conversation = getTab('liveSessionConversationTab', 'liveSessionConversation');
  const transcript = getTab('liveCaptionTranscriptTab', 'liveTranscriptColumn');
  const translation = getTab('liveCaptionTranslationTab', 'liveTranslationColumn');
  const workspaceTabs = [hints, conversation].filter((tab): tab is LayoutTab => tab !== null);
  const captionTabs = [transcript, translation].filter((tab): tab is LayoutTab => tab !== null);
  const originalLabels = new Map(
    workspaceTabs.map(({ panel }) => [panel, panel.getAttribute('aria-labelledby')]),
  );
  let workspaceSelection = hints;
  let captionSelection = transcript;
  let translationEnabled = true;

  const render = () => {
    for (const tab of workspaceTabs) {
      const selected = tab === workspaceSelection;
      tab.button.setAttribute('role', 'tab');
      tab.button.setAttribute('aria-controls', tab.panel.id);
      tab.button.setAttribute('aria-selected', String(selected));
      tab.button.tabIndex = selected ? 0 : -1;
      tab.panel.hidden = narrow.matches && !selected;
      tab.button
        .closest<HTMLElement>('[role="tablist"]')
        ?.toggleAttribute('hidden', !narrow.matches);
      if (narrow.matches) {
        tab.panel.setAttribute('role', 'tabpanel');
        tab.panel.setAttribute('aria-labelledby', tab.button.id);
      } else {
        tab.panel.removeAttribute('role');
        const label = originalLabels.get(tab.panel);
        if (label) tab.panel.setAttribute('aria-labelledby', label);
        else tab.panel.removeAttribute('aria-labelledby');
      }
    }
    for (const tab of captionTabs) {
      const selected = tab === captionSelection;
      tab.button.setAttribute('role', 'tab');
      tab.button.setAttribute('aria-controls', tab.panel.id);
      tab.button.setAttribute('aria-selected', String(selected));
      tab.button.tabIndex = selected ? 0 : -1;
      tab.button.disabled = tab === translation && !translationEnabled;
      tab.panel.setAttribute('role', 'tabpanel');
      tab.panel.setAttribute('aria-labelledby', tab.button.id);
      tab.panel.hidden = !selected;
    }
  };

  const select = (tab: LayoutTab, tabs: LayoutTab[], focus: boolean) => {
    if (tab.button.disabled) return;
    if (tabs === workspaceTabs) workspaceSelection = tab;
    else captionSelection = tab;
    render();
    if (focus) tab.button.focus();
  };
  for (const tabs of [workspaceTabs, captionTabs]) {
    for (const tab of tabs) {
      tab.button.addEventListener('click', () => select(tab, tabs, false), {
        signal: listeners.signal,
      });
      tab.button.addEventListener(
        'keydown',
        (event) => {
          if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
          const available = tabs.filter(({ button }) => !button.disabled);
          const index = available.indexOf(tab);
          let next: LayoutTab | undefined;
          if (event.key === 'ArrowRight') next = available[(index + 1) % available.length];
          else if (event.key === 'ArrowLeft')
            next = available[(index + available.length - 1) % available.length];
          else if (event.key === 'Home') next = available[0];
          else if (event.key === 'End') next = available[available.length - 1];
          if (!next) return;
          event.preventDefault();
          select(next, tabs, true);
        },
        { signal: listeners.signal },
      );
    }
  }
  narrow.addEventListener(
    'change',
    () => {
      const hiddenTab =
        !narrow.matches && workspaceTabs.find(({ button }) => button === document.activeElement);
      // Preserve a focused conversation control when collapsing the desktop layout.
      if (narrow.matches) {
        const focused = workspaceTabs.find(({ panel }) => panel.contains(document.activeElement));
        if (focused) workspaceSelection = focused;
      }
      render();
      if (hiddenTab) {
        const panel = hiddenTab.panel;
        const control = Array.from(
          panel.querySelectorAll<HTMLElement>(
            'button:not(:disabled), summary, a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
          ),
        ).find(
          (element) => element.getClientRects().length > 0 && !element.closest('[hidden], [inert]'),
        );
        if (control) control.focus({ preventScroll: true });
        else {
          panel.tabIndex = -1;
          panel.focus({ preventScroll: true });
        }
      }
    },
    { signal: listeners.signal },
  );
  render();

  return {
    setTranslationEnabled(enabled: boolean) {
      const restoreFocus =
        !enabled &&
        translation &&
        (translation.panel.contains(document.activeElement) ||
          document.activeElement === translation.button);
      translationEnabled = enabled;
      if (!enabled && captionSelection === translation) captionSelection = transcript;
      render();
      if (restoreFocus) transcript?.button.focus();
    },
    showSource() {
      workspaceSelection = conversation;
      captionSelection = transcript;
      render();
    },
    showHints() {
      workspaceSelection = hints;
      render();
    },
    reset() {
      workspaceSelection = hints;
      captionSelection = transcript;
      const ask = document.getElementById('liveSessionAsk');
      if (ask instanceof HTMLDetailsElement) ask.open = false;
      render();
    },
    dispose() {
      listeners.abort();
    },
  };
}
