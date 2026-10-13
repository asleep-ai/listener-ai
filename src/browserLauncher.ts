// Open a sign-in URL in the user's default browser from the CLI.
//
// The URL is always passed as one argv entry to a native launcher, never
// through a shell: an OAuth authorize URL carries `&` between query
// parameters, which `cmd /c start` would treat as a command separator.

import { spawn as nodeSpawn } from 'child_process';
import * as path from 'path';

export interface BrowserLaunchCommand {
  command: string;
  args: string[];
}

/**
 * The launcher for `url` on `platform`. Windows uses the URL protocol handler
 * through rundll32 from System32 (resolved from SystemRoot, not PATH).
 */
export function browserLaunchCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): BrowserLaunchCommand {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') {
    const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
    return {
      command: path.win32.join(systemRoot, 'System32', 'rundll32.exe'),
      args: ['url.dll,FileProtocolHandler', url],
    };
  }
  return { command: 'xdg-open', args: [url] };
}

/** Resolves false (never throws) when the browser could not be started. */
export function openInBrowser(
  url: string,
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    spawn?: typeof nodeSpawn;
  } = {},
): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.resolve(false);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return Promise.resolve(false);
  const { command, args } = browserLaunchCommand(url, options.platform, options.env);
  const spawn = options.spawn ?? nodeSpawn;
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, {
        stdio: 'ignore',
        detached: true,
        shell: false,
        windowsHide: true,
      });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
