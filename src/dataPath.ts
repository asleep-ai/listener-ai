import * as path from 'path';
import * as os from 'os';

// Must match productName in package.json (used by Electron for app.getPath('userData'))
const APP_NAME = 'Listener.AI';

export function getDataPath(): string {
  // Test escape hatch: integration tests set this to a temp dir to avoid
  // touching the user's real data. Gated on NODE_ENV=test so a stray
  // LISTENER_DATA_PATH in a packaged user's shell rc can't redirect their
  // config + transcriptions to an attacker-controlled path.
  if (process.env.LISTENER_DATA_PATH && process.env.NODE_ENV === 'test') {
    return process.env.LISTENER_DATA_PATH;
  }
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
    case 'win32':
      return path.join(process.env['APPDATA'] || path.join(os.homedir(), 'AppData', 'Roaming'), APP_NAME);
    default:
      return path.join(process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config'), APP_NAME);
  }
}
