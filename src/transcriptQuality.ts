// Shared transcript-quality analyzer for repetition/hallucination loops
// (issue #182). ASR providers can emit repeated or fabricated text on
// silence, low-signal noise, and music -- especially the diarize model,
// which accepts no grounding prompt. This module is the single detector
// used by both the batch pipeline (per-segment, per-file) and the live
// paths (per-final marking, duplicate suppression).
//
// Design constraints, in order:
//   1. Never delete text on detection alone. Callers may use a bounded
//      context-cleared retry ladder, then one exhaustion cleanup whose output
//      is accepted only when it never grows and the normal verdict is clean.
//      Otherwise the FIRST result is kept and marked uncertain.
//   2. Legitimate repetition (stutters, `네, 네` confirmations, chants,
//      emphasis) must survive. Thresholds are deliberately conservative and
//      cleanup must preserve every piece of genuine speech.
//   3. Korean-aware: comparisons strip whitespace entirely so spacing
//      variants of the same phrase compare equal, and loop detection works
//      on character periods too (Korean loops often contain no spaces).
//   4. Logs must never contain transcript text -- metrics and reasons only.

import * as zlib from 'zlib';

// Detection thresholds. Derived from issue #182's acceptance criteria
// ("three consecutive near-identical segments or the same normalized 4-gram
// repeated four consecutive times") with margins that keep legitimate
// repetition (<=2 duplicate turns, <=5 repeated words) unflagged. Final
// calibration against a labeled corpus is tracked in the issue; these are
// intentionally on the conservative (under-flagging) side.
const NEAR_DUPLICATE_SIMILARITY = 0.9;
const MIN_DUPLICATE_LINE_CHARS = 4;
const CONSECUTIVE_DUPLICATE_LINE_FLAG = 3;
const WORD_BLOCK_MAX_PERIOD = 4;
const NGRAM_FLAG_REPEATS = 4; // period-4 blocks (the issue's 4-gram rule)
const SHORT_BLOCK_FLAG_REPEATS = 6; // period 1-3 blocks need more repeats
const CHAR_PERIOD_MIN_LENGTH = 12;
// A genuine triple emphasis can be 15+ characters; decoder loops repeat far
// more, so require four complete periods before treating this shape as a loop.
const CHAR_PERIOD_MIN_REPEATS = 4;
// Local text-compression metric (deflate over normalized text). This is NOT
// the Whisper provider compression_ratio; hosted APIs don't expose one, so
// we measure our own. Natural prose stays well under 4x at this length.
const COMPRESSION_MIN_CHARS = 200;
const COMPRESSION_FLAG_RATIO = 4;

export const NO_SPEECH_SENTINEL = '[NO_SPEECH]';

export interface TranscriptQualityMetrics {
  /** Length of the whitespace-stripped normalized text. */
  normalizedLength: number;
  /** Longest run of consecutive near-identical lines (speaker turns). */
  maxConsecutiveDuplicateLines: number;
  /** Highest consecutive repeat count of any 1-4 word block. */
  maxWordBlockRepeats: number;
  /** deflate ratio of the normalized text; 0 below COMPRESSION_MIN_CHARS. */
  textCompressionRatio: number;
}

export interface TranscriptQualityReport {
  flagged: boolean;
  reasons: string[];
  metrics: TranscriptQualityMetrics;
}

// Comparison form: lowercase NFC with punctuation/symbols and ALL whitespace
// removed, so Korean spacing variants ("오늘 회의를" vs "오늘회의를") and
// punctuation-only differences compare equal. Used for cross-line and
// cross-final duplicate detection.
export function normalizeForComparison(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, '')
    .replace(/\s+/gu, '');
}

