// Settings/configuration modal.
// Extracted from legacy.ts (~lines 1151-1242, 1591-1707, plus the
// settingsButton handler in setupEventListeners).
// Behavior preserved verbatim.

import {
  BACKEND_DEFAULTS,
  CURATED_MODELS,
  CUSTOM_MODEL_SENTINEL,
  type ModelField,
  chooseInitial,
} from '../services/model-options';
import { DEFAULT_SUMMARY_PROMPT } from '../state';

let configModal: HTMLDialogElement | null = null;
let saveConfigBtn: HTMLButtonElement | null = null;
let cancelConfigBtn: HTMLButtonElement | null = null;
let aiProviderSelect: HTMLSelectElement | null = null;
let geminiApiKeyInput: HTMLInputElement | null = null;
let geminiThinkingLevelSelect: HTMLSelectElement | null = null;
let loginCodexOAuthBtn: HTMLButtonElement | null = null;
let clearCodexOAuthBtn: HTMLButtonElement | null = null;
let codexOAuthStatus: HTMLElement | null = null;
let loginGoogleOAuthBtn: HTMLButtonElement | null = null;
let clearGoogleOAuthBtn: HTMLButtonElement | null = null;
let googleOAuthStatus: HTMLElement | null = null;
let googleDriveEnabledInput: HTMLInputElement | null = null;
let googleDriveSyncNowBtn: HTMLButtonElement | null = null;
let googleDriveSyncStatusEl: HTMLElement | null = null;
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
let googleLoginToken = 0;

const MODEL_FIELDS: readonly ModelField[] = [
  'geminiModel',
  'geminiFlashModel',
  'codexModel',
  'codexTranscriptionModel',
];

const RESET_BUTTON_IDS: Record<ModelField, string> = {
  geminiModel: 'resetGeminiModel',
  geminiFlashModel: 'resetGeminiFlashModel',
  codexModel: 'resetCodexModel',
  codexTranscriptionModel: 'resetCodexTranscriptionModel',
};

function getModelEls(
  field: ModelField,
): { select: HTMLSelectElement; input: HTMLInputElement } | null {
  const select = document.getElementById(`${field}Select`) as HTMLSelectElement | null;
  const input = document.getElementById(field) as HTMLInputElement | null;
  return select && input ? { select, input } : null;
}

function buildModelOptions(field: ModelField, select: HTMLSelectElement): void {
  select.innerHTML = '';
  // First entry uses an empty value as the "no override" sentinel. Save
  // persists empty, the backend falls through to DEFAULT_*_MODEL. Without
  // this entry, Reset to Default would snap to a real curated id and Save
  // would persist that as an explicit override.
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = `Default (${BACKEND_DEFAULTS[field]})`;
  select.appendChild(defaultOpt);

  for (const id of CURATED_MODELS[field]) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id;
    select.appendChild(opt);
  }

  const customOpt = document.createElement('option');
  customOpt.value = CUSTOM_MODEL_SENTINEL;
  customOpt.textContent = 'Custom...';
  select.appendChild(customOpt);
}

function applyModelValue(field: ModelField, savedValue: string | undefined): void {
  const els = getModelEls(field);
  if (!els) return;
  const choice = chooseInitial(field, savedValue);
  if (choice.kind === 'custom') {
    els.select.value = CUSTOM_MODEL_SENTINEL;
    els.input.value = choice.value;
    els.input.hidden = false;
  } else {
    els.select.value = choice.value;
    els.input.value = '';
    els.input.hidden = true;
  }
}

function readModelValue(field: ModelField): string {
  const els = getModelEls(field);
  if (!els) return '';
  if (els.select.value === CUSTOM_MODEL_SENTINEL) return els.input.value.trim();
  return els.select.value;
}

