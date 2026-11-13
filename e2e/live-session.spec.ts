/// <reference path="../renderer/electronAPI.d.ts" />
import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './support/launch';
import { scriptedDialogs } from './support/dialogs';
import { ReusableApp } from './support/reusable-app';
import {
  installSyntheticCapture,
  invokeMain,
  recordingState,
  releaseSyntheticCapture,
} from './support/synthetic-capture';

// The recording graph and live-caption capture (both in the hidden capture
// host), main's routing, the live service and events run unchanged. Only
// microphone acquisition and the provider boundary are synthetic. The visible
// window only observes, so reloading it must not touch the session.
const shared = new ReusableApp('live');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
test.afterAll(() => shared.close());

async function fixture(): Promise<{ app: ElectronApplication; page: Page }> {
  shared.seed({
    aiProvider: 'gemini', geminiApiKey: 'e2e-unused', liveSttProvider: 'soniox',
    sonioxApiKey: 'e2e-unused', autoMode: false, recordSystemAudio: false,
    meetingDetection: false, displayDetection: false, googleDriveEnabled: false,
    minRecordingSeconds: 0, lastSeenVersion: VERSION,
  });
  const { app, page } = await shared.start();
  await app.evaluate(({ app, ipcMain }) => {
    const previous = (globalThis as any).__liveFixtureBoundary;
    if (previous && (previous.service.snapshot() !== null || previous.recorder.isRecording()))
      throw new Error('Previous live fixture left a session snapshot or recording active');
    const proto = process.mainModule!.require(`${app.getAppPath()}/dist/liveSessionService.js`).LiveSessionService.prototype;
    // Recording-stop remux is outside live coverage; do not download or spawn ffmpeg.
    process.mainModule!.require(`${app.getAppPath()}/dist/services/ffmpegManager.js`)
      .FFmpegManager.prototype.ensureFFmpeg = async () => null;
    const original = proto.start;
    const fx: any = { starts: 0, closes: 0, frames: 0, original, proto };
    (globalThis as any).__liveFixture = fx;
    const recorderProto = process.mainModule!.require(`${app.getAppPath()}/dist/simpleAudioRecorder.js`).SimpleAudioRecorder.prototype;
    const recorderStart = recorderProto.startRecording;
    fx.restoreRecorder = () => { recorderProto.startRecording = recorderStart; };
    recorderProto.startRecording = function (...args: unknown[]) {
      fx.recordStarts = (fx.recordStarts ?? 0) + 1;
      fx.recorder = this;
      if (this.isRecording()) throw new Error('Live scenario started with an active recording');
      return recorderStart.apply(this, args);
    };
    const snapshotHandler = (ipcMain as any)._invokeHandlers.get('live-session-snapshot');
    fx.snapshotReads = 0;
    ipcMain.removeHandler('live-session-snapshot');
    ipcMain.handle('live-session-snapshot', async (...args: unknown[]) => {
      const result = await snapshotHandler(...args);
      fx.snapshotReads++;
      return result;
    });
    fx.serviceStarts = 0;
    proto.start = function (input: unknown) {
      fx.serviceStarts++;
      if (!fx.service) {
        fx.service = this;
        fx.originalOptions = this.opts;
        this.opts = {
          ...this.opts,
          getLiveSttConfig: () => fx.chunked
            ? { provider: 'chunked' }
            : { provider: 'soniox', sonioxApiKey: 'unused' },
          // Chunked snippets: the host's 12s windows upload through main to this fake.
          ...(fx.chunked ? {
            getChunkedCaptionsIssue: () => null,
            ensureTranscriptionService: () => ({
              transcribeLiveSnippet: async () => {
                fx.uploads = (fx.uploads ?? 0) + 1;
                return `청크 ${fx.uploads}번째 발언입니다.`;
              },
            }),
          } : {}),
          // Text tasks stay offline: no hint candidates, a synthetic translation.
          ensureGeminiService: () => ({
            generateLiveHints: async () => [],
            translateText: async (text: string) => `Translated: ${text}`,
          }),
          createLiveSttSession: async (config: { provider?: string }, callbacks: unknown) => {
            // Like the real factory: chunked captions have no streaming session.
            if (config.provider === 'chunked') return null;
            fx.starts++;
            fx.callbacks = callbacks;
            return {
              provider: 'soniox', kind: 'translation',
              sendPcm: () => { fx.frames++; },
              close: async () => {
                fx.closes++;
                if (fx.holdClose) await new Promise<void>((resolve) => { fx.releaseClose = resolve; });
              },
            };
          },
          getAgentService: () => ({ run: async (input: any) => ({
            answer: 'The fixture decision is recorded.',
            appliedActions: [],
            history: [...input.history, { role: 'user', text: input.question },
              { role: 'model', text: 'The fixture decision is recorded.' }],
          }) }),
        };
      }
      return original.call(this, input);
    };
  });
  expect((await page.evaluate(() => window.electronAPI.getLiveSessionSnapshot())).snapshot).toBeNull();
  // Recording capture runs in the hidden capture host; its mic is synthetic.
  await installSyntheticCapture(app);
  return { app, page };
}

