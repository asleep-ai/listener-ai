import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { browserLaunchCommand, openInBrowser } from './browserLauncher';

// A real authorize URL shape: several `&`-joined parameters plus characters
// cmd.exe treats specially (`^`, `|`, `%`).
const AUTHORIZE_URL =
  'https://auth.openai.com/oauth/authorize?response_type=code&client_id=oaiapp_x&state=a%26b&scope=openid%20profile&x=^|%PATH%';

type SpawnCall = { command: string; args: string[]; options: Record<string, unknown> };

function fakeSpawn(outcome: 'spawn' | 'error') {
  const calls: SpawnCall[] = [];
  const spawn = ((command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    const child = Object.assign(new EventEmitter(), { unref: () => {} });
    queueMicrotask(() =>
      outcome === 'spawn' ? child.emit('spawn') : child.emit('error', new Error('ENOENT')),
    );
    return child;
  }) as never;
  return { spawn, calls };
}

describe('browserLauncher', () => {
  it('opens Windows URLs through the System32 URL handler with the URL as one argument', () => {
    const { command, args } = browserLaunchCommand(AUTHORIZE_URL, 'win32', {
      SystemRoot: 'D:\\Win',
    });
    assert.equal(command, 'D:\\Win\\System32\\rundll32.exe');
    assert.deepEqual(args, ['url.dll,FileProtocolHandler', AUTHORIZE_URL]);
    assert.ok(!/cmd(\.exe)?$/i.test(command));
    assert.equal(
      browserLaunchCommand(AUTHORIZE_URL, 'win32', {}).command,
      'C:\\Windows\\System32\\rundll32.exe',
    );
  });

  it('keeps the macOS and Linux launchers', () => {
    assert.deepEqual(browserLaunchCommand(AUTHORIZE_URL, 'darwin'), {
      command: 'open',
      args: [AUTHORIZE_URL],
    });
    assert.deepEqual(browserLaunchCommand(AUTHORIZE_URL, 'linux'), {
      command: 'xdg-open',
      args: [AUTHORIZE_URL],
    });
  });

  it('spawns without a shell and passes the URL unmodified', async () => {
    const { spawn, calls } = fakeSpawn('spawn');
    assert.equal(await openInBrowser(AUTHORIZE_URL, { platform: 'win32', env: {}, spawn }), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].args.at(-1), AUTHORIZE_URL);
  });

  it('reports a launcher that failed to start', async () => {
    const { spawn } = fakeSpawn('error');
    assert.equal(await openInBrowser(AUTHORIZE_URL, { platform: 'linux', spawn }), false);
  });

  it('refuses anything but an http(s) URL without spawning', async () => {
    const { spawn, calls } = fakeSpawn('spawn');
    for (const url of [
      'file:///C:/Windows/System32/calc.exe',
      'not a url',
      'javascript:alert(1)',
    ]) {
      assert.equal(await openInBrowser(url, { platform: 'win32', env: {}, spawn }), false);
    }
    assert.equal(calls.length, 0);
  });
});
