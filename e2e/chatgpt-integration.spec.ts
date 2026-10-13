import { test, expect } from '@playwright/test';
import { type ElectronApplication, type Page } from 'playwright';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { backgroundArtifact } from './background-test';
import { ReusableApp } from './support/reusable-app';

// Offline UI evidence only: every connected account and model below is an
// injected fake auth/service response. Real IPC and config gates stay intact.
// No OAuth browser, microphone, or inference runs.
const evidenceDir =
  process.env.LISTENER_CHATGPT_EVIDENCE_DIR ?? join(tmpdir(), 'listener-chatgpt-gui');
mkdirSync(evidenceDir, { recursive: true });

function readFixtureHashes(path: string): { path: string; sha256: string }[] | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

// Module-level preflight also protects the smoke test in this combined invocation.
if (process.env.LISTENER_SMOKE_BUILD_DIR) backgroundArtifact(process.env.LISTENER_SMOKE_BUILD_DIR);

type FakeState =
  | 'signed-out'
  | 'identity'
  | 'incomplete'
  | 'plan'
  | 'model-error'
  | 'missing-model'
  | 'pending'
  | 'disconnected-active'
  | 'same-email';
let app: ElectronApplication;
let page: Page;
let dataDir: string;
let preserved: Map<string, Buffer>;
let nativeDialogs: string[];
const sharedSession = new ReusableApp('chatgpt', { packaged: true });
let selectedSession: ReusableApp | undefined;
let freshSession = false;
let disposeDialogObserver: (() => void) | undefined;
let unsafeNativeState = false;

async function launch(config: Record<string, unknown> = {}, rawConfig = false): Promise<void> {
  app = undefined!;
  page = undefined!;
  dataDir = undefined!;
  preserved = undefined!;
  nativeDialogs = [];
  unsafeNativeState = false;
  if (rawConfig !== test.info().title.startsWith('startup '))
    throw new Error('Only the four startup cases may request a fresh ChatGPT app.');
  freshSession = rawConfig;
  selectedSession = rawConfig
    ? new ReusableApp(`chatgpt-startup-${test.info().testId}`, { packaged: true, fresh: true })
    : sharedSession;
  dataDir = selectedSession.seed(
    rawConfig ? config : { aiProvider: 'chatgpt', transcriptionProvider: 'auto', ...config },
  );
  mkdirSync(join(dataDir, 'recordings'), { recursive: true });
  mkdirSync(join(dataDir, 'metadata'), { recursive: true });
  const name = 'Synthetic_Meeting_2026-10-12T00-00-00-000Z';
  const audioPath = join(dataDir, 'recordings', `${name}.wav`);
  writeFileSync(audioPath, Buffer.alloc(44));
  const { saveTranscription } =
    require('../dist/outputService.js') as typeof import('../src/outputService');
  const { createTranscriptCutoff } =
    require('../dist/transcriptCutoff.js') as typeof import('../src/transcriptCutoff');
  const transcript = 'Speaker 1: Synthetic existing meeting.\nSpeaker 2: Excluded synthetic tail.';
  const folder = saveTranscription({
    title: 'Synthetic Meeting',
    result: { transcript, summary: 'Synthetic summary.', keyPoints: [], actionItems: [] },
    audioFilePath: audioPath,
    dataPath: dataDir,
  });
  const metaPath = join(folder, 'meta.json');
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  meta.transcriptCutoff = createTranscriptCutoff(transcript, transcript.indexOf('Speaker 2:'));
  writeFileSync(metaPath, JSON.stringify(meta));
  const sidecar = join(dataDir, 'metadata', `${name}.json`);
  writeFileSync(
    sidecar,
    JSON.stringify({
      filePath: audioPath,
      title: 'Synthetic Meeting',
      timestamp: '2026-10-12T00:00:00.000Z',
      transcriptionPath: folder,
    }),
  );
  preserved = new Map(
    [audioPath, sidecar, metaPath, join(folder, 'transcript.md'), join(folder, 'summary.md')].map(
      (path) => [path, readFileSync(path)],
    ),
  );
  writeFileSync(
    join(dataDir, 'fixture-before.json'),
    JSON.stringify(
      [...preserved].map(([path, bytes]) => ({
        path,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })),
      null,
      2,
    ),
  );
  ({ app, page } = await selectedSession.start());
  const observedApp = app;
  const observed = new WeakSet<Page>();
  const handlers = new Map<Page, (dialog: import('playwright').Dialog) => void>();
  const observe = (window: Page) => {
    if (observed.has(window)) return;
    observed.add(window);
    const handler = (dialog: import('playwright').Dialog) => {
      nativeDialogs.push(dialog.message());
      void dialog.dismiss().catch(() => {});
    };
    handlers.set(window, handler);
    window.on('dialog', handler);
  };
  app.on('window', observe);
  app.windows().forEach(observe);
  disposeDialogObserver = () => {
    observedApp.off('window', observe);
    for (const [window, handler] of handlers) window.off('dialog', handler);
  };
  await expect
    .poll(() => page.evaluate(() => !!(window as any).__listenerBackgroundTestDialogs))
    .toBe(true);
  await app.evaluate(({ BrowserWindow, app }) => {
    const proof = { pid: process.pid, events: [] as string[], snapshots: [] as unknown[] };
    (globalThis as any).__listenerBackgroundProof = proof;
    const handlers: (() => void)[] = [];
    const observe = (window: Electron.BrowserWindow) => {
      for (const event of ['show', 'focus', 'restore'] as const) {
        const handler = () => proof.events.push(`${window.id}:${event}`);
        window.on(event, handler);
        handlers.push(() => window.off(event, handler));
      }
    };
    BrowserWindow.getAllWindows().forEach(observe);
    const onWindow = (_event: unknown, window: Electron.BrowserWindow) => observe(window);
    app.on('browser-window-created', onWindow);
    (globalThis as any).__listenerDisposeBackgroundProof = () => {
      app.off('browser-window-created', onWindow);
      handlers.forEach((dispose) => dispose());
    };
  });
  await assertBackground();
}