function setupModelControls(): void {
  for (const field of MODEL_FIELDS) {
    const els = getModelEls(field);
    if (!els) continue;
    buildModelOptions(field, els.select);
    els.select.addEventListener('change', () => {
      const isCustom = els.select.value === CUSTOM_MODEL_SENTINEL;
      els.input.hidden = !isCustom;
      if (isCustom) els.input.focus();
    });

    const resetBtn = document.getElementById(RESET_BUTTON_IDS[field]) as HTMLButtonElement | null;
    if (resetBtn) resetBtn.onclick = () => applyModelValue(field, '');
  }
}

// Apply the project's status-pill styling to a target element. Reused by the
// Codex sign-in, Google sign-in, and Google sync status indicators -- all
// three pills share the same CSS surface, only the target element differs.
function setStatusEl(
  el: HTMLElement | null,
  text: string,
  state: 'idle' | 'success' | 'error' = 'idle',
): void {
  if (!el) return;
  el.textContent = text;
  el.className = `slack-webhook-status${state === 'idle' ? '' : ` is-${state}`}`;
}

function setCodexOAuthStatus(text: string, state: 'idle' | 'success' | 'error' = 'idle'): void {
  setStatusEl(codexOAuthStatus, text, state);
}

function setGoogleOAuthStatus(text: string, state: 'idle' | 'success' | 'error' = 'idle'): void {
  setStatusEl(googleOAuthStatus, text, state);
}

function setGoogleSyncStatus(text: string, state: 'idle' | 'success' | 'error' = 'idle'): void {
  setStatusEl(googleDriveSyncStatusEl, text, state);
}

