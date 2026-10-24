import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import * as path from 'node:path';
import * as vm from 'node:vm';

// Bundle the actual renderer handler with the project's compiler, then supply
// narrow DOM/IPC fixtures. No Electron window or native dialog is opened.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('transcription modal session ownership', () => {
  let code: string;
  let modal: any;
  let elements: Record<string, any>;
  let button: { disabled: boolean; textContent: string };
  let response: ReturnType<typeof deferred<any>>;
  let download: ReturnType<typeof deferred<{ success: boolean }>>;
  let errors: unknown[][];
  let refreshes: number;
  let requests: number;
  let recoveries: number;
  let setupReady: boolean;
  let setupChecks: unknown[];
  let chatScopes: (string | null)[];
  let hintReads: ReturnType<typeof deferred<any>>[];
  let renderedHints: unknown[];
  let renderedHintMessages: unknown[];

  before(async () => {
    const { build } = require('vite');
    const output = await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        write: false,
        minify: false,
        lib: { entry: path.resolve('renderer/ui/transcription-modal.ts'), formats: ['cjs'] },
        rollupOptions: {
          external: (id: string) => !path.isAbsolute(id),
          output: { dynamicImportInCjs: false },
        },
      },
    });
    code = output[0].output.find((chunk: any) => chunk.type === 'chunk').code;
  });

  beforeEach(() => {
    const element = () => ({
      textContent: '',
      innerHTML: '',
      style: {},
      classList: { add() {}, remove() {} },
    });
    elements = Object.fromEntries(
      ['transcriptionTitle', 'all', 'summary', 'progressContainer'].map((key) => [key, element()]),
    );
    elements.transcriptionModal = {
      open: false,
      showModal() {
        this.open = true;
      },
    };
    button = { disabled: false, textContent: 'Transcribe' };
    response = deferred();
    download = deferred();
    errors = [];
    refreshes = 0;
    requests = 0;
    recoveries = 0;
    setupReady = true;
    setupChecks = [];
    chatScopes = [];
    hintReads = [];
    renderedHints = [];
    renderedHintMessages = [];
    const dependencies = {
      getDom: () => ({ progressContainer: elements.progressContainer }),
      resetModalChatFor(folderName: string | null) {
        chatScopes.push(folderName);
      },
      requireAiSetup: async (options: unknown) => {
        setupChecks.push(options);
        return setupReady;
      },
      titleForSavedReport: (title: string) => title,
      structuredToMarkdown: (data: any, tab: string) => data[tab] ?? '',
      renderMarkdown: (value: string) => value,
      renderDynamicFields() {},
      renderRecordingHints(history: unknown, message?: string) {
        renderedHints.push(history);
        renderedHintMessages.push(message);
      },
      refreshRecordingsList: async () => {
        refreshes++;
      },
      showTranscriptionErrorDialog: async (...args: unknown[]) => {
        errors.push(args);
      },
      showFFmpegDownloadDialog: () => {
        recoveries++;
        return download.promise;
      },
    };
    const module = { exports: {} };
    vm.runInNewContext(code, {
      module,
      exports: module.exports,
      require: () => dependencies,
      console: { log() {} },
      document: {
        getElementById: (id: string) => elements[id] ?? null,
        querySelector: (selector: string) =>
          selector.startsWith('[data-filepath=') ? button : null,
        querySelectorAll: () => [],
      },
      window: {
        electronAPI: {
          checkConfig: async () => ({ hasAiAuth: true, hasTranscriptionAuth: true }),
          transcribeAudio: () => {
            requests++;
            return response.promise;
          },
          getConfig: async () => ({}),
          readRecordingLiveHints: () => {
            const pending = deferred<any>();
            hintReads.push(pending);
            return pending.promise;
          },
        },
      },
    });
    modal = module.exports;
  });

  async function start() {
    const pending = modal.handleTranscribe('/recording.wav', 'Pending');
    // Authentication resolves before admission.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(requests, 1);
    return { pending };
  }
  function selectSavedNote() {
    modal.showSavedTranscript(
      '/saved.wav',
      'Saved B',
      { summary: 'Saved B content' },
      'saved-b-folder',
    );
  }
  function assertSavedNote() {
    assert.equal(elements.transcriptionTitle.textContent, 'Transcription - Saved B');
    assert.match(elements.summary.innerHTML, /Saved B content/);
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, 'Transcribe');
    assert.deepEqual(errors, []);
    assert.equal(chatScopes.at(-1), 'saved-b-folder');
  }

  it('does not render an older recording history after selecting another note', async () => {
    modal.showSavedTranscript('/first.wav', 'First', {});
    modal.showSavedTranscript('/second.wav', 'Second', {});
    assert.equal(hintReads.length, 2);
    const history = { version: 1, recordingId: 'second', sessions: [] };
    hintReads[1].resolve({ success: true, liveHints: history });
    await new Promise<void>((resolve) => setImmediate(resolve));
    hintReads[0].resolve({ success: true, liveHints: { recordingId: 'first' } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(renderedHints.at(-1), history);
  });

  it('shows empty hints for a Drive-only note without requesting a local sidecar', async () => {
    modal.showSavedTranscript('', 'Drive note', { summary: 'Remote report' }, 'drive-folder');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(hintReads.length, 0);
    assert.equal(renderedHints.at(-1), undefined);
    assert.equal(renderedHintMessages.at(-1), undefined);
    assert.deepEqual(errors, []);
  });

  it('shows supplied note-only history without a recording path or local sidecar request', () => {
    const liveHints = { version: 1, recordingId: 'missing.wav', sessions: [] };
    modal.showSavedTranscript('', 'Note without audio', {
      summary: 'Saved report',
      transcriptionPath: '/transcriptions/note',
      liveHints,
    });
    assert.equal(renderedHints.at(-1), liveHints);
    assert.equal(hintReads.length, 0);
    assert.equal(renderedHintMessages.at(-1), undefined);
  });

  it('keeps a saved note in loading state until the sidecar resolves to an empty history', async () => {
    modal.showSavedTranscript('/legacy.wav', 'Legacy', {});
    assert.equal(renderedHintMessages.at(-1), 'Loading saved AI hints...');
    assert.equal(hintReads.length, 1);
    const emptyHistory = { version: 1, recordingId: 'legacy', sessions: [] };
    hintReads[0].resolve({ success: true, liveHints: emptyHistory });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(renderedHints.at(-1), emptyHistory);
    assert.equal(renderedHintMessages.at(-1), undefined);
  });

  it('preserves the saved-history load error through later report re-rendering', async () => {
    modal.showSavedTranscript('/broken.wav', 'Broken', {});
    assert.equal(renderedHintMessages.at(-1), 'Loading saved AI hints...');
    hintReads[0].reject(new Error('sidecar read failed'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(renderedHintMessages.at(-1), 'Saved AI hints could not be loaded.');

    modal.populateTranscriptionUI({ summary: 'Report refreshed after cutoff' });
    assert.equal(renderedHintMessages.at(-1), 'Saved AI hints could not be loaded.');
  });

  it('does not update a closed modal when recording history arrives', async () => {
    selectSavedNote();
    const count = renderedHints.length;
    elements.transcriptionModal.open = false;
    hintReads[0].resolve({ success: true, liveHints: { recordingId: 'closed' } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(renderedHints.length, count);
  });

  it('opens saved hints without discarding the associated transcription report', () => {
    const liveHints = { version: 1, recordingId: 'saved', sessions: [] };
    modal.showRecordingHints('/saved.wav', 'Saved', { summary: 'Saved report content', liveHints });
    assert.match(elements.summary.innerHTML, /Saved report content/);
    assert.equal(renderedHints.at(-1), liveHints);
    assert.equal(hintReads.length, 0);
  });

  it('sends nothing when the AI or transcription setup is missing', async () => {
    setupReady = false;
    await modal.handleTranscribe('/recording.wav', 'Pending');
    assert.equal(JSON.stringify(setupChecks), '[{"transcription":true}]');
    assert.equal(requests, 0);
    assert.equal(elements.transcriptionModal.open, false);
  });
  for (const outcome of ['failure', 'cancelled', 'rejection', 'ffmpeg-missing']) {
    it(`ignores stale ${outcome} after selecting a saved note`, async () => {
      const { pending } = await start();
      selectSavedNote();
      if (outcome === 'rejection') response.reject(new Error('IPC disconnected'));
      else
        response.resolve({
          success: false,
          error: 'Old failure',
          cancelled: outcome === 'cancelled',
          code: outcome === 'ffmpeg-missing' ? outcome : undefined,
        });
      // Let an unfixed recovery complete too, so the failing baseline never hangs.
      download.resolve({ success: false });
      await pending;
      assertSavedNote();
      assert.equal(recoveries, 0);
      assert.equal(requests, 1);
    });
  }
  it('does not retry after the session changes during ffmpeg recovery', async () => {
    const { pending } = await start();
    response.resolve({ success: false, code: 'ffmpeg-missing' });
    // Dynamic import and the recovery dialog are asynchronous.
    for (let i = 0; i < 20 && recoveries === 0; i++) await Promise.resolve();
    assert.equal(recoveries, 1);
    selectSavedNote();
    download.resolve({ success: true });
    await pending;
    assertSavedNote();
    assert.equal(requests, 1);
  });
  it('preserves ffmpeg retry for callers without a session predicate', async () => {
    const pending = modal.transcribeWithFfmpegRetry('/recording.wav');
    response.resolve({ success: false, code: 'ffmpeg-missing' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(recoveries, 1);
    response = deferred();
    download.resolve({ success: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(requests, 2);
    const result = { success: true, data: { summary: 'Retry result' } };
    response.resolve(result);
    assert.equal(await pending, result);
  });
  it('ignores a retry rejection after selecting a saved note', async () => {
    const { pending } = await start();
    response.resolve({ success: false, code: 'ffmpeg-missing' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    response = deferred();
    download.resolve({ success: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(requests, 2);
    selectSavedNote();
    response.reject(new Error('Retry disconnected'));
    await pending;
    assertSavedNote();
  });
  it('keeps current-session failure details and ignores cancellation', async () => {
    let pending = (await start()).pending;
    const details = { message: 'Provider failed', code: 'provider' };
    response.resolve({ success: false, error: 'Provider failed', errorDetails: details });
    await pending;
    assert.equal(errors.length, 1);
    assert.equal(errors[0][0], details);
    assert.match(String(errors[0][1]), /Provider failed/);
    errors = [];
    response = deferred();
    pending = modal.handleTranscribe('/other.wav', 'Other');
    await Promise.resolve();
    response.resolve({ success: false, cancelled: true });
    await pending;
    assert.deepEqual(errors, []);
  });
  it('refreshes the list for stale success without replacing the saved note', async () => {
    const { pending } = await start();
    selectSavedNote();
    response.resolve({ success: true, data: { summary: 'Old result' } });
    await pending;
    assertSavedNote();
    assert.equal(refreshes, 1);
  });

  it('scopes Ask to the saved folder once a fresh transcription completes', async () => {
    const { pending } = await start();
    assert.equal(chatScopes.at(-1), null, 'Ask stays unavailable while transcribing');
    response.resolve({
      success: true,
      data: { summary: 'Fresh result' },
      transcriptionPath: '/data/transcriptions/2025-07-10T01-34-07-679Z_Fresh',
      folderName: '2025-07-10T01-34-07-679Z_Fresh',
      generationId: 'gen-1',
    });
    await pending;
    assert.match(elements.summary.innerHTML, /Fresh result/);
    assert.equal(chatScopes.at(-1), '2025-07-10T01-34-07-679Z_Fresh');
  });
  it('keeps Ask unavailable when a fresh transcription was not saved', async () => {
    const { pending } = await start();
    response.resolve({ success: true, data: { summary: 'Unsaved result' } });
    await pending;
    assert.match(elements.summary.innerHTML, /Unsaved result/);
    assert.equal(chatScopes.at(-1), null);
  });
  it('does not let a stale success take over Ask for the saved note', async () => {
    const { pending } = await start();
    selectSavedNote();
    response.resolve({
      success: true,
      data: { summary: 'Old result' },
      transcriptionPath: '/data/transcriptions/old-folder',
      folderName: 'old-folder',
    });
    await pending;
    assertSavedNote();
    assert.ok(!chatScopes.includes('old-folder'));
  });
  it('scopes Ask to the merged note when the merge result is shown', () => {
    modal.prepareTranscriptionModal('Merging - M', 'Preparing merge...', undefined, {
      kind: 'merge',
    });
    assert.equal(chatScopes.at(-1), null);
    modal._setCurrentTranscription({
      transcriptionData: { summary: 'Merged' },
      title: 'M',
      filePath: '/recordings/merged.webm',
      transcriptionPath: '/data/transcriptions/merged-folder',
      generationId: 'gen-m',
      folderName: 'merged-folder',
    });
    assert.equal(chatScopes.at(-1), 'merged-folder');
    modal._setCurrentTranscription({
      transcriptionData: { summary: 'Unsaved' },
      title: 'M',
      filePath: null,
      folderName: undefined,
    });
    assert.equal(chatScopes.at(-1), null);
  });
});
