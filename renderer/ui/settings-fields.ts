// Declarative table for the settings modal's scalar fields.
//
// Each row names an element id in renderer/index.html, the ConfigPayload key it
// maps to, and the kind that picks its prefill/read pair. One generic pass
// fills the form from `getConfig()` and one reads it back for `saveConfig`, so
// a field costs one row instead of a module-level handle, an entry in a load-
// time structural type, a prefill branch, a `getElementById` lookup, a read on
// save, and a payload entry.
//
// Controls that carry their own UI state stay hand-written in config-modal.ts:
// the Codex/Google OAuth buttons and status pills, the Drive sync pill, the
// known-words chips, the summary prompt (its prefill and its save both depend
// on the backend default), and the model-id fields (select + custom input +
// reset button, driven by MODEL_FIELDS).

import type { ConfigPayload } from '../electronAPI';
import {
  type LiveSttProvider,
  normalizeAiProvider,
  normalizeLiveSttProvider,
  normalizeTranscriptionProvider,
} from '../../src/aiProvider';

/** The ConfigPayload keys whose value type admits `T`. */
type ConfigKeysOfType<T> = {
  [K in keyof ConfigPayload]-?: T extends ConfigPayload[K] ? K : never;
}[keyof ConfigPayload];

type TextFieldRow = {
  kind: 'text';
  id: string;
  key: ConfigKeysOfType<string>;
  /** Substituted for an empty value on both prefill and read. Defaults to ''. */
  fallback?: string;
  /**
   * Prefill leaves the input alone when nothing is saved, matching the
   * `if (el && config.X)` guard these fields originally carried.
   */
  keepOnEmpty?: true;
};

type CheckboxFieldRow = {
  kind: 'checkbox';
  id: string;
  key: ConfigKeysOfType<boolean>;
  /** Opt-out toggle: absent means checked, only an explicit `false` clears it. */
  defaultOn?: true;
};

type NumberFieldRow = {
  kind: 'number';
  id: string;
  key: ConfigKeysOfType<number>;
};

type SelectKey = 'aiProvider' | 'liveSttProvider' | 'transcriptionProvider' | 'geminiThinkingLevel';

type SelectFieldRow<K extends SelectKey = SelectKey> = {
  kind: 'select';
  id: string;
  key: K;
  /** Value the <select> falls back to on prefill when nothing is saved. */
  fallback: string;
  /** Coerces the raw <select> value into the payload value on save. */
  parse: (raw: string | undefined) => ConfigPayload[K];
};

// Binds each select row's `parse` to that row's own `key`. A bare array literal
// widens K to the whole union and would accept a parse returning some other
// field's type; going through this helper fails at the offending row instead.
const selectRow = <K extends SelectKey>(row: SelectFieldRow<K>): SelectFieldRow<K> => row;

export type SettingsFieldRow = TextFieldRow | CheckboxFieldRow | NumberFieldRow | SelectFieldRow;

/**
 * Shared with config-modal.ts so the live-provider notice and the save payload
 * derive the provider the same way.
 */
export function parseLiveSttProvider(raw: string | undefined): LiveSttProvider {
  return normalizeLiveSttProvider(raw) ?? 'auto';
}

