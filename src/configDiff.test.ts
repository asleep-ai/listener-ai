import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diffConfigPayload } from './configDiff';

describe('diffConfigPayload', () => {
  it('returns nothing for an untouched form', () => {
    const baseline = { aiProvider: 'gemini', autoMode: false, maxRecordingMinutes: 0 };
    assert.deepEqual(diffConfigPayload(baseline, { ...baseline }), {});
  });

  it('returns only the fields that changed', () => {
    const baseline = { geminiApiKey: 'env-key', autoMode: false, globalShortcut: 'A' };
    const next = { geminiApiKey: 'env-key', autoMode: true, globalShortcut: 'A' };
    assert.deepEqual(diffConfigPayload(baseline, next), { autoMode: true });
  });

  it('compares arrays by content, not identity', () => {
    const baseline = { knownWords: ['alpha', 'beta'] };
    assert.deepEqual(diffConfigPayload(baseline, { knownWords: ['alpha', 'beta'] }), {});
    assert.deepEqual(diffConfigPayload(baseline, { knownWords: ['alpha'] }), {
      knownWords: ['alpha'],
    });
    assert.deepEqual(diffConfigPayload(baseline, { knownWords: ['beta', 'alpha'] }), {
      knownWords: ['beta', 'alpha'],
    });
  });

  it('keeps an explicit edit back to an empty or default-looking value', () => {
    const baseline = { notionApiKey: 'stored', geminiThinkingLevel: 'high' };
    const next = { notionApiKey: '', geminiThinkingLevel: 'medium' };
    assert.deepEqual(diffConfigPayload(baseline, next), next);
  });

  it('treats a key missing from the baseline as changed', () => {
    const baseline: { autoMode?: boolean } = {};
    assert.deepEqual(diffConfigPayload(baseline, { autoMode: false }), { autoMode: false });
  });
});
