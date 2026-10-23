import type {} from '../renderer/electronAPI';
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ReusableApp } from './support/reusable-app';
import { visibleWindows } from './support/dialogs';

const meetingApp = new ReusableApp('meeting-list');
test.afterAll(async () => meetingApp.close());

test('note-only meetings open by keyboard and refresh without audio actions', async () => {
  const dataDir = meetingApp.seed({ aiProvider: 'gemini', geminiApiKey: 'e2e-unused' });
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
  const dataDir = meetingApp.seed({ aiProvider: 'gemini', geminiApiKey: 'e2e-unused' });
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
      const fs = require('node:fs') as typeof import('node:fs');
      const recordings = require('node:path').join(app.getPath('userData'), 'recordings');
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
