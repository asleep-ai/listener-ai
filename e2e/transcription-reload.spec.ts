import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, appWindow, launchApp } from './support/launch';
import { answerConfirm, scriptDialogs, scriptedDialogs, visibleWindows } from './support/dialogs';

// Reload-safe transcription jobs, end to end in the real Electron app.
//
// The provider, Notion, Slack, ffmpeg/concat and shell.openExternal are
// replaced inside the running main process through `electronApp.evaluate`
// with deferred fixtures, so each test decides exactly when a job advances
// while the real IPC handlers, job registry, preload bridge and renderer run
// unchanged. No product test-delay switch is involved, every renderer HTTP(S)
// request is cancelled, and nothing reaches a real provider, Notion or Slack.
//
// Needs `pnpm run build` (main + renderer). Launches go through
// e2e/support/launch.ts, which keeps the app windows hidden (TEST-ONLY), and
// JavaScript dialogs are scripted (e2e/support/dialogs.ts) so none goes native.

const TS = '2026-10-12T05-00-00-000Z';
const SLACK_WEBHOOK = 'https://hooks.slack.com/services/T000/B000/fixture';
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version as string;

interface Fixture {
  dataDir: string;
  app: ElectronApplication;
  page: Page;
}

function seed(config: Record<string, unknown> = {}): string {
  const dataDir = mkdtempSync(join(tmpdir(), 'listener-reload-e2e-'));
  mkdirSync(join(dataDir, 'recordings'));
  mkdirSync(join(dataDir, 'metadata'));
  writeFileSync(
    join(dataDir, 'config.json'),
    JSON.stringify({
      aiProvider: 'gemini',
      geminiApiKey: 'e2e-unused',
      autoMode: false,
      googleDriveEnabled: false,
      lastSeenVersion: VERSION,
      ...config,
    }),
  );
  return dataDir;
}

function seedRecording(dataDir: string, name: string): string {
  const audio = join(dataDir, 'recordings', `${name}_${TS}.wav`);
  writeFileSync(audio, Buffer.alloc(44));
  writeFileSync(
    join(dataDir, 'metadata', `${name}_${TS}.json`),
    JSON.stringify({ filePath: audio, title: name, timestamp: '2026-10-12T05:00:00.000Z' }),
  );
  return audio;
}

async function launch(dataDir: string): Promise<Fixture> {
  const app = await launchApp({ ...process.env, NODE_ENV: 'test', LISTENER_DATA_PATH: dataDir });
  await app.evaluate(({ session, shell }, root) => {
    type Call = {
      file: string;
      aborted: boolean;
      settled: boolean;
      progress: (percent: number, message: string) => void;
      resolve: (value: unknown) => void;
    };
    const fx = {
      calls: [] as Call[],
      notion: [] as Array<{ title: string; resolve: (value: unknown) => void }>,
      slack: [] as Array<{
        title: string;
        notionUrl?: string;
        notionError?: string;
        resolve: (value: unknown) => void;
      }>,
      opened: [] as string[],
      blocked: [] as string[],
      concat: 0,
      holdSave: null as null | { path: string; reached: boolean; release: () => void },
    };
    (globalThis as Record<string, unknown>).__jobFixture = fx;
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (details, callback) => {
        fx.blocked.push(details.url);
        callback({ cancel: true });
      },
    );
    const load = (rel: string) => (process as any).mainModule.require(`${root}/dist/${rel}`);
    load('geminiService.js').GeminiService.prototype.transcribeAudio = function (
      file: string,
      progress: Call['progress'],
      _prompt: unknown,
      _notes: unknown,
      options?: { signal?: AbortSignal },
    ) {
      return new Promise((resolve, reject) => {
        const call: Call = { file, aborted: false, settled: false, progress, resolve };
        fx.calls.push(call);
        options?.signal?.addEventListener(
          'abort',
          () => {
            call.aborted = true;
            call.settled = true;
            reject(new Error('Deferred fixture aborted'));
          },
          { once: true },
        );
        progress(25, 'Deferred fixture pending');
      });
    };
    load('notionService.js').NotionService.prototype.createMeetingNote = function (title: string) {
      return new Promise((resolve) => fx.notion.push({ title, resolve }));
    };
    load('slackService.js').SlackService.prototype.sendMeetingSummary = function (o: {
      title: string;
      notionUrl?: string;
      notionError?: string;
    }) {
      return new Promise((resolve) =>
        fx.slack.push({
          title: o.title,
          notionUrl: o.notionUrl,
          notionError: o.notionError,
          resolve,
        }),
      );
    };
    load('services/ffmpegManager.js').FFmpegManager.prototype.ensureFFmpeg = async () =>
      '/fixture/ffmpeg';
    load('services/audioConcatService.js').concatAudioFiles = async (o: { outputPath: string }) => {
      fx.concat++;
      (process as any).mainModule.require('fs').writeFileSync(o.outputPath, Buffer.alloc(44));
    };
    const metadata = load('services/metadataService.js').metadataService;
    const save = metadata.saveMetadata.bind(metadata);
    metadata.saveMetadata = async (file: string, data: unknown) => {
      const hold = fx.holdSave;
      if (hold && file === hold.path) {
        hold.reached = true;
        await new Promise<void>((release) => {
          hold.release = release;
        });
      }
      return save(file, data);
    };
    const opener = async (url: string) => {
      fx.opened.push(url);
    };
    shell.openExternal = opener;
    if (shell.openExternal !== opener) throw new Error('shell.openExternal could not be replaced');
  }, ROOT);
  const page = await appWindow(app);
  // Safety net only: scriptDialogs keeps dialogs from going native at all.
  page.on('dialog', (dialog) => void dialog.dismiss());
  await page.waitForLoadState('domcontentloaded');
  await scriptDialogs(app, page);
  return { dataDir, app, page };
}

