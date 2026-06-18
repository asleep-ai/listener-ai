import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import * as fs from 'fs';
import * as path from 'path';
import {
  _setDataPathForTesting,
  computeCost,
  createCostSession,
  currentMonthString,
  formatUsd,
  MODEL_PRICING,
  monthRange,
  recordUsage,
  summarizeUsage,
} from './usageTracker';
import { makeTempDir, rmDir } from '../test-helpers';

// Helper: drop the per-key floating-point noise so deepEqual against expected
// integers works without epsilon plumbing in every assertion.
function roundCents(n: number, digits = 6): number {
  const m = 10 ** digits;
  return Math.round(n * m) / m;
}

describe('computeCost', () => {
  it('returns modelUnknown for an unrecognized model id', () => {
    const result = computeCost('not-a-real-model', 'summary', { input: 1000, output: 500 });
    assert.equal(result.modelUnknown, true);
    assert.equal(result.usd, 0);
  });

  it('uses gemini-2.5-flash audioInput rate when kind is transcription', () => {
    const pricing = MODEL_PRICING['gemini-2.5-flash'];
    const trans = computeCost('gemini-2.5-flash', 'transcription', {
      input: 1_000_000,
      output: 1_000_000,
    });
    assert.equal(roundCents(trans.usd), pricing.audioInput! + pricing.output!);

    const summary = computeCost('gemini-2.5-flash', 'summary', {
      input: 1_000_000,
      output: 0,
    });
    assert.equal(roundCents(summary.usd), pricing.input!);
  });

  it('prices gemini-3.5-flash when used for direct transcription', () => {
    const pricing = MODEL_PRICING['gemini-3.5-flash'];
    const result = computeCost('gemini-3.5-flash', 'transcription', {
      input: 1_000_000,
      output: 1_000_000,
    });
    assert.equal(roundCents(result.usd), pricing.input! + pricing.output!);
  });

  it('prices gpt-4o-transcribe per audio minute, ignoring tokens', () => {
    const pricing = MODEL_PRICING['gpt-4o-transcribe'];
    // 600s = 10min; spurious `input` field must not double-bill.
    const result = computeCost('gpt-4o-transcribe', 'transcription', {
      audioSeconds: 600,
      input: 1_000_000,
    });
    assert.equal(roundCents(result.usd), 10 * pricing.audioPerMinute!);
  });

  it('prices realtime models per audio minute', () => {
    assert.equal(
      roundCents(
        computeCost('gpt-realtime-whisper', 'realtime', {
          audioSeconds: 120,
        }).usd,
      ),
      0.034,
    );
    assert.equal(
      roundCents(
        computeCost('gpt-realtime-translate', 'realtime', {
          audioSeconds: 60,
        }).usd,
      ),
      0.034,
    );
    assert.equal(
      roundCents(
        computeCost('gemini-3.5-live-translate-preview', 'realtime', {
          audioSeconds: 60,
        }).usd,
      ),
      0.0368,
    );
  });

  it('treats thoughts tokens as output (folded by caller)', () => {
    // geminiService wraps candidates+thoughts into a single `output` count.
    const pricing = MODEL_PRICING['gemini-2.5-flash'];
    const total = 800_000;
    const result = computeCost('gemini-2.5-flash', 'transcription', { output: total });
    assert.equal(roundCents(result.usd), roundCents((total / 1_000_000) * pricing.output!));
  });

  it('falls back to input rate when cacheRead rate is missing', () => {
    // gemini-2.5-flash has no cacheRead rate. Cached tokens fall back to the
    // audio rate (transcription) or text rate (summary) so they aren't $0.
    const pricing = MODEL_PRICING['gemini-2.5-flash'];
    assert.equal(pricing.cacheRead, undefined);

    const trans = computeCost('gemini-2.5-flash', 'transcription', { cacheRead: 1_000_000 });
    assert.equal(roundCents(trans.usd), pricing.audioInput!);

    const summary = computeCost('gemini-2.5-flash', 'summary', { cacheRead: 1_000_000 });
    assert.equal(roundCents(summary.usd), pricing.input!);
  });
});

