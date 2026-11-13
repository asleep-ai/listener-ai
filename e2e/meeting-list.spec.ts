import type {} from '../renderer/electronAPI';
import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ReusableApp } from './support/reusable-app';
import { answerConfirm, scriptDialogs, scriptedDialogs, visibleWindows } from './support/dialogs';
import { fakeDriveState, installFakeDrive, uninstallFakeDrive } from './support/fake-drive';
import { SYNTHETIC_GOOGLE_OAUTH } from './support/packaged-guards';

// With LISTENER_SMOKE_BUILD_DIR set (CI package-check and the macOS test
// build), the same cases run against the packaged executable and its ASAR, so
// Drive-backed storage is verified on the artifact under test, not only dev.
const meetingApp = new ReusableApp('meeting-list', {
  packaged: Boolean(process.env.LISTENER_SMOKE_BUILD_DIR),
});
test.afterAll(async () => meetingApp.close());

test('note-only meetings open by keyboard and refresh without audio actions', async () => {
  const dataDir = meetingApp.seed({ aiProvider: 'gemini', geminiApiKey: 'synthetic-unused-key' });
  const { saveTranscription } =
    require('../dist/outputService.js') as typeof import('../src/outputService');
  const save = (title: string, audioFilePath?: string) =>
    saveTranscription({
      title,
      audioFilePath,
      dataPath: dataDir,
      result: {
        emoji: '',
        transcript: 'Saved speech',
        summary: `${title} summary`,
        keyPoints: [],
        actionItems: [],
      },
    });
  const audio = join(dataDir, 'recordings', 'Local_2026-10-23.wav');
  mkdirSync(join(dataDir, 'recordings'), { recursive: true });
  mkdirSync(join(dataDir, 'metadata'), { recursive: true });
  writeFileSync(audio, Buffer.alloc(44));
  const linked = save('Local', audio);
  writeFileSync(
    join(dataDir, 'metadata', 'Local_2026-10-23.json'),
    JSON.stringify({ filePath: audio, transcriptionPath: linked }),
  );
  const remote = save('Remote', '/other-device/missing.wav');
  writeFileSync(
    join(remote, 'live-hints.json'),
    JSON.stringify({
      version: 1,
      recordingId: 'missing.wav',
      sessions: [
        {
          sessionId: 'note-only',
          startedAt: '2026-10-23T00:00:00Z',
          recordingOffsetMs: 0,
          hints: [
            {
              id: 'retained-cue',
              sessionId: 'note-only',
              kind: 'term',
              text: 'Hint retained after audio deletion',
              basis: ['transcript'],
              sourceState: 'final',
              sourceSegmentIds: [],
              sources: [],
              trigger: 'auto',
              revision: 0,
              createdAt: '2026-10-23T00:00:00Z',
              offsetMs: 100,
            },
          ],
        },
      ],
    }),
  );
  const { app, page } = await meetingApp.start();
  try {
    await expect(page.locator('.recording-item')).toHaveCount(2);
    const row = page.locator('[data-note-path]').filter({ hasText: 'Remote' });
    await expect(row).toContainText('Audio not on this device');
    await expect(row.locator('.transcribe-btn, .more-actions-btn, [data-filepath]')).toHaveCount(0);
    await row.focus();
    await row.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    // A completed IPC round trip settles any incorrectly triggered open.
    await page.evaluate(async (folder) => {
      await window.electronAPI.getSavedNote(folder);
    }, remote);
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await row.press('Enter');
    await expect(page.locator('#summary')).toContainText('Remote summary');
    await page.evaluate(() =>
      (document.querySelector('dialog[open]') as HTMLDialogElement)?.close(),
    );
    await row.focus();
    await row.press('Space');
    await expect(page.locator('dialog[open]')).toHaveCount(1);
    await expect(page.locator('#summary')).toContainText('Remote summary');
    const payload = await page.evaluate(
      async (folder) => window.electronAPI.getSavedNote(folder),
      remote,
    );
    expect(payload.data.transcriptionPath).toBe(remote);
    expect(payload.data.generationId).toBeDefined();
    expect(payload.data.liveHints?.sessions[0].hints[0].text).toBe(
      'Hint retained after audio deletion',
    );
    await expect(page.locator('#recordingHints')).toContainText(
      'Hint retained after audio deletion',
    );
    const outside = await page.evaluate(
      async (folder) => window.electronAPI.getSavedNote(folder),
      dataDir,
    );
    expect(outside.success).toBe(false);
    const root = join(dataDir, 'transcriptions');
    expect(
      (await page.evaluate(async (folder) => window.electronAPI.getSavedNote(folder), root))
        .success,
    ).toBe(false);
    const escaped = join(root, 'outside-link');
    symlinkSync(dataDir, escaped, 'dir');
    expect(
      (await page.evaluate(async (folder) => window.electronAPI.getSavedNote(folder), escaped))
        .success,
    ).toBe(false);
    // A symlinked data root must still return the configured spelling the
    // lexical export/cutoff guards compare against.
    const aliasRoot = join(dataDir, 'linked-data-root');
    symlinkSync(dataDir, aliasRoot, 'dir');
    const aliasFolder = join(aliasRoot, 'transcriptions', basename(remote));
    const aliased = await app.evaluate(
      async ({ app, ipcMain }, { root, folder }) => {
        const original = app.getPath('userData');
        app.setPath('userData', root);
        try {
          return (await (ipcMain as any)._invokeHandlers.get('get-saved-note')({}, folder)) as {
            success: boolean;
            data?: { transcriptionPath: string };
          };
        } finally {
          app.setPath('userData', original);
        }
      },
      { root: aliasRoot, folder: aliasFolder },
    );
    expect(aliased.success).toBe(true);
    expect(aliased.data?.transcriptionPath).toBe(aliasFolder);
    await page.evaluate(() =>
      (document.querySelector('dialog[open]') as HTMLDialogElement)?.close(),
    );
    await row.focus();
    const downloaded = save('Downloaded');
    const downloadedMeta = join(downloaded, 'meta.json');
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const meta = JSON.parse(readFileSync(downloadedMeta, 'utf8'));
    meta.transcribedAt = '2099-01-01T00:00:00Z';
    writeFileSync(downloadedMeta, JSON.stringify(meta));
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.send('recordings-changed');
    });
    await expect(page.locator('.recording-item')).toHaveCount(3);
    await expect(page.locator('.recording-item').first()).toContainText('Downloaded');
    await expect(row).toBeFocused();
    await page.locator('#searchInput').fill('Remote');
    await expect(page.locator('.search-result-item')).toHaveCount(1);
    save('Remote follow-up');
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.send('recordings-changed');
    });
    await expect(page.locator('#searchInput')).toHaveValue('Remote');
    await expect(page.locator('.search-result-item')).toHaveCount(2);
    expect(await visibleWindows(app)).toEqual([]);
  } finally {
    await meetingApp.finish();
  }
});