async function close(fx: Fixture | undefined, dataDir: string): Promise<void> {
  if (fx) {
    const blocked = await fx.app
      .evaluate(() => (globalThis as any).__jobFixture.blocked as string[])
      .catch(() => []);
    if (process.env.LISTENER_E2E_SHOW !== '1') {
      // Soft, so a failure earlier in the test keeps its own error.
      const visible = await visibleWindows(fx.app).catch(() => []);
      expect.soft(visible, 'app windows stayed hidden').toEqual([]);
    }
    await fx.app.close();
    // Renderer network stayed fixture-only; record what was refused, if anything.
    if (blocked.length) console.log('Blocked renderer requests:', blocked);
  }
  rmSync(dataDir, { recursive: true, force: true });
}

const stats = (app: ElectronApplication) =>
  app.evaluate(() => {
    const fx = (globalThis as any).__jobFixture;
    return {
      calls: fx.calls.map((c: any) => ({ file: c.file, aborted: c.aborted, settled: c.settled })),
      notion: fx.notion.map((n: any) => n.title),
      slack: fx.slack.map((s: any) => ({
        title: s.title,
        notionUrl: s.notionUrl,
        notionError: s.notionError,
      })),
      opened: fx.opened,
      concat: fx.concat,
    } as {
      calls: Array<{ file: string; aborted: boolean; settled: boolean }>;
      notion: string[];
      slack: Array<{ title: string; notionUrl?: string; notionError?: string }>;
      opened: string[];
      concat: number;
    };
  });

const resolveCall = (app: ElectronApplication, index: number, label: string) =>
  app.evaluate(
    (_e, { index, label }) => {
      const call = (globalThis as any).__jobFixture.calls[index];
      call.settled = true;
      call.resolve({
        transcript: `Speaker 1: ${label} fixture transcript.`,
        summary: `${label} fixture summary.`,
        keyPoints: [],
        actionItems: [],
        suggestedTitle: `${label}`,
      });
    },
    { index, label },
  );

const reloadFromMain = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.webContents.getURL().endsWith('/renderer/index.html')) w.webContents.reload();
    }
  });

const jobsFromMain = (page: Page) => page.evaluate(() => window.electronAPI.getTranscriptionJobs());

function noteMetas(dataDir: string): string[] {
  const dir = join(dataDir, 'transcriptions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !name.startsWith('.'))
    .filter((name) => existsSync(join(dir, name, 'meta.json')))
    .map((name) => join(dir, name));
}

function row(page: Page, audio: string) {
  return page.locator(`.recording-item[data-filepath="${audio}"]`);
}

test('reload, list refresh and a duplicate request keep one provider run, then Cancel works', async () => {
  const dataDir = seed();
  const audio = seedRecording(dataDir, 'Untitled_Meeting');
  let fx: Fixture | undefined;
  try {
    fx = await launch(dataDir);
    const { app, page } = fx;
    await row(page, audio).locator('.transcribe-btn').click();
    await expect.poll(async () => (await stats(app)).calls.length).toBe(1);
    await expect(row(page, audio)).toHaveAttribute('data-transcribing', 'true');

    // Reload from the renderer: the same row shows the running job again.
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(row(page, audio)).toHaveAttribute('data-transcribing', 'true');
    await expect(
      row(page, audio).getByRole('button', { name: 'Cancel transcription' }),
    ).toBeVisible();
    await expect(row(page, audio).locator('.recording-progress-percent')).toHaveText('25%');
    await app.evaluate(() =>
      (globalThis as any).__jobFixture.calls[0].progress(45, 'Still pending after reload'),
    );
    await expect(row(page, audio).locator('.recording-progress-message')).toHaveText(
      'Still pending after reload',
    );

    // Reload driven from main (menu / webContents path).
    await reloadFromMain(app);
    await page.waitForLoadState('domcontentloaded');
    await expect(row(page, audio).locator('.recording-progress-percent')).toHaveText('45%');

    // Recording-list rebuild: a fresh row element follows the same job.
    await row(page, audio).evaluate((el) => {
      (el as HTMLElement).dataset.e2eStale = 'true';
    });
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('recordings-changed');
    });
    await expect(page.locator('[data-e2e-stale]')).toHaveCount(0);
    await expect(row(page, audio)).toHaveAttribute('data-transcribing', 'true');
    await expect(
      row(page, audio).getByRole('button', { name: 'Cancel transcription' }),
    ).toBeVisible();

    // A duplicate request joins the running job.
    await page.evaluate((p) => {
      void window.electronAPI.transcribeAudio(p).then((r) => {
        (window as any).__dup = r;
      });
    }, audio);
    await page.waitForTimeout(300);
    let s = await stats(app);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].aborted).toBe(false);
    const running = await jobsFromMain(page);
    expect(running.jobs.filter((j) => j.status === 'running')).toHaveLength(1);

    await row(page, audio).getByRole('button', { name: 'Cancel transcription' }).click();
    await expect.poll(async () => (await stats(app)).calls[0].aborted).toBe(true);
    await expect(row(page, audio)).not.toHaveAttribute('data-transcribing', /.*/);
    await expect(row(page, audio).locator('.transcribe-btn')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__dup?.cancelled)).toBe(true);
    s = await stats(app);
    expect(s.calls).toHaveLength(1);
    expect(noteMetas(dataDir)).toHaveLength(0);
    const sidecar = JSON.parse(
      readFileSync(join(dataDir, 'metadata', `Untitled_Meeting_${TS}.json`), 'utf8'),
    );
    expect(sidecar.transcriptionPath).toBeUndefined();
    expect(existsSync(audio)).toBe(true);
    const [cancelled] = (await jobsFromMain(page)).jobs;
    expect(cancelled.status).toBe('cancelled');
  } finally {
    await close(fx, dataDir);
  }
});

