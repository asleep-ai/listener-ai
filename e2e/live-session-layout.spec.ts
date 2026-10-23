import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LiveHint, LiveHintsSnapshot } from '../src/liveHintTypes';
import type { LiveSessionSnapshot } from '../src/liveSessionService';
import {
  assertHidden, captureNative, EVIDENCE, closeIntegratedHints, launchIntegratedHints,
  preserveFirstFailure, resizeNative,
} from './integrated-hints-fixture';

const korean = '장시간 한국어 회의에서는 서비스 전환 일정과 접근성 검증 결과를 확인하고 담당자별 다음 실행 항목을 정리합니다. ';
const hint = (sessionId: string, index: number): LiveHint => ({
  id: `layout-hint-${index}`, sessionId, kind: 'action',
  title: `한국어 회의 실행 항목 ${index} 담당자와 일정 확인`,
  text: '확정된 결정과 검토 중인 제안을 구분하여 다음 회의에서 담당자와 일정을 확인해 주세요.',
  detail: korean.repeat(3), basis: ['transcript', 'suggestion'], sourceState: 'final',
  sourceSegmentIds: ['layout-source'],
  sources: [{ ref: 'layout-source', state: 'final', text: korean.repeat(3), offsetMs: 7321000 }],
  trigger: 'auto', revision: 1, createdAt: '2026-10-23T00:00:00Z', offsetMs: 7322000 + index,
  anchorOffsetMs: 7321000,
});
const replay = (app: ElectronApplication, channel: string, event: unknown) => app.evaluate(
  ({ BrowserWindow }, input) => {
    const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().endsWith('/renderer/index.html'));
    if (!window) throw new Error('Owned window missing');
    window.webContents.send(input.channel, input.event);
  }, { channel, event },
);

async function startSyntheticSession(app: ElectronApplication, page: Page) {
  await app.evaluate(({ app, ipcMain }) => {
    const requireMain = process.mainModule!.require.bind(process.mainModule);
    requireMain(`${app.getAppPath()}/dist/services/ffmpegManager.js`).FFmpegManager.prototype.ensureFFmpeg = async () => null;
    const proto = requireMain(`${app.getAppPath()}/dist/liveSessionService.js`).LiveSessionService.prototype;
    const start = proto.start;
    proto.start = function (input: unknown) {
      this.opts = { ...this.opts,
        getLiveSttConfig: () => ({ provider: 'soniox', sonioxApiKey: 'unused' }),
        createLiveSttSession: async () => ({ provider: 'soniox', kind: 'translation', sendPcm() {}, async close() {
          if ((globalThis as any).__layoutHoldClose) await new Promise<void>((resolve) => { (globalThis as any).__layoutReleaseClose = resolve; });
        } }),
      };
      return start.call(this, input);
    };
    const stopRecording = (ipcMain as any)._invokeHandlers.get('stop-recording');
    (globalThis as any).__layoutRecordingStops = 0;
    ipcMain.removeHandler('stop-recording');
    ipcMain.handle('stop-recording', (...args: unknown[]) => {
      (globalThis as any).__layoutRecordingStops++;
      return stopRecording(...args);
    });
    ipcMain.removeHandler('live-session-ask');
    ipcMain.handle('live-session-ask', () => new Promise((resolve) => {
      (globalThis as any).__layoutResolveAsk = (answer = 'Owned delayed answer') => resolve({ success: true, result: { answer, history: [] } });
    }));
  });
  await page.evaluate(() => {
    const NativeRecorder = window.MediaRecorder;
    window.MediaRecorder = class extends NativeRecorder {
      constructor(stream: MediaStream, options?: MediaRecorderOptions) {
        super(stream, options);
        this.addEventListener('stop', () => { (window as any).__layoutRecorderStopped = true; });
      }
    };
    const arrayBuffer = Blob.prototype.arrayBuffer;
    (window as any).__layoutBlobReads = [];
    Blob.prototype.arrayBuffer = function () {
      const pending = arrayBuffer.call(this);
      (window as any).__layoutBlobReads.push(pending);
      return pending;
    };
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true, value: async () => {
        const context = new AudioContext();
        const oscillator = context.createOscillator();
        const destination = context.createMediaStreamDestination();
        const gain = context.createGain();
        gain.gain.value = 0.001;
        oscillator.connect(gain).connect(destination);
        oscillator.start();
        (window as any).__layoutAudioContext = context;
        return destination.stream;
      },
    });
  });
  await page.locator('#recordButton').click();
  await expect(page.locator('#recordButton')).toHaveText('Stop Recording');
  await page.locator('#liveSessionStartButton').click();
  await expect(page.locator('#liveSessionStatus')).toContainText('Listening');
  const result = await page.evaluate(() => window.electronAPI.getLiveSessionSnapshot());
  expect(result.snapshot?.active).toBe(true);
  return result.snapshot!.sessionId;
}

async function retainFailure(app: ElectronApplication, page: Page, error: unknown, paused = false) {
  preserveFirstFailure(error);
  writeFileSync(join(EVIDENCE, 'layout-first-failure-dom.html'), await page.content());
  await captureNative(app, 'layout-first-failure', paused ? page : undefined).catch(() => {});
  await assertHidden(app, page, 'layout-first-failure').catch(() => {});
}

