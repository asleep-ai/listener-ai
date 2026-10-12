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
import type { ConfigPayload, ElectronAPI, GoogleSyncProgress } from '../electronAPI';
import {
  LEGACY_CODEX_PROVIDER,
  type LiveSttProvider,
  type TranscriptionProvider,
  chatgptPlaceholderModel,
  normalizeTranscriptionProvider,
  showLegacyCodexNotice,
} from '../../src/aiProvider';
import { applySettingsFields, parseLiveSttProvider, readSettingsFields } from './settings-fields';
import { diffConfigPayload } from '../../src/configDiff';
import { DEFAULT_GLOBAL_SHORTCUT } from '../../src/configKeys';
import {
  type CredentialUse,
  credentialUsage,
  describeCredentialUse,
} from '../../src/settingsVisibility';
import { formatUsd } from '../../src/usageFormat';
import {
  createManageUsageButton,
  isChatGPTUsageLimitCode,
  openChatGPTUsage,
} from '../services/chatgpt-usage';

let configModal: HTMLDialogElement | null = null;
let saveConfigBtn: HTMLButtonElement | null = null;
let cancelConfigBtn: HTMLButtonElement | null = null;
let aiProviderSelect: HTMLSelectElement | null = null;
let geminiApiKeyInput: HTMLInputElement | null = null;
let liveSttProviderSelect: HTMLSelectElement | null = null;
let transcriptionProviderSelect: HTMLSelectElement | null = null;
let transcriptionProviderNotice: HTMLElement | null = null;
let openaiApiKeyInput: HTMLInputElement | null = null;
let sonioxApiKeyInput: HTMLInputElement | null = null;
let liveProviderNotice: HTMLElement | null = null;
let legacyCodexNotice: HTMLElement | null = null;
let chatgptCard: HTMLElement | null = null;
let chatgptStatusEl: HTMLElement | null = null;
let chatgptPlanBadge: HTMLElement | null = null;
let chatgptLoginBtn: HTMLButtonElement | null = null;
let chatgptCancelLoginBtn: HTMLButtonElement | null = null;
let chatgptLogoutBtn: HTMLButtonElement | null = null;
let chatgptProfileGroup: HTMLElement | null = null;
let chatgptProfileSelect: HTMLSelectElement | null = null;
let chatgptAddProfileBtn: HTMLButtonElement | null = null;
let chatgptNotice: HTMLElement | null = null;
let chatgptNoticeText: HTMLElement | null = null;
let chatgptNoticeActions: HTMLElement | null = null;
let chatgptUsingPlan: HTMLElement | null = null;
let chatgptModelSelect: HTMLSelectElement | null = null;
let chatgptRefreshModelsBtn: HTMLButtonElement | null = null;
let chatgptPlanDialog: HTMLDialogElement | null = null;
let loginGoogleOAuthBtn: HTMLButtonElement | null = null;
let clearGoogleOAuthBtn: HTMLButtonElement | null = null;
let googleOAuthStatus: HTMLElement | null = null;
let googleDriveSyncNowBtn: HTMLButtonElement | null = null;
let googleDriveSyncStatusEl: HTMLElement | null = null;
let slackWebhookUrlInput: HTMLInputElement | null = null;
let testSlackWebhookBtn: HTMLButtonElement | null = null;
let slackWebhookStatus: HTMLElement | null = null;
let globalShortcutInput: HTMLInputElement | null = null;
let knownWordsContainer: HTMLElement | null = null;
let defaultSummaryPrompt = '';
let knownWordsField: HTMLInputElement | null = null;
let knownWordsValues: string[] = [];
// What the form read back as right after prefill. Save sends only the fields
// that differ from it, so resolved defaults and env-sourced secrets the user
// never touched stay out of config.json.
let settingsBaseline: ConfigPayload = {};
// The backend sends resolved defaults, so an explicit stored default is
// indistinguishable from an unset value. A Reset click must still clear it.
const resetSettingsKeys = new Set<keyof ConfigPayload>();
let aiPane: HTMLElement | null = null;
let aiRequiredBadge: HTMLElement | null = null;

// Shapes come from the preload bridge so this module tracks the main-process
// contract. Tokens never cross into the renderer: the status carries only
// connection, plan-usage and account display fields.
type ChatGPTStatus = Awaited<ReturnType<ElectronAPI['getChatGPTStatus']>>['status'];
type ChatGPTModels = Extract<
  Awaited<ReturnType<ElectronAPI['listChatGPTModels']>>,
  { success: true }
>['models'];
type ChatGPTProfiles = Extract<
  Awaited<ReturnType<ElectronAPI['listChatGPTProfiles']>>,
  { success: true }
>['profiles'];

const CHATGPT_DISCONNECTED: ChatGPTStatus = { connected: false, planEnabled: false };
let chatgptStatus: ChatGPTStatus = CHATGPT_DISCONNECTED;
// The saved `chatgptModel`. Kept separately from the <select> because the
// select is rebuilt from the account's model list, which may not contain it.
let chatgptSavedModel = '';
let chatgptPlanNoticeAcknowledged = false;
let chatgptLoginInFlight = false;
// A stored retired `transcriptionProvider=codex` shows as a disabled
// placeholder option in the select; this keeps the removal explained until
// the user picks a backend.
let legacyTranscriptionMessage = '';
// Retired Codex values are still stored. The notice stays until a ChatGPT
// sign-in exists, since the stored values are kept for migration.
let legacyCodexConfigured = false;

// Each sign-in click bumps this; the in-flight click checks its captured
// token against the current one after `await`, discarding stale results from
// prior attempts that were aborted by a newer click or a cancel.
let chatgptLoginToken = 0;
let googleLoginToken = 0;
// Bumped on every account switch or reload so a slow model list for the
// previous account cannot overwrite the current one.
let chatgptModelsToken = 0;
// Same guard for the saved-account list.
let chatgptProfilesToken = 0;
// Saved ChatGPT registrations, listed whether or not the active one is
// signed in, so signing out of one account never hides the others.
let chatgptProfiles: ChatGPTProfiles = [];

// Value of the placeholder option shown while the stored transcription
// provider is the retired `codex`. Disabled, so the user cannot pick it; Save
// omits the field while it is selected, keeping the stored value untouched.
const LEGACY_TRANSCRIPTION_OPTION = 'legacy-codex';

const MODEL_FIELDS: readonly ModelField[] = [
  'geminiModel',
  'geminiFlashModel',
  'openaiTranscriptionModel',
];

const RESET_BUTTON_IDS: Record<ModelField, string> = {
  geminiModel: 'resetGeminiModel',
  geminiFlashModel: 'resetGeminiFlashModel',
  openaiTranscriptionModel: 'resetOpenaiTranscriptionModel',
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

// The hand-written controls' share of the save payload.
function readOtherSettings(): ConfigPayload {
  const summaryPromptInput = document.getElementById('summaryPrompt') as HTMLTextAreaElement | null;
  const summaryPrompt = summaryPromptInput ? summaryPromptInput.value.trim() : '';
  // Like the summary prompt, the default shortcut reads back as '' (the stored
  // "use the default" value), so Reset clears a saved shortcut instead of
  // pinning today's default into config.json.
  const globalShortcut = globalShortcutInput ? globalShortcutInput.value.trim() : '';
  return {
    geminiModel: readModelValue('geminiModel'),
    geminiFlashModel: readModelValue('geminiFlashModel'),
    openaiTranscriptionModel: readModelValue('openaiTranscriptionModel'),
    chatgptModel: readChatGPTModel(),
    knownWords: [...knownWordsValues],
    summaryPrompt: summaryPrompt === defaultSummaryPrompt ? '' : summaryPrompt,
    globalShortcut: globalShortcut === DEFAULT_GLOBAL_SHORTCUT ? '' : globalShortcut,
  };
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
    if (resetBtn) {
      resetBtn.onclick = () => {
        applyModelValue(field, '');
        resetSettingsKeys.add(field);
      };
    }
  }
}

