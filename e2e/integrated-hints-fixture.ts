import { expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appWindow, launchApp, ROOT } from './support/launch';
import { scriptDialogs, scriptedDialogs } from './support/dialogs';

export const EVIDENCE =
  process.env.LISTENER_HINTS_EVIDENCE_DIR || '/tmp/listener-integrated-hints-v2-qa';

export function preserveFirstFailure(error: unknown) {
  try {
    writeFileSync(join(EVIDENCE, 'first-failure.txt'), String(error), { flag: 'wx' });
  } catch (writeError) {
    if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
  }
}

/** Capture the actual native contents without showing or focusing the window. */
export async function captureNative(app: ElectronApplication, name: string, pausedPage?: Page) {
  const pendingCapture = app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((item) =>
      item.webContents.getURL().endsWith('/renderer/index.html'),
    );
    if (!window) throw new Error('Owned native app window is unavailable');
    await window.webContents.executeJavaScript(`new Promise((resolve) => {
      globalThis.__listenerCaptureWaiting = true;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        globalThis.__listenerCaptureWaiting = false;
        resolve();
      }));
    })`);
    const layout = await window.webContents.executeJavaScript(`({
      width: innerWidth, height: innerHeight,
      panelScroll: document.getElementById('liveSessionPanel').scrollTop,
      railScroll: document.querySelector('.live-hints-rail').scrollTop,
      documentScroll: document.scrollingElement.scrollTop,
      previewHidden: document.getElementById('liveHintPreview').hidden,
      previewText: document.getElementById('liveHintPreview').textContent,
      askOpen: document.getElementById('liveSessionAsk').open,
      rects: Object.fromEntries(['liveSessionPanel', 'liveSessionWorkspace', 'liveSessionAsk', 'liveChatInput', 'liveHintsCurrent', 'liveHintPreview'].map((id) => [id, document.getElementById(id)?.getBoundingClientRect().toJSON()])),
      inputAncestors: (() => {
        const result = [];
        for (let node = document.getElementById('liveChatInput'); node; node = node.parentElement) {
          const style = getComputedStyle(node);
          result.push({
            id: node.id, tag: node.tagName, className: node.className,
            rect: node.getBoundingClientRect().toJSON(),
            clientHeight: node.clientHeight, clientWidth: node.clientWidth,
            scrollHeight: node.scrollHeight, scrollWidth: node.scrollWidth,
            scrollTop: node.scrollTop, scrollLeft: node.scrollLeft,
            overflowX: style.overflowX, overflowY: style.overflowY,
            height: style.height, maxHeight: style.maxHeight, minHeight: style.minHeight,
            paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, boxSizing: style.boxSizing
          });
        }
        return result;
      })()
    })`);
    return { png: (await window.webContents.capturePage()).toPNG().toString('base64'), layout };
  });
  if (pausedPage) {
    await expect.poll(() => pausedPage.evaluate(() => (globalThis as any).__listenerCaptureWaiting)).toBe(true);
    await pausedPage.clock.runFor(50);
  }
  const capture = await pendingCapture;
  writeFileSync(join(EVIDENCE, `${name}.png`), Buffer.from(capture.png, 'base64'));
  writeFileSync(join(EVIDENCE, `${name}-layout.json`), JSON.stringify(capture.layout, null, 2));
}

export async function resizeNative(app: ElectronApplication, width: number, height: number) {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows().find((item) =>
        item.webContents.getURL().endsWith('/renderer/index.html'),
      );
      if (!window) throw new Error('Owned native app window is unavailable');
      window.setContentSize(size.width, size.height);
    },
    { width, height },
  );
}

