// Best-effort cost accounting for AI API calls. Appends every call to
// `${dataPath}/usage.jsonl` so the Settings card and `listener usage` CLI can
// roll up monthly totals.
//
// Two cost sources:
// 1. pi-ai's `response.usage.cost.total` -- already computed by pi-ai using its
//    bundled model price table (see node_modules/@earendil-works/pi-ai/dist/
//    models.generated.js). Used for summary/agent calls. Passed verbatim via
//    `recordUsage({ precomputedUsd, ... })`.
// 2. Our own MODEL_PRICING table -- for the two paths that bypass pi-ai:
//    Gemini transcription (`@google/genai` SDK direct, not pi-ai chat) and
//    OpenAI STT (`/v1/audio/transcriptions` raw fetch). pi-ai is chat-only;
//    there's no audio surface to delegate to.
//
// Caveat: estimate. The user's invoice is the source of truth. Unknown models
// record as `{ usd: 0, modelUnknown: true }` rather than throwing -- billing
// tracking must never break the transcription pipeline.
//
// jsonl writes use `fs.appendFileSync` (single syscall with O_APPEND on
// POSIX, where the kernel guarantees an atomic offset+write for local
// filesystems). Best-effort on Windows and networked filesystems: rare
// interleaved lines are possible. summarizeUsage skips malformed lines so
// a single corrupted entry doesn't poison the monthly roll-up.

import * as fs from 'fs';
import * as path from 'path';
import { getDataPath } from '../dataPath';

/**
 * Per-model rates. Text/image/audio token rates are $ per 1M tokens.
 * `audioPerMinute` is $ per minute of audio input or realtime audio session
 * duration for models billed by elapsed audio time.
 * `audioInput` overrides `input` when the call kind is 'transcription' and the
 * provider charges a different rate for audio tokens (gemini-2.5-flash:
 * $1.00/M for audio vs $0.30/M for text).
 */
export interface ModelPricing {
  input?: number;
  output?: number;
  /** $ per 1M cached-input tokens (pi-ai calls this `cacheRead`). */
  cacheRead?: number;
  audioInput?: number;
  audioPerMinute?: number;
}

// Source: docs/model-pricing.md (verified 2026-06-15). Keep in sync.
//
// This table is consulted ONLY for non-pi-ai paths. If the same model is used
// through pi-ai's `complete()`, the caller passes pi-ai's precomputed cost
// instead and this table is bypassed.
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Gemini transcription: @google/genai SDK direct call. Audio-token rates can
  // override text rates when kind is 'transcription'.
  'gemini-3.5-flash': { input: 1.5, output: 9.0 },
  'gemini-2.5-flash': { input: 0.3, audioInput: 1.0, output: 2.5 },
  // OpenAI STT (raw fetch to /v1/audio/transcriptions). Billed per audio
  // minute, prorated to the second.
  'gpt-4o-transcribe': { audioPerMinute: 0.006 },
  'gpt-4o-transcribe-diarize': { audioPerMinute: 0.006 },
  'gpt-4o-mini-transcribe': { audioPerMinute: 0.003 },
  'whisper-1': { audioPerMinute: 0.006 },
  // OpenAI Realtime audio-duration pricing.
  'gpt-realtime-whisper': { audioPerMinute: 0.017 },
  'gpt-realtime-translate': { audioPerMinute: 0.034 },
  // Gemini Live effective per-minute pricing from Google's audio-token rates.
  // 3.1 Flash Live transcription uses input audio only. 3.5 Live Translate
  // uses the documented combined input+output effective price.
  'gemini-3.1-flash-live-preview': { audioPerMinute: 0.005 },
  'gemini-3.5-live-translate-preview': { audioPerMinute: 0.0368 },
};

export type UsageKind = 'summary' | 'transcription' | 'agent' | 'realtime';

export interface UsageTokens {
  /** Input tokens (text/image, or audio when kind=transcription). */
  input?: number;
  /** Output tokens. Includes reasoning/thought tokens unless the model splits them. */
  output?: number;
  /** Cached input tokens (billed at the model's cacheRead rate). */
  cacheRead?: number;
  /** Cache-write tokens from pi-ai. Not priced by us (pi-ai owns chat cost). */
  cacheWrite?: number;
  /** Seconds of audio sent to a per-minute STT model. */
  audioSeconds?: number;
}

export interface CostResult {
  usd: number;
  /** True when the modelId wasn't in MODEL_PRICING. usd is then 0. */
  modelUnknown?: boolean;
}

export interface RecordInput {
  modelId: string;
  kind: UsageKind;
  usage: UsageTokens;
  /**
   * Pre-computed USD cost. Used by callers that have a more authoritative
   * number than our MODEL_PRICING table -- specifically pi-ai, whose
   * `response.usage.cost.total` is already computed by the upstream bundled
   * price table. When set, computeCost is skipped.
   */
  precomputedUsd?: number;
  /** Optional ref so the entry can be tied back to a transcription folder. */
  transcriptionRef?: string;
  /** Override the timestamp (defaults to now). Used by tests. */
  timestamp?: string;
}

