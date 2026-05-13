// Covers the OAuth-credential persistence boundary (PR #119 review C1), the
// LISTENER_AI_PROVIDER env override (M2), file-mode hardening (m2), and the
// concurrent-save dirty-key merge (M4). These are the moving parts most likely
// to leak credentials or lose user config across processes.

import * as fs from 'fs';
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import * as path from 'path';
import { ConfigService } from './configService';
import { makeTempDir, rmDir } from './test-helpers';

let workDir: string;

const CODEX_ENV_KEYS = [
  'CODEX_OAUTH_ACCESS_TOKEN',
  'CODEX_OAUTH_REFRESH_TOKEN',
  'CODEX_OAUTH_EXPIRES',
  'OPENAI_CODEX_ACCESS_TOKEN',
  'OPENAI_CODEX_REFRESH_TOKEN',
  'OPENAI_CODEX_EXPIRES',
  'LISTENER_AI_PROVIDER',
];
const savedEnv = new Map<string, string | undefined>();

before(() => {
  workDir = makeTempDir('config-service');
  for (const k of CODEX_ENV_KEYS) savedEnv.set(k, process.env[k]);
});

after(() => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmDir(workDir);
});

beforeEach(() => {
  for (const k of CODEX_ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of CODEX_ENV_KEYS) delete process.env[k];
});

function freshDataPath(suffix: string): string {
  const dir = path.join(workDir, suffix);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('ConfigService: Codex OAuth credential source', () => {
  it('returns env credentials when config has none', () => {
    process.env.CODEX_OAUTH_ACCESS_TOKEN = 'env-access';
    process.env.CODEX_OAUTH_REFRESH_TOKEN = 'env-refresh';
    process.env.CODEX_OAUTH_EXPIRES = String(Date.now() + 30 * 60_000);

    const cfg = new ConfigService(freshDataPath('env-only'));
    const creds = cfg.getCodexOAuth();
    assert.ok(creds, 'expected env credentials to be returned');
    assert.equal(creds?.access, 'env-access');
  });

  it('hasStoredCodexOAuth is false for env-only credentials', () => {
    process.env.CODEX_OAUTH_ACCESS_TOKEN = 'env-access';
    process.env.CODEX_OAUTH_REFRESH_TOKEN = 'env-refresh';

    const cfg = new ConfigService(freshDataPath('env-only-stored'));
    assert.equal(cfg.hasStoredCodexOAuth(), false);
    // hasCodexOAuth, in contrast, accepts env-sourced credentials.
    assert.equal(cfg.hasCodexOAuth(), true);
  });

  it('hasStoredCodexOAuth is true after explicit setCodexOAuth', () => {
    const cfg = new ConfigService(freshDataPath('stored'));
    cfg.setCodexOAuth({ access: 'a', refresh: 'r', expires: Date.now() + 60_000 });
    assert.equal(cfg.hasStoredCodexOAuth(), true);
  });

  it('config credentials win over env credentials', () => {
    process.env.CODEX_OAUTH_ACCESS_TOKEN = 'env-access';
    process.env.CODEX_OAUTH_REFRESH_TOKEN = 'env-refresh';

    const dataPath = freshDataPath('config-vs-env');
    const cfg = new ConfigService(dataPath);
    cfg.setCodexOAuth({ access: 'config-access', refresh: 'r', expires: Date.now() + 60_000 });

    assert.equal(cfg.getCodexOAuth()?.access, 'config-access');
  });

  it('clearCodexOAuth removes the key from disk (not resurrected by save-merge)', () => {
    const dataPath = freshDataPath('clear');
    const cfg = new ConfigService(dataPath);
    cfg.setCodexOAuth({ access: 'a', refresh: 'r', expires: Date.now() + 60_000 });
    cfg.clearCodexOAuth();

    const onDisk = JSON.parse(fs.readFileSync(path.join(dataPath, 'config.json'), 'utf-8'));
    assert.equal(onDisk.codexOAuth, undefined);
    assert.equal(cfg.hasStoredCodexOAuth(), false);
  });
});

describe('ConfigService: LISTENER_AI_PROVIDER env override', () => {
  it('overrides configured provider', () => {
    const cfg = new ConfigService(freshDataPath('env-override'));
    cfg.setAiProvider('gemini');
    process.env.LISTENER_AI_PROVIDER = 'codex';
    assert.equal(cfg.getAiProvider(), 'codex');
  });

  it('warns exactly once when env disagrees with configured value', () => {
    const cfg = new ConfigService(freshDataPath('env-warn'));
    cfg.setAiProvider('gemini');
    process.env.LISTENER_AI_PROVIDER = 'codex';

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: string) => {
      warnings.push(String(msg));
    };
    try {
      cfg.getAiProvider();
      cfg.getAiProvider();
      cfg.getAiProvider();
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 1, 'expected one warning across repeated calls');
    assert.match(warnings[0], /LISTENER_AI_PROVIDER=codex/);
    assert.match(warnings[0], /aiProvider=gemini/);
  });

  it('does not warn when env matches configured value', () => {
    const cfg = new ConfigService(freshDataPath('env-no-warn'));
    cfg.setAiProvider('codex');
    process.env.LISTENER_AI_PROVIDER = 'codex';

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: string) => {
      warnings.push(String(msg));
    };
    try {
      cfg.getAiProvider();
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 0);
  });
});

