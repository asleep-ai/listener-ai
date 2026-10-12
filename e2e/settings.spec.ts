import { test, expect } from '@playwright/test';
import { type ElectronApplication, type Page, _electron as electron } from 'playwright';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertBackgroundDevBuild } from './background-test';

// Drives the Settings window against an isolated data dir and HOME, so neither
// the developer's config.json nor a saved ChatGPT sign-in leaks in. Runs in
// background-test mode (see AGENTS.md, Background Testing): hidden, unfocused
// windows with no global shortcut, tray, notifications or native dialogs. Set
// LISTENER_E2E_SHOTS=<dir> to also save a screenshot of every Settings tab.

async function appWindow(electronApp: ElectronApplication): Promise<Page> {
  let page: Page | undefined;
  await expect
    .poll(
      () => {
        page = electronApp.windows().find((w) => w.url().endsWith('/renderer/index.html'));
        return page;
      },
      { timeout: 30_000, message: 'The application window did not open' },
    )
    .toBeTruthy();
  return page!;
}

// Every provider/auth override the app reads from the environment. An empty
// value reads as unset, so a developer shell's real keys, retired Codex
// variables or forced provider cannot change what these tests see.
const CLEARED_ENV = Object.fromEntries(
  [
    'LISTENER_AI_PROVIDER',
    'LISTENER_CODEX_AUTH_PATH',
    'GEMINI_API_KEY',
    'OPENAI_API_KEY',
    'SONIOX_API_KEY',
    'NOTION_API_KEY',
    'NOTION_DATABASE_ID',
    'SLACK_WEBHOOK_URL',
    'CODEX_OAUTH_ACCESS_TOKEN',
    'CODEX_OAUTH_REFRESH_TOKEN',
    'CODEX_OAUTH_EXPIRES',
    'OPENAI_CODEX_ACCESS_TOKEN',
    'OPENAI_CODEX_REFRESH_TOKEN',
    'OPENAI_CODEX_EXPIRES',
    'GOOGLE_OAUTH_ACCESS_TOKEN',
    'GOOGLE_OAUTH_REFRESH_TOKEN',
    'GOOGLE_OAUTH_EXPIRES',
  ].map((name) => [name, '']),
);

type Session = {
  window: Page;
  configPath: string;
  readConfig: () => Record<string, unknown>;
};

