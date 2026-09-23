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
//   4. Speaker-aware: an alternating exchange between two or more labelled
//      speakers is a conversation, not a decoder loop, so it is exempt from
//      word-block scoring and from the whole-text character-period check.
//      Line-level checks instead compare what each speaker actually said,
//      with the label stripped, and an endless exchange is still caught by
//      the compression metric. This is what keeps a meeting close where two
//      participants trade `네.` for twenty turns unflagged end to end.
//   5. Logs must never contain transcript text -- metrics and reasons only.
//   6. Normalization strips punctuation and symbols, so a flood made of them
//      is invisible to the normalized checks. The within-line run detector
//      therefore reads the raw line and runs regardless of normalized length.

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
// Within-line floods: ONE line holding the same character or token thousands
// of times. Every detector above works on normalized text, which strips
// punctuation and symbols -- a line of `+` x30,000 normalizes to an empty
// string and is invisible to all of them (found in 10 of 102 stored
// transcripts). These thresholds stay far above legitimate repetition:
// laughter (`ㅋㅋㅋㅋㅋㅋㅋㅋ`), ellipses (`......`), `네 네 네 네 네` and
// short chants must never reach them.
const INTRA_LINE_CHAR_RUN_FLAG = 40;
const INTRA_LINE_TOKEN_RUN_FLAG = 15;

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
  /** Longest run of one repeated non-whitespace character inside a line. */
  maxIntraLineCharRun: number;
  /** Longest run of identical consecutive tokens inside a line. */
  maxIntraLineTokenRun: number;
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

// A leading speaker label as it appears in a raw line.
const SPEAKER_LABEL_PREFIX = /^\s*(?:참가자|speaker)\s*\d+\s*[:：]\s*/iu;

// Strip a leading speaker label ("참가자1:", "Speaker 2:") before per-line
// loop and duplicate checks, so the label neither masks a purely periodic
// payload nor holds two speakers' identical sentences apart.
export function stripSpeakerLabel(line: string): string {
  return line.replace(SPEAKER_LABEL_PREFIX, '');
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

// Longest run of consecutive near-identical lines. Lines arrive with their
// speaker label stripped, so one sentence repeated under alternating ids
// ("참가자1: 시청해주셔서 감사합니다." / "참가자2: 시청해주셔서 감사합니다.")
// still reads as a duplicate run -- keeping the labels dragged similarity
// below NEAR_DUPLICATE_SIMILARITY and hid that hallucination shape. Lines
// shorter than MIN_DUPLICATE_LINE_CHARS (normalized) break the run, so real
// short acknowledgements ("네", "맞아요") never accumulate into a flag no
// matter how many turns they span.
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

// A speaker label as it survives normalization ("참가자1:" -> "참가자1").
// Only this joined shape can sit inside a block of period <= 4; the split
// shape ("Speaker 2:" -> "speaker 2") costs three tokens per turn, so an
// alternating exchange written that way never forms a qualifying block.
const SPEAKER_LABEL_TOKEN = /^(?:참가자|speaker)\d+$/u;

// Distinct speaker labels inside one candidate block. Two or more means the
// "loop" is an exchange between real speakers, not a decoder loop: a meeting
// close where two participants trade `네.` for twenty turns tokenizes as
// `참가자1 네 참가자2 네`, a period-4 block that reaches the 4-repeat rule on
// entirely genuine speech (observed in a Soniox whole-file eval).
function distinctSpeakerLabels(words: string[], start: number, period: number): number {
  const labels = new Set<string>();
  for (let i = start; i < start + period; i++) {
    if (SPEAKER_LABEL_TOKEN.test(words[i])) labels.add(words[i]);
  }
  return labels.size;
}

// Distinct speaker labels across the whole text. Labels are read from raw
// lines in the shapes `stripSpeakerLabel` accepts, then reduced to the same
// token shape `SPEAKER_LABEL_TOKEN` matches, so "Speaker 2:" and "참가자2:"
// are counted identically here and inside a candidate word block.
function distinctLineSpeakerLabels(text: string): number {
  const labels = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const match = SPEAKER_LABEL_PREFIX.exec(rawLine);
    if (!match) continue;
    const token = normalizeForComparison(match[0]);
    if (SPEAKER_LABEL_TOKEN.test(token)) labels.add(token);
  }
  return labels.size;
}

