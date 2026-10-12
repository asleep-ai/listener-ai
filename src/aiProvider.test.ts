import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CHATGPT_AUTO_TRANSCRIPTION_MESSAGE,
  LEGACY_CODEX_TRANSCRIPTION_MESSAGE,
  autoModeSkipMessage,
  chatgptPlaceholderModel,
  showLegacyCodexNotice,
} from './aiProvider';

describe('autoModeSkipMessage', () => {
  it('names the unresolvable selection instead of a missing key (migrated ChatGPT + auto)', () => {
    const message = autoModeSkipMessage({
      hasAiAuth: true,
      transcriptionProvider: null,
      transcriptionProviderIssue: CHATGPT_AUTO_TRANSCRIPTION_MESSAGE,
    });
    assert.equal(
      message,
      `Auto mode: Skipped -- ${CHATGPT_AUTO_TRANSCRIPTION_MESSAGE} The recording was saved.`,
    );
    assert.doesNotMatch(message, /no credentials saved/);
  });

  it('names the retired Codex transcription selection', () => {
    const message = autoModeSkipMessage({
      hasAiAuth: true,
      transcriptionProvider: null,
      transcriptionProviderIssue: LEGACY_CODEX_TRANSCRIPTION_MESSAGE,
    });
    assert.ok(message.includes('Codex transcription was removed'));
  });

  it('keeps the existing messages for the AI provider, Soniox and a missing backend key', () => {
    assert.equal(
      autoModeSkipMessage({ hasAiAuth: false, transcriptionProvider: null }),
      'Auto mode: Skipped -- configure your AI provider in Settings. The recording was saved.',
    );
    assert.equal(
      autoModeSkipMessage({ hasAiAuth: true, transcriptionProvider: 'soniox' }),
      'Auto mode: Skipped -- transcription is set to Soniox but no Soniox API key is saved. The recording was saved.',
    );
    assert.equal(
      autoModeSkipMessage({ hasAiAuth: true, transcriptionProvider: 'openai' }),
      'Auto mode: Skipped -- the selected transcription backend has no credentials saved. The recording was saved.',
    );
  });

  it('adds a full stop to an issue that has none', () => {
    assert.equal(
      autoModeSkipMessage({
        hasAiAuth: true,
        transcriptionProvider: null,
        transcriptionProviderIssue: 'Choose a provider',
      }),
      'Auto mode: Skipped -- Choose a provider. The recording was saved.',
    );
  });
});

describe('showLegacyCodexNotice', () => {
  it('shows for a migrated Codex install while ChatGPT is selected and not connected', () => {
    assert.equal(
      showLegacyCodexNotice({
        legacyCodexConfigured: true,
        selectedAiProvider: 'chatgpt',
        chatgptConnected: false,
      }),
      true,
    );
  });

  it('stays hidden on a Gemini install that still carries old Codex keys', () => {
    assert.equal(
      showLegacyCodexNotice({
        legacyCodexConfigured: true,
        selectedAiProvider: 'gemini',
        chatgptConnected: false,
      }),
      false,
    );
  });

  it('hides once a ChatGPT account is connected or when nothing legacy is stored', () => {
    assert.equal(
      showLegacyCodexNotice({
        legacyCodexConfigured: true,
        selectedAiProvider: 'chatgpt',
        chatgptConnected: true,
      }),
      false,
    );
    assert.equal(
      showLegacyCodexNotice({
        legacyCodexConfigured: false,
        selectedAiProvider: 'chatgpt',
        chatgptConnected: false,
      }),
      false,
    );
  });
});

// Mirrors the renderer's model select (renderer/ui/config-modal.ts): every
// placeholder disables it and holds one value; a loaded list enables it and
// keeps the previous value.
describe('chatgptPlaceholderModel', () => {
  const saved = 'saved-model';
  function modelSelect() {
    const select = { value: '', disabled: false };
    return {
      select,
      placeholder(keepCurrent: boolean) {
        select.value = chatgptPlaceholderModel(select, saved, keepCurrent);
        select.disabled = true;
      },
      loaded() {
        select.disabled = false;
      },
      pick(value: string) {
        select.value = value;
      },
    };
  }

  it('keeps an unsaved pick through a refresh whose model list fails', () => {
    const ui = modelSelect();
    ui.placeholder(false); // Settings opens: loading...
    ui.placeholder(true); // loadChatGPTModels: loading...
    ui.loaded();
    ui.pick('picked-not-saved');
    ui.placeholder(true); // Refresh list: loading... (disables the select)
    ui.placeholder(true); // model list unavailable
    assert.equal(ui.select.value, 'picked-not-saved');
    ui.loaded(); // a later successful refresh keeps it too
    assert.equal(ui.select.value, 'picked-not-saved');
  });

  it('keeps an unsaved pick across sign-out and plan-not-enabled placeholders', () => {
    const ui = modelSelect();
    ui.placeholder(false);
    ui.loaded();
    ui.pick('picked-not-saved');
    ui.placeholder(true); // sign in to load models
    ui.placeholder(true); // plan usage not enabled
    assert.equal(ui.select.value, 'picked-not-saved');
  });

  it('starts from the saved model whenever Settings opens', () => {
    const ui = modelSelect();
    ui.loaded();
    ui.pick('abandoned-pick');
    ui.placeholder(false);
    assert.equal(ui.select.value, saved);
    ui.placeholder(true);
    assert.equal(ui.select.value, saved);
  });
});