test('a job completed after reload saves one note and updates the row; regenerate after completion runs again', async () => {
  const dataDir = seed();
  const audio = seedRecording(dataDir, 'Untitled_Meeting');
  const renamed = join(dataDir, 'recordings', `Reload_QA_Title_${TS}.wav`);
  let fx: Fixture | undefined;
  try {
    fx = await launch(dataDir);
    const { app, page } = fx;
    await row(page, audio).locator('.transcribe-btn').click();
    await expect.poll(async () => (await stats(app)).calls.length).toBe(1);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(row(page, audio)).toHaveAttribute('data-transcribing', 'true');

    await resolveCall(app, 0, 'Reload QA Title');
    await expect(
      page.getByRole('button', { name: 'Open transcript for Reload_QA_Title' }),
    ).toBeVisible();
    expect(existsSync(renamed)).toBe(true);
    expect(existsSync(audio)).toBe(false);
    const notes = noteMetas(dataDir);
    expect(notes).toHaveLength(1);
    const sidecar = JSON.parse(
      readFileSync(join(dataDir, 'metadata', `Reload_QA_Title_${TS}.json`), 'utf8'),
    );
    expect(sidecar.transcriptionPath).toBe(notes[0]);
    const meta = JSON.parse(readFileSync(join(notes[0], 'meta.json'), 'utf8'));
    expect(meta.audioFile).toBe(renamed);
    const [done] = (await jobsFromMain(page)).jobs;
    expect(done.status).toBe('succeeded');
    expect(done.generationId).toBe(meta.generationId);

    // Deliberate regenerate after completion is a new run on the same note.
    await page.evaluate((p) => {
      void window.electronAPI.transcribeAudio(p).then((r) => {
        (window as any).__regen = r;
      });
    }, renamed);
    await expect.poll(async () => (await stats(app)).calls.length).toBe(2);
    await resolveCall(app, 1, 'Reload QA Title');
    await expect.poll(() => page.evaluate(() => (window as any).__regen?.success)).toBe(true);
    expect(noteMetas(dataDir)).toEqual(notes);
    expect(readFileSync(join(notes[0], 'summary.md'), 'utf8')).toContain('Reload QA Title fixture');
  } finally {
    await close(fx, dataDir);
  }
});

test('Cancel from the renamed row after reload rolls the rename back before the save', async () => {
  const dataDir = seed();
  const audio = seedRecording(dataDir, 'Untitled_Meeting');
  const renamed = join(dataDir, 'recordings', `Alias_Title_${TS}.wav`);
  let fx: Fixture | undefined;
  try {
    fx = await launch(dataDir);
    const { app, page } = fx;
    // Hold the sidecar move that follows the rename (before the commit).
    await app.evaluate((_e, path) => {
      (globalThis as any).__jobFixture.holdSave = { path, reached: false, release: () => {} };
    }, renamed);
    await row(page, audio).locator('.transcribe-btn').click();
    await expect.poll(async () => (await stats(app)).calls.length).toBe(1);
    await resolveCall(app, 0, 'Alias Title');
    await expect
      .poll(() => app.evaluate(() => (globalThis as any).__jobFixture.holdSave.reached))
      .toBe(true);

    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    // Only the renamed file exists now; its row follows the job by alias.
    await expect(row(page, renamed)).toHaveAttribute('data-transcribing', 'true');
    await row(page, renamed).getByRole('button', { name: 'Cancel transcription' }).click();
    await expect.poll(async () => (await jobsFromMain(page)).jobs[0]?.cancelRequested).toBe(true);
    await app.evaluate(() => (globalThis as any).__jobFixture.holdSave.release());

    await expect.poll(async () => (await jobsFromMain(page)).jobs[0]?.status).toBe('cancelled');
    await expect(row(page, audio).locator('.transcribe-btn')).toBeVisible();
    expect(existsSync(audio)).toBe(true);
    expect(existsSync(renamed)).toBe(false);
    expect(noteMetas(dataDir)).toHaveLength(0);
  } finally {
    await close(fx, dataDir);
  }
});

