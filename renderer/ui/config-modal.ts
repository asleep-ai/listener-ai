// Settings/configuration modal.
// Extracted from legacy.ts (~lines 1151-1242, 1591-1707, plus the
// settingsButton handler in setupEventListeners).
// Behavior preserved verbatim.

import { DEFAULT_SUMMARY_PROMPT } from '../state';

let configModal: HTMLElement | null = null;
let saveConfigBtn: HTMLButtonElement | null = null;
let cancelConfigBtn: HTMLButtonElement | null = null;
let aiProviderSelect: HTMLSelectElement | null = null;
let geminiApiKeyInput: HTMLInputElement | null = null;
let geminiModelInput: HTMLInputElement | null = null;
let geminiFlashModelInput: HTMLInputElement | null = null;
let codexModelInput: HTMLInputElement | null = null;
let codexTranscriptionModelInput: HTMLInputElement | null = null;
let loginCodexOAuthBtn: HTMLButtonElement | null = null;
let clearCodexOAuthBtn: HTMLButtonElement | null = null;
let codexOAuthStatus: HTMLElement | null = null;
let notionApiKeyInput: HTMLInputElement | null = null;
let notionDatabaseIdInput: HTMLInputElement | null = null;
let slackWebhookUrlInput: HTMLInputElement | null = null;
let slackAutoShareInput: HTMLInputElement | null = null;
let testSlackWebhookBtn: HTMLButtonElement | null = null;
let slackWebhookStatus: HTMLElement | null = null;
let globalShortcutInput: HTMLInputElement | null = null;
let knownWordsContainer: HTMLElement | null = null;
let knownWordsField: HTMLInputElement | null = null;
let knownWordsValues: string[] = [];
let aiPane: HTMLElement | null = null;

// Each Codex sign-in click bumps this; the in-flight click checks its captured
// token against the current one after `await`, discarding stale results from
// prior attempts that were aborted by a newer click.
let codexLoginToken = 0;

function setCodexOAuthStatus(text: string, state: 'idle' | 'success' | 'error' = 'idle'): void {
  if (!codexOAuthStatus) return;
  codexOAuthStatus.textContent = text;
  codexOAuthStatus.className = `slack-webhook-status${state === 'idle' ? '' : ` is-${state}`}`;
}

// Function to check and prompt for API keys
export async function checkAndPromptForConfig(): Promise<void> {
  const configCheck = (await window.electronAPI.checkConfig()) as {
    hasConfig?: boolean;
    missing?: string[];
  };

  if (!configCheck.hasConfig) {
    const missing = configCheck.missing || [];
    const message = `The following API keys are missing:\n${missing.join('\n')}\n\nWould you like to configure them now?`;

    if (confirm(message)) {
      // Show the config modal instead of using prompts
      showConfigModal();
    }
  }
}