export interface UsageEntry {
  timestamp: string;
  modelId: string;
  kind: UsageKind;
  usage: UsageTokens;
  usd: number;
  modelUnknown?: boolean;
  transcriptionRef?: string;
}

const PER_MILLION = 1_000_000;
const PER_MINUTE_SECONDS = 60;

/**
 * Compute the USD cost of a single call. Fails soft when the model isn't in
 * MODEL_PRICING: returns `{ usd: 0, modelUnknown: true }` so the caller can
 * continue. Used only for paths that bypass pi-ai (Gemini transcription via
 * @google/genai, OpenAI STT via raw fetch).
 */
export function computeCost(modelId: string, kind: UsageKind, usage: UsageTokens): CostResult {
  const pricing = MODEL_PRICING[modelId];
  if (!pricing) return { usd: 0, modelUnknown: true };

  // Per-minute STT models bill audio only; token fields are ignored.
  if (typeof pricing.audioPerMinute === 'number') {
    const seconds = usage.audioSeconds ?? 0;
    return { usd: (seconds / PER_MINUTE_SECONDS) * pricing.audioPerMinute };
  }

  // Token-priced models. Transcription kind uses audioInput when a model has
  // a modality-specific audio rate; summary/agent use the text rate. cacheRead
  // falls back to the same input rate when no cache discount is defined
  // (avoids silent $0 billing for cached tokens).
  const inputRate =
    kind === 'transcription' && typeof pricing.audioInput === 'number'
      ? pricing.audioInput
      : (pricing.input ?? 0);
  const cacheRate = pricing.cacheRead ?? inputRate;
  const outputRate = pricing.output ?? 0;

  const usd =
    ((usage.input ?? 0) * inputRate +
      (usage.cacheRead ?? 0) * cacheRate +
      (usage.output ?? 0) * outputRate) /
    PER_MILLION;
  return { usd };
}

/** Override the data path -- used by tests to redirect to a temp dir. */
let overrideDataPath: string | undefined;
export function _setDataPathForTesting(p: string | undefined): void {
  overrideDataPath = p;
}

/**
 * Resolve where usage.jsonl lives. Returns null in test mode without an
 * explicit override -- otherwise unit tests that exercise `complete()` (e.g.
 * agentService.piai.test.ts) would silently write into the user's real
 * Application Support dir.
 *
 * If you are writing a test that depends on persisted usage entries and they
 * appear to vanish: call `_setDataPathForTesting(tempDir)` in a `before` hook,
 * or set `LISTENER_DATA_PATH` in the spawned subprocess's env (CLI integration
 * tests do this). The null return is intentional and only kicks in when both
 * are missing.
 */
function usageFilePath(): string | null {
  if (overrideDataPath) return path.join(overrideDataPath, 'usage.jsonl');
  if (process.env.NODE_ENV === 'test' && !process.env.LISTENER_DATA_PATH) return null;
  return path.join(getDataPath(), 'usage.jsonl');
}

/**
 * Append one usage entry to usage.jsonl and return the computed cost. Never
 * throws -- swallows fs errors with a warning so accounting failures don't
 * break transcription. Returns `{ usd: 0, modelUnknown: true }` for unknown
 * models so the caller can still aggregate.
 */
export function recordUsage(input: RecordInput): CostResult {
  const cost: CostResult =
    typeof input.precomputedUsd === 'number'
      ? { usd: input.precomputedUsd }
      : computeCost(input.modelId, input.kind, input.usage);
  const entry: UsageEntry = {
    timestamp: input.timestamp ?? new Date().toISOString(),
    modelId: input.modelId,
    kind: input.kind,
    usage: input.usage,
    usd: cost.usd,
    modelUnknown: cost.modelUnknown,
    transcriptionRef: input.transcriptionRef,
  };
  const file = usageFilePath();
  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf-8');
    } catch (err) {
      console.warn('[usageTracker] failed to write usage.jsonl:', err);
    }
  }
  return cost;
}

export interface CostBreakdownItem {
  modelId: string;
  kind: UsageKind;
  usd: number;
  usage: UsageTokens;
  modelUnknown?: boolean;
}

export interface CostSnapshot {
  usd: number;
  breakdown: CostBreakdownItem[];
  /** True when at least one sub-call hit a model not in MODEL_PRICING. */
  modelUnknown?: boolean;
}

/**
 * Per-call cost session for multi-step pipelines (transcribeWithTwoSteps).
 * `record()` writes through to usage.jsonl and also accumulates into a local
 * breakdown the caller can read at the end. The breakdown is what gets
 * persisted in summary.md frontmatter.
 */
