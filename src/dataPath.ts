import * as path from 'path';
import * as os from 'os';

// Must match productName in package.json (used by Electron for app.getPath('userData'))
const APP_NAME = 'Listener.AI';

export function getDataPath(): string {
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
    case 'win32':
      return path.join(process.env['APPDATA'] || path.join(os.homedir(), 'AppData', 'Roaming'), APP_NAME);
    default:
      return path.join(process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config'), APP_NAME);
  }
}