// Function to show the config modal
export async function showConfigModal(): Promise<void> {
  // Cmd+, while the modal is already open should be a no-op rather than
  // discarding the user's in-progress edits by re-fetching config.
  if (configModal && configModal.style.display === 'block') return;

  // Load current config
  const config = (await window.electronAPI.getConfig()) as Record<string, unknown> & {
    aiProvider?: 'gemini' | 'codex';
    geminiApiKey?: string;
    geminiModel?: string;
    geminiFlashModel?: string;
    codexModel?: string;
    codexTranscriptionModel?: string;
    codexOAuthConfigured?: boolean;
    notionApiKey?: string;
    notionDatabaseId?: string;
    slackWebhookUrl?: string;
    slackAutoShare?: boolean;
    globalShortcut?: string;
    knownWords?: string[];
    maxRecordingMinutes?: number | string;
    recordingReminderMinutes?: number | string;
    minRecordingSeconds?: number | string;
    summaryPrompt?: string;
  };

  // Pre-fill the form if values exist
  if (aiProviderSelect) {
    aiProviderSelect.value = config.aiProvider || 'gemini';
  }
  if (geminiApiKeyInput && config.geminiApiKey) {
    geminiApiKeyInput.value = config.geminiApiKey;
  }
  if (geminiModelInput) {
    geminiModelInput.value = config.geminiModel || '';
  }
  if (geminiFlashModelInput) {
    geminiFlashModelInput.value = config.geminiFlashModel || '';
  }
  if (codexModelInput) {
    codexModelInput.value = config.codexModel || '';
  }
  if (codexTranscriptionModelInput) {
    codexTranscriptionModelInput.value = config.codexTranscriptionModel || '';
  }
  setCodexOAuthStatus(
    config.codexOAuthConfigured ? 'Signed in' : 'Not signed in',
    config.codexOAuthConfigured ? 'success' : 'idle',
  );
  if (notionApiKeyInput && config.notionApiKey) {
    notionApiKeyInput.value = config.notionApiKey;
  }
  if (notionDatabaseIdInput && config.notionDatabaseId) {
    notionDatabaseIdInput.value = config.notionDatabaseId;
  }
  if (slackWebhookUrlInput) {
    slackWebhookUrlInput.value = config.slackWebhookUrl || '';
  }
  if (slackAutoShareInput) {
    slackAutoShareInput.checked = !!config.slackAutoShare;
  }
  if (slackWebhookStatus) {
    slackWebhookStatus.textContent = '';
    slackWebhookStatus.className = 'slack-webhook-status';
  }
  if (globalShortcutInput && config.globalShortcut) {
    globalShortcutInput.value = config.globalShortcut;
  }
  knownWordsValues = (config.knownWords || []).filter(
    (w): w is string => typeof w === 'string' && w.trim().length > 0,
  );
  if (knownWordsField) knownWordsField.value = '';
  renderKnownWordsChips();
  const maxRecordingMinutesInput = document.getElementById(
    'maxRecordingMinutes',
  ) as HTMLInputElement | null;
  if (maxRecordingMinutesInput) {
    maxRecordingMinutesInput.value = String(config.maxRecordingMinutes || '');
  }
  const recordingReminderMinutesInput = document.getElementById(
    'recordingReminderMinutes',
  ) as HTMLInputElement | null;
  if (recordingReminderMinutesInput) {
    recordingReminderMinutesInput.value = String(config.recordingReminderMinutes || '');
  }
  const minRecordingSecondsInput = document.getElementById(
    'minRecordingSeconds',
  ) as HTMLInputElement | null;
  if (minRecordingSecondsInput) {
    minRecordingSecondsInput.value = String(config.minRecordingSeconds || '');
  }

  // Pre-fill summary prompt
  const summaryPromptInput = document.getElementById('summaryPrompt') as HTMLTextAreaElement | null;
  if (summaryPromptInput) {
    summaryPromptInput.value = config.summaryPrompt || DEFAULT_SUMMARY_PROMPT;
  }

  // Reset to default buttons
  const resetGeminiModelBtn = document.getElementById(
    'resetGeminiModel',
  ) as HTMLButtonElement | null;
  if (resetGeminiModelBtn) {
    resetGeminiModelBtn.onclick = () => {
      if (geminiModelInput) geminiModelInput.value = '';
    };
  }
  const resetGeminiFlashModelBtn = document.getElementById(
    'resetGeminiFlashModel',
  ) as HTMLButtonElement | null;
  if (resetGeminiFlashModelBtn) {
    resetGeminiFlashModelBtn.onclick = () => {
      if (geminiFlashModelInput) geminiFlashModelInput.value = '';
    };
  }
  const resetPromptBtn = document.getElementById('resetPrompt') as HTMLButtonElement | null;
  if (resetPromptBtn) {
    resetPromptBtn.onclick = () => {
      if (summaryPromptInput) {
        summaryPromptInput.value = DEFAULT_SUMMARY_PROMPT;
      }
    };
  }

  applyAiProviderVisibility();

  // AI Provider tab carries the required-credentials state; open there so the
  // user sees setup status first.
  activateConfigTab('ai');
  if (configModal) configModal.style.display = 'block';
}