async function dialogMessages(): Promise<string[]> {
  return await page.evaluate(() =>
    (window as any).__listenerBackgroundTestDialogs.events.map(
      (event: { message: string }) => event.message,
    ),
  );
}

async function assertBackground(): Promise<void> {
  await assertNativeSafety('background-observation');
  const shortcut = await page.evaluate(
    async () => (await window.electronAPI.getConfig()).globalShortcut,
  );
  const proof = await app.evaluate(({ BrowserWindow, app, globalShortcut }, shortcut) => {
    const proof = (globalThis as any).__listenerBackgroundProof;
    const snapshot = {
      windows: BrowserWindow.getAllWindows().map((window) => ({
        id: window.id,
        visible: window.isVisible(),
        focused: window.isFocused(),
        focusable: window.isFocusable(),
      })),
      dockVisible: process.platform === 'darwin' ? app.dock?.isVisible() : undefined,
      shortcutRegistered: typeof shortcut === 'string' && globalShortcut.isRegistered(shortcut),
    };
    proof.snapshots.push(snapshot);
    return proof;
  }, shortcut);
  writeFileSync(
    join(evidenceDir, `${test.info().testId.replace(/[^a-zA-Z0-9]/g, '_')}-background.json`),
    JSON.stringify(proof, null, 2),
  );
  expect(
    proof.events,
    'Background test attempted to show, restore or focus a native window',
  ).toEqual([]);
  for (const snapshot of proof.snapshots) {
    expect(snapshot.dockVisible).not.toBe(true);
    expect(snapshot.shortcutRegistered).toBe(false);
    for (const window of snapshot.windows) {
      expect(window.visible).toBe(false);
      expect(window.focused).toBe(false);
      expect(window.focusable).toBe(false);
    }
  }
  expect(nativeDialogs, 'Native dialog escaped the non-visible test observer').toEqual([]);
}

async function assertNativeSafety(stage: string): Promise<void> {
  try {
    await app.evaluate((_electron, stage) => {
      const guards = (globalThis as any).__listenerPackagedGuards;
      if (!guards) throw new Error('Packaged guard baseline is missing.');
      guards.assertNativeState(stage);
    }, stage);
  } catch (error) {
    unsafeNativeState = true;
    try {
      await selectedSession?.close();
    } finally {
      app = undefined!;
      page = undefined!;
    }
    throw error;
  }
}

async function fake(state: FakeState): Promise<void> {
  await app.evaluate(({ app, ipcMain }, initial) => {
    const require = process.mainModule!.require.bind(process.mainModule);
    const authModule = require(require('node:path').join(app.getAppPath(), 'dist/chatgptAuth.js'));
    const auth = authModule.getChatGPTAuth();
    const statusFor = (id: string, mode: string) => ({
      connected:
        mode !== 'signed-out' &&
        mode !== 'pending' &&
        !(mode === 'disconnected-active' && id === 'fake-a'),
      planEnabled:
        ['plan', 'model-error', 'missing-model', 'same-email'].includes(mode) ||
        (mode === 'disconnected-active' && id === 'fake-b'),
      planState:
        mode === 'incomplete' ? 'incomplete' : mode === 'identity' ? 'not_granted' : 'enabled',
      profileId: id,
      email: mode === 'same-email' ? 'fake-shared@fake.invalid' : `${id}@fake.invalid`,
      sessionRevision: harness.revision,
    });
    const harness = {
      mode: initial as string,
      active: 'fake-a',
      logins: [] as unknown[],
      usage: 0,
      cancelled: 0,
      models: [] as string[],
      revision: 'injected-fake-grant-1',
    };
    (globalThis as any).__listenerFakeChatGPT = harness;
    const replace = (channel: string, handler: (...args: any[]) => any) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    };
    auth.getStatus = async () => statusFor(harness.active, harness.mode);
    auth.getStatusSync = () => statusFor(harness.active, harness.mode);
    auth.openSession = async (profileId: string) => {
      const revision = harness.revision;
      const isActive = () => revision === harness.revision && harness.mode === 'plan';
      return {
        profileId,
        isActive,
        getAccessToken: async () => {
          if (!isActive())
            throw new authModule.ChatGPTAuthError('session_ended', 'Injected fake grant ended');
          return 'synthetic-unused-never-sent';
        },
        listModels: async () => [
          {
            slug: `${profileId}-model`,
            display_name: 'Injected fake model',
            visibility: 'visible',
          },
        ],
      };
    };
    auth.listProfiles = async () =>
      ['fake-a', 'fake-b'].map((id) => ({
        id,
        ...statusFor(id, harness.mode),
        ...(harness.mode === 'same-email'
          ? { label: `fake-shared@fake.invalid [injected fake workspace ${id}]` }
          : {}),
        active: id === harness.active,
      }));
    auth.listModels = async () => {
      harness.models.push(harness.active);
      if (harness.mode === 'model-error')
        throw new authModule.ChatGPTAuthError(
          'subscription_sharing_usage_limit_exceeded',
          'Injected fake response: ChatGPT plan usage limit reached. Manage usage to continue.',
        );
      return [
        {
          slug: `${harness.active}-model`,
          display_name: `${harness.active} injected fake model`,
          visibility: 'visible',
        },
      ];
    };
    auth.selectProfile = async (id: string) => {
      harness.active = id;
      return statusFor(id, harness.mode);
    };
    auth.signIn = async (options: any) => {
      harness.logins.push({
        requestPlanConsent: options.requestPlanConsent,
        profileId: options.profileId,
        newProfile: options.newProfile,
      });
      if (harness.mode === 'pending')
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => {
              harness.cancelled++;
              reject(new Error('Injected fake cancellation'));
            },
            { once: true },
          );
        });
      harness.mode = 'plan';
      return statusFor(harness.active, harness.mode);
    };
    auth.signOut = async () => {
      harness.mode = 'signed-out';
      return { signedIn: true, revoked: true };
    };
    replace('chatgpt-manage-usage', () => {
      harness.usage++;
      return { success: true };
    });
  }, state);
}