export interface CostSession {
  record(input: RecordInput): CostResult;
  snapshot(): CostSnapshot;
}

export function createCostSession(): CostSession {
  const items: CostBreakdownItem[] = [];
  return {
    record(input) {
      const cost = recordUsage(input);
      items.push({
        modelId: input.modelId,
        kind: input.kind,
        usd: cost.usd,
        usage: input.usage,
        modelUnknown: cost.modelUnknown,
      });
      return cost;
    },
    snapshot() {
      const usd = items.reduce((sum, it) => sum + it.usd, 0);
      const modelUnknown = items.some((it) => it.modelUnknown);
      return modelUnknown ? { usd, breakdown: items, modelUnknown } : { usd, breakdown: items };
    },
  };
}

export interface SummaryFilter {
  /** ISO timestamp; entries with `timestamp >= since` are included. */
  since?: string;
  /** ISO timestamp; entries with `timestamp < until` are included. */
  until?: string;
}

export interface SummaryGroup {
  modelId: string;
  kind: UsageKind;
  usd: number;
  count: number;
  tokens: UsageTokens;
}

export interface UsageSummaryResult {
  totalUsd: number;
  count: number;
  modelUnknownCount: number;
  byModel: SummaryGroup[];
}

function readAllEntries(): UsageEntry[] {
  const file = usageFilePath();
  // Test mode without an override path: nothing to read. summarizeUsage returns
  // an empty roll-up, matching the "no usage recorded yet" first-run state.
  if (!file) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const entries: UsageEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as UsageEntry;
      if (parsed && typeof parsed.timestamp === 'string' && typeof parsed.modelId === 'string') {
        entries.push(parsed);
      }
    } catch {
      // Skip malformed lines silently -- jsonl is best-effort, a bad line
      // from a half-written entry shouldn't poison the whole summary.
    }
  }
  return entries;
}

/**
 * Roll up jsonl entries inside [since, until). Both bounds optional. Groups by
 * (modelId, kind) so the Settings card can show per-model totals.
 */
export function summarizeUsage(filter: SummaryFilter = {}): UsageSummaryResult {
  const all = readAllEntries();
  const filtered = all.filter((e) => {
    if (filter.since && e.timestamp < filter.since) return false;
    if (filter.until && e.timestamp >= filter.until) return false;
    return true;
  });

  const groups = new Map<string, SummaryGroup>();
  let totalUsd = 0;
  let modelUnknownCount = 0;

  for (const e of filtered) {
    totalUsd += e.usd;
    if (e.modelUnknown) modelUnknownCount += 1;
    const key = `${e.modelId} ${e.kind}`;
    const existing = groups.get(key);
    if (existing) {
      existing.usd += e.usd;
      existing.count += 1;
      existing.tokens = sumTokens(existing.tokens, e.usage);
    } else {
      groups.set(key, {
        modelId: e.modelId,
        kind: e.kind,
        usd: e.usd,
        count: 1,
        tokens: { ...e.usage },
      });
    }
  }

  const byModel = Array.from(groups.values()).sort((a, b) => b.usd - a.usd);
  return { totalUsd, count: filtered.length, modelUnknownCount, byModel };
}

function sumTokens(a: UsageTokens, b: UsageTokens): UsageTokens {
  return {
    input: (a.input ?? 0) + (b.input ?? 0) || undefined,
    output: (a.output ?? 0) + (b.output ?? 0) || undefined,
    cacheRead: (a.cacheRead ?? 0) + (b.cacheRead ?? 0) || undefined,
    cacheWrite: (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0) || undefined,
    audioSeconds: (a.audioSeconds ?? 0) + (b.audioSeconds ?? 0) || undefined,
  };
}

/**
 * Convert "YYYY-MM" to an ISO range [start, end) covering that calendar month
 * in the user's local timezone. Used by `listener usage --month` and the
 * Settings card default. Local-zone semantics matter: a user in Asia/Seoul
 * thinks "May 2026" as KST May 1 00:00 to KST June 1 00:00, not the UTC
 * window. With UTC bounds, an 09:00 KST call on May 1 would leak into April.
 */
export function monthRange(month: string): { since: string; until: string } {
  const match = month.match(/^(\d{4})-(\d{2})$/);
  if (!match) throw new Error(`Invalid month: ${month} (expected YYYY-MM)`);
  const year = Number.parseInt(match[1], 10);
  const m = Number.parseInt(match[2], 10);
  if (m < 1 || m > 12) throw new Error(`Invalid month: ${month}`);
  // `new Date(y, m, d)` is local time; ISO output is the corresponding UTC
  // instant. JS handles m=12 by rolling year forward automatically.
  const since = new Date(year, m - 1, 1).toISOString();
  const until = new Date(year, m, 1).toISOString();
  return { since, until };
}

export function currentMonthString(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export { formatUsd } from '../usageFormat';
