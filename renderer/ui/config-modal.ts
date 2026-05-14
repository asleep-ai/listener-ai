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
let knownWordsInput: HTMLTextAreaElement | null = null;

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
  if (knownWordsInput) {
    knownWordsInput.value = (config.knownWords || []).join('\n');
  }
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

  // Show the modal
  if (configModal) {
    configModal.style.display = 'block';
  }
}

export function setupConfigModal(): void {
  configModal = document.getElementById('configModal');
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
  knownWordsInput = document.getElementById('knownWords') as HTMLTextAreaElement | null;

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

  if (loginCodexOAuthBtn) {
    loginCodexOAuthBtn.addEventListener('click', async () => {
      setCodexOAuthStatus('Opening browser sign-in...');
      loginCodexOAuthBtn!.disabled = true;
      try {
        const result = await window.electronAPI.loginCodexOAuth();
        if (result.success) {
          if (aiProviderSelect) aiProviderSelect.value = 'codex';
          setCodexOAuthStatus('Signed in', 'success');
        } else {
          setCodexOAuthStatus(result.error, 'error');
        }
      } finally {
        loginCodexOAuthBtn!.disabled = false;
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
      const knownWords = knownWordsInput
        ? knownWordsInput.value
            .split('\n')
            .map((w) => w.trim())
            .filter((w) => w.length > 0)
        : [];
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
      if (configModal) configModal.style.display = 'none';
    });
  }

  const hideConfig = () => {
    if (configModal) configModal.style.display = 'none';
  };
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