test('auto-mode Notion and Slack follow-ups survive reloads in every phase and run once', async () => {
  const dataDir = seed({
    notionApiKey: 'secret_fixture',
    notionDatabaseId: 'fixture-database',
    slackWebhookUrl: SLACK_WEBHOOK,
    slackAutoShare: true,
  });
  const audio = seedRecording(dataDir, 'Untitled_Meeting');
  let fx: Fixture | undefined;
  try {
    fx = await launch(dataDir);
    const { app, page } = fx;
    await page.evaluate((p) => {
      void window.electronAPI.transcribeAudio(p, undefined, {
        autoExport: true,
        recordingTitle: 'Untitled_Meeting',
      });
    }, audio);
    await expect.poll(async () => (await stats(app)).calls.length).toBe(1);

    // Reload while transcribing.
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('#statusText')).toHaveText('Auto mode: Processing recording...');
    await expect(page.locator('#recordButton')).toBeDisabled();
    await resolveCall(app, 0, 'Auto Export Title');

    // Reload while the Notion upload is pending.
    await expect.poll(async () => (await stats(app)).notion.length).toBe(1);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('#statusText')).toHaveText('Auto mode: Sending to Notion/Slack...');
    await app.evaluate(() =>
      (globalThis as any).__jobFixture.notion[0].resolve({
        success: true,
        url: 'https://notion.invalid/page-1',
      }),
    );

    // Reload while the Slack send is pending.
    await expect.poll(async () => (await stats(app)).slack.length).toBe(1);
    await reloadFromMain(app);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('#recordButton')).toBeDisabled();
    await app.evaluate(() =>
      (globalThis as any).__jobFixture.slack[0].resolve({
        success: true,
        sentAt: '2026-10-12T05:10:00.000Z',
      }),
    );

    await expect(page.locator('#statusText')).toHaveText('Auto mode: Sent to Notion and Slack.');
    await expect(page.locator('#recordButton')).toBeEnabled();
    const s = await stats(app);
    expect(s.calls).toHaveLength(1);
    expect(s.notion).toEqual(['Auto Export Title by L.AI']);
    expect(s.slack).toEqual([
      {
        title: 'Auto Export Title',
        notionUrl: 'https://notion.invalid/page-1',
        notionError: undefined,
      },
    ]);
    expect(s.opened).toEqual(['https://notion.invalid/page-1']);

    const notes = noteMetas(dataDir);
    expect(notes).toHaveLength(1);
    const meta = JSON.parse(readFileSync(join(notes[0], 'meta.json'), 'utf8'));
    expect(meta.exports.notion.pageUrl).toBe('https://notion.invalid/page-1');
    expect(meta.exports.slack.sentAt).toBe('2026-10-12T05:10:00.000Z');
    const [job] = (await jobsFromMain(page)).jobs;
    expect(job.status).toBe('succeeded');
    expect(job.origin).toBe('auto');
    expect(job.generationId).toBe(meta.generationId);
    expect(job.exports).toEqual({
      notion: { status: 'succeeded', url: 'https://notion.invalid/page-1' },
      slack: { status: 'succeeded' },
    });
  } finally {
    await close(fx, dataDir);
  }
});

test('a Notion failure keeps the saved note and still reaches Slack with the error', async () => {
  const dataDir = seed({
    notionApiKey: 'secret_fixture',
    notionDatabaseId: 'fixture-database',
    slackWebhookUrl: SLACK_WEBHOOK,
    slackAutoShare: true,
  });
  const audio = seedRecording(dataDir, 'Planning');
  let fx: Fixture | undefined;
  try {
    fx = await launch(dataDir);
    const { app, page } = fx;
    await page.evaluate((p) => {
      void window.electronAPI.transcribeAudio(p, undefined, {
        autoExport: true,
        recordingTitle: 'Planning',
      });
    }, audio);
    await expect.poll(async () => (await stats(app)).calls.length).toBe(1);
    await resolveCall(app, 0, 'Planning Notes');
    await expect.poll(async () => (await stats(app)).notion.length).toBe(1);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await app.evaluate(() =>
      (globalThis as any).__jobFixture.notion[0].resolve({
        success: false,
        error: 'Fixture Notion down',
      }),
    );
    await expect.poll(async () => (await stats(app)).slack.length).toBe(1);
    await app.evaluate(() =>
      (globalThis as any).__jobFixture.slack[0].resolve({
        success: true,
        sentAt: '2026-10-12T05:11:00.000Z',
      }),
    );
    await expect(page.locator('#statusText')).toHaveText(
      'Auto mode: Sent to Slack (Notion failed).',
    );

    const s = await stats(app);
    expect(s.slack).toEqual([
      { title: 'Planning', notionUrl: undefined, notionError: 'Fixture Notion down' },
    ]);
    expect(s.opened).toEqual([]);
    const notes = noteMetas(dataDir);
    expect(notes).toHaveLength(1);
    const meta = JSON.parse(readFileSync(join(notes[0], 'meta.json'), 'utf8'));
    expect(meta.exports?.notion).toBeUndefined();
    expect(meta.exports.slack.sentAt).toBe('2026-10-12T05:11:00.000Z');
    const [job] = (await jobsFromMain(page)).jobs;
    expect(job.status).toBe('succeeded');
    expect(job.exports?.notion).toEqual({ status: 'failed', error: 'Fixture Notion down' });
  } finally {
    await close(fx, dataDir);
  }
});

test('a merge reconnects after reload, stays single-flight, and shows its note when done', async () => {
  const dataDir = seed();
  const first = seedRecording(dataDir, 'Part_One');
  const second = seedRecording(dataDir, 'Part_Two');
  let fx: Fixture | undefined;
  try {
    fx = await launch(dataDir);
    const { app, page } = fx;
    await page.evaluate(
      (paths) => {
        void window.electronAPI.mergeRecordings({ paths, title: 'Combined Review' });
      },
      [first, second],
    );
    await expect.poll(async () => (await stats(app)).calls.length).toBe(1);

    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('#transcriptionModal')).toBeVisible();
    await expect(page.locator('#transcriptionTitle')).toHaveText('Merging - Combined Review');
    await expect(page.locator('#transcriptionProgress')).toBeVisible();

    const busy = await page.evaluate(
      (paths) => window.electronAPI.mergeRecordings({ paths }),
      [first, second],
    );
    expect((busy as { code?: string }).code).toBe('merge-busy');

    await resolveCall(app, 0, 'Combined Review Notes');
    await expect(page.locator('#transcriptionTitle')).toHaveText(/^Transcription - /);
    await expect(page.locator('#transcriptionProgress')).toBeHidden();
    await expect(page.locator('#summary')).toContainText('Combined Review Notes fixture summary.');

    const s = await stats(app);
    expect(s.calls).toHaveLength(1);
    expect(s.concat).toBe(1);
    expect(existsSync(first) && existsSync(second)).toBe(true);
    const notes = noteMetas(dataDir);
    expect(notes).toHaveLength(1);
    const [job] = (await jobsFromMain(page)).jobs;
    expect(job.kind).toBe('merge');
    expect(job.status).toBe('succeeded');
    expect(job.transcriptionPath).toBe(notes[0]);
    expect(job.sourcePaths).toEqual([first, second]);
  } finally {
    await close(fx, dataDir);
  }
});

