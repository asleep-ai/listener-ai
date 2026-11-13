/// <reference path="../renderer/electronAPI.d.ts" />
import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { caseApplies } from './support/case-policy';
import { ReusableApp } from './support/reusable-app';
import {
  installSyntheticCapture,
  installSyntheticLiveProvider,
  installSyntheticRealtime,
  invokeMain,
  realtimeDiagnostics,
  realtimeEvidence,
  realtimeSay,
  realtimeTail,
  realtimeTimeline,
  stallSyntheticLiveClose,
  recordingState,
  releaseSyntheticCapture,
  syntheticLive,
  syntheticLiveFinal,
  syntheticRealtime,
} from './support/synthetic-capture';

// Recording capture runs in a hidden capture host owned by main. These cases
// drive it with a synthetic microphone (the only fake: Web Audio, MediaRecorder,
// chunk IPC and file writes are production) and prove that the visible window
// is only a subscriber. With LISTENER_SMOKE_BUILD_DIR set every case runs
// against the packaged executable; the main-window replacement cases re-pin
// the packaged guards' main window through adoptMainWindow.
const packaged = Boolean(process.env.LISTENER_SMOKE_BUILD_DIR);
const shared = new ReusableApp('recording', { packaged });
test.afterAll(() => shared.close());

// Packaged seeds must keep autoMode and detectors off; auto mode is switched on
// in memory for the case that needs it and the harness restores the raw seed.
const SEED = {
  aiProvider: 'gemini',
  geminiApiKey: 'synthetic-unused-key',
  autoMode: false,
  googleDriveEnabled: false,
  meetingDetection: false,
  displayDetection: false,
  recordSystemAudio: false,
  minRecordingSeconds: 0,
};

const size = (file: string) => (existsSync(file) ? statSync(file).size : 0);

async function waitForPhase(app: ElectronApplication, phase: string) {
  await expect.poll(async () => (await recordingState(app)).phase, { timeout: 20_000 }).toBe(phase);
  return recordingState(app);
}

async function waitForGrowth(file: string, from: number) {
  await expect.poll(() => size(file), { timeout: 15_000 }).toBeGreaterThan(from);
  return size(file);
}

