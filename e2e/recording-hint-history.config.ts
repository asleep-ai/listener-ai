import { defineConfig } from '@playwright/test';
import { join } from 'node:path';
const evidence =
  process.env.LISTENER_HINTS_EVIDENCE_DIR || '/tmp/listener-recording-hint-history-qa';
export default defineConfig({
  testDir: '.',
  testMatch: 'recording-hint-history.spec.ts',
  workers: 1,
  retries: 0,
  maxFailures: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: join(evidence, 'playwright'),
  reporter: [['list'], ['json', { outputFile: join(evidence, 'results.json') }]],
});
