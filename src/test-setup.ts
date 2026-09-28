// Preloaded into every test process by `pnpm test`
// (`node --test --require ./dist/test-setup.js`; the runner forwards
// `--require` to each per-file child process).
//
// Gives each test process its own throwaway data directory so nothing a test
// exercises -- usage.jsonl, config.json, transcriptions -- can resolve to the
// developer's real getDataPath(). Always overrides an inherited
// LISTENER_DATA_PATH: the runner process loads this file too and would
// otherwise hand one shared directory to every child.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

process.env.NODE_ENV = 'test';

const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'listener-test-data-'));
process.env.LISTENER_DATA_PATH = dataPath;

process.on('exit', () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
});