// Apply the project's status-pill styling to a target element. Reused by the
// Google sign-in and Google sync status indicators -- both pills share the
// same CSS surface, only the target element differs.
function setStatusEl(
  el: HTMLElement | null,
  text: string,
  state: 'idle' | 'success' | 'error' = 'idle',
): void {
  if (!el) return;
  el.textContent = text;
  el.className = `slack-webhook-status${state === 'idle' ? '' : ` is-${state}`}`;
}

function setGoogleOAuthStatus(text: string, state: 'idle' | 'success' | 'error' = 'idle'): void {
  setStatusEl(googleOAuthStatus, text, state);
}

function setGoogleSyncStatus(text: string, state: 'idle' | 'success' | 'error' = 'idle'): void {
  setStatusEl(googleDriveSyncStatusEl, text, state);
}

// --- ChatGPT connection card -------------------------------------------------

function chatgptPlanUsable(): boolean {
  return chatgptStatus.connected && chatgptStatus.planEnabled;
}

function readChatGPTModel(): string {
  // A disabled select (signed out, identity only, loading, list failed) still
  // carries the kept value (the saved model, or the user's unsaved pick) as
  // its only option, so reading it never drops a choice the user made.
  return chatgptModelSelect?.value ?? chatgptSavedModel;
}

function hideChatGPTNotice(): void {
  if (!chatgptNotice) return;
  chatgptNotice.hidden = true;
  chatgptNotice.className = 'config-notice';
  if (chatgptNoticeText) chatgptNoticeText.textContent = '';
  if (chatgptNoticeActions) chatgptNoticeActions.hidden = true;
}

function showChatGPTNotice(
  text: string,
  state: 'info' | 'success' | 'warning' | 'error',
  opts: { manageUsage?: boolean } = {},
): void {
  if (!chatgptNotice || !chatgptNoticeText) return;
  chatgptNoticeText.textContent = text;
  chatgptNotice.className = `config-notice is-${state}`;
  chatgptNotice.hidden = false;
  if (chatgptNoticeActions) chatgptNoticeActions.hidden = !opts.manageUsage;
}

// Error codes main attaches to a failed ChatGPT call. A usage-limit error makes
// Manage usage the primary action (SIWC UI guidelines); nothing falls back to
// another provider or billing path.
const CHATGPT_USAGE_GUIDANCE: Record<string, string> = {
  usage_limit_exceeded:
    "Your ChatGPT plan's usage limit was reached. Check Manage usage, wait for the limit to reset, or choose another AI provider.",
  usage_unavailable:
    'ChatGPT plan usage is unavailable right now. Check Manage usage, try again later, or choose another AI provider.',
  not_eligible:
    'This ChatGPT account is not eligible for plan usage in Listener.AI (ChatGPT Plus or Pro is required). Check Manage usage or choose another AI provider.',
};

function showChatGPTError(error: string, code?: string): void {
  if (isChatGPTUsageLimitCode(code)) {
    const guidance =
      CHATGPT_USAGE_GUIDANCE[code ?? ''] ?? CHATGPT_USAGE_GUIDANCE.usage_limit_exceeded;
    showChatGPTNotice(`${error} ${guidance}`, 'error', { manageUsage: true });
    return;
  }
  showChatGPTNotice(error, 'error');
}

function setChatGPTBusy(busy: boolean, label?: string): void {
  chatgptLoginInFlight = busy;
  if (chatgptCard) chatgptCard.setAttribute('aria-busy', busy ? 'true' : 'false');
  if (chatgptLoginBtn) chatgptLoginBtn.disabled = busy;
  if (chatgptAddProfileBtn) chatgptAddProfileBtn.disabled = busy;
  if (chatgptProfileSelect) chatgptProfileSelect.disabled = busy;
  if (chatgptCancelLoginBtn) chatgptCancelLoginBtn.hidden = !busy;
  if (busy && label && chatgptStatusEl) chatgptStatusEl.textContent = label;
}

// Display name of a saved registration. Two registrations can share an email
// (one per workspace), so when the auth store gives no label, a duplicate or
// missing email gets a suffix from the registration's immutable id. That
// keeps names distinct and stable across reloads, sign-outs and switches,
// without inventing a workspace name.
function chatgptProfileLabel(profile: ChatGPTProfiles[number]): string {
  const label = (profile as { label?: string }).label?.trim();
  const email = profile.email?.trim();
  if (label) return email && email !== label ? `${email} · ${label}` : label;
  const shared =
    !email || chatgptProfiles.some((p) => p.id !== profile.id && p.email?.trim() === email);
  const base = email || 'ChatGPT account';
  return shared ? `${base} · registration ${profile.id.slice(0, 8)}` : base;
}

function activeChatGPTLabel(): string | undefined {
  const { profileId } = chatgptStatus;
  const profile = profileId ? chatgptProfiles.find((p) => p.id === profileId) : undefined;
  if (profile) return chatgptProfileLabel(profile);
  return chatgptStatus.email;
}

function renderLegacyCodexNotice(): void {
  if (!legacyCodexNotice) return;
  legacyCodexNotice.hidden = !showLegacyCodexNotice({
    legacyCodexConfigured,
    selectedAiProvider: aiProviderSelect?.value,
    chatgptConnected: chatgptStatus.connected,
  });
}

function renderChatGPTCard(): void {
  const { connected, planEnabled, profileId } = chatgptStatus;
  const name = activeChatGPTLabel();
  renderLegacyCodexNotice();
  if (chatgptStatusEl && !chatgptLoginInFlight) {
    chatgptStatusEl.textContent = connected
      ? `Connected as ${name || 'your ChatGPT account'}`
      : profileId && name
        ? `Signed out of ${name}. Sign in again, or choose or add another account.`
        : 'Not connected';
  }
  if (chatgptPlanBadge) {
    chatgptPlanBadge.hidden = !connected;
    if (planEnabled) {
      chatgptPlanBadge.textContent = 'Plan usage enabled. Listener.AI uses your ChatGPT plan.';
      chatgptPlanBadge.className = 'chatgpt-plan-badge is-enabled';
    } else if ((chatgptStatus as { planState?: string }).planState === 'incomplete') {
      // Plan scope granted but no renewable token pair: consent must be redone.
      chatgptPlanBadge.textContent =
        'Plan usage needs to be enabled again before Listener.AI can use your ChatGPT plan. Select Enable ChatGPT plan, or choose another AI provider above.';
      chatgptPlanBadge.className = 'chatgpt-plan-badge is-disabled';
    } else {
      chatgptPlanBadge.textContent =
        'Signed in for identity only. Plan usage is not enabled, so Listener.AI will not use your ChatGPT plan. Select Enable ChatGPT plan to allow it, or choose another AI provider above.';
      chatgptPlanBadge.className = 'chatgpt-plan-badge is-disabled';
    }
  }
  if (chatgptLoginBtn) {
    // Hidden once plan usage works. After an identity-only consent it becomes
    // the explicit Enable ChatGPT plan action (errors-and-recovery guidance).
    chatgptLoginBtn.hidden = connected && planEnabled;
    chatgptLoginBtn.textContent =
      connected && !planEnabled ? 'Enable ChatGPT plan' : 'Continue with ChatGPT';
  }
  if (chatgptLogoutBtn) chatgptLogoutBtn.hidden = !connected;
  // Shown whenever an account is saved, signed in or not, so the user can
  // switch to another saved account or add one after signing out.
  if (chatgptProfileGroup) chatgptProfileGroup.hidden = !connected && chatgptProfiles.length === 0;
  if (chatgptUsingPlan) chatgptUsingPlan.hidden = !chatgptPlanUsable();
  if (chatgptRefreshModelsBtn) chatgptRefreshModelsBtn.disabled = !chatgptPlanUsable();
}