describe('recordUsage + summarizeUsage', () => {
  let tmp: string;

  before(() => {
    tmp = makeTempDir('usage-tracker');
    _setDataPathForTesting(tmp);
  });

  after(() => {
    _setDataPathForTesting(undefined);
    rmDir(tmp);
  });

  beforeEach(() => {
    const file = path.join(tmp, 'usage.jsonl');
    if (fs.existsSync(file)) fs.unlinkSync(file);
  });

  it('writes one jsonl line per call and round-trips through summarize', () => {
    recordUsage({
      modelId: 'gemini-2.5-flash',
      kind: 'summary',
      usage: { input: 1_000_000, output: 0 },
      timestamp: '2026-05-10T10:00:00.000Z',
    });
    recordUsage({
      modelId: 'gpt-4o-transcribe',
      kind: 'transcription',
      usage: { audioSeconds: 60 },
      timestamp: '2026-05-15T10:00:00.000Z',
    });

    const range = monthRange('2026-05');
    const summary = summarizeUsage(range);
    assert.equal(summary.count, 2);
    assert.equal(summary.byModel.length, 2);
    // gemini-2.5-flash summary input $0.30/M + gpt-4o-transcribe $0.006
    assert.equal(roundCents(summary.totalUsd), roundCents(0.3 + 0.006));
  });

  it('filters entries outside the [since, until) range', () => {
    // Build fixtures from the actual range so the test is timezone-agnostic.
    // Mid-month is deep inside the window from any local zone; March/July
    // are deep outside.
    const may = monthRange('2026-05');
    const mid = new Date(new Date(may.since).getTime() + 14 * 24 * 3600 * 1000).toISOString();
    recordUsage({
      modelId: 'gemini-2.5-flash',
      kind: 'summary',
      usage: { input: 1_000_000 },
      timestamp: '2026-03-15T12:00:00.000Z',
    });
    recordUsage({
      modelId: 'gemini-2.5-flash',
      kind: 'summary',
      usage: { input: 1_000_000 },
      timestamp: mid,
    });
    recordUsage({
      modelId: 'gemini-2.5-flash',
      kind: 'summary',
      usage: { input: 1_000_000 },
      timestamp: '2026-07-15T12:00:00.000Z',
    });

    const summary = summarizeUsage(may);
    assert.equal(summary.count, 1);
    assert.equal(summary.byModel[0].count, 1);
  });

  it('excludes the until boundary (half-open range)', () => {
    const may = monthRange('2026-05');
    recordUsage({
      modelId: 'gemini-2.5-flash',
      kind: 'summary',
      usage: { input: 1_000_000 },
      timestamp: may.until, // exactly the upper bound
    });
    const summary = summarizeUsage(may);
    assert.equal(summary.count, 0);
  });

  it('groups by (modelId, kind) when summarizing', () => {
    recordUsage({
      modelId: 'gemini-2.5-flash',
      kind: 'summary',
      usage: { input: 500_000 },
      timestamp: '2026-05-10T10:00:00.000Z',
    });
    recordUsage({
      modelId: 'gemini-2.5-flash',
      kind: 'agent',
      usage: { input: 500_000 },
      timestamp: '2026-05-11T10:00:00.000Z',
    });
    recordUsage({
      modelId: 'gemini-2.5-flash',
      kind: 'summary',
      usage: { input: 500_000 },
      timestamp: '2026-05-12T10:00:00.000Z',
    });

    const summary = summarizeUsage(monthRange('2026-05'));
    assert.equal(summary.byModel.length, 2);
    const summaryRow = summary.byModel.find((r) => r.kind === 'summary');
    const agentRow = summary.byModel.find((r) => r.kind === 'agent');
    assert.ok(summaryRow && agentRow);
    assert.equal(summaryRow!.count, 2);
    assert.equal(agentRow!.count, 1);
  });

  it('skips malformed jsonl lines without throwing', () => {
    const file = path.join(tmp, 'usage.jsonl');
    fs.writeFileSync(
      file,
      '{not valid json}\n' +
        `${JSON.stringify({ timestamp: '2026-05-10T10:00:00.000Z', modelId: 'gemini-2.5-pro', kind: 'summary', usage: {}, usd: 1.0 })}\n`,
      'utf-8',
    );
    const summary = summarizeUsage(monthRange('2026-05'));
    assert.equal(summary.count, 1);
    assert.equal(roundCents(summary.totalUsd), 1.0);
  });
});