// Tokenization form: same cleanup but whitespace collapsed to single spaces
// so word-block loop detection still sees word boundaries.
function normalizeKeepSpaces(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

// Strip a leading speaker label ("참가자1:", "Speaker 2:") before per-line
// loop checks so the label doesn't mask a purely periodic payload.
export function stripSpeakerLabel(line: string): string {
  return line.replace(/^\s*(?:참가자|speaker)\s*\d+\s*[:：]\s*/iu, '');
}

// Character-bigram Dice coefficient on normalized strings. Cheap, order-two,
// and language-agnostic -- good enough for "near-identical" without an
// O(n^2) edit distance.
function bigramSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const counts = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const gram = a.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  let shared = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const gram = b.slice(i, i + 2);
    const remaining = counts.get(gram) ?? 0;
    if (remaining > 0) {
      counts.set(gram, remaining - 1);
      shared++;
    }
  }
  return (2 * shared) / (a.length - 1 + (b.length - 1));
}

// Longest run of consecutive near-identical lines. Lines shorter than
// MIN_DUPLICATE_LINE_CHARS (normalized) break the run so real short
// acknowledgements ("네", "맞아요") never accumulate into a flag.
function maxConsecutiveDuplicateLines(lines: string[]): number {
  let best = 1;
  let run = 1;
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const curr = lines[i];
    const comparable =
      prev.length >= MIN_DUPLICATE_LINE_CHARS && curr.length >= MIN_DUPLICATE_LINE_CHARS;
    if (comparable && bigramSimilarity(prev, curr) >= NEAR_DUPLICATE_SIMILARITY) {
      run++;
      if (run > best) best = run;
    } else {
      run = 1;
    }
  }
  return best;
}

// Highest consecutive repeat count of any word block of period 1..4.
// "빨리 빨리 빨리" -> period 1 repeated 3x. A period-4 block repeated 4x is
// the issue's "same normalized 4-gram four consecutive times" criterion.
function maxWordBlockRepeats(words: string[]): {
  period: number;
  repeats: number;
  flagged: boolean;
} {
  let best = { period: 0, repeats: 1 };
  let flagged = false;
  for (let period = 1; period <= WORD_BLOCK_MAX_PERIOD; period++) {
    for (let start = 0; start + period <= words.length; start++) {
      let repeats = 1;
      let next = start + period;
      while (next + period <= words.length) {
        let matches = true;
        for (let k = 0; k < period; k++) {
          if (words[next + k] !== words[start + k]) {
            matches = false;
            break;
          }
        }
        if (!matches) break;
        repeats++;
        next += period;
      }
      if (
        (period === WORD_BLOCK_MAX_PERIOD && repeats >= NGRAM_FLAG_REPEATS) ||
        (period < WORD_BLOCK_MAX_PERIOD && repeats >= SHORT_BLOCK_FLAG_REPEATS)
      ) {
        flagged = true;
      }
      if (repeats > best.repeats) best = { period, repeats };
      // Skip past this run; restarting inside it can't do better.
      if (repeats > 1) start = next - period;
    }
  }
  return { ...best, flagged };
}

// Smallest-period check via the KMP failure function: detects space-less
// character loops ("감사합니다감사합니다감사합니다") that word-block
// detection can't see. Only trusts full repetitions of at least
// CHAR_PERIOD_MIN_REPEATS over CHAR_PERIOD_MIN_LENGTH+ chars.
function hasCharPeriodLoop(normalized: string): boolean {
  const n = normalized.length;
  if (n < CHAR_PERIOD_MIN_LENGTH) return false;
  const fail = Array.from({ length: n }, () => 0);
  for (let i = 1; i < n; i++) {
    let k = fail[i - 1];
    while (k > 0 && normalized[i] !== normalized[k]) k = fail[k - 1];
    if (normalized[i] === normalized[k]) k++;
    fail[i] = k;
  }
  const period = n - fail[n - 1];
  if (period === 0 || period >= n) return false;
  return n % period === 0 && n / period >= CHAR_PERIOD_MIN_REPEATS;
}

function textCompressionRatio(normalized: string): number {
  if (normalized.length < COMPRESSION_MIN_CHARS) return 0;
  const raw = Buffer.from(normalized, 'utf8');
  const compressed = zlib.deflateRawSync(raw, { level: 9 });
  if (compressed.length === 0) return 0;
  return raw.length / compressed.length;
}