async function settings(): Promise<void> {
  if (!(await page.locator('#configModal').isVisible()))
    await page.locator('#settingsButton').click();
  await expect(page.locator('#configModal')).toBeVisible();
  await page.getByLabel('Summary provider', { exact: true }).selectOption('chatgpt');
}

async function capture(name: string): Promise<void> {
  await assertBackground();
  await assertNativeSafety('before-screenshot');
  await page.screenshot({
    path: join(evidenceDir, `${name}.png`),
    fullPage: true,
    animations: 'disabled',
  });
  await assertNativeSafety('after-screenshot');
}

test.afterEach(async () => {
  if (unsafeNativeState) {
    disposeDialogObserver?.();
    disposeDialogObserver = undefined;
    const owned = selectedSession;
    selectedSession = undefined;
    await owned?.close();
    preserved = undefined!;
    return;
  }
  try {
    if (app && page) await assertBackground();
    if (preserved && app)
      for (const [path, bytes] of preserved)
        expect(
          readFileSync(path).equals(bytes),
          `Existing synthetic fixture changed: ${path}`,
        ).toBe(true);
    if (preserved && app)
      writeFileSync(
        join(dataDir, 'fixture-after.json'),
        JSON.stringify(
          [...preserved.keys()].map((path) => ({
            path,
            sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
          })),
          null,
          2,
        ),
      );
  } finally {
    try {
      // Archive only this case's synthetic fixture before the reusable root is reset.
      if (dataDir && preserved && app) {
        const archive = join(
          evidenceDir,
          `${test.info().testId.replace(/[^a-zA-Z0-9]/g, '_')}-fixture`,
        );
        for (const path of [...preserved.keys(), join(dataDir, 'config.json')]) {
          const destination = join(archive, relative(dataDir, path));
          mkdirSync(dirname(destination), { recursive: true });
          cpSync(path, destination);
        }
        for (const name of ['fixture-before.json', 'fixture-after.json']) {
          const path = join(dataDir, name);
          const hashes = readFixtureHashes(path);
          if (hashes) {
            writeFileSync(
              join(archive, name),
              JSON.stringify(
                hashes.map((entry) => ({
                  ...entry,
                  originalPath: entry.path,
                  path: join(archive, relative(dataDir, entry.path)),
                })),
                null,
                2,
              ),
            );
          }
        }
        writeFileSync(
          join(evidenceDir, `${test.info().testId.replace(/[^a-zA-Z0-9]/g, '_')}-fixture.txt`),
          archive,
        );
      }
    } finally {
      disposeDialogObserver?.();
      disposeDialogObserver = undefined;
      const session = selectedSession;
      selectedSession = undefined;
      if (session && unsafeNativeState) await session.close();
      else if (session) {
        try {
          await session.finish(async () => {
            if (!app || !page) return;
            await app.evaluate(() => {
              (globalThis as any).__listenerDelayedPreflight?.release();
              (globalThis as any).__listenerDisposeBackgroundProof?.();
            });
            await page.evaluate(() => window.electronAPI.cancelChatGPTLogin());
          });
        } finally {
          if (freshSession) await session.close();
        }
      }
      app = undefined!;
      page = undefined!;
      preserved = undefined!;
    }
  }
});

test.afterAll(async () => {
  await sharedSession.close();
});

