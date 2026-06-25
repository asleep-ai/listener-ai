import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { findLatestBuild, parseElectronApp } from 'electron-playwright-helpers';

// Launches the electron-builder *packaged* output (not dev mode) and asserts the
// app reaches its first window. This is the standard Electron smoke test, and it
// guards the whole class of "the packaged app silently won't start" regressions
// -- e.g. electron-builder dropping a transitive dependency from app.asar after a
// pnpm / electron / electron-builder bump, which crashes the app at startup with
// "Cannot find module". Unit tests cannot see this because they run against the
// full dev node_modules. It MUST run against the packaged build: a dev-mode
// launch would resolve the missing module from node_modules and hide the bug.
test('packaged app boots without crashing', async () => {
  const app = parseElectronApp(findLatestBuild('release'));
  const electronApp = await electron.launch({
    executablePath: app.executable,
    args: ['--no-sandbox'], // required on Linux CI runners
  });
  try {
    // A startup crash (missing module) never opens a window -> this rejects.
    const window = await electronApp.firstWindow({ timeout: 30_000 });
    expect((await window.title()).length).toBeGreaterThan(0);
  } finally {
    await electronApp.close();
  }
});
