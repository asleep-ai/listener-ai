import { expect } from '@playwright/test';
import { type ElectronApplication, type Page, _electron as electron } from 'playwright';
import { resolve } from 'node:path';

// Shared launcher for the unpackaged Electron E2Es. Every launch preloads
// hidden-electron.cjs (TEST-ONLY) so runs stay in the background; set
// LISTENER_E2E_SHOW=1 to watch the windows instead. LISTENER_E2E_ELECTRON
// points at an Electron binary when the local `electron` package has no
// complete dist. The packaged smoke test (e2e/smoke.spec.ts) does not use it.

export const ROOT = resolve(__dirname, '..', '..');
export const HIDDEN_ELECTRON = resolve(__dirname, 'hidden-electron.cjs');

export function launchApp(env: NodeJS.ProcessEnv): Promise<ElectronApplication> {
  const hidden = process.env.LISTENER_E2E_SHOW === '1' ? [] : ['-r', HIDDEN_ELECTRON];
  return electron.launch({
    executablePath: process.env.LISTENER_E2E_ELECTRON || (require('electron') as string),
    args: [...hidden, '.', '--disable-gpu', '--no-sandbox'],
    cwd: ROOT,
    env,
  });
}

// An unpackaged launch can also open a DevTools window (the hidden helper
// keeps it closed), so wait for the page that loaded the app itself.
export async function appWindow(electronApp: ElectronApplication): Promise<Page> {
  let page: Page | undefined;
  await expect
    .poll(
      () => {
        page = electronApp.windows().find((w) => w.url().endsWith('/renderer/index.html'));
        return page;
      },
      { timeout: 30_000, message: 'The application window did not open' },
    )
    .toBeTruthy();
  return page!;
}
