// Reversible transcript tail cutoff.
//
// A saved note can mark a point in its transcript text after which the rest is
// left out of the report: the summary, key points, action items and highlights
// are regenerated from the text before the point, and exports (Notion) carry
// only that portion. transcript.md and the audio are never modified, so
// removing the cutoff restores the full transcript.
//
// Transcripts carry no reliable per-line timestamps, so the boundary is a
// character offset into the stored transcript text, not a time. It is stored
// additively in meta.json as `transcriptCutoff`; an absent (or no longer
// matching) value means the full transcript is used.
//
// This module is pure (no Node or DOM imports) so the renderer, main and CLI
// share one definition of where the included text ends.

export interface TranscriptCutoff {
  /** Offset into the trimmed transcript text where the excluded tail begins. */
  offset: number;
  /** Length of the transcript the offset was chosen against. */
  transcriptLength: number;
  /** Fingerprint of that transcript; a mismatch means the cutoff no longer applies. */
  transcriptHash: string;
  /** ISO 8601 time the cutoff was applied. */
  appliedAt: string;
}

/** FNV-1a (32-bit) over UTF-16 code units. A change detector, not a security hash. */
export function fingerprintTranscript(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Why `offset` cannot be a cutoff for `transcript`, or null when it can. */
export function validateCutoffOffset(transcript: string, offset: number): string | null {
  if (!Number.isInteger(offset) || offset <= 0 || offset >= transcript.length) {
    return 'The cutoff point is outside the transcript.';
  }
  if (transcript.slice(0, offset).trim().length === 0) {
    return 'The cutoff would leave no transcript text to summarize.';
  }
  if (transcript.slice(offset).trim().length === 0) {
    return 'There is no transcript text after the cutoff point.';
  }
  return null;
}

/** Build a cutoff for `transcript` at `offset`. Throws when the offset is invalid. */
export function createTranscriptCutoff(
  transcript: string,
  offset: number,
  now: Date = new Date(),
): TranscriptCutoff {
  const error = validateCutoffOffset(transcript, offset);
  if (error) throw new Error(error);
  return {
    offset,
    transcriptLength: transcript.length,
    transcriptHash: fingerprintTranscript(transcript),
    appliedAt: now.toISOString(),
  };
}

/** Structural parse of a stored cutoff. Does not check it against a transcript. */
export function parseTranscriptCutoff(raw: unknown): TranscriptCutoff | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (
    !Number.isInteger(r.offset) ||
    !Number.isInteger(r.transcriptLength) ||
    typeof r.transcriptHash !== 'string' ||
    typeof r.appliedAt !== 'string'
  ) {
    return undefined;
  }
  return {
    offset: r.offset as number,
    transcriptLength: r.transcriptLength as number,
    transcriptHash: r.transcriptHash,
    appliedAt: r.appliedAt,
  };
}

/**
 * The stored cutoff when it still applies to `transcript`, otherwise
 * undefined (full transcript). A transcript that changed since the cutoff was
 * set (for example a re-transcription synced from another device) silently
 * falls back to the full text rather than cutting at a meaningless offset.
 */
export function resolveTranscriptCutoff(
  transcript: string,
  raw: unknown,
): TranscriptCutoff | undefined {
  const cutoff = parseTranscriptCutoff(raw);
  if (!cutoff) return undefined;
  if (
    cutoff.transcriptLength !== transcript.length ||
    cutoff.transcriptHash !== fingerprintTranscript(transcript) ||
    validateCutoffOffset(transcript, cutoff.offset) !== null
  ) {
    return undefined;
  }
  return cutoff;
}

export function splitTranscriptAtCutoff(
  transcript: string,
  cutoff: Pick<TranscriptCutoff, 'offset'> | undefined | null,
): { included: string; excluded: string } {
  if (!cutoff) return { included: transcript, excluded: '' };
  return {
    included: transcript.slice(0, cutoff.offset).trimEnd(),
    excluded: transcript.slice(cutoff.offset),
  };
}