// Highest consecutive repeat count of any word block of period 1..4.
// "빨리 빨리 빨리" -> period 1 repeated 3x. A period-4 block repeated 4x is
// the issue's "same normalized 4-gram four consecutive times" criterion.
// Multi-speaker blocks are exempt (see distinctSpeakerLabels); a loop from a
// single speaker ("참가자1 네" x20) still flags.
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
      // An alternating exchange between speakers may neither flag nor drive
      // the reported metric; everything else is scored as before.
      if (distinctSpeakerLabels(words, start, period) < 2) {
        if (
          (period === WORD_BLOCK_MAX_PERIOD && repeats >= NGRAM_FLAG_REPEATS) ||
          (period < WORD_BLOCK_MAX_PERIOD && repeats >= SHORT_BLOCK_FLAG_REPEATS)
        ) {
          flagged = true;
        }
        if (repeats > best.repeats) best = { period, repeats };
      }
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

// Longest run of the same non-whitespace character in one line, counted by
// code point. Whitespace breaks a run. Input is already NFC.
function maxCharRun(line: string): number {
  let best = 0;
  let run = 0;
  let previous = '';
  for (const char of line) {
    if (/\s/u.test(char)) {
      run = 0;
      previous = '';
      continue;
    }
    run = char === previous ? run + 1 : 1;
    previous = char;
    if (run > best) best = run;
  }
  return best;
}