// Placeholder state for the model select when no account list is available.
// Keeps one choice as the only option so Save never rewrites it: the saved
// model when Settings opens, otherwise (`keepCurrent`) the current pick, which
// survives loading, a failed refresh and an account switch even though the
// placeholder before it disabled the select.
function renderChatGPTModelPlaceholder(reason: string, keepCurrent = false): void {
  if (!chatgptModelSelect) return;
  const value = chatgptPlaceholderModel(chatgptModelSelect, chatgptSavedModel, keepCurrent);
  chatgptModelSelect.innerHTML = '';
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = value ? `${value} (${reason})` : `Default (${reason})`;
  chatgptModelSelect.appendChild(opt);
  chatgptModelSelect.value = value;
  chatgptModelSelect.disabled = true;
}

function renderChatGPTModels(models: ChatGPTModels): void {
  if (!chatgptModelSelect) return;
  const previous = chatgptModelSelect.value;
  chatgptModelSelect.innerHTML = '';
  const first = models[0];
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = first ? `Default (${first.display_name || first.slug})` : 'Default';
  chatgptModelSelect.appendChild(defaultOpt);
  for (const model of models) {
    const opt = document.createElement('option');
    opt.value = model.slug;
    opt.textContent =
      model.display_name && model.display_name !== model.slug
        ? `${model.display_name} (${model.slug})`
        : model.slug;
    chatgptModelSelect.appendChild(opt);
  }
  // A saved model this account does not list stays selected and labeled, so
  // switching accounts never silently substitutes another model.
  if (previous && !models.some((m) => m.slug === previous)) {
    const opt = document.createElement('option');
    opt.value = previous;
    opt.textContent = `${previous} (not available for this account)`;
    chatgptModelSelect.appendChild(opt);
    showChatGPTNotice(
      `The saved model ${previous} is not in this account's model list. Choose another model or Default.`,
      'warning',
    );
  }
  chatgptModelSelect.value = previous;
  chatgptModelSelect.disabled = false;
}

async function loadChatGPTModels(): Promise<void> {
  const myToken = ++chatgptModelsToken;
  if (!chatgptStatus.connected) {
    renderChatGPTModelPlaceholder('sign in to load models', true);
    return;
  }
  if (!chatgptStatus.planEnabled) {
    renderChatGPTModelPlaceholder('plan usage not enabled', true);
    return;
  }
  renderChatGPTModelPlaceholder('loading...', true);
  try {
    const result = await window.electronAPI.listChatGPTModels();
    if (myToken !== chatgptModelsToken) return;
    if (result.success) {
      renderChatGPTModels(result.models);
    } else {
      renderChatGPTModelPlaceholder('model list unavailable', true);
      showChatGPTError(result.error, result.code);
    }
  } catch (e) {
    if (myToken !== chatgptModelsToken) return;
    renderChatGPTModelPlaceholder('model list unavailable', true);
    showChatGPTError(e instanceof Error ? e.message : String(e));
  }
}

function renderChatGPTProfiles(profiles: ChatGPTProfiles): void {
  chatgptProfiles = profiles;
  if (chatgptProfileSelect) {
    chatgptProfileSelect.innerHTML = '';
    for (const profile of profiles) {
      const opt = document.createElement('option');
      opt.value = profile.id;
      const state = !profile.connected
        ? ' (signed out, sign in again to use)'
        : profile.planEnabled
          ? ''
          : ' (identity only)';
      opt.textContent = `${chatgptProfileLabel(profile)}${state}`;
      chatgptProfileSelect.appendChild(opt);
    }
    const active = chatgptStatus.profileId ?? profiles.find((p) => p.active)?.id;
    if (active) chatgptProfileSelect.value = active;
  }
  // Labels feed the status line and group visibility.
  renderChatGPTCard();
}

// Lists saved registrations independently of whether the active one is
// signed in. Listing never runs inference or reads tokens in the renderer.
async function loadChatGPTProfiles(): Promise<void> {
  const myToken = ++chatgptProfilesToken;
  try {
    const result = await window.electronAPI.listChatGPTProfiles();
    if (myToken !== chatgptProfilesToken) return;
    if (result.success) renderChatGPTProfiles(result.profiles);
    else showChatGPTError(result.error, result.code);
  } catch (e) {
    if (myToken !== chatgptProfilesToken) return;
    showChatGPTError(e instanceof Error ? e.message : String(e));
  }
}

async function applyChatGPTStatus(status: ChatGPTStatus): Promise<void> {
  chatgptStatus = status;
  renderChatGPTCard();
  updateAiRequiredBadge();
  updateTranscriptionProviderNotice();
  updateLiveProviderNotice();
  await Promise.all([loadChatGPTProfiles(), loadChatGPTModels()]);
}

async function refreshChatGPTState(): Promise<void> {
  hideChatGPTNotice();
  try {
    const result = await window.electronAPI.getChatGPTStatus();
    await applyChatGPTStatus(result.status);
  } catch (e) {
    await applyChatGPTStatus(CHATGPT_DISCONNECTED);
    showChatGPTError(e instanceof Error ? e.message : String(e));
  }
}

// One-time "You're using your ChatGPT plan" explanation. Persisted the moment
// the user acknowledges it, independent of the Settings Save button.
function maybeShowChatGPTPlanDialog(): void {
  if (chatgptPlanNoticeAcknowledged || !chatgptPlanUsable() || !chatgptPlanDialog) return;
  if (!chatgptPlanDialog.open) chatgptPlanDialog.showModal();
}

// `requestPlanConsent` asks main to re-prompt for plan consent; sent only from
// the deliberate Enable ChatGPT plan action, never on an ordinary sign-in.
type ChatGPTLoginOptions = Parameters<ElectronAPI['loginChatGPT']>[0];