function seedSavedNote(dataDir: string, name: string, summary: string): string {
  const audio = join(dataDir, 'recordings', `${name}_${TS}.wav`);
  writeFileSync(audio, Buffer.alloc(44));
  const { saveTranscription } =
    require('../dist/outputService.js') as typeof import('../src/outputService');
  const folder = saveTranscription({
    title: name,
    result: {
      transcript: 'Speaker 1: Saved note transcript.',
      summary,
      keyPoints: [],
      actionItems: [],
      suggestedTitle: name,
    },
    audioFilePath: audio,
    dataPath: dataDir,
  });
  writeFileSync(
    join(dataDir, 'metadata', `${name}_${TS}.json`),
    JSON.stringify({
      filePath: audio,
      title: name,
      suggestedTitle: name,
      timestamp: '2026-10-12T05:00:00.000Z',
      transcriptionPath: folder,
    }),
  );
  return audio;
}

const callIndex = async (app: ElectronApplication, fragment: string) =>
  (await stats(app)).calls.findIndex((c) => c.file.includes(fragment));

const progressCall = (app: ElectronApplication, index: number, percent: number, message: string) =>
  app.evaluate(
    (_e, { index, percent, message }) =>
      (globalThis as any).__jobFixture.calls[index].progress(percent, message),
    { index, percent, message },
  );

async function expectSavedNoteShown(page: Page): Promise<void> {
  await expect(page.locator('#transcriptionTitle')).toHaveText('Transcription - Saved_Note');
  await expect(page.locator('#summary')).toContainText('Saved note summary only.');
  await expect(page.locator('#summary')).not.toContainText('fixture summary');
  await expect(page.locator('#transcriptionProgress')).toBeHidden();
}

test('with two row jobs and a merge pending, the modal only follows its own job and keeps a newly opened note', async () => {
  const dataDir = seed();
  const rowA = seedRecording(dataDir, 'Row_A');
  const rowE = seedRecording(dataDir, 'Row_E');
  seedRecording(dataDir, 'Part_One');
  const partTwo = seedRecording(dataDir, 'Part_Two');
  seedSavedNote(dataDir, 'Saved_Note', 'Saved note summary only.');
  let fx: Fixture | undefined;
  try {
    fx = await launch(dataDir);
    const { app, page } = fx;
    await row(page, rowA).locator('.transcribe-btn').click();
    await row(page, rowE).locator('.transcribe-btn').click();
    await expect.poll(async () => (await stats(app)).calls.length).toBe(2);

    // Start a merge through the real dialog; the modal now belongs to it.
    await page.getByRole('button', { name: 'More actions for Part_One' }).click();
    await page.getByRole('menuitem', { name: 'Merge with other recordings…' }).click();
    await page.locator(`#mergeList li[data-path="${partTwo}"]`).click();
    await page.locator('#mergeTitleInput').fill('Combined Review');
    await page.locator('#mergeConfirmBtn').click();
    await expect.poll(async () => (await stats(app)).calls.length).toBe(3);
    const merge = await callIndex(app, 'Combined Review_');
    const a = await callIndex(app, 'Row_A');
    const e = await callIndex(app, 'Row_E');
    expect(merge).toBeGreaterThanOrEqual(0);
    await expect(page.locator('#transcriptionTitle')).toHaveText('Merging - Combined Review');

    // Row progress never moves the merge modal; merge progress does.
    await progressCall(app, merge, 50, 'Merge fixture progress');
    await expect(page.locator('#progressText')).toHaveText('Merge fixture progress');
    await progressCall(app, a, 70, 'Row A progress only');
    await progressCall(app, e, 80, 'Row E progress only');
    await expect(row(page, rowA).locator('.recording-progress-message')).toHaveText(
      'Row A progress only',
    );
    await expect(row(page, rowE).locator('.recording-progress-message')).toHaveText(
      'Row E progress only',
    );
    await expect(page.locator('#progressText')).toHaveText('Merge fixture progress');

    // The user leaves the merge and opens another saved note.
    await page.locator('#transcriptionModal .close').click();
    await page.getByRole('button', { name: 'Open transcript for Saved_Note' }).click();
    await expectSavedNoteShown(page);

    // Late progress and completions of every job leave that note on screen.
    await progressCall(app, merge, 90, 'Late merge progress');
    await resolveCall(app, merge, 'Combined Review Notes');
    await expect(page.getByText('Merge complete')).toBeVisible();
    await resolveCall(app, a, 'Row A Done');
    await resolveCall(app, e, 'Row E Done');
    await expect(page.getByRole('button', { name: 'Open transcript for Row_A' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open transcript for Row_E' })).toBeVisible();
    await expectSavedNoteShown(page);
    expect(noteMetas(dataDir)).toHaveLength(4);
    const s = await stats(app);
    expect(s.calls.filter((c) => c.aborted)).toHaveLength(0);
  } finally {
    await close(fx, dataDir);
  }
});

test('a merge modal reconnected after reload yields to a newly opened note while row and merge jobs finish', async () => {
  const dataDir = seed();
  const rowA = seedRecording(dataDir, 'Row_A');
  const partOne = seedRecording(dataDir, 'Part_One');
  const partTwo = seedRecording(dataDir, 'Part_Two');
  seedSavedNote(dataDir, 'Saved_Note', 'Saved note summary only.');
  let fx: Fixture | undefined;
  try {
    fx = await launch(dataDir);
    const { app, page } = fx;
    await row(page, rowA).locator('.transcribe-btn').click();
    await expect.poll(async () => (await stats(app)).calls.length).toBe(1);
    await page.evaluate(
      (paths) => {
        void window.electronAPI.mergeRecordings({ paths, title: 'Combined Review' });
      },
      [partOne, partTwo],
    );
    await expect.poll(async () => (await stats(app)).calls.length).toBe(2);
    const merge = await callIndex(app, 'Combined Review_');
    const a = await callIndex(app, 'Row_A');

    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('#transcriptionTitle')).toHaveText('Merging - Combined Review');
    await expect(row(page, rowA)).toHaveAttribute('data-transcribing', 'true');
    await progressCall(app, a, 70, 'Row A progress only');
    await expect(row(page, rowA).locator('.recording-progress-message')).toHaveText(
      'Row A progress only',
    );
    await expect(page.locator('#progressText')).not.toHaveText('Row A progress only');
    await progressCall(app, merge, 60, 'Reconnected merge progress');
    await expect(page.locator('#progressText')).toHaveText('Reconnected merge progress');

    await page.locator('#transcriptionModal .close').click();
    await page.getByRole('button', { name: 'Open transcript for Saved_Note' }).click();
    await expectSavedNoteShown(page);

    await resolveCall(app, merge, 'Combined Review Notes');
    await expect
      .poll(async () => (await jobsFromMain(page)).jobs.find((j) => j.kind === 'merge')?.status)
      .toBe('succeeded');
    await resolveCall(app, a, 'Row A Done');
    await expect(page.getByRole('button', { name: 'Open transcript for Row_A' })).toBeVisible();
    await expectSavedNoteShown(page);
    expect(noteMetas(dataDir)).toHaveLength(3);
  } finally {
    await close(fx, dataDir);
  }
});

const listChanged = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('recordings-changed');
  });