test('saved meetings remain available without a recordings directory', async () => {
  const dataDir = meetingApp.seed({ aiProvider: 'gemini', geminiApiKey: 'synthetic-unused-key' });
  const { saveTranscription } =
    require('../dist/outputService.js') as typeof import('../src/outputService');
  saveTranscription({
    title: 'Note without recordings',
    dataPath: dataDir,
    result: {
      emoji: '',
      transcript: 'Speech',
      summary: 'Saved summary',
      keyPoints: [],
      actionItems: [],
    },
  });
  const { app, page } = await meetingApp.start();
  try {
    // Simulate the missing-directory branch without replacing the shared
    // process's watched directory inode.
    const result = await app.evaluate(async ({ app, ipcMain }) => {
      // Playwright evaluates this outside a CommonJS scope, so require is undefined.
      const fs = process.getBuiltinModule('node:fs');
      const recordings = process
        .getBuiltinModule('node:path')
        .join(app.getPath('userData'), 'recordings');
      const original = fs.existsSync;
      fs.existsSync = (candidate) => (candidate === recordings ? false : original(candidate));
      try {
        return (await (ipcMain as any)._invokeHandlers.get('get-recordings')({})) as {
          success: boolean;
          recordings: unknown[];
          notes: unknown[];
        };
      } finally {
        fs.existsSync = original;
      }
    });
    expect(result.success).toBe(true);
    expect(result.recordings).toEqual([]);
    expect(result.notes).toHaveLength(1);
    await expect(page.locator('[data-note-path]')).toHaveCount(1);
    await page.locator('[data-note-path]').press('Enter');
    await expect(page.locator('dialog[open]')).toHaveCount(1);
    await expect(page.locator('#summary')).toContainText('Saved summary');
  } finally {
    await meetingApp.finish();
  }
});

