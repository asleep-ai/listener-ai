import * as fs from 'fs';
import assert from 'node:assert/strict';
import { after, afterEach, describe, it } from 'node:test';
import * as os from 'os';
import * as path from 'path';
import {
  RecordingController,
  decideAutoModeSkip,
  type RecordingControllerDeps,
} from './recordingController';
import type { RecordingNote, RecordingStateSnapshot } from './recordingState';
import { SimpleAudioRecorder } from './simpleAudioRecorder';

type HostCall = { type: string; sessionId?: number; deviceId?: string };

function harness(
  overrides: Partial<RecordingControllerDeps> = {},
  opts: {
    autoMode?: boolean;
    minSeconds?: number;
    credentialIssue?: string | null;
    quitting?: boolean;
    autoRunning?: boolean;
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-controller-'));
  const recorder = new SimpleAudioRecorder(dir);
  const calls: HostCall[] = [];
  const emitted: RecordingStateSnapshot[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const savedNotes: Array<{ filePath: string; notes: RecordingNote[] }> = [];
  const autoStarts: Array<{ filePath: string; title: string; notes: RecordingNote[] }> = [];
  let finalizeCount = 0;
  let disposeCount = 0;
  let clock = 1_000_000;
  const state = {
    quitting: opts.quitting ?? false,
    autoMode: opts.autoMode ?? false,
    minSeconds: opts.minSeconds ?? 0,
    credentialIssue: opts.credentialIssue ?? null,
    autoRunning: opts.autoRunning ?? false,
  };
  const deps: RecordingControllerDeps = {
    host: {
      start: async (command) => {
        calls.push({ type: 'start', sessionId: command.sessionId, deviceId: command.deviceId });
      },
      stop: (sessionId) => {
        calls.push({ type: 'stop', sessionId });
      },
      switchMic: (sessionId, deviceId) => {
        calls.push({ type: 'switch-mic', sessionId, deviceId });
      },
      dispose: () => {
        disposeCount++;
      },
    },
    recorder,
    finalizeFile: async (liveDrain, onClosed) => {
      finalizeCount++;
      const result = await recorder.stopRecording();
      if (result.filePath) await onClosed?.(result.filePath);
      await liveDrain;
      return result;
    },
    saveNotes: async (filePath, notes) => {
      savedNotes.push({ filePath, notes });
    },
    captureSettings: () => ({ deviceId: 'mic-1', recordSystemAudio: false }),
    autoMode: {
      enabled: () => state.autoMode,
      minSeconds: () => state.minSeconds,
      credentialIssue: () => state.credentialIssue,
      start: async (input) => {
        autoStarts.push(input);
        return 'job-42';
      },
      isRunning: () => state.autoRunning,
    },
    isQuitting: () => state.quitting,
    emit: (snapshot) => emitted.push(snapshot),
    now: () => clock,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
    ...overrides,
  };
  const controller = new RecordingController(deps);
  return {
    controller,
    recorder,
    dir,
    calls,
    emitted,
    timers,
    savedNotes,
    autoStarts,
    state,
    advance: (ms: number) => {
      clock += ms;
    },
    get finalizeCount() {
      return finalizeCount;
    },
    get disposeCount() {
      return disposeCount;
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// Drives the host side of a start: the host opens the file, then reports started.
async function startRecording(h: ReturnType<typeof harness>, title = 'Weekly sync') {
  const started = h.controller.requestStart({ title });
  const sessionId = h.calls.at(-1)!.sessionId!;
  const opened = await h.controller.hostOpen(sessionId, 'audio/webm;codecs=opus');
  assert.equal(opened.success, true);
  h.controller.hostEvent({ type: 'started', sessionId });
  assert.deepEqual(await started, { success: true });
  return sessionId;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('RecordingController', () => {
  let h: ReturnType<typeof harness>;
  afterEach(() => h?.cleanup());

  it('moves through starting, recording, stopping and idle with increasing revisions', async () => {
    h = harness();
    const sessionId = await startRecording(h);
    const snapshot = h.controller.snapshot();
    assert.equal(snapshot.phase, 'recording');
    assert.equal(snapshot.title, 'Weekly sync');
    assert.ok(snapshot.filePath && fs.existsSync(snapshot.filePath));
    assert.equal(typeof snapshot.startedAt, 'number');
    h.recorder.appendChunk(Buffer.from([1, 2, 3]));

    const stopped = h.controller.requestStop('user');
    assert.equal(h.controller.snapshot().phase, 'stopping');
    assert.equal(h.controller.snapshot().stopReason, 'user');
    assert.deepEqual(h.calls.at(-1), { type: 'stop', sessionId });
    h.controller.hostEvent({ type: 'stopped', sessionId });
    const result = await stopped;
    assert.equal(result?.success, true);
    assert.equal(result?.stopReason, 'user');
    assert.deepEqual(result?.autoMode, { status: 'off' });

    const phases = h.emitted.map((s) => s.phase);
    assert.deepEqual(phases, ['starting', 'recording', 'stopping', 'idle']);
    const revisions = h.emitted.map((s) => s.revision);
    assert.deepEqual(
      revisions,
      [...revisions].sort((a, b) => a - b),
    );
    assert.equal(new Set(revisions).size, revisions.length);
    const idle = h.controller.snapshot();
    assert.equal(idle.phase, 'idle');
    assert.equal(idle.lastResult?.filePath, snapshot.filePath);
    assert.equal(idle.lastResult?.id, idle.revision);
    assert.ok(h.timers[0].cleared, 'grace timer is cleared after the host stops');
    assert.equal(h.disposeCount, 0, 'a host that stopped cleanly stays loaded');
  });

  it('force-finalizes the partial file when the host never reports stopped', async () => {
    h = harness();
    await startRecording(h);
    h.recorder.appendChunk(Buffer.from([1, 2, 3, 4]));
    const stopped = h.controller.requestStop('tray', { graceMs: 2_500 });
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0].ms, 2_500);
    await flush();
    assert.equal(h.controller.snapshot().phase, 'stopping', 'still waiting for the host');
    h.timers[0].fn();
    const result = await stopped;
    assert.equal(result?.success, true);
    assert.equal(result?.stopReason, 'tray');
    assert.equal(fs.statSync(result!.filePath!).size, 4);
    assert.equal(h.controller.snapshot().phase, 'idle');
    assert.equal(h.finalizeCount, 1);
    assert.equal(h.disposeCount, 1, 'a hung host is destroyed so it cannot keep the mic');
  });

  it('finalizes cleanly when the host is lost mid-recording and records the error', async () => {
    h = harness();
    await startRecording(h);
    h.recorder.appendChunk(Buffer.from([7, 7]));
    const result = await h.controller.hostLost('Capture renderer crashed');
    assert.equal(result?.success, true);
    assert.equal(result?.stopReason, 'host-lost');
    const snapshot = h.controller.snapshot();
    assert.equal(snapshot.phase, 'idle');
    assert.equal(snapshot.lastError?.code, 'host-lost');
    assert.equal(snapshot.lastResult?.filePath, result?.filePath);
    assert.equal(h.finalizeCount, 1);
  });

  it('aborts the opened file when the host is lost while starting', async () => {
    h = harness();
    const started = h.controller.requestStart({ title: 'x' });
    const sessionId = h.calls.at(-1)!.sessionId!;
    await h.controller.hostOpen(sessionId, 'audio/webm');
    const filePath = h.recorder.getActiveRecording()!.filePath;
    await h.controller.hostLost();
    assert.deepEqual((await started).code, 'host-lost');
    await flush();
    assert.equal(fs.existsSync(filePath), false);
    assert.equal(h.controller.snapshot().phase, 'idle');
    assert.equal(h.finalizeCount, 0);
  });

  it('reports host capture errors during start as lastError codes', async () => {
    h = harness();
    const started = h.controller.requestStart({});
    const sessionId = h.calls.at(-1)!.sessionId!;
    h.controller.hostEvent({
      type: 'error',
      sessionId,
      code: 'permission-denied',
      message: 'denied',
    });
    assert.deepEqual(await started, { success: false, code: 'permission-denied', error: 'denied' });
    assert.equal(h.controller.snapshot().lastError?.code, 'permission-denied');
    assert.equal(h.recorder.isRecording(), false);
  });

  it('ignores duplicate starts and stops: one host start, one finalize', async () => {
    h = harness();
    const first = h.controller.requestStart({ title: 'a' });
    const second = h.controller.requestStart({ title: 'b' });
    assert.equal(first, second, 'a start during starting joins the pending start');
    assert.equal(h.calls.filter((c) => c.type === 'start').length, 1);
    const sessionId = h.calls[0].sessionId!;
    await h.controller.hostOpen(sessionId, 'audio/webm');
    assert.equal((await h.controller.hostOpen(sessionId, 'audio/webm')).success, false);
    h.controller.hostEvent({ type: 'started', sessionId });
    h.controller.hostEvent({ type: 'started', sessionId });
    await first;
    assert.equal((await h.controller.requestStart({})).code, 'busy');
    h.recorder.appendChunk(Buffer.from([1]));

    const stopA = h.controller.requestStop('user');
    const stopB = h.controller.requestStop('shortcut');
    assert.equal(stopA, stopB);
    assert.equal(h.calls.filter((c) => c.type === 'stop').length, 1);
    h.controller.hostEvent({ type: 'stopped', sessionId });
    h.controller.hostEvent({ type: 'stopped', sessionId });
    await h.controller.hostLost();
    h.timers[0].fn();
    const result = await stopA;
    assert.equal(result?.stopReason, 'user');
    assert.equal(h.finalizeCount, 1);
    assert.equal(h.emitted.filter((s) => s.phase === 'idle').length, 1);
    assert.equal(await h.controller.requestStop('user'), null);
  });

  it('ignores events from an older session', async () => {
    h = harness();
    const sessionId = await startRecording(h);
    h.controller.hostEvent({ type: 'stopped', sessionId: sessionId + 99 });
    assert.equal(h.controller.snapshot().phase, 'recording');
  });

  it('keeps notes in state and hands them to persistence and auto mode', async () => {
    h = harness({}, { autoMode: true });
    const sessionId = await startRecording(h, 'Planning');
    h.advance(5_000);
    assert.equal(h.controller.addNote({ text: '  decision  ' }).success, true);
    assert.equal(h.controller.addNote({ text: '', offsetMs: 1_200 }).success, true);
    assert.equal(h.controller.addNote({ text: 'future', offsetMs: 99_000 }).success, true);
    assert.deepEqual(h.controller.snapshot().notes, [
      { offsetMs: 5_000, text: 'decision' },
      { offsetMs: 1_200, text: '' },
      { offsetMs: 5_000, text: 'future' },
    ]);
    h.recorder.appendChunk(Buffer.from([1, 2]));
    const stopped = h.controller.requestStop('user');
    h.controller.hostEvent({ type: 'stopped', sessionId });
    const result = await stopped;
    assert.equal(h.savedNotes.length, 1);
    assert.equal(h.savedNotes[0].filePath, result?.filePath);
    assert.equal(h.savedNotes[0].notes.length, 3);
    assert.equal(h.autoStarts[0].notes.length, 3);
    assert.equal(h.autoStarts[0].title, 'Planning');
    assert.deepEqual(h.controller.snapshot().notes, []);
    assert.equal(h.controller.addNote({ text: 'late' }).success, false);
  });

  describe('auto mode after finalize', () => {
    async function runOnce(
      opts: Parameters<typeof harness>[1],
      stopOpts: { reason?: 'user' | 'quit'; autoMode?: boolean; durationMs?: number } = {},
    ) {
      h = harness({}, opts);
      const sessionId = await startRecording(h);
      h.recorder.appendChunk(Buffer.from([1, 2, 3]));
      const stopped = h.controller.requestStop(stopOpts.reason ?? 'user', {
        autoMode: stopOpts.autoMode,
      });
      h.controller.hostEvent({ type: 'stopped', sessionId });
      return stopped;
    }

    it('is off when the setting is off', async () => {
      assert.deepEqual((await runOnce({ autoMode: false }))?.autoMode, { status: 'off' });
      assert.equal(h.autoStarts.length, 0);
    });

    it('skips below the minimum length with the existing message', async () => {
      const result = await runOnce({ autoMode: true, minSeconds: 3600 });
      assert.equal(result?.autoMode.status, 'skipped');
      assert.match(
        (result!.autoMode as { message: string }).message,
        /^Auto mode: Skipped \(\d+s < 3600s minimum\)$/,
      );
      assert.equal(h.autoStarts.length, 0);
    });

    it('skips with the credential message when a gate fails', async () => {
      const message =
        'Auto mode: Skipped -- configure your AI provider in Settings. The recording was saved.';
      const result = await runOnce({ autoMode: true, credentialIssue: message });
      assert.deepEqual(result?.autoMode, { status: 'skipped', message });
      assert.equal(h.autoStarts.length, 0);
    });

    it('starts the job and records its id', async () => {
      const result = await runOnce({ autoMode: true });
      assert.deepEqual(result?.autoMode, { status: 'started', jobId: 'job-42' });
      assert.equal(h.autoStarts.length, 1);
      assert.equal(h.autoStarts[0].filePath, result?.filePath);
      assert.deepEqual(h.controller.snapshot().lastResult?.autoMode, {
        status: 'started',
        jobId: 'job-42',
      });
    });

    it('never starts while quitting or for a quit stop', async () => {
      h = harness({}, { autoMode: true });
      const sessionId = await startRecording(h);
      h.recorder.appendChunk(Buffer.from([1]));
      h.state.quitting = true;
      const stopped = h.controller.requestStop('user');
      h.controller.hostEvent({ type: 'stopped', sessionId });
      assert.deepEqual((await stopped)?.autoMode, { status: 'off' });
      assert.equal(h.autoStarts.length, 0);
      h.cleanup();
      assert.deepEqual(
        (await runOnce({ autoMode: true }, { reason: 'quit', autoMode: false }))?.autoMode,
        {
          status: 'off',
        },
      );
      assert.equal(h.autoStarts.length, 0);
    });

    it('reports a failed admission without failing the recording', async () => {
      h = harness(
        {
          autoMode: {
            enabled: () => true,
            minSeconds: () => 0,
            credentialIssue: () => null,
            start: async () => {
              throw new Error('ffmpeg missing');
            },
            isRunning: () => false,
          },
        },
        {},
      );
      const sessionId = await startRecording(h);
      h.recorder.appendChunk(Buffer.from([1]));
      const stopped = h.controller.requestStop('user');
      h.controller.hostEvent({ type: 'stopped', sessionId });
      const result = await stopped;
      assert.equal(result?.success, true);
      assert.deepEqual(result?.autoMode, {
        status: 'failed',
        message: 'Auto mode: ffmpeg missing',
      });
    });

    it('decision helper ignores failed or empty recordings', () => {
      const base = {
        enabled: true,
        quitting: false,
        allowed: true,
        minSeconds: 0,
        credentialIssue: null,
      };
      assert.deepEqual(decideAutoModeSkip({ ...base, success: false }), { status: 'off' });
      assert.deepEqual(decideAutoModeSkip({ ...base, success: true }), { status: 'off' });
      assert.equal(
        decideAutoModeSkip({ ...base, success: true, filePath: '/a.webm', durationMs: 1 }),
        'start',
      );
    });
  });

  it('refuses a start while an auto job runs or the app quits', async () => {
    h = harness({}, { autoRunning: true });
    assert.equal((await h.controller.requestStart({})).code, 'auto-mode-busy');
    h.state.autoRunning = false;
    h.state.quitting = true;
    assert.equal((await h.controller.requestStart({})).code, 'quitting');
    assert.equal(h.calls.length, 0);
  });

  it('cancels a pending start when a stop arrives first', async () => {
    h = harness();
    const started = h.controller.requestStart({});
    assert.equal(await h.controller.requestStop('tray'), null);
    assert.equal((await started).code, 'cancelled');
    const sessionId = h.calls[0].sessionId!;
    assert.equal((await h.controller.hostOpen(sessionId, 'audio/webm')).success, false);
    assert.equal(h.recorder.isRecording(), false);
  });

  it('keeps the file and records the error when capture fails mid-recording', async () => {
    h = harness({}, { autoMode: true });
    const sessionId = await startRecording(h);
    h.recorder.appendChunk(Buffer.from([1, 2]));
    h.controller.hostEvent({
      type: 'error',
      sessionId,
      code: 'recorder-error',
      message: 'Recording failed: boom',
    });
    // A stop request during that finalize joins it instead of starting another.
    await h.controller.requestStop('user');
    assert.equal(h.finalizeCount, 1);
    const snapshot = h.controller.snapshot();
    assert.equal(snapshot.phase, 'idle');
    assert.equal(snapshot.lastError?.code, 'recorder-error');
    assert.equal(snapshot.lastResult?.success, true);
    assert.equal(snapshot.lastResult?.stopReason, 'recorder-error');
  });

  it('reports an empty recording as a result plus an empty error code', async () => {
    h = harness();
    const sessionId = await startRecording(h);
    const stopped = h.controller.requestStop('user');
    h.controller.hostEvent({ type: 'stopped', sessionId });
    const result = await stopped;
    assert.equal(result?.success, false);
    assert.equal(result?.reason, 'empty');
    assert.equal(h.controller.snapshot().lastError?.code, 'empty');
  });

  it('resolves a mic switch from the host and fails it when the session ends', async () => {
    h = harness();
    const sessionId = await startRecording(h);
    const switched = h.controller.switchMic('usb');
    assert.deepEqual(h.calls.at(-1), { type: 'switch-mic', sessionId, deviceId: 'usb' });
    h.controller.hostEvent({ type: 'mic-switched', sessionId, success: true });
    assert.equal(await switched, true);
    const pending = h.controller.switchMic('other');
    await h.controller.hostLost();
    assert.equal(await pending, false);
  });
});

describe('RecordingController grace default', () => {
  it('uses the 10s grace window by default', async () => {
    const h = harness();
    await startRecording(h);
    void h.controller.requestStop('max-duration');
    assert.equal(h.timers[0].ms, 10_000);
    h.timers[0].fn();
    await h.controller.requestStop('user');
    assert.equal(h.controller.snapshot().phase, 'idle');
    h.cleanup();
  });

  it('a failed start keeps its slot until the file is aborted, so a new start cannot lose its host', async () => {
    let releaseAbort!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });
    const h = harness();
    after(() => h.cleanup());
    const abort = h.recorder.abortRecording.bind(h.recorder);
    h.recorder.abortRecording = async () => {
      await held;
      return abort();
    };
    const first = h.controller.requestStart({ title: 'First' });
    const firstId = h.calls.at(-1)!.sessionId!;
    assert.equal((await h.controller.hostOpen(firstId, 'audio/webm')).success, true);
    h.controller.hostEvent({ type: 'error', sessionId: firstId, code: 'init', message: 'boom' });
    await flush();
    assert.equal(h.disposeCount, 0, 'the host reported its own teardown');
    // A start (e.g. the shortcut) while the abort is still pending joins the failure.
    const joined = h.controller.requestStart({ title: 'Second' });
    assert.equal(h.calls.filter((c) => c.type === 'start').length, 1, 'no second host start');
    assert.equal(h.controller.snapshot().phase, 'starting');
    releaseAbort();
    assert.equal((await first).success, false);
    assert.equal((await joined).success, false, 'the joined start reports the failure');
    assert.equal(h.controller.snapshot().phase, 'idle');
    // After cleanup a new start succeeds and nothing disposes its host.
    const disposed = h.disposeCount;
    await startRecording(h, 'Third');
    assert.equal(h.disposeCount, disposed);
    assert.equal(h.controller.snapshot().phase, 'recording');
  });

  it('a failed start disposes a host that did not tear itself down before anything else', async () => {
    const h = harness();
    after(() => h.cleanup());
    const start = h.controller.requestStart({ title: 'Cancelled' });
    const id = h.calls.at(-1)!.sessionId!;
    assert.equal((await h.controller.hostOpen(id, 'audio/webm')).success, true);
    void h.controller.requestStop();
    assert.equal(h.disposeCount, 1, 'disposed synchronously, before the abort settles');
    assert.equal((await start).success, false);
  });

  it('a start cancelled while its file is opening keeps its slot through the open and abort', async () => {
    const h = harness();
    after(() => h.cleanup());
    let releaseOpen!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const open = h.recorder.startRecording.bind(h.recorder);
    let aborts = 0;
    const abort = h.recorder.abortRecording.bind(h.recorder);
    h.recorder.abortRecording = async () => {
      aborts++;
      return abort();
    };
    let firstOpen = true;
    h.recorder.startRecording = async (...args: Parameters<typeof open>) => {
      if (firstOpen) {
        firstOpen = false;
        await held;
      }
      return open(...args);
    };
    const first = h.controller.requestStart({ title: 'First' });
    const firstId = h.calls.at(-1)!.sessionId!;
    const opening = h.controller.hostOpen(firstId, 'audio/webm');
    await flush();
    void h.controller.requestStop(); // cancel while the file is opening
    const joined = h.controller.requestStart({ title: 'Second' }); // e.g. the shortcut
    await flush();
    assert.equal(h.calls.filter((c) => c.type === 'start').length, 1, 'no second host start');
    assert.equal(h.controller.snapshot().phase, 'starting');
    releaseOpen();
    assert.equal((await opening).success, false);
    assert.equal((await first).success, false);
    assert.equal((await joined).success, false);
    assert.equal(aborts, 1, 'the late-opened file is aborted once, by the cancelled start');
    assert.equal(h.controller.snapshot().phase, 'idle');
    // A new start now owns the recorder; nothing aborts its file.
    await startRecording(h, 'Third');
    assert.equal(aborts, 1);
    assert.equal(h.recorder.isRecording(), true);
  });

  it('saves notes as soon as the audio closes, before a stalled live drain', async () => {
    const h = harness({ beginLiveDrain: () => new Promise(() => {}) });
    after(() => h.cleanup());
    const sessionId = await startRecording(h);
    h.controller.addNote({ text: 'Decision: ship it' });
    h.recorder.appendChunk(Buffer.from([1, 2]));
    void h.controller.requestStop('quit', { autoMode: false });
    h.controller.hostEvent({ type: 'stopped', sessionId });
    for (let i = 0; i < 20 && h.savedNotes.length === 0; i++) await flush();
    assert.equal(h.savedNotes.length, 1, 'saved while the drain never finishes');
    assert.equal(h.savedNotes[0].notes[0].text, 'Decision: ship it');
  });

  it('a duplicate open while one is pending is refused and cannot leak the owned open', async () => {
    const h = harness();
    after(() => h.cleanup());
    let releaseOpen!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const open = h.recorder.startRecording.bind(h.recorder);
    let opens = 0;
    h.recorder.startRecording = async (...args: Parameters<typeof open>) => {
      opens++;
      await held;
      return open(...args);
    };
    let aborts = 0;
    const abort = h.recorder.abortRecording.bind(h.recorder);
    h.recorder.abortRecording = async () => {
      aborts++;
      return abort();
    };
    const start = h.controller.requestStart({ title: 'Duplicate open' });
    const id = h.calls.at(-1)!.sessionId!;
    const first = h.controller.hostOpen(id, 'audio/webm');
    await flush();
    // A duplicate RPC from the host while the first open is pending.
    const duplicate = await h.controller.hostOpen(id, 'audio/webm');
    assert.equal(duplicate.success, false);
    assert.equal(duplicate.code, 'busy');
    assert.equal(opens, 1, 'the recorder was asked to open once');
    // Cancel: the start waits for the owned open and aborts what it opened.
    void h.controller.requestStop();
    await flush();
    assert.equal(h.controller.snapshot().phase, 'starting', 'slot kept while the open is pending');
    releaseOpen();
    assert.equal((await first).success, false);
    assert.equal((await start).success, false);
    assert.equal(aborts, 1, 'the opened file is aborted, not leaked');
    assert.equal(h.recorder.isRecording(), false);
    assert.equal(h.controller.snapshot().phase, 'idle');
  });
});
