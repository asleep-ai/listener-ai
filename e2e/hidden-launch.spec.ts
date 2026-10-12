import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, appWindow, launchApp } from './support/launch';

// Proves the TEST-ONLY hidden launch (e2e/support/hidden-electron.cjs) takes
// effect from the first window on: the preload ran before the app's main
// module, every app window was created hidden and stays hidden when product
// code asks to show or focus it, rendering is not throttled, DevTools stay
// closed, and (macOS) the test app left the Dock. The page still works.

test('E2E launches keep the app hidden from creation while the page stays usable', async () => {
  test.skip(process.env.LISTENER_E2E_SHOW === '1', 'hidden launch is turned off');
  const dataDir = mkdtempSync(join(tmpdir(), 'listener-hidden-e2e-'));
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version as string;
  writeFileSync(
    join(dataDir, 'config.json'),
    JSON.stringify({
      aiProvider: 'gemini',
      geminiApiKey: 'e2e-unused',
      lastSeenVersion: version,
      googleDriveEnabled: false,
    }),
  );
  const app = await launchApp({ ...process.env, NODE_ENV: 'test', LISTENER_DATA_PATH: dataDir });
  try {
    // Recorded as the window is created, before anything could show it.
    await app.evaluate(({ BrowserWindow }) => {
      const seen = ((globalThis as any).__shownWhileHidden = [] as string[]);
      for (const w of BrowserWindow.getAllWindows()) {
        w.on('show', () => seen.push('show'));
        w.on('focus', () => seen.push('focus'));
      }
    });
    const page = await appWindow(app);
    await page.waitForLoadState('domcontentloaded');

    const state = await app.evaluate(({ app: electronApp, BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      for (const w of windows) {
        // What a tray click, dock click or notification click would do.
        w.show();
        w.showInactive();
        w.focus();
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
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