test('a recording renamed to a name another running job holds keeps both recordings, and Cancel stops only its own job', async () => {
  const dataDir = seed();
  const other = join(dataDir, 'recordings', `Weekly_Sync_Title_${TS}.wav`);
  writeFileSync(other, 'B-audio-bytes');
  const audio = seedRecording(dataDir, 'Untitled_Meeting');
  let fx: Fixture | undefined;
  try {
    fx = await launch(dataDir);
    const { app, page } = fx;
    await row(page, other).locator('.transcribe-btn').click();
    await expect.poll(async () => (await stats(app)).calls.length).toBe(1);
    await row(page, audio).locator('.transcribe-btn').click();
    await expect.poll(async () => (await stats(app)).calls.length).toBe(2);

    // The untitled recording's suggested title produces the other row's name.
    await resolveCall(app, 1, 'Weekly Sync Title');
    await expect(
      page.getByRole('button', { name: 'Open transcript for Untitled_Meeting' }),
    ).toBeVisible();
    expect(readFileSync(other, 'utf8')).toBe('B-audio-bytes');
    expect(existsSync(audio)).toBe(true);
    await expect(row(page, other)).toHaveAttribute('data-transcribing', 'true');

    await row(page, other).getByRole('button', { name: 'Cancel transcription' }).click();
    await expect.poll(async () => (await stats(app)).calls[0].aborted).toBe(true);
    expect((await stats(app)).calls[1].aborted).toBe(false);
    await expect(row(page, other).locator('.transcribe-btn')).toBeVisible();
    expect(readFileSync(other, 'utf8')).toBe('B-audio-bytes');
    const notes = noteMetas(dataDir);
    expect(notes).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(notes[0], 'meta.json'), 'utf8')).audioFile).toBe(audio);
  } finally {
    await close(fx, dataDir);
  }
});

test('a cancelled rename is reconciled in a rebuilt list even without a file-watcher refresh', async () => {
  const dataDir = seed();
  const audio = seedRecording(dataDir, 'Untitled_Meeting');
  const renamed = join(dataDir, 'recordings', `Alias_Title_${TS}.wav`);
  let fx: Fixture | undefined;
  try {
    fx = await launch(dataDir);
    const { app, page } = fx;
    await app.evaluate((_e, path) => {
      (globalThis as any).__jobFixture.holdSave = { path, reached: false, release: () => {} };
    }, renamed);
    await row(page, audio).locator('.transcribe-btn').click();
    await expect.poll(async () => (await stats(app)).calls.length).toBe(1);
    await resolveCall(app, 0, 'Alias Title');
    await expect
      .poll(() => app.evaluate(() => (globalThis as any).__jobFixture.holdSave.reached))
      .toBe(true);
    // Rebuild without a reload: this renderer is still awaiting its request.
    await listChanged(app);
    await expect(row(page, renamed)).toHaveAttribute('data-transcribing', 'true');
    // From here on, only job events reach the renderer.
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) {
        const send = w.webContents.send.bind(w.webContents);
        w.webContents.send = (channel: string, ...args: unknown[]) => {
          if (channel === 'recordings-changed') return;
          send(channel, ...args);
        };
      }
    });
    await row(page, renamed).getByRole('button', { name: 'Cancel transcription' }).click();
    await expect.poll(async () => (await jobsFromMain(page)).jobs[0]?.cancelRequested).toBe(true);
    await app.evaluate(() => (globalThis as any).__jobFixture.holdSave.release());
    await expect.poll(async () => (await jobsFromMain(page)).jobs[0]?.status).toBe('cancelled');
    expect(existsSync(audio)).toBe(true);
    expect(existsSync(renamed)).toBe(false);
    expect(noteMetas(dataDir)).toHaveLength(0);
    await expect(row(page, audio).locator('.transcribe-btn')).toBeVisible();
    await expect(row(page, renamed)).toHaveCount(0);
  } finally {
    await close(fx, dataDir);
  }
});