export function analyzeTranscriptQuality(text: string): TranscriptQualityReport {
  const normalized = normalizeForComparison(text);
  const lines = text
    .split(/\r?\n+/)
    .map((line) => normalizeForComparison(line))
    .filter((line) => line.length > 0);
  const words = normalizeKeepSpaces(text).split(' ').filter(Boolean);

  const duplicateLines = maxConsecutiveDuplicateLines(lines);
  const blockRepeats = maxWordBlockRepeats(words);
  const compressionRatio = textCompressionRatio(normalized);

  const reasons: string[] = [];
  if (duplicateLines >= CONSECUTIVE_DUPLICATE_LINE_FLAG) {
    reasons.push('consecutive-duplicate-lines');
  }
  const charLoop =
    hasCharPeriodLoop(normalized) ||
    text
      .split(/\r?\n+/)
      .some((line) => hasCharPeriodLoop(normalizeForComparison(stripSpeakerLabel(line))));
  if (blockRepeats.flagged || charLoop) {
    reasons.push('repeated-ngram-loop');
  }
  if (compressionRatio >= COMPRESSION_FLAG_RATIO) {
    reasons.push('high-text-compression');
  }

  return {
    flagged: reasons.length > 0,
    reasons,
    metrics: {
      normalizedLength: normalized.length,
      maxConsecutiveDuplicateLines: duplicateLines,
      maxWordBlockRepeats: blockRepeats.repeats,
      textCompressionRatio: compressionRatio,
    },
  };
}

// Final-stage analysis of the ASSEMBLED multi-segment transcript. Strips the
// batch scaffolding first: `[Segment N: HH:MM:SS ~ HH:MM:SS]` headers and
// `---` separators would otherwise sit adjacent when segments are empty and
// false-flag as near-duplicate lines. Running the analyzer across the joined
// text is what catches cross-segment repetition (the same hallucinated block
// ending segment N and opening segment N+1) that per-segment gating cannot
// see (issue #182 H3).
export function analyzeAssembledTranscript(transcript: string): TranscriptQualityReport {
  const body = transcript
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== '---' && !/^\[Segment \d+: [0-9:]+ ~ [0-9:]+\]$/.test(trimmed);
    })
    .join('\n');
  return analyzeTranscriptQuality(body);
}

// Boundary reconciliation for head-overlapped batch segments (issue #182
// root mitigation). Segments after the first are cut with a few seconds of
// audio overlap, so the same speech near a boundary is transcribed twice --
// that duplication is EVIDENCE, which makes deleting the second copy safe in
// a way that text-similarity dedupe without overlap never is. Matching is
// anchored at the boundary and bounded to a small window; when in doubt,
// nothing is removed.
const MAX_BOUNDARY_OVERLAP_CHARS = 400;
const BOUNDARY_LINE_SIMILARITY = 0.85;
const MIN_BOUNDARY_MATCH_CHARS = 10;
const MIN_BOUNDARY_LINE_CHARS = 4;