test('Drive-backed storage: cloud-only rows, local-only actions, and the storage setting', async () => {
  const dataDir = meetingApp.seed({ aiProvider: 'gemini', geminiApiKey: 'synthetic-unused-key' });
  const fs = require('node:fs') as typeof import('node:fs');
  const crypto = require('node:crypto') as typeof import('node:crypto');
  const { saveTranscription } =
    require('../dist/outputService.js') as typeof import('../src/outputService');
  const recordings = join(dataDir, 'recordings');
  mkdirSync(recordings, { recursive: true });
  mkdirSync(join(dataDir, 'metadata'), { recursive: true });
  const save = (title: string, audioFilePath: string) =>
    saveTranscription({
      title,
      audioFilePath,
      dataPath: dataDir,
      result: {
        emoji: '',
        transcript: 'Speech',
        summary: `${title} summary`,
        keyPoints: [],
        actionItems: [],
      },
    });
  const sidecar = (audio: string, note: string) =>
    writeFileSync(
      join(dataDir, 'metadata', `${basename(audio).replace(/\.webm$/, '')}.json`),
      JSON.stringify({ filePath: audio, title: basename(note), transcriptionPath: note }),
    );

  // Backed up: on disk, with a matching recorded Drive copy.
  const backedAudio = join(recordings, 'Backed_2026-09-01T00-00-00-000Z.webm');
  writeFileSync(backedAudio, Buffer.from('backed audio'));
  const backed = save('Backed', backedAudio);
  sidecar(backedAudio, backed);
  // Cloud-only: removed locally, sidecar still links the note.
  const cloudAudio = join(recordings, 'Cloud_2026-09-02T00-00-00-000Z.webm');
  const cloud = save('Cloud', cloudAudio);
  sidecar(cloudAudio, cloud);
  // From another device: absolute path that does not exist here.
  const foreign = save('Foreign', '/other-device/recordings/Foreign_2026-09-03T00-00-00-000Z.webm');

  const stat = fs.statSync(backedAudio);
  const entry = (id: string, extra: Record<string, unknown>) => ({
    driveFileId: id,
    localMtimeMs: 0,
    mimeType: 'audio/webm',
    lastUploadedAt: '2026-09-01T00:00:00Z',
    ...extra,
  });
  writeFileSync(
    join(dataDir, 'sync-state.json'),
    JSON.stringify({
      version: 1,
      appFolderName: 'Listener.AI',
      meetings: {
        [basename(backed)]: {
          driveFolderId: 'folder-b',
          lastSyncedAt: '2026-09-01T00:00:00Z',
          files: {
            [basename(backedAudio)]: entry('file-b', {
              sourceAudio: true,
              localMtimeMs: stat.mtimeMs,
              size: stat.size,
              md5Checksum: crypto
                .createHash('md5')
                .update(fs.readFileSync(backedAudio))
                .digest('hex'),
            }),
          },
        },
        [basename(cloud)]: {
          driveFolderId: 'folder-c',
          lastSyncedAt: '2026-09-01T00:00:00Z',
          files: {
            [basename(cloudAudio)]: entry('file-c', {
              sourceAudio: true,
              cloudOnly: true,
              size: 4096,
            }),
          },
        },
        [basename(foreign)]: {
          driveFolderId: 'folder-f',
          lastSyncedAt: '2026-09-01T00:00:00Z',
          files: {
            'Foreign_2026-09-03T00-00-00-000Z.webm': entry('file-f', {
              cloudOnly: true,
              size: 2048,
            }),
          },
        },
      },
    }),
  );

  const { app, page } = await meetingApp.start();
  try {
    const cloudRow = page.locator('.recording-item').filter({ hasText: 'Cloud' });
    await expect(cloudRow).toContainText('In Google Drive, not on this device');
    await expect(cloudRow.locator('.download-audio-btn')).toHaveCount(1);
    await expect(cloudRow.locator('.free-local-btn')).toHaveCount(0);

    const backedRow = page.locator('.recording-item').filter({ hasText: 'Backed' });
    await expect(backedRow.locator('.free-local-btn')).toHaveText('Remove local copy…');
    await expect(backedRow.locator('.download-audio-btn')).toHaveCount(0);

    const foreignRow = page.locator('[data-note-path]').filter({ hasText: 'Foreign' });
    await expect(foreignRow).toContainText('Audio in Google Drive');
    const download = foreignRow.getByRole('button', { name: /Download audio for Foreign/ });
    await expect(download).toBeVisible();
    // Keyboard reachable; signed out, the download is refused and nothing is written.
    await download.focus();
    await download.press('Enter');
    await expect(page.locator('.toast')).toContainText('Sign in to Google Drive');
    expect(fs.readdirSync(recordings).sort()).toEqual([basename(backedAudio)]);

    // Removal is refused while signed out and never touches the note.
    const refused = await page.evaluate(
      async (p) => window.electronAPI.freeLocalAudio({ paths: [p] }),
      backedAudio,
    );
    expect(refused.success).toBe(false);
    expect(fs.existsSync(backedAudio)).toBe(true);

    const report = await page.evaluate(() => window.electronAPI.getLocalStorageReport());
    expect(report.success).toBe(true);
    if (report.success) {
      expect(report.report.eligibleFiles).toBe(1);
      expect(report.report.cloudOnlyFiles).toBe(2);
      expect(report.offloadAfterDays).toBe(0);
    }

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Integrations' }).click();
    await expect(page.locator('#localStorageReport')).toContainText('in total');
    await expect(page.locator('#localStorageReport')).toContainText('Sign in to Google Drive');
    await expect(page.locator('#audioOffloadAfterDays')).toHaveValue('');
    await expect(page.locator('#freeLocalAudioNow')).toBeDisabled();
    await page.locator('#audioOffloadAfterDays').selectOption('30');
    await page.locator('#saveConfig').click();
    await expect(page.locator('#configModal')).toBeHidden();
    const config = JSON.parse(fs.readFileSync(join(dataDir, 'config.json'), 'utf8'));
    expect(config.audioOffloadAfterDays).toBe(30);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Integrations' }).click();
    await expect(page.locator('#audioOffloadAfterDays')).toHaveValue('30');
    await page.locator('#cancelConfig').click();
    expect(await visibleWindows(app)).toEqual([]);
  } finally {
    await meetingApp.finish();
  }
});

