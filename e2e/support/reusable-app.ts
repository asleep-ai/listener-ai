import { type ElectronApplication, type Page, _electron as electron } from 'playwright';
import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { backgroundArtifact } from '../background-test';
import { appWindow, launchApp } from './launch';
import {
  assertPackagedSeed,
  installPackagedGuards,
  type PackagedProofContext,
} from './packaged-guards';
import { classifyCase } from './case-policy';
import { scriptDialogs } from './dialogs';
import {
  assertCleanReset,
  assertSingleHiddenWindow,
  bounded,
  clearOwnedFixtureData,
  OwnedSession,
} from './reusable-lifecycle';

async function resetConfiguration(
  app: ElectronApplication,
  raw: Record<string, unknown>,
  options: { load?: boolean } = {},
): Promise<void> {
  await app.evaluate(
    async ({ session }, { raw, load }) => {
      const baseline = (globalThis as any).__listenerReusableBaseline;
      const config = baseline.config;
      config.dirtyKeys.clear();
      if (load) {
        // A warm case must load its seed with the same native migration semantics
        // as a cold ConfigService constructor, using the existing singleton.
        config.loadConfig();
        config.migrateLegacyDefaults();
      } else config.config = JSON.parse(JSON.stringify(raw));
      const settled = JSON.parse(JSON.stringify(config.config));
      config.setChatGPTStatus({ connected: false, planEnabled: false });
      const fields = [
        'aiProvider',
        'knownWords',
        'geminiApiKey',
        'geminiModel',
        'geminiFlashModel',
        'geminiThinkingLevel',
        'chatgptModel',
        'openaiApiKey',
        'openaiTranscriptionModel',
        'transcriptionProvider',
        'sonioxApiKey',
        'notionApiKey',
        'notionDatabaseId',
        'slackWebhookUrl',
      ];
      const effective = config.getAllConfig();
      const payload = Object.fromEntries(fields.map((key) => [key, effective[key] ?? '']));
      const result = await baseline.handlers.get('save-config')({}, payload);
      if (!result.success) throw new Error(`Config reset failed: ${result.error}`);
      config.config = settled;
      config.dirtyKeys.clear();
      process
        .mainModule!.require('node:fs')
        .writeFileSync(config.getConfigPath(), JSON.stringify(settled));
      await session.defaultSession.clearStorageData();
    },
    { raw, load: options.load === true },
  );
}

async function closeOwnedElectron(app: ElectronApplication): Promise<void> {
  const child = app.process();
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const wait = (milliseconds: number) =>
    bounded(
      new Promise<void>((resolve) => {
        if (exited()) resolve();
        else child.once('exit', () => resolve());
      }),
      milliseconds,
      'Owned Electron process exit',
    );
  await bounded(app.close(), 10_000, 'Owned Electron shutdown').catch(() => {});
  if (!exited()) {
    child.kill('SIGTERM');
    await wait(5_000).catch(async () => {
      child.kill('SIGKILL');
      await wait(5_000);
    });
  }
  if (!exited()) throw new Error('Owned Electron is still alive; retaining its fixture data.');
}

// Each suite owns one data root for the entire lifetime of its main-process
// singletons. Only synthetic app data is reset; Chromium's live profile stays.
export class ReusableApp {
  private directory: string | undefined;
  get dataDir(): string {
    this.directory ??= mkdtempSync(
      join(tmpdir(), `listener-shared-${this.name.replace(/[^a-z0-9-]/gi, '-')}-`),
    );
    return this.directory;
  }
  private owner: OwnedSession<ElectronApplication>;
  private application: ElectronApplication | undefined;
  private window: Page | undefined;
  private pid: number | undefined;
  private windowId: number | undefined;
  private active = false;
  private prepared = false;
  private cases = 0;
  private closed = false;
  private name: string;
  private fresh: boolean;
  private packaged: boolean;
  private verifiedArchive: string | undefined;
  private artifactSha256: string | undefined;
  private rawConfig: Record<string, unknown> = {};
  private caseId = '';

