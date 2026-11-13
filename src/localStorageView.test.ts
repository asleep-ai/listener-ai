import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LocalStorageReportPayload } from './electronApiTypes';
import { describeSkip, formatBytes, storageSummary } from './localStorageView';

const MB = 1024 * 1024;
const base: LocalStorageReportPayload = {
  totalBytes: 300 * MB,
  audioBytes: 250 * MB,
  audioFiles: 4,
  notesBytes: 2 * MB,
  otherBytes: 48 * MB,
  eligibleBytes: 200 * MB,
  eligibleFiles: 3,
  notBackedUpBytes: 0,
  notBackedUpFiles: 0,
  unlinkedBytes: 0,
  unlinkedFiles: 0,
  cloudOnlyBytes: 0,
  cloudOnlyFiles: 0,
  externalFiles: 0,
};

const byCategory = (s: ReturnType<typeof storageSummary>) =>
  Object.fromEntries(s.segments.map((seg) => [seg.category, seg]));

describe('storage summary', () => {
  it('shows the total, what can be freed, and a sized primary action', () => {
    const s = storageSummary(base, { signedIn: true });
    assert.equal(s.total, '300 MB in total');
    assert.deepEqual(s.reclaim, { text: '200 MB can be freed', tone: 'action' });
    assert.equal(s.canFree, true);
    assert.equal(s.freeLabel, 'Free up 200 MB');
  });

  it('splits on-device space into categories that add up to the total', () => {
    const s = storageSummary(
      {
        ...base,
        notBackedUpBytes: 10 * MB,
        notBackedUpFiles: 1,
        unlinkedBytes: 5 * MB,
        unlinkedFiles: 1,
      },
      { signedIn: true },
    );
    const c = byCategory(s);
    assert.deepEqual(
      s.segments.map((seg) => seg.category),
      ['freeable', 'pending', 'kept', 'notes', 'other'],
    );
    assert.equal(c.freeable.size, '200 MB');
    assert.equal(c.freeable.detail, '3 recordings already in Google Drive');
    assert.equal(c.pending.size, '10 MB');
    assert.match(c.pending.detail ?? '', /1 recording, kept until a sync uploads it/);
    assert.equal(c.kept.size, '40 MB');
    assert.match(c.kept.detail ?? '', /1 recording without a saved meeting/);
    assert.equal(c.notes.size, '2.0 MB');
    assert.equal(c.other.size, '48 MB');
    assert.equal(
      s.segments.reduce((sum, seg) => sum + seg.bytes, 0),
      base.totalBytes,
    );
    assert.equal(s.barBytes, base.totalBytes);
  });

  it('asks to sign in instead of offering removal when signed out', () => {
    const s = storageSummary(base, { signedIn: false });
    assert.match(s.reclaim.text, /Sign in to Google Drive/);
    assert.equal(s.reclaim.tone, 'muted');
    assert.equal(s.canFree, false);
    assert.equal(s.freeLabel, 'Free up space');
    assert.equal(byCategory(s).freeable.label, 'Audio in Drive');
  });

  it('offers no action when nothing can be freed', () => {
    const s = storageSummary({ ...base, eligibleBytes: 0, eligibleFiles: 0 }, { signedIn: true });
    assert.deepEqual(s.reclaim, { text: 'Nothing to free right now', tone: 'muted' });
    assert.equal(s.canFree, false);
    assert.equal(byCategory(s).freeable, undefined);
  });

  it('keeps Drive-only and external audio out of the on-device bar', () => {
    const s = storageSummary(
      { ...base, cloudOnlyFiles: 2, cloudOnlyBytes: 5 * MB, externalFiles: 1 },
      { signedIn: true },
    );
    assert.match(s.cloudOnly ?? '', /^2 recordings in Google Drive only \(5\.0 MB\)/);
    assert.match(
      s.external ?? '',
      /1 meeting uses audio stored elsewhere.*never uploads or removes it/,
    );
    assert.equal(
      s.segments.reduce((sum, seg) => sum + seg.bytes, 0),
      base.totalBytes,
    );
  });

  it('handles an empty data folder without a zero denominator', () => {
    const empty: LocalStorageReportPayload = Object.fromEntries(
      Object.keys(base).map((k) => [k, 0]),
    ) as LocalStorageReportPayload;
    const s = storageSummary(empty, { signedIn: true });
    assert.equal(s.total, '0 KB in total');
    assert.deepEqual(s.segments, []);
    assert.equal(s.barBytes, 1);
    assert.equal(s.canFree, false);
  });

  it('never uses implementation jargon in visible copy', () => {
    const s = storageSummary(
      {
        ...base,
        notBackedUpFiles: 1,
        notBackedUpBytes: MB,
        unlinkedFiles: 1,
        unlinkedBytes: MB,
        externalFiles: 1,
        cloudOnlyFiles: 1,
        cloudOnlyBytes: MB,
      },
      { signedIn: true },
    );
    const text = JSON.stringify(s);
    assert.doesNotMatch(text, /md5|checksum|lease|byte for byte/i);
  });
});

describe('storage wording helpers', () => {
  it('explains why a recording was kept', () => {
    assert.match(describeSkip('in-use'), /right now/);
    assert.match(describeSkip('drive-unavailable', 'Drive copy not found'), /not found/);
    assert.match(describeSkip('not-backed-up'), /not been fully uploaded/);
  });

  it('formats sizes', () => {
    assert.equal(formatBytes(0), '0 KB');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(3 * 1024 * 1024 * 1024), '3.0 GB');
  });
});