/** The transcript text that reports and exports use: everything before a valid cutoff. */
export function includedTranscript(transcript: string, rawCutoff: unknown): string {
  return splitTranscriptAtCutoff(transcript, resolveTranscriptCutoff(transcript, rawCutoff))
    .included;
}

/** Use a regenerated report title only when the visible title was AI generated. */
export function titleForSavedReport(
  visibleTitle: string,
  previousSuggestedTitle: string | undefined,
  reportTitle: string,
): string {
  if (!previousSuggestedTitle || !reportTitle) return visibleTitle;
  const filenameTitle = previousSuggestedTitle
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .trim();
  return visibleTitle === previousSuggestedTitle || visibleTitle === filenameTitle
    ? reportTitle
    : visibleTitle;
}

/**
 * Move an offset picked from a text selection to the start of the word it
 * falls in, so a cutoff never splits a word. An offset on whitespace moves
 * forward to the next word.
 */
export function snapToWordStart(transcript: string, offset: number): number {
  const i = Math.max(0, Math.min(transcript.length, Math.trunc(offset)));
  let lastWordStart = 0;
  for (const part of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(transcript)) {
    if (!part.isWordLike) continue;
    if (i < part.index + part.segment.length) return part.index;
    lastWordStart = part.index;
  }
  return lastWordStart;
}

/** A displayed run of transcript text and the source offset of its first character. */
export interface TranscriptPiece {
  text: string;
  start: number;
}

/**
 * Lay the transcript out the way the report modal shows it (one trimmed,
 * non-empty line per piece) and split it at `cutoffOffset`. Each piece keeps
 * its source offset so a DOM selection maps back to the stored text.
 */
export function layoutTranscript(
  transcript: string,
  cutoffOffset?: number | null,
): { included: TranscriptPiece[]; excluded: TranscriptPiece[] } {
  const included: TranscriptPiece[] = [];
  const excluded: TranscriptPiece[] = [];
  const cut = cutoffOffset ?? Number.POSITIVE_INFINITY;
  for (const line of trimmedLines(transcript)) {
    const end = line.start + line.text.length;
    if (end <= cut) {
      included.push(line);
    } else if (line.start >= cut) {
      excluded.push(line);
    } else {
      pushTrimmed(included, transcript, line.start, cut);
      pushTrimmed(excluded, transcript, cut, end);
    }
  }
  return { included, excluded };
}

/**
 * Keyboard stops for choosing a cutoff without a pointer: the start of every
 * displayed line and of every sentence inside a line (after . ! ? or their
 * full-width forms followed by whitespace). For a single sentence, use word
 * boundaries so the slider can still set a meaningful cutoff. Sorted source
 * offsets.
 */
export function cutoffStops(transcript: string): number[] {
  const stops: number[] = [];
  for (const line of trimmedLines(transcript)) {
    stops.push(line.start);
    const sentenceEnd = /[.!?\u3002\uFF01\uFF1F]\s+(?=\S)/g;
    let match: RegExpExecArray | null;
    while ((match = sentenceEnd.exec(line.text)) !== null) {
      stops.push(line.start + match.index + match[0].length);
    }
  }
  if (stops.length === 1) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
    for (const part of segmenter.segment(transcript)) {
      if (
        part.isWordLike &&
        part.index > stops[0] &&
        !validateCutoffOffset(transcript, part.index)
      ) {
        stops.push(part.index);
      }
    }
  }
  return stops;
}

/** How many stops lie before `offset` (sentences at least partly included). */
export function countStopsBefore(stops: number[], offset: number): number {
  let count = 0;
  while (count < stops.length && stops[count] < offset) count++;
  return count;
}

/**
 * Apply a payload's own cutoff to its transcript before it leaves the app.
 * Used for export payloads that are not tied to a saved note on disk.
 */
export function withIncludedTranscript<
  T extends { transcript?: unknown; transcriptCutoff?: unknown },
