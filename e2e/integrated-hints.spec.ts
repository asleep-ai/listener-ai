import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { closeIntegratedHints, launchIntegratedHints } from './integrated-hints-fixture';

test('hint previews expire without losing history and pause while being read', async () => {
  const { app, page, dataDir } = await launchIntegratedHints();
  try {
    // Exercise the actual renderer module with deterministic events and time,
    // independently of the provider scheduler and the user's desktop.
    const presentation = stripTypeScriptTypes(
      readFileSync('src/liveHintPresentation.ts', 'utf8'),
    ).replaceAll('export function ', 'function ');
    const ui = stripTypeScriptTypes(
      readFileSync('renderer/ui/live-hints.ts', 'utf8').replace(
        /^import \{[\s\S]*?\} from '\.\.\/\.\.\/src\/liveHintPresentation';\s*/,
        '',
      ),
    ).replaceAll('export function ', 'function ');
    await page.setContent(
      readFileSync('renderer/index.html', 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ''),
    );
    await page.clock.install();
    await page.evaluate((source) => {
      const setup = new Function(`${source}\nreturn setupLiveHints;`)();
      (window as any).__previewTestUI = setup({
        source: () => {},
      });
      (window as any).__previewTestUI.active(true);
      // The isolated module fixture has no app startup script to dismiss this.
      document.getElementById('loadingIndicator')?.remove();
      const panel = document.getElementById('liveSessionPanel') as HTMLDialogElement;
      panel.showModal();
    }, `${presentation}\n${ui}`);
    const add = async (id: string, options: { replay?: boolean; retracted?: boolean } = {}) =>
      page.evaluate(
        ({ id, options }) => {
          (window as any).__previewTestUI.add(
            {
              id,
              title: `힌트 ${id}`,
              text: `기록에 남는 내용 ${id}`,
              kind: '확인 질문',
              sources: [],
              retracted: options.retracted,
            },
            { replay: options.replay },
          );
        },
        { id, options },
      );
    const preview = page.locator('#liveHintPreview');
    const announcement = page.locator('#liveHintPreviewAnnouncement');
    await expect(announcement).toHaveAttribute('aria-live', 'polite');
    await expect(announcement).toBeEmpty();
    expect(await announcement.evaluate((node) => !node.closest('#liveHintPreview'))).toBe(true);
    await expect(preview).toHaveAttribute('aria-live', 'off');
    await page.locator('#liveSessionMinimizeButton').focus();
    await add('first');
    await expect(preview).toBeVisible();
    await expect(announcement).toHaveText('새 힌트 · 힌트 first. 기록에 남는 내용 first');
    expect(await preview.evaluate((node) => node.matches(':popover-open'))).toBe(true);
    expect(await preview.evaluate((node) => !document.getElementById('liveSessionHints')!.contains(node))).toBe(true);
    await expect(page.locator('#liveSessionMinimizeButton')).toBeFocused();
    await page.clock.runFor(4900);
    await expect(preview).toBeVisible();
    await page.clock.runFor(200);
    await expect(preview).toBeHidden();
    await expect(page.locator('.live-hint[data-hint-id="first"]')).toHaveCount(1);

    await add('hover');
    await preview.dispatchEvent('pointerenter');
    await page.clock.runFor(6000);
    await expect(preview).toBeVisible();
    await preview.dispatchEvent('pointerleave');
    await page.clock.runFor(5200);
    await expect(preview).toBeHidden();

    await add('focus');
    await page.locator('#liveHintPreviewDismiss').focus();
    await page.clock.runFor(6000);
    await expect(preview).toBeVisible();
    await page.locator('#liveSessionMinimizeButton').focus();
    await page.clock.runFor(5200);
    await expect(preview).toBeHidden();

    await add('dismiss');
    await page.locator('#liveHintPreviewDismiss').focus();
    await page.locator('#liveHintPreviewDismiss').press('Enter');
    await expect(preview).toBeHidden();
    await expect(announcement).toBeEmpty();
    await expect(page.locator('#liveSessionMinimizeButton')).toBeFocused();

    await add('selection');
    await page.locator('#liveHintPreviewText').evaluate((node) => {
      const selection = window.getSelection()!;
      const range = document.createRange();
      range.selectNodeContents(node);
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.clock.runFor(6000);
    await expect(preview).toBeVisible();
    await page.evaluate(() => window.getSelection()!.removeAllRanges());
    await page.clock.runFor(5200);
    await expect(preview).toBeHidden();

    await add('restored', { replay: true });
    await expect(preview).toBeHidden();
    await expect(announcement).toBeEmpty();
    await expect(page.locator('.live-hint[data-hint-id="restored"]')).toHaveCount(1);
    await add('stopped');
    await expect(preview).toBeVisible();
    await page.evaluate(() => (window as any).__previewTestUI.active(false));
    await expect(preview).toBeHidden();
    await expect(page.locator('.live-hint[data-hint-id="stopped"]')).toHaveCount(1);
    await page.evaluate(() => (window as any).__previewTestUI.dispose());
  } finally {
    await closeIntegratedHints(app, dataDir);
  }
});