describe('ConfigService: saveConfig file mode + concurrent merge', () => {
  it('writes config.json with mode 0o600 (POSIX)', { skip: process.platform === 'win32' }, () => {
    const dataPath = freshDataPath('mode');
    const cfg = new ConfigService(dataPath);
    cfg.setGeminiApiKey('gemini-key');

    const stat = fs.statSync(path.join(dataPath, 'config.json'));
    // mask off file type bits; only inspect permission bits
    const mode = stat.mode & 0o777;
    assert.equal(mode, 0o600, `expected 0o600 mode, got 0o${mode.toString(8)}`);
  });

  it('save merges disk-side keys this process never modified', () => {
    const dataPath = freshDataPath('merge-disk-keys');

    // Process A writes geminiApiKey.
    const a = new ConfigService(dataPath);
    a.setGeminiApiKey('from-A');

    // Process B starts up, only knows about a different key, then saves.
    const b = new ConfigService(dataPath);
    b.setNotionApiKey('from-B');

    const onDisk = JSON.parse(fs.readFileSync(path.join(dataPath, 'config.json'), 'utf-8'));
    assert.equal(onDisk.geminiApiKey, 'from-A', "A's write must survive B's save");
    assert.equal(onDisk.notionApiKey, 'from-B');
  });

  it('save merges disk-side concurrent writes that happened after load', () => {
    const dataPath = freshDataPath('merge-after-load');

    // B loads first with an empty file.
    const b = new ConfigService(dataPath);

    // A writes concurrently (different key) -- this lands on disk before B saves.
    const a = new ConfigService(dataPath);
    a.setGeminiApiKey('from-A-late');

    // B now saves its own change.
    b.setNotionApiKey('from-B');

    const onDisk = JSON.parse(fs.readFileSync(path.join(dataPath, 'config.json'), 'utf-8'));
    assert.equal(onDisk.geminiApiKey, 'from-A-late', "A's late write must not be clobbered by B");
    assert.equal(onDisk.notionApiKey, 'from-B');
  });

  it('unsetKey deletes a key even when disk has it from a concurrent process', () => {
    const dataPath = freshDataPath('unset-merge');

    const a = new ConfigService(dataPath);
    a.setSummaryPrompt('keep me');
    a.setGlobalShortcut('CommandOrControl+Shift+L');

    // B starts fresh, intentionally unsets one of A's keys.
    const b = new ConfigService(dataPath);
    b.unsetKey('summaryPrompt');

    const onDisk = JSON.parse(fs.readFileSync(path.join(dataPath, 'config.json'), 'utf-8'));
    assert.equal(onDisk.summaryPrompt, undefined, 'unsetKey must win over disk-side value');
    assert.equal(onDisk.globalShortcut, 'CommandOrControl+Shift+L', 'other A-keys must survive');
  });
});