async function finish(app: ElectronApplication, page: Page, failure?: unknown): Promise<void> {
  try { await shared.finish(async () => {
    await app.evaluate(() => { (globalThis as any).__liveFixture?.releaseClose?.(); });
    // Native modal dialogs make the recording controls inert until closed.
    if (await page.locator('#liveSessionPanel').isVisible()) {
      await page.locator('#liveSessionMinimizeButton').click();
      await expect(page.locator('#liveSessionPanel')).toBeHidden();
    }
    if ((await page.locator('#recordButton').textContent()) === 'Stop Recording') {
      await page.locator('#recordButton').click();
      await expect(page.locator('#recordButton')).toHaveText('Start Recording');
    }
    // Settle a test-owned recording the controls did not stop (main owns it).
    await invokeMain(app, 'recording-request-stop');
    await expect.poll(async () => (await recordingState(app)).phase).toBe('idle');
    await app.evaluate(async () => {
      const fx = (globalThis as any).__liveFixture;
      if (fx?.service) {
        const snapshot = fx.service.snapshot();
        if (snapshot) await fx.service.stop(snapshot.sessionId);
        if (fx.service.isActive() || fx.recorder?.isRecording())
          throw new Error('Live fixture did not settle its service and recording');
        // Ended snapshots deliberately survive renderer reload, but each case
        // owns a separate synthetic session. Clear only after the real stop.
        fx.service.session = null;
        if (fx.service.snapshot() !== null) throw new Error('Live fixture snapshot reset failed');
        (globalThis as any).__liveFixtureBoundary = { service: fx.service, recorder: fx.recorder };
        fx.service.opts = fx.originalOptions;
      }
      if (fx) { fx.proto.start = fx.original; fx.restoreRecorder(); }
      delete (globalThis as any).__liveFixture;
    });
    await releaseSyntheticCapture(app);
  }); } catch (cleanupError) {
    if (failure) throw new AggregateError([failure, cleanupError], "Live case failed and fixture cleanup also failed");
    throw cleanupError;
  }
}
const stats = (app: ElectronApplication) => app.evaluate(() => {
  const fx = (globalThis as any).__liveFixture;
  return { starts: fx.starts, closes: fx.closes, frames: fx.frames, uploads: fx.uploads ?? 0 };
});
const liveSnapshot = async (page: Page) =>
  (await page.evaluate(() => window.electronAPI.getLiveSessionSnapshot())).snapshot;
// Main serves a live session only once; a second start would be a new id.
const serviceStarts = (app: ElectronApplication) => app.evaluate(() =>
  (globalThis as any).__liveFixture.serviceStarts as number);
