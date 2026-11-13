import { extractFile } from '@electron/asar';
import { findLatestBuild, parseElectronApp } from 'electron-playwright-helpers';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

function assertBackgroundMarkers(main: string, preload: string): void {
  const markers = [
    'process.env.NODE_ENV',
    'process.env.LISTENER_BACKGROUND_TEST',
    'show: !backgroundTestMode',
    'focusable: !backgroundTestMode',
    '.setSuppressed(backgroundTestMode)',
    '--listener-background-test',
    'Shortcut validation is unavailable in background test mode',
  ];
  if (
    markers.some((marker) => !main.includes(marker)) ||
    !preload.includes('__listenerBackgroundTestDialogs')
  ) {
    throw new Error(
      'Rebuild main and preload with background-test support; refusing to launch a foreground-capable app.',
    );
  }
}

// The hidden recording capture host must be compiled never-shown and
// non-focusable, with the background-test dialog opt-in, and its page must ship.
function assertCaptureHostMarkers(host: string, page: string): void {
  const markers = [
    'show: false',
    'focusable: false',
    'skipTaskbar: true',
    'backgroundThrottling: false',
    "'--listener-background-test', '--listener-capture-host'",
  ];
  if (markers.some((marker) => !host.includes(marker)) || !page.includes('Listener.AI Capture')) {
    throw new Error(
      'Rebuild main and renderer with the hidden capture host; refusing to launch a foreground-capable app.',
    );
  }
}

export function backgroundArtifact(buildDir: string) {
  const buildPath = findLatestBuild(buildDir);
  if (!buildPath) throw new Error(`No packaged build under '${buildDir}'. Build the app first.`);
  const packaged = parseElectronApp(buildPath);
  if (!packaged.asar) throw new Error('Rebuild a packaged ASAR app with background-test support.');
  const archive = join(packaged.resourcesDir, 'app.asar');
  assertBackgroundMarkers(
    extractFile(archive, packaged.packageJson.main).toString('utf8'),
    extractFile(archive, 'dist/preload.js').toString('utf8'),
  );
  assertCaptureHostMarkers(
    extractFile(archive, 'dist/captureHost.js').toString('utf8'),
    extractFile(archive, 'dist/renderer/capture.html').toString('utf8'),
  );
  return { ...packaged, verifiedArchive: realpathSync(archive) };
}

export function assertBackgroundDevBuild(): void {
  assertBackgroundMarkers(
    readFileSync(join(process.cwd(), 'dist/main.js'), 'utf8'),
    readFileSync(join(process.cwd(), 'dist/preload.js'), 'utf8'),
  );
  assertCaptureHostMarkers(
    readFileSync(join(process.cwd(), 'dist/captureHost.js'), 'utf8'),
    readFileSync(join(process.cwd(), 'dist/renderer/capture.html'), 'utf8'),
  );
}