export async function assertHidden(app: ElectronApplication, page: Page, stage: string) {
  const native = await app.evaluate(({ app, BrowserWindow }) => ({
    pid: process.pid,
    windowIds: BrowserWindow.getAllWindows().map((window) => window.id),
    contentBounds: BrowserWindow.getAllWindows().map((window) => window.getContentBounds()),
    windows: BrowserWindow.getAllWindows().map((window) => ({
      visible: window.isVisible(),
      focused: window.isFocused(),
      focusable: window.isFocusable(),
      devTools: window.webContents.isDevToolsOpened(),
    })),
    dockVisible: process.platform === 'darwin' ? app.dock?.isVisible() : false,
    effects: (globalThis as any).__listenerTestNativeEffects,
    background: process.env.NODE_ENV === 'test' && process.env.LISTENER_BACKGROUND_TEST === '1',
    dataPath: process.env.LISTENER_DATA_PATH,
    version: process.versions.electron,
  }));
  writeFileSync(join(EVIDENCE, `native-${stage}.json`), JSON.stringify(native, null, 2));
  writeFileSync(join(EVIDENCE, `native-${stage}-${native.pid}.json`), JSON.stringify(native, null, 2));
  const rendererUrl = page.url();
  expect(rendererUrl).toBe(pathToFileURL(join(ROOT, 'dist/renderer/index.html')).href);
  writeFileSync(join(EVIDENCE, 'renderer-url.txt'), rendererUrl);
  expect(native.background).toBe(true);
  expect(native.version).toBe('43.7.9');
  expect(native.windows).toEqual([
    { visible: false, focused: false, focusable: false, devTools: false },
  ]);
  expect(native.dockVisible).toBe(false);
  expect(native.effects).toEqual([]);
  if (stage !== 'start') {
    const baseline = JSON.parse(readFileSync(join(EVIDENCE, 'native-start.json'), 'utf8'));
    expect(native.pid).toBe(baseline.pid);
    expect(native.windowIds).toEqual(baseline.windowIds);
    expect(native.dataPath).toBe(baseline.dataPath);
  }
  expect(await scriptedDialogs(page)).toEqual([]);
  return native;
}

export async function closeIntegratedHints(app: ElectronApplication, dataDir: string) {
  const child = app.process();
  await app.close();
  const exited = child.exitCode !== null || child.signalCode !== null;
  const ownedRoot = resolve(dirname(dataDir)) === resolve(tmpdir()) && basename(dataDir).startsWith('listener-integrated-hints-data-');
  if (exited && ownedRoot) rmSync(dataDir, { recursive: true });
  const receipt = { pid: child.pid, dataDir, exited, ownedRoot, dataRemoved: !existsSync(dataDir) };
  appendFileSync(join(EVIDENCE, 'owned-cleanup.jsonl'), `${JSON.stringify(receipt)}\n`);
  expect(receipt).toMatchObject({ exited: true, ownedRoot: true, dataRemoved: true });
}

export async function launchIntegratedHints() {
  mkdirSync(EVIDENCE, { recursive: true });
  const dataDir = mkdtempSync(join(tmpdir(), 'listener-integrated-hints-data-'));
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  writeFileSync(
    join(dataDir, 'config.json'),
    JSON.stringify({
      aiProvider: 'gemini',
      geminiApiKey: 'e2e-unused',
      lastSeenVersion: version,
      googleDriveEnabled: false,
      meetingDetection: false,
      displayDetection: false,
    }),
  );
  const app = await launchApp({ ...process.env, LISTENER_DATA_PATH: dataDir });
  try {
    const page = await appWindow(app);
    await page.waitForLoadState('domcontentloaded');
    await scriptDialogs(app, page);
    await expect(page.locator('#loadingIndicator')).toBeHidden();
    await assertHidden(app, page, 'start');
    appendFileSync(join(EVIDENCE, 'owned-launches.jsonl'), `${JSON.stringify({ pid: app.process().pid, dataDir })}\n`);
    return { app, page, dataDir };
  } catch (error) {
    preserveFirstFailure(error);
    await closeIntegratedHints(app, dataDir);
    throw error;
  }
}