test('after a reload, Cancel appears while Regenerate waits on the note lock, and the old note is kept', async () => {
  const dataDir = seed();
  const audio = seedSavedNote(dataDir, 'Saved_Note', 'Saved note summary only.');
  const [folder] = noteMetas(dataDir);
  let fx: Fixture | undefined;
  try {
    fx = await launch(dataDir);
    const { app, page } = fx;
    await answerConfirm(page, true);
    await page.getByRole('button', { name: 'More actions for Saved_Note' }).click();
    await page.getByRole('menuitem', { name: 'Regenerate transcript' }).click();
    await expect.poll(async () => (await stats(app)).calls.length).toBe(1);
    expect(await scriptedDialogs(page)).toEqual([
      {
        type: 'confirm',
        message:
          'Are you sure you want to regenerate the transcript? This will overwrite the existing one.',
      },
    ]);
    // Another holder takes the note's real meeting lock before the save.
    await app.evaluate(
      (_e, { root, folder }) => {
        const lock = (process as any).mainModule.require(`${root}/dist/meetingLock.js`);
        const gate = { entered: false, release: () => {} };
        (globalThis as any).__lockGate = gate;
        void lock.withMeetingLock(
          folder,
          () =>
            new Promise<void>((release) => {
              gate.entered = true;
              gate.release = release;
            }),
        );
      },
      { root: ROOT, folder },
    );
    await expect.poll(() => app.evaluate(() => (globalThis as any).__lockGate.entered)).toBe(true);
    await resolveCall(app, 0, 'Replacement');
    await page.waitForTimeout(350);
    expect((await jobsFromMain(page)).jobs[0].status).toBe('running');

    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(
      row(page, audio).getByRole('button', { name: 'Cancel transcription' }),
    ).toBeVisible();
    await row(page, audio).getByRole('button', { name: 'Cancel transcription' }).click();
    await expect.poll(async () => (await jobsFromMain(page)).jobs[0]?.cancelRequested).toBe(true);
    await app.evaluate(() => (globalThis as any).__lockGate.release());
    await expect.poll(async () => (await jobsFromMain(page)).jobs[0]?.status).toBe('cancelled');
    expect(noteMetas(dataDir)).toEqual([folder]);
    expect(readFileSync(join(folder, 'summary.md'), 'utf8')).toContain('Saved note summary only.');
    await expect(
      page.getByRole('button', { name: 'Open transcript for Saved_Note' }),
    ).toBeVisible();
  } finally {
    if (fx) await fx.app.evaluate(() => (globalThis as any).__lockGate?.release()).catch(() => {});
    await close(fx, dataDir);
  }
});

test('the canonical row reconnects to a job started through a symlinked directory', async () => {
  const dataDir = seed();
  const audio = seedRecording(dataDir, 'Canonical_Record');
  const aliasDir = join(dataDir, 'alias-recordings');
  symlinkSync(join(dataDir, 'recordings'), aliasDir);
  const alias = join(aliasDir, `Canonical_Record_${TS}.wav`);
  let fx: Fixture | undefined;
  try {
    fx = await launch(dataDir);
    const { app, page } = fx;
    await page.evaluate((p) => {
      void window.electronAPI.transcribeAudio(p);
    }, alias);
    await expect.poll(async () => (await stats(app)).calls.length).toBe(1);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(row(page, audio)).toHaveAttribute('data-transcribing', 'true');
    await row(page, audio).getByRole('button', { name: 'Cancel transcription' }).click();
    await expect.poll(async () => (await jobsFromMain(page)).jobs[0]?.status).toBe('cancelled');
    await expect(row(page, audio).locator('.transcribe-btn')).toBeVisible();
    expect((await stats(app)).calls).toHaveLength(1);
  } finally {
    await close(fx, dataDir);
  }
});

test('a refused second merge leaves the modal the user closed alone while the first merge finishes', async () => {
  const dataDir = seed();
  // Seeded oldest first, so the list (newest first) shows Part_Three,
  // Part_Two, Part_One above Saved_Note: no merge starts from the last row,
  // whose menu would open at the bottom edge of the window.
  seedSavedNote(dataDir, 'Saved_Note', 'Saved note summary only.');
  const partOne = seedRecording(dataDir, 'Part_One');
  const partTwo = seedRecording(dataDir, 'Part_Two');
  seedRecording(dataDir, 'Part_Three');
  let fx: Fixture | undefined;
  try {
    fx = await launch(dataDir);
    const { app, page } = fx;
    const alerts = async () =>
      (await scriptedDialogs(page)).filter((d) => d.type === 'alert').map((d) => d.message);
    const startMerge = async (from: string, withRow: string, title: string) => {
      await page.getByRole('button', { name: `More actions for ${from}` }).click();
      await page.getByRole('menuitem', { name: 'Merge with other recordings…' }).click();
      await page.locator(`#mergeList li[data-path="${withRow}"]`).click();
      await page.locator('#mergeTitleInput').fill(title);
      await page.locator('#mergeConfirmBtn').click();
    };
    await startMerge('Part_Three', partTwo, 'First Merge');
    await expect.poll(async () => (await stats(app)).calls.length).toBe(1);
    await expect(page.locator('#transcriptionTitle')).toHaveText('Merging - First Merge');
    await page.locator('#transcriptionModal .close').click();
    await expect(page.locator('#transcriptionModal')).toBeHidden();
    // The merged audio file appears in the recordings folder and the list is
    // rebuilt for it. Wait for that row, and for the watcher's debounced
    // refresh to settle, so the next menu is opened on rows that stay put.
    await expect(page.locator('.recording-item', { hasText: 'First Merge' })).toBeVisible();
    await expect(page.locator('.recording-item')).toHaveCount(5);
    await page.waitForTimeout(650);

    await startMerge('Part_Two', partOne, 'Second Merge');
    await expect.poll(async () => (await alerts()).length).toBe(1);
    expect((await alerts())[0]).toContain('Another merge is already running');
    await expect(page.locator('#transcriptionModal')).toBeHidden();
    await progressCall(app, 0, 60, 'First merge progress');
    await page.waitForTimeout(300);
    await expect(page.locator('#transcriptionModal')).toBeHidden();

    await resolveCall(app, 0, 'First Merge Notes');
    await expect
      .poll(async () => (await jobsFromMain(page)).jobs.find((j) => j.kind === 'merge')?.status)
      .toBe('succeeded');
    await expect(page.locator('#transcriptionModal')).toBeHidden();
    expect((await stats(app)).calls).toHaveLength(1);
    await page.getByRole('button', { name: 'Open transcript for Saved_Note' }).click();
    await expectSavedNoteShown(page);
  } finally {
    await close(fx, dataDir);
  }
});