function splitTurns(body: string): string[] {
  return body
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// Number of lines from one side of a boundary that can plausibly belong to
// the audio overlap: accumulate normalized chars until the window budget is
// exhausted. Matching never looks past this window, so legitimately repeated
// speech deep inside a segment is untouchable by design.
function overlapWindowLines(normalizedLines: string[], fromEnd: boolean): number {
  let window = 0;
  let acc = 0;
  for (let i = 0; i < normalizedLines.length; i++) {
    const length = normalizedLines[fromEnd ? normalizedLines.length - 1 - i : i].length;
    // Strict budget: a line only joins the window if it fits entirely. The
    // boundary-adjacent line always counts, though -- a single long turn
    // crossing the cut must stay reconcilable.
    if (window > 0 && acc + length > MAX_BOUNDARY_OVERLAP_CHARS) break;
    acc += length;
    window++;
  }
  return window;
}

function reconcileBoundary(prevBody: string, nextBody: string): { next: string; removed: number } {
  if (!prevBody.trim() || !nextBody.trim()) return { next: nextBody, removed: 0 };
  const prevLines = splitTurns(prevBody);
  const nextLines = splitTurns(nextBody);
  const prevNorm = prevLines.map(normalizeForComparison);
  const nextNorm = nextLines.map(normalizeForComparison);

  // Largest run of next's leading lines that near-matches prev's trailing
  // lines in order. Anchored: line j of the run must match line j -- a stray
  // match deeper in either segment can never trigger removal.
  const maxK = Math.min(overlapWindowLines(prevNorm, true), overlapWindowLines(nextNorm, false));
  for (let k = maxK; k >= 1; k--) {
    let matchedChars = 0;
    let allMatch = true;
    for (let j = 0; j < k; j++) {
      const prevLine = prevNorm[prevNorm.length - k + j];
      const nextLine = nextNorm[j];
      if (
        prevLine.length < MIN_BOUNDARY_LINE_CHARS ||
        nextLine.length < MIN_BOUNDARY_LINE_CHARS ||
        // Normalization already strips whitespace and punctuation, so the same
        // overlap audio has near-equal lengths. Meaningfully longer text carries
        // continuation and must survive; when unsure, keep the duplicate.
        nextLine.length > prevLine.length + 2 ||
        bigramSimilarity(prevLine, nextLine) < BOUNDARY_LINE_SIMILARITY
      ) {
        allMatch = false;
        break;
      }
      matchedChars += nextLine.length;
    }
    if (allMatch && matchedChars >= MIN_BOUNDARY_MATCH_CHARS) {
      return { next: nextLines.slice(k).join('\n\n'), removed: matchedChars };
    }
  }

  // Half-line case: the overlap cut a turn mid-sentence, so next's first
  // line is the tail of prev's last line. Require an exact normalized
  // suffix -- similarity alone is too weak evidence for a partial line.
  const lastPrev = prevNorm[prevNorm.length - 1] ?? '';
  const firstNext = nextNorm[0] ?? '';
  if (firstNext.length >= MIN_BOUNDARY_MATCH_CHARS && lastPrev.endsWith(firstNext)) {
    return { next: nextLines.slice(1).join('\n\n'), removed: firstNext.length };
  }

  return { next: nextBody, removed: 0 };
}

// Reconcile every adjacent segment pair. Removals only ever trim the HEAD of
// the later segment (the earlier segment's version of the overlap is kept),
// so boundary b+1 -> b+2 correctly sees b+1's already-trimmed head while its
// tail -- the input to the next comparison -- is never modified.
export function reconcileOverlappingSegments(bodies: string[]): {
  bodies: string[];
  removedPerBoundary: number[];
} {
  const out = [...bodies];
  const removedPerBoundary: number[] = [];
  for (let b = 0; b + 1 < out.length; b++) {
    const { next, removed } = reconcileBoundary(out[b], out[b + 1]);
    out[b + 1] = next;
    removedPerBoundary.push(removed);
  }
  return { bodies: out, removedPerBoundary };
}

const MAX_QUALITY_NOTES = 10;
const MAX_QUALITY_NOTE_CHARS = 300;

// Normalize the summary model's optional `transcriptQualityNotes` JSON field
// into a bounded string list. The prompt asks for short sentences in the meeting's primary language, but
// models sometimes return objects or nest unexpectedly -- tolerate that
// without letting a malformed response bloat meta.json.
export function normalizeTranscriptQualityNotes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const notes: string[] = [];
  for (const item of raw) {
    if (notes.length >= MAX_QUALITY_NOTES) break;
    let text: string;
    if (typeof item === 'string') {
      text = item.trim();
    } else if (item && typeof item === 'object') {
      try {
        text = JSON.stringify(item);
      } catch {
        continue;
      }
    } else {
      continue;
    }
    if (!text) continue;
    notes.push(
      text.length > MAX_QUALITY_NOTE_CHARS ? `${text.slice(0, MAX_QUALITY_NOTE_CHARS)}...` : text,
    );
  }
  return notes;
}

// Remove the [NO_SPEECH] sentinel the transcription prompts define for
// silent audio. Tolerates the sentinel arriving as the whole output, as a
// standalone line, or with stray punctuation around it -- but never touches
// lines that contain any other content.
export function stripNoSpeechSentinel(text: string): string {
  const sentinelLine = /^[\s.,!?~\-–—]*\[?NO_SPEECH\]?[\s.,!?~\-–—]*$/i;
  return text
    .split(/\r?\n/)
    .filter((line) => !sentinelLine.test(line.trim()))
    .join('\n')
    .trim();
}

