import * as fs from 'fs';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as path from 'path';
import type { TranscriptionResult } from '../geminiService';
import { META_JSON, getTranscriptionsDir, readTranscription } from '../outputService';
import { makeTempDir, rmDir } from '../test-helpers';
import type { TranscriptionJobSnapshot, TranscriptionJobsList } from '../transcriptionJobs';
import type { IpcContext } from './types';

// Drives the real `transcribe-audio`, `cancel-transcription`,
// `get-transcription-jobs` and `merge-recordings` handlers outside Electron
// against the main-owned job registry, with deferred fakes standing in for the
// provider, Notion, Slack and ffmpeg. Pins the reload-safe contract: a second
// request joins the running job, renamed paths still identify it, a cancel
// after the note is saved is refused, and auto-mode exports run in main
// exactly once whether or not a renderer is still waiting.

type Handler = (...args: unknown[]) => Promise<any>;
type ModuleWithLoad = typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const TS = '2026-10-12T05-00-00-000Z';

// Reloaded per test so each binds to the electron stub, this test's temp dir
// and a fresh registry.
const RELOAD = [
  './transcription',
  './noteExports',
  './meetingsManagement',
  '../transcriptionJobs',
  '../services/metadataService',
  '../services/notificationService',
  '../services/audioConcatService',
];

interface ProviderCall {
  filePath: string;
  signal: AbortSignal;
  progress: (percent: number, message: string) => void;
  resolve: (result: TranscriptionResult) => void;
}

function resultFor(label: string): TranscriptionResult {
  return {
    transcript: `Speaker 1: ${label} transcript.`,
    summary: `${label} summary.`,
    keyPoints: [],
    actionItems: [],
    emoji: '📝',
    suggestedTitle: `${label} Title`,
  } as TranscriptionResult;
}