>(data: T): T {
  if (typeof data.transcript !== 'string') return data;
  return { ...data, transcript: includedTranscript(data.transcript, data.transcriptCutoff) };
}

function trimmedLines(transcript: string): TranscriptPiece[] {
  const lines: TranscriptPiece[] = [];
  let lineStart = 0;
  while (lineStart <= transcript.length) {
    const newline = transcript.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? transcript.length : newline;
    pushTrimmed(lines, transcript, lineStart, lineEnd);
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  return lines;
}

function pushTrimmed(
  target: TranscriptPiece[],
  transcript: string,
  from: number,
  to: number,
): void {
  let start = from;
  let end = to;
  while (start < end && /\s/.test(transcript[start])) start++;
  while (end > start && /\s/.test(transcript[end - 1])) end--;
  if (end > start) target.push({ text: transcript.slice(start, end), start });
}

/** A moment flagged during recording: a live note or the highlight built from one. */
export interface TimedNote {
  offsetMs: number;
}

/** A batch segment header found in the transcript text. */
export interface SegmentHeader {
  /** Source offset of the header line. */
  start: number;
  /** 1-based segment number, as the header states it. */
  segment: number;
  /** Nominal start of the segment in seconds, as the header states it. */
  startSeconds: number;
}

// Long recordings are transcribed in segments joined under
// `[Segment N: HH:MM:SS ~ HH:MM:SS]` headers (see geminiService). They are the
// only timing evidence a transcript carries.
const SEGMENT_HEADER = /^\[Segment (\d+): (\d{2,}):(\d{2}):(\d{2}) ~ [0-9:]+\]$/;

/** Segment headers in `transcript`, in source order. Empty for a whole-file transcript. */
export function findSegmentHeaders(transcript: string): SegmentHeader[] {
  const headers: SegmentHeader[] = [];
  for (const line of trimmedLines(transcript)) {
    const match = SEGMENT_HEADER.exec(line.text);
    if (!match) continue;
    headers.push({
      start: line.start,
      segment: Number(match[1]),
      startSeconds: Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4]),
    });
  }
  return headers;
}

export interface NotesSplit<N extends TimedNote> {
  /** Notes the transcript proves were flagged before the cutoff. */
  included: N[];
  /** Notes that may fall in the excluded tail (or cannot be placed at all). */
  excluded: N[];
  /**
   * The segment header the cutoff falls under, when there is one. Its start
   * time is the earliest moment the excluded tail can hold.
   */
  cutoffSegment?: SegmentHeader;
}

/**
 * Decide which flagged notes stay in a report cut at `cutoffOffset`.
 *
 * Notes are timed and the cutoff is a text position, so a note is kept only
 * when the transcript proves it precedes the cutoff: the cutoff falls under
 * a segment header, and the note was flagged before that segment's start
 * time. Everything else is left out, including every note of a whole-file
 * transcript (no headers), rather than guessed into either side. Without a
 * cutoff every note is kept. The notes themselves are never modified.
 */
export function splitNotesAtCutoff<N extends TimedNote>(
  transcript: string,
  cutoffOffset: number | null | undefined,
  notes: readonly N[],
): NotesSplit<N> {
  if (cutoffOffset === null || cutoffOffset === undefined) {
    return { included: [...notes], excluded: [] };
  }
  let cutoffSegment: SegmentHeader | undefined;
  for (const header of findSegmentHeaders(transcript)) {
    if (header.start <= cutoffOffset) cutoffSegment = header;
  }
  const included: N[] = [];
  const excluded: N[] = [];
  for (const note of notes) {
    if (cutoffSegment && note.offsetMs < cutoffSegment.startSeconds * 1000) included.push(note);
    else excluded.push(note);
  }
  return { included, excluded, cutoffSegment };
}

