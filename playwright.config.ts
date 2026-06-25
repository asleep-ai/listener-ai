import { defineConfig } from '@playwright/test';

// E2E config for the packaged-app smoke test (see e2e/). Kept separate from the
// unit suite (node --test). Run with `pnpm run test:e2e` after an electron-builder
// build has produced output under release/.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  // Headroom for auto-retrying assertions (e.g. toHaveURL) while the packaged
  // app finishes loading its renderer on a slow headless CI runner.
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: 'list',
});