// Leaves the app idle with the capture host still hidden, so the harness can
// check the window roles and reset the case.
async function settle(app: ElectronApplication, owned: ReusableApp): Promise<void> {
  const state = await recordingState(app);
  if (state.phase !== 'idle') {
    await invokeMain(app, 'recording-request-stop');
    await waitForPhase(app, 'idle');
  }
  await app.evaluate(async ({ app }) => {
    const registry = process.mainModule!.require(
      `${app.getAppPath()}/dist/transcriptionJobs.js`,
    ).transcriptionJobs;
    const deadline = Date.now() + 15_000;
    while (registry.list().jobs.some((job: { status: string }) => job.status === 'running')) {
      if (Date.now() > deadline) throw new Error('Auto job did not settle');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });
  await owned.assertWindows('recording-settled');
  await releaseSyntheticCapture(app);
}

// Readiness of the loopback, within one 20s budget from the start of live
// captions: both peers connected over numeric host candidates (the launch
// turns off mDNS host-candidate hiding), each saw the other's candidates, a
// candidate pair succeeded on each side, and RTP went out and came in.
// getStats() reports each peer on its own schedule, so one peer can already
// show RTP while its pair still reads in-progress; the snapshot is re-read
// until it meets every criterion. Candidate kinds only: no addresses are read
// out. The satisfying snapshot is kept as an output file of the case; on a
// timeout the last snapshot is kept and added to the failure.
function unmetLoopbackCriteria(peers: any): string[] {
  const unmet: string[] = [];
  for (const [name, side] of [
    ['offerer', peers.offerer],
    ['answerer', peers.answerer],
  ] as const) {
    if (!side) {
      unmet.push(`${name}: no peer`);
      continue;
    }
    if (side.connection !== 'connected') unmet.push(`${name}: ${side.connection}`);
    if (!side.localSdp.length) unmet.push(`${name}: no local candidates`);
    if (!side.remoteSdp.length) unmet.push(`${name}: no remote candidates`);
    const kinds: string[] = [...side.localSdp, ...side.remoteSdp, ...side.candidateStats];
    if (kinds.some((c) => c.endsWith('/mdns'))) unmet.push(`${name}: mDNS candidate`);
    if (!side.candidateStats.some((c: string) => c.startsWith('remote-candidate:')))
      unmet.push(`${name}: no remote candidate stats`);
    if (!((side.pairs.succeeded ?? 0) > 0)) unmet.push(`${name}: no succeeded pair`);
  }
  if (!(peers.offerer?.rtp['outbound-rtp']?.packets > 0)) unmet.push('offerer: no outbound RTP');
  if (!(peers.answerer?.rtp['inbound-rtp']?.packets > 0)) unmet.push('answerer: no inbound RTP');
  return unmet;
}

async function expectLoopbackReady(app: ElectronApplication): Promise<void> {
  let peers: any;
  try {
    await expect
      .poll(
        async () => {
          peers = await realtimeDiagnostics(app);
          return unmetLoopbackCriteria(peers);
        },
        { timeout: 20_000 },
      )
      .toEqual([]);
  } catch (error) {
    const diagnostics = JSON.stringify(peers ?? null, null, 2);
    const path = test.info().outputPath('realtime-diagnostics.json');
    writeFileSync(path, diagnostics);
    await test
      .info()
      .attach('realtime-diagnostics.json', { path, contentType: 'application/json' });
    throw new Error(`${(error as Error).message}\nRealtime loopback diagnostics:\n${diagnostics}`, {
      cause: error,
    });
  }
  // Kept with the case's results as the evidence of what the peers used.
  writeFileSync(
    test.info().outputPath('realtime-connected-diagnostics.json'),
    JSON.stringify(peers, null, 2),
  );
  for (const side of [peers.offerer, peers.answerer]) {
    expect(side.connection).toBe('connected');
    expect(side.localSdp.length).toBeGreaterThan(0);
    expect(side.remoteSdp.length).toBeGreaterThan(0);
    expect(
      [...side.localSdp, ...side.remoteSdp, ...side.candidateStats].filter((c: string) =>
        c.endsWith('/mdns'),
      ),
    ).toEqual([]);
    expect(side.candidateStats.some((c: string) => c.startsWith('remote-candidate:'))).toBe(true);
    expect(side.pairs.succeeded ?? 0).toBeGreaterThan(0);
  }
  expect(peers.offerer.rtp['outbound-rtp'].packets).toBeGreaterThan(0);
  expect(peers.answerer.rtp['inbound-rtp'].packets).toBeGreaterThan(0);
}

async function startWithoutUi(app: ElectronApplication, title: string) {
  const started = await invokeMain(app, 'recording-request-start', { title });
  expect(started).toEqual({ success: true });
  const state = await waitForPhase(app, 'recording');
  expect(state.title).toBe(title);
  expect(state.filePath).toBeTruthy();
  return state;
}

test('a recording started without the UI survives a UI reload and main starts auto mode', async () => {
  const dataDir = shared.seed(SEED);
  const { app, page } = await shared.start();
  try {
    await installSyntheticCapture(app);
    const started = await startWithoutUi(app, 'Synthetic Sync');
    const file: string = started.filePath;
    // The visible window only subscribes; it follows main without any click.
    await expect(page.locator('#recordButton')).toHaveText('Stop Recording');
    const roles = await shared.assertWindows('recording');
    expect(roles.capture).toBeDefined();
    let bytes = await waitForGrowth(file, 0);

    await page.locator('#liveNoteFlagButton').click();
    await page.locator('#liveNoteInput').fill('Budget approved');
    await page.locator('#liveNoteInput').press('Enter');
    await expect.poll(async () => (await recordingState(app)).notes.length).toBe(2);

    await page.reload();
    await expect(page.locator('#loadingIndicator')).toBeHidden();
    // Same session, reattached: same file, still recording, notes restored.
    await expect(page.locator('#recordButton')).toHaveText('Stop Recording');
    await expect(page.locator('#liveNotesList')).toContainText('Budget approved');
    const reloaded = await recordingState(app);
    expect(reloaded.phase).toBe('recording');
    expect(reloaded.filePath).toBe(file);
    expect(reloaded.startedAt).toBe(started.startedAt);
    bytes = await waitForGrowth(file, bytes);
    expect(await shared.assertWindows('after-ui-reload')).toEqual(roles);

    // Auto mode on (in memory) with a synthetic provider result.
    await app.evaluate(({ app }) => {
      (globalThis as any).__listenerReusableBaseline.config.config.autoMode = true;
      process.mainModule!.require(
        `${app.getAppPath()}/dist/geminiService.js`,
      ).GeminiService.prototype.transcribeAudio = async () => ({
        transcript: 'Speaker 1: Synthetic recording transcript.',
        summary: 'Synthetic summary.',
        keyPoints: [],
        actionItems: [],
        suggestedTitle: 'Synthetic Sync',
      });
    });
    await page.locator('#recordButton').click();
    const stopped = await waitForPhase(app, 'idle');
    expect(stopped.lastResult).toMatchObject({ success: true, stopReason: 'user', filePath: file });
    expect(stopped.lastResult.autoMode.status).toBe('started');
    expect(size(file)).toBeGreaterThanOrEqual(bytes);
    const jobId = stopped.lastResult.autoMode.jobId;
    await expect
      .poll(async () => {
        const { jobs } = await invokeMain(app, 'get-transcription-jobs');
        return jobs.find((job: { id: string }) => job.id === jobId)?.status;
      })
      .toBe('succeeded');
    const { jobs } = await invokeMain(app, 'get-transcription-jobs');
    expect(jobs.find((job: { id: string }) => job.id === jobId)).toMatchObject({
      origin: 'auto',
      kind: 'transcribe',
    });
    // The notes taken before the reload reached the saved note.
    const notes = readdirSync(join(dataDir, 'transcriptions')).flatMap((folder) => {
      const path = join(dataDir, 'transcriptions', folder, 'notes.json');
      return existsSync(path) ? [readFileSync(path, 'utf8')] : [];
    });
    expect(notes.join('\n')).toContain('Budget approved');
    await expect(page.locator('#recordButton')).toHaveText('Start Recording');
    await expect(page.locator('#statusText')).not.toHaveText('Recording...');
    await settle(app, shared);
  } finally {
    await shared.finish();
  }
});

test('a capture host crash finalizes the partial file and a new host records again', async () => {
  shared.seed(SEED);
  const { app, page } = await shared.start();
  try {
    await installSyntheticCapture(app);
    const started = await startWithoutUi(app, 'Crash Case');
    const file: string = started.filePath;
    const bytes = await waitForGrowth(file, 0);
    await app.evaluate(({ BrowserWindow }) => {
      const host = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().endsWith('/renderer/capture.html'),
      );
      if (!host) throw new Error('No capture host');
      host.webContents.forcefullyCrashRenderer();
    });
    const lost = await waitForPhase(app, 'idle');
    expect(lost.lastResult).toMatchObject({
      success: true,
      stopReason: 'host-lost',
      filePath: file,
    });
    expect(lost.lastResult.autoMode).toEqual({ status: 'off' });
    expect(lost.lastError.code).toBe('host-lost');
    expect(size(file)).toBeGreaterThanOrEqual(bytes);
    await expect(page.locator('#recordButton')).toHaveText('Start Recording');
    // The crashed host is gone; release its pinned ID deliberately.
    await shared.releaseCaptureHost();
    expect((await shared.assertWindows('after-host-crash')).capture).toBeUndefined();

    // The next recording loads a fresh host and works from the UI as well.
    await page.locator('#meetingTitle').fill('After Crash');
    await page.locator('#recordButton').click();
    const again = await waitForPhase(app, 'recording');
    expect(again.title).toBe('After Crash');
    await waitForGrowth(again.filePath, 0);
    expect((await shared.assertWindows('replacement-host')).capture).toBeDefined();
    await page.locator('#recordButton').click();
    const done = await waitForPhase(app, 'idle');
    expect(done.lastResult).toMatchObject({ success: true, stopReason: 'user' });
    await settle(app, shared);
  } finally {
    await shared.finish();
  }
});