async function runChatGPTLogin(opts?: ChatGPTLoginOptions): Promise<void> {
  // Reentrant: each click aborts any prior in-flight attempt on main; the
  // token guard drops the aborted attempt's stale result.
  const myToken = ++chatgptLoginToken;
  hideChatGPTNotice();
  setChatGPTBusy(true, 'Opening your browser to sign in...');
  let result: Awaited<ReturnType<ElectronAPI['loginChatGPT']>>;
  try {
    result = await window.electronAPI.loginChatGPT(opts);
  } catch (e) {
    if (myToken !== chatgptLoginToken) return;
    setChatGPTBusy(false);
    renderChatGPTCard();
    showChatGPTError(e instanceof Error ? e.message : String(e));
    return;
  }
  if (myToken !== chatgptLoginToken) return;
  setChatGPTBusy(false);
  if (result.success) {
    if (aiProviderSelect) aiProviderSelect.value = 'chatgpt';
    applyCredentialVisibility();
    await applyChatGPTStatus(result.status);
    if (!result.status.planEnabled) {
      showChatGPTNotice(
        'Signed in, but plan usage was not allowed. Listener.AI will not use your ChatGPT plan until you select Enable ChatGPT plan and allow it.',
        'warning',
      );
    }
    maybeShowChatGPTPlanDialog();
  } else if (result.cancelled) {
    renderChatGPTCard();
    if (chatgptStatusEl && !chatgptStatus.connected)
      chatgptStatusEl.textContent = 'Sign-in cancelled';
  } else {
    renderChatGPTCard();
    showChatGPTError(result.error, result.code);
  }
}

function readLiveProvider(): LiveSttProvider {
  return parseLiveSttProvider(liveSttProviderSelect?.value);
}

function readTranscriptionProvider(): TranscriptionProvider {
  return normalizeTranscriptionProvider(transcriptionProviderSelect?.value);
}

// A notice that names a missing credential links straight to it: credentials
// live on the AI connection tab while the choices that need them are here.
type NoticeLink = { target: string; label: string };

function renderNotice(el: HTMLElement, text: string, link?: NoticeLink): void {
  el.textContent = text;
  if (link && text.length > 0) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'config-link-button';
    button.dataset.goto = link.target;
    button.textContent = link.label;
    el.append(' ', button);
  }
  el.hidden = text.length === 0;
}

const GEMINI_KEY_LINK: NoticeLink = { target: 'geminiApiKey', label: 'Add a Gemini API key' };
const OPENAI_KEY_LINK: NoticeLink = { target: 'openaiApiKey', label: 'Add an OpenAI API key' };
const SONIOX_KEY_LINK: NoticeLink = { target: 'sonioxApiKey', label: 'Add a Soniox API key' };

function setLiveProviderNotice(
  text: string,
  state: 'info' | 'success' | 'warning' | 'error' = 'info',
  link?: NoticeLink,
): void {
  if (!liveProviderNotice) return;
  renderNotice(liveProviderNotice, text, link);
  liveProviderNotice.className = `config-notice is-${state}`;
}

// Shows (or removes) the disabled placeholder for a stored retired `codex`
// transcription provider. Nothing is written until the user picks a real
// backend: opening Settings, switching AI provider, signing in, or saving an
// unrelated setting leaves the stored value, and audio stays off, as before.
function setLegacyTranscriptionOption(show: boolean): void {
  if (!transcriptionProviderSelect) return;
  transcriptionProviderSelect
    .querySelector(`option[value="${LEGACY_TRANSCRIPTION_OPTION}"]`)
    ?.remove();
  if (!show) return;
  const opt = document.createElement('option');
  opt.value = LEGACY_TRANSCRIPTION_OPTION;
  opt.textContent = 'Codex (removed): choose a provider';
  opt.disabled = true;
  transcriptionProviderSelect.prepend(opt);
  transcriptionProviderSelect.value = LEGACY_TRANSCRIPTION_OPTION;
}

function isLegacyTranscriptionSelected(): boolean {
  return transcriptionProviderSelect?.value === LEGACY_TRANSCRIPTION_OPTION;
}

// Everything Save compares against the baseline. While the retired-provider
// placeholder is selected the field is left out on both sides, so the save
// delta never carries it; any explicit choice, Follow summary provider included,
// then differs from the (absent) baseline and is written.
function readModalSettings(fields: ConfigPayload = readSettingsFields()): ConfigPayload {
  const next = { ...fields, ...readOtherSettings() };
  if (isLegacyTranscriptionSelected()) delete next.transcriptionProvider;
  return next;
}

// Why the current Transcription choice cannot run, or '' when it can.
function transcriptionProviderProblem(): string {
  if (legacyTranscriptionMessage) return legacyTranscriptionMessage;
  const provider = readTranscriptionProvider();
  if (provider === 'auto' && aiProviderSelect?.value === 'chatgpt') {
    // Never redirected silently: Auto under ChatGPT refuses audio work at run
    // time, so the user picks who receives and bills the audio. Saving a
    // text-only ChatGPT setup is still allowed.
    return 'Recording transcription is off: ChatGPT sign-in cannot transcribe audio. Summaries, report regeneration, and Ask Listener still work on existing transcripts. To transcribe recordings, choose Gemini, OpenAI API, or Soniox.';
  }
  if (provider === 'openai' && (openaiApiKeyInput?.value.trim() ?? '').length === 0) {
    return 'OpenAI transcription needs an OpenAI API key, saved under AI connection and billed to your OpenAI API account, not your ChatGPT plan. Add one or choose another service.';
  }
  if (provider === 'soniox' && (sonioxApiKeyInput?.value.trim() ?? '').length === 0) {
    return 'Soniox transcription needs a Soniox API key, saved under AI connection. Add one or choose another service.';
  }
  return '';
}

// The credential the transcription notice names, if it names one. The ChatGPT
// and retired-Codex notices ask for a different choice, not a key.
function transcriptionProviderLink(): NoticeLink | undefined {
  if (legacyTranscriptionMessage) return undefined;
  const provider = readTranscriptionProvider();
  if (provider === 'openai') return OPENAI_KEY_LINK;
  if (provider === 'soniox') return SONIOX_KEY_LINK;
  return undefined;
}

function updateTranscriptionProviderNotice(): void {
  if (!transcriptionProviderNotice) return;
  const text = transcriptionProviderProblem();
  const warn = text.length > 0;
  renderNotice(transcriptionProviderNotice, text, transcriptionProviderLink());
  // Only carry the warning state while there is a warning: a hidden element
  // that keeps `is-warning` shows up as one in a11y tooling and in any future
  // styling that reads the class rather than `hidden`.
  transcriptionProviderNotice.className = warn ? 'config-notice is-warning' : 'config-notice';
}

