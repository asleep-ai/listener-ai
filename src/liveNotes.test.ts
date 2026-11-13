// The in-recording notes panel (renderer/ui/live-notes.ts), bundled and run
// against a minimal DOM. Main accepts notes only while recording; the panel
// must stop offering them once the recording is stopping, and a note main
// refuses (or a failed request) must keep the typed text and say so.

import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import * as path from 'path';
import * as vm from 'vm';

type Listener = (event: any) => void;

function element() {
  const listeners: Record<string, Listener> = {};
  return {
    value: '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    style: {} as Record<string, string>,
    classList: { add() {} },
    appendChild() {},
    listeners,
    addEventListener(type: string, fn: Listener) {
      listeners[type] = fn;
    },
  };
}

describe('live notes panel', () => {
  let code: string;
  let notes: ReturnType<typeof load>;
  let elements: Record<string, ReturnType<typeof element>>;
  let sent: Array<{ text: string }>;
  let reply: () => Promise<any>;

  before(async () => {
    const { build } = require('vite');
    const output = await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        write: false,
        minify: false,
        lib: { entry: path.resolve('renderer/ui/live-notes.ts'), formats: ['cjs'] },
        rollupOptions: { external: (id: string) => !path.isAbsolute(id) },
      },
    });
    code = output[0].output.find((chunk: any) => chunk.type === 'chunk').code;
  });

  function load() {
    const module = { exports: {} as any };
    vm.runInNewContext(code, {
      module,
      exports: module.exports,
      require: () => ({
        state: { isRecording: true, recordingStartTime: Date.now(), liveNotes: [] },
      }),
      console: { warn() {} },
      Date,
      document: {
        getElementById: (id: string) => elements[id] ?? null,
        createElement: () => element(),
      },
      window: {
        electronAPI: {
          addRecordingNote: (note: { text: string }) => {
            sent.push(note);
            return reply();
          },
        },
      },
    });
    return module.exports as {
      setupLiveNotes(): void;
      setLiveNotesAccepting(value: boolean): void;
      showLiveNotesPanel(): void;
    };
  }

  beforeEach(() => {
    elements = Object.fromEntries(
      [
        'liveNotesPanel',
        'liveNotesList',
        'liveNoteInput',
        'liveNoteFlagButton',
        'liveNotesEmpty',
        'liveNotesStatus',
      ].map((id) => [id, element()]),
    );
    sent = [];
    reply = async () => ({ success: true });
    notes = load();
    notes.setupLiveNotes();
    notes.showLiveNotesPanel();
  });

  const enter = async (text: string) => {
    elements.liveNoteInput.value = text;
    elements.liveNoteInput.listeners.keydown({
      key: 'Enter',
      isComposing: false,
      keyCode: 13,
      preventDefault() {},
    });
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  };

  it('stops taking notes once the recording is stopping, keeping what was typed', async () => {
    notes.setLiveNotesAccepting(true);
    notes.setLiveNotesAccepting(false); // the 'stopping' snapshot
    assert.equal(elements.liveNoteInput.disabled, true);
    assert.equal(elements.liveNoteFlagButton.disabled, true);
    await enter('Typed while stopping');
    assert.deepEqual(sent, [], 'nothing sent that main would refuse');
    assert.equal(elements.liveNoteInput.value, 'Typed while stopping');
    elements.liveNoteFlagButton.listeners.click({});
    assert.deepEqual(sent, []);
  });

  it('keeps the text and says so when main refuses a note sent as the stop began', async () => {
    notes.setLiveNotesAccepting(true);
    reply = async () => ({ success: false, error: 'Not recording' });
    await enter('Decision: ship it');
    assert.deepEqual(
      sent.map((n) => n.text),
      ['Decision: ship it'],
    );
    assert.equal(elements.liveNoteInput.value, 'Decision: ship it', 'not cleared');
    assert.equal(elements.liveNotesStatus.textContent, 'Note not added: Not recording');
  });

  it('keeps the text and says so when the request fails', async () => {
    notes.setLiveNotesAccepting(true);
    reply = async () => {
      throw new Error('IPC gone');
    };
    await enter('Follow up with legal');
    assert.equal(elements.liveNoteInput.value, 'Follow up with legal');
    assert.match(elements.liveNotesStatus.textContent, /^Note not added/);
  });

  it('clears the field once main recorded the note, and ignores Enter mid-composition', async () => {
    notes.setLiveNotesAccepting(true);
    elements.liveNoteInput.value = '지금';
    elements.liveNoteInput.listeners.keydown({
      key: 'Enter',
      isComposing: true,
      keyCode: 229,
      preventDefault() {},
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 0, 'IME composition guard kept');
    await enter('Recorded note');
    assert.deepEqual(
      sent.map((n) => n.text),
      ['Recorded note'],
    );
    assert.equal(elements.liveNoteInput.value, '');
    assert.equal(elements.liveNotesStatus.textContent, '');
  });

  it('sends a note once while its first Enter awaits main, then takes notes again after a failure', async () => {
    notes.setLiveNotesAccepting(true);
    let answer!: (value: any) => void;
    reply = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    await enter('Action: send the deck');
    await enter('Action: send the deck'); // a second Enter before main answered
    assert.deepEqual(
      sent.map((n) => n.text),
      ['Action: send the deck'],
      'one request, no duplicate note',
    );
    elements.liveNoteInput.value = 'Action: send the deck to Mina'; // typing went on
    answer({ success: false, error: 'Not recording' });
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(elements.liveNoteInput.value, 'Action: send the deck to Mina');
    assert.match(elements.liveNotesStatus.textContent, /^Note not added/);
    // The failed submission does not block the next one.
    reply = async () => ({ success: true });
    await enter('Action: send the deck to Mina');
    assert.deepEqual(
      sent.map((n) => n.text),
      ['Action: send the deck', 'Action: send the deck to Mina'],
    );
    assert.equal(elements.liveNoteInput.value, '');
  });
});