// Live captions are captured in the same host, so the case also proves a
// destroyed and recreated window neither ends nor restarts a live session.
test('recording continues after the main window is destroyed and a recreated window reattaches', async () => {
  const owned = new ReusableApp('recording-window', { fresh: true, packaged });
  try {
    owned.seed(SEED);
    const { app, page } = await owned.start();
    await installSyntheticCapture(app);
    await installSyntheticLiveProvider(app);
    const started = await startWithoutUi(app, 'Window Case');
    const file: string = started.filePath;
    await invokeMain(app, 'recording-add-note', { text: 'Before close' });
    let bytes = await waitForGrowth(file, 0);

    await page.locator('#liveSessionStartButton').click();
    await expect(page.locator('#liveSessionStatus')).toContainText('Listening');
    await syntheticLiveFinal(app, '창을 닫기 전 발언입니다.', 'Before the window closed.');
    await expect(page.locator('#liveTranscriptList')).toContainText('창을 닫기 전 발언입니다.');
    await page.locator('#liveSessionMinimizeButton').click();
    const live = (await invokeMain(app, 'live-session-snapshot')).snapshot;
    expect(live.active).toBe(true);
    let frames = (await syntheticLive(app)).frames;

    // Win/Linux close destroys the window; destroy it directly here.
    await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().endsWith('/renderer/index.html'),
      );
      main!.destroy();
    });
    bytes = await waitForGrowth(file, bytes);
    expect((await recordingState(app)).phase).toBe('recording');
    // No window at all: live PCM still reaches the provider from the host.
    await expect.poll(async () => (await syntheticLive(app)).frames).toBeGreaterThan(frames);
    await syntheticLiveFinal(app, '창이 없는 동안의 발언입니다.', 'While no window existed.');
    frames = (await syntheticLive(app)).frames;

    // Dock click / tray Open recreates the window; it reattaches from the snapshot.
    await app.evaluate(({ app }) => app.emit('activate'));
    const replacement: Page = await owned.adoptReplacedMainWindow(page);
    await expect(replacement.locator('#loadingIndicator')).toBeHidden();
    await expect(replacement.locator('#recordButton')).toHaveText('Stop Recording');
    await expect(replacement.locator('#liveNotesList')).toContainText('Before close');
    await waitForGrowth(file, bytes);

    // The recreated window reattaches to the same live session.
    await expect(replacement.locator('#liveSessionIndicatorStatus')).toHaveText('Live captions on');
    expect((await invokeMain(app, 'live-session-snapshot')).snapshot).toMatchObject({
      sessionId: live.sessionId,
      active: true,
    });
    await expect.poll(async () => (await syntheticLive(app)).frames).toBeGreaterThan(frames);
    await syntheticLiveFinal(app, '새 창에서 이어진 발언입니다.', 'Continued in the new window.');
    await replacement.locator('#liveSessionStartButton').click();
    await expect(replacement.locator('#liveSessionPanel')).toBeVisible();
    for (const text of [
      '창을 닫기 전 발언입니다.',
      '창이 없는 동안의 발언입니다.',
      '새 창에서 이어진 발언입니다.',
    ])
      await expect(replacement.locator('#liveTranscriptList')).toContainText(text);
    await replacement.locator('#liveSessionAsk > summary').click();
    await replacement.locator('#liveChatInput').fill('What happened?');
    await replacement.locator('#liveChatSend').click();
    await expect(replacement.locator('#liveChatMessages')).toContainText('Synthetic live answer.');
    await replacement.locator('#liveSessionCloseButton').click();
    await expect(replacement.locator('#liveSessionStatus')).toHaveText('Live transcript ready.');
    expect(await syntheticLive(app)).toMatchObject({ starts: 1, closes: 1, serviceStarts: 1 });
    await replacement.locator('#liveSessionMinimizeButton').click();

    await replacement.locator('#recordButton').click();
    const done = await waitForPhase(app, 'idle');
    expect(done.lastResult).toMatchObject({ success: true, filePath: file });
    await settle(app, owned);
    await owned.finish();
  } finally {
    await owned.close();
  }
});