async function withSettings(
  config: Record<string, unknown>,
  run: (session: Session) => Promise<void>,
): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'listener-settings-e2e-'));
  const configPath = join(dataDir, 'config.json');
  writeFileSync(configPath, JSON.stringify(config));
  // Refuse to launch a dev build that lacks background-test support.
  assertBackgroundDevBuild();
  const electronApp = await electron.launch({
    executablePath: require('electron') as string,
    // Background launch: transparent, unfocused window (see support file).
    args: [
      '-r',
      join(__dirname, 'support', 'background-window.cjs'),
      '.',
      '--disable-gpu',
      '--no-sandbox',
    ],
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      LISTENER_BACKGROUND_TEST: '1',
      LISTENER_DATA_PATH: dataDir,
      HOME: dataDir,
      ...CLEARED_ENV,
    },
  });
  try {
    const window = await appWindow(electronApp);
    // The background preload must have applied, or this run took focus.
    // Window opacity exists only on macOS and Windows; Linux always reports 1.
    const windows = await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => ({
        focused: w.isFocused(),
        devTools: w.webContents.isDevToolsOpened(),
        transparent: process.platform === 'linux' || w.getOpacity() === 0,
      })),
    );
    expect(windows.length).toBeGreaterThan(0);
    for (const state of windows) {
      expect(state).toEqual({ focused: false, devTools: false, transparent: true });
    }
    // Background-test mode records alert/confirm in the page instead of
    // showing them; this is a fallback should a native dialog still appear.
    // A dialog can close with the app mid-dismiss; that is not a test failure.
    window.on('dialog', (dialog) => void dialog.dismiss().catch(() => {}));
    await window.waitForLoadState('domcontentloaded');
    await expect(window.locator('#loadingIndicator')).toBeHidden();
    await run({
      window,
      configPath,
      readConfig: () => JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>,
    });
  } finally {
    await electronApp.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function openSettings(window: Page): Promise<void> {
  await window.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(window.locator('#configModal')).toBeVisible();
}

const dialog = (window: Page) => window.locator('#configModal');

test('credential sections follow every provider that uses them', async () => {
  await withSettings(
    {
      aiProvider: 'chatgpt',
      transcriptionProvider: 'gemini',
      liveSttProvider: 'chunked',
      geminiApiKey: 'gemini-e2e',
    },
    async ({ window }) => {
      await openSettings(window);
      const gemini = dialog(window).locator('fieldset[data-provider="gemini"]');
      const chatgpt = dialog(window).locator('fieldset[data-provider="chatgpt"]');
      // Summaries on the ChatGPT plan, transcription on Gemini: both sections
      // are needed, and 12s chunked captions also go through the
      // transcription service.
      await expect(gemini).toBeVisible();
      await expect(chatgpt).toBeVisible();
      await expect(window.locator('#chatgptUsage')).toHaveText('Used for summaries and Ask Listener.');
      await expect(window.locator('#geminiUsage')).toHaveText(
        'Used for transcribing recordings and live captions.',
      );
      await expect(window.locator('#geminiApiKey')).toHaveValue('gemini-e2e');

      await window.getByRole('tab', { name: 'Transcription and summary' }).click();
      await window.locator('#transcriptionProvider').selectOption('auto');
      // Auto under ChatGPT transcribes nothing, so Gemini is no longer used.
      await expect(window.locator('#transcriptionProviderNotice')).toContainText(
        'ChatGPT sign-in cannot transcribe audio',
      );
      await window.getByRole('tab', { name: /AI connection/ }).click();
      await expect(gemini).toBeHidden();

      // Gemini Live brings the Gemini key back under ChatGPT summaries.
      await window.getByRole('tab', { name: 'Transcription and summary' }).click();
      await window.locator('#liveSttProvider').selectOption('gemini');
      await window.getByRole('tab', { name: /AI connection/ }).click();
      await expect(gemini).toBeVisible();
      await expect(window.locator('#geminiUsage')).toHaveText('Used for live captions.');

      // Gemini summaries with OpenAI API transcription: ChatGPT sign-in never
      // carries audio, so its section goes away and the OpenAI key is named.
      await window.locator('#aiProvider').selectOption('gemini');
      await window.getByRole('tab', { name: 'Transcription and summary' }).click();
      await window.locator('#transcriptionProvider').selectOption('openai');
      await window.getByRole('tab', { name: /AI connection/ }).click();
      await expect(chatgpt).toBeHidden();
      await expect(window.locator('#openaiUsage')).toHaveText('Used for transcribing recordings.');
      await expect(window.locator('#geminiUsage')).toHaveText(
        'Used for summaries and Ask Listener and live captions.',
      );
      // The OpenAI and Soniox keys are never hidden.
      await expect(window.locator('#openaiApiKey')).toBeVisible();
      await expect(window.locator('#sonioxApiKey')).toBeVisible();
    },
  );
});

test('tabs follow the ARIA keyboard model and the shortcut field does not trap focus', async () => {
  await withSettings({ aiProvider: 'gemini', geminiApiKey: 'gemini-e2e' }, async ({ window }) => {
    await openSettings(window);
    const tabs = dialog(window).getByRole('tab');
    await expect(tabs).toHaveText([
      /AI connection/,
      'Transcription and summary',
      'Recording',
      'Integrations',
      'Privacy and usage',
    ]);
    // Configured provider: no Required badge.
    await expect(window.locator('#configAiRequiredBadge')).toBeHidden();

    const aiTab = tabs.nth(0);
    await aiTab.focus();
    await window.keyboard.press('ArrowRight');
    await expect(tabs.nth(1)).toBeFocused();
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(window.locator('#config-pane-transcription')).toBeVisible();
    await expect(window.locator('#config-pane-ai')).toBeHidden();
    await expect(aiTab).toHaveAttribute('tabindex', '-1');
    await window.keyboard.press('End');
    await expect(tabs.nth(4)).toBeFocused();
    await expect(window.locator('#config-pane-advanced')).toBeVisible();
    await window.keyboard.press('ArrowRight');
    await expect(aiTab).toBeFocused();
    await window.keyboard.press('ArrowLeft');
    await expect(tabs.nth(4)).toBeFocused();
    await window.keyboard.press('Home');
    await expect(aiTab).toBeFocused();
    await expect(window.locator('#config-pane-ai')).toBeVisible();
    // Only the selected tab is in the Tab order.
    await expect(dialog(window).locator('[role="tab"][tabindex="0"]')).toHaveCount(1);

    await tabs.nth(2).click();
    const shortcut = window.locator('#globalShortcut');
    await shortcut.focus();
    await window.keyboard.press('a');
    await expect(window.locator('#globalShortcutError')).toContainText('Add a modifier key');
    await expect(shortcut).toHaveAttribute('aria-invalid', 'true');
    await window.keyboard.press('Tab');
    await expect(window.locator('#resetGlobalShortcut')).toBeFocused();
    await window.keyboard.press('Shift+Tab');
    await expect(shortcut).toBeFocused();
    await window.locator('#resetGlobalShortcut').click();
    await expect(shortcut).toHaveValue('CommandOrControl+Shift+L');
    await expect(window.locator('#globalShortcutError')).toBeHidden();
    await shortcut.focus();
    await window.keyboard.press('Escape');
    await expect(dialog(window)).toBeHidden();
  });
});

test('cancel discards edits, Save persists them, and an untouched Save is a no-op', async () => {
  await withSettings(
    {
      aiProvider: 'gemini',
      geminiApiKey: 'gemini-e2e',
      knownWords: ['Listener'],
      maxRecordingMinutes: 90,
    },
    async ({ window, configPath, readConfig }) => {
      // Startup may normalize config.json; compare against what it settled on.
      await openSettings(window);
      await window.locator('#cancelConfig').click();
      const settled = readFileSync(configPath, 'utf8');

      await openSettings(window);
      await window.getByRole('tab', { name: 'Recording' }).click();
      await window.locator('#maxRecordingMinutes').fill('15');
      await window.locator('#cancelConfig').click();
      expect(readFileSync(configPath, 'utf8')).toBe(settled);
      await openSettings(window);
      await window.getByRole('tab', { name: 'Recording' }).click();
      await expect(window.locator('#maxRecordingMinutes')).toHaveValue('90');
      await window.locator('#saveConfig').click();
      await expect(dialog(window)).toBeHidden();
      expect(readConfig()).toEqual(JSON.parse(settled));

      // Edits survive switching tabs before Save.
      await openSettings(window);
      await window.getByRole('tab', { name: 'Recording' }).click();
      await window.locator('#maxRecordingMinutes').fill('30');
      await window.getByRole('tab', { name: 'Transcription and summary' }).click();
      await window.locator('#knownWordsField').fill('Orca');
      await window.locator('#knownWordsField').press('Enter');
      await window.getByRole('tab', { name: 'Integrations' }).click();
      await window.locator('#notionDatabaseId').fill('db-e2e');
      await window.getByRole('tab', { name: 'Recording' }).click();
      await expect(window.locator('#maxRecordingMinutes')).toHaveValue('30');
      await window.locator('#saveConfig').click();
      await expect(dialog(window)).toBeHidden();
      const saved = readConfig();
      expect(saved.maxRecordingMinutes).toBe(30);
      expect(saved.knownWords).toEqual(['Listener', 'Orca']);
      expect(saved.notionDatabaseId).toBe('db-e2e');
      expect(saved.geminiApiKey).toBe('gemini-e2e');

      // Reopen shows the saved values; Save without edits leaves the file alone.
      const afterSave = readFileSync(configPath, 'utf8');
      await openSettings(window);
      await expect(window.locator('#notionDatabaseId')).toHaveValue('db-e2e');
      await expect(dialog(window).locator('#knownWordsChips .chip-text')).toHaveText([
        'Listener',
        'Orca',
      ]);
      await window.locator('#saveConfig').click();
      await expect(dialog(window)).toBeHidden();
      expect(readConfig()).toEqual(JSON.parse(afterSave));
    },
  );
});

test('shortcut Reset stores the default sentinel instead of pinning the default', async () => {
  const custom = 'CommandOrControl+Alt+Shift+F12';
  await withSettings(
    { aiProvider: 'gemini', geminiApiKey: 'gemini-e2e', globalShortcut: custom },
    async ({ window, readConfig }) => {
      const shortcut = window.locator('#globalShortcut');
      await openSettings(window);
      await window.getByRole('tab', { name: 'Recording' }).click();
      await expect(shortcut).toHaveValue(custom);
      await window.locator('#resetGlobalShortcut').click();
      await expect(shortcut).toHaveValue('CommandOrControl+Shift+L');
      await window.locator('#saveConfig').click();
      await expect(dialog(window)).toBeHidden();
      // '' is the stored "use the default" value, as for the model resets.
      expect(readConfig().globalShortcut).toBe('');

      // Reopen resolves the sentinel to the default, and an untouched Save
      // keeps the sentinel rather than writing the default out.
      await openSettings(window);
      await window.getByRole('tab', { name: 'Recording' }).click();
      await expect(shortcut).toHaveValue('CommandOrControl+Shift+L');
      await window.locator('#saveConfig').click();
      await expect(dialog(window)).toBeHidden();
      expect(readConfig().globalShortcut).toBe('');
    },
  );
});

test('missing credentials point to the field instead of an alert', async () => {
  await withSettings({ aiProvider: 'gemini' }, async ({ window, configPath }) => {
    await openSettings(window);
    await expect(window.locator('#configAiRequiredBadge')).toBeVisible();
    const before = readFileSync(configPath, 'utf8');

    // A notice on the Transcription tab links to the credential it needs.
    await window.getByRole('tab', { name: 'Transcription and summary' }).click();
    await window.locator('#transcriptionProvider').selectOption('soniox');
    const link = window.locator('#transcriptionProviderNotice').getByRole('button', {
      name: 'Add a Soniox API key',
    });
    await link.click();
    await expect(window.getByRole('tab', { name: /AI connection/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(window.locator('#sonioxApiKey')).toBeFocused();

    // Save without a Gemini key: stay open, focus the key, explain inline.
    await window.getByRole('tab', { name: 'Privacy and usage' }).click();
    await window.locator('#saveConfig').click();
    await expect(dialog(window)).toBeVisible();
    await expect(window.locator('#geminiApiKey')).toBeFocused();
    await expect(window.locator('#geminiApiKey')).toHaveAttribute('aria-invalid', 'true');
    await expect(window.locator('#geminiApiKeyError')).toContainText('Enter a Gemini API key');
    expect(readFileSync(configPath, 'utf8')).toBe(before);

    await window.locator('#geminiApiKey').fill('gemini-e2e');
    await expect(window.locator('#geminiApiKeyError')).toBeHidden();
    await expect(window.locator('#configAiRequiredBadge')).toBeHidden();
  });
});

// Visual review aid, off by default: LISTENER_E2E_SHOTS=/tmp/dir pnpm test:e2e
const shotsDir = process.env.LISTENER_E2E_SHOTS;
test('captures every Settings tab for visual review', async () => {
  test.skip(!shotsDir, 'LISTENER_E2E_SHOTS is not set');
  await withSettings(
    {
      aiProvider: 'chatgpt',
      transcriptionProvider: 'gemini',
      liveSttProvider: 'soniox',
      knownWords: ['Listener', 'Orca'],
    },
    async ({ window }) => {
      await window.emulateMedia({ reducedMotion: 'reduce' });
      await window.setViewportSize({ width: 1100, height: 900 });
      await openSettings(window);
      for (const tab of ['ai', 'transcription', 'recording', 'integrations', 'advanced']) {
        await window.locator(`#config-tab-${tab}`).click();
        await window
          .locator('.config-modal')
          .screenshot({ path: join(shotsDir!, `settings-${tab}.png`) });
      }
      await window.setViewportSize({ width: 420, height: 760 });
      await window.locator('#config-tab-ai').click();
      await window.screenshot({ path: join(shotsDir!, 'settings-narrow.png') });
    },
  );
});