test('signed-out card, text-only settings and explicit API billing preserve existing data', async () => {
  await launch();
  const dependencies = await app.evaluate(async ({ app }) => {
    const require = process.mainModule!.require.bind(process.mainModule);
    const path = require('node:path');
    const { importEsm } = require(path.join(app.getAppPath(), 'dist/esmImport.js'));
    const jose = await importEsm('jose');
    const piAi = await importEsm('@earendil-works/pi-ai');
    const responses = await importEsm('@earendil-works/pi-ai/api/openai-responses');
    return {
      appPath: app.getAppPath(),
      joseVerify: typeof jose.jwtVerify,
      piAiModels: typeof piAi.createModels,
      responsesStream: typeof responses.stream,
    };
  });
  expect(dependencies.appPath).not.toContain(process.cwd());
  expect(dependencies.joseVerify).toBe('function');
  expect(dependencies.piAiModels).toBe('function');
  expect(dependencies.responsesStream).toBe('function');
  writeFileSync(
    join(evidenceDir, 'packaged-runtime-dependencies.json'),
    JSON.stringify(dependencies, null, 2),
  );
  await settings();
  await expect(page.locator('#chatgptStatus')).toHaveText('Not connected');
  await expect(
    page.getByRole('button', { name: 'Continue with ChatGPT', exact: true }),
  ).toBeVisible();
  await expect(page.locator('#aiProvider option[value="codex"]')).toHaveCount(0);
  await expect(page.locator('#transcriptionProvider option[value="codex"]')).toHaveCount(0);
  await expect(page.locator('#chatgptModelSelect')).toBeDisabled();
  await expect(page.locator('#transcriptionProviderNotice')).toContainText(/choose|select/i);
  await capture('signed-out-card');
  await page.locator('#saveConfig').click();
  await expect(page.locator('#configModal')).not.toBeVisible();
  const gates = await page.evaluate(() => (window as any).electronAPI.checkConfig());
  expect(gates.hasTranscriptionAuth).toBe(false);
  expect(gates.transcriptionProvider).toBeNull();
  expect(gates.transcriptionProviderIssue).toMatch(/choose|select/i);
  await settings();
  await page.getByRole('tab', { name: 'Transcription and summary', exact: true }).click();
  await page.getByLabel('Transcription service', { exact: true }).selectOption('openai');
  // The notice links to the key on the AI connection tab.
  await page
    .locator('#transcriptionProviderNotice')
    .getByRole('button', { name: 'Add an OpenAI API key', exact: true })
    .click();
  await expect(page.locator('#openaiApiKey')).toBeFocused();
  await expect(page.locator('#openaiApiKeyHelp')).toContainText(
    'billed to your OpenAI API account',
  );
  await expect(page.locator('#openaiApiKeyHelp')).toContainText('ChatGPT sign-in does not cover');
  await page.locator('#openaiApiKey').fill('synthetic-unused-key');
  await page.locator('#openaiApiKeyHelp').screenshot({
    path: join(evidenceDir, 'signed-out-openai-billing.png'),
    animations: 'disabled',
  });
  await page.locator('#saveConfig').click();
  await expect(page.locator('#configModal')).not.toBeVisible();
  expect(JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')).transcriptionProvider).toBe(
    'openai',
  );
});

test('legacy Codex config explains migration and requires an explicit STT choice', async () => {
  await launch({
    aiProvider: 'codex',
    transcriptionProvider: 'codex',
    codexModel: 'synthetic-legacy-model',
    codexTranscriptionModel: 'gpt-4o-transcribe',
    codexTranscriptionMigratedToDiarize: false,
    summaryPromptMigratedToStructured: false,
    codexOAuth: { access: 'synthetic-not-a-token' },
  });
  const migrated = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
  expect(migrated.codexTranscriptionModel).toBeUndefined();
  expect(migrated.codexTranscriptionMigratedToDiarize).toBe(true);
  expect(migrated.summaryPromptMigratedToStructured).toBe(true);
  await settings();
  await expect(page.locator('#legacyCodexNotice')).toBeVisible();
  await expect(page.locator('#legacyCodexNotice')).toContainText(
    /removed|replaced|no longer supported/i,
  );
  await expect(page.locator('#transcriptionProviderNotice')).toContainText(
    'Codex transcription was removed',
  );
  await capture('legacy-migration');
  const gates = await page.evaluate(() => (window as any).electronAPI.checkConfig());
  expect(gates.hasTranscriptionAuth).toBe(false);
  expect(gates.transcriptionProvider).toBeNull();
  await page.locator('#saveConfig').click();
  await expect(page.locator('#configModal')).not.toBeVisible();
  expect(JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')).codexModel).toBe(
    'synthetic-legacy-model',
  );
});

test('unrelated Gemini settings save preserves retired raw Codex STT until an explicit provider choice', async () => {
  await launch({
    aiProvider: 'gemini',
    geminiApiKey: 'synthetic-unused-key',
    transcriptionProvider: 'codex',
  });
  await page.locator('#settingsButton').click();
  await expect(page.getByLabel('Summary provider', { exact: true })).toHaveValue('gemini');
  await page.getByRole('tab', { name: 'Transcription and summary', exact: true }).click();
  await page.locator('#knownWordsField').fill('synthetic-preservation-term');
  await page.locator('#saveConfig').click();
  await expect(page.locator('#configModal')).not.toBeVisible();
  const stored = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
  expect(stored.aiProvider).toBe('gemini');
  expect(stored.transcriptionProvider).toBe('codex');
  const gate = await page.evaluate(() => (window as any).electronAPI.checkConfig());
  expect(gate.hasTranscriptionAuth).toBe(false);
  expect(gate.transcriptionProvider).toBeNull();
  expect(gate.transcriptionProviderIssue).toContain('Codex transcription was removed');
  await page.locator('#settingsButton').click();
  await capture('legacy-gemini-preserved-after-unrelated-save');
  await page.getByRole('tab', { name: 'Transcription and summary', exact: true }).click();
  await page.getByLabel('Transcription service', { exact: true }).selectOption('gemini');
  await page.locator('#saveConfig').click();
  await expect(page.locator('#configModal')).not.toBeVisible();
  const explicitlyChosen = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
  expect(explicitlyChosen.transcriptionProvider).toBe('gemini');
  const explicitGate = await page.evaluate(() => (window as any).electronAPI.checkConfig());
  expect(explicitGate.transcriptionProvider).toBe('gemini');
  expect(explicitGate.hasTranscriptionAuth).toBe(true);
  writeFileSync(
    join(evidenceDir, 'legacy-gemini-unrelated-save.json'),
    JSON.stringify({ stored, gate, explicitlyChosen, explicitGate }, null, 2),
  );
});