// The OpenAI Realtime transport is a WebRTC peer owned by the hidden capture
// host. A native loopback peer in that host answers its real offer, so the
// production peer's audio track arrives as RTP and its data channel carries
// the transcription events, across a UI reload and a destroyed window.
test('the host-owned OpenAI Realtime WebRTC peer keeps streaming across a UI reload and after the main window is destroyed', async () => {
  const owned = new ReusableApp('recording-window', { fresh: true, packaged });
  try {
    owned.seed(SEED);
    const { app, page } = await owned.start();
    await installSyntheticCapture(app);
    await installSyntheticRealtime(app);
    const started = await startWithoutUi(app, 'Realtime Case');
    let bytes = await waitForGrowth(started.filePath, 0);

    await page.locator('#liveSessionStartButton').click();
    await expect(page.locator('#liveSessionStatus')).toContainText('Listening');
    await expectLoopbackReady(app);
    let rtp = await realtimeEvidence(app);
    expect(rtp).toMatchObject({
      calls: 1,
      peers: 1,
      connection: 'connected',
      channel: 'open',
      authorization: ['Bearer synthetic-client-secret'],
    });
    // The client secret goes to the host only, never to the visible window.
    expect(
      await page.evaluate(async () =>
        JSON.stringify(await window.electronAPI.getLiveSessionSnapshot()),
      ),
    ).not.toContain('synthetic-client-secret');
    const live = (await invokeMain(app, 'live-session-snapshot')).snapshot;
    expect(live.active).toBe(true);

    await realtimeSay(app, 'one', '첫 번째 실시간 발언입니다.');
    await expect(page.locator('#liveTranscriptList')).toContainText('첫 번째 실시간 발언입니다.');

    // Reload the visible window: the peer, its RTP and its channel carry on.
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('#liveSessionIndicatorStatus')).toHaveText('Live captions on');
    await expect.poll(async () => (await realtimeEvidence(app)).bytes).toBeGreaterThan(rtp.bytes);
    rtp = await realtimeEvidence(app);
    expect(rtp).toMatchObject({ calls: 1, peers: 1, connection: 'connected', channel: 'open' });
    await realtimeSay(app, 'two', '새로고침 뒤의 발언입니다.');

    // Destroy the window (Win/Linux close): no window at all, RTP continues.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().endsWith('/renderer/index.html'))!
        .destroy();
    });
    await expect.poll(async () => (await realtimeEvidence(app)).bytes).toBeGreaterThan(rtp.bytes);
    await realtimeSay(app, 'three', '창이 없는 동안의 실시간 발언입니다.');
    rtp = await realtimeEvidence(app);
    bytes = await waitForGrowth(started.filePath, bytes);

    // A recreated window reattaches to the same session and transport.
    await app.evaluate(({ app }) => app.emit('activate'));
    const replacement: Page = await owned.adoptReplacedMainWindow(page);
    await expect(replacement.locator('#loadingIndicator')).toBeHidden();
    await expect(replacement.locator('#liveSessionIndicatorStatus')).toHaveText('Live captions on');
    expect((await invokeMain(app, 'live-session-snapshot')).snapshot).toMatchObject({
      sessionId: live.sessionId,
      active: true,
    });
    await expect.poll(async () => (await realtimeEvidence(app)).bytes).toBeGreaterThan(rtp.bytes);
    await replacement.locator('#liveSessionStartButton').click();
    await expect(replacement.locator('#liveSessionPanel')).toBeVisible();
    for (const text of [
      '첫 번째 실시간 발언입니다.',
      '새로고침 뒤의 발언입니다.',
      '창이 없는 동안의 실시간 발언입니다.',
    ])
      await expect(replacement.locator('#liveTranscriptList')).toContainText(text);

    // Stop flushes the host's tail through the same channel before closing.
    // An earlier interval commit is still open, and completes first: the
    // flush must wait for its own final commit's item, not the first reply.
    await expect
      .poll(async () => (await realtimeEvidence(app)).openItems, { timeout: 10_000 })
      .toBeGreaterThan(0);
    await realtimeTail(app, '마지막 꼬리 발언입니다.');
    await replacement.locator('#liveSessionCloseButton').click();
    await expect(replacement.locator('#liveSessionStatus')).toHaveText('Live transcript ready.');
    // The tail reaches the dialog even though its segment event can arrive
    // after the stop reply (the stop snapshot carries it).
    await expect(replacement.locator('#liveTranscriptList')).toContainText(
      '마지막 꼬리 발언입니다.',
    );
    expect(await realtimeEvidence(app)).toMatchObject({ calls: 1, peers: 1 });
    expect(await syntheticRealtime(app)).toEqual({
      serviceStarts: 1,
      secrets: 1,
      streamingStarts: 0,
    });
    await replacement.locator('#liveSessionMinimizeButton').click();

    // Stop Recording with live captions on and a slow provider reply: capture
    // (file, RTP) ends at the click while the tail still drains into main.
    await replacement.locator('#liveSessionStartButton').click(); // opens the stopped transcript
    await replacement.locator('#liveSessionRestartButton').click();
    await expect(replacement.locator('#liveSessionStatus')).toContainText('Listening');
    await expect.poll(async () => (await realtimeEvidence(app)).peers).toBe(2);
    await expect
      .poll(async () => (await realtimeEvidence(app)).connection, { timeout: 20_000 })
      .toBe('connected');
    await expect
      .poll(async () => (await realtimeEvidence(app)).packets, { timeout: 20_000 })
      .toBeGreaterThan(0);
    const second = (await invokeMain(app, 'live-session-snapshot')).snapshot;
    await replacement.locator('#liveSessionMinimizeButton').click();
    await expect
      .poll(async () => (await realtimeEvidence(app)).openItems, { timeout: 10_000 })
      .toBeGreaterThan(0);
    // Stop timing comes from the app itself (same machine clock), not from
    // around Playwright's click, whose actionability waits vary by runner:
    // the click event as dispatched in the window, and the moment the window
    // learns main is stopping.
    await replacement.evaluate(() => {
      const timing: { clickAt?: number; stoppingAt?: number } = {};
      (window as any).__stopTiming = timing;
      document
        .getElementById('recordButton')!
        .addEventListener('click', () => (timing.clickAt ??= Date.now()), { capture: true });
      window.electronAPI.onRecordingStateChanged((snapshot) => {
        if (snapshot.phase === 'stopping') timing.stoppingAt ??= Date.now();
      });
    });
    // The provider replies to the final commit only after TAIL_REPLY_MS: a stop
    // that waits for that reply before ending capture shows it in the stages.
    // The host's flush waits at most 1.5s after its final commit, and a reply
    // after that is dropped by design, so the reply stays well inside that cap
    // (1.4s left only 0.1s for channel and timer delay) while the stage bounds
    // below stay under the reply.
    const TAIL_REPLY_MS = 1_100;
    await realtimeTail(app, '녹음 정지 중의 꼬리 발언입니다.', TAIL_REPLY_MS);
    await replacement.locator('#recordButton').click();
    // RTP stops at once (the sender is muted before the provider replies).
    await new Promise((resolve) => setTimeout(resolve, 300));
    const mutedAt = (await realtimeEvidence(app)).bytes;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await realtimeEvidence(app)).bytes).toBe(mutedAt);
    const done = await waitForPhase(app, 'idle');
    expect(done.lastResult).toMatchObject({ success: true, filePath: started.filePath });
    const timing = await replacement.evaluate(
      () => (window as any).__stopTiming as { clickAt: number; stoppingAt: number },
    );
    const recordedEnd = Number(started.startedAt) + done.lastResult.durationMs;
    const stages = {
      clickToStopping: timing.stoppingAt - timing.clickAt,
      stoppingToRecordedEnd: recordedEnd - timing.stoppingAt,
      tailReply: TAIL_REPLY_MS,
    };
    console.log(`[stop-timing] ${JSON.stringify(stages)}`);
    // The window asks main to stop at once; waiting for live captions to stop
    // first would put the provider's reply between the click and 'stopping'.
    expect(stages.clickToStopping, JSON.stringify(stages)).toBeLessThan(TAIL_REPLY_MS - 400);
    // The host ends capture (the recorded duration) without waiting for that
    // reply; waiting for it would put it between 'stopping' and the end.
    expect(stages.stoppingToRecordedEnd, JSON.stringify(stages)).toBeLessThan(TAIL_REPLY_MS - 400);
    const ended = (await invokeMain(app, 'live-session-snapshot')).snapshot;
    expect(ended).toMatchObject({ sessionId: second.sessionId, active: false });
    // Which commit took the tail, when it was sent and whether the host got it
    // before its channel closed; kept with the case's results.
    const tailTimeline = await realtimeTimeline(app);
    writeFileSync(
      test.info().outputPath('realtime-tail-timeline.json'),
      JSON.stringify(tailTimeline, null, 2),
    );
    console.log(`[tail-timeline] ${JSON.stringify(tailTimeline)}`);
    expect(ended.transcript, JSON.stringify(tailTimeline)).toContain('녹음 정지 중의 꼬리 발언입니다.');
    await settle(app, owned);
    await owned.finish();
  } finally {
    await owned.close();
  }
});