function updateLiveProviderNotice(): void {
  const provider = readLiveProvider();
  const hasOpenAiKey = (openaiApiKeyInput?.value.trim() ?? '').length > 0;
  const hasGeminiKey = (geminiApiKeyInput?.value.trim() ?? '').length > 0;
  const hasSonioxKey = (sonioxApiKeyInput?.value.trim() ?? '').length > 0;

  if (provider === 'soniox') {
    setLiveProviderNotice(
      hasSonioxKey
        ? 'Soniox realtime will handle live captions.'
        : 'Soniox realtime needs a Soniox API key, saved under AI connection. Add one or choose another service.',
      hasSonioxKey ? 'success' : 'warning',
      hasSonioxKey ? undefined : SONIOX_KEY_LINK,
    );
    return;
  }

  if (provider === 'chunked') {
    setLiveProviderNotice(
      'Live captions will use 12-second chunks through your transcription service, with any translation by the summary provider. This is slower but needs no live caption credentials.',
      'info',
    );
    return;
  }

  if (provider === 'gemini') {
    if (hasGeminiKey) {
      setLiveProviderNotice(
        'Gemini Live will handle live transcription and translation.',
        'success',
      );
    } else {
      setLiveProviderNotice(
        'Gemini Live needs a Gemini API key. Add one or choose 12s fallback.',
        'warning',
        GEMINI_KEY_LINK,
      );
    }
    return;
  }

  if (hasOpenAiKey) {
    setLiveProviderNotice(
      'OpenAI Realtime live translation will use this OpenAI API key.',
      'success',
    );
    return;
  }

  if (provider === 'openai') {
    if (hasGeminiKey) {
      setLiveProviderNotice(
        'OpenAI Realtime live translation needs an OpenAI API key. Without one, Listener.AI will fall back to Gemini Live.',
        'warning',
        OPENAI_KEY_LINK,
      );
    } else {
      setLiveProviderNotice(
        'OpenAI Realtime live translation needs an OpenAI API key. ChatGPT sign-in does not cover live captions.',
        'warning',
        OPENAI_KEY_LINK,
      );
    }
    return;
  }

  if (hasGeminiKey) {
    setLiveProviderNotice(
      'Auto will use Gemini Live unless you add an OpenAI API key for OpenAI Realtime.',
      'info',
    );
  } else {
    setLiveProviderNotice(
      chatgptStatus.connected
        ? 'ChatGPT sign-in does not cover live captions. Live streaming needs an OpenAI API key or Gemini API key; otherwise use 12s fallback.'
        : 'Auto needs an OpenAI API key or Gemini API key for streaming live translation; otherwise use 12s fallback.',
      'warning',
      { target: 'openaiApiKey', label: 'Open AI connection' },
    );
  }
}