export interface QualityGateInput {
  /** First transcription result (sentinel already stripped by the caller). */
  text: string;
  /** Tag for log lines, e.g. "segment 3/10". Never include transcript text. */
  label: string;
  /**
   * Optional semantic repetition judge. When present, its verdict replaces
   * the analyzer verdict for every non-empty result. The analyzer still runs
   * for metrics and becomes the fail-open fallback when the judge fails.
   */
  judge?: (text: string) => Promise<{ flagged: boolean; reason?: string }>;
  /**
   * Ordered bounded quality retries with prior/context text cleared. Rungs run
   * in order, at most once each, until the first clean result wins (including
   * empty text as silence evidence). A throwing rung is logged and skipped.
   * If every rung stays flagged, the optional cleanup gets one last chance.
   * Failed rungs or rejected/failed cleanup keep the first result uncertain.
   * Omit or pass an empty array to disable retrying (live chunks must not
   * blindly resend the same low-signal audio).
   */
  retries?: Array<() => Promise<string>>;
  /**
   * Last-resort text cleanup after configured retries are exhausted. Receives
   * the first result, never a retry result. The gate accepts its output only
   * when it does not grow and the normal verdict path considers it clean.
   */
  cleanup?: (text: string) => Promise<string>;
  log?: (message: string) => void;
}

export interface QualityGateResult {
  text: string;
  /** True when the accepted text is still anomalous (treat as uncertain). */
  flagged: boolean;
  reasons: string[];
  retried: boolean;
  retriesAttempted: number;
  /** Present only when an exhaustion cleanup was accepted. */
  cleaned?: boolean;
}

type QualityVerdictSource = 'judge' | 'analyzer' | 'empty';

interface QualityVerdict {
  flagged: boolean;
  reasons: string[];
  source: QualityVerdictSource;
  report: TranscriptQualityReport;
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && 'name' in error && error.name === 'AbortError',
  );
}

function cappedQualityErrorMessage(error: unknown, transcriptText: string): string {
  let message = error instanceof Error ? error.message : String(error);
  const transcriptFragments = new Set(
    [transcriptText, ...transcriptText.split(/\r?\n/)]
      .map((fragment) => fragment.trim())
      .filter(Boolean),
  );
  for (const fragment of transcriptFragments) {
    message = message.split(fragment).join('[transcript redacted]');
  }
  return message.slice(0, 200);
}