// Settings requested from the app menu (or the tray) when the main window was
// destroyed recreates it, and the request waits until the new page listens.
test('Settings requested after the main window is destroyed opens in the recreated window', async () => {
  test.skip(!caseApplies(test.info().title), 'The app menu Settings item exists only on macOS.');
  const owned = new ReusableApp('recording-window', { fresh: true, packaged });
  try {
    owned.seed(SEED);
    const { app, page } = await owned.start();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().endsWith('/renderer/index.html'))!
        .destroy();
    });
    const clicked = await app.evaluate(({ Menu }) => {
      const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
        for (const item of items) {
          if (item.label === 'Settings...') return item;
          const inner = item.submenu && find(item.submenu.items);
          if (inner) return inner;
        }
        return undefined;
      };
      const item = find(Menu.getApplicationMenu()?.items ?? []);
      if (!item) return false;
      item.click();
      return true;
    });
    expect(clicked).toBe(true);
    const replacement: Page = await owned.adoptReplacedMainWindow(page);
    await expect(replacement.locator('#configModal')).toHaveJSProperty('open', true);
    await owned.assertWindows('settings-recreated');
    await owned.finish();
  } finally {
    await owned.close();
  }
});

// Quit is bounded by one deadline (3s stop grace + 5s finalize wait in
// src/main.ts) even when the live-caption tail never drains: the real
// app.quit() runs, the process exits on its own (no signal), and the audio,
// closed before the drain is awaited, is a non-empty WebM.
test('quitting during a recording with a stalled live caption tail exits within the deadline and keeps the audio', async () => {
  const owned = new ReusableApp('recording-quit', { fresh: true, packaged });
  try {
    owned.seed(SEED);
    const { app, page } = await owned.start();
    await installSyntheticCapture(app);
    await installSyntheticLiveProvider(app);
    const started = await startWithoutUi(app, 'Quit Case');
    const file: string = started.filePath;
    await waitForGrowth(file, 0);
    expect(
      await invokeMain(app, 'recording-add-note', { text: 'Decision before quit' }),
    ).toMatchObject({
      success: true,
    });
    await page.locator('#liveSessionStartButton').click();
    await expect(page.locator('#liveSessionStatus')).toContainText('Listening');
    await page.locator('#liveSessionMinimizeButton').click();
    await expect.poll(async () => (await syntheticLive(app)).frames).toBeGreaterThan(0);
    await stallSyntheticLiveClose(app);

    const child = app.process();
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal })),
    );
    const quitAt = Date.now();
    await app.evaluate(({ app }) => {
      setTimeout(() => app.quit(), 0);
    });
    const outcome = await Promise.race([
      exited,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 30_000)),
    ]);
    const elapsed = Date.now() - quitAt;
    expect(outcome).toEqual({ code: 0, signal: null });
    // The stalled tail held quit until the deadline, and no longer.
    expect(elapsed).toBeGreaterThan(7_000);
    expect(elapsed).toBeLessThan(8_000 + 4_000);

    const bytes = readFileSync(file);
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.subarray(0, 4).toString('hex')).toBe('1a45dfa3'); // EBML / WebM header
    const sizeAtExit = bytes.length;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(size(file)).toBe(sizeAtExit);
    // The user's note was persisted before the stalled drain, not lost with it.
    const sidecar = join(
      owned.dataDir,
      'metadata',
      `${basename(file).replace(/\.[^.]+$/, '')}.json`,
    );
    const metadata = JSON.parse(readFileSync(sidecar, 'utf8'));
    expect(metadata.liveNotes).toEqual([expect.objectContaining({ text: 'Decision before quit' })]);
  } finally {
    await owned.close();
  }
});