async function start(page: Page): Promise<void> {
  await page.locator('#recordButton').click();
  await expect(page.locator('#recordButton')).toHaveText('Stop Recording');
  await page.locator('#liveSessionStartButton').click();
  await expect(page.locator('#liveSessionPanel')).toBeVisible();
  await expect(page.locator('#liveSessionStatus')).toContainText('Listening');
  await expect.poll(() => page.locator('#liveSessionPanel').evaluate((dialog) =>
    dialog.contains(document.activeElement))).toBe(true);
}
const final = (app: ElectronApplication, text: string, translation: string) => app.evaluate((_e, value) => {
  (globalThis as any).__liveFixture.callbacks.onFinal({ ...value, offsetMs: 1000, durationMs: 1000 });
}, { text, translation });

test('minimize and Escape retain captions, translation and chat while PCM keeps flowing', async () => {
  const { app, page } = await fixture();
  let failure: unknown;
  try {
    await start(page);
    await final(app, '첫 번째 결정입니다.', 'This is the first decision.');
    await expect(page.locator('#liveTranscriptList')).toContainText('첫 번째 결정입니다.');
    await page.locator('#liveSessionAsk > summary').click();
    await page.locator('#liveChatInput').fill('What was decided?');
    await page.locator('#liveChatSend').click();
    await expect(page.locator('#liveChatMessages')).toContainText('The fixture decision is recorded.');
    await page.screenshot({ path: test.info().outputPath('live-dialog.png') });
    await page.locator('#liveSessionMinimizeButton').click();
    await expect(page.locator('#liveSessionPanel')).toBeHidden();
    await expect(page.locator('#liveSessionStartButton')).toBeFocused();
    await expect(page.locator('#liveSessionIndicatorStatus')).toHaveText('Live captions on');
    const frames = (await stats(app)).frames;
    await final(app, '최소화한 동안 이어진 발언입니다.', 'Speech continued while minimized.');
    await expect.poll(async () => (await stats(app)).frames).toBeGreaterThan(frames);
    await page.screenshot({ path: test.info().outputPath('live-minimized.png') });
    await page.locator('#liveSessionStartButton').click();
    await expect(page.locator('#liveTranscriptList')).toContainText('최소화한 동안 이어진 발언입니다.');
    if (await page.locator('#liveSessionConversationTab').isVisible())
      await page.locator('#liveSessionConversationTab').click();
    await page.locator('#liveCaptionTranslationTab').click();
    await expect(page.locator('#liveTranslationList')).toContainText('Speech continued while minimized.');
    await page.locator('#liveCaptionTranscriptTab').click();
    await expect(page.locator('#liveChatMessages')).toContainText('What was decided?');
    await expect(page.locator('#liveChatMessages')).toContainText('The fixture decision is recorded.');
    await page.locator('#liveSessionMinimizeButton').press('Escape');
    await expect(page.locator('#liveSessionPanel')).toBeHidden();
    expect(await stats(app)).toMatchObject({ starts: 1, closes: 0 });
    await app.evaluate(() => (globalThis as any).__liveFixture.callbacks.onError(new Error('Synthetic provider interruption')));
    await expect(page.locator('#liveSessionIndicatorStatus')).toContainText('Synthetic provider interruption');
    await expect(page.locator('#liveSessionPanel')).toBeHidden();
    await page.locator('#recordButton').click();
    await expect(page.locator('#recordButton')).toHaveText('Start Recording');
    await expect.poll(async () => (await stats(app)).closes).toBe(1);
    await expect(page.locator('#liveSessionPanel')).toBeHidden();
    expect((await stats(app)).starts).toBe(1);
  } catch (error) { failure = error; throw error; }
  finally { await finish(app, page, failure); }
});