test('compiled live session shows automatic top popup and retains chronological history across widths', async () => {
  const { app, page, dataDir } = await launchIntegratedHints();
  try {
    const sessionId = await startSyntheticSession(app, page);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setMinimumSize(0, 0));
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    await replay(app, 'live-session-event', { type: 'segment', sessionId, segment: {
      id: 'layout-source', offsetMs: 7321000, durationMs: 1000,
      transcript: korean.repeat(10), final: true, createdAt: '2026-10-23T00:00:00Z',
    } });
    for (const width of [1200, 820, 390]) {
      await resizeNative(app, width, 818);
      if (width <= 900) await page.locator('#liveSessionHintsTab').click();
      await page.mouse.move(width - 4, 814);
      await replay(app, 'live-session-event', { type: 'hint', sessionId, hint: hint(sessionId, width) });
      const preview = page.locator('#liveHintPreview');
      await expect(preview).toBeVisible();
      expect(await preview.evaluate((node) => node.matches(':popover-open'))).toBe(true);
      expect(await preview.evaluate((node) => !document.getElementById('liveSessionHints')!.contains(node))).toBe(true);
      const bounds = await preview.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(bounds!.y).toBeLessThan(100);
      expect(await preview.evaluate((node) => node.matches(':hover'))).toBe(false);
      await page.clock.runFor(5200);
      await expect(preview).toBeHidden();
      await expect(page.locator(`.live-hint[data-hint-id="layout-hint-${width}"]`)).toHaveCount(1);
      await captureNative(app, `automatic-hints-${width}`, page);
    }
    await page.locator('#liveSessionCloseButton').click();
    await expect(page.locator('#liveSessionRestartButton')).toBeVisible();
    await expect(page.locator('#liveHintPreview')).toBeHidden();
    await expect(page.locator('#liveHintsCurrent .live-hint')).toHaveCount(3);
    await page.locator('#liveSessionMinimizeButton').click();
    await page.locator('#recordButton').click();
    await expect(page.locator('#recordButton')).toHaveText('Start Recording');
    await page.evaluate(async () => (window as any).__layoutAudioContext.close());
    await assertHidden(app, page, 'automatic-layout-end');
  } catch (error) { await retainFailure(app, page, error, true); throw error; }
  finally { await closeIntegratedHints(app, dataDir); }
});

test('renderer-lost snapshot and late hint revisions stay silent and read-only', async () => {
  const { app, page, dataDir } = await launchIntegratedHints();
  try {
    const sessionId = 'owned-renderer-lost';
    const hints: LiveHintsSnapshot = {
      status: { sessionId, mode: 'auto', state: 'listening', sourceCapability: 'turn-finals', pendingChars: 0, callsLastHour: 1, callsPerHourLimit: 12 },
      hints: [hint(sessionId, 0)],
    };
    const snapshot: LiveSessionSnapshot = {
      sessionId, title: 'Owned recovered session', startedAt: '2026-10-23T00:00:00Z',
      active: false, endedReason: 'renderer-lost', translate: true, mode: 'streaming', provider: 'soniox',
      segments: [{ id: 'layout-source', transcript: korean, translation: 'Retained translation', offsetMs: 1000, durationMs: 1000, final: true, createdAt: '2026-10-23T00:00:00Z' }],
      transcript: korean, translation: 'Retained translation', interimTranscript: '', interimTranslation: '', hints,
    };
    // Replace only this owned process's snapshot IPC; the compiled bridge and UI run unchanged.
    await app.evaluate(({ ipcMain }, snapshot) => {
      ipcMain.removeHandler('live-session-snapshot');
      ipcMain.handle('live-session-snapshot', () => ({ success: true, snapshot }));
    }, snapshot);
    await page.reload();
    await expect(page.locator('#liveSessionIndicatorStatus')).toHaveText('Live captions ended when the window reloaded');
    await expect(page.locator('#liveSessionPanel')).toBeHidden();
    const late = { ...hint(sessionId, 0), revision: 2, text: '종료 후 원문 정정으로 업데이트된 내용', history: [{ revision: 1, text: '보존한 이전 문구', producedOffsetMs: 1000 }] };
    for (const event of [
      { type: 'hint', sessionId, hint: hint(sessionId, 1) },
      { type: 'hintUpdated', sessionId, hint: late },
      { type: 'hintStatus', sessionId, status: { ...hints.status, state: 'unavailable' } },
    ]) await replay(app, 'live-session-event', event);
    await expect(page.locator('#liveSessionPanel')).toBeHidden();
    await expect(page.locator('#liveHintPreview')).toBeHidden();
    await expect(page.locator('#liveChatInput')).toBeDisabled();
    await page.locator('#liveSessionStartButton').click();
    await expect(page.locator('#liveSessionPanel')).toBeVisible();
    await expect(page.locator('#liveHintsCurrent .live-hint')).toHaveCount(2);
    const cue = page.locator('.live-hint[data-hint-id="layout-hint-0"]');
    await expect(cue).toContainText(late.text);
    await cue.locator(':scope > summary').click();
    await cue.locator('[data-hint-versions] > summary').click();
    await expect(cue).toContainText('보존한 이전 문구');
    await expect(page.locator('#liveHintPreview')).toBeHidden();
    await expect(page.locator('#liveHintsError')).toBeHidden();
    await expect(page.locator('#liveSessionCloseButton')).toBeHidden();
    await expect(page.locator('#liveChatSend')).toBeDisabled();
    await captureNative(app, 'whole-recovered-late-history');
    await assertHidden(app, page, 'recovered-late-history');
  } catch (error) { await retainFailure(app, page, error); throw error; }
  finally { await closeIntegratedHints(app, dataDir); }
});
