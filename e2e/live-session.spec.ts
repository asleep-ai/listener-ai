/// <reference path="../renderer/electronAPI.d.ts" />
import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './support/launch';
import { ReusableApp } from './support/reusable-app';

// The recording graph, PCM bridge, live service and events run unchanged.
// Only microphone acquisition and the provider boundary are synthetic.
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
    proto.start = function (input: unknown) {
      if (!fx.service) {
        fx.service = this;
        fx.originalOptions = this.opts;
        this.opts = {
          ...this.opts,
          getLiveSttConfig: () => ({ provider: 'soniox', sonioxApiKey: 'unused' }),
          createLiveSttSession: async (_config: unknown, callbacks: unknown) => {
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
  await page.evaluate(() => {
    const contexts: AudioContext[] = [];
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        const context = new AudioContext();
        const oscillator = context.createOscillator();
        const destination = context.createMediaStreamDestination();
        const gain = context.createGain();
        gain.gain.value = 0.001;
        oscillator.connect(gain).connect(destination);
        oscillator.start();
        contexts.push(context);
        return destination.stream;
      },
    });
    (window as any).__liveCaptureContexts = contexts;
  });
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
    // A page reload resets renderer controls while main still owns its audio file.
    // Settle that test-owned recording even when the new button says Start.
    await page.evaluate(() => window.electronAPI.stopRecording());
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
    await page.evaluate(async () => {
      for (const context of (window as any).__liveCaptureContexts ?? []) await context.close();
    });
  }); } catch (cleanupError) {
    if (failure) throw new AggregateError([failure, cleanupError], "Live case failed and fixture cleanup also failed");
    throw cleanupError;
  }
}
const stats = (app: ElectronApplication) => app.evaluate(() => {
  const fx = (globalThis as any).__liveFixture;
  return { starts: fx.starts, closes: fx.closes, frames: fx.frames };
});
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