test('Stop Live ends only live processing and allows a fresh session during recording', async () => {
  const { app, page } = await fixture();
  let failure: unknown;
  try {
    await start(page);
    await page.locator('#liveSessionCloseButton').click();
    await expect.poll(async () => (await stats(app)).closes).toBe(1);
    await expect(page.locator('#liveSessionPanel')).toBeVisible();
    await expect(page.locator('#liveSessionIndicatorStatus')).toHaveText('Live captions stopped');
    await expect(page.locator('#recordButton')).toHaveText('Stop Recording');
    await page.locator('#liveSessionRestartButton').click();
    await expect.poll(async () => (await stats(app)).starts).toBe(2);
    await expect(page.locator('#liveSessionPanel')).toBeVisible();
    await page.locator('#liveSessionMinimizeButton').click();
    await page.locator('#recordButton').click();
    await expect.poll(async () => (await stats(app)).closes).toBe(2);
  } catch (error) { failure = error; throw error; }
  finally { await finish(app, page, failure); }
});

test('a visible reload reattaches to the same running live session with Ask and Stop', async () => {
  const { app, page } = await fixture();
  let failure: unknown;
  try {
    await start(page);
    await final(app, '다시 열어도 남아야 하는 발언입니다.', 'This caption must survive reopening.');
    await expect(page.locator('#liveTranscriptList')).toContainText('다시 열어도 남아야 하는 발언입니다.');
    const before = await liveSnapshot(page);
    expect(before?.active).toBe(true);
    await page.locator('#liveSessionMinimizeButton').click();
    const frames = (await stats(app)).frames;
    await page.reload();
    await expect(page.locator('#loadingIndicator')).toBeHidden();
    // Capture and the provider kept running in the host: no close, no new session.
    await expect.poll(async () => (await stats(app)).frames).toBeGreaterThan(frames);
    const after = await liveSnapshot(page);
    expect(after).toMatchObject({ sessionId: before!.sessionId, active: true });
    expect(after?.endedReason).toBeUndefined();
    await expect(page.locator('#liveSessionIndicatorStatus')).toHaveText('Live captions on');
    await expect(page.locator('#liveSessionPanel')).toBeHidden();
    // A final after the reload lands in the reattached dialog with the earlier one.
    await final(app, '새로고침 뒤에 이어진 발언입니다.', 'Speech continued after the reload.');
    await page.locator('#liveSessionStartButton').click();
    await expect(page.locator('#liveSessionPanel')).toBeVisible();
    await expect(page.locator('#liveTranscriptList')).toContainText('다시 열어도 남아야 하는 발언입니다.');
    await expect(page.locator('#liveTranscriptList')).toContainText('새로고침 뒤에 이어진 발언입니다.');
    if (await page.locator('#liveSessionConversationTab').isVisible())
      await page.locator('#liveSessionConversationTab').click();
    await page.locator('#liveCaptionTranslationTab').click();
    await expect(page.locator('#liveTranslationList')).toContainText('Speech continued after the reload.');
    await page.locator('#liveCaptionTranscriptTab').click();
    await page.locator('#liveSessionAsk > summary').click();
    await page.locator('#liveChatInput').fill('What was decided?');
    await page.locator('#liveChatSend').click();
    await expect(page.locator('#liveChatMessages')).toContainText('The fixture decision is recorded.');
    await expect(page.locator('#liveSessionCloseButton')).toBeVisible();
    expect(await stats(app)).toMatchObject({ starts: 1, closes: 0 });
    await page.locator('#liveSessionCloseButton').click();
    await expect(page.locator('#liveSessionStatus')).toHaveText('Live transcript ready.');
    await expect.poll(async () => (await stats(app)).closes).toBe(1);
    expect((await liveSnapshot(page))?.endedReason).toBe('user');
    expect(await stats(app)).toMatchObject({ starts: 1, closes: 1 });
    expect(await serviceStarts(app)).toBe(1);
    await expect(page.locator('#recordButton')).toHaveText('Stop Recording');
  } catch (error) { failure = error; throw error; }
  finally { await finish(app, page, failure); }
});

