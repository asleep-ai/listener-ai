import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { findLatestBuild, parseElectronApp } from 'electron-playwright-helpers';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Launches the electron-builder *packaged* output (not dev mode) and asserts the
// app reaches its first window. This is the standard Electron smoke test, and it
// guards the whole class of "the packaged app silently won't start" regressions
// -- e.g. electron-builder dropping a transitive dependency from app.asar after a
// pnpm / electron / electron-builder bump, which crashes the app at startup with
// "Cannot find module". Unit tests cannot see this because they run against the
// full dev node_modules. It MUST run against the packaged build: a dev-mode
// launch would resolve the missing module from node_modules and hide the bug.
test('packaged app boots without crashing', async () => {
  const buildPath = findLatestBuild('release');
  if (!buildPath) {
    throw new Error("No packaged build found under 'release/'. Run `pnpm exec electron-builder --dir` first.");
  }
  const app = parseElectronApp(buildPath);
  // Launch against a throwaway data dir so the smoke never reads/migrates/writes
  // real Listener data — startup runs autoMigrateLegacyOnStartup(getDataPath()).
  // getDataPath() only honors LISTENER_DATA_PATH when NODE_ENV==='test', so both
  // are set; spread process.env to keep PATH/HOME/DISPLAY (xvfb) for the launch.
  const dataDir = mkdtempSync(join(tmpdir(), 'listener-smoke-'));
  const electronApp = await electron.launch({
    executablePath: app.executable,
    args: ['--no-sandbox'], // required on Linux CI runners
    env: { ...process.env, NODE_ENV: 'test', LISTENER_DATA_PATH: dataDir },
  });
  try {
    // A missing-module crash throws at require time and never opens a window, so
    // firstWindow() rejects (no explicit timeout -> bounded by the test timeout).
    // Then wait for the renderer to reach the app UI. toHaveURL auto-retries,
    // which avoids a race on slow headless runners where the window opens before
    // index.html has finished loading (a title/content check would flake there).
    const window = await electronApp.firstWindow();
    await expect(window).toHaveURL(/index\.html/);
  } finally {
    await electronApp.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
