import type { ElectronApplication, Page } from 'playwright';

// TEST-ONLY scripted JavaScript dialogs for the hidden (background) E2Es.
//
// Electron answers window.alert / confirm / prompt with a native message box
// attached to the app window. On macOS that box is a sheet, and a sheet on a
// hidden window was seen to leave the window visible (with no show/focus
// event, so hidden-electron.cjs cannot stop it). Background runs therefore
// never let a dialog go native: these overrides record each prompt and answer
// it from a scripted value. Product dialog code is unchanged; what the native
// box looks like is NOT covered by these tests.
//
// confirm returns the scripted answer (default false, i.e. dismissed), alert
// returns nothing and prompt returns null. A reload starts again from the
// default answer with an empty log.

export interface ScriptedDialog {
  type: 'alert' | 'confirm' | 'prompt';
  message: string;
}

function installScriptedDialogs(): void {
  const w = window as unknown as {
    __e2eDialogs?: ScriptedDialog[];
    __e2eConfirmAnswer?: boolean;
  };
  if (w.__e2eDialogs) return;
  const log: ScriptedDialog[] = [];
  w.__e2eDialogs = log;
  w.__e2eConfirmAnswer = false;
  // Read-only, so the app's own background-test dialog layer (installed by
  // the preload in no fixed order relative to this init script) cannot
  // replace these and leave prompts out of the log.
  const fix = (name: 'alert' | 'confirm' | 'prompt', value: (message?: string) => unknown) =>
    Object.defineProperty(window, name, { value, writable: false, configurable: true });
  fix('alert', (message) => {
    log.push({ type: 'alert', message: String(message ?? '') });
  });
  fix('confirm', (message) => {
    log.push({ type: 'confirm', message: String(message ?? '') });
    return w.__e2eConfirmAnswer === true;
  });
  fix('prompt', (message) => {
    log.push({ type: 'prompt', message: String(message ?? '') });
    return null;
  });
}

// Installs the overrides in the current document and, through the context's
// init script, in documents a reload creates.
export async function scriptDialogs(app: ElectronApplication, page: Page): Promise<void> {
  await app.context().addInitScript(installScriptedDialogs);
  await page.evaluate(installScriptedDialogs);
  // Fail before any interaction if a native dialog could still open.
  const native = await page.evaluate(() =>
    [window.alert, window.confirm, window.prompt].some((fn) =>
      Function.prototype.toString.call(fn).includes('[native code]'),
    ),
  );
  if (native) throw new Error('JavaScript dialogs are still native; refusing a background run');
}

export function answerConfirm(page: Page, accept: boolean): Promise<void> {
  return page.evaluate((accept) => {
    (window as unknown as { __e2eConfirmAnswer?: boolean }).__e2eConfirmAnswer = accept;
  }, accept);
}

export function scriptedDialogs(page: Page): Promise<ScriptedDialog[]> {
  return page.evaluate(
    () => (window as unknown as { __e2eDialogs?: ScriptedDialog[] }).__e2eDialogs ?? [],
  );
}

// Visible app windows, for the end-of-test check that a run stayed hidden.
export function visibleWindows(app: ElectronApplication): Promise<number[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((w) => w.isVisible())
      .map((w) => w.id),
  );
}