test('Stop Live retains captions and translation with disabled Ask while recording continues', async () => {
  const { app, page } = await fixture();
  let failure: unknown;
  try {
    await start(page);
    await final(app, '중지해도 남아야 하는 발언입니다.', 'This caption must survive stopping.');
    await expect(page.locator('#liveChatInput')).toBeEnabled();
    await page.locator('#liveSessionCloseButton').click();
    await expect(page.locator('#liveSessionStatus')).toHaveText('Live transcript ready.');
    await expect(page.locator('#liveSessionPanel')).toBeVisible();
    await expect(page.locator('#liveTranscriptList')).toContainText('중지해도 남아야 하는 발언입니다.');
    if (await page.locator('#liveSessionConversationTab').isVisible())
      await page.locator('#liveSessionConversationTab').click();
    await page.locator('#liveCaptionTranslationTab').click();
    await expect(page.locator('#liveTranslationList')).toContainText('This caption must survive stopping.');
    await page.locator('#liveCaptionTranscriptTab').click();
    await expect(page.locator('#liveChatInput')).toBeDisabled();
    await expect(page.locator('#liveChatSend')).toBeDisabled();
    await expect(page.locator('#recordButton')).toHaveText('Stop Recording');
    expect(await app.evaluate(() => (globalThis as any).__liveFixture.recorder.isRecording())).toBe(true);
    expect(await stats(app)).toMatchObject({ starts: 1, closes: 1 });
  } catch (error) { failure = error; throw error; }
  finally { await finish(app, page, failure); }
});

test('reload during a draining user stop neither restarts nor promotes the session', async () => {
  const { app, page } = await fixture();
  let failure: unknown;
  try {
    await start(page);
    await final(app, '중지 전에 도착한 발언입니다.', 'This caption arrived before stopping.');
    await expect(page.locator('#liveTranscriptList')).toContainText('중지 전에 도착한 발언입니다.');
    await app.evaluate(() => {
      (globalThis as any).__liveFixture.holdClose = true;
    });
    await page.locator('#liveSessionCloseButton').click();
    await expect.poll(async () => (await stats(app)).closes).toBe(1);
    await expect(page.locator('#liveChatInput')).toBeDisabled();
    expect((await liveSnapshot(page))?.endedReason).toBe('user');
    await page.reload();
    await expect(page.locator('#loadingIndicator')).toBeHidden();
    // The reload is not a capture loss: the stop keeps its user reason.
    expect((await liveSnapshot(page))?.endedReason).toBe('user');
    await final(app, '종료 중 추가된 발언입니다.', 'This caption arrived during shutdown.');
    await app.evaluate(() => (globalThis as any).__liveFixture.releaseClose());
    await expect.poll(async () => (await liveSnapshot(page))?.segments.map((s: any) => s.transcript))
      .toContain('종료 중 추가된 발언입니다.');
    // The stopped session is not offered again; the launcher starts a new one.
    await expect(page.locator('#liveSessionIndicatorStatus')).toHaveText('');
    await expect(page.locator('#liveSessionStartButton')).toHaveText('Live captions');
    await expect(page.locator('#liveSessionPanel')).toBeHidden();
    expect(await stats(app)).toMatchObject({ starts: 1, closes: 1 });
    expect(await serviceStarts(app)).toBe(1);
  } catch (error) { failure = error; throw error; }
  finally { await finish(app, page, failure); }
});