describe('transcription jobs (reload-safe ownership)', () => {
  let dataPath: string;
  let recordingsDir: string;
  let handlers: Map<string, Handler>;
  let originalLoad: ModuleWithLoad['_load'];
  let calls: ProviderCall[];
  let sent: Array<{ channel: string; payload: any }>;
  let notionCalls: Array<{ title: string }>;
  let notionGate: Deferred<void> | null;
  let notionResult: { success: boolean; url?: string; error?: string } | null;
  let slackCalls: Array<{ title: string; notionUrl?: string; notionError?: string }>;
  let slackGate: Deferred<void> | null;
  let opened: string[];
  let notionConfigured: boolean;
  let slackConfigured: boolean;
  let ffmpegGate: Deferred<string | null> | null;

  beforeEach(() => {
    dataPath = makeTempDir('ipc-transcription-jobs');
    recordingsDir = path.join(dataPath, 'recordings');
    fs.mkdirSync(recordingsDir, { recursive: true });
    handlers = new Map();
    calls = [];
    sent = [];
    notionCalls = [];
    notionGate = null;
    notionResult = null;
    slackCalls = [];
    slackGate = null;
    opened = [];
    notionConfigured = false;
    slackConfigured = false;
    ffmpegGate = null;

    const fakeElectron = {
      ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) },
      app: { getPath: () => dataPath, emit: () => {} },
      dialog: {},
      Notification: { isSupported: () => false },
    };
    const moduleAny = Module as ModuleWithLoad;
    originalLoad = moduleAny._load;
    moduleAny._load = function (request: string, parent: NodeModule | null, isMain: boolean) {
      if (request === 'electron') return fakeElectron;
      return originalLoad.call(this, request, parent, isMain);
    };
    for (const m of RELOAD) delete require.cache[require.resolve(m)];

    const transcriptionsRoot = getTranscriptionsDir(dataPath);
    const window = {
      isDestroyed: () => false,
      webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) },
    };
    let pageId = 0;
    const ctx = {
      getMainWindow: () => window,
      configService: {
        getSummaryPrompt: () => '',
        getSlackWebhookUrl: () => (slackConfigured ? 'https://hooks.slack.com/services/x' : ''),
        getSlackAutoShare: () => slackConfigured,
      },
      notificationService: {
        notifyUploadComplete: () => {},
        notifyUploadFailed: () => {},
        notifyTranscriptionComplete: () => {},
        notifyTranscriptionFailed: () => {},
      },
      ffmpegManager: { ensureFFmpeg: () => ffmpegGate?.promise ?? Promise.resolve('/ffmpeg') },
      ensureGeminiService: () => ({
        transcribeAudio: (
          filePath: string,
          progress: (percent: number, message: string) => void,
          _prompt: unknown,
          _notes: unknown,
          opts?: { signal?: AbortSignal },
        ) =>
          new Promise<TranscriptionResult>((resolve, reject) => {
            const signal = opts?.signal ?? new AbortController().signal;
            calls.push({ filePath, signal, progress, resolve });
            // Like the real SDKs: an already-aborted signal rejects at once.
            if (signal.aborted) reject(new Error('aborted'));
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            progress(25, 'Deferred provider pending');
          }),
      }),
      getNotionService: () =>
        notionConfigured
          ? {
              createMeetingNote: async (title: string) => {
                notionCalls.push({ title });
                await notionGate?.promise;
                return notionResult ?? { success: true, url: `https://notion.so/page-${++pageId}` };
              },
            }
          : null,
      getSlackService: () =>
        slackConfigured
          ? {
              sendMeetingSummary: async (options: {
                title: string;
                notionUrl?: string;
                notionError?: string;
              }) => {
                slackCalls.push({
                  title: options.title,
                  notionUrl: options.notionUrl,
                  notionError: options.notionError,
                });
                await slackGate?.promise;
                return { success: true, sentAt: '2026-10-12T05:10:00.000Z' };
              },
            }
          : null,
      openExternal: (url: string) => opened.push(url),
      maybeAutoSync: () => {},
      isContainedTranscriptionPath: (p: string | undefined): p is string =>
        typeof p === 'string' && path.resolve(p).startsWith(transcriptionsRoot + path.sep),
      formatAiCredentialsError: () => 'no credentials',
      serializeTranscriptionError: () => ({}),
      sanitizeLiveNotes: (raw: unknown) => (Array.isArray(raw) ? raw : undefined),
    } as unknown as IpcContext;
    for (const mod of ['./transcription', './noteExports', './meetingsManagement']) {
      (require(mod) as { register: (c: IpcContext) => void }).register(ctx);
    }
  });

  afterEach(() => {
    (Module as ModuleWithLoad)._load = originalLoad;
    for (const m of RELOAD) delete require.cache[require.resolve(m)];
    rmDir(dataPath);
  });

  const invoke = (channel: string, ...args: unknown[]): Promise<any> => {
    const handler = handlers.get(channel);
    assert.ok(handler, `${channel} must be registered`);
    return Promise.resolve(handler({}, ...args));
  };
  const jobs = async (): Promise<TranscriptionJobsList> => invoke('get-transcription-jobs');
  const jobEvents = (): TranscriptionJobSnapshot[] =>
    sent.filter((s) => s.channel === 'transcription-job-changed').map((s) => s.payload);
  const noteFolders = () => {
    const dir = getTranscriptionsDir(dataPath);
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => !f.startsWith('.')) : [];
  };
  const recording = (name: string) => {
    const file = path.join(recordingsDir, `${name}_${TS}.webm`);
    fs.writeFileSync(file, 'audio');
    return file;
  };

  it('joins a duplicate request instead of aborting and restarting the provider', async () => {
    const audio = recording('Untitled_Meeting');
    const first = invoke('transcribe-audio', audio);
    await waitFor(() => calls.length === 1, 'provider call');
    const second = invoke('transcribe-audio', audio);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.length, 1, 'a duplicate must not start a second provider call');
    assert.equal(calls[0].signal.aborted, false, 'a duplicate must not abort the first');

    const running = await jobs();
    assert.equal(running.jobs.length, 1);
    assert.equal(running.jobs[0].status, 'running');
    assert.equal(running.jobs[0].percent, 25);
    assert.equal(running.jobs[0].message, 'Deferred provider pending');
    assert.equal(running.jobs[0].cancellable, true);

    calls[0].resolve(resultFor('Weekly Sync'));
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.success, true);
    assert.equal(b.success, true);
    assert.equal(b.joined, true);
    assert.equal(a.jobId, b.jobId);
    assert.equal(a.transcriptionPath, b.transcriptionPath);
    assert.equal(noteFolders().length, 1);

    const [done] = (await jobs()).jobs;
    assert.equal(done.status, 'succeeded');
    assert.equal(done.newFilePath, a.newFilePath);
    assert.equal(done.transcriptionPath, a.transcriptionPath);
    assert.ok(done.paths.includes(audio) && done.paths.includes(a.newFilePath));

    // Progress events now name their job; legacy fields are unchanged.
    const progress = sent.filter((s) => s.channel === 'transcription-progress');
    assert.ok(progress.length > 0);
    assert.ok(progress.every((p) => p.payload.filePath === audio && p.payload.jobId === a.jobId));
    // The job event stream ends with the terminal state.
    assert.equal(jobEvents().at(-1)?.status, 'succeeded');
  });

  it('starts a new run for a deliberate regenerate after completion', async () => {
    const audio = recording('Standup');
    const first = invoke('transcribe-audio', audio);
    await waitFor(() => calls.length === 1, 'first provider call');
    calls[0].resolve(resultFor('First'));
    const one = await first;
    const second = invoke('transcribe-audio', audio);
    await waitFor(() => calls.length === 2, 'second provider call');
    calls[1].resolve(resultFor('Second'));
    const two = await second;
    assert.notEqual(one.jobId, two.jobId);
    assert.equal(two.joined, undefined);
    assert.deepEqual(noteFolders().length, 1, 'regenerate replaces the note in place');
    const read = await readTranscription(two.transcriptionPath);
    assert.equal(read?.summary, 'Second summary.');
  });

  it('cancels through the renamed path before the save and restores the original name', async () => {
    const audio = recording('Untitled_Meeting');
    const renamed = path.join(recordingsDir, `Weekly_Sync_Title_${TS}.webm`);
    const service = require('../services/metadataService').metadataService as {
      saveMetadata: (file: string, metadata: unknown) => Promise<void>;
    };
    const originalSave = service.saveMetadata.bind(service);
    const reached = deferred();
    const release = deferred();
    service.saveMetadata = async (file, metadata) => {
      if (file === renamed) {
        reached.resolve();
        await release.promise;
      }
      await originalSave(file, metadata);
    };
    fs.mkdirSync(path.join(dataPath, 'metadata'), { recursive: true });
    fs.writeFileSync(
      path.join(dataPath, 'metadata', `Untitled_Meeting_${TS}.json`),
      JSON.stringify({ filePath: audio, title: 'Untitled' }),
    );

    const pending = invoke('transcribe-audio', audio);
    await waitFor(() => calls.length === 1, 'provider call');
    calls[0].resolve(resultFor('Weekly Sync'));
    await reached.promise;
    // A reloaded list shows the renamed row; that row's Cancel must reach the job.
    assert.ok((await jobs()).jobs[0].paths.includes(renamed));
    assert.deepEqual(await invoke('cancel-transcription', renamed), { success: true });
    release.resolve();
    const result = await pending;
    assert.equal(result.cancelled, true);
    assert.ok(fs.existsSync(audio));
    assert.ok(!fs.existsSync(renamed));
    assert.equal(noteFolders().length, 0);
    assert.equal((await jobs()).jobs[0].status, 'cancelled');
    assert.deepEqual(await invoke('cancel-transcription', audio), {
      success: false,
      reason: 'not-running',
    });
  });

  it('refuses a cancel after the note is saved and reports success', async () => {
    const audio = recording('Untitled_Meeting');
    const renamed = path.join(recordingsDir, `Weekly_Sync_Title_${TS}.webm`);
    const service = require('../services/metadataService').metadataService as {
      saveMetadata: (file: string, metadata: { transcriptionPath?: string }) => Promise<void>;
    };
    const originalSave = service.saveMetadata.bind(service);
    const reached = deferred();
    const release = deferred();
    service.saveMetadata = async (file, metadata) => {
      // The sidecar write that links the saved note runs after the commit.
      if (file === renamed && metadata.transcriptionPath) {
        reached.resolve();
        await release.promise;
      }
      await originalSave(file, metadata);
    };

    const pending = invoke('transcribe-audio', audio);
    await waitFor(() => calls.length === 1, 'provider call');
    calls[0].resolve(resultFor('Weekly Sync'));
    await reached.promise;
    assert.deepEqual(await invoke('cancel-transcription', renamed), {
      success: false,
      reason: 'committed',
    });
    assert.equal(calls[0].signal.aborted, false);
    release.resolve();
    const result = await pending;
    assert.equal(result.success, true);
    assert.equal(result.newFilePath, renamed);
    assert.equal(noteFolders().length, 1);
  });

  it('never renames over another running recording and cancels only the job asked for', async () => {
    const other = path.join(recordingsDir, `Weekly_Sync_Title_${TS}.webm`);
    fs.writeFileSync(other, 'B-audio');
    const audio = recording('Untitled_Meeting');
    const b = invoke('transcribe-audio', other);
    await waitFor(() => calls.length === 1, 'B provider call');
    const a = invoke('transcribe-audio', audio);
    await waitFor(() => calls.length === 2, 'A provider call');
    // A's suggested title produces exactly B's file name.
    calls[1].resolve(resultFor('Weekly Sync'));
    const aResult = await a;
    assert.equal(aResult.success, true);
    assert.equal(aResult.newFilePath, audio, 'A keeps its name instead of replacing B');
    assert.equal(fs.readFileSync(other, 'utf-8'), 'B-audio');
    assert.equal(fs.readFileSync(audio, 'utf-8'), 'audio');
    const aMeta = JSON.parse(
      fs.readFileSync(path.join(aResult.transcriptionPath, META_JSON), 'utf-8'),
    );
    assert.equal(aMeta.audioFile, audio);

    assert.deepEqual(await invoke('cancel-transcription', other), { success: true });
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(calls[1].signal.aborted, false);
    assert.equal((await b).cancelled, true);
    assert.equal(fs.readFileSync(other, 'utf-8'), 'B-audio');
  });

  it('does not touch a path another running job answers to, even when no file holds it', async () => {
    const claimed = path.join(recordingsDir, `Weekly_Sync_Title_${TS}.webm`);
    const audio = recording('Untitled_Meeting');
    // Record every link/copy/rename/unlink the rename flow could make.
    const fsPromises = require('fs').promises as Record<string, (...args: any[]) => Promise<any>>;
    const spied = ['link', 'copyFile', 'rename', 'unlink'] as const;
    const originals = Object.fromEntries(spied.map((name) => [name, fsPromises[name]]));
    const touched: string[] = [];
    for (const name of spied) {
      fsPromises[name] = (...args: any[]) => {
        touched.push(...args.filter((a) => typeof a === 'string'));
        return originals[name](...args);
      };
    }
    try {
      const b = invoke('transcribe-audio', claimed);
      await waitFor(() => calls.length === 1, 'B provider call');
      const a = invoke('transcribe-audio', audio);
      await waitFor(() => calls.length === 2, 'A provider call');
      calls[1].resolve(resultFor('Weekly Sync'));
      const aResult = await a;
      assert.equal(aResult.newFilePath, audio);
      assert.ok(fs.existsSync(audio));
      assert.ok(!fs.existsSync(claimed));
      assert.ok(!touched.includes(claimed), `no filesystem call named ${claimed}`);
      assert.ok(!touched.includes(audio), 'the recording was never moved');
      await finishClaimedCheck(b);
    } finally {
      for (const name of spied) fsPromises[name] = originals[name];
    }
  });

  async function finishClaimedCheck(b: Promise<any>): Promise<void> {
    const claimed = path.join(recordingsDir, `Weekly_Sync_Title_${TS}.webm`);
    const audio = path.join(recordingsDir, `Untitled_Meeting_${TS}.webm`);
    const listed = (await jobs()).jobs;
    const bJob = listed.find((j) => j.filePath === claimed);
    const aJob = listed.find((j) => j.filePath === audio);
    assert.deepEqual(bJob?.paths, [claimed]);
    assert.ok(!aJob?.paths.includes(claimed));
    assert.deepEqual(await invoke('cancel-transcription', claimed), { success: true });
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(calls[1].signal.aborted, false);
    assert.equal((await b).cancelled, true);
  }

  it('never lets a name it only tried to take redirect a request or Cancel for the recording there', async () => {
    // B appears after A's existence check, so A's real link() fails EEXIST;
    // that rejection is held while requests for B arrive.
    const foreign = path.join(recordingsDir, `Weekly_Sync_Title_${TS}.webm`);
    const audio = recording('Untitled_Meeting');
    const fsPromises = require('fs').promises as { link: (a: string, b: string) => Promise<void> };
    const originalLink = fsPromises.link;
    const linkFailed = deferred();
    const releaseLink = deferred();
    fsPromises.link = async (from, to) => {
      if (to !== foreign) return originalLink(from, to);
      fs.writeFileSync(foreign, 'B-audio');
      try {
        return await originalLink(from, to);
      } catch (error) {
        linkFailed.resolve();
        await releaseLink.promise;
        throw error;
      }
    };
    try {
      const a = invoke('transcribe-audio', audio);
      await waitFor(() => calls.length === 1, 'A provider call');
      calls[0].resolve(resultFor('Weekly Sync'));
      await linkFailed.promise;

      const aJobId = (await jobs()).jobs[0].id;
      const b = invoke('transcribe-audio', foreign);
      const cancelB = invoke('cancel-transcription', foreign);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(calls.length, 1, 'nothing runs for B while the name is undecided');
      assert.equal(calls[0].signal.aborted, false);
      const aDuring = (await jobs()).jobs.find((j) => j.id === aJobId)!;
      assert.deepEqual(aDuring.paths, [audio], 'the reservation is never listed');

      releaseLink.resolve();
      await waitFor(() => calls.length === 2, 'B provider call');
      assert.equal(calls[1].filePath, foreign);
      assert.deepEqual(await cancelB, { success: true });
      assert.equal(calls[1].signal.aborted, true, 'Cancel for B reached B');
      assert.equal(calls[0].signal.aborted, false, 'and never A');
      const bResult = await b;
      assert.equal(bResult.cancelled, true);
      assert.equal(bResult.joined, undefined);
      assert.notEqual(bResult.jobId, aJobId);
      const aResult = await a;
      assert.equal(aResult.success, true);
      assert.equal(aResult.newFilePath, audio);
      assert.equal(fs.readFileSync(foreign, 'utf-8'), 'B-audio');
      for (const event of sent.filter((e) => e.channel === 'transcription-job-changed')) {
        if (event.payload.id === aJobId) {
          assert.ok(!event.payload.paths.includes(foreign), 'A never published B');
          assert.ok(!event.payload.aliases.some((k: string) => k.endsWith(path.basename(foreign))));
        }
      }
    } finally {
      fsPromises.link = originalLink;
    }
  });

  it('makes a request wait while its file is still being copied, then joins the job that made it', async () => {
    const fsPromises = require('fs').promises as Record<string, (...args: any[]) => Promise<any>>;
    const originalLink = fsPromises.link;
    const originalCopy = fsPromises.copyFile;
    const copying = deferred();
    const finishCopy = deferred();
    fsPromises.link = async () => {
      throw Object.assign(new Error('link not supported'), { code: 'ENOTSUP' });
    };
    fsPromises.copyFile = async (from: string, to: string, mode: number) => {
      // Leave a partial destination on disk while the copy is "in progress".
      fs.writeFileSync(to, 'partial');
      copying.resolve();
      await finishCopy.promise;
      fs.rmSync(to);
      return originalCopy(from, to, mode);
    };
    try {
      const audio = recording('Untitled_Meeting');
      const renamed = path.join(recordingsDir, `Weekly_Sync_Title_${TS}.webm`);
      const a = invoke('transcribe-audio', audio);
      await waitFor(() => calls.length === 1, 'provider call');
      calls[0].resolve(resultFor('Weekly Sync'));
      await copying.promise;
      const viaNewName = invoke('transcribe-audio', renamed);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(calls.length, 1, 'no run reads the incomplete copy');
      finishCopy.resolve();
      const [aResult, joined] = await Promise.all([a, viaNewName]);
      assert.equal(aResult.newFilePath, renamed);
      assert.equal(joined.joined, true);
      assert.equal(joined.jobId, aResult.jobId);
      assert.equal(calls.length, 1);
      assert.equal(fs.readFileSync(renamed, 'utf-8'), 'audio');
    } finally {
      fsPromises.link = originalLink;
      fsPromises.copyFile = originalCopy;
    }
  });

  it('reserves a missing destination under its canonical spelling when started through a symlink', async () => {
    const linkedDir = path.join(dataPath, 'linked-recordings');
    fs.symlinkSync(recordingsDir, linkedDir);
    const audioViaLink = path.join(linkedDir, `Untitled_Meeting_${TS}.webm`);
    fs.writeFileSync(path.join(recordingsDir, `Untitled_Meeting_${TS}.webm`), 'audio');
    fs.mkdirSync(path.join(dataPath, 'metadata'), { recursive: true });
    fs.writeFileSync(
      path.join(dataPath, 'metadata', `Untitled_Meeting_${TS}.json`),
      JSON.stringify({ filePath: audioViaLink, title: 'Untitled' }),
    );
    const renamedViaLink = path.join(linkedDir, `Weekly_Sync_Title_${TS}.webm`);
    const renamedCanonical = path.join(
      fs.realpathSync.native(recordingsDir),
      `Weekly_Sync_Title_${TS}.webm`,
    );
    const service = require('../services/metadataService').metadataService as {
      saveMetadata: (file: string, metadata: unknown) => Promise<void>;
    };
    const originalSave = service.saveMetadata.bind(service);
    const reached = deferred();
    const release = deferred();
    service.saveMetadata = async (file, metadata) => {
      if (file === renamedViaLink) {
        reached.resolve();
        await release.promise;
      }
      await originalSave(file, metadata);
    };
    const a = invoke('transcribe-audio', audioViaLink);
    await waitFor(() => calls.length === 1, 'provider call');
    calls[0].resolve(resultFor('Weekly Sync'));
    await reached.promise;
    const [job] = (await jobs()).jobs;
    assert.ok(job.aliases.includes(renamedCanonical), 'the canonical renamed spelling is listed');
    const viaCanonical = invoke('transcribe-audio', renamedCanonical);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.length, 1, 'the canonical request joins instead of starting');
    assert.deepEqual(await invoke('cancel-transcription', renamedCanonical), { success: true });
    assert.equal(calls[0].signal.aborted, true);
    release.resolve();
    const [aResult, joined] = await Promise.all([a, viaCanonical]);
    assert.equal(aResult.cancelled, true);
    assert.equal(joined.joined, true);
    assert.equal(joined.jobId, aResult.jobId);
    assert.ok(fs.existsSync(audioViaLink));
  });

  it('never rolls a cancelled rename back over a recording that took the original name', async () => {
    const audio = recording('Untitled_Meeting');
    const renamed = path.join(recordingsDir, `Weekly_Sync_Title_${TS}.webm`);
    fs.mkdirSync(path.join(dataPath, 'metadata'), { recursive: true });
    fs.writeFileSync(
      path.join(dataPath, 'metadata', `Untitled_Meeting_${TS}.json`),
      JSON.stringify({ filePath: audio, title: 'Untitled' }),
    );
    const service = require('../services/metadataService').metadataService as {
      saveMetadata: (file: string, metadata: unknown) => Promise<void>;
    };
    const originalSave = service.saveMetadata.bind(service);
    const reached = deferred();
    const release = deferred();
    service.saveMetadata = async (file, metadata) => {
      if (file === renamed) {
        reached.resolve();
        await release.promise;
      }
      await originalSave(file, metadata);
    };

    const pending = invoke('transcribe-audio', audio);
    await waitFor(() => calls.length === 1, 'provider call');
    calls[0].resolve(resultFor('Weekly Sync'));
    await reached.promise;
    fs.writeFileSync(audio, 'newcomer');
    assert.deepEqual(await invoke('cancel-transcription', audio), { success: true });
    release.resolve();
    const result = await pending;
    assert.equal(result.cancelled, true);
    assert.equal(
      result.newFilePath,
      renamed,
      'the audio stays where it is, and the caller is told',
    );
    assert.equal(fs.readFileSync(audio, 'utf-8'), 'newcomer');
    assert.equal(fs.readFileSync(renamed, 'utf-8'), 'audio');
    assert.ok(fs.existsSync(path.join(dataPath, 'metadata', `Weekly_Sync_Title_${TS}.json`)));
    assert.equal(noteFolders().length, 0);
  });

  it('joins a request through the renamed path while the cancel rolls back, and both end cancelled', async () => {
    const audio = recording('Untitled_Meeting');
    const renamed = path.join(recordingsDir, `Weekly_Sync_Title_${TS}.webm`);
    const metadataDir = path.join(dataPath, 'metadata');
    fs.mkdirSync(metadataDir, { recursive: true });
    fs.writeFileSync(
      path.join(metadataDir, `Untitled_Meeting_${TS}.json`),
      JSON.stringify({ filePath: audio, title: 'Untitled' }),
    );
    const service = require('../services/metadataService').metadataService as {
      saveMetadata: (file: string, metadata: unknown) => Promise<void>;
    };
    const originalSave = service.saveMetadata.bind(service);
    // First hold: the sidecar move after the rename (before the commit).
    // Second hold: the sidecar move back during the cancel rollback.
    const forwardReached = deferred();
    const forwardRelease = deferred();
    const rollbackReached = deferred();
    const rollbackRelease = deferred();
    service.saveMetadata = async (file, metadata) => {
      if (file === renamed) {
        forwardReached.resolve();
        await forwardRelease.promise;
      } else if (file === audio) {
        rollbackReached.resolve();
        await rollbackRelease.promise;
      }
      await originalSave(file, metadata);
    };

    const first = invoke('transcribe-audio', audio);
    await waitFor(() => calls.length === 1, 'provider call');
    calls[0].resolve(resultFor('Weekly Sync'));
    await forwardReached.promise;
    assert.deepEqual(await invoke('cancel-transcription', audio), { success: true });
    forwardRelease.resolve();
    await rollbackReached.promise;
    // The audio is already back under its original name; the job is still
    // running its rollback. A request for the renamed row joins that job.
    assert.ok(fs.existsSync(audio));
    assert.ok(!fs.existsSync(renamed));
    const viaAlias = invoke('transcribe-audio', renamed);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.length, 1, 'no second provider call');
    rollbackRelease.resolve();

    const [one, two] = await Promise.all([first, viaAlias]);
    assert.equal(one.cancelled, true);
    assert.equal(two.cancelled, true);
    assert.equal(two.joined, true);
    assert.equal(two.jobId, one.jobId);
    assert.equal(one.newFilePath, undefined);
    assert.equal(calls.length, 1);
    assert.equal(fs.readFileSync(audio, 'utf-8'), 'audio');
    assert.ok(!fs.existsSync(renamed));
    assert.deepEqual(fs.readdirSync(metadataDir), [`Untitled_Meeting_${TS}.json`]);
    assert.equal(noteFolders().length, 0);
    const listed = (await jobs()).jobs;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, 'cancelled');
  });

  it('renames through an exclusive copy where hard links are unsupported', async () => {
    const fsPromises = require('fs').promises as { link: (...args: unknown[]) => Promise<void> };
    const originalLink = fsPromises.link;
    let linkAttempts = 0;
    fsPromises.link = async () => {
      linkAttempts++;
      throw Object.assign(new Error('link not supported'), { code: 'EPERM' });
    };
    try {
      const audio = recording('Untitled_Meeting');
      fs.writeFileSync(audio, 'A-audio');
      const pending = invoke('transcribe-audio', audio);
      await waitFor(() => calls.length === 1, 'provider call');
      calls[0].resolve(resultFor('Weekly Sync'));
      const result = await pending;
      const renamed = path.join(recordingsDir, `Weekly_Sync_Title_${TS}.webm`);
      assert.ok(linkAttempts > 0, 'the hard-link path was tried first');
      assert.equal(result.newFilePath, renamed);
      assert.equal(fs.readFileSync(renamed, 'utf-8'), 'A-audio');
      assert.ok(!fs.existsSync(audio), 'one name per recording');
    } finally {
      fsPromises.link = originalLink;
    }
  });

  it('keeps an existing recording when the exclusive-copy fallback meets its name', async () => {
    const fsPromises = require('fs').promises as { link: (...args: unknown[]) => Promise<void> };
    const originalLink = fsPromises.link;
    fsPromises.link = async () => {
      throw Object.assign(new Error('link not supported'), { code: 'ENOTSUP' });
    };
    try {
      const other = path.join(recordingsDir, `Weekly_Sync_Title_${TS}.webm`);
      fs.writeFileSync(other, 'B-audio');
      const audio = recording('Untitled_Meeting');
      fs.writeFileSync(audio, 'A-audio');
      const pending = invoke('transcribe-audio', audio);
      await waitFor(() => calls.length === 1, 'provider call');
      calls[0].resolve(resultFor('Weekly Sync'));
      const result = await pending;
      assert.equal(result.success, true);
      assert.equal(result.newFilePath, audio, 'the recording keeps its original name');
      assert.equal(fs.readFileSync(other, 'utf-8'), 'B-audio');
      assert.equal(fs.readFileSync(audio, 'utf-8'), 'A-audio');
    } finally {
      fsPromises.link = originalLink;
    }
  });

  it('runs configured auto exports in main once, even with no renderer waiting', async () => {
    notionConfigured = true;
    slackConfigured = true;
    notionGate = deferred();
    slackGate = deferred();
    const audio = recording('Untitled_Meeting');
    // Fire and forget: a reloaded renderer no longer awaits this promise.
    const pending = invoke('transcribe-audio', audio, undefined, {
      autoExport: true,
      recordingTitle: 'Untitled_Meeting',
    });
    await waitFor(() => calls.length === 1, 'provider call');
    assert.equal((await jobs()).jobs[0].origin, 'auto');
    calls[0].resolve(resultFor('Weekly Sync'));

    await waitFor(() => notionCalls.length === 1, 'notion upload');
    const exporting = (await jobs()).jobs[0];
    assert.equal(exporting.phase, 'exporting');
    assert.equal(exporting.status, 'running');
    assert.equal(exporting.cancellable, false);
    assert.deepEqual(exporting.exports, { notion: { status: 'running' } });
    // A duplicate during the export phase joins; it never re-runs exports.
    const joined = invoke('transcribe-audio', exporting.paths.at(-1));
    assert.deepEqual(await invoke('cancel-transcription', audio), {
      success: false,
      reason: 'committed',
    });
    notionGate.resolve();
    await waitFor(() => slackCalls.length === 1, 'slack send');
    slackGate.resolve();
    const [result, joinedResult] = await Promise.all([pending, joined]);

    assert.equal(calls.length, 1);
    assert.equal(notionCalls.length, 1);
    assert.equal(slackCalls.length, 1);
    assert.equal(notionCalls[0].title, 'Weekly Sync Title by L.AI');
    assert.equal(slackCalls[0].notionUrl, 'https://notion.so/page-1');
    assert.deepEqual(opened, ['https://notion.so/page-1']);
    assert.deepEqual(result.exports, {
      notion: { status: 'succeeded', url: 'https://notion.so/page-1' },
      slack: { status: 'succeeded' },
    });
    assert.deepEqual(joinedResult.exports, result.exports);

    const meta = JSON.parse(
      fs.readFileSync(path.join(result.transcriptionPath, META_JSON), 'utf-8'),
    );
    assert.equal(meta.generationId, result.generationId);
    assert.equal(meta.exports.notion.pageUrl, 'https://notion.so/page-1');
    assert.equal(meta.exports.slack.sentAt, '2026-10-12T05:10:00.000Z');
    const [done] = (await jobs()).jobs;
    assert.equal(done.status, 'succeeded');
    assert.deepEqual(done.exports, result.exports);
  });

  it('keeps the saved note and passes a Notion failure on to Slack', async () => {
    notionConfigured = true;
    slackConfigured = true;
    notionResult = { success: false, error: 'Notion is down' };
    const audio = recording('Planning');
    const pending = invoke('transcribe-audio', audio, undefined, {
      autoExport: true,
      recordingTitle: 'Planning',
    });
    await waitFor(() => calls.length === 1, 'provider call');
    calls[0].resolve(resultFor('Planning'));
    const result = await pending;

    assert.equal(result.success, true);
    assert.equal(noteFolders().length, 1);
    assert.equal(slackCalls.length, 1);
    assert.equal(slackCalls[0].title, 'Planning');
    assert.equal(slackCalls[0].notionError, 'Notion is down');
    assert.deepEqual(opened, []);
    assert.deepEqual(result.exports, {
      notion: { status: 'failed', error: 'Notion is down' },
      slack: { status: 'succeeded' },
    });
    const [done] = (await jobs()).jobs;
    assert.equal(done.status, 'succeeded');
    assert.equal(done.error, undefined);
  });

  it('skips exports that are not configured and manual runs never export', async () => {
    notionConfigured = true;
    const manualAudio = recording('Manual');
    const manual = invoke('transcribe-audio', manualAudio);
    await waitFor(() => calls.length === 1, 'manual provider call');
    calls[0].resolve(resultFor('Manual'));
    assert.equal((await manual).exports, undefined);
    assert.equal(notionCalls.length, 0);

    notionConfigured = false;
    const autoAudio = recording('Auto');
    const auto = invoke('transcribe-audio', autoAudio, undefined, { autoExport: true });
    await waitFor(() => calls.length === 2, 'auto provider call');
    calls[1].resolve(resultFor('Auto'));
    assert.deepEqual((await auto).exports, {});
  });

  it('keeps merge single-flight and exposes the running merge as a job', async () => {
    const a = recording('Part_One');
    const b = recording('Part_Two');
    ffmpegGate = deferred<string | null>();
    const first = invoke('merge-recordings', { paths: [a, b], title: 'Combined' });
    await waitFor(() => jobEvents().length > 0, 'merge job event');
    const busy = await invoke('merge-recordings', { paths: [a, b], title: 'Again' });
    assert.equal(busy.code, 'merge-busy');
    const [running] = (await jobs()).jobs;
    assert.equal(running.kind, 'merge');
    assert.equal(running.status, 'running');
    assert.deepEqual(running.sourcePaths, [a, b]);
    assert.equal(running.title, 'Combined');
    // Transcribing a source is a different job and still allowed.
    assert.deepEqual(await invoke('cancel-transcription', a), {
      success: false,
      reason: 'not-running',
    });

    // Provide a fake concat so the merge reaches the provider.
    const concat = require('../services/audioConcatService') as {
      concatAudioFiles: (o: { outputPath: string }) => Promise<void>;
    };
    concat.concatAudioFiles = async ({ outputPath }) => fs.writeFileSync(outputPath, 'merged');
    ffmpegGate.resolve('/ffmpeg');
    await waitFor(() => calls.length === 1, 'merge provider call');
    const midway = (await jobs()).jobs[0];
    assert.ok(midway.mergedAudioPath && midway.mergedAudioPath === calls[0].filePath);
    assert.ok(midway.percent >= 15);
    calls[0].resolve(resultFor('Combined'));
    const result = await first;

    assert.equal(result.success, true);
    assert.equal(result.mergedAudioPath, midway.mergedAudioPath);
    assert.ok(fs.existsSync(a) && fs.existsSync(b), 'originals are untouched');
    const [done] = (await jobs()).jobs;
    assert.equal(done.status, 'succeeded');
    assert.equal(done.transcriptionPath, result.transcriptionPath);
    assert.equal(done.id, result.jobId);
    const progress = sent.filter((s) => s.channel === 'transcription-progress');
    assert.ok(
      progress.every((p) => p.payload.filePath === undefined && p.payload.jobId === done.id),
    );

    // The slot is free again after the merge settles.
    ffmpegGate = deferred<string | null>();
    const next = invoke('merge-recordings', { paths: [a, b] });
    ffmpegGate.resolve(null);
    assert.equal((await next).code, 'ffmpeg-missing');
  });
});
