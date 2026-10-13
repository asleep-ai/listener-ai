import { expect } from '@playwright/test';
import { type ElectronApplication, type Page, _electron as electron } from 'playwright';
import { resolve } from 'node:path';
import { assertBackgroundDevBuild } from '../background-test';

// Shared launcher for the unpackaged Electron E2Es. Every launch preloads
// hidden-electron.cjs (TEST-ONLY) so runs stay in the background; visible
// launches are rejected. LISTENER_E2E_ELECTRON
// points at an Electron binary when the local `electron` package has no
// complete dist. Packaged launches use product background mode and verified
// native guards through ReusableApp.
// A hidden launch also turns on the app's own background-test mode (no
// shortcuts, tray, detectors, notifications or native dialogs) and refuses a
// build without it, so a stale dist cannot raise anything on the desktop.

export const ROOT = resolve(__dirname, '..', '..');
export const HIDDEN_ELECTRON = resolve(__dirname, 'hidden-electron.cjs');

export function launchApp(env: NodeJS.ProcessEnv): Promise<ElectronApplication> {
  if (process.env.LISTENER_E2E_SHOW === '1')
    throw new Error('Background tests refuse LISTENER_E2E_SHOW=1.');
  assertBackgroundDevBuild();
  const isolatedEnv: Record<string, string> = Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' &&
        !/API_KEY|OAUTH|TOKEN|SECRET|PASSWORD|WEBHOOK|NOTION_DATABASE_ID|LISTENER_AI_PROVIDER|LISTENER_CODEX_AUTH_PATH/i.test(
          entry[0],
        ),
    ),
  );
  return electron.launch({
    executablePath: process.env.LISTENER_E2E_ELECTRON || (require('electron') as string),
    args: ['-r', HIDDEN_ELECTRON, '.', '--disable-gpu', '--no-sandbox'],
    cwd: ROOT,
    env: {
      ...isolatedEnv,
      NODE_ENV: 'test',
      LISTENER_TEST_MODE: '',
      LISTENER_BACKGROUND_TEST: '1',
      LISTENER_E2E_SHOW: '0',
    },
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
