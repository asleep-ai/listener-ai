// Transcript pane with the reversible tail cutoff.
//
// The user picks where the excluded tail begins by selecting (or clicking) in
// the transcript text, or with a sentence slider for keyboard and screen-reader
// use. The change is only a preview until applied; applying regenerates the
// report in main from the included text. The full transcript stays visible,
// with the excluded tail marked in text (not colour alone).
//
// Transcripts have no timestamps, so the UI talks about points in the text,
// never about times in the recording. Notes flagged while recording are
// timed, so the pane says how many of them a cutoff leaves out of the report
// (see `splitNotesAtCutoff`) instead of claiming they are placed.

import {
  type TimedNote,
  type TranscriptCutoff,
  countStopsBefore,
  cutoffStops,
  layoutTranscript,
  snapToWordStart,
  splitNotesAtCutoff,
  validateCutoffOffset,
  type TranscriptPiece,
} from '../../src/transcriptCutoff';
import { escapeHtml } from './markdown-utils';

export interface TranscriptCutoffView {
  /** Full transcript, trimmed exactly as the saved note stores it. */
  transcript: string;
  /** Cutoff currently applied to the saved report. */
  cutoff?: TranscriptCutoff;
  /** A saved cutoff exists but no longer matches the transcript; exports are paused. */
  cutoffMismatch?: boolean;
  /** Notes flagged while recording (raw notes, or the highlights built from them). */
  flaggedNotes?: readonly TimedNote[];
  /** False when the note cannot be changed from here (no saved note linked). */
  editable: boolean;
  /** Called with the new offset, or null to restore the full transcript. */
  onApply: (offset: number | null) => void;
}

let view: TranscriptCutoffView | null = null;
let pane: HTMLElement | null = null;
let stops: number[] = [];
// undefined = no pending change; null = pending removal; number = pending offset.
let pendingOffset: number | null | undefined;
let selectionOffset: number | null = null;
let busy = false;
let message = '';

const EXCERPT_CHARS = 60;

/** Build the transcript pane for a newly shown note. */
export function renderTranscriptPane(target: HTMLElement, next: TranscriptCutoffView): void {
  pane = target;
  view = next;
  stops = cutoffStops(next.transcript);
  pendingOffset = undefined;
  selectionOffset = null;
  busy = false;
  setBodyBusy(false);
  message = next.cutoffMismatch
    ? 'The saved cutoff no longer matches this transcript (it may have changed through sync), so the whole transcript is shown and Notion uploads are paused. Set the cutoff again, or choose "Restore full transcript" to use the whole transcript.'
    : '';

  const canCut = next.editable && stops.length > 0;
  const controls = canCut
    ? `<div class="transcript-cutoff-row">
        <label for="transcriptCutoffRange">Report end point</label>
        <input type="range" id="transcriptCutoffRange" min="1" max="${stops.length}" step="1"
          aria-describedby="transcriptCutoffHelp" />
        <output id="transcriptCutoffRangeValue" for="transcriptCutoffRange"></output>
      </div>
      <div class="transcript-cutoff-actions">
        <button type="button" class="cancel-button" data-cutoff-action="selection">Exclude from selection</button>
        <button type="button" class="save-button" data-cutoff-action="apply">Apply and regenerate report</button>
        <button type="button" class="cancel-button" data-cutoff-action="discard">Discard change</button>
        <button type="button" class="cancel-button" data-cutoff-action="restore">Restore full transcript</button>
      </div>`
    : '';
  const help = canCut
    ? 'To leave the end of the meeting out of the report, select or click in the transcript where the excluded part should start and choose "Exclude from selection", or use the slider. The cutoff is a point in the transcript text, not a time in the recording. Notes you flagged while recording are timed, so they stay in the report only when the transcript shows they came before the cutoff; the others are left out of the report and of exports, but kept with the note. Automatically suggested titles follow the new report; your own title is kept. Nothing is deleted: the audio, the full transcript and your notes are kept, and you can move or remove the cutoff later.'
    : next.cutoff || next.cutoffMismatch
      ? 'The cutoff can be changed when this note is opened from the recordings list.'
      : '';

  target.innerHTML = `
    <button class="copy-button" data-copy-target="transcript">📋 Copy</button>
    <div class="transcript-content" id="transcriptText" tabindex="0" role="region" aria-label="Transcript"></div>
    ${
      canCut || next.cutoff || next.cutoffMismatch
        ? `<section class="transcript-cutoff" aria-labelledby="transcriptCutoffHeading">
        <h3 id="transcriptCutoffHeading" class="transcript-cutoff-heading">Transcript used for the report</h3>
        ${help ? `<p id="transcriptCutoffHelp" class="transcript-cutoff-help">${escapeHtml(help)}</p>` : ''}
        ${controls}
        <p id="transcriptCutoffStatus" class="transcript-cutoff-status" role="status" tabindex="-1"></p>
      </section>`
        : ''
    }`;

  target.querySelector('#transcriptCutoffRange')?.addEventListener('input', onRangeInput);
  target.querySelectorAll<HTMLButtonElement>('[data-cutoff-action]').forEach((button) => {
    button.addEventListener('click', () => onAction(button.dataset.cutoffAction ?? ''));
  });
  refresh({ syncRange: true });
}

