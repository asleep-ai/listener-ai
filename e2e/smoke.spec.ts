import { test, expect } from '@playwright/test';
import { ReusableApp } from './support/reusable-app';

// Launches the electron-builder *packaged* output (not dev mode) and asserts the
// app reaches its first window. This is the standard Electron smoke test, and it
// guards the whole class of "the packaged app silently won't start" regressions
// -- e.g. electron-builder dropping a transitive dependency from app.asar after a
// pnpm / electron / electron-builder bump, which crashes the app at startup with
// "Cannot find module". Unit tests cannot see this because they run against the
// full dev node_modules. It MUST run against the packaged build: a dev-mode
// launch would resolve the missing module from node_modules and hide the bug.
test('packaged app boots without crashing', async () => {
  // CI builds the app OUTSIDE the checkout (via LISTENER_SMOKE_BUILD_DIR) so a
  // require() from the packaged app cannot walk up to the repo's hoisted
  // node_modules and resolve a dependency that was pruned from app.asar -- which
  // would mask the exact regression this smoke exists to catch. Defaults to
  // 'release' for quick local runs.
  const buildDir = process.env.LISTENER_SMOKE_BUILD_DIR ?? 'release';
  // Keep the packaged first-boot check independent, with artifact preflight
  // and a throwaway data directory owned by the lifecycle helper.
  const owned = new ReusableApp('package-smoke', { packaged: true, fresh: true, buildDir });
  try {
    owned.seed({});
    const { app: electronApp } = await owned.start();
    // A missing-module crash throws at require time and never opens a window, so
    // firstWindow() rejects (no explicit timeout -> bounded by the test timeout).
    // Then wait for the renderer to reach the app UI. toHaveURL auto-retries,
    // which avoids a race on slow headless runners where the window opens before
    // index.html has finished loading (a title/content check would flake there).
    const window = await electronApp.firstWindow();
    await expect(window).toHaveURL(/index\.html/);
  } finally {
    try {
      await owned.finish();
    } finally {
      await owned.close();
    }
  }
});