test('a capture host crash ends live captions read-only and the recording finalizes', async () => {
  const { app, page } = await fixture();
  let failure: unknown;
  try {
    await start(page);
    await final(app, '수집 중단 전에 도착한 발언입니다.', 'This caption arrived before capture stopped.');
    await expect(page.locator('#liveTranscriptList')).toContainText('수집 중단 전에 도착한 발언입니다.');
    await page.locator('#liveSessionMinimizeButton').click();
    const file = await app.evaluate(() =>
      (globalThis as any).__liveFixture.recorder.getActiveRecording()?.filePath as string);
    await expect.poll(() => app.evaluate((_e, f) => {
      const fs = process.mainModule!.require('fs');
      return fs.existsSync(f) ? fs.statSync(f).size : 0;
    }, file)).toBeGreaterThan(0);
    await app.evaluate(({ BrowserWindow }) => {
      const host = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().endsWith('/renderer/capture.html'));
      if (!host) throw new Error('No capture host');
      host.webContents.forcefullyCrashRenderer();
    });
    await expect.poll(async () => (await recordingState(app)).phase, { timeout: 20_000 }).toBe('idle');
    // The crashed host is gone; release its pinned ID deliberately.
    await shared.releaseCaptureHost();
    const state = await recordingState(app);
    expect(state.lastResult).toMatchObject({ success: true, stopReason: 'host-lost', filePath: file });
    await expect.poll(async () => (await stats(app)).closes).toBe(1);
    expect((await liveSnapshot(page))).toMatchObject({ active: false, endedReason: 'renderer-lost' });
    await expect(page.locator('#liveSessionIndicatorStatus')).toHaveText('Live captions ended when audio capture stopped');
    await expect(page.locator('#liveSessionPanel')).toBeHidden();
    await expect(page.locator('#recordButton')).toHaveText('Start Recording');
    await page.locator('#liveSessionStartButton').click();
    await expect(page.locator('#liveTranscriptList')).toContainText('수집 중단 전에 도착한 발언입니다.');
    await expect(page.locator('#liveChatInput')).toBeDisabled();
    await expect(page.locator('#liveSessionCloseButton')).toBeHidden();
    expect(await stats(app)).toMatchObject({ starts: 1, closes: 1 });
  } catch (error) { failure = error; throw error; }
  finally { await finish(app, page, failure); }
});

test('chunked captions upload from the capture host across a reload and flush the last window on stop', async () => {
  test.setTimeout(90_000);
  const { app, page } = await fixture();
  let failure: unknown;
  try {
    await app.evaluate(() => { (globalThis as any).__liveFixture.chunked = true; });
    await page.locator('#recordButton').click();
    await expect(page.locator('#recordButton')).toHaveText('Stop Recording');
    await page.locator('#liveSessionStartButton').click();
    await expect(page.locator('#liveSessionStatus')).toContainText('Listening with fallback');
    const sessionId = (await liveSnapshot(page))?.sessionId;
    expect((await liveSnapshot(page))?.mode).toBe('chunked');
    await expect.poll(async () => (await stats(app)).uploads, { timeout: 20_000 }).toBeGreaterThan(0);
    await expect(page.locator('#liveTranscriptList')).toContainText('청크 1번째 발언입니다.');
    await page.locator('#liveSessionMinimizeButton').click();
    await page.reload();
    await expect(page.locator('#loadingIndicator')).toBeHidden();
    // The next 12s window uploads after the reload, into the same session.
    await expect.poll(async () => (await stats(app)).uploads, { timeout: 20_000 }).toBeGreaterThan(1);
    expect((await liveSnapshot(page))).toMatchObject({ sessionId, active: true, mode: 'chunked' });
    await page.locator('#liveSessionStartButton').click();
    await expect(page.locator('#liveTranscriptList')).toContainText('청크 1번째 발언입니다.');
    await expect(page.locator('#liveTranscriptList')).toContainText('청크 2번째 발언입니다.');
    // Stop flushes the partial window (a few seconds old: windows restart on
    // each upload) before main closes the session.
    await page.waitForTimeout(2_000);
    const uploads = (await stats(app)).uploads;
    await page.locator('#liveSessionCloseButton').click();
    await expect(page.locator('#liveSessionStatus')).toHaveText('Live transcript ready.');
    expect((await stats(app)).uploads).toBe(uploads + 1);
    await expect(page.locator('#liveTranscriptList')).toContainText(`청크 ${uploads + 1}번째 발언입니다.`);
    expect(await serviceStarts(app)).toBe(1);
  } catch (error) { failure = error; throw error; }
  finally { await finish(app, page, failure); }
});

