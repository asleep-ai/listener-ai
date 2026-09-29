import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('dragging in the saved transcript previews a reversible tail cutoff', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'listener-cutoff-e2e-'));
  const transcript = [
    'Speaker 1: We agreed to ship the draft on Friday.',
    'Speaker 2: The budget remains unchanged.',
    'Speaker 1: Unrelated conversation after the meeting ended.',
  ].join('\n');
  const audioPath = join(dataDir, 'recordings', 'Cutoff_QA_2026-09-29T02-43-29-413Z.wav');
  mkdirSync(join(dataDir, 'recordings'));
  mkdirSync(join(dataDir, 'metadata'));
  writeFileSync(audioPath, Buffer.alloc(44));

  // The compiled writer produces the same saved-note layout the app reads.
  const { saveTranscription } =
    require('../dist/outputService.js') as typeof import('../src/outputService');
  const folder = saveTranscription({
    title: 'Cutoff QA',
    result: {
      transcript,
      summary: 'Draft ships Friday. Budget unchanged.',
      keyPoints: [],
      actionItems: [],
    },
    audioFilePath: audioPath,
    dataPath: dataDir,
  });
  writeFileSync(
    join(dataDir, 'metadata', 'Cutoff_QA_2026-09-29T02-43-29-413Z.json'),
    JSON.stringify({
      filePath: audioPath,
      title: 'Cutoff QA',
      suggestedTitle: 'Cutoff QA',
      timestamp: '2026-09-29T02:43:29.413Z',
      transcriptionPath: folder,
    }),
  );
  const metaPath = join(folder, 'meta.json');
  const transcriptPath = join(folder, 'transcript.md');
  const originalMeta = readFileSync(metaPath, 'utf8');
  const originalTranscript = readFileSync(transcriptPath, 'utf8');

  const electronApp = await electron.launch({
    executablePath: require('electron') as string,
    args: ['.', '--disable-gpu', '--no-sandbox'],
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test', LISTENER_DATA_PATH: dataDir },
  });
  try {
    const window = await electronApp.firstWindow();
    window.on('dialog', (dialog) => void dialog.dismiss());
    await window.waitForLoadState('domcontentloaded');
    await window.getByRole('button', { name: 'Open transcript for Cutoff_QA' }).click();
    await window.locator('[data-tab="transcript"]').click();

    const tail = window.locator('#transcriptText [data-start]').last();
    const box = await tail.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;
    const y = box.y + box.height / 2;
    await window.mouse.move(box.x + 2, y);
    await window.mouse.down();
    await window.mouse.move(box.x + Math.min(250, box.width - 2), y, { steps: 12 });
    await window.mouse.up();
    expect(await window.evaluate(() => window.getSelection()?.toString().trim())).not.toBe('');

    await window.locator('[data-cutoff-action="selection"]').click();
    await expect(window.locator('.transcript-cutoff-marker.pending')).toBeVisible();
    await expect(window.getByRole('group', { name: 'Excluded from the report' })).toContainText(
      'Unrelated conversation',
    );
    await expect(window.locator('#transcriptCutoffStatus')).toContainText('Not applied yet');
    expect(readFileSync(metaPath, 'utf8')).toBe(originalMeta);
    expect(readFileSync(transcriptPath, 'utf8')).toBe(originalTranscript);
  } finally {
    await electronApp.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('reopened cut report uses its new title and does not revive old sidecar fields', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'listener-cutoff-reopen-'));
  const transcript = 'Speaker 1: We agreed to ship Friday.\nSpeaker 2: Unrelated tail topic.';
  const audioPath = join(dataDir, 'recordings', 'Old_Title_2026-09-29T02-43-29-413Z.wav');
  mkdirSync(join(dataDir, 'recordings'));
  mkdirSync(join(dataDir, 'metadata'));
  writeFileSync(audioPath, Buffer.alloc(44));
  const { saveTranscription } =
    require('../dist/outputService.js') as typeof import('../src/outputService');
  const { createTranscriptCutoff } =
    require('../dist/transcriptCutoff.js') as typeof import('../src/transcriptCutoff');
  const folder = saveTranscription({
    title: 'Old Title',
    result: {
      transcript,
      summary: 'Original summary.',
      keyPoints: [],
      actionItems: [],
      suggestedTitle: 'Old Title',
      customFields: { decisions: ['TAIL_SECRET'] },
    },
    audioFilePath: audioPath,
    dataPath: dataDir,
  });
  const metaPath = join(folder, 'meta.json');
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  meta.title = 'New Title';
  meta.suggestedTitle = 'New Title';
  meta.transcriptCutoff = createTranscriptCutoff(transcript, transcript.indexOf('Speaker 2:'));
  delete meta.customFields;
  writeFileSync(metaPath, JSON.stringify(meta));
  writeFileSync(join(folder, 'summary.md'), 'We agreed to ship Friday.\n');
  writeFileSync(
    join(dataDir, 'metadata', 'Old_Title_2026-09-29T02-43-29-413Z.json'),
    JSON.stringify({
      filePath: audioPath,
      title: 'Old Title',
      suggestedTitle: 'Old Title',
      customFields: { decisions: ['TAIL_SECRET'] },
      timestamp: '2026-09-29T02:43:29.413Z',
      transcriptionPath: folder,
    }),
  );

  const electronApp = await electron.launch({
    executablePath: require('electron') as string,
    args: ['.', '--disable-gpu', '--no-sandbox'],
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test', LISTENER_DATA_PATH: dataDir },
  });
  try {
    const window = await electronApp.firstWindow();
    window.on('dialog', (dialog) => void dialog.dismiss());
    await window.waitForLoadState('domcontentloaded');
    await window.getByRole('button', { name: 'Open transcript for Old_Title' }).click();
    await expect(window.locator('#transcriptionTitle')).toHaveText('Transcription - New Title');
    await expect(window.getByText('TAIL_SECRET')).toHaveCount(0);
    await window.locator('[data-tab="transcript"]').click();
    await expect(window.getByRole('group', { name: 'Excluded from the report' })).toContainText(
      'Unrelated tail topic',
    );
  } finally {
    await electronApp.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
