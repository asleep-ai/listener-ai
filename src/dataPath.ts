import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const APP_NAME = 'listener-ai';
const LEGACY_APP_NAME = 'Listener.AI';

function platformDataPath(appName: string): string {
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', appName);
    case 'win32':
      return path.join(
        process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
        appName,
      );
    default:
      return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), appName);
  }
}

function hasUserData(dataPath: string): boolean {
  return (
    fs.existsSync(path.join(dataPath, 'config.json')) ||
    fs.existsSync(path.join(dataPath, 'transcriptions')) ||
    fs.existsSync(path.join(dataPath, 'recordings')) ||
    fs.existsSync(path.join(dataPath, 'metadata'))
  );
}

// Captured once at module load: a process started as a test stays a test for
// its whole life. A test that deletes or rewrites NODE_ENV mid-run (to exercise
// some other NODE_ENV gate) must not flip getDataPath() back to the user's real
// data directory for every later test in that process.
const TEST_ENV_AT_LOAD = process.env.NODE_ENV === 'test';

export function isTestEnvironment(): boolean {
  return TEST_ENV_AT_LOAD || process.env.NODE_ENV === 'test';
}

export function getDataPath(): string {
  // Test escape hatch: integration tests set this to a temp dir to avoid
  // touching the user's real data. Gated on NODE_ENV=test so a stray
  // LISTENER_DATA_PATH in a packaged user's shell rc can't redirect their
  // config + transcriptions to an attacker-controlled path.
  if (process.env.LISTENER_DATA_PATH && isTestEnvironment()) {
    return process.env.LISTENER_DATA_PATH;
  }

  const currentPath = platformDataPath(APP_NAME);
  const legacyPath = platformDataPath(LEGACY_APP_NAME);

  if (hasUserData(currentPath)) return currentPath;
  if (hasUserData(legacyPath)) return legacyPath;

  if (fs.existsSync(currentPath)) return currentPath;
  if (fs.existsSync(legacyPath)) return legacyPath;

  return currentPath;
}