// While the recording is stopping, main refuses notes; the window's notes
// panel stops taking them at once and keeps whatever was typed.
test('the notes panel stops taking notes while the recording is stopping and keeps typed text', async () => {
  shared.seed(SEED);
  const { app, page } = await shared.start();
  await installSyntheticCapture(app);
  await startWithoutUi(app, 'Notes While Stopping');
  const input = page.locator('#liveNoteInput');
  await expect(input).toBeEnabled();
  await input.fill('Typed before the stop');
  // Keep the stop from reaching the host so the recording stays 'stopping'.
  await app.evaluate(({ app }) => {
    process.mainModule!.require(`${app.getAppPath()}/dist/captureHost.js`).CaptureHostWindow.prototype.stop =
      () => {};
  });
  await app.evaluate(({ ipcMain }) => {
    void (ipcMain as any)._invokeHandlers.get('recording-request-stop')({ sender: null });
  });
  await waitForPhase(app, 'stopping');
  await expect(input).toBeDisabled();
  await expect(page.locator('#liveNoteFlagButton')).toBeDisabled();
  await expect(input).toHaveValue('Typed before the stop');
  // Main's rule is unchanged: a note sent now is refused, not taken silently.
  expect(await page.evaluate(() => window.electronAPI.addRecordingNote({ text: 'late' }))).toMatchObject({
    success: false,
  });
  expect((await recordingState(app)).notes).toEqual([]);
  // The 10s grace force-finalizes the stuck stop and disposes the host it
  // never heard from; release its pinned window role like the crash case.
  await waitForPhase(app, 'idle');
  await shared.releaseCaptureHost();
  await settle(app, shared);
  await shared.finish();
});

