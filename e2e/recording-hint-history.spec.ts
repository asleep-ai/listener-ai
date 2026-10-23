import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RecordingLiveHintsV1 } from '../src/liveHintTypes';
import {
  assertHidden,
  captureNative,
  EVIDENCE,
  closeIntegratedHints,
  launchIntegratedHints,
  preserveFirstFailure,
  resizeNative,
} from './integrated-hints-fixture';

test('recording history reads actual disk through IPC and reopens after renderer reload', async () => {
  const { app, page, dataDir } = await launchIntegratedHints();
  try {
    const recordings = join(dataDir, 'recordings');
    const metadata = join(dataDir, 'metadata');
    mkdirSync(recordings, { recursive: true });
    mkdirSync(metadata, { recursive: true });
    const filePath = join(recordings, 'SavedHints_20261021.webm');
    const legacyPath = join(recordings, 'Legacy_20261021.webm');
    // Discovery fixtures only: never decoded, played, recorded, or uploaded.
    writeFileSync(filePath, 'isolated dummy audio fixture');
    writeFileSync(legacyPath, 'isolated legacy audio fixture');
    const history: RecordingLiveHintsV1 = {
      version: 1,
      recordingId: 'SavedHints_20261021.webm',
      truncated: true,
      sessions: [
        {
          sessionId: 'saved-session',
          startedAt: '2026-10-21T01:00:00Z',
          recordingOffsetMs: 7320000,
          hints: [
            {
              id: 'saved-cue',
              sessionId: 'saved-session',
              kind: 'action',
              title: '<img onerror=boom> 장시간 한국어 회의 실행 항목과 담당자 일정 확인',
              text: '사용자 예제와 비교할 제안입니다.',
              detail: '확정된 실행 항목이 아닙니다.',
              basis: ['transcript', 'model-knowledge', 'suggestion'],
              sourceState: 'retracted',
              sourceSegmentIds: ['source-final'],
              sources: [
                {
                  ref: 'source-final',
                  state: 'final',
                  text: '원문 근거 발화',
                  offsetMs: 1000,
                  uncertain: true,
                },
              ],
              trigger: 'auto',
              revision: 2,
              createdAt: '2026-10-21T01:00:02Z',
              offsetMs: 2000,
              anchorOffsetMs: 1000,
              history: [
                {
                  revision: 1,
                  text: '이전 제안 문구',
                  producedOffsetMs: 1500,
                  sourceState: 'draft',
                  sources: [
                    { ref: 'source-draft', state: 'draft', text: '이전 원문 발화', offsetMs: 500 },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(Array.from(history.sessions[0].hints[0].title!).length).toBeLessThanOrEqual(48);
    history.sessions[0].hints.push({ ...history.sessions[0].hints[0], id: 'final-cue', title: '확정 자막을 바탕으로 한 일반 힌트', sourceState: 'final', history: [], anchorOffsetMs: 5000 });
    writeFileSync(
      join(metadata, 'SavedHints_20261021.json'),
      JSON.stringify({
        filePath,
        title: 'SavedHints',
        timestamp: '2026-10-21T01:00:00Z',
        liveHints: history,
      }),
    );
    await page.reload();
    await expect(page.locator('#loadingIndicator')).toBeHidden();
    const openHistory = async (path: string) => {
      const row = page.locator('.recording-item').filter({
        has: page.locator(`.recording-info h3`, {
          hasText: path === filePath ? 'SavedHints' : 'Legacy',
        }),
      });
      await expect(row).toHaveCount(1);
      const trigger = row.getByRole('button', { name: /More actions/ });
      await trigger.click();
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await expect(row.getByRole('menu')).toBeVisible();
      await row.getByRole('menuitem', { name: 'View AI hints' }).click();
      await expect(page.locator('#recordingHints')).toBeVisible();
    };
    await openHistory(filePath);
    const pane = page.locator('#recordingHints');
    await expect(pane).toContainText('이 목록은 일부만 표시됩니다.');
    const cue = pane.locator('.recording-hint').first();
    const heading = cue.locator(':scope > summary');
    await expect(heading.locator('.recording-hint-title')).toHaveText(history.sessions[0].hints[0].title!);
    await expect(heading.locator('time')).toHaveText('122:01');
    await expect(heading).toHaveAccessibleName(/자막 수정/);
    await heading.focus();
    await heading.press('Enter');
    await expect(cue).toHaveAttribute('open', '');
    await expect(heading).toBeFocused();
    await expect(cue.locator(':scope > .recording-hint-warning')).toHaveText('원문 자막이 정정되어 이 힌트는 더 이상 근거가 없습니다.');
    const provenance = cue.locator('.recording-hint-provenance > summary');
    await provenance.focus();
    await provenance.press('Space');
    await expect(cue.locator('.recording-hint-provenance')).toHaveAttribute('open', '');
    await expect(cue).toContainText('대화 내용 기반');
    await expect(cue).toContainText('일반 지식 기반 · 실제 대화와 맞는지 확인하세요');
    await expect(cue).toContainText('AI 제안');
    await cue.locator(':scope > .recording-hint-source > summary').click();
    await expect(cue).toContainText('122:01 · 자막이 불확실할 수 있음 — 원문 근거 발화');
    await cue.locator('.recording-hint-revisions > summary').click();
    await expect(cue).toContainText('이전 제안 문구');
    await expect(cue.locator('.recording-hint-revisions .recording-hint-warning')).toHaveText('확정 전 자막을 바탕으로 한 힌트입니다.');
    const finalCue = pane.locator('.recording-hint').nth(1);
    await finalCue.locator(':scope > summary').focus();
    await finalCue.locator(':scope > summary').press('Enter');
    await expect(finalCue).toHaveAttribute('open', '');
    await expect(finalCue.locator('.recording-hint-warning')).toHaveCount(0);
    await expect(finalCue.locator('.recording-hint-correction')).toHaveCount(0);
    await expect(pane.locator('img')).toHaveCount(0);
    for (const width of [1200, 820, 390]) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setMinimumSize(0, 0));
      await resizeNative(app, width, 900);
      expect(await page.evaluate(() => innerWidth)).toBe(width);
      expect(await pane.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      await expect(page.locator('#liveHintPreview')).toBeHidden();
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await heading.scrollIntoViewIfNeeded();
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await captureNative(app, `saved-history-${width}-expanded`);
      await heading.focus();
      await heading.press('Space');
      await expect(cue).not.toHaveAttribute('open');
      await finalCue.locator(':scope > summary').press('Enter');
      await expect(finalCue).not.toHaveAttribute('open');
      await heading.scrollIntoViewIfNeeded();
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await captureNative(app, `saved-history-${width}-list`);
      writeFileSync(join(EVIDENCE, `saved-history-${width}-visibility.json`), JSON.stringify(await pane.evaluate((node) => ({
        width: innerWidth, popupHidden: document.getElementById('liveHintPreview')!.hidden,
        horizontalOverflow: node.scrollWidth > node.clientWidth,
        titles: Array.from(node.querySelectorAll('.recording-hint-title')).map((title) => title.getBoundingClientRect().toJSON()),
        times: Array.from(node.querySelectorAll('time')).map((time) => time.getBoundingClientRect().toJSON()),
      })), null, 2));
      await heading.press('Enter');
      await finalCue.locator(':scope > summary').press('Enter');
    }
    await assertHidden(app, page, 'saved-history');
    await page.locator('#transcriptionModal .close').click();
    // Exercise supported legacy inline report metadata on the same recording.
    writeFileSync(
      join(metadata, 'SavedHints_20261021.json'),
      JSON.stringify({
        filePath,
        title: 'SavedHints',
        timestamp: '2026-10-21T01:00:00Z',
        liveHints: history,
        transcript: 'Saved recording transcript remains available.',
        summary: 'Saved recording summary remains available.',
      }),
    );
    await page.reload();
    await expect(page.locator('#loadingIndicator')).toBeHidden();
    await openHistory(filePath);
    await expect(page.locator('#recordingHints')).toContainText('장시간 한국어 회의');
    await page.locator('.tab-button[data-tab="summary"]').click();
    await expect(page.locator('#summary')).toContainText(
      'Saved recording summary remains available.',
    );
    await page.locator('.tab-button[data-tab="transcript"]').click();
    await expect(page.locator('#transcript')).toContainText(
      'Saved recording transcript remains available.',
    );
    await page.locator('#transcriptionModal .close').click();
    await openHistory(legacyPath);
    await expect(page.locator('#recordingHints')).toContainText(
      '이 녹음에는 저장된 AI 힌트가 없습니다.',
    );
    await assertHidden(app, page, 'saved-history-reload');
    writeFileSync(
      join(EVIDENCE, 'saved-history-proof.json'),
      JSON.stringify(
        {
          dataDir,
          source: 'isolated filesystem fixture; actual IPC and renderer',
          reload: true,
          legacy: true,
          actualAi: false,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    preserveFirstFailure(error);
    writeFileSync(join(EVIDENCE, 'saved-first-failure-dom.html'), await page.content());
    await captureNative(app, 'saved-first-failure').catch(() => {});
    await assertHidden(app, page, 'saved-first-failure').catch(() => {});
    throw error;
  } finally {
    await closeIntegratedHints(app, dataDir);
  }
});