test('injected fake plan permits text-only setup but actual audio processing refuses auto without fallback', async () => {
  await launch();
  await fake('plan');
  await settings();
  await expect(page.locator('#chatgptPlanBadge')).toContainText('Plan usage enabled');
  await page.locator('#saveConfig').click();
  await expect(page.locator('#configModal')).not.toBeVisible();
  const gates = await page.evaluate(() => (window as any).electronAPI.checkConfig());
  expect(gates.hasAiAuth).toBe(true);
  expect(gates.hasTranscriptionAuth).toBe(false);
  expect(gates.transcriptionProvider).toBeNull();
  expect(gates.transcriptionProviderIssue).toMatch(/choose|select/i);
  await app.evaluate(() => {
    (globalThis as any).__listenerUnexpectedFetches = [];
    globalThis.fetch = async (input) => {
      (globalThis as any).__listenerUnexpectedFetches.push(String(input));
      throw new Error('Offline GUI harness forbids provider network calls');
    };
  });
  const audioPath = [...preserved.keys()].find((path) => path.endsWith('.wav'))!;
  const result = await page.evaluate(
    (path) => (window as any).electronAPI.transcribeAudio(path),
    audioPath,
  );
  expect(result.success).toBe(false);
  expect(result.error).toMatch(/choose|select/i);
  expect(await app.evaluate(() => (globalThis as any).__listenerUnexpectedFetches)).toEqual([]);
  await settings();
  await capture('fake-plan-text-only-audio-refusal');
});

test('real check-config preflight observes injected fake CLI auth changes without opening Settings', async () => {
  await launch();
  await fake('signed-out');
  const before = await page.evaluate(() => (window as any).electronAPI.checkConfig());
  expect(before.hasAiAuth).toBe(false);
  await app.evaluate(() => {
    const harness = (globalThis as any).__listenerFakeChatGPT;
    harness.mode = 'plan';
    harness.revision = 'injected-fake-cli-grant-2';
  });
  const signedIn = await page.evaluate(() => (window as any).electronAPI.checkConfig());
  expect(signedIn.hasAiAuth).toBe(true);
  expect(signedIn.hasTranscriptionAuth).toBe(false);
  expect(signedIn.transcriptionProvider).toBeNull();
  expect(signedIn.chatgptStatus.sessionRevision).toBe('injected-fake-cli-grant-2');
  await app.evaluate(() => {
    (globalThis as any).__listenerFakeChatGPT.mode = 'signed-out';
  });
  const signedOut = await page.evaluate(() => (window as any).electronAPI.checkConfig());
  expect(signedOut.hasAiAuth).toBe(false);
  expect(signedOut.hasTranscriptionAuth).toBe(false);
  await expect(page.locator('#configModal')).not.toBeVisible();
  writeFileSync(
    join(evidenceDir, 'fake-cli-auth-real-preflight.json'),
    JSON.stringify({ before, signedIn, signedOut }, null, 2),
  );
});

for (const state of ['identity', 'incomplete'] as const) {
  test(`injected fake ${state} sign-in offers deliberate plan consent`, async () => {
    await launch({ transcriptionProvider: 'openai', chatgptPlanNoticeAcknowledged: true });
    await fake(state);
    await settings();
    await expect(
      page.getByRole('button', { name: 'Enable ChatGPT plan', exact: true }),
    ).toBeVisible();
    await expect(page.locator('#chatgptModelSelect')).toBeDisabled();
    await capture(`fake-${state}-enable-plan`);
    await page.getByRole('button', { name: 'Enable ChatGPT plan', exact: true }).press('Enter');
    await expect(page.locator('#chatgptPlanBadge')).toContainText('Plan usage enabled');
    expect(
      await app.evaluate(() => (globalThis as any).__listenerFakeChatGPT.logins[0]),
    ).toMatchObject({ requestPlanConsent: true, profileId: 'fake-a' });
  });
}

test('injected fake first sign-in acknowledges plan once and reconnect does not repeat it', async () => {
  await launch({ transcriptionProvider: 'openai' });
  await fake('signed-out');
  await settings();
  await page.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).press('Enter');
  await expect(page.getByRole('dialog', { name: "You're using your ChatGPT plan" })).toBeVisible();
  await capture('fake-first-plan-modal');
  await page.getByRole('button', { name: 'Got it', exact: true }).press('Enter');
  await expect
    .poll(
      () =>
        JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'))
          .chatgptPlanNoticeAcknowledged,
    )
    .toBe(true);
  await page.locator('#cancelConfig').click();
  await settings();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click();
  await expect(page.locator('#chatgptPlanBadge')).toContainText('Plan usage enabled');
  await expect(page.locator('#chatgptPlanDialog')).not.toBeVisible();
});

