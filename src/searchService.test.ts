import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ReadTranscriptionResult, TranscriptionEntry } from './outputService';
import {
  ALL_FIELDS,
  DEFAULT_FIELDS,
  FIELD_WEIGHTS,
  makeSnippet,
  resolveFields,
  scoreRecord,
} from './searchService';

const sampleEntry: TranscriptionEntry = {
  folderPath: '/tmp/Roadmap_20260420_143000',
  folderName: 'Roadmap_20260420_143000',
  title: 'Roadmap Review',
  transcribedAt: '2026-04-20T14:30:00Z',
};

const sampleData: ReadTranscriptionResult = {
  title: 'Roadmap Review',
  summary: 'We discussed the Q2 roadmap and platform priorities.',
  transcript: 'Jaden talked about the roadmap. The billing system came up.',
  keyPoints: ['Prioritize billing UX', 'Ship search V1'],
  actionItems: ['Draft roadmap doc', 'Review billing tickets'],
  transcribedAt: '2026-04-20T14:30:00Z',
};

describe('makeSnippet', () => {
  it('returns empty string when there is no match', () => {
    assert.equal(makeSnippet('hello world', 'foo'), '');
  });

  it('centers snippet around first occurrence and adds ellipses', () => {
    const text = `${'a'.repeat(100)} needle ${'b'.repeat(100)}`;
    const snippet = makeSnippet(text, 'needle', 40);
    assert.ok(snippet.includes('needle'));
    assert.ok(snippet.startsWith('...'));
    assert.ok(snippet.endsWith('...'));
  });

  it('is case-insensitive', () => {
    assert.ok(makeSnippet('Hello WORLD', 'world').includes('WORLD'));
  });

  it('omits leading ellipsis when match is near start', () => {
    const snippet = makeSnippet('needle followed by a tail of trailing content', 'needle', 40);
    assert.ok(!snippet.startsWith('...'));
    assert.ok(snippet.includes('needle'));
  });

  it('collapses whitespace', () => {
    const snippet = makeSnippet('line one\n\nline two   needle   after', 'needle', 40);
    assert.ok(!/\s\s/.test(snippet), `snippet has double-space: ${snippet}`);
  });
});

describe('resolveFields', () => {
  it('defaults to everything except transcript', () => {
    assert.deepEqual(resolveFields({}), DEFAULT_FIELDS);
  });

  it('includeTranscript widens to ALL_FIELDS', () => {
    assert.deepEqual(resolveFields({ includeTranscript: true }), ALL_FIELDS);
  });

  it('field=all returns ALL_FIELDS', () => {
    assert.deepEqual(resolveFields({ field: 'all' }), ALL_FIELDS);
  });

  it('specific field overrides defaults', () => {
    assert.deepEqual(resolveFields({ field: 'summary' }), ['summary']);
  });

  it('specific field wins over includeTranscript', () => {
    assert.deepEqual(resolveFields({ field: 'title', includeTranscript: true }), ['title']);
  });
});

describe('scoreRecord', () => {
  it('returns null when nothing matches', () => {
    const hit = scoreRecord(sampleEntry, sampleData, 'xyz-nonexistent', ALL_FIELDS);
    assert.equal(hit, null);
  });

  it('matches title case-insensitively', () => {
    const hit = scoreRecord(sampleEntry, sampleData, 'ROADMAP review', ALL_FIELDS);
    assert.ok(hit);
    assert.ok(hit!.matchedFields.includes('title'));
  });

  it('matches inside keyPoints array', () => {
    const hit = scoreRecord(sampleEntry, sampleData, 'billing UX', ALL_FIELDS);
    assert.ok(hit);
    assert.ok(hit!.matchedFields.includes('keyPoints'));
  });

  it('respects field scope -- transcript-only term skipped when transcript not in scope', () => {
    const hit = scoreRecord(sampleEntry, sampleData, 'jaden', ['summary', 'keyPoints']);
    assert.equal(hit, null);
    const hit2 = scoreRecord(sampleEntry, sampleData, 'jaden', ['transcript']);
    assert.ok(hit2);
    assert.ok(hit2!.matchedFields.includes('transcript'));
  });

  it('aggregates score across every matching field', () => {
    const hit = scoreRecord(sampleEntry, sampleData, 'roadmap', ALL_FIELDS);
    assert.ok(hit);
    const expected =
      FIELD_WEIGHTS.title +
      FIELD_WEIGHTS.summary +
      FIELD_WEIGHTS.actionItems +
      FIELD_WEIGHTS.transcript;
    assert.equal(hit!.score, expected);
    assert.deepEqual(hit!.matchedFields.slice().sort(), [
      'actionItems',
      'summary',
      'title',
      'transcript',
    ]);
  });

  it('ranks title match above transcript-only match', () => {
    const titleOnly: ReadTranscriptionResult = {
      ...sampleData,
      summary: '',
      transcript: '',
      keyPoints: [],
      actionItems: [],
    };
    const transcriptOnly: ReadTranscriptionResult = {
      ...sampleData,
      title: 'Unrelated',
      summary: '',
      keyPoints: [],
      actionItems: [],
    };
    const hitA = scoreRecord(sampleEntry, titleOnly, 'roadmap', ALL_FIELDS);
    const hitB = scoreRecord(sampleEntry, transcriptOnly, 'roadmap', ALL_FIELDS);
    assert.ok(hitA && hitB);
    assert.ok(hitA!.score > hitB!.score);
  });

  it('prefers higher-weighted field for snippet source', () => {
    const hit = scoreRecord(sampleEntry, sampleData, 'roadmap', ALL_FIELDS);
    assert.ok(hit);
    assert.equal(hit!.snippetField, 'summary');
    assert.ok(hit!.snippet.toLowerCase().includes('roadmap'));
  });

  it('does not produce snippet when only title matches', () => {
    const titleOnly: ReadTranscriptionResult = {
      ...sampleData,
      summary: '',
      transcript: '',
      keyPoints: [],
      actionItems: [],
    };
    const hit = scoreRecord(sampleEntry, titleOnly, 'roadmap', ALL_FIELDS);
    assert.ok(hit);
    assert.equal(hit!.snippet, '');
    assert.equal(hit!.snippetField, undefined);
  });
});