// Longest run of identical consecutive whitespace-separated tokens in one
// line. Matching is exact (no punctuation stripping), so a `요` or `I` flood
// is caught by the raw text it actually carries. Input is already NFC.
function maxTokenRun(line: string): number {
  const tokens = line.split(/\s+/u).filter(Boolean);
  let best = 0;
  let run = 0;
  for (let i = 0; i < tokens.length; i++) {
    run = i > 0 && tokens[i] === tokens[i - 1] ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}

// Per-line flood scan over RAW text (only the speaker label is stripped).
// Deliberately skips normalizeForComparison: the symbol floods this detector
// exists for have zero normalized length.
function intraLineRuns(text: string): { charRun: number; tokenRun: number } {
  let charRun = 0;
  let tokenRun = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripSpeakerLabel(rawLine).normalize('NFC');
    const lineCharRun = maxCharRun(line);
    if (lineCharRun > charRun) charRun = lineCharRun;
    const lineTokenRun = maxTokenRun(line);
    if (lineTokenRun > tokenRun) tokenRun = lineTokenRun;
  }
  return { charRun, tokenRun };
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
    .map((line) => normalizeForComparison(stripSpeakerLabel(line)))
    .filter((line) => line.length > 0);
  const words = normalizeKeepSpaces(text).split(' ').filter(Boolean);

  const duplicateLines = maxConsecutiveDuplicateLines(lines);
  const blockRepeats = maxWordBlockRepeats(words);
  const compressionRatio = textCompressionRatio(normalized);
  // Runs on the raw text, so it still fires when `normalized` is empty or
  // below the compression floor -- the shape a symbol flood always has.
  const intraLine = intraLineRuns(text);

  const reasons: string[] = [];
  if (duplicateLines >= CONSECUTIVE_DUPLICATE_LINE_FLAG) {
    reasons.push('consecutive-duplicate-lines');
  }
  // Cross-line exact periodicity is loop evidence only for a SINGLE speaker.
  // `참가자1: 네.` / `참가자2: 네.` traded at a meeting close concatenates to a
  // perfectly periodic `참가자1네참가자2네...`, which reached this check on
  // entirely genuine speech in a Soniox whole-file eval. Hundreds of
  // alternating turns are still caught by the compression ratio. The per-line
  // check is unaffected: one speaker looping inside their own turn flags.
  const multiSpeaker = distinctLineSpeakerLabels(text) >= 2;
  const charLoop =
    (!multiSpeaker && hasCharPeriodLoop(normalized)) ||
    text
      .split(/\r?\n+/)
      .some((line) => hasCharPeriodLoop(normalizeForComparison(stripSpeakerLabel(line))));
  if (blockRepeats.flagged || charLoop) {
    reasons.push('repeated-ngram-loop');
  }
  if (compressionRatio >= COMPRESSION_FLAG_RATIO) {
    reasons.push('high-text-compression');
  }
  if (
    intraLine.charRun >= INTRA_LINE_CHAR_RUN_FLAG ||
    intraLine.tokenRun >= INTRA_LINE_TOKEN_RUN_FLAG
  ) {
    reasons.push('intra-line-token-flood');
  }

  return {
    flagged: reasons.length > 0,
    reasons,
    metrics: {
      normalizedLength: normalized.length,
      maxConsecutiveDuplicateLines: duplicateLines,
      maxWordBlockRepeats: blockRepeats.repeats,
      textCompressionRatio: compressionRatio,
      maxIntraLineCharRun: intraLine.charRun,
      maxIntraLineTokenRun: intraLine.tokenRun,
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

// Foreign-script insertion (issue #197). A store audit found four transcripts
// plus fragments in a fifth carrying a fluent, fabricated foreign-language
// passage inside a Korean meeting: a Portuguese podcast interview as the
// closing segment, a Portuguese AI-podcast intro, an English racing
// narration, and a run mixing Chinese characters, Japanese katakana and a
// cooking instruction. Every other detector here is repetition-shaped, so
// invented but fluent prose passes all of them and the summary presents it as
// discussion. This measures script composition instead. It is notes-only: it
// never rewrites or removes transcript text, and it reports positions and
// counts, never the text itself.

export interface ScriptMix {
  /** Share of letters written in Hangul, 0 when the text has no letters. */
  hangul: number;
  /** Share of letters written in Latin script. */
  latin: number;
  /** Share of letters in any other script (Han, Kana, Cyrillic, ...). */
  other: number;
  /** Total letter code points counted. */
  letters: number;
}

type ScriptName = 'hangul' | 'latin' | 'other';

const LETTER = /\p{L}/u;
const HANGUL_LETTER = /\p{Script=Hangul}/u;
const LATIN_LETTER = /\p{Script=Latin}/u;

// Thresholds. Deliberately far apart so ordinary code-switching cannot reach
// them: a Korean meeting segment that is 30-50% Latin (product names, English
// jargon, acronyms) keeps a Hangul share well above OUTLIER_MAX_DOMINANT_SHARE
// and never flags. Only a block that has almost none of the recording's
// dominant script qualifies, which is the shape the audit found -- a whole
// segment of fluent Portuguese or Chinese.
//   MIN_SCRIPT_MIX_LETTERS     a block must be long enough for its mix to mean
//                              anything; a one-line English aside is noise.
//   DOMINANT_SCRIPT_MIN_SHARE  the recording must HAVE a dominant script;
//                              a genuinely bilingual meeting has none and is
//                              left alone entirely.
//   OUTLIER_MAX_DOMINANT_SHARE the block must be almost entirely something
//                              else before it counts as an insertion.
const MIN_SCRIPT_MIX_LETTERS = 120;
const DOMINANT_SCRIPT_MIN_SHARE = 0.6;
const OUTLIER_MAX_DOMINANT_SHARE = 0.2;

// Default window size for the whole-file path: a few minutes of speech, large
// enough to be well over MIN_SCRIPT_MIX_LETTERS and small enough that a
// three-minute foreign run is not diluted by the Korean around it.
export const SCRIPT_WINDOW_LETTERS = 1500;

// Letter composition of one block. Speaker labels are stripped first: they are
// Hangul and would pull a short block's mix toward Korean no matter what the
// speech actually is.
export function scriptMix(text: string): ScriptMix {
  let hangul = 0;
  let latin = 0;
  let other = 0;
  for (const line of text.split(/\r?\n/)) {
    for (const char of stripSpeakerLabel(line)) {
      if (!LETTER.test(char)) continue;
      if (HANGUL_LETTER.test(char)) hangul++;
      else if (LATIN_LETTER.test(char)) latin++;
      else other++;
    }
  }
  const letters = hangul + latin + other;
  if (letters === 0) return { hangul: 0, latin: 0, other: 0, letters: 0 };
  return { hangul: hangul / letters, latin: latin / letters, other: other / letters, letters };
}

function dominantScript(mix: ScriptMix): ScriptName | undefined {
  for (const script of ['hangul', 'latin', 'other'] as const) {
    if (mix[script] >= DOMINANT_SCRIPT_MIN_SHARE) return script;
  }
  return undefined;
}

// Blocks whose script composition does not belong to this recording, as
// 0-based indices. Symmetric by construction: an English meeting with one
// Korean-only block flags the same way a Korean meeting with one Portuguese
// block does, because the test is always "almost none of the DOMINANT script".
export function findScriptMixOutliers(blocks: string[]): {
  outliers: number[];
  overall: ScriptMix;
} {
  const overall = scriptMix(blocks.join('\n\n'));
  const dominant = dominantScript(overall);
  if (!dominant) return { outliers: [], overall };
  const outliers: number[] = [];
  blocks.forEach((block, index) => {
    const mix = scriptMix(block);
    if (mix.letters < MIN_SCRIPT_MIX_LETTERS) return;
    if (mix[dominant] <= OUTLIER_MAX_DOMINANT_SHARE) outliers.push(index);
  });
  return { outliers, overall };
}

// Whole-file transcripts have no segment structure, so group consecutive turns
// into windows of roughly `targetLetters` letters and test those instead. A
// turn is never split: the smallest unit anyone can review is one speaker's
// turn, and cutting mid-turn would manufacture a mixed block out of two clean
// ones. Windows exist only for detection -- nothing is ever written back.
export function splitIntoScriptWindows(
  text: string,
  targetLetters = SCRIPT_WINDOW_LETTERS,
): string[] {
  const budget = Math.max(1, Math.floor(targetLetters));
  const windows: string[] = [];
  let current: string[] = [];
  let letters = 0;
  for (const turn of splitTurns(text)) {
    current.push(turn);
    letters += scriptMix(turn).letters;
    if (letters >= budget) {
      windows.push(current.join('\n\n'));
      current = [];
      letters = 0;
    }
  }
  if (current.length > 0) windows.push(current.join('\n\n'));
  return windows;
}

// Silent transcript loss (issue #197). A store audit found 15 of 102
// transcripts holding at least one empty segment -- a time-range header with
// no body -- while the stored summary read as if the whole meeting had been
// captured. The pipeline already knew which stretches produced nothing; this
// turns that knowledge into one plain sentence the user actually sees.
//
// A segment that exhausts its provider retries never reaches here: it throws
// and fails the whole run, because a partial note that looks complete is worse
// than an error. What this covers is a segment that came back empty (the
// [NO_SPEECH] sentinel or EmptyTranscriptionError), one the exhaustion cleanup
// rewrote to nothing, and one dropped because it echoed the prompt.
export type TranscriptLossReason = 'empty' | 'cleaned' | 'prompt-echo';

export interface LostSegment {
  /** 1-based segment number, matching the transcript's segment headers. */
  segment: number;
  /** Nominal segment bounds in seconds, as the headers report them. */
  start: number;
  end: number;
  reason: TranscriptLossReason;
}

// One sentence, plain English, safe to put at the top of a summary. The caller
// supplies the clock formatter so the times match the segment headers exactly.
export function formatTranscriptLossNotice(
  lost: LostSegment[],
  formatTime: (seconds: number) => string,
): string {
  if (lost.length === 0) return '';
  const totalSeconds = lost.reduce(
    (total, segment) => total + Math.max(0, segment.end - segment.start),
    0,
  );
  // Never say "0 minutes": any loss at all is worth a minute of the user's
  // attention, and the segment list carries the exact ranges anyway.
  const minutes = Math.max(1, Math.round(totalSeconds / 60));
  const ranges = lost
    .map(
      (segment) => `${segment.segment} [${formatTime(segment.start)} ~ ${formatTime(segment.end)}]`,
    )
    .join(', ');
  return (
    `${minutes} minute${minutes === 1 ? '' : 's'} of this recording produced no transcript ` +
    `(segments: ${ranges}).`
  );
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

// Speaker-label normalisation (issue #197). A store audit found corrupted
// leading labels in 63 of 102 transcripts -- `참가1:`, `참자2:`, `참참가자1:`,
// `참가자 3:`, `[참가자1]`, `[ 참가자1 ]` -- and runaway id counters reaching
// `참가자147`, where a diarizer gave almost every bare `어.` line a new
// speaker (150 distinct ids in one segment). Owner-grouped action items
// cannot be attributed on that output, so labels are rewritten to one
// canonical shape before the transcript reaches the summary stage. The id
// space is bounded only for the runaway shape itself: a genuinely large
// meeting keeps every id it was given and is merely reported, because
// collapsing its ids would merge real participants. Pure and total: odd input
// is left alone, never thrown on.
export const SPEAKER_ID_CAP = 12;

// A leading Korean speaker label in any of the observed corrupted shapes.
// Groups: 1 open bracket, 2 name, 3 hash, 4 id digits, 5 close bracket,
// 6 colon. English labels ("Speaker 2:", "Participant 5:") are deliberately
// not matched -- they arrive well-formed and renaming them would destroy the
// only speaker information an English meeting carries.
const SPEAKER_LABEL_VARIANT =
  /^[ \t]*(\[[ \t]*)?(참참가자|참가자|참가|참자)[ \t]*(#[ \t]*)?(\d+)[ \t]*(\][ \t]*)?([:：][ \t]*)?/u;

export interface SpeakerLabelStats {
  /** Distinct ids seen in the body, counted BEFORE the cap is applied. */
  distinctIds: number;
  /** Lines whose label text was rewritten by normalisation. */
  normalizedLines: number;
  /** True when more distinct ids appeared than the cap allows. */
  exceededCap: boolean;
  /** True when ids past the cap were collapsed onto the last valid id. */
  capped: boolean;
}

export interface SpeakerLabelNormalization extends SpeakerLabelStats {
  text: string;
}

// Canonical form: `참가자N: `, single ASCII colon and one space. A label with
// nothing after it keeps no trailing space, so a bare label line does not
// gain invisible whitespace on every pass.
function canonicalSpeakerLabel(id: string, rest: string): string {
  return rest.length > 0 ? `참가자${id}: ` : `참가자${id}:`;
}

// The runaway-counter signature: ids that only ever climb, each spent on a
// single line (`참가자100` ... `참가자147`, one bare `어.` apiece). That is a
// diarizer which stopped tracking speakers and started numbering lines. An id
// reused later in the segment is evidence it was still following people, so a
// large meeting -- fifteen participants taking turns -- fails this test and
// keeps its ids however far past the cap it runs.
function isRunawayIdSequence(order: string[], uses: Map<string, number>): boolean {
  for (let i = 0; i < order.length; i++) {
    if ((uses.get(order[i]) ?? 0) > 1) return false;
    if (i > 0 && Number(order[i]) <= Number(order[i - 1])) return false;
  }
  return true;
}

export function normalizeSpeakerLabels(
  body: string,
  options?: { maxDistinctIds?: number },
): SpeakerLabelNormalization {
  const maxDistinctIds = Math.max(1, Math.floor(options?.maxDistinctIds ?? SPEAKER_ID_CAP));
  // Split keeping the separators, so line endings survive the round trip and
  // unlabelled lines come back byte-identical.
  const parts = body.split(/(\r\n|[\n\r])/u);
  const labels = new Map<number, { id: string; rest: string; original: string }>();
  const order: string[] = [];
  const uses = new Map<string, number>();

  for (let i = 0; i < parts.length; i += 2) {
    const match = SPEAKER_LABEL_VARIANT.exec(parts[i]);
    if (!match) continue;
    // A terminator is required: `참가자 3명이 참석했습니다` is a sentence, not
    // a label, and rewriting it would eat the first word of real speech.
    const bracketed = Boolean(match[1]) && Boolean(match[5]);
    if (!bracketed && !match[6]) continue;
    const id = match[4];
    if (!order.includes(id)) order.push(id);
    uses.set(id, (uses.get(id) ?? 0) + 1);
    labels.set(i, { id, rest: parts[i].slice(match[0].length), original: match[0] });
  }

  const exceededCap = order.length > maxDistinctIds;
  const capped = exceededCap && isRunawayIdSequence(order, uses);
  const lastValidId = capped ? order[maxDistinctIds - 1] : undefined;
  let normalizedLines = 0;

  for (const [i, label] of labels) {
    if (label.original !== canonicalSpeakerLabel(label.id, label.rest)) normalizedLines++;
    const id =
      lastValidId !== undefined && order.indexOf(label.id) >= maxDistinctIds
        ? lastValidId
        : label.id;
    parts[i] = canonicalSpeakerLabel(id, label.rest) + label.rest;
  }

  return {
    text: parts.join(''),
    distinctIds: order.length,
    normalizedLines,
    exceededCap,
    capped,
  };
}

// Prompt echo (issue #197). A provider sometimes returns the instructions it
// was given instead of a transcription of the audio: a store audit found one
// segment holding the whole transcription prompt -- positional prefix,
// glossary block (company, product and colleague names) and instruction list
// -- and another holding its preamble sentence. That text reached the
// summary, Notion, the Markdown export and Drive sync. Two provider-
// independent signals:
//   1. Built-in markers that exist regardless of prompt customisation.
//   2. Verbatim lines of the prompt ACTUALLY sent with the call, which also
//      covers a user's custom `--prompt` text and glossary entries.
// Short prompt lines are excluded on purpose: a glossary bullet (`- Foo`) is
// exactly what a legitimate mention of that term looks like in speech.
//
// The gate DELETES an echoed segment, so precision beats recall here. The
// built-in markers come in two strengths:
//   - Distinctive: the positional `[Audio segment N of M]` tag and the long
//     instruction sentences. Nobody says these in a meeting, so one hit is
//     enough on its own.
//   - Generic: short phrases a speaker can plausibly say ("Format
//     requirements: ..."). One of them alone never triggers an echo; it takes
//     two distinct generic markers. A generic marker next to a verbatim
//     prompt line is already covered, since that line is sufficient alone.
const PROMPT_ECHO_REASON = 'prompt-echo';
const MIN_ECHOED_PROMPT_LINE_CHARS = 24;
const MIN_GENERIC_PROMPT_ECHO_MARKERS = 2;
const DISTINCTIVE_PROMPT_ECHO_MARKERS: Array<string | RegExp> = [
  /\[audio segment \d+ of \d+\]/u,
  'the following proper nouns, names, and terms may appear in the audio',
  'please transcribe this audio recording with proper speaker identification',
  'transcribe the speech in this audio exactly as spoken',
];
const GENERIC_PROMPT_ECHO_MARKERS: string[] = [
  'format requirements:',
  'return only the transcription text',
  'return only the transcript text',
];

// Echo comparison form: lowercase NFC with whitespace collapsed to single
// spaces. Punctuation is KEPT (unlike normalizeForComparison) -- the markers
// are instruction sentences whose punctuation is part of the evidence, and a
// line break inside an echoed instruction must still match.
function normalizeForEcho(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

export function detectPromptEcho(
  text: string,
  promptLines?: string[],
): { echoed: boolean; reasons: string[] } {
  const haystack = normalizeForEcho(text);
  if (!haystack) return { echoed: false, reasons: [] };
  for (const marker of DISTINCTIVE_PROMPT_ECHO_MARKERS) {
    if (typeof marker === 'string' ? haystack.includes(marker) : marker.test(haystack)) {
      return { echoed: true, reasons: [PROMPT_ECHO_REASON] };
    }
  }
  const genericHits = GENERIC_PROMPT_ECHO_MARKERS.filter((marker) =>
    haystack.includes(marker),
  ).length;
  if (genericHits >= MIN_GENERIC_PROMPT_ECHO_MARKERS) {
    return { echoed: true, reasons: [PROMPT_ECHO_REASON] };
  }
  for (const line of promptLines ?? []) {
    const needle = normalizeForEcho(line);
    if (needle.length < MIN_ECHOED_PROMPT_LINE_CHARS) continue;
    if (haystack.includes(needle)) {
      return { echoed: true, reasons: [PROMPT_ECHO_REASON] };
    }
  }
  return { echoed: false, reasons: [] };
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
  /**
   * Lines of every prompt this call could echo back (issue #197): the prompt
   * sent with the first attempt plus the retry prompt the ladder uses. Used
   * only by `detectPromptEcho`; omit it to rely on the built-in markers.
   */
  promptLines?: string[];
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
  /**
   * Present only when the gate returned empty text because the result echoed
   * the prompt. Prompt text must never reach a transcript, so this is the one
   * case where the gate deletes rather than marks uncertain.
   */
  dropped?: 'prompt-echo';
}

type QualityVerdictSource = 'judge' | 'analyzer' | 'empty' | 'echo';

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
      source === 'echo'
        ? PROMPT_ECHO_REASON
        : report.reasons.length > 0
          ? report.reasons.join(', ')
          : source === 'judge'
            ? 'judge-loop-verdict'
            : 'no-analyzer-reasons';
    return (
      `${reasons}; normalizedLength=${report.metrics.normalizedLength}, ` +
      `duplicateLines=${report.metrics.maxConsecutiveDuplicateLines}, ` +
      `blockRepeats=${report.metrics.maxWordBlockRepeats}, ` +
      `compression=${report.metrics.textCompressionRatio.toFixed(2)}, ` +
      `intraLineCharRun=${report.metrics.maxIntraLineCharRun}, ` +
      `intraLineTokenRun=${report.metrics.maxIntraLineTokenRun}`
    );
  };
  const verdictFor = async (text: string): Promise<QualityVerdict> => {
    const report = analyzeTranscriptQuality(text);
    if (!text.trim()) {
      return { flagged: false, reasons: [], source: 'empty', report };
    }
    // Prompt echo is decided before the judge: the judge only knows loop
    // shapes, and instruction text is a different defect that no amount of
    // semantic loop judgement would catch.
    const echo = detectPromptEcho(text, input.promptLines);
    if (echo.echoed) {
      return { flagged: true, reasons: echo.reasons, source: 'echo', report };
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

  // The gate never returns text that echoes the prompt: an exhausted ladder
  // drops it instead of keeping it marked uncertain, because instruction text
  // in a transcript is always wrong, never merely suspicious.
  const dropEchoedText = (retried: boolean, retriesAttempted: number): QualityGateResult => {
    log(`[transcript-quality] ${input.label}: prompt echo persisted; dropping segment text`);
    return {
      text: '',
      flagged: true,
      reasons: [PROMPT_ECHO_REASON],
      retried,
      retriesAttempted,
      dropped: PROMPT_ECHO_REASON,
    };
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
    if (first.source === 'echo') return dropEchoedText(false, 0);
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
  // Cleanup is skipped for an echoed first result: rewriting instruction text
  // cannot recover speech that was never transcribed, and the only acceptable
  // output here is no text at all.
  if (first.source === 'echo') return dropEchoedText(true, totalRetries);
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