// Translate a progress event into the pill label. Kept separate from the
// onGoogleSyncStatus handler because the same shape arrives from two paths:
// live `google-sync-progress` IPC events, and the snapshot returned by
// getGoogleSyncStatus when the modal opens mid-sync.
function syncProgressText(progress: GoogleSyncProgress): string {
  if (progress.type === 'scanning') return 'Scanning...';
  return `Syncing ${progress.index}/${progress.total}: ${progress.meeting}`;
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

// Gate a deliberate AI action on the credentials it needs: the AI provider
// (summary, report regeneration, Ask Listener) and, for audio work, the
// selected transcription backend, which can be a different vendor with its
// own key. Returns true when the caller can proceed; false when Settings has
// been opened on the missing setting instead. Startup never calls this, so the
// app opens without a setup prompt. Nothing here signs in or switches vendor.
export async function requireAiSetup({
  transcription,
}: {
  transcription: boolean;
}): Promise<boolean> {
  const configCheck = await window.electronAPI.checkConfig();
  if (configCheck.hasAiAuth && (!transcription || configCheck.hasTranscriptionAuth)) return true;
  const message = !configCheck.hasAiAuth
    ? 'Please configure your AI provider first'
    : !configCheck.transcriptionProvider && configCheck.transcriptionProviderIssue
      ? configCheck.transcriptionProviderIssue
      : configCheck.transcriptionProvider === 'soniox'
        ? 'Transcription is set to Soniox, but no Soniox API key is saved. Add the key in Settings > AI connection, or choose another service under Transcription and summary.'
        : 'The selected transcription service has no credentials saved. Add them in Settings > AI connection, or choose another service under Transcription and summary.';
  // Open Settings on the exact setting that is missing.
  const focus = !configCheck.hasAiAuth
    ? configCheck.aiProvider === 'chatgpt'
      ? 'chatgptLogin'
      : 'geminiApiKey'
    : configCheck.transcriptionProvider === 'soniox'
      ? 'sonioxApiKey'
      : configCheck.transcriptionProvider === 'openai'
        ? 'openaiApiKey'
        : configCheck.transcriptionProvider === 'gemini'
          ? 'geminiApiKey'
          : 'transcriptionProvider';
  if (document.getElementById('configModal')) {
    // The provider case is self-evident once Settings opens; a missing backend
    // key is not, so name it before the modal appears.
    if (configCheck.hasAiAuth) alert(message);
    void showConfigModal({ focus });
  } else {
    alert(message);
  }
  return false;
}

export type ConfigModalOptions = {
  /** Element id to reveal and focus once the modal opens; picks its tab. */
  focus?: string;
};

// Function to show the config modal
export async function showConfigModal(options: ConfigModalOptions = {}): Promise<void> {
  // Cmd+, while the modal is already open should be a no-op rather than
  // discarding the user's in-progress edits by re-fetching config.
  if (configModal && configModal.open) return;

  // Load current config. ConfigPayload doubles as the load shape -- main
  // returns the same field set it accepts -- plus the read-only OAuth flags.
  const config = (await window.electronAPI.getConfig()) as ConfigPayload & {
    googleOAuthConfigured?: boolean;
    legacyCodexConfigured?: boolean;
    transcriptionProviderIssue?: { issue?: string; message?: string };
  };

  // Pre-fill the form if values exist
  resetSettingsKeys.clear();
  applySettingsFields(config);
  applyModelValue('geminiModel', config.geminiModel);
  applyModelValue('geminiFlashModel', config.geminiFlashModel);
  applyModelValue('openaiTranscriptionModel', config.openaiTranscriptionModel);
  chatgptSavedModel = (config.chatgptModel ?? '').trim();
  chatgptPlanNoticeAcknowledged = config.chatgptPlanNoticeAcknowledged === true;
  // A pre-ChatGPT install that used Codex keeps its old values on disk for
  // migration, but they are never reused: the user signs in again.
  legacyCodexConfigured = config.legacyCodexConfigured === true;
  chatgptStatus = CHATGPT_DISCONNECTED;
  chatgptProfiles = [];
  hideChatGPTNotice();
  renderChatGPTCard();
  renderChatGPTModelPlaceholder('loading...');
  setGoogleOAuthStatus(
    config.googleOAuthConfigured ? 'Signed in' : 'Not signed in',
    config.googleOAuthConfigured ? 'success' : 'idle',
  );
  // Pull the current sync status (last synced, in-flight, current progress)
  // so the modal is accurate on open even if no event has fired since boot.
  // If we land mid-sync with a known progress event, render that immediately
  // instead of a generic "Syncing..." so the user doesn't see a phantom regress.
  window.electronAPI
    .getGoogleSyncStatus()
    .then((s) => {
      if (s.inFlight) {
        setGoogleSyncStatus(s.progress ? syncProgressText(s.progress) : 'Syncing...', 'idle');
      } else {
        setGoogleSyncStatus(formatLastSynced(s.lastSyncedAt));
      }
    })
    .catch(() => {});
  if (slackWebhookStatus) {
    slackWebhookStatus.textContent = '';
    slackWebhookStatus.className = 'slack-webhook-status';
  }
  knownWordsValues = (config.knownWords || []).filter(
    (w): w is string => typeof w === 'string' && w.trim().length > 0,
  );
  if (knownWordsField) knownWordsField.value = '';
  renderKnownWordsChips();

  // Pre-fill summary prompt
  const summaryPromptInput = document.getElementById('summaryPrompt') as HTMLTextAreaElement | null;
  defaultSummaryPrompt = config.defaultSummaryPrompt || '';
  if (summaryPromptInput) {
    summaryPromptInput.value = config.summaryPrompt || defaultSummaryPrompt;
  }

  const resetPromptBtn = document.getElementById('resetPrompt') as HTMLButtonElement | null;
  if (resetPromptBtn) {
    resetPromptBtn.onclick = () => {
      if (summaryPromptInput) {
        summaryPromptInput.value = defaultSummaryPrompt;
        resetSettingsKeys.add('summaryPrompt');
      }
    };
  }

  legacyTranscriptionMessage = '';
  setLegacyTranscriptionOption(config.transcriptionProviderIssue?.issue === 'legacy-codex');
  settingsBaseline = readModalSettings();
  if (isLegacyTranscriptionSelected()) {
    legacyTranscriptionMessage =
      'Codex transcription was removed, so recordings are not transcribed. Choose a transcription service and save: Gemini, OpenAI API (billed to your OpenAI API key), Soniox, or Follow summary provider.';
  }

  // Status and the account's model list load after the baseline is taken; the
  // model select keeps the saved value throughout, so the diff stays clean.
  void refreshChatGPTState();

  clearFieldError(geminiApiKeyInput, 'geminiApiKeyError');
  clearFieldError(globalShortcutInput, 'globalShortcutError');
  applyCredentialVisibility();
  updateAiRequiredBadge();
  updateLiveProviderNotice();
  updateTranscriptionProviderNotice();

  // Refresh "Usage this month" card on each open so the totals stay current
  // even if the user has been recording in the same session. Fire-and-forget;
  // missing data renders as zeros.
  void refreshUsageSummaryCard();

  // AI connection carries the required-credentials state; open there so the
  // user sees setup status first, unless the caller names a specific setting.
  activateConfigTab('ai');
  if (configModal && !configModal.open) configModal.showModal();
  if (options.focus) goToSetting(options.focus);
}

async function refreshUsageSummaryCard(): Promise<void> {
  const totalEl = document.getElementById('usageSummaryTotal');
  const listEl = document.getElementById('usageSummaryBreakdown');
  if (!totalEl || !listEl) return;
  totalEl.textContent = '…';
  listEl.innerHTML = '';
  try {
    const res = await window.electronAPI.getUsageSummary();
    if (!res.success) {
      totalEl.textContent = '$0.00';
      const li = document.createElement('li');
      li.textContent = `Couldn't load: ${res.error}`;
      li.className = 'usage-summary-error';
      listEl.appendChild(li);
      return;
    }
    totalEl.textContent = formatUsd(res.summary.totalUsd, 'long');
    if (res.summary.byModel.length === 0) {
      const li = document.createElement('li');
      li.className = 'usage-summary-empty';
      li.textContent = 'No API calls recorded yet this month.';
      listEl.appendChild(li);
      return;
    }
    let planRows = 0;
    for (const row of res.summary.byModel) {
      // ChatGPT plan calls are not priced per token: showing $0.00 would read
      // as free. Rows without a billing field are historical API rows.
      const onPlan = (row as { billing?: string }).billing === 'chatgpt-plan';
      if (onPlan) planRows++;
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.className = 'usage-summary-model';
      label.textContent = `${row.modelId} · ${row.kind} (${row.count})`;
      const amount = document.createElement('span');
      amount.className = 'usage-summary-amount';
      amount.textContent = onPlan ? 'ChatGPT plan' : formatUsd(row.usd, 'long');
      li.append(label, amount);
      listEl.appendChild(li);
    }
    if (planRows > 0) {
      const note = document.createElement('li');
      note.className = 'usage-summary-empty';
      note.append(
        'ChatGPT plan calls count toward your plan’s usage limits and any credits you authorized; they are not included in the dollar total. ',
        createManageUsageButton('link-button'),
      );
      listEl.appendChild(note);
    }
    if (res.summary.modelUnknownCount > 0) {
      const note = document.createElement('li');
      note.className = 'usage-summary-empty';
      note.textContent = `${res.summary.modelUnknownCount} call(s) used a model not in the price table (counted as $0).`;
      listEl.appendChild(note);
    }
  } catch (e) {
    totalEl.textContent = '$0.00';
    const li = document.createElement('li');
    li.className = 'usage-summary-error';
    li.textContent = `Couldn't load usage: ${e instanceof Error ? e.message : String(e)}`;
    listEl.appendChild(li);
  }
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

// A credential section stays visible while any feature still routes through
// it, not just the summary provider: a Gemini key can power Gemini Live or
// file transcription while summaries run on the ChatGPT plan.
function applyCredentialVisibility(): void {
  if (!aiPane || !aiProviderSelect) return;
  const usage = credentialUsage({
    aiProvider: aiProviderSelect.value === 'chatgpt' ? 'chatgpt' : 'gemini',
    // The retired-provider placeholder transcribes nothing until replaced.
    transcriptionProvider: isLegacyTranscriptionSelected()
      ? LEGACY_CODEX_PROVIDER
      : readTranscriptionProvider(),
    liveSttProvider: readLiveProvider(),
  });
  aiPane.querySelectorAll<HTMLElement>('.config-subgroup[data-provider]').forEach((sg) => {
    const provider = sg.dataset.provider === 'chatgpt' ? 'chatgpt' : 'gemini';
    sg.hidden = usage[provider].length === 0;
  });
  const usageLines: Record<string, CredentialUse[]> = {
    geminiUsage: usage.gemini,
    chatgptUsage: usage.chatgpt,
    openaiUsage: usage.openai,
    sonioxUsage: usage.soniox,
  };
  for (const [id, uses] of Object.entries(usageLines)) {
    const el = document.getElementById(id);
    if (el) el.textContent = describeCredentialUse(uses);
  }
  updateTranscriptionProviderNotice();
  renderLegacyCodexNotice();
}

// Mirrors hasAiAuth() against the unsaved form so the badge clears as soon as
// the summary provider has what it needs.
function updateAiRequiredBadge(): void {
  if (!aiRequiredBadge) return;
  const hasAuth =
    aiProviderSelect?.value === 'chatgpt'
      ? chatgptPlanUsable()
      : (geminiApiKeyInput?.value.trim() ?? '').length > 0;
  aiRequiredBadge.hidden = hasAuth;
}

function showFieldError(input: HTMLInputElement | null, errorId: string, message: string): void {
  const error = document.getElementById(errorId);
  if (error) {
    error.textContent = message;
    error.hidden = false;
  }
  input?.setAttribute('aria-invalid', 'true');
}

function clearFieldError(input: HTMLInputElement | null, errorId: string): void {
  const error = document.getElementById(errorId);
  if (error) {
    error.textContent = '';
    error.hidden = true;
  }
  input?.removeAttribute('aria-invalid');
}

function resetGlobalShortcut(): void {
  if (!globalShortcutInput) return;
  globalShortcutInput.value = DEFAULT_GLOBAL_SHORTCUT;
  resetSettingsKeys.add('globalShortcut');
  clearFieldError(globalShortcutInput, 'globalShortcutError');
}

function configTabs(): HTMLButtonElement[] {
  return configModal ? [...configModal.querySelectorAll<HTMLButtonElement>('.config-tab')] : [];
}

function activateConfigTab(target: string): void {
  if (!configModal) return;
  const panes = configModal.querySelectorAll<HTMLElement>('.config-pane');
  configTabs().forEach((t) => {
    const active = t.dataset.tab === target;
    t.classList.toggle('is-active', active);
    t.setAttribute('aria-selected', active ? 'true' : 'false');
    // Roving tabindex: Tab enters the tablist on the selected tab only, and
    // the arrow keys move between tabs.
    t.tabIndex = active ? 0 : -1;
  });
  panes.forEach((p) => {
    const active = p.dataset.pane === target;
    p.classList.toggle('is-active', active);
    p.hidden = !active;
  });
}

// Opens the tab holding `id`, scrolls it into view, and focuses it. Used by the
// cross-tab links and by callers that open Settings for one missing setting.
function goToSetting(id: string): void {
  const el = document.getElementById(id);
  const pane = el?.closest<HTMLElement>('.config-pane');
  if (!el || !pane?.dataset.pane) return;
  activateConfigTab(pane.dataset.pane);
  el.scrollIntoView({ block: 'center' });
  el.focus();
}

function setupConfigTabs(modal: HTMLElement): void {
  const tabs = configTabs();
  if (tabs.length === 0) return;
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      if (target) activateConfigTab(target);
    });
  });
  // WAI-ARIA tabs pattern with automatic activation: Left/Right wrap, Home and
  // End jump to the ends.
  modal.querySelector('[role="tablist"]')?.addEventListener('keydown', (event) => {
    const e = event as KeyboardEvent;
    const current = tabs.indexOf(e.target as HTMLButtonElement);
    if (current < 0) return;
    let next: number;
    if (e.key === 'ArrowRight') next = (current + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;
    e.preventDefault();
    const tab = tabs[next]!;
    if (tab.dataset.tab) activateConfigTab(tab.dataset.tab);
    tab.focus();
  });
  modal.addEventListener('click', (e) => {
    const link = (e.target as HTMLElement).closest<HTMLElement>('[data-goto]');
    if (!link?.dataset.goto) return;
    e.preventDefault();
    goToSetting(link.dataset.goto);
  });
}