function renderKnownWordsChips(): void {
  if (!knownWordsContainer || !knownWordsField) return;
  // Remove existing chip nodes but keep the input field in place.
  knownWordsContainer.querySelectorAll('.chip').forEach((node) => node.remove());
  for (const value of knownWordsValues) {
    const chip = document.createElement('span');
    chip.className = 'chip';

    const text = document.createElement('span');
    text.className = 'chip-text';
    text.textContent = value;
    chip.appendChild(text);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'chip-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${value}`);
    remove.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeKnownWord(value);
    });
    chip.appendChild(remove);

    knownWordsContainer.insertBefore(chip, knownWordsField);
  }
}

function addKnownWords(raw: string): void {
  // Case-insensitive dedupe so "GPT-4o" and "gpt-4o" don't both stick. Build
  // the lookup set once so a large paste stays O(n) rather than O(n^2).
  const seen = new Set(knownWordsValues.map((w) => w.toLowerCase()));
  let changed = false;
  for (const word of raw.split(/[,\n]/)) {
    const trimmed = word.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    knownWordsValues.push(trimmed);
    changed = true;
  }
  if (changed) renderKnownWordsChips();
}

function removeKnownWord(value: string): void {
  const before = knownWordsValues.length;
  knownWordsValues = knownWordsValues.filter((w) => w !== value);
  if (knownWordsValues.length !== before) renderKnownWordsChips();
  knownWordsField?.focus();
}

function applyAiProviderVisibility(): void {
  if (!aiPane || !aiProviderSelect) return;
  const active = aiProviderSelect.value;
  aiPane.querySelectorAll<HTMLElement>('.config-subgroup[data-provider]').forEach((sg) => {
    sg.hidden = sg.dataset.provider !== active;
  });
}

function activateConfigTab(target: string): void {
  if (!configModal) return;
  const tabs = configModal.querySelectorAll<HTMLButtonElement>('.config-tab');
  const panes = configModal.querySelectorAll<HTMLElement>('.config-pane');
  tabs.forEach((t) => {
    const active = t.dataset.tab === target;
    t.classList.toggle('is-active', active);
    t.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  panes.forEach((p) => {
    p.classList.toggle('is-active', p.dataset.pane === target);
  });
}

function setupConfigTabs(modal: HTMLElement): void {
  const tabs = modal.querySelectorAll<HTMLButtonElement>('.config-tab');
  if (tabs.length === 0) return;
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      if (target) activateConfigTab(target);
    });
  });
}