/** Show or clear the in-progress state while main regenerates the report. */
export function setTranscriptCutoffBusy(value: boolean, text = ''): void {
  busy = value;
  message = text;
  refresh({ syncRange: false });
  setBodyBusy(value);
}

/**
 * End the in-progress state without touching the status line. Safe to call
 * after the pane was rebuilt for another note: only the modal body's busy
 * flag is reset, and only the cutoff flow sets it.
 */
export function clearTranscriptCutoffBusy(): void {
  busy = false;
  refresh({ syncRange: false });
  setBodyBusy(false);
}

function setBodyBusy(value: boolean): void {
  const body =
    pane?.closest('.transcription-body') ?? document.querySelector('.transcription-body');
  if (value) body?.setAttribute('aria-busy', 'true');
  else body?.removeAttribute('aria-busy');
}

/** How a cutoff at `offset` treats the notes flagged while recording. */
export function describeFlaggedNotes(offset: number | null): string {
  const notes = view?.flaggedNotes ?? [];
  if (!view || notes.length === 0 || offset === null) return '';
  const split = splitNotesAtCutoff(view.transcript, offset, notes);
  const left = split.excluded.length;
  if (left === 0) return ` All ${notes.length} flagged notes stay in the report.`;
  const which = left === notes.length ? `All ${left}` : `${left} of ${notes.length}`;
  return split.cutoffSegment
    ? ` ${which} flagged notes are left out of the report and exports (only notes from before the cut segment stay).`
    : ` ${which} flagged notes are left out of the report and exports, because this transcript has no timing to place them.`;
}

/** Report an outcome (for example a failed apply) in the status line. */
export function showTranscriptCutoffMessage(text: string, focus = false): void {
  message = text;
  refresh({ syncRange: false });
  if (focus) pane?.querySelector<HTMLElement>('#transcriptCutoffStatus')?.focus();
}

/** Move keyboard focus to the status line, e.g. after the pane was rebuilt. */
export function focusTranscriptCutoffStatus(): void {
  pane?.querySelector<HTMLElement>('#transcriptCutoffStatus')?.focus();
}

/**
 * Track where a selection inside the transcript starts. Registered once on
 * `selectionchange`; a click that only places a caret counts too.
 */
export function trackTranscriptSelection(): void {
  const text = pane?.querySelector<HTMLElement>('#transcriptText');
  const selection = window.getSelection();
  if (!view || !text) return;
  if (!selection || selection.rangeCount === 0) {
    selectionOffset = null;
    return;
  }
  const range = selection.getRangeAt(0);
  if (!text.contains(range.startContainer)) {
    // Clicking the action button may move focus before its click handler runs.
    // Preserve the just-selected boundary for that button only.
    if (!document.activeElement?.closest('[data-cutoff-action="selection"]')) {
      selectionOffset = null;
    }
    return;
  }
  selectionOffset = sourceOffsetAt(text, range.startContainer, range.startOffset);
}

/** A pointer action elsewhere invalidates a previous transcript selection. */
export function clearTranscriptSelectionOnPointerDown(event: PointerEvent): void {
  const target = event.target;
  if (!(target instanceof Node)) return;
  const text = pane?.querySelector<HTMLElement>('#transcriptText');
  if (text?.contains(target)) return;
  const element = target instanceof Element ? target : target.parentElement;
  if (element?.closest('[data-cutoff-action="selection"]')) return;
  selectionOffset = null;
}

function onRangeInput(event: Event): void {
  if (!view || busy) return;
  const value = Number((event.target as HTMLInputElement).value);
  const offset = value >= stops.length ? null : stops[value];
  setPending(offset);
  message = '';
  refresh({ syncRange: false });
  scrollToMarker();
}

function onAction(action: string): void {
  if (!view || busy) return;
  if (action === 'selection') {
    if (selectionOffset === null) {
      showTranscriptCutoffMessage(
        'Select or click in the transcript where the excluded part should start, then choose "Exclude from selection".',
      );
      return;
    }
    const offset = snapToWordStart(view.transcript, selectionOffset);
    const error = validateCutoffOffset(view.transcript, offset);
    if (error) {
      showTranscriptCutoffMessage(error);
      return;
    }
    setPending(offset);
    message = '';
    refresh({ syncRange: true });
    scrollToMarker();
    if (pendingOffset !== undefined) focusAction('apply');
  } else if (action === 'discard') {
    pendingOffset = undefined;
    message = 'Change discarded.';
    refresh({ syncRange: true });
    focusAction(view.cutoff ? 'restore' : 'selection');
  } else if (action === 'apply' && pendingOffset !== undefined) {
    view.onApply(pendingOffset);
  } else if (action === 'restore' && (view.cutoff || view.cutoffMismatch)) {
    view.onApply(null);
  }
}

function setPending(offset: number | null): void {
  const applied = view?.cutoff?.offset ?? null;
  pendingOffset = offset === applied ? undefined : offset;
}

function effectiveOffset(): number | null {
  if (pendingOffset !== undefined) return pendingOffset;
  return view?.cutoff?.offset ?? null;
}