// A normal stop gives a silent capture host 10s before it force-finalizes. A
// quit within that window must pull the force-finalize inside its own
// deadline (3s grace), or the process exits first and the recording's notes
// are never saved. The stop command is kept from reaching the host page, so
// the host never confirms, exactly like a hung capture renderer.
test('quitting during a recording after a stop the capture host never confirmed saves the audio and notes', async () => {
  const owned = new ReusableApp('recording-quit', { fresh: true, packaged });
  try {
    owned.seed(SEED);
    const { app } = await owned.start();
    await installSyntheticCapture(app);
    const started = await startWithoutUi(app, 'Stuck Stop Case');
    const file: string = started.filePath;
    await waitForGrowth(file, 0);
    expect(
      await invokeMain(app, 'recording-add-note', { text: 'Note before the stuck stop' }),
    ).toMatchObject({
      success: true,
    });
    await app.evaluate(({ app }) => {
      const proto = process.mainModule!.require(`${app.getAppPath()}/dist/captureHost.js`)
        .CaptureHostWindow.prototype;
      proto.stop = () => {}; // the host never learns of the stop, never confirms
    });
    // A normal stop (not awaited: it would wait for the 10s grace).
    await app.evaluate(({ ipcMain }) => {
      void (ipcMain as any)._invokeHandlers.get('recording-request-stop')({ sender: null });
    });
    await waitForPhase(app, 'stopping');

    const child = app.process();
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal })),
    );
    const quitAt = Date.now();
    await app.evaluate(({ app }) => {
      setTimeout(() => app.quit(), 500);
    });
    const outcome = await Promise.race([
      exited,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 30_000)),
    ]);
    const elapsed = Date.now() - quitAt;
    expect(outcome).toEqual({ code: 0, signal: null });
    // Quit's own deadline bounds it (0.5s delay + 3s grace + 5s), not the 10s grace.
    expect(elapsed).toBeLessThan(500 + 8_000 + 4_000);

    const bytes = readFileSync(file);
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.subarray(0, 4).toString('hex')).toBe('1a45dfa3');
    const sidecar = join(
      owned.dataDir,
      'metadata',
      `${basename(file).replace(/\.[^.]+$/, '')}.json`,
    );
    const metadata = JSON.parse(readFileSync(sidecar, 'utf8'));
    expect(metadata.liveNotes).toEqual([
      expect.objectContaining({ text: 'Note before the stuck stop' }),
    ]);
  } finally {
    await owned.close();
  }
});
