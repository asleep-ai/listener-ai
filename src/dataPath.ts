import * as path from 'path';
import * as os from 'os';

export function getDataPath(): string {
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'Listener.AI');
    case 'win32':
      return path.join(process.env['APPDATA'] || path.join(os.homedir(), 'AppData', 'Roaming'), 'Listener.AI');
    default:
      return path.join(process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config'), 'Listener.AI');
  }
}