export interface ReportNotes<L extends TimedNote, H extends TimedNote> {
  liveNotes?: L[];
  highlights?: H[];
  /** Flagged notes left out because of the cutoff. */
  excludedCount: number;
  /** True when a cutoff applies but the transcript carries no timing evidence at all. */
  noTimingEvidence: boolean;
}

/**
 * The live notes and highlights a report built at the note's cutoff may show
 * or publish. Both are filtered with `splitNotesAtCutoff`; a stale or absent
 * cutoff keeps everything. `undefined` inputs stay `undefined`.
 */
export function reportNotesAtCutoff<L extends TimedNote, H extends TimedNote>(note: {
  transcript: string;
  transcriptCutoff?: unknown;
  liveNotes?: readonly L[];
  highlights?: readonly H[];
}): ReportNotes<L, H> {
  const cutoff = resolveTranscriptCutoff(note.transcript, note.transcriptCutoff);
  if (!cutoff) {
    return {
      liveNotes: note.liveNotes ? [...note.liveNotes] : undefined,
      highlights: note.highlights ? [...note.highlights] : undefined,
      excludedCount: 0,
      noTimingEvidence: false,
    };
  }
  const liveNotes = note.liveNotes
    ? splitNotesAtCutoff(note.transcript, cutoff.offset, note.liveNotes)
    : undefined;
  const highlights = note.highlights
    ? splitNotesAtCutoff(note.transcript, cutoff.offset, note.highlights)
    : undefined;
  return {
    liveNotes: liveNotes?.included,
    highlights: highlights?.included,
    excludedCount: Math.max(liveNotes?.excluded.length ?? 0, highlights?.excluded.length ?? 0),
    noTimingEvidence: !(liveNotes ?? highlights)?.cutoffSegment,
  };
}

/** Report fields of a saved note, as read back from disk. */
export interface StoredReportFields {
  transcript: string;
  transcriptCutoff?: unknown;
  summary?: string;
  summarySections?: unknown;
  keyPoints?: unknown;
  actionItems?: unknown;
  actionItemGroups?: unknown;
  customFields?: unknown;
  emoji?: string;
  liveNotes?: readonly TimedNote[];
  highlights?: readonly TimedNote[];
}

/**
 * The payload to publish for a saved note: its report exactly as stored, and
 * only the transcript text before its cutoff. Flagged notes and highlights
 * are limited to those the cutoff keeps (`reportNotesAtCutoff`). Fields the
 * renderer sent that the note does not own (for example `cost`) are kept
 * from `base`; so are `liveNotes` when the note stores none. Older uncut
 * recordings can also keep custom fields only in their metadata sidecar, but
 * a cut report must never revive fields its regeneration removed.
 */
export function exportPayloadFromNote<T extends object>(
  base: T,
  note: StoredReportFields,
): T & { transcript: string; summary: string; keyPoints: unknown; actionItems: unknown } {
  const sidecar = base as { liveNotes?: unknown; customFields?: unknown };
  const notes = reportNotesAtCutoff({
    transcript: note.transcript,
    transcriptCutoff: note.transcriptCutoff,
    liveNotes: note.liveNotes ?? timedNotes(sidecar.liveNotes),
    highlights: note.highlights,
  });
  return {
    ...base,
    transcript: includedTranscript(note.transcript, note.transcriptCutoff),
    transcriptCutoff: undefined,
    summary: note.summary ?? '',
    summarySections: note.summarySections,
    keyPoints: note.keyPoints ?? [],
    actionItems: note.actionItems ?? [],
    actionItemGroups: note.actionItemGroups,
    customFields: note.transcriptCutoff
      ? note.customFields
      : (note.customFields ?? sidecar.customFields),
    emoji: note.emoji,
    liveNotes: notes.liveNotes,
    highlights: notes.highlights,
  };
}

function timedNotes(value: unknown): TimedNote[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(
    (item): item is TimedNote =>
      !!item && typeof item === 'object' && Number.isFinite((item as TimedNote).offsetMs),
  );
}