test('injected fake profile switch reloads models and exposes keyboard labels', async () => {
  await launch({ transcriptionProvider: 'openai', chatgptPlanNoticeAcknowledged: true });
  await fake('plan');
  await settings();
  const account = page.getByRole('combobox', { name: 'Account or workspace', exact: true });
  const model = page
    .getByRole('group', { name: 'ChatGPT', exact: true })
    .getByRole('combobox', { name: 'Summary model optional', exact: true });
  await expect(model).toBeEnabled();
  await account.focus();
  await expect(account).toBeFocused();
  // Electron's macOS native option popup blocks CDP keyboard dispatch. Use
  // Playwright's select API for the change; verify keyboard focus/Tab below.
  await account.selectOption('fake-b');
  await expect(account).toHaveValue('fake-b');
  await expect(model.locator('option[value="fake-b-model"]')).toHaveCount(1);
  await expect(model.locator('option[value="fake-a-model"]')).toHaveCount(0);
  await account.press('Tab');
  await expect(page.getByRole('button', { name: 'Add account', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Add account', exact: true }).press('Tab');
  await expect(page.locator('#chatgptManageUsage')).toBeFocused();
  await page.locator('#chatgptManageUsage').press('Tab');
  await expect(model).toBeFocused();
  await capture('fake-profile-model-keyboard');
});

test('injected fake saved connected account remains selectable when the active account is signed out', async () => {
  await launch();
  await fake('disconnected-active');
  await settings();
  const account = page.getByRole('combobox', { name: 'Account or workspace', exact: true });
  await expect(account).toBeVisible();
  await expect(account).toBeEnabled();
  await expect(account.locator('option[value="fake-b"]')).toHaveCount(1);
  await capture('fake-disconnected-active-account-picker');
  await account.selectOption('fake-b');
  await expect(page.locator('#chatgptStatus')).toContainText('fake-b@fake.invalid');
  await expect(page.locator('#chatgptModelSelect option[value="fake-b-model"]')).toHaveCount(1);
  await capture('fake-disconnected-active-switch-success');
});

test('injected fake same-email saved accounts have distinct stable account labels', async () => {
  await launch();
  await fake('same-email');
  await settings();
  const account = page.getByRole('combobox', { name: 'Account or workspace', exact: true });
  await expect(account.locator('option')).toHaveCount(2);
  const labels = await account.locator('option').allTextContents();
  expect(labels.every((label) => label.includes('fake-shared@fake.invalid'))).toBe(true);
  expect(new Set(labels).size).toBe(2);
  await page.locator('#cancelConfig').click();
  await settings();
  await expect(account.locator('option')).toHaveCount(2);
  expect(await account.locator('option').allTextContents()).toEqual(labels);
  writeFileSync(
    join(evidenceDir, 'fake-same-email-stable-labels.json'),
    JSON.stringify(labels, null, 2),
  );
  await account.scrollIntoViewIfNeeded();
  await capture('fake-same-email-distinct-account-labels');
});

test('injected fake model-list failure retains error and actionable Manage usage', async () => {
  await launch({ transcriptionProvider: 'openai', chatgptModel: 'saved-unavailable-model' });
  await fake('model-error');
  await settings();
  await expect(page.locator('#chatgptNotice')).toContainText('Injected fake response');
  await expect(page.locator('#chatgptModelSelect')).toBeDisabled();
  await expect(page.locator('#chatgptModelSelect')).toHaveValue('saved-unavailable-model');
  await page.locator('#chatgptNoticeManageUsage').press('Enter');
  expect(await app.evaluate(() => (globalThis as any).__listenerFakeChatGPT.usage)).toBe(1);
  await expect(page.locator('#chatgptNotice')).toContainText('Manage usage');
  await capture('fake-model-error-manage-usage');
});

test('real agent-chat IPC carries injected fake usage-limit error and offers Manage usage', async () => {
  await launch();
  await fake('plan');
  await settings();
  await expect(page.locator('#chatgptPlanBadge')).toContainText('Plan usage enabled');
  await page.locator('#cancelConfig').click();
  await app.evaluate(({ app }) => {
    const require = process.mainModule!.require.bind(process.mainModule);
    const path = require('node:path');
    const { AgentService } = require(path.join(app.getAppPath(), 'dist/agentService.js'));
    const { ChatGPTInferenceError } = require(
      path.join(app.getAppPath(), 'dist/chatgptResponses.js'),
    );
    AgentService.prototype.run = async () => {
      throw new ChatGPTInferenceError(
        'usage_limit_exceeded',
        'Injected fake inference response: your ChatGPT plan usage limit was reached. Manage usage to continue.',
        { manageUsage: true, status: 429 },
      );
    };
  });
  const result = await page.evaluate(() =>
    (window as any).electronAPI.agentChat({
      question: 'Injected offline error probe',
      history: [],
      scope: { kind: 'all' },
    }),
  );
  expect(result.success).toBe(false);
  expect(result.errorType).toBe('chatgpt');
  expect(result.errorCode).toBe('usage_limit_exceeded');
  expect(result.manageUsageUrl).toBe('https://chatgpt.com/settings/usage');
  writeFileSync(
    join(evidenceDir, 'real-agent-chat-fake-error-envelope.json'),
    JSON.stringify(result, null, 2),
  );
  await page.getByRole('button', { name: 'Toggle chat', exact: true }).click();
  await page.locator('#chatInput').fill('Show the injected offline usage-limit response');
  await page.getByRole('button', { name: 'Send', exact: true }).press('Enter');
  const error = page.locator('#chatMessages .chat-error');
  await expect(error).toContainText('Injected fake inference response');
  await error.getByRole('button', { name: 'Manage usage', exact: true }).press('Enter');
  expect(await app.evaluate(() => (globalThis as any).__listenerFakeChatGPT.usage)).toBe(1);
  await expect(page.locator('#chatInput')).toBeEnabled();
  await capture('fake-agent-real-ipc-usage-limit');
});

test('real next-job IPC rebuilds service after injected fake same-profile reauthentication', async () => {
  await launch();
  await fake('plan');
  await settings();
  await expect(page.locator('#chatgptPlanBadge')).toContainText('Plan usage enabled');
  await page.locator('#cancelConfig').click();
  await app.evaluate(({ app }) => {
    const require = process.mainModule!.require.bind(process.mainModule);
    const path = require('node:path');
    const { AgentService } = require(path.join(app.getAppPath(), 'dist/agentService.js'));
    const instances: any[] = [];
    (globalThis as any).__listenerFakeAgentInstances = instances;
    AgentService.prototype.run = async function () {
      if (!instances.includes(this)) instances.push(this);
      const id = instances.indexOf(this);
      return await this.chatgpt.run(undefined, async () => ({
        answer: `Injected fake job uses service ${id}`,
        history: [],
        appliedActions: [],
      }));
    };
  });
  await page.getByRole('button', { name: 'Toggle chat', exact: true }).click();
  await page.locator('#chatInput').fill('First injected offline job');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('#chatMessages')).toContainText('Injected fake job uses service 0');
  await app.evaluate(() => {
    (globalThis as any).__listenerFakeChatGPT.revision = 'injected-fake-grant-2';
  });
  await page
    .locator('#chatInput')
    .fill('Next job after simulated CLI reauthentication of the same profile');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('#chatMessages')).toContainText('Injected fake job uses service 1');
  const proof = await app.evaluate(async () => {
    const instances = (globalThis as any).__listenerFakeAgentInstances;
    let oldGrantCode: string | undefined;
    try {
      await instances[0].chatgpt.run(undefined, async () => 'Old grant must never resume');
    } catch (error) {
      oldGrantCode = (error as any).code;
    }
    const harness = (globalThis as any).__listenerFakeChatGPT;
    return {
      instances: instances.length,
      oldGrantCode,
      profileId: harness.active,
      sessionRevision: harness.revision,
    };
  });
  expect(proof.instances).toBe(2);
  expect(proof.oldGrantCode).toBe('signed_out_during_job');
  expect(proof.profileId).toBe('fake-a');
  writeFileSync(
    join(evidenceDir, 'same-profile-fake-reauth-runtime.json'),
    JSON.stringify(proof, null, 2),
  );
  await capture('fake-same-profile-reauth-new-service');
});

test('injected fake account missing saved model keeps the choice without silent substitution', async () => {
  await launch({ transcriptionProvider: 'openai', chatgptModel: 'saved-unavailable-model' });
  await fake('missing-model');
  await settings();
  await expect(page.locator('#chatgptModelSelect')).toBeEnabled();
  await expect(page.locator('#chatgptModelSelect')).toHaveValue('saved-unavailable-model');
  await expect(page.locator('#chatgptModelSelect option:checked')).toContainText(
    'not available for this account',
  );
  await expect(page.locator('#chatgptNotice')).toContainText(
    /not available|not in this account|unavailable/i,
  );
  await page.locator('#chatgptNotice').scrollIntoViewIfNeeded();
  await capture('fake-missing-model');
});

test('injected fake pending login cancellation recovers focus and allows another attempt', async () => {
  await launch({ transcriptionProvider: 'openai', chatgptPlanNoticeAcknowledged: true });
  await fake('pending');
  await settings();
  const login = page.getByRole('button', { name: 'Continue with ChatGPT', exact: true });
  await login.press('Enter');
  await expect(page.locator('#chatgptCard')).toHaveAttribute('aria-busy', 'true');
  await page.getByRole('button', { name: 'Cancel sign-in', exact: true }).press('Enter');
  await expect(login).toBeFocused();
  await expect(page.locator('#chatgptStatus')).toContainText('cancelled');
  await expect(page.locator('#chatgptCard')).toHaveAttribute('aria-busy', 'false');
  await capture('fake-cancel-recovered');
  await app.evaluate(() => {
    (globalThis as any).__listenerFakeChatGPT.mode = 'signed-out';
  });
  await login.press('Enter');
  await expect(page.locator('#chatgptPlanBadge')).toContainText('Plan usage enabled');
  await capture('fake-cancel-retry');
});

for (const [name, config] of [
  ['fresh', {}],
  ['missing-gemini-key', { aiProvider: 'gemini' }],
  ['signed-out-chatgpt', { aiProvider: 'chatgpt', transcriptionProvider: 'auto' }],
  ['legacy-codex', { aiProvider: 'codex', transcriptionProvider: 'codex' }],
] as const) {
  test(`startup ${name} opens without AI setup prompt`, async () => {
    await launch(config, true);
    await expect(
      page.getByRole('button', { name: 'Open transcript for Synthetic_Meeting' }),
    ).toBeVisible();
    await expect(page.locator('#configModal')).not.toBeVisible();
    expect(await dialogMessages()).toEqual([]);
    await capture(`startup-${name}-no-setup`);
  });
}

test('missing AI auth opens setup only when Ask is submitted and retains question', async () => {
  await launch();
  await page.getByRole('button', { name: 'Toggle chat', exact: true }).click();
  await page.locator('#chatInput').fill('Synthetic retained setup question');
  await page.locator('#chatSend').press('Enter');
  await expect(page.locator('#configModal')).toBeVisible();
  await expect(page.locator('#config-tab-ai')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#chatInput')).toHaveValue('Synthetic retained setup question');
  await expect(page.locator('#chatMessages .chat-message')).toHaveCount(0);
  expect(await dialogMessages()).toEqual([]);
  await capture('action-ask-missing-auth-setup');
});

test('missing Gemini key gates explicit audio action without processing saved fixture', async () => {
  await launch({ aiProvider: 'gemini' });
  await page.getByRole('button', { name: 'More actions for Synthetic_Meeting' }).click();
  await page.evaluate(() => {
    (window as any).__listenerBackgroundTestDialogs.confirmResult = true;
  });
  await page.locator('.regenerate-btn').click();
  await expect(page.locator('#configModal')).toBeVisible();
  await expect(page.locator('#config-tab-ai')).toHaveAttribute('aria-selected', 'true');
  expect(await dialogMessages()).toHaveLength(1);
  expect((await dialogMessages())[0]).toContain('regenerate the transcript');
  await capture('action-audio-missing-gemini-key');
});

test('injected fake ChatGPT plan with auto STT gates audio with an explicit backend explanation', async () => {
  await launch();
  await fake('plan');
  await page.getByRole('button', { name: 'More actions for Synthetic_Meeting' }).click();
  await page.evaluate(() => {
    (window as any).__listenerBackgroundTestDialogs.confirmResult = true;
  });
  await page.locator('.regenerate-btn').click();
  await expect(page.locator('#configModal')).toBeVisible();
  expect(await dialogMessages()).toHaveLength(2);
  expect((await dialogMessages())[0]).toContain('regenerate the transcript');
  expect((await dialogMessages())[1]).toMatch(/choose|select|transcription/i);
  await capture('action-fake-plan-auto-stt-setup');
});

test('stored-text cutoff action opens AI setup without changing existing cutoff', async () => {
  await launch();
  await page.getByRole('button', { name: 'Open transcript for Synthetic_Meeting' }).click();
  await page.locator('#transcriptionModal [data-tab="transcript"]').click();
  await page.locator('[data-cutoff-action="restore"]').click();
  await expect(page.locator('#configModal')).toBeVisible();
  expect(await dialogMessages()).toEqual([]);
  await capture('action-stored-text-missing-auth-setup');
});

test('injected fake configured text-only Ask proceeds through real IPC without audio setup', async () => {
  await launch();
  await fake('plan');
  await app.evaluate(({ app }) => {
    const require = process.mainModule!.require.bind(process.mainModule);
    const { AgentService } = require(
      require('node:path').join(app.getAppPath(), 'dist/agentService.js'),
    );
    AgentService.prototype.run = async () => ({
      answer: 'Injected fake text-only answer',
      history: [],
      appliedActions: [],
    });
  });
  await page.getByRole('button', { name: 'Toggle chat', exact: true }).click();
  await page.locator('#chatInput').fill('Synthetic text-only question');
  await page.locator('#chatSend').press('Enter');
  await expect(page.locator('#chatMessages')).toContainText('Injected fake text-only answer');
  await expect(page.locator('#configModal')).not.toBeVisible();
  expect(await dialogMessages()).toEqual([]);
  await capture('action-fake-plan-text-only-ask');
});

test('closing and reopening a note during real preflight discards the stale Ask context', async () => {
  await launch();
  await fake('plan');
  await page.getByRole('button', { name: 'Open transcript for Synthetic_Meeting' }).click();
  await page.locator('#transcriptionModal [data-tab="ask"]').click();
  await app.evaluate(({ app, ipcMain }) => {
    const require = process.mainModule!.require.bind(process.mainModule);
    const { AgentService } = require(
      require('node:path').join(app.getAppPath(), 'dist/agentService.js'),
    );
    const proof = { calls: 0, waiting: false, release: () => {} };
    (globalThis as any).__listenerDelayedPreflight = proof;
    AgentService.prototype.run = async () => {
      proof.calls++;
      return { answer: 'Stale context must not run', history: [], appliedActions: [] };
    };
    // Test-only timing proxy preserves the production check-config handler and response.
    const original = (ipcMain as any)._invokeHandlers.get('check-config');
    if (typeof original !== 'function') throw new Error('Native check-config handler unavailable');
    ipcMain.removeHandler('check-config');
    ipcMain.handle('check-config', async (event, ...args) => {
      const result = await original(event, ...args);
      await new Promise<void>((resolve) => {
        proof.waiting = true;
        proof.release = resolve;
      });
      return result;
    });
  });
  await page.locator('#modalChatInput').fill('Synthetic stale note context');
  await page.locator('#modalChatSend').press('Enter');
  await expect
    .poll(() => app.evaluate(() => (globalThis as any).__listenerDelayedPreflight.waiting))
    .toBe(true);
  await page.locator('#transcriptionModal .close').click();
  await page.getByRole('button', { name: 'Open transcript for Synthetic_Meeting' }).click();
  await page.locator('#transcriptionModal [data-tab="ask"]').click();
  await app.evaluate(() => (globalThis as any).__listenerDelayedPreflight.release());
  await expect(page.locator('#modalChatSend')).toBeEnabled();
  await expect(page.locator('#modalChatMessages .chat-message')).toHaveCount(0);
  expect(await app.evaluate(() => (globalThis as any).__listenerDelayedPreflight.calls)).toBe(0);
  await capture('action-delayed-preflight-note-reset');
});
