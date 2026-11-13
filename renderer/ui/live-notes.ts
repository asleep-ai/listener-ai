// In-recording notes panel (Plaud-style highlights). Visible only while
// recording. The flag button records the moment with empty text, the text
// input records the moment with the typed text. Notes live in main's
// recording state (so a reload keeps them); this panel renders that list and
// main persists it with the recording.

import { type LiveNote, state } from '../state';

const NOTE_MAX_TEXT = 2000;
const NOTE_MAX_COUNT = 500;

let panelEl: HTMLElement | null = null;
let listEl: HTMLElement | null = null;
let inputEl: HTMLInputElement | null = null;
let flagButtonEl: HTMLButtonElement | null = null;
let emptyHintEl: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;
// Main accepts notes only while the recording phase is 'recording'; once it
// is stopping (Stop, tray, shortcut, max duration, quit) the panel stops
// taking them instead of sending notes main would refuse.
let accepting = false;
// A typed note is on its way to main; further Enters wait for its answer
// instead of sending the same text again.
let submitting = false;

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

function setStatus(text: string): void {
  if (statusEl) statusEl.textContent = text;
}

// Resolves true once main recorded the note. A refusal (the recording began
// stopping meanwhile) or a failed request is reported in the panel's status
// line instead of disappearing.
async function appendNote(note: LiveNote): Promise<boolean> {
  if (state.liveNotes.length >= NOTE_MAX_COUNT) {
    setStatus(`Note not added: the limit of ${NOTE_MAX_COUNT} notes was reached.`);
    return false;
  }
  try {
    const result = await window.electronAPI.addRecordingNote(note);
    if (result.success) {
      setStatus('');
      return true;
    }
    setStatus(`Note not added: ${result.error || 'the recording is not taking notes.'}`);
  } catch (error) {
    console.warn('Could not add note:', error);
    setStatus('Note not added: the recording could not be reached.');
  }
  return false;
}

/** Whether the panel takes notes; follows the recording phase from main. */
export function setLiveNotesAccepting(value: boolean): void {
  accepting = value;
  if (inputEl) inputEl.disabled = !value;
  if (flagButtonEl) flagButtonEl.disabled = !value;
}

/** Replaces the rendered notes with main's recording state. */
export function setLiveNotes(notes: LiveNote[]): void {
  state.liveNotes = notes.map((note) => ({ ...note }));
  renderList();
}

function addFlag(): void {
  if (!state.isRecording || !accepting) return;
  void appendNote({ offsetMs: currentOffsetMs(), text: '' });
}

async function commitTextInput(): Promise<void> {
  if (!state.isRecording || !accepting || !inputEl || submitting) return;
  const typed = inputEl.value;
  const text = typed.trim();
  if (!text) return;
  const input = inputEl;
  submitting = true;
  try {
    const added = await appendNote({
      offsetMs: currentOffsetMs(),
      text: text.slice(0, NOTE_MAX_TEXT),
    });
    // Cleared only once main has the note, and only if the field still holds
    // what was sent (typing may have continued meanwhile); otherwise the text
    // stays for the user.
    if (added && input.value === typed) input.value = '';
  } finally {
    submitting = false;
  }
}

export function showLiveNotesPanel(): void {
  // hideLiveNotesPanel (via resetRecordingUI) already clears state.liveNotes
  // when a previous recording ends, so we only render+show here.
  renderList();
  if (panelEl) panelEl.style.display = '';
}

export function hideLiveNotesPanel(): void {
  if (panelEl) panelEl.style.display = 'none';
  if (inputEl) inputEl.value = '';
  setStatus('');
  state.liveNotes = [];
  renderList();
}

export function setupLiveNotes(): void {
  panelEl = document.getElementById('liveNotesPanel');
  listEl = document.getElementById('liveNotesList');
  inputEl = document.getElementById('liveNoteInput') as HTMLInputElement | null;
  flagButtonEl = document.getElementById('liveNoteFlagButton') as HTMLButtonElement | null;
  emptyHintEl = document.getElementById('liveNotesEmpty');
  statusEl = document.getElementById('liveNotesStatus');

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
    void commitTextInput();
  });

  renderList();
}