  constructor(
    name: string,
    options: { packaged?: boolean; fresh?: boolean; buildDir?: string } = {},
  ) {
    this.name = name;
    this.fresh = options.fresh ?? false;
    this.packaged = options.packaged ?? false;
    this.owner = new OwnedSession(
      async () => {
        if (process.env.LISTENER_E2E_SHOW === '1')
          throw new Error('Reusable tests refuse LISTENER_E2E_SHOW=1 before launching Electron.');
        const proofLog = process.env.LISTENER_E2E_LAUNCH_LOG;
        if (proofLog && existsSync(proofLog)) {
          const previous = readFileSync(proofLog, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line));
          if (
            previous.some(
              (event) =>
                event.event === 'launch' &&
                (this.fresh ? event.caseId === this.caseId : event.group === this.name),
            )
          )
            throw new Error('A dirty worker cannot silently relaunch this owned session.');
        }
        const env: Record<string, string> = Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] =>
              typeof entry[1] === 'string' &&
              !/API_KEY|OAUTH|TOKEN|SECRET|PASSWORD|WEBHOOK|NOTION_DATABASE_ID|LISTENER_AI_PROVIDER|LISTENER_CODEX_AUTH_PATH/i.test(
                entry[0],
              ),
          ),
        );
        Object.assign(env, {
          NODE_ENV: 'test',
          LISTENER_BACKGROUND_TEST: '1',
          LISTENER_TEST_MODE: '',
          LISTENER_DATA_PATH: this.dataDir,
          LISTENER_E2E_SHOW: '0',
        });
        let app: ElectronApplication;
        if (options.packaged) {
          const buildDir = options.buildDir ?? process.env.LISTENER_SMOKE_BUILD_DIR;
          if (!buildDir)
            throw new Error('Set LISTENER_SMOKE_BUILD_DIR to an external packaged build.');
          const artifact = backgroundArtifact(buildDir);
          this.verifiedArchive = artifact.verifiedArchive;
          this.artifactSha256 = createHash('sha256')
            .update(readFileSync(this.verifiedArchive))
            .digest('hex');
          app = await electron.launch({
            executablePath: artifact.executable,
            args: ['--no-sandbox'],
            cwd: this.dataDir,
            env,
          });
        } else {
          app = await launchApp(env);
        }
        this.application = app;
        this.pid = app.process().pid;
        return app;
      },
      async (app) => {
        await closeOwnedElectron(app);
        this.application = undefined;
        this.window = undefined;
      },
    );
  }

  seed(config: Record<string, unknown> = {}): string {
    if (this.active || this.prepared || this.closed || (this.fresh && this.cases))
      throw new Error('Finish the previous case before preparing this owned session.');
    clearOwnedFixtureData(this.dataDir, true);
    writeFileSync(join(this.dataDir, 'config.json'), JSON.stringify(config));
    this.rawConfig = JSON.parse(JSON.stringify(config));
    this.prepared = true;
    return this.dataDir;
  }

  async start(): Promise<{ app: ElectronApplication; page: Page; dataDir: string }> {
    if (!this.prepared || this.active || this.closed)
      throw new Error('Seed exactly one case before start.');
    this.prepared = false;
    this.active = true;
    this.caseId = test.info().testId;
    const policy = classifyCase(test.info().file, test.info().title);
    if (this.name.startsWith('chatgpt-startup-')) this.name = 'chatgpt-startup';
    if ((policy.kind === 'fresh') !== this.fresh || policy.group !== this.name) {
      await this.close();
      throw new Error('Fresh/shared session classification mismatch.');
    }
    try {
      if (this.packaged)
        assertPackagedSeed(this.rawConfig, this.cases === 0 ? readdirSync(this.dataDir) : []);
      const app = await this.owner.acquire(async (app) => {
        const log = process.env.LISTENER_E2E_LAUNCH_LOG;
        if (log)
          appendFileSync(
            log,
            JSON.stringify({
              event: 'launch',
              group: this.name,
              kind: this.fresh ? 'planned fresh' : 'planned shared',
              pid: this.pid,
              caseId: this.caseId,
            }) + '\n',
          );
        this.window = await appWindow(app);
        if (this.packaged) {
          await expect
            .poll(() =>
              this.window!.evaluate(() => !!(window as any).__listenerBackgroundTestDialogs),
            )
            .toBe(true);
          const native = await this.window!.evaluate(() =>
            [window.alert, window.confirm, window.prompt].some((fn) =>
              Function.prototype.toString.call(fn).includes('[native code]'),
            ),
          );
          if (native) throw new Error('Packaged background dialog replacement failed.');
          await app.evaluate(installPackagedGuards, {
            expectedAsar: this.verifiedArchive!,
            proofContext: this.packagedProofContext(),
          });
          // Persist the first guard observations before any later initializer
          // can fail and dispose this process.
          await this.configurePackagedProof(app);
        }
        await app.evaluate(async ({ app, ipcMain, session, shell, dialog }) => {
          if (
            process.env.NODE_ENV !== 'test' ||
            process.env.LISTENER_BACKGROUND_TEST !== '1' ||
            process.env.LISTENER_TEST_MODE !== '' ||
            (!app.isPackaged && !(globalThis as any).__listenerHiddenE2E?.loadedBeforeMain) ||
            !Array.isArray((globalThis as any).__listenerTestNativeEffects)
          )
            throw new Error('Reusable reset hooks require explicit background test mode.');
          const load = (file: string) =>
            process.mainModule!.require(`${app.getAppPath()}/dist/${file}`);
          type Snapshot = {
            object: any;
            label: string;
            kind: 'module' | 'prototype' | 'instance';
            descriptors: PropertyDescriptorMap;
          };
          const snapshots: Snapshot[] = [];
          const snapshot = (object: any, label: string, kind: Snapshot['kind']) =>
            snapshots.push({
              object,
              label,
              kind,
              descriptors: Object.getOwnPropertyDescriptors(object),
            });
          const mockMismatches = (entries: Snapshot[]): string[] => {
            const mismatches: string[] = [];
            const callable = (descriptor: PropertyDescriptor | undefined) =>
              !!descriptor &&
              (typeof descriptor.value === 'function' ||
                Object.hasOwn(descriptor, 'get') ||
                Object.hasOwn(descriptor, 'set'));
            for (const { object, label, kind, descriptors } of entries) {
              for (const [key, expected] of Object.entries(descriptors)) {
                const current = Object.getOwnPropertyDescriptor(object, key);
                // Lazy caches and other ordinary instance fields can change
                // when the restored renderer reads them. They are not hooks.
                if (kind === 'instance' && !callable(expected)) {
                  if (callable(current))
                    mismatches.push(`${label}.${key}: unexpected callable or accessor`);
                  continue;
                }
                if (!current) mismatches.push(`${label}.${key}: missing own property`);
                else if (
                  !Object.is(current.value, expected.value) ||
                  current.get !== expected.get ||
                  current.set !== expected.set ||
                  current.enumerable !== expected.enumerable ||
                  current.configurable !== expected.configurable ||
                  current.writable !== expected.writable
                )
                  mismatches.push(`${label}.${key}: descriptor identity changed`);
              }
              for (const key of Object.getOwnPropertyNames(object)) {
                if (Object.hasOwn(descriptors, key)) continue;
                if (kind !== 'instance' || callable(Object.getOwnPropertyDescriptor(object, key)))
                  mismatches.push(`${label}.${key}: unexpected own property`);
              }
            }
            return mismatches;
          };
          // Pure negative controls exercise the same checker used after reload:
          // a lazy state update is permitted, but a surviving mock is rejected.
          const probe = { cachedPath: undefined as string | undefined, run: () => {} };
          const probeSnapshot: Snapshot = {
            object: probe,
            label: 'reset-check-probe',
            kind: 'instance',
            descriptors: Object.getOwnPropertyDescriptors(probe),
          };
          probe.cachedPath = '/synthetic/metadata';
          if (mockMismatches([probeSnapshot]).length)
            throw new Error('Mock checker incorrectly rejects lazy instance state');
          probe.run = () => {};
          if (!mockMismatches([probeSnapshot]).some((key) => key.includes('.run:')))
            throw new Error('Mock checker missed an overridden method');
          Object.defineProperties(probe, probeSnapshot.descriptors);
          Object.defineProperty(probe, 'cachedPath', { get: () => '/mock', configurable: true });
          if (!mockMismatches([probeSnapshot]).some((key) => key.includes('.cachedPath:')))
            throw new Error('Mock checker missed a field replaced by an accessor');
          Object.defineProperties(probe, probeSnapshot.descriptors);
          Object.defineProperty(probe, 'extra', { value: () => {}, configurable: true });
          if (!mockMismatches([probeSnapshot]).some((key) => key.includes('.extra:')))
            throw new Error('Mock checker missed an extra own method');
          for (const file of [
            'geminiService.js',
            'notionService.js',
            'slackService.js',
            'agentService.js',
            'services/ffmpegManager.js',
            'services/audioConcatService.js',
            'services/metadataService.js',
            'meetingLock.js',
          ]) {
            const module = load(file);
            snapshot(module, file, 'module');
            for (const [name, value] of Object.entries(module) as [string, any][]) {
              if (typeof value === 'function' && value.prototype)
                snapshot(value.prototype, `${file}:${name}.prototype`, 'prototype');
              else if (value && typeof value === 'object')
                snapshot(value, `${file}:${name}`, 'instance');
            }
          }
          snapshot(load('chatgptAuth.js').getChatGPTAuth(), 'chatgptAuth', 'instance');
          snapshot(shell, 'electron.shell', 'module');
          snapshot(dialog, 'electron.dialog', 'module');
          const configPrototype = load('configService.js').ConfigService.prototype;
          snapshot(configPrototype, 'configService.js:ConfigService.prototype', 'prototype');
          const original = configPrototype.getAllConfig;
          let config: any;
          configPrototype.getAllConfig = function () {
            // Capture the app-owned receiver; an arrow would change its identity.
            // eslint-disable-next-line typescript/no-this-alias
            config = this;
            return original.call(this);
          };
          try {
            await (ipcMain as any)._invokeHandlers.get('get-config')({});
          } finally {
            configPrototype.getAllConfig = original;
          }
          if (configPrototype.getAllConfig !== original)
            throw new Error('Config capture wrapper was not restored.');
          if (!config) throw new Error('Could not capture the app-owned configuration singleton.');
          if (!app.isPackaged) {
            session.defaultSession.setPermissionRequestHandler(
              (_contents, permission, callback) => {
                (globalThis as any).__listenerTestNativeEffects.push(`permission:${permission}`);
                callback(false);
              },
            );
            session.defaultSession.setPermissionCheckHandler(() => false);
            session.defaultSession.webRequest.onBeforeRequest(
              { urls: ['http://*/*', 'https://*/*'] },
              (_details, callback) => {
                (globalThis as any).__listenerTestNativeEffects.push('unmocked renderer network');
                callback({ cancel: true });
              },
            );
          }
          const originalHandle = ipcMain.handle;
          const pending = new Set<Promise<unknown>>();
          const track =
            (handler: (...args: any[]) => any) =>
            (...args: any[]) => {
              const promise = Promise.resolve().then(() => handler(...args));
              pending.add(promise);
              void promise.then(
                () => pending.delete(promise),
                () => pending.delete(promise),
              );
              return promise;
            };
          for (const [channel, handler] of new Map((ipcMain as any)._invokeHandlers) as Map<
            string,
            (...args: any[]) => any
          >) {
            ipcMain.removeHandler(channel);
            originalHandle.call(ipcMain, channel, track(handler));
          }
          ipcMain.handle = (channel, handler) =>
            originalHandle.call(ipcMain, channel, track(handler));
          (globalThis as any).__listenerReusableBaseline = {
            snapshots,
            mockMismatches,
            handlers: new Map((ipcMain as any)._invokeHandlers),
            config,
            checks: 0,
            resetChecks: 0,
            pending,
            originalHandle,
            globalFetch: Object.getOwnPropertyDescriptor(globalThis, 'fetch'),
          };
        });
        if (!this.packaged) await scriptDialogs(app, this.window!);
      });
      // Reused cases must own their proof before config reset or renderer
      // reload can produce observations or fail.
      if (this.packaged) await this.configurePackagedProof(app);
      if (this.cases) {
        const config = JSON.parse(readFileSync(join(this.dataDir, 'config.json'), 'utf8'));
        await resetConfiguration(app, config, { load: true });
        await app.context().clearCookies();
        await this.window!.reload();
      }
      await this.window!.waitForLoadState('domcontentloaded');
      await expect(this.window!.locator('#loadingIndicator')).toBeHidden();
      await this.waitForRecordingsListSettlement(app, this.window!);
      await this.assertIdentity('case-start');
      this.cases++;
      return { app, page: this.window!, dataDir: this.dataDir };
    } catch (error) {
      this.active = false;
      await this.owner.fail(error);
      await this.close();
      throw error;
    }
  }

  private packagedProofContext(): PackagedProofContext {
    if (!this.artifactSha256) throw new Error('The packaged artifact hash is missing.');
    const info = test.info();
    const outputPath = info.outputPath('native-proof.json');
    mkdirSync(dirname(outputPath), { recursive: true });
    return {
      outputPath,
      caseName: info.title,
      caseOrder: this.cases + 1,
      artifactSha256: this.artifactSha256,
    };
  }

  private async configurePackagedProof(app: ElectronApplication): Promise<void> {
    await app.evaluate((_electron, context) => {
      const guards = (globalThis as any).__listenerPackagedGuards;
      if (!guards || typeof guards.configureProof !== 'function')
        throw new Error('Packaged proof context cannot be configured.');
      guards.configureProof(context);
    }, this.packagedProofContext());
  }

  private async waitForRecordingsListSettlement(
    app: ElectronApplication,
    page: Page,
  ): Promise<void> {
    await page.evaluate(() => {
      const list = document.getElementById('recordingsList');
      if (!list) throw new Error('The recordings list is missing during case setup.');
      const state = { lastMutation: performance.now(), observer: null as MutationObserver | null };
      state.observer = new MutationObserver(() => {
        state.lastMutation = performance.now();
      });
      state.observer.observe(list, { childList: true, subtree: true });
      (window as any).__listenerReusableListSettlement = state;
    });
    try {
      // Seed writes can trigger main's 250ms watcher debounce after the first
      // renderer load. Observe actual row mutations for two debounce periods
      // so case actions do not open a menu on a row about to be replaced.
      await bounded(
        expect
          .poll(
            async () => {
              const [renderer, pendingInvocations] = await Promise.all([
                page.evaluate(() => {
                  const state = (window as any).__listenerReusableListSettlement;
                  const loading = document.getElementById('loadingIndicator');
                  return {
                    quiet: !!state && performance.now() - state.lastMutation >= 500,
                    loadingHidden: !!loading && loading.getClientRects().length === 0,
                  };
                }),
                app.evaluate(() => (globalThis as any).__listenerReusableBaseline.pending.size),
              ]);
              return { ...renderer, pendingInvocations };
            },
            { timeout: 15_000, message: 'The recordings list did not settle before case actions.' },
          )
          .toEqual({ quiet: true, loadingHidden: true, pendingInvocations: 0 }),
        15_000,
        'Recordings list settlement',
      );
    } finally {
      await page.evaluate(() => {
        const state = (window as any).__listenerReusableListSettlement;
        state?.observer?.disconnect();
        delete (window as any).__listenerReusableListSettlement;
      });
    }
  }

  private async assertIdentity(stage: string): Promise<void> {
    const app = this.application;
    if (!app || app.process().pid !== this.pid)
      throw new Error('The shared main process was replaced.');
    const windows = await app.evaluate(({ BrowserWindow, app }, stage) => {
      if (app.isPackaged) {
        const guards = (globalThis as any).__listenerPackagedGuards;
        if (!guards) throw new Error('Packaged guard baseline is missing.');
        guards.assertIntact(stage);
      }
      if (!Array.isArray((globalThis as any).__listenerTestNativeEffects))
        throw new Error('Native effect recorder is missing.');
      if ((globalThis as any).__listenerTestNativeEffects.length)
        throw new Error(
          `Native effect attempted: ${(globalThis as any).__listenerTestNativeEffects.join(', ')}`,
        );
      (globalThis as any).__listenerReusableBaseline.checks++;
      return BrowserWindow.getAllWindows().map((w) => ({
        id: w.id,
        visible: w.isVisible(),
        focused: w.isFocused(),
        focusable: w.isFocusable(),
        devTools: w.webContents.isDevToolsOpened(),
      }));
    }, stage);
    this.windowId = assertSingleHiddenWindow(windows, this.windowId);
  }

  async finish(release?: () => Promise<void>): Promise<void> {
    if (!this.active) return;
    try {
      await this.owner.reset(async (app) => {
        await app.evaluate(({ app }) => {
          if (!app.isPackaged) return;
          const guards = (globalThis as any).__listenerPackagedGuards;
          if (!guards) throw new Error('Packaged guard baseline is missing.');
          guards.assertNativeState('before-reset');
        });
        if (release) await bounded(release(), 15_000, 'Fixture release');
        await bounded(
          app.evaluate(async ({ app, ipcMain, session }) => {
            const load = (file: string) =>
              process.mainModule!.require(`${app.getAppPath()}/dist/${file}`);
            const registry = load('transcriptionJobs.js').transcriptionJobs;
            const baseline = (globalThis as any).__listenerReusableBaseline;
            const records = [...registry.jobs.values()] as any[];
            for (const record of records)
              if (record.snapshot.status === 'running' && !record.committed)
                record.controller.abort();
            await Promise.allSettled([
              ...records.map((record) => record.promise),
              ...baseline.pending,
            ]);
            if (
              records.some((record) => record.snapshot.status === 'running' || record.reserved.size)
            )
              throw new Error('A job or private reservation survived fixture cleanup.');
            registry.jobs.clear(); // Keep listeners and the monotonically increasing revision.
            Object.defineProperty(globalThis, 'fetch', baseline.globalFetch);
            for (const { object, label, descriptors } of baseline.snapshots) {
              for (const key of Object.getOwnPropertyNames(object))
                if (!Object.hasOwn(descriptors, key)) delete object[key];
              Object.defineProperties(object, descriptors);
              for (const [key, descriptor] of Object.entries(descriptors) as [
                string,
                PropertyDescriptor,
              ][]) {
                const current = Object.getOwnPropertyDescriptor(object, key)!;
                if (
                  current.value !== descriptor.value ||
                  current.get !== descriptor.get ||
                  current.set !== descriptor.set
                )
                  throw new Error(`Fixture override survived cleanup: ${label}.${key}`);
              }
            }
            for (const channel of (ipcMain as any)._invokeHandlers.keys())
              ipcMain.removeHandler(channel);
            for (const [channel, handler] of baseline.handlers)
              baseline.originalHandle.call(ipcMain, channel, handler);
            for (const [channel, handler] of baseline.handlers)
              if ((ipcMain as any)._invokeHandlers.get(channel) !== handler)
                throw new Error(`IPC override survived cleanup: ${channel}`);
            if (!app.isPackaged)
              session.defaultSession.webRequest.onBeforeRequest(
                { urls: ['http://*/*', 'https://*/*'] },
                (_details, callback) => {
                  (globalThis as any).__listenerTestNativeEffects.push('unmocked renderer network');
                  callback({ cancel: true });
                },
              );
            for (const key of [
              '__jobFixture',
              '__lockGate',
              '__listenerFakeChatGPT',
              '__listenerFakeAgentInstances',
              '__listenerUnexpectedFetches',
              '__listenerDelayedPreflight',
              '__listenerDisposeBackgroundProof',
              '__listenerBackgroundProof',
            ])
              delete (globalThis as any)[key];
            if (app.isPackaged) {
              const guards = (globalThis as any).__listenerPackagedGuards;
              if (!guards) throw new Error('Packaged guard baseline is missing.');
              guards.restoreAndAssert();
            }
          }),
          15_000,
          'Job and mock reset',
        );
        if (!this.fresh) {
          await resetConfiguration(app, this.rawConfig);
          clearOwnedFixtureData(this.dataDir);
          await this.window!.reload();
          await this.window!.waitForLoadState('domcontentloaded');
          await expect(this.window!.locator('#loadingIndicator')).toBeHidden();
          await expect
            .poll(
              () => app.evaluate(() => (globalThis as any).__listenerReusableBaseline.pending.size),
              { timeout: 15_000 },
            )
            .toBe(0);
          const state = await app.evaluate(({ app, ipcMain }, raw) => {
            const load = (file: string) =>
              process.mainModule!.require(`${app.getAppPath()}/dist/${file}`);
            const baseline = (globalThis as any).__listenerReusableBaseline;
            const fs = process.mainModule!.require('node:fs');
            const equal = process.mainModule!.require('node:util').isDeepStrictEqual;
            baseline.resetChecks++;
            const mockMismatches = baseline.mockMismatches(baseline.snapshots) as string[];
            for (const [channel, handler] of baseline.handlers)
              if ((ipcMain as any)._invokeHandlers.get(channel) !== handler)
                mockMismatches.push(`ipcMain.${channel}: handler identity changed`);
            return {
              activeJobs: load('transcriptionJobs.js')
                .transcriptionJobs.list()
                .jobs.filter((j: any) => j.status === 'running').length,
              pendingInvocations: baseline.pending.size,
              configMatches:
                equal(baseline.config.config, raw) &&
                equal(JSON.parse(fs.readFileSync(baseline.config.getConfigPath(), 'utf8')), raw),
              mocksRestored: mockMismatches.length === 0,
              mockMismatches,
              dataEmpty: ['recordings', 'metadata', 'transcriptions'].every(
                (name) => fs.readdirSync(`${app.getPath('userData')}/${name}`).length === 0,
              ),
            };
          }, this.rawConfig);
          assertCleanReset(state);
          const log = process.env.LISTENER_E2E_LAUNCH_LOG;
          if (log)
            appendFileSync(
              log,
              JSON.stringify({
                event: 'reset-checked',
                group: this.name,
                pid: this.pid,
                caseId: this.caseId,
                case: this.cases,
                omittedReset: false,
              }) + '\n',
            );
        }
        await this.assertIdentity('after-reset');
      });
      this.active = false;
    } catch (error) {
      this.active = false;
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed && !this.application) return;
    this.closed = true;
    await this.owner.close();
    if (this.application) {
      await closeOwnedElectron(this.application);
      this.application = undefined;
      this.window = undefined;
    }
    if (this.directory && existsSync(this.directory))
      rmSync(this.directory, { recursive: true, force: true });
  }
}
