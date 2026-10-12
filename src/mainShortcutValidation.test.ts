import * as fs from 'fs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as path from 'path';
import * as vm from 'vm';

// main.ts registers its IPC handlers at module load and has no test harness, so
// this runs the compiled `validate-shortcut` handler alone against stub
// dependencies. No Electron process starts and no OS shortcut is touched.
const HANDLER_START = "electron_1.ipcMain.handle('validate-shortcut',";

function extractHandlerSource(): string {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = source.indexOf(HANDLER_START);
  assert.notEqual(start, -1, 'validate-shortcut handler not found in compiled main.js');
  const end = source.indexOf('\n});', start);
  assert.notEqual(end, -1, 'end of validate-shortcut handler not found');
  return source.slice(start, end + '\n});'.length);
}

interface ShortcutCalls {
  register: string[];
  unregister: string[];
  restore: number;
}

type ValidateResult = { valid: boolean; unavailable?: boolean; error?: string };

function loadHandler(backgroundTestMode: boolean, registerResult = true) {
  const calls: ShortcutCalls = { register: [], unregister: [], restore: 0 };
  let handler: ((event: unknown, shortcut: string) => Promise<ValidateResult>) | undefined;
  const context = vm.createContext({
    backgroundTestMode,
    registerGlobalShortcut: () => {
      calls.restore += 1;
    },
    electron_1: {
      ipcMain: {
        handle: (channel: string, fn: typeof handler) => {
          assert.equal(channel, 'validate-shortcut');
          handler = fn;
        },
      },
      globalShortcut: {
        register: (accelerator: string) => {
          calls.register.push(accelerator);
          return registerResult;
        },
        unregister: (accelerator: string) => {
          calls.unregister.push(accelerator);
        },
      },
    },
  });
  vm.runInContext(extractHandlerSource(), context);
  assert.ok(handler, 'validate-shortcut handler was not registered');
  return { handler, calls };
}

describe('validate-shortcut IPC handler', () => {
  it('reports validation unavailable in background test mode without touching OS shortcuts', async () => {
    const { handler, calls } = loadHandler(true);
    const result = await handler({}, 'CommandOrControl+Shift+R');
    assert.equal(result.valid, false);
    assert.equal(result.unavailable, true);
    assert.match(result.error ?? '', /unavailable in background test mode/);
    assert.deepEqual(calls, { register: [], unregister: [], restore: 0 });
  });

  it('still probes, releases and restores the shortcut outside background mode', async () => {
    const { handler, calls } = loadHandler(false, true);
    const result = await handler({}, 'CommandOrControl+Shift+R');
    assert.deepEqual({ ...result }, { valid: true });
    assert.deepEqual(calls, {
      register: ['CommandOrControl+Shift+R'],
      unregister: ['CommandOrControl+Shift+R'],
      restore: 1,
    });
  });

  it('reports a taken shortcut as invalid outside background mode', async () => {
    const { handler, calls } = loadHandler(false, false);
    const result = await handler({}, 'CommandOrControl+Shift+R');
    assert.deepEqual({ ...result }, { valid: false });
    assert.deepEqual(calls, { register: ['CommandOrControl+Shift+R'], unregister: [], restore: 1 });
  });
});
