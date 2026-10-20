import { defineConfig } from '@playwright/test';
import { initializeLaunchLog } from './e2e/support/launch-reporter';

initializeLaunchLog();

// Warm groups reuse one owned process; startup contracts run as fresh cases.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  maxFailures: 1,
  reporter: [['list'], ['./e2e/support/launch-reporter.ts']],
  projects: [
    {
      name: 'settings',
      testMatch: 'settings.spec.ts',
      grepInvert: /captures every Settings tab for visual review$/,
    },
    {
      name: 'settings-shots',
      testMatch: 'settings.spec.ts',
      grep: /captures every Settings tab for visual review$/,
    },
    { name: 'cutoff', testMatch: 'transcript-cutoff.spec.ts' },
    { name: 'reload', testMatch: 'transcription-reload.spec.ts' },
    { name: 'live', testMatch: 'live-session.spec.ts' },
    {
      name: 'chatgpt',
      testMatch: 'chatgpt-integration.spec.ts',
      grepInvert: /startup .* opens without AI setup prompt/,
    },
    {
      name: 'chatgpt-startup',
      testMatch: 'chatgpt-integration.spec.ts',
      grep: /startup .* opens without AI setup prompt/,
    },
    { name: 'hidden-startup', testMatch: 'hidden-launch.spec.ts' },
    { name: 'package-smoke', testMatch: 'smoke.spec.ts' },
  ],
});
