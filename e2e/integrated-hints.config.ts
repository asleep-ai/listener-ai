import { defineConfig } from '@playwright/test';
import { join } from 'node:path';

const evidence = process.env.LISTENER_HINTS_EVIDENCE_DIR || '/tmp/listener-integrated-hints-v2-qa';

// This bounded native exercise owns one hidden app for all of its live-session
// transitions. Existing reusable groups and their launch/reset proofs stay intact.
export default defineConfig({
  testDir: '.',
  testMatch: 'integrated-hints.spec.ts',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  maxFailures: 1,
  outputDir: join(evidence, 'playwright'),
  reporter: [['list'], ['json', { outputFile: join(evidence, 'results.json') }]],
});