export function setupConfigModal(): void {
  configModal = document.getElementById('configModal');
  if (configModal) {
    setupConfigTabs(configModal);
    aiPane = configModal.querySelector<HTMLElement>('.config-pane[data-pane="ai"]');
  }
  saveConfigBtn = document.getElementById('saveConfig') as HTMLButtonElement | null;
  cancelConfigBtn = document.getElementById('cancelConfig') as HTMLButtonElement | null;
  aiProviderSelect = document.getElementById('aiProvider') as HTMLSelectElement | null;
  geminiApiKeyInput = document.getElementById('geminiApiKey') as HTMLInputElement | null;
  geminiModelInput = document.getElementById('geminiModel') as HTMLInputElement | null;
  geminiFlashModelInput = document.getElementById('geminiFlashModel') as HTMLInputElement | null;
  codexModelInput = document.getElementById('codexModel') as HTMLInputElement | null;
  codexTranscriptionModelInput = document.getElementById(
    'codexTranscriptionModel',
  ) as HTMLInputElement | null;
  loginCodexOAuthBtn = document.getElementById('loginCodexOAuth') as HTMLButtonElement | null;
  clearCodexOAuthBtn = document.getElementById('clearCodexOAuth') as HTMLButtonElement | null;
  codexOAuthStatus = document.getElementById('codexOAuthStatus');
  notionApiKeyInput = document.getElementById('notionApiKey') as HTMLInputElement | null;
  notionDatabaseIdInput = document.getElementById('notionDatabaseId') as HTMLInputElement | null;
  slackWebhookUrlInput = document.getElementById('slackWebhookUrl') as HTMLInputElement | null;
  slackAutoShareInput = document.getElementById('slackAutoShare') as HTMLInputElement | null;
  testSlackWebhookBtn = document.getElementById('testSlackWebhook') as HTMLButtonElement | null;
  slackWebhookStatus = document.getElementById('slackWebhookStatus');
  globalShortcutInput = document.getElementById('globalShortcut') as HTMLInputElement | null;
  knownWordsContainer = document.getElementById('knownWordsChips');
  knownWordsField = document.getElementById('knownWordsField') as HTMLInputElement | null;

  if (knownWordsContainer && knownWordsField) {
    // Clicking anywhere in the chip container should focus the input (matches
    // iOS Mail / Apple's tokenized address fields).
    knownWordsContainer.addEventListener('click', (e) => {
      if (e.target === knownWordsContainer) knownWordsField?.focus();
    });

    knownWordsField.addEventListener('keydown', (e) => {
      // Guard against Korean (and other IME) composition: pressing Enter to
      // commit a Hangul syllable would otherwise also commit a chip mid-word.
      if (e.isComposing) return;

      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const value = knownWordsField!.value;
        if (value.trim().length > 0) {
          addKnownWords(value);
          knownWordsField!.value = '';
        }
        return;
      }

      if (e.key === 'Backspace' && knownWordsField!.value.length === 0 && knownWordsValues.length > 0) {
        e.preventDefault();
        removeKnownWord(knownWordsValues[knownWordsValues.length - 1]!);
      }
    });

    // Commit whatever's typed when the user clicks Save or moves focus away,
    // so trailing text doesn't get silently dropped.
    knownWordsField.addEventListener('blur', () => {
      const value = knownWordsField!.value;
      if (value.trim().length > 0) {
        addKnownWords(value);
        knownWordsField!.value = '';
      }
    });

    // Pasted comma- or newline-separated lists become multiple chips at once.
    knownWordsField.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text') ?? '';
      if (!/[,\n]/.test(text)) return;
      e.preventDefault();
      addKnownWords(text);
      knownWordsField!.value = '';
    });
  }

  if (aiProviderSelect) {
    aiProviderSelect.addEventListener('change', applyAiProviderVisibility);
  }

  const openSlackAppCreatorBtn = document.getElementById(
    'openSlackAppCreator',
  ) as HTMLButtonElement | null;
  if (openSlackAppCreatorBtn) {
    openSlackAppCreatorBtn.addEventListener('click', () => {
      window.electronAPI.openExternal('https://api.slack.com/apps?new_app=1');
    });
  }

  if (testSlackWebhookBtn) {
    testSlackWebhookBtn.addEventListener('click', async () => {
      if (!slackWebhookUrlInput || !slackWebhookStatus) return;
      const url = slackWebhookUrlInput.value.trim();
      if (!url) {
        slackWebhookStatus.textContent = 'Enter a webhook URL first.';
        slackWebhookStatus.className = 'slack-webhook-status is-error';
        return;
      }
      slackWebhookStatus.textContent = 'Sending test message…';
      slackWebhookStatus.className = 'slack-webhook-status';
      testSlackWebhookBtn!.disabled = true;
      try {
        const result = await window.electronAPI.testSlackWebhook(url);
        if (result.success) {
          slackWebhookStatus.textContent = 'Test message sent. Check the channel.';
          slackWebhookStatus.className = 'slack-webhook-status is-success';
        } else {
          slackWebhookStatus.textContent = result.error;
          slackWebhookStatus.className = 'slack-webhook-status is-error';
        }
      } finally {
        testSlackWebhookBtn!.disabled = false;
      }
    });
  }

  window.electronAPI.onCodexOAuthProgress((status) => {
    if (status.phase === 'browser-opened') {
      setCodexOAuthStatus('Waiting for browser sign-in — click Sign in again to retry.');
    } else if (status.phase === 'progress' && status.message) {
      setCodexOAuthStatus(status.message);
    }
  });

  if (loginCodexOAuthBtn) {
    loginCodexOAuthBtn.addEventListener('click', async () => {
      // Reentrant: each click aborts any prior in-flight attempt on main;
      // the token guard drops the aborted attempt's stale result.
      const myToken = ++codexLoginToken;
      setCodexOAuthStatus('Opening browser sign-in...');
      const result = await window.electronAPI.loginCodexOAuth();
      if (myToken !== codexLoginToken) return;
      if (result.success) {
        if (aiProviderSelect) aiProviderSelect.value = 'codex';
        applyAiProviderVisibility();
        setCodexOAuthStatus('Signed in', 'success');
      } else if (result.cancelled) {
        return;
      } else {
        setCodexOAuthStatus(result.error, 'error');
      }
    });
  }

  if (clearCodexOAuthBtn) {
    clearCodexOAuthBtn.addEventListener('click', async () => {
      clearCodexOAuthBtn!.disabled = true;
      try {
        const result = await window.electronAPI.clearCodexOAuth();
        if (result.success) {
          setCodexOAuthStatus('Not signed in');
        } else {
          setCodexOAuthStatus(result.error, 'error');
        }
      } finally {
        clearCodexOAuthBtn!.disabled = false;
      }
    });
  }

  const hideConfig = () => {
    if (configModal) configModal.style.display = 'none';
    // Bumping the token drops any stale result from an in-flight Codex login
    // promise that resolves after the modal is gone.
    codexLoginToken++;
    // Free port 1455 if a Codex sign-in is still pending so the next attempt
    // can bind a fresh loopback.
    window.electronAPI.cancelCodexOAuth().catch(() => {});
  };

  if (saveConfigBtn) {
    saveConfigBtn.addEventListener('click', async () => {
      const aiProvider = aiProviderSelect?.value === 'codex' ? 'codex' : 'gemini';
      const geminiKey = geminiApiKeyInput?.value.trim() ?? '';
      const geminiModel = geminiModelInput ? geminiModelInput.value.trim() : '';
      const geminiFlashModel = geminiFlashModelInput ? geminiFlashModelInput.value.trim() : '';
      const codexModel = codexModelInput ? codexModelInput.value.trim() : '';
      const codexTranscriptionModel = codexTranscriptionModelInput
        ? codexTranscriptionModelInput.value.trim()
        : '';
      const notionKey = notionApiKeyInput?.value.trim() ?? '';
      const notionDb = notionDatabaseIdInput?.value.trim() ?? '';
      const slackWebhookUrl = slackWebhookUrlInput?.value.trim() ?? '';
      const slackAutoShare = !!slackAutoShareInput?.checked;
      const globalShortcut = globalShortcutInput?.value.trim() ?? '';
      // Flush any uncommitted typing in the chip field before saving so the
      // user doesn't lose what they typed but never pressed comma/Enter on.
      if (knownWordsField && knownWordsField.value.trim().length > 0) {
        addKnownWords(knownWordsField.value);
        knownWordsField.value = '';
      }
      const knownWords = [...knownWordsValues];
      const summaryPromptInput = document.getElementById(
        'summaryPrompt',
      ) as HTMLTextAreaElement | null;
      const summaryPrompt = summaryPromptInput ? summaryPromptInput.value.trim() : '';
      const maxRecordingMinutesEl = document.getElementById(
        'maxRecordingMinutes',
      ) as HTMLInputElement | null;
      const maxRecordingMinutes = Math.max(
        0,
        Math.floor(Number.parseInt(maxRecordingMinutesEl?.value || '') || 0),
      );
      const recordingReminderMinutesEl = document.getElementById(
        'recordingReminderMinutes',
      ) as HTMLInputElement | null;
      const recordingReminderMinutes = Math.max(
        0,
        Math.floor(Number.parseInt(recordingReminderMinutesEl?.value || '') || 0),
      );
      const minRecordingSecondsEl = document.getElementById(
        'minRecordingSeconds',
      ) as HTMLInputElement | null;
      const minRecordingSeconds = Math.max(
        0,
        Math.floor(Number.parseInt(minRecordingSecondsEl?.value || '') || 0),
      );

      if (aiProvider === 'gemini' && !geminiKey) {
        alert('Please enter at least the Gemini API key');
        return;
      }

      // ConfigPayload in electronAPI.d.ts is a subset; the main process
      // accepts these extra keys (*Recording*Minutes, etc). Cast through
      // `unknown` to satisfy strict mode without widening the public type
      // surface used elsewhere.
      const payload = {
        aiProvider,
        geminiApiKey: geminiKey,
        geminiModel: geminiModel,
        geminiFlashModel: geminiFlashModel,
        codexModel: codexModel,
        codexTranscriptionModel: codexTranscriptionModel,
        notionApiKey: notionKey,
        notionDatabaseId: notionDb,
        slackWebhookUrl: slackWebhookUrl,
        slackAutoShare: slackAutoShare,
        globalShortcut: globalShortcut,
        knownWords: knownWords,
        summaryPrompt: summaryPrompt || DEFAULT_SUMMARY_PROMPT,
        maxRecordingMinutes: maxRecordingMinutes,
        recordingReminderMinutes: recordingReminderMinutes,
        minRecordingSeconds: minRecordingSeconds,
      };
      await window.electronAPI.saveConfig(
        payload as unknown as Parameters<typeof window.electronAPI.saveConfig>[0],
      );
      hideConfig();
    });
  }

  if (cancelConfigBtn) cancelConfigBtn.addEventListener('click', hideConfig);
  const configCloseBtn = document.getElementById('configClose');
  if (configCloseBtn) configCloseBtn.addEventListener('click', hideConfig);

  // Global shortcut input handling
  if (globalShortcutInput) {
    globalShortcutInput.addEventListener('focus', () => {
      if (globalShortcutInput) globalShortcutInput.placeholder = 'Press your shortcut keys...';
    });

    globalShortcutInput.addEventListener('keydown', async (e) => {
      e.preventDefault();

      const modifiers: string[] = [];
      if (e.metaKey || e.ctrlKey) modifiers.push('CommandOrControl');
      if (e.altKey) modifiers.push('Alt');
      if (e.shiftKey) modifiers.push('Shift');

      // Get the key (excluding modifier keys)
      let key = e.key;
      if (['Control', 'Alt', 'Shift', 'Meta', 'Command'].includes(key)) {
        return; // Don't capture modifier keys alone
      }

      // Convert special keys
      if (key === ' ') key = 'Space';
      if (key === 'ArrowUp') key = 'Up';
      if (key === 'ArrowDown') key = 'Down';
      if (key === 'ArrowLeft') key = 'Left';
      if (key === 'ArrowRight') key = 'Right';
      if (key.length === 1) key = key.toUpperCase();

      if (modifiers.length > 0 && globalShortcutInput) {
        const shortcut = [...modifiers, key].join('+');
        globalShortcutInput.value = shortcut;

        // Validate the shortcut
        const result = await window.electronAPI.validateShortcut(shortcut);
        if (!result.valid) {
          globalShortcutInput.style.borderColor = '#ff4444';
          alert('This shortcut is already in use or invalid. Please try another combination.');
        } else {
          globalShortcutInput.style.borderColor = '';
        }
      }
    });

    globalShortcutInput.addEventListener('blur', () => {
      if (globalShortcutInput) globalShortcutInput.placeholder = 'Press shortcut keys';
    });
  }

  // Settings button opens the modal.
  const settingsButton = document.getElementById('settingsButton');
  if (settingsButton) {
    settingsButton.addEventListener('click', () => {
      showConfigModal();
    });
  }
}