test('renderer reload tears down a minimized provider and retains its captions without restarting it', async () => {
  const { app, page } = await fixture();
  let failure: unknown;
  try {
    await start(page);
    await final(app, '다시 열어도 남아야 하는 발언입니다.', 'This caption must survive reopening.');
    await expect(page.locator('#liveTranscriptList')).toContainText('다시 열어도 남아야 하는 발언입니다.');
    await page.locator('#liveSessionMinimizeButton').click();
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect.poll(async () => (await stats(app)).closes).toBe(1);
    await expect(page.locator('#liveSessionPanel')).toBeHidden();
    await expect(page.locator('#liveSessionIndicatorStatus')).toHaveText('Live captions ended when the window reloaded');
    const snapshot = await page.evaluate(() => window.electronAPI.getLiveSessionSnapshot());
    expect(snapshot.snapshot?.active).not.toBe(true);
    await page.locator('#liveSessionStartButton').click();
    await expect(page.locator('#liveTranscriptList')).toContainText('다시 열어도 남아야 하는 발언입니다.');
    if (await page.locator('#liveSessionConversationTab').isVisible())
      await page.locator('#liveSessionConversationTab').click();
    await page.locator('#liveCaptionTranslationTab').click();
    await expect(page.locator('#liveTranslationList')).toContainText('This caption must survive reopening.');
    await page.locator('#liveCaptionTranscriptTab').click();
    await expect(page.locator('#liveChatInput')).toBeDisabled();
    expect((await stats(app)).starts).toBe(1);
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

test('reload during a draining user stop retains existing and late captions as a read-only transcript', async () => {
  const { app, page } = await fixture();
  let failure: unknown;
  try {
    await start(page);
    await final(app, '중지 전에 도착한 발언입니다.', 'This caption arrived before stopping.');
    await expect(page.locator('#liveTranscriptList')).toContainText('중지 전에 도착한 발언입니다.');
    await app.evaluate(() => {
      const fx = (globalThis as any).__liveFixture;
      fx.holdClose = true;
      fx.snapshotReads = 0;
    });
    await page.locator('#liveSessionCloseButton').click();
    await expect.poll(async () => (await stats(app)).closes).toBe(1);
    await expect(page.locator('#liveChatInput')).toBeDisabled();
    await expect(page.locator('#liveChatSend')).toBeDisabled();
    expect((await page.evaluate(() => window.electronAPI.getLiveSessionSnapshot())).snapshot?.endedReason).toBe('user');
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect.poll(() => app.evaluate(() => (globalThis as any).__liveFixture.snapshotReads)).toBeGreaterThan(1);
    await expect(page.locator('#liveSessionIndicatorStatus')).toHaveText('Live captions ended when the window reloaded');
    expect((await page.evaluate(() => window.electronAPI.getLiveSessionSnapshot())).snapshot?.endedReason).toBe('renderer-lost');
    await final(app, '종료 중 추가된 발언입니다.', 'This caption arrived during shutdown.');
    await app.evaluate(() => (globalThis as any).__liveFixture.releaseClose());
    await expect(page.locator('#liveSessionPanel')).toBeHidden();
    await page.locator('#liveSessionStartButton').click();
    await expect(page.locator('#liveTranscriptList')).toContainText('중지 전에 도착한 발언입니다.');
    await expect(page.locator('#liveTranscriptList')).toContainText('종료 중 추가된 발언입니다.');
    if (await page.locator('#liveSessionConversationTab').isVisible())
      await page.locator('#liveSessionConversationTab').click();
    await page.locator('#liveCaptionTranslationTab').click();
    await expect(page.locator('#liveTranslationList')).toContainText('This caption arrived before stopping.');
    await page.locator('#liveCaptionTranscriptTab').click();
    if (await page.locator('#liveSessionConversationTab').isVisible())
      await page.locator('#liveSessionConversationTab').click();
    await page.locator('#liveCaptionTranslationTab').click();
    await expect(page.locator('#liveTranslationList')).toContainText('This caption arrived during shutdown.');
    await page.locator('#liveCaptionTranscriptTab').click();
    await expect(page.locator('#liveChatInput')).toBeDisabled();
    await expect(page.locator('#liveChatSend')).toBeDisabled();
    await expect(page.locator('#liveSessionCloseButton')).toBeHidden();
    expect(await stats(app)).toMatchObject({ starts: 1, closes: 1 });
  } catch (error) { failure = error; throw error; }
  finally { await finish(app, page, failure); }
});


test('the first final flushed after reload recovers a read-only caption from an initially empty snapshot', async () => {
  const { app, page } = await fixture();
  let failure: unknown;
  try {
    await start(page);
    await page.locator('#liveSessionMinimizeButton').click();
    await app.evaluate(() => {
      const fx = (globalThis as any).__liveFixture;
      fx.holdClose = true;
      fx.snapshotReads = 0;
    });
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect.poll(() => app.evaluate(() => (globalThis as any).__liveFixture.snapshotReads)).toBeGreaterThan(0);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect((await stats(app)).closes).toBe(1);
    await final(app, '종료 중 도착한 첫 번째 발언입니다.', 'The first caption arrived during shutdown.');
    await expect(page.locator('#liveSessionIndicatorStatus')).toHaveText('Live captions ended when the window reloaded');
    await expect(page.locator('#liveSessionPanel')).toBeHidden();
    await app.evaluate(() => (globalThis as any).__liveFixture.releaseClose());
    await page.locator('#liveSessionStartButton').click();
    await expect(page.locator('#liveTranscriptList')).toContainText('종료 중 도착한 첫 번째 발언입니다.');
    if (await page.locator('#liveSessionConversationTab').isVisible())
      await page.locator('#liveSessionConversationTab').click();
    await page.locator('#liveCaptionTranslationTab').click();
    await expect(page.locator('#liveTranslationList')).toContainText('The first caption arrived during shutdown.');
    await page.locator('#liveCaptionTranscriptTab').click();
    await expect(page.locator('#liveChatInput')).toBeDisabled();
    expect(await stats(app)).toMatchObject({ starts: 1, closes: 1 });
  } catch (error) { failure = error; throw error; }
  finally { await finish(app, page, failure); }
});
