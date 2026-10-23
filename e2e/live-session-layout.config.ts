import { defineConfig } from '@playwright/test';
import { join } from 'node:path';

const evidence = process.env.LISTENER_HINTS_EVIDENCE_DIR || '/tmp/listener-rebased-layout-20261023/layout';
export default defineConfig({
  testDir: '.',
  testMatch: 'live-session-layout.spec.ts',
  workers: 1,
  retries: 0,
  maxFailures: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: join(evidence, 'playwright'),
  reporter: [['list'], ['json', { outputFile: join(evidence, 'results.json') }]],
});