export function setupConfigModal(): void {
  configModal = document.getElementById('configModal') as HTMLDialogElement | null;
  if (configModal) {
    setupConfigTabs(configModal);
    aiPane = configModal.querySelector<HTMLElement>('.config-pane[data-pane="ai"]');
    aiRequiredBadge = document.getElementById('configAiRequiredBadge');
  }
  saveConfigBtn = document.getElementById('saveConfig') as HTMLButtonElement | null;
  cancelConfigBtn = document.getElementById('cancelConfig') as HTMLButtonElement | null;
  aiProviderSelect = document.getElementById('aiProvider') as HTMLSelectElement | null;
  geminiApiKeyInput = document.getElementById('geminiApiKey') as HTMLInputElement | null;
  liveSttProviderSelect = document.getElementById('liveSttProvider') as HTMLSelectElement | null;
  transcriptionProviderSelect = document.getElementById(
    'transcriptionProvider',
  ) as HTMLSelectElement | null;
  transcriptionProviderNotice = document.getElementById('transcriptionProviderNotice');
  openaiApiKeyInput = document.getElementById('openaiApiKey') as HTMLInputElement | null;
  sonioxApiKeyInput = document.getElementById('sonioxApiKey') as HTMLInputElement | null;
  liveProviderNotice = document.getElementById('liveProviderNotice');
  setupModelControls();
  legacyCodexNotice = document.getElementById('legacyCodexNotice');
  chatgptCard = document.getElementById('chatgptCard');
  chatgptStatusEl = document.getElementById('chatgptStatus');
  chatgptPlanBadge = document.getElementById('chatgptPlanBadge');
  chatgptLoginBtn = document.getElementById('chatgptLogin') as HTMLButtonElement | null;
  chatgptCancelLoginBtn = document.getElementById('chatgptCancelLogin') as HTMLButtonElement | null;
  chatgptLogoutBtn = document.getElementById('chatgptLogout') as HTMLButtonElement | null;
  chatgptProfileGroup = document.getElementById('chatgptProfileGroup');
  chatgptProfileSelect = document.getElementById('chatgptProfile') as HTMLSelectElement | null;
  chatgptAddProfileBtn = document.getElementById('chatgptAddProfile') as HTMLButtonElement | null;
  chatgptNotice = document.getElementById('chatgptNotice');
  chatgptNoticeText = document.getElementById('chatgptNoticeText');
  chatgptNoticeActions = document.getElementById('chatgptNoticeActions');
  chatgptUsingPlan = document.getElementById('chatgptUsingPlan');
  chatgptModelSelect = document.getElementById('chatgptModelSelect') as HTMLSelectElement | null;
  chatgptRefreshModelsBtn = document.getElementById(
    'chatgptRefreshModels',
  ) as HTMLButtonElement | null;
  chatgptPlanDialog = document.getElementById('chatgptPlanDialog') as HTMLDialogElement | null;
  loginGoogleOAuthBtn = document.getElementById('loginGoogleOAuth') as HTMLButtonElement | null;
  clearGoogleOAuthBtn = document.getElementById('clearGoogleOAuth') as HTMLButtonElement | null;
  googleOAuthStatus = document.getElementById('googleOAuthStatus');
  googleDriveSyncNowBtn = document.getElementById('googleDriveSyncNow') as HTMLButtonElement | null;
  googleDriveSyncStatusEl = document.getElementById('googleDriveSyncStatus');
  slackWebhookUrlInput = document.getElementById('slackWebhookUrl') as HTMLInputElement | null;
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

  aiProviderSelect?.addEventListener('change', () => {
    applyCredentialVisibility();
    updateAiRequiredBadge();
  });
  liveSttProviderSelect?.addEventListener('change', () => {
    applyCredentialVisibility();
    updateLiveProviderNotice();
  });
  openaiApiKeyInput?.addEventListener('input', updateLiveProviderNotice);
  sonioxApiKeyInput?.addEventListener('input', updateLiveProviderNotice);
  transcriptionProviderSelect?.addEventListener('change', () => {
    legacyTranscriptionMessage = '';
    applyCredentialVisibility();
    updateTranscriptionProviderNotice();
  });
  sonioxApiKeyInput?.addEventListener('input', updateTranscriptionProviderNotice);
  openaiApiKeyInput?.addEventListener('input', updateTranscriptionProviderNotice);
  geminiApiKeyInput?.addEventListener('input', () => {
    clearFieldError(geminiApiKeyInput, 'geminiApiKeyError');
    updateAiRequiredBadge();
    updateLiveProviderNotice();
  });

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

  window.electronAPI.onChatGPTProgress((event) => {
    if (!chatgptLoginInFlight || !chatgptStatusEl) return;
    if (event.phase === 'browser-opened') {
      chatgptStatusEl.textContent =
        'Waiting for you to finish signing in in your browser. Use Cancel sign-in to stop.';
    } else if (event.phase === 'progress' && event.message) {
      chatgptStatusEl.textContent = event.message;
    }
  });

  chatgptLoginBtn?.addEventListener('click', () => {
    const { connected, planEnabled, profileId } = chatgptStatus;
    // A signed-out saved account signs in again under its own registration
    // (its issued client ID) instead of registering a duplicate.
    void runChatGPTLogin(
      connected && !planEnabled
        ? { requestPlanConsent: true, profileId }
        : !connected && profileId
          ? { profileId }
          : undefined,
    );
  });
  chatgptAddProfileBtn?.addEventListener('click', () => {
    void runChatGPTLogin({ newProfile: true });
  });

  chatgptCancelLoginBtn?.addEventListener('click', () => {
    chatgptLoginToken++;
    setChatGPTBusy(false);
    renderChatGPTCard();
    if (chatgptStatusEl && !chatgptStatus.connected)
      chatgptStatusEl.textContent = 'Sign-in cancelled';
    window.electronAPI.cancelChatGPTLogin().catch(() => {});
    chatgptLoginBtn?.focus();
  });

  chatgptLogoutBtn?.addEventListener('click', async () => {
    chatgptLogoutBtn!.disabled = true;
    hideChatGPTNotice();
    try {
      // Signs out the active account; other accounts stay signed in.
      const result = await window.electronAPI.logoutChatGPT(chatgptStatus.profileId);
      if (result.success) {
        await refreshChatGPTState();
        if (result.signedIn && !result.revoked) {
          showChatGPTNotice(
            'Signed out on this device, but OpenAI did not confirm that the sign-in was revoked. You can also disconnect Listener.AI from your ChatGPT settings.',
            'warning',
          );
        }
        (chatgptStatus.connected ? chatgptLogoutBtn : chatgptLoginBtn)?.focus();
      } else {
        showChatGPTError(result.error);
      }
    } catch (e) {
      showChatGPTError(e instanceof Error ? e.message : String(e));
    } finally {
      chatgptLogoutBtn!.disabled = false;
    }
  });

  chatgptProfileSelect?.addEventListener('change', async () => {
    const id = chatgptProfileSelect!.value;
    if (!id || id === chatgptStatus.profileId) return;
    hideChatGPTNotice();
    chatgptProfileSelect!.disabled = true;
    try {
      const result = await window.electronAPI.selectChatGPTProfile(id);
      if (result.success) {
        await applyChatGPTStatus(result.status);
      } else {
        if (chatgptStatus.profileId) chatgptProfileSelect!.value = chatgptStatus.profileId;
        showChatGPTError(result.error);
      }
    } catch (e) {
      if (chatgptStatus.profileId) chatgptProfileSelect!.value = chatgptStatus.profileId;
      showChatGPTError(e instanceof Error ? e.message : String(e));
    } finally {
      chatgptProfileSelect!.disabled = false;
    }
  });

  chatgptRefreshModelsBtn?.addEventListener('click', () => {
    hideChatGPTNotice();
    void loadChatGPTModels();
  });

  document.getElementById('chatgptManageUsage')?.addEventListener('click', openChatGPTUsage);
  document.getElementById('chatgptNoticeManageUsage')?.addEventListener('click', openChatGPTUsage);
  document.getElementById('chatgptPlanManageUsage')?.addEventListener('click', openChatGPTUsage);
  document.getElementById('chatgptPlanGotIt')?.addEventListener('click', () => {
    chatgptPlanDialog?.close();
    chatgptPlanNoticeAcknowledged = true;
    // Persist right away so the explanation never repeats, even if the user
    // then cancels Settings. Not part of the form diff.
    window.electronAPI.saveConfig({ chatgptPlanNoticeAcknowledged: true }).catch(() => {});
  });

  // Google Drive OAuth + sync wiring. Same patterns as the ChatGPT block above.
  window.electronAPI.onGoogleOAuthProgress((status) => {
    if (status.phase === 'browser-opened') {
      setGoogleOAuthStatus('Waiting for browser sign-in — click Sign in again to retry.');
    } else if (status.phase === 'progress' && status.message) {
      setGoogleOAuthStatus(status.message);
    }
  });

  window.electronAPI.onGoogleSyncProgress((event) => {
    // Progress events only matter while syncing. If success/error has already
    // fired (status.phase moved out of 'syncing') the next render comes from
    // onGoogleSyncStatus and overwrites this one -- benign racing, no guard
    // needed.
    setGoogleSyncStatus(syncProgressText(event), 'idle');
  });

  window.electronAPI.onGoogleSyncStatus((status) => {
    if (status.phase === 'syncing') {
      setGoogleSyncStatus('Syncing...', 'idle');
    } else if (status.phase === 'success' && status.result) {
      const { uploaded, downloaded, skipped, conflicts, deleted, tombstoned } = status.result;
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
      setGoogleSyncStatus(status.error ?? `Sync finished with ${errCount} error(s)`, 'error');
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
    // Bumping the tokens drops any stale result from an in-flight login
    // promise that resolves after the modal is gone.
    chatgptLoginToken++;
    chatgptModelsToken++;
    googleLoginToken++;
    if (chatgptLoginInFlight) setChatGPTBusy(false);
    // Close a pending sign-in's loopback so the next attempt binds cleanly.
    window.electronAPI.cancelChatGPTLogin().catch(() => {});
    window.electronAPI.cancelGoogleOAuth().catch(() => {});
  };

  // Native <dialog> emits `close` for any dismissal -- click on the X button,
  // Cancel/Save button, AND the ESC key. Route ESC through hideConfig so it
  // also drops in-flight sign-in state, instead of the browser's default
  // close-only behavior.
  if (configModal) {
    configModal.addEventListener('cancel', (e) => {
      e.preventDefault();
      hideConfig();
    });
  }

  if (saveConfigBtn) {
    saveConfigBtn.addEventListener('click', async () => {
      const fields = readSettingsFields();
      // Flush any uncommitted typing in the chip field before saving so the
      // user doesn't lose what they typed but never pressed comma/Enter on.
      if (knownWordsField && knownWordsField.value.trim().length > 0) {
        addKnownWords(knownWordsField.value);
        knownWordsField.value = '';
      }

      if (fields.aiProvider === 'gemini' && !fields.geminiApiKey) {
        showFieldError(
          geminiApiKeyInput,
          'geminiApiKeyError',
          'Enter a Gemini API key, or choose the ChatGPT plan as the summary provider.',
        );
        goToSetting('geminiApiKey');
        return;
      }

      const next = readModalSettings(fields);
      const forcedResets = [...resetSettingsKeys].filter((key) => next[key] === '');
      const payload = diffConfigPayload(settingsBaseline, next, forcedResets);
      await window.electronAPI.saveConfig(payload);
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
      if (e.isComposing) return;
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
      // Tab / Shift+Tab move focus and Escape closes the dialog, as everywhere
      // else; capturing them would trap keyboard users in this field.
      if ((e.key === 'Tab' && plain) || (e.key === 'Escape' && plain && !e.shiftKey)) return;
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
        // A newer keypress or Reset may have replaced the value meanwhile.
        if (globalShortcutInput.value !== shortcut) return;
        if (!result.valid) {
          showFieldError(
            globalShortcutInput,
            'globalShortcutError',
            `${shortcut} is already in use or not allowed. Try another combination.`,
          );
        } else {
          clearFieldError(globalShortcutInput, 'globalShortcutError');
        }
      } else {
        showFieldError(
          globalShortcutInput,
          'globalShortcutError',
          'Add a modifier key: Command/Ctrl, Option/Alt, or Shift.',
        );
      }
    });

    globalShortcutInput.addEventListener('blur', () => {
      if (globalShortcutInput) globalShortcutInput.placeholder = 'Press shortcut keys';
    });

    document.getElementById('resetGlobalShortcut')?.addEventListener('click', () => {
      resetGlobalShortcut();
      globalShortcutInput?.focus();
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