export const SETTINGS_FIELDS: readonly SettingsFieldRow[] = [
  selectRow({
    kind: 'select',
    id: 'aiProvider',
    key: 'aiProvider',
    fallback: 'gemini',
    parse: (raw) => normalizeAiProvider(raw) ?? 'gemini',
  }),
  { kind: 'text', id: 'geminiApiKey', key: 'geminiApiKey', keepOnEmpty: true },
  selectRow({
    kind: 'select',
    id: 'geminiThinkingLevel',
    key: 'geminiThinkingLevel',
    // Defensive fallback; backend's getGeminiThinkingLevel normalizes first.
    fallback: 'medium',
    // Coerce to one of the three valid levels; an out-of-range selection
    // (e.g. extension-injected DOM, stale form state) becomes the default.
    // Include 'medium' explicitly so a future change to the default doesn't
    // silently turn user-selected 'medium' into the new default.
    parse: (raw) => (raw === 'low' || raw === 'medium' || raw === 'high' ? raw : 'medium'),
  }),
  selectRow({
    kind: 'select',
    id: 'liveSttProvider',
    key: 'liveSttProvider',
    fallback: 'auto',
    parse: parseLiveSttProvider,
  }),
  selectRow({
    kind: 'select',
    id: 'transcriptionProvider',
    key: 'transcriptionProvider',
    fallback: 'auto',
    // Returns the 'auto' fallback for junk rather than undefined.
    parse: (raw) => normalizeTranscriptionProvider(raw),
  }),
  { kind: 'text', id: 'openaiApiKey', key: 'openaiApiKey' },
  { kind: 'text', id: 'sonioxApiKey', key: 'sonioxApiKey' },
  { kind: 'text', id: 'liveSttLanguage', key: 'liveSttLanguage' },
  { kind: 'text', id: 'liveTranslationLanguage', key: 'liveTranslationLanguage', fallback: 'ko' },
  { kind: 'text', id: 'notionApiKey', key: 'notionApiKey', keepOnEmpty: true },
  { kind: 'text', id: 'notionDatabaseId', key: 'notionDatabaseId', keepOnEmpty: true },
  { kind: 'text', id: 'slackWebhookUrl', key: 'slackWebhookUrl' },
  { kind: 'checkbox', id: 'slackAutoShare', key: 'slackAutoShare' },
  { kind: 'checkbox', id: 'googleDriveEnabled', key: 'googleDriveEnabled' },
  { kind: 'checkbox', id: 'crashReportingEnabled', key: 'crashReportingEnabled', defaultOn: true },
  { kind: 'text', id: 'globalShortcut', key: 'globalShortcut', keepOnEmpty: true },
  { kind: 'number', id: 'maxRecordingMinutes', key: 'maxRecordingMinutes' },
  { kind: 'number', id: 'recordingReminderMinutes', key: 'recordingReminderMinutes' },
  { kind: 'number', id: 'minRecordingSeconds', key: 'minRecordingSeconds' },
];

function inputEl(id: string): HTMLInputElement | null {
  return document.getElementById(id) as HTMLInputElement | null;
}

function selectEl(id: string): HTMLSelectElement | null {
  return document.getElementById(id) as HTMLSelectElement | null;
}

function applyTextField(row: TextFieldRow, saved: string | undefined): void {
  const el = inputEl(row.id);
  if (!el) return;
  if (!saved && row.keepOnEmpty) return;
  el.value = saved || (row.fallback ?? '');
}

function readTextField(row: TextFieldRow): string {
  return inputEl(row.id)?.value.trim() || (row.fallback ?? '');
}

function applyCheckboxField(row: CheckboxFieldRow, saved: boolean | undefined): void {
  const el = inputEl(row.id);
  if (!el) return;
  el.checked = row.defaultOn ? saved !== false : !!saved;
}

function readCheckboxField(row: CheckboxFieldRow): boolean {
  return !!inputEl(row.id)?.checked;
}

function applyNumberField(row: NumberFieldRow, saved: number | undefined): void {
  const el = inputEl(row.id);
  if (!el) return;
  el.value = String(saved || '');
}

function readNumberField(row: NumberFieldRow): number {
  return Math.max(0, Math.floor(Number.parseInt(inputEl(row.id)?.value || '') || 0));
}

function applySelectField(row: SelectFieldRow, saved: string | undefined): void {
  const el = selectEl(row.id);
  if (!el) return;
  el.value = saved || row.fallback;
}

function readSelectField(row: SelectFieldRow): ConfigPayload[SelectKey] {
  return row.parse(selectEl(row.id)?.value);
}

// Generic key/value writer. Assigning through a union-typed key directly would
// force the value down to the intersection of the candidate value types; the
// type parameter keeps each row's key correlated with its own value type.
function setField<K extends keyof ConfigPayload>(
  payload: ConfigPayload,
  key: K,
  value: ConfigPayload[K],
): void {
  payload[key] = value;
}

/** Fills every table-driven input from a `getConfig()` result. */
export function applySettingsFields(config: ConfigPayload): void {
  for (const row of SETTINGS_FIELDS) {
    switch (row.kind) {
      case 'text':
        applyTextField(row, config[row.key]);
        break;
      case 'checkbox':
        applyCheckboxField(row, config[row.key]);
        break;
      case 'number':
        applyNumberField(row, config[row.key]);
        break;
      case 'select':
        applySelectField(row, config[row.key]);
        break;
    }
  }
}

/** Reads every table-driven input into the `saveConfig` payload. */
export function readSettingsFields(): ConfigPayload {
  const payload: ConfigPayload = {};
  for (const row of SETTINGS_FIELDS) {
    switch (row.kind) {
      case 'text':
        setField(payload, row.key, readTextField(row));
        break;
      case 'checkbox':
        setField(payload, row.key, readCheckboxField(row));
        break;
      case 'number':
        setField(payload, row.key, readNumberField(row));
        break;
      case 'select':
        setField(payload, row.key, readSelectField(row));
        break;
    }
  }
  return payload;
}