test('a second start while one is in flight is ignored and the recording keeps its audio', async () => {
  const { app, page } = await fixture();
  let failure: unknown;
  const pageErrors: string[] = [];
  const onPageError = (error: Error) => pageErrors.push(error.message);
  page.on('pageerror', onPageError);
  try {
    await app.evaluate(({ app }) => {
      const fx = (globalThis as any).__liveFixture;
      const proto = process.mainModule!.require(`${app.getAppPath()}/dist/simpleAudioRecorder.js`).SimpleAudioRecorder.prototype;
      const append = proto.appendChunk;
      fx.chunks = 0;
      fx.restoreAppend = () => { proto.appendChunk = append; };
      proto.appendChunk = function (...args: unknown[]) { fx.chunks++; return append.apply(this, args); };
    });
    // The second click lands while the first start is in flight (the capture
    // host is still loading or acquiring the mic); main's controller also
    // joins a duplicate start.
    await page.evaluate(() => {
      const button = document.getElementById('recordButton') as HTMLButtonElement;
      button.click();
      button.click();
    });
    const duplicate = await invokeMain(app, 'recording-request-start', { title: 'Duplicate' });
    // Joined the pending start, or refused once it was recording; never a second one.
    expect(duplicate.success || duplicate.code === 'busy').toBe(true);
    await expect(page.locator('#recordButton')).toHaveText('Stop Recording');
    await expect.poll(() => app.evaluate(() => (globalThis as any).__liveFixture.chunks)).toBeGreaterThan(1);
    expect(await app.evaluate(() => (globalThis as any).__liveFixture.recordStarts)).toBe(1);
    const filePath = await app.evaluate(() =>
      (globalThis as any).__liveFixture.recorder.getActiveRecording()?.filePath as string | undefined);
    expect(filePath).toBeTruthy();
    // Stop through the product's own button: the first start's recorder must
    // still finalize, flush its chunks and save a non-empty file.
    await page.locator('#recordButton').click();
    await expect(page.locator('#recordButton')).toHaveText('Start Recording');
    await expect.poll(() => app.evaluate((_e, file) =>
      process.mainModule!.require('fs').existsSync(file)
        ? process.mainModule!.require('fs').statSync(file).size : 0, filePath)).toBeGreaterThan(0);
    expect(await scriptedDialogs(page)).toEqual([]);
    expect(pageErrors).toEqual([]);
  } catch (error) { failure = error; throw error; }
  finally {
    page.off('pageerror', onPageError);
    await app.evaluate(() => { (globalThis as any).__liveFixture?.restoreAppend?.(); });
    await finish(app, page, failure);
  }
});

// Deleting the row of the recording still being written unlinked the open
// file and lost the recording. Main now refuses it until capture stops.
test('the recording being written cannot be deleted until it stops, and still saves', async () => {
  const { app, page } = await fixture();
  let failure: unknown;
  try {
    await page.locator('#recordButton').click();
    await expect(page.locator('#recordButton')).toHaveText('Stop Recording');
    const filePath = await app.evaluate(() =>
      (globalThis as any).__liveFixture.recorder.getActiveRecording()?.filePath as string | undefined);
    expect(filePath).toBeTruthy();
    const size = (file: string) => app.evaluate((_e, f) => {
      const fs = process.mainModule!.require('fs');
      return fs.existsSync(f) ? fs.statSync(f).size : -1;
    }, file);
    await expect.poll(() => size(filePath!)).toBeGreaterThan(0);

    const refused = await page.evaluate((f) => window.electronAPI.deleteMeeting(f), filePath!);
    expect(refused.success).toBe(false);
    expect(await size(filePath!)).toBeGreaterThan(0);

    await page.locator('#recordButton').click();
    await expect(page.locator('#recordButton')).toHaveText('Start Recording');
    await expect.poll(() => size(filePath!)).toBeGreaterThan(0);

    const removed = await page.evaluate((f) => window.electronAPI.deleteMeeting(f), filePath!);
    expect(removed.success).toBe(true);
    expect(await size(filePath!)).toBe(-1);
    expect(await scriptedDialogs(page)).toEqual([]);
  } catch (error) { failure = error; throw error; }
  finally { await finish(app, page, failure); }
});