function refresh(opts: { syncRange: boolean }): void {
  if (!view || !pane) return;
  const offset = effectiveOffset();
  const pending = pendingOffset !== undefined;

  const text = pane.querySelector<HTMLElement>('#transcriptText');
  if (text) text.innerHTML = renderTranscriptHtml(view.transcript, offset, pending);

  const range = pane.querySelector<HTMLInputElement>('#transcriptCutoffRange');
  if (range) {
    const included = offset === null ? stops.length : countStopsBefore(stops, offset);
    if (opts.syncRange) range.value = String(included);
    range.setAttribute('aria-valuetext', describeRange(included, offset));
    range.disabled = busy || stops.length < 2;
    const output = pane.querySelector<HTMLOutputElement>('#transcriptCutoffRangeValue');
    if (output) output.textContent = `${included} of ${stops.length} positions`;
  }

  const show = (action: string, visible: boolean) => {
    const button = pane?.querySelector<HTMLButtonElement>(`[data-cutoff-action="${action}"]`);
    if (!button) return;
    button.hidden = !visible;
    button.disabled = busy;
  };
  show('selection', true);
  show('apply', pending);
  show('discard', pending);
  show('restore', !pending && !!(view.cutoff || view.cutoffMismatch));

  const status = pane.querySelector<HTMLElement>('#transcriptCutoffStatus');
  if (status) status.textContent = message || describeState(offset, pending);
}

function describeState(offset: number | null, pending: boolean): string {
  if (!view) return '';
  const share =
    offset === null ? 100 : Math.max(1, Math.round((offset / view.transcript.length) * 100));
  if (pending && offset === null) {
    return 'Not applied yet: the report will use the whole transcript and every flagged note. Choose "Apply and regenerate report" to update it.';
  }
  if (pending) {
    return `Not applied yet: the report will use the transcript text before the marker (about ${share}% of the text), and the rest will be left out.${describeFlaggedNotes(offset)} Choose "Apply and regenerate report" to update it.`;
  }
  if (offset !== null) {
    return `The report uses the transcript text before the marker (about ${share}% of the text). The rest of the transcript is left out of the summary and of Notion uploads, but kept in the saved transcript.${describeFlaggedNotes(offset)} Automatically suggested titles follow the new report; your own title is kept.`;
  }
  return 'The report uses the whole transcript.';
}

function describeRange(included: number, offset: number | null): string {
  const total = stops.length;
  if (offset === null || !view) return 'All transcript text used, no cutoff';
  return `End point ${included} of ${total}. Excluded part starts with: ${excerpt(view.transcript.slice(offset))}`;
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS)}...` : flat;
}

function renderTranscriptHtml(transcript: string, offset: number | null, pending: boolean): string {
  const { included, excluded } = layoutTranscript(transcript, offset);
  const pieces = (list: TranscriptPiece[]) =>
    list
      .map((piece) => `<span data-start="${piece.start}">${escapeHtml(piece.text)}</span>`)
      .join('\n');
  if (excluded.length === 0) return pieces(included);
  const marker = pending
    ? 'Proposed cutoff (not applied yet): the transcript text below would be left out of the report'
    : 'Cutoff: the transcript text below is left out of the report and of Notion uploads';
  return `${pieces(included)}<div class="transcript-cutoff-marker${pending ? ' pending' : ''}">${escapeHtml(marker)}</div><div class="transcript-excluded" role="group" aria-label="Excluded from the report">${pieces(excluded)}</div>`;
}

// Map a DOM position inside the transcript text to an offset in the stored
// transcript. Each rendered piece carries its source offset in data-start;
// a position between pieces resolves to the start of the next piece.
function sourceOffsetAt(root: HTMLElement, node: Node, offset: number): number | null {
  const element = node instanceof Element ? node : node.parentElement;
  if (element?.closest('.transcript-cutoff-marker')) return null;
  const pieces = Array.from(root.querySelectorAll<HTMLElement>('[data-start]'));
  const owner =
    node.nodeType === Node.TEXT_NODE
      ? node.parentElement?.closest<HTMLElement>('[data-start]')
      : null;
  if (owner && root.contains(owner)) return Number(owner.dataset.start) + offset;

  const anchor = node.nodeType === Node.TEXT_NODE ? node : (node.childNodes[offset] ?? null);
  const anchorElement = anchor instanceof Element ? anchor : anchor?.parentElement;
  if (anchorElement?.closest('.transcript-cutoff-marker')) return null;
  const next = anchor
    ? pieces.find(
        (piece) =>
          piece === anchor ||
          piece.contains(anchor) ||
          !!(anchor.compareDocumentPosition(piece) & Node.DOCUMENT_POSITION_FOLLOWING),
      )
    : undefined;
  return next ? Number(next.dataset.start) : null;
}

function scrollToMarker(): void {
  pane?.querySelector('.transcript-cutoff-marker')?.scrollIntoView({ block: 'center' });
}

function focusAction(action: string): void {
  pane?.querySelector<HTMLButtonElement>(`[data-cutoff-action="${action}"]`)?.focus();
}