describe('createCostSession', () => {
  let tmp: string;
  before(() => {
    tmp = makeTempDir('usage-session');
    _setDataPathForTesting(tmp);
  });
  after(() => {
    _setDataPathForTesting(undefined);
    rmDir(tmp);
  });
  beforeEach(() => {
    const file = path.join(tmp, 'usage.jsonl');
    if (fs.existsSync(file)) fs.unlinkSync(file);
  });

  it('aggregates per-call costs into a snapshot', () => {
    const session = createCostSession();
    // Transcription: audioInput rate $1.00/M
    session.record({
      modelId: 'gemini-2.5-flash',
      kind: 'transcription',
      usage: { input: 1_000_000, output: 0 },
    });
    // STT: $0.006/min for 1 minute
    session.record({
      modelId: 'gpt-4o-transcribe',
      kind: 'transcription',
      usage: { audioSeconds: 60 },
    });
    const snap = session.snapshot();
    assert.equal(snap.breakdown.length, 2);
    assert.equal(roundCents(snap.usd), roundCents(1.0 + 0.006));
  });

  it('passes pi-ai precomputedUsd through without re-pricing', () => {
    const session = createCostSession();
    // Mimic a piAiClient.complete() call: model isn't in our table (pi-ai
    // owns chat-model pricing), but precomputedUsd is supplied.
    session.record({
      modelId: 'gpt-5.5',
      kind: 'summary',
      usage: { input: 1000, output: 500 },
      precomputedUsd: 0.0234,
    });
    const snap = session.snapshot();
    assert.equal(snap.breakdown.length, 1);
    assert.equal(roundCents(snap.usd), 0.0234);
    // modelUnknown must NOT be set -- pi-ai authoritative-priced this call.
    assert.equal(snap.modelUnknown, undefined);
  });

  it('marks modelUnknown on the snapshot when any sub-call had an unknown model', () => {
    const session = createCostSession();
    session.record({
      modelId: 'gemini-2.5-flash',
      kind: 'summary',
      usage: { input: 1_000_000 },
    });
    session.record({
      modelId: 'made-up-model',
      kind: 'agent',
      usage: { input: 1_000_000 },
    });
    const snap = session.snapshot();
    assert.equal(snap.modelUnknown, true);
  });

  it('persists every recorded call to jsonl', () => {
    const session = createCostSession();
    session.record({
      modelId: 'gemini-2.5-flash',
      kind: 'summary',
      usage: { input: 100_000 },
      timestamp: '2026-05-10T10:00:00.000Z',
    });
    session.record({
      modelId: 'gpt-4o-transcribe',
      kind: 'transcription',
      usage: { audioSeconds: 30 },
      timestamp: '2026-05-10T10:00:01.000Z',
    });
    const summary = summarizeUsage(monthRange('2026-05'));
    assert.equal(summary.count, 2);
  });
});

describe('monthRange', () => {
  it('produces a local-time half-open range for a calendar month', () => {
    const r = monthRange('2026-05');
    // Local midnight on May 1 in whatever zone the test runs in; we assert on
    // the local-time projection of the result, not exact UTC strings.
    const since = new Date(r.since);
    const until = new Date(r.until);
    assert.equal(since.getFullYear(), 2026);
    assert.equal(since.getMonth(), 4); // May (0-indexed)
    assert.equal(since.getDate(), 1);
    assert.equal(since.getHours(), 0);
    assert.equal(since.getMinutes(), 0);
    assert.equal(until.getFullYear(), 2026);
    assert.equal(until.getMonth(), 5); // June (0-indexed)
    assert.equal(until.getDate(), 1);
    assert.equal(until.getHours(), 0);
  });

  it('handles December rollover correctly', () => {
    const r = monthRange('2026-12');
    const until = new Date(r.until);
    assert.equal(until.getFullYear(), 2027);
    assert.equal(until.getMonth(), 0); // January (0-indexed)
    assert.equal(until.getDate(), 1);
  });

  it('throws on invalid input', () => {
    assert.throws(() => monthRange('not-a-month'));
    assert.throws(() => monthRange('2026-13'));
    assert.throws(() => monthRange('2026-00'));
  });
});

describe('currentMonthString', () => {
  it('returns the current month in YYYY-MM (local time)', () => {
    // Build a Date that is the 15th in local time, then verify the YYYY-MM
    // we emit matches the local-time month/year of that date. Avoids UTC vs
    // local timezone drift on the assertion side.
    const local = new Date(2026, 4, 15, 10, 0, 0);
    assert.equal(currentMonthString(local), '2026-05');
  });
});

describe('formatUsd', () => {
  it('renders zero as $0', () => {
    assert.equal(formatUsd(0), '$0');
  });
  it('renders tiny amounts at 4-decimal precision', () => {
    assert.equal(formatUsd(0.001234), '$0.0012');
  });
  it('renders normal amounts at 2-decimal precision', () => {
    assert.equal(formatUsd(1.234), '$1.23');
  });
});