// Picks `source` in the drop zone's file dialog (the native dialog is
// replaced in main) and leaves the imported copy out of every recordings list
// main returns until the provider has been called. The import flow refreshes
// the list and reads the DOM right after the confirmation, so the imported row
// is reliably missing at that moment whatever extra list loads run (startup
// load, the recordings watcher), and the real modal fallback is taken. Once
// the job runs, lists are whole again.
const importWithoutRow = (app: ElectronApplication, source: string) =>
  app.evaluate(({ dialog, ipcMain }, source) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [source] })) as any;
    const fx = (globalThis as any).__jobFixture;
    const list = (ipcMain as any)._invokeHandlers.get('get-recordings');
    if (typeof list !== 'function') throw new Error('get-recordings handler not found');
    ipcMain.removeHandler('get-recordings');
    ipcMain.handle('get-recordings', async (...args: unknown[]) => {
      const result = await list(...args);
      if (fx.calls.length === 0 && Array.isArray(result?.recordings)) {
        result.recordings = result.recordings.filter(
          (r: { path: string }) => !r.path.includes('Imported_Fallback'),
        );
      }
      return result;
    });
  }, source);

test('an imported file whose row is missing falls back to the modal, which yields to a saved note before the job completes', async () => {
  const dataDir = seed();
  seedSavedNote(dataDir, 'Saved_Note', 'Saved note summary only.');
  const source = join(dataDir, 'Imported_Fallback.wav');
  writeFileSync(source, Buffer.alloc(44));
  let fx: Fixture | undefined;
  try {
    fx = await launch(dataDir);
    const { app, page } = fx;
    await expect(
      page.getByRole('button', { name: 'Open transcript for Saved_Note' }),
    ).toBeVisible();
    await importWithoutRow(app, source);
    await answerConfirm(page, true);

    await page.locator('#dragDropZone').click();
    await expect.poll(async () => (await stats(app)).calls.length).toBe(1);
    const dialogs = await scriptedDialogs(page);
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0].type).toBe('confirm');
    expect(dialogs[0].message).toMatch(
      /^Audio file "Imported_Fallback_[^"]+" has been added\. Would you like to transcribe it now\?$/,
    );
    const imported = (await stats(app)).calls[0].file;
    expect(imported).toContain(join(dataDir, 'recordings', 'Imported_Fallback_'));

    await expect(page.locator('#transcriptionModal')).toBeVisible();
    await expect(page.locator('#transcriptionTitle')).toContainText('Imported_Fallback');
    await progressCall(app, 0, 40, 'Fallback pending');
    await expect(page.locator('#progressText')).toHaveText('Fallback pending');

    await page.locator('#transcriptionModal .close').click();
    await page.getByRole('button', { name: 'Open transcript for Saved_Note' }).click();
    await expectSavedNoteShown(page);
    await progressCall(app, 0, 80, 'Late fallback progress');
    await expectSavedNoteShown(page);

    await resolveCall(app, 0, 'Imported Fallback');
    await expect.poll(async () => (await jobsFromMain(page)).jobs[0]?.status).toBe('succeeded');
    await expect(
      page.getByRole('button', { name: /Open transcript for Imported_Fallback/ }),
    ).toBeVisible();
    await expectSavedNoteShown(page);
    expect(noteMetas(dataDir)).toHaveLength(2);
    expect((await stats(app)).calls).toHaveLength(1);
  } finally {
    await close(fx, dataDir);
  }
});

test('declining the import confirmation keeps the imported row and starts no transcription', async () => {
  const dataDir = seed();
  const source = join(dataDir, 'Imported_Declined.wav');
  writeFileSync(source, Buffer.alloc(44));
  let fx: Fixture | undefined;
  try {
    fx = await launch(dataDir);
    const { app, page } = fx;
    await app.evaluate(({ dialog }, source) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [source] })) as any;
    }, source);
    await answerConfirm(page, false);

    await page.locator('#dragDropZone').click();
    await expect.poll(async () => (await scriptedDialogs(page)).length).toBe(1);
    const [prompt] = await scriptedDialogs(page);
    expect(prompt.type).toBe('confirm');
    expect(prompt.message).toMatch(
      /^Audio file "Imported_Declined_[^"]+" has been added\. Would you like to transcribe it now\?$/,
    );
    // A no skips the transcription branch entirely, so once the prompt is
    // logged nothing is left that could start a job.
    const importedRow = page.locator('.recording-item', { hasText: 'Imported_Declined' });
    await expect(importedRow.locator('.transcribe-btn')).toBeVisible();
    await expect(page.locator('#transcriptionModal')).toBeHidden();
    expect((await stats(app)).calls).toHaveLength(0);
    expect((await jobsFromMain(page)).jobs).toHaveLength(0);
    expect(noteMetas(dataDir)).toHaveLength(0);
  } finally {
    await close(fx, dataDir);
  }
});
