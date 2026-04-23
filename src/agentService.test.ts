import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  coerceConfigValue,
  describeProposal,
  isValidFolderName,
  WRITABLE_CONFIG_KEYS,
  READABLE_CONFIG_KEYS,
  type WritableConfigKey,
} from './agentService';

describe('coerceConfigValue', () => {
  it('accepts native booleans for toggle keys', () => {
    const r = coerceConfigValue('autoMode', true);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value, true);
  });

  it('accepts "true"/"false" strings for toggle keys', () => {
    const t = coerceConfigValue('meetingDetection', 'true');
    const f = coerceConfigValue('displayDetection', 'false');
    assert.equal(t.ok, true);
    assert.equal(f.ok, true);
    if (t.ok) assert.equal(t.value, true);
    if (f.ok) assert.equal(f.value, false);
  });

  it('rejects garbage for toggle keys', () => {
    const r = coerceConfigValue('autoMode', 'yes');
    assert.equal(r.ok, false);
  });

  it('accepts non-empty strings for globalShortcut, trims, rejects empty', () => {
    const ok = coerceConfigValue('globalShortcut', '  CmdOrCtrl+Shift+L  ');
    const bad = coerceConfigValue('globalShortcut', '  ');
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.value, 'CmdOrCtrl+Shift+L');
    assert.equal(bad.ok, false);
  });

  it('accepts numeric strings and numbers for minute keys, floors them, rejects negatives', () => {
    const num = coerceConfigValue('maxRecordingMinutes', 30);
    const str = coerceConfigValue('recordingReminderMinutes', '45');
    const frac = coerceConfigValue('minRecordingSeconds', 5.9);
    const neg = coerceConfigValue('maxRecordingMinutes', -1);
    const nan = coerceConfigValue('maxRecordingMinutes', 'soon');
    assert.equal(num.ok, true);
    assert.equal(str.ok, true);
    assert.equal(frac.ok, true);
    assert.equal(neg.ok, false);
    assert.equal(nan.ok, false);
    if (num.ok) assert.equal(num.value, 30);
    if (str.ok) assert.equal(str.value, 45);
    if (frac.ok) assert.equal(frac.value, 5);
  });
});

describe('config key whitelists', () => {
  it('does not include API credentials or database IDs in writable keys', () => {
    const dangerous = ['geminiApiKey', 'notionApiKey', 'notionDatabaseId'];
    for (const k of dangerous) {
      assert.equal(
        (WRITABLE_CONFIG_KEYS as readonly string[]).includes(k),
        false,
        `${k} must not be agent-writable`,
      );
      assert.equal(
        (READABLE_CONFIG_KEYS as readonly string[]).includes(k),
        false,
        `${k} must not be agent-readable`,
      );
    }
  });

  it('exposes expected writable toggles and numbers', () => {
    const expected: WritableConfigKey[] = [
      'autoMode',
      'meetingDetection',
      'displayDetection',
      'globalShortcut',
      'maxRecordingMinutes',
      'recordingReminderMinutes',
      'minRecordingSeconds',
    ];
    for (const k of expected) {
      assert.ok(
        (WRITABLE_CONFIG_KEYS as readonly string[]).includes(k),
        `${k} should be writable`,
      );
    }
  });
});

describe('describeProposal', () => {
  it('formats toggle flip with reason', () => {
    const s = describeProposal('autoMode', true, false, 'enable hands-free upload');
    assert.match(s, /autoMode/);
    assert.match(s, /false -> true/);
    assert.match(s, /enable hands-free upload/);
  });

  it('handles unset previous values', () => {
    const s = describeProposal('globalShortcut', 'Cmd+Shift+R', undefined);
    assert.match(s, /\(unset\)/);
    assert.match(s, /"Cmd\+Shift\+R"/);
  });
});

describe('isValidFolderName', () => {
  it('accepts names produced by saveTranscription', () => {
    assert.equal(isValidFolderName('Q4_OKR_Sync_20260201_140000'), true);
    assert.equal(isValidFolderName('meeting with spaces_20260201_140000'), true);
  });

  it('rejects path traversal attempts', () => {
    assert.equal(isValidFolderName('..'), false);
    assert.equal(isValidFolderName('../etc/passwd'), false);
    assert.equal(isValidFolderName('foo/bar'), false);
    assert.equal(isValidFolderName('foo\\bar'), false);
    assert.equal(isValidFolderName('foo\0bar'), false);
  });

  it('rejects empty and dotfile-style names', () => {
    assert.equal(isValidFolderName(''), false);
    assert.equal(isValidFolderName('.'), false);
    assert.equal(isValidFolderName('.hidden'), false);
  });

  it('rejects non-string input', () => {
    assert.equal(isValidFolderName(null as unknown as string), false);
    assert.equal(isValidFolderName(undefined as unknown as string), false);
    assert.equal(isValidFolderName(42 as unknown as string), false);
  });
});
