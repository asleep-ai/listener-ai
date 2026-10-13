import { test, expect } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './support/launch';
import { scriptDialogs, scriptedDialogs, visibleWindows } from './support/dialogs';
import { ReusableApp } from './support/reusable-app';

// Proves the TEST-ONLY hidden launch (e2e/support/hidden-electron.cjs) takes
// effect from the first window on: the preload ran before the app's main
// module, every app window was created hidden and stays hidden when product
// code asks to show or focus it, rendering is not throttled, DevTools stay
// closed, and (macOS) the test app left the Dock. The page still works.

test('E2E launches keep the app hidden from creation while the page stays usable', async () => {
  const owned = new ReusableApp('hidden-startup', { fresh: true });
  let application: ElectronApplication | undefined;
  try {
    const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version as string;
    owned.seed({
      aiProvider: 'gemini',
      geminiApiKey: 'e2e-unused',
      lastSeenVersion: version,
      googleDriveEnabled: false,
    });
    const { app, page } = await owned.start();
    application = app;
    // Recorded as the window is created, before anything could show it.
    await app.evaluate(({ BrowserWindow }) => {
      const seen = ((globalThis as any).__shownWhileHidden = [] as string[]);
      for (const w of BrowserWindow.getAllWindows()) {
        w.on('show', () => seen.push('show'));
        w.on('focus', () => seen.push('focus'));
      }
    });
    await page.waitForLoadState('domcontentloaded');
    await scriptDialogs(app, page);

    const state = await app.evaluate(({ app: electronApp, BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      // Deliberately exercise the guard without counting the probe as a
      // product request. Product window requests otherwise fail the fixture.
      (globalThis as any).__listenerAllowWindowGuardProbe = true;
      try {
        for (const w of windows) {
          w.show();
          w.showInactive();
          w.focus();
        }
      } finally {
        (globalThis as any).__listenerAllowWindowGuardProbe = false;
      }
      return {
        helper: (globalThis as any).__listenerHiddenE2E,
        windows: windows.map((w) => ({
          hiddenForE2E: (w as any).hiddenForE2E === true,
          visible: w.isVisible(),
          focused: w.isFocused(),
          throttling: w.webContents.getBackgroundThrottling(),
          devTools: w.webContents.isDevToolsOpened(),
        })),
        dockVisible: process.platform === 'darwin' ? electronApp.dock?.isVisible() : false,
        shown: (globalThis as any).__shownWhileHidden,
      };
    });
    expect(state.helper).toEqual({ loadedBeforeMain: true });
    expect(state.windows.length).toBeGreaterThan(0);
    for (const w of state.windows) {
      expect(w).toEqual({
        hiddenForE2E: true,
        visible: false,
        focused: false,
        throttling: false,
        devTools: false,
      });
    }
    expect(state.shown).toEqual([]);
    await expect.poll(() => app.evaluate(({ app: a }) => a.dock?.isVisible() ?? false)).toBe(false);

    // Hidden, but rendered and interactive through Playwright.
    await expect(page.locator('#recordButton')).toBeVisible();
    await page.locator('#searchInput').fill('hidden launch');
    await expect(page.locator('#searchInput')).toHaveValue('hidden launch');
    expect(await scriptedDialogs(page)).toEqual([]);
  } finally {
    try {
      // Soft, so a failure earlier in the test keeps its own error.
      if (application) {
        const visible = await visibleWindows(application).catch(() => []);
        expect.soft(visible, 'app windows stayed hidden').toEqual([]);
      }
      await owned.finish();
    } finally {
      await owned.close();
    }
  }
});