function formatLastSynced(iso: string | null | undefined): string {
  if (!iso) return 'Never synced';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'Synced just now';
  if (mins < 60) return `Synced ${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `Synced ${hrs}h ago`;
  return `Synced ${Math.floor(hrs / 24)}d ago`;
}

// Function to check and prompt for API keys
export async function checkAndPromptForConfig(): Promise<void> {
  const configCheck = (await window.electronAPI.checkConfig()) as {
    hasAiAuth?: boolean;
  };

  // Only prompt when the AI provider isn't set up. Notion / Slack are optional
  // integrations and shouldn't trigger a startup nag.
  if (!configCheck.hasAiAuth) {
    if (confirm('Listener.AI needs an AI provider configured. Open settings now?')) {
      showConfigModal();
    }
  }
}

// Function to show the config modal
export async function showConfigModal(): Promise<void> {
  // Cmd+, while the modal is already open should be a no-op rather than
  // discarding the user's in-progress edits by re-fetching config.
  if (configModal && configModal.open) return;

  // Load current config
  const config = (await window.electronAPI.getConfig()) as Record<string, unknown> & {
    aiProvider?: 'gemini' | 'codex';
    geminiApiKey?: string;
    geminiModel?: string;
    geminiFlashModel?: string;
    geminiThinkingLevel?: 'low' | 'medium' | 'high';
    codexModel?: string;
    codexTranscriptionModel?: string;
    codexOAuthConfigured?: boolean;
    notionApiKey?: string;
    notionDatabaseId?: string;
    slackWebhookUrl?: string;
    slackAutoShare?: boolean;
    googleOAuthConfigured?: boolean;
    googleDriveEnabled?: boolean;
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
  applyModelValue('geminiModel', config.geminiModel);
  applyModelValue('geminiFlashModel', config.geminiFlashModel);
  applyModelValue('codexModel', config.codexModel);
  applyModelValue('codexTranscriptionModel', config.codexTranscriptionModel);
  if (geminiThinkingLevelSelect) {
    // Defensive fallback; backend's getGeminiThinkingLevel normalizes first.
    geminiThinkingLevelSelect.value = config.geminiThinkingLevel || 'medium';
  }
  setCodexOAuthStatus(
    config.codexOAuthConfigured ? 'Signed in' : 'Not signed in',
    config.codexOAuthConfigured ? 'success' : 'idle',
  );
  setGoogleOAuthStatus(
    config.googleOAuthConfigured ? 'Signed in' : 'Not signed in',
    config.googleOAuthConfigured ? 'success' : 'idle',
  );
  if (googleDriveEnabledInput) {
    googleDriveEnabledInput.checked = !!config.googleDriveEnabled;
  }
  // Pull the current sync status (last synced, in-flight) so the modal is
  // accurate on open even if no event has fired since boot.
  window.electronAPI
    .getGoogleSyncStatus()
    .then((s) => {
      if (s.inFlight) {
        setGoogleSyncStatus('Syncing...', 'idle');
      } else {
        setGoogleSyncStatus(formatLastSynced(s.lastSyncedAt));
      }
    })
    .catch(() => {});
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
  if (configModal && !configModal.open) configModal.showModal();
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
  configModal = document.getElementById('configModal') as HTMLDialogElement | null;
  if (configModal) {
    setupConfigTabs(configModal);
    aiPane = configModal.querySelector<HTMLElement>('.config-pane[data-pane="ai"]');
  }
  saveConfigBtn = document.getElementById('saveConfig') as HTMLButtonElement | null;
  cancelConfigBtn = document.getElementById('cancelConfig') as HTMLButtonElement | null;
  aiProviderSelect = document.getElementById('aiProvider') as HTMLSelectElement | null;
  geminiApiKeyInput = document.getElementById('geminiApiKey') as HTMLInputElement | null;
  setupModelControls();
  geminiThinkingLevelSelect = document.getElementById(
    'geminiThinkingLevel',
  ) as HTMLSelectElement | null;
  loginCodexOAuthBtn = document.getElementById('loginCodexOAuth') as HTMLButtonElement | null;
  clearCodexOAuthBtn = document.getElementById('clearCodexOAuth') as HTMLButtonElement | null;
  codexOAuthStatus = document.getElementById('codexOAuthStatus');
  loginGoogleOAuthBtn = document.getElementById('loginGoogleOAuth') as HTMLButtonElement | null;
  clearGoogleOAuthBtn = document.getElementById('clearGoogleOAuth') as HTMLButtonElement | null;
  googleOAuthStatus = document.getElementById('googleOAuthStatus');
  googleDriveEnabledInput = document.getElementById(
    'googleDriveEnabled',
  ) as HTMLInputElement | null;
  googleDriveSyncNowBtn = document.getElementById(
    'googleDriveSyncNow',
  ) as HTMLButtonElement | null;
  googleDriveSyncStatusEl = document.getElementById('googleDriveSyncStatus');
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

      if (
        e.key === 'Backspace' &&
        knownWordsField!.value.length === 0 &&
        knownWordsValues.length > 0
      ) {
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

  // Google Drive OAuth + sync wiring. Same patterns as the Codex block above.
  window.electronAPI.onGoogleOAuthProgress((status) => {
    if (status.phase === 'browser-opened') {
      setGoogleOAuthStatus('Waiting for browser sign-in — click Sign in again to retry.');
    } else if (status.phase === 'progress' && status.message) {
      setGoogleOAuthStatus(status.message);
    }
  });

  window.electronAPI.onGoogleSyncStatus((status) => {
    if (status.phase === 'syncing') {
      setGoogleSyncStatus('Syncing...', 'idle');
    } else if (status.phase === 'success' && status.result) {
      const { uploaded, downloaded, skipped, conflicts, deleted, tombstoned } =
        status.result;
      const parts = [
        `${uploaded.length} uploaded`,
        `${downloaded.length} downloaded`,
        `${skipped.length} skipped`,
      ];
      if (conflicts.length > 0) parts.push(`${conflicts.length} conflict(s) backed up`);
      if (deleted.length > 0) parts.push(`${deleted.length} deleted`);
      if (tombstoned.length > 0) parts.push(`${tombstoned.length} marked for deletion`);
      setGoogleSyncStatus(`Synced just now (${parts.join(', ')})`, 'success');
    } else if (status.phase === 'error') {
      const errCount = status.result?.errors.length ?? 0;
      setGoogleSyncStatus(
        status.error ?? `Sync finished with ${errCount} error(s)`,
        'error',
      );
    }
  });

  if (loginGoogleOAuthBtn) {
    loginGoogleOAuthBtn.addEventListener('click', async () => {
      const myToken = ++googleLoginToken;
      setGoogleOAuthStatus('Opening browser sign-in...');
      const result = await window.electronAPI.loginGoogleOAuth();
      if (myToken !== googleLoginToken) return;
      if (result.success) {
        setGoogleOAuthStatus('Signed in', 'success');
      } else if (result.cancelled) {
        return;
      } else {
        setGoogleOAuthStatus(result.error, 'error');
      }
    });
  }

  if (clearGoogleOAuthBtn) {
    clearGoogleOAuthBtn.addEventListener('click', async () => {
      clearGoogleOAuthBtn!.disabled = true;
      try {
        const result = await window.electronAPI.clearGoogleOAuth();
        if (result.success) {
          setGoogleOAuthStatus('Not signed in');
          setGoogleSyncStatus('Sign in to sync.');
        } else {
          setGoogleOAuthStatus(result.error, 'error');
        }
      } finally {
        clearGoogleOAuthBtn!.disabled = false;
      }
    });
  }

  if (googleDriveSyncNowBtn) {
    googleDriveSyncNowBtn.addEventListener('click', async () => {
      googleDriveSyncNowBtn!.disabled = true;
      setGoogleSyncStatus('Syncing...', 'idle');
      try {
        const result = await window.electronAPI.syncGoogleDriveNow();
        if (!result.success) {
          setGoogleSyncStatus(result.error, 'error');
        }
        // success path is handled by the onGoogleSyncStatus listener
      } finally {
        googleDriveSyncNowBtn!.disabled = false;
      }
    });
  }

  const hideConfig = () => {
    configModal?.close();
    // Bumping the token drops any stale result from an in-flight Codex login
    // promise that resolves after the modal is gone.
    codexLoginToken++;
    googleLoginToken++;
    // Free port 1455 if a Codex sign-in is still pending so the next attempt
    // can bind a fresh loopback. Same for the Google loopback (dynamic port).
    window.electronAPI.cancelCodexOAuth().catch(() => {});
    window.electronAPI.cancelGoogleOAuth().catch(() => {});
  };

  // Native <dialog> emits `close` for any dismissal -- click on the X button,
  // Cancel/Save button, AND the ESC key. Route ESC through hideConfig so it
  // also drops in-flight Codex login state, instead of the browser's default
  // close-only behavior.
  if (configModal) {
    configModal.addEventListener('cancel', (e) => {
      e.preventDefault();
      hideConfig();
    });
  }

  if (saveConfigBtn) {
    saveConfigBtn.addEventListener('click', async () => {
      const aiProvider = aiProviderSelect?.value === 'codex' ? 'codex' : 'gemini';
      const geminiKey = geminiApiKeyInput?.value.trim() ?? '';
      const geminiModel = readModelValue('geminiModel');
      const geminiFlashModel = readModelValue('geminiFlashModel');
      const codexModel = readModelValue('codexModel');
      const codexTranscriptionModel = readModelValue('codexTranscriptionModel');
      // Coerce to one of the three valid levels; an out-of-range selection
      // (e.g. extension-injected DOM, stale form state) becomes the default.
      // Include 'medium' explicitly so a future change to the default doesn't
      // silently turn user-selected 'medium' into the new default.
      const rawThinkingLevel = geminiThinkingLevelSelect?.value;
      const geminiThinkingLevel =
        rawThinkingLevel === 'low' || rawThinkingLevel === 'medium' || rawThinkingLevel === 'high'
          ? rawThinkingLevel
          : 'medium';
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
        geminiThinkingLevel: geminiThinkingLevel,
        codexModel: codexModel,
        codexTranscriptionModel: codexTranscriptionModel,
        notionApiKey: notionKey,
        notionDatabaseId: notionDb,
        slackWebhookUrl: slackWebhookUrl,
        slackAutoShare: slackAutoShare,
        googleDriveEnabled: !!googleDriveEnabledInput?.checked,
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