test('signed in with a fake Drive: free locally, merge downloads first, free all, download again', async () => {
  const dataDir = meetingApp.seed({
    aiProvider: 'gemini',
    geminiApiKey: 'synthetic-unused-key',
    googleDriveEnabled: false,
    googleOAuth: { ...SYNTHETIC_GOOGLE_OAUTH, expires: Date.now() + 24 * 60 * 60 * 1000 },
  });
  const fs = require('node:fs') as typeof import('node:fs');
  const { saveTranscription } =
    require('../dist/outputService.js') as typeof import('../src/outputService');
  const recordings = join(dataDir, 'recordings');
  mkdirSync(recordings, { recursive: true });
  mkdirSync(join(dataDir, 'metadata'), { recursive: true });
  const meeting = (title: string) => {
    const audio = join(recordings, `${title}_2026-10-0${title.length}T00-00-00-000Z.webm`);
    writeFileSync(audio, Buffer.from(`${title} audio `.repeat(64)));
    const note = saveTranscription({
      title,
      audioFilePath: audio,
      dataPath: dataDir,
      result: {
        emoji: '',
        transcript: 'Speech',
        summary: `${title} summary`,
        keyPoints: [],
        actionItems: [],
      },
    });
    writeFileSync(
      join(recordings, '..', 'metadata', `${basename(audio).replace(/\.webm$/, '')}.json`),
      JSON.stringify({ filePath: audio, title, transcriptionPath: note }),
    );
    return { audio, bytes: fs.readFileSync(audio) };
  };
  const alpha = meeting('Alpha');
  const bravo = meeting('Bravo');

  const { app, page } = await meetingApp.start();
  try {
    // Before the first Drive request of the case; the packaged fetch/https
    // guards record any request that would bypass it.
    await installFakeDrive(app);
    await scriptDialogs(app, page);
    const synced = await page.evaluate(() => window.electronAPI.syncGoogleDriveNow());
    expect(synced.success).toBe(true);
    expect((await fakeDriveState(app)).names).toEqual(
      expect.arrayContaining([basename(alpha.audio), basename(bravo.audio)]),
    );
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('recordings-changed');
    });

    // Manual local-only removal from the row menu, confirmed in the dialog.
    const alphaRow = page.locator('.recording-item').filter({ hasText: 'Alpha' });
    await expect(alphaRow.locator('.free-local-btn')).toHaveCount(1);
    await answerConfirm(page, true);
    await alphaRow.locator('.more-actions-btn').click();
    await alphaRow.locator('.free-local-btn').click();
    await expect.poll(() => fs.existsSync(alpha.audio)).toBe(false);
    await expect(page.locator('.toast')).toContainText('Removed local audio');
    await expect(alphaRow).toContainText('In Google Drive, not on this device');
    expect(
      (await scriptedDialogs(page)).some((d) => /Remove the audio of "Alpha/.test(d.message)),
    ).toBe(true);
    expect((await fakeDriveState(app)).trashed).toEqual([]);

    // Merge from Bravo with cloud-only Alpha: the request names Alpha's path
    // as is, and main downloads it as the merge job's first step (so the
    // merge survives a reload). The merge handler is swapped for a recorder
    // that runs that same main restore (restoreRecordingAudio, which the merge
    // job calls; see transcription.jobs.test) and no transcription provider.
    await app.evaluate(({ app, ipcMain }) => {
      const handlers = (ipcMain as any)._invokeHandlers;
      const gg = globalThis as any;
      const { createRequire } = process.getBuiltinModule('node:module');
      const pathm = process.getBuiltinModule('node:path');
      const req = createRequire(pathm.join(app.getAppPath(), 'dist', 'main.js'));
      const { restoreRecordingAudio } = req('./ipc/googleDrive.js');
      gg.__e2eMergeCalls = [];
      gg.__e2eMergeOriginal = handlers.get('merge-recordings');
      handlers.set('merge-recordings', async (_e: unknown, opts: { paths: string[] }) => {
        const fsm = process.getBuiltinModule('node:fs');
        const existBefore = opts.paths.map((p) => fsm.existsSync(p));
        for (const p of opts.paths) if (!fsm.existsSync(p)) await restoreRecordingAudio(p);
        gg.__e2eMergeCalls.push({
          paths: opts.paths,
          existBefore,
          exist: opts.paths.map((p) => fsm.existsSync(p)),
        });
        return { success: false, error: 'e2e merge recorder' };
      });
    });
    const bravoRow = page.locator('.recording-item').filter({ hasText: 'Bravo' });
    await bravoRow.locator('.more-actions-btn').click();
    await bravoRow.locator('.merge-btn').click();
    await expect(page.locator('#mergeModal')).toBeVisible();
    const alphaChoice = page.locator(`#mergeList li[data-path="${alpha.audio}"]`);
    await expect(alphaChoice).toContainText('In Google Drive (downloads when merged)');
    await alphaChoice.click();
    await page.locator('#mergeConfirmBtn').click();
    await expect
      .poll(() => app.evaluate(() => ((globalThis as any).__e2eMergeCalls ?? []).length))
      .toBe(1);
    const [call] = await app.evaluate(() => (globalThis as any).__e2eMergeCalls);
    expect(call.paths).toContain(alpha.audio);
    expect(call.existBefore).toContain(false); // the renderer no longer pre-downloads
    expect(call.exist).toEqual([true, true]);
    expect(fs.readFileSync(alpha.audio)).toEqual(alpha.bytes);

    // The downloaded copy counts as backed up only after a sync re-checks it
    // against Drive (no upload: the bytes already match).
    const uploadsBefore = (await fakeDriveState(app)).uploads.length;
    expect((await page.evaluate(() => window.electronAPI.syncGoogleDriveNow())).success).toBe(true);
    expect((await fakeDriveState(app)).uploads.length).toBe(uploadsBefore);

    // Settings: free everything backed up, totals refresh.
    await page.evaluate(() =>
      (document.querySelectorAll('dialog[open]') as NodeListOf<HTMLDialogElement>).forEach((d) =>
        d.close(),
      ),
    );
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Integrations' }).click();
    await expect(page.locator('#localStorageReport')).toContainText('can be freed');
    await answerConfirm(page, true);
    await page.locator('#freeLocalAudioNow').click();
    await expect(page.locator('#freeLocalAudioStatus')).toContainText('Freed');
    await expect(page.locator('#localStorageReport')).toContainText('in Google Drive only');
    expect(fs.existsSync(alpha.audio)).toBe(false);
    expect(fs.existsSync(bravo.audio)).toBe(false);
    await page.locator('#cancelConfig').click();

    // Download again from the row menu; the bytes match.
    await bravoRow.locator('.more-actions-btn').click();
    await bravoRow.locator('.download-audio-btn').click();
    await expect.poll(() => fs.existsSync(bravo.audio)).toBe(true);
    expect(fs.readFileSync(bravo.audio)).toEqual(bravo.bytes);
    await expect(bravoRow).not.toContainText('In Google Drive');
    expect((await fakeDriveState(app)).trashed).toEqual([]);
    expect(await visibleWindows(app)).toEqual([]);
  } finally {
    await app.evaluate(({ ipcMain }) => {
      const gg = globalThis as any;
      if (gg.__e2eMergeOriginal) {
        (ipcMain as any)._invokeHandlers.set('merge-recordings', gg.__e2eMergeOriginal);
      }
      delete gg.__e2eMergeOriginal;
      delete gg.__e2eMergeCalls;
    });
    await uninstallFakeDrive(app);
    await meetingApp.finish();
  }
});

