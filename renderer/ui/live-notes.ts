// In-recording notes panel (Plaud-style highlights). Visible only while
// recording. Holds an append-only list of {offsetMs, text} captured from the
// user; the flag button records the moment with empty text, the text input
// records the moment with the typed text. Notes leave the renderer when
// transcribeAudio forwards them to main at the end of the recording.

import { type LiveNote, state } from '../state';

const NOTE_MAX_TEXT = 2000;
const NOTE_MAX_COUNT = 500;

let panelEl: HTMLElement | null = null;
let listEl: HTMLElement | null = null;
let inputEl: HTMLInputElement | null = null;
let flagButtonEl: HTMLButtonElement | null = null;
let emptyHintEl: HTMLElement | null = null;

function formatTimestamp(offsetMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(offsetMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function currentOffsetMs(): number {
  if (state.recordingStartTime == null) return 0;
  return Math.max(0, Date.now() - state.recordingStartTime);
}

function renderList(): void {
  if (!listEl) return;
  listEl.innerHTML = '';
  for (const note of state.liveNotes) {
    const item = document.createElement('li');
    item.className = 'live-note-item';

    const ts = document.createElement('span');
    ts.className = 'live-note-time';
    ts.textContent = formatTimestamp(note.offsetMs);

    const body = document.createElement('span');
    body.className = 'live-note-text';
    const trimmed = note.text.trim();
    if (trimmed) {
      body.textContent = trimmed;
    } else {
      body.textContent = '🏴';
      body.classList.add('live-note-text--flag');
    }

    item.appendChild(ts);
    item.appendChild(body);
    listEl.appendChild(item);
  }

  if (emptyHintEl) {
    emptyHintEl.style.display = state.liveNotes.length === 0 ? '' : 'none';
  }
}

function appendNote(note: LiveNote): void {
  if (state.liveNotes.length >= NOTE_MAX_COUNT) return;
  state.liveNotes.push(note);
  renderList();
}

function addFlag(): void {
  if (!state.isRecording) return;
  appendNote({ offsetMs: currentOffsetMs(), text: '' });
}

function commitTextInput(): void {
  if (!state.isRecording || !inputEl) return;
  const text = inputEl.value.trim();
  if (!text) return;
  appendNote({ offsetMs: currentOffsetMs(), text: text.slice(0, NOTE_MAX_TEXT) });
  inputEl.value = '';
}

export function showLiveNotesPanel(): void {
  state.liveNotes = [];
  renderList();
  if (panelEl) panelEl.style.display = '';
  if (inputEl) inputEl.value = '';
}

export function hideLiveNotesPanel(): void {
  if (panelEl) panelEl.style.display = 'none';
  if (inputEl) inputEl.value = '';
  state.liveNotes = [];
  renderList();
}

export function setupLiveNotes(): void {
  panelEl = document.getElementById('liveNotesPanel');
  listEl = document.getElementById('liveNotesList');
  inputEl = document.getElementById('liveNoteInput') as HTMLInputElement | null;
  flagButtonEl = document.getElementById('liveNoteFlagButton') as HTMLButtonElement | null;
  emptyHintEl = document.getElementById('liveNotesEmpty');

  if (!panelEl || !listEl || !inputEl || !flagButtonEl) return;

  // Start hidden -- the recorder shows it via showLiveNotesPanel on start.
  panelEl.style.display = 'none';

  flagButtonEl.addEventListener('click', () => {
    addFlag();
  });

  inputEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    // Korean/Japanese/Chinese IMEs use Enter to commit the in-flight
    // composition (e.g. finishing 지금). Acting on Enter mid-composition
    // submits a partial note and double-fires when the IME re-emits Enter
    // after the composition lands. keyCode === 229 covers older WebKit
    // that doesn't set isComposing.
    if (event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    commitTextInput();
  });

  renderList();
}