// Bounded accept/retry policy on top of the optional judge (or analyzer
// fallback):
//   clean first        -> accept
//   flagged, no retry  -> keep first, mark uncertain
//   flagged + retries  -> first clean retry (including empty = "audio was
//                         silent") replaces the first; if all rungs stay
//                         flagged, one guarded cleanup may replace the FIRST
//                         result. Otherwise keep the FIRST result uncertain.
export async function applyTranscriptQualityGate(
  input: QualityGateInput,
): Promise<QualityGateResult> {
  const log = input.log ?? ((message: string) => console.warn(message));
  const describe = (report: TranscriptQualityReport, source: QualityVerdictSource): string => {
    const reasons =
      report.reasons.length > 0
        ? report.reasons.join(', ')
        : source === 'judge'
          ? 'judge-loop-verdict'
          : 'no-analyzer-reasons';
    return (
      `${reasons}; normalizedLength=${report.metrics.normalizedLength}, ` +
      `duplicateLines=${report.metrics.maxConsecutiveDuplicateLines}, ` +
      `blockRepeats=${report.metrics.maxWordBlockRepeats}, ` +
      `compression=${report.metrics.textCompressionRatio.toFixed(2)}`
    );
  };
  const verdictFor = async (text: string): Promise<QualityVerdict> => {
    const report = analyzeTranscriptQuality(text);
    if (!text.trim()) {
      return { flagged: false, reasons: [], source: 'empty', report };
    }
    if (!input.judge) {
      return { flagged: report.flagged, reasons: report.reasons, source: 'analyzer', report };
    }
    try {
      const judged = await input.judge(text);
      return {
        flagged: judged.flagged,
        reasons: judged.flagged ? [judged.reason?.trim() || 'quality-judge-loop'] : [],
        source: 'judge',
        report,
      };
    } catch (error) {
      if (isAbortError(error)) throw error;
      const message = cappedQualityErrorMessage(error, text);
      log(
        `[transcript-quality] ${input.label}: judge failed (${message}); ` +
          'falling back to analyzer',
      );
      return { flagged: report.flagged, reasons: report.reasons, source: 'analyzer', report };
    }
  };

  const first = await verdictFor(input.text);
  if (!first.flagged) {
    return {
      text: input.text,
      flagged: false,
      reasons: [],
      retried: false,
      retriesAttempted: 0,
    };
  }
  log(
    `[transcript-quality] ${input.label}: flagged by ${first.source} (` +
      `${describe(first.report, first.source)})`,
  );

  if (!input.retries?.length) {
    log(`[transcript-quality] ${input.label}: no retry available; keeping flagged text`);
    return {
      text: input.text,
      flagged: true,
      reasons: first.reasons,
      retried: false,
      retriesAttempted: 0,
    };
  }

  const totalRetries = input.retries.length;
  let allRetriesFlagged = true;
  for (let index = 0; index < totalRetries; index++) {
    const attempt = index + 1;
    let retryText: string;
    try {
      retryText = await input.retries[index]();
    } catch (error) {
      if (isAbortError(error)) throw error;
      allRetriesFlagged = false;
      const nextStep = attempt < totalRetries ? 'trying next rung' : 'no rungs remain';
      const message = error instanceof Error ? error.message : String(error);
      log(
        `[transcript-quality] ${input.label}: retry ${attempt}/${totalRetries} failed (${String(
          message,
        ).slice(0, 200)}); ${nextStep}`,
      );
      continue;
    }

    const retryVerdict = await verdictFor(retryText);
    if (!retryVerdict.flagged) {
      const cleanDescription =
        retryVerdict.source === 'judge'
          ? 'judged clean'
          : retryVerdict.source === 'empty'
            ? 'is clean (empty)'
            : 'is clean by analyzer';
      log(
        `[transcript-quality] ${input.label}: retry ${attempt}/${totalRetries} ` +
          `${cleanDescription}; ` +
          'using retry result',
      );
      return {
        text: retryText,
        flagged: false,
        reasons: [],
        retried: true,
        retriesAttempted: attempt,
      };
    }
    log(
      `[transcript-quality] ${input.label}: retry ${attempt}/${totalRetries} still flagged by ` +
        `${retryVerdict.source} (${describe(retryVerdict.report, retryVerdict.source)})`,
    );
  }
  if (input.cleanup && allRetriesFlagged) {
    try {
      const cleanedText = await input.cleanup(input.text);
      if (cleanedText.length > input.text.length) {
        log(
          `[transcript-quality] ${input.label}: cleanup rejected (grew); ` + 'keeping first result',
        );
      } else {
        const cleanedVerdict = await verdictFor(cleanedText);
        if (!cleanedVerdict.flagged) {
          log(
            `[transcript-quality] ${input.label}: cleanup accepted ` +
              `(removed ${input.text.length - cleanedText.length} chars)`,
          );
          return {
            text: cleanedText,
            flagged: false,
            reasons: [],
            retried: true,
            retriesAttempted: totalRetries,
            cleaned: true,
          };
        }
        log(
          `[transcript-quality] ${input.label}: cleanup rejected (still flagged); ` +
            'keeping first result',
        );
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      const message = cappedQualityErrorMessage(error, input.text);
      log(
        `[transcript-quality] ${input.label}: cleanup failed (${message}); ` +
          'keeping first result',
      );
    }
  } else {
    log(
      `[transcript-quality] ${input.label}: all retries exhausted; ` +
        'keeping first result marked uncertain',
    );
  }
  return {
    text: input.text,
    flagged: true,
    reasons: first.reasons,
    retried: true,
    retriesAttempted: totalRetries,
  };
}