// Automatic sync is owned by main: with the window never touched and Settings
// never opened, the periodic scheduler transfers files once sync is enabled on
// disk (the way `listener config set googleDriveEnabled true` does it), and the
// main window's status line reports it.
test('Drive syncs on its own schedule with Settings never opened', async () => {
  test.setTimeout(150_000);
  const dataDir = meetingApp.seed({
    aiProvider: 'gemini',
    geminiApiKey: 'synthetic-unused-key',
    googleDriveEnabled: false,
    googleOAuth: { ...SYNTHETIC_GOOGLE_OAUTH, expires: Date.now() + 24 * 60 * 60 * 1000 },
  });
  const { saveTranscription } =
    require('../dist/outputService.js') as typeof import('../src/outputService');
  const recordings = join(dataDir, 'recordings');
  mkdirSync(recordings, { recursive: true });
  const audio = join(recordings, 'Scheduled_2026-10-05T00-00-00-000Z.webm');
  writeFileSync(audio, Buffer.from('Scheduled audio '.repeat(64)));
  saveTranscription({
    title: 'Scheduled',
    audioFilePath: audio,
    dataPath: dataDir,
    result: { emoji: '', transcript: 'Speech', summary: 'S', keyPoints: [], actionItems: [] },
  });
  const configPath = join(dataDir, 'config.json');
  const writeEnabled = (enabled: boolean) => {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    writeFileSync(configPath, JSON.stringify({ ...config, googleDriveEnabled: enabled }));
  };

  const { app, page } = await meetingApp.start();
  try {
    await installFakeDrive(app);
    await expect(page.locator('#driveSyncStatus')).toBeHidden();
    writeEnabled(true); // outside this process; its cached config still says off

    await expect
      .poll(async () => (await fakeDriveState(app)).names, { timeout: 75_000, intervals: [1_000] })
      .toContain(basename(audio));
    await expect(page.locator('#driveSyncStatus')).toHaveText(/^Google Drive: Synced /, {
      timeout: 75_000,
    });
    expect(await page.evaluate(() => (document.getElementById('configModal') as HTMLDialogElement).open)).toBe(false);
    expect(await visibleWindows(app)).toEqual([]);
  } finally {
    writeEnabled(false);
    await expect
      .poll(async () => (await page.evaluate(() => window.electronAPI.getGoogleSyncStatus())).inFlight, {
        timeout: 30_000,
      })
      .toBe(false);
    await uninstallFakeDrive(app);
    await meetingApp.finish();
  }
});
