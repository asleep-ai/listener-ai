// Covers the OAuth-credential persistence boundary (PR #119 review C1), the
// LISTENER_AI_PROVIDER env override (M2), file-mode hardening (m2), and the
// concurrent-save dirty-key merge (M4). These are the moving parts most likely
// to leak credentials or lose user config across processes.

import * as fs from 'fs';
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import * as path from 'path';
import { diffConfigPayload } from './configDiff';
import {
  AGENT_READABLE_CONFIG_KEYS,
  AGENT_WRITABLE_CONFIG_KEYS,
  CONFIG_KEY_DEFINITIONS,
  KNOWN_CONFIG_KEYS,
} from './configKeys';
import {
  ConfigService,
  chatGPTBindingChanged,
  DEFAULT_SUMMARY_PROMPT,
  TranscriptionProviderSelectionError,
} from './configService';
import { makeTempDir, rmDir } from './test-helpers';

let workDir: string;

const CODEX_ENV_KEYS = [
  'CODEX_OAUTH_ACCESS_TOKEN',
  'CODEX_OAUTH_REFRESH_TOKEN',
  'CODEX_OAUTH_EXPIRES',
  'OPENAI_CODEX_ACCESS_TOKEN',
  'OPENAI_CODEX_REFRESH_TOKEN',
  'OPENAI_CODEX_EXPIRES',
  'OPENAI_API_KEY',
  'SONIOX_API_KEY',
  'GEMINI_API_KEY',
  'LISTENER_AI_PROVIDER',
  'LISTENER_CODEX_AUTH_PATH',
  'NOTION_API_KEY',
  'NOTION_DATABASE_ID',
  'SLACK_WEBHOOK_URL',
  'GOOGLE_OAUTH_ACCESS_TOKEN',
  'GOOGLE_OAUTH_REFRESH_TOKEN',
  'GOOGLE_OAUTH_EXPIRES',
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

function fakeJwt(expMs: number, accountId = 'acct_cli'): string {
  const payload = {
    exp: Math.floor(expMs / 1000),
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  };
  const encoded = Buffer.from(JSON.stringify(payload))
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `header.${encoded}.sig`;
}

function writeCodexCliAuth(filePath: string, expMs = Date.now() + 60_000): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: fakeJwt(expMs),
        refresh_token: 'cli-refresh',
        account_id: 'acct_cli',
      },
    }),
    'utf-8',
  );
}

// The retired Codex OAuth path must never authenticate anything: not tokens
// stored in config.json, not CODEX_* env vars, not ~/.codex/auth.json. A user
// who chose Codex keeps the ChatGPT-plan intent but must sign in again.
describe('ConfigService: legacy Codex migration (no credential reuse)', () => {
  function writeLegacyConfig(dataPath: string, extra: Record<string, unknown> = {}): void {
    fs.writeFileSync(
      path.join(dataPath, 'config.json'),
      JSON.stringify({
        codexOAuth: {
          access: 'legacy-access',
          refresh: 'legacy-refresh',
          expires: Date.now() + 3_600_000,
        },
        ...extra,
      }),
    );
  }

  it('maps a stored aiProvider=codex to chatgpt, unauthenticated until a new sign-in', () => {
    const dataPath = freshDataPath('legacy-codex-provider');
    writeLegacyConfig(dataPath, { aiProvider: 'codex' });
    process.env.CODEX_OAUTH_ACCESS_TOKEN = 'env-access';
    process.env.CODEX_OAUTH_REFRESH_TOKEN = 'env-refresh';
    process.env.CODEX_OAUTH_EXPIRES = String(Date.now() + 3_600_000);
    const authPath = path.join(dataPath, 'codex-cli', 'auth.json');
    writeCodexCliAuth(authPath);
    process.env.LISTENER_CODEX_AUTH_PATH = authPath;

    const cfg = new ConfigService(dataPath);

    assert.equal(cfg.getAiProvider(), 'chatgpt');
    assert.equal(cfg.isLegacyCodexProviderConfigured(), true);
    assert.equal(cfg.hasLegacyCodexSignIn(), true);
    assert.equal(cfg.hasAiAuth(), false, 'old Codex tokens must never count as ChatGPT auth');
    assert.deepEqual(cfg.getMissingConfigs().slice(0, 1), ['Sign in with ChatGPT']);
  });

  it('carries the plan state into the renderer status payload', () => {
    const cfg = new ConfigService(freshDataPath('chatgpt-plan-state'));
    cfg.setChatGPTStatus({
      connected: true,
      planEnabled: false,
      planState: 'incomplete',
      profileId: 'p1',
    });
    assert.equal(cfg.getAllConfig().chatgptStatus?.planState, 'incomplete');
    assert.equal(cfg.hasChatGPTPlan(), false);
  });

  it('treats a same-profile reauthorization as a binding change for new work', () => {
    const cfg = new ConfigService(freshDataPath('chatgpt-session-revision'));
    const first = { connected: true, planEnabled: true, profileId: 'p1', sessionRevision: 'aaaa' };
    cfg.setChatGPTStatus(first);
    const cached = cfg.getChatGPTStatus();
    assert.equal(cached.sessionRevision, 'aaaa');
    assert.equal(chatGPTBindingChanged(cached, { ...first }), false);
    assert.equal(chatGPTBindingChanged(cached, { ...first, sessionRevision: 'bbbb' }), true);
    assert.equal(chatGPTBindingChanged(cached, { ...first, profileId: 'p2' }), true);
    assert.equal(chatGPTBindingChanged(cached, { ...first, planEnabled: false }), true);
    assert.equal(chatGPTBindingChanged(cached, { connected: false, planEnabled: false }), true);
  });

  it('counts only a fresh ChatGPT sign-in with plan usage as chat auth', () => {
    const dataPath = freshDataPath('legacy-codex-then-chatgpt');
    writeLegacyConfig(dataPath, { aiProvider: 'codex' });
    const cfg = new ConfigService(dataPath);
    cfg.setChatGPTStatus({ connected: true, planEnabled: false, profileId: 'p1' });
    assert.equal(cfg.hasAiAuth(), false, 'plan scope missing');
    cfg.setChatGPTStatus({ connected: true, planEnabled: true, profileId: 'p1' });
    assert.equal(cfg.hasAiAuth(), true);
  });

  it('keeps the ChatGPT-plan intent for an unset provider that only had Codex tokens', () => {
    const dataPath = freshDataPath('legacy-codex-implicit');
    writeLegacyConfig(dataPath);
    assert.equal(new ConfigService(dataPath).getAiProvider(), 'chatgpt');

    const withGemini = freshDataPath('legacy-codex-implicit-gemini');
    writeLegacyConfig(withGemini, { geminiApiKey: 'gemini-key' });
    assert.equal(new ConfigService(withGemini).getAiProvider(), 'gemini');
  });

  it('never exposes legacy tokens through getAllConfig', () => {
    const dataPath = freshDataPath('legacy-codex-projection');
    writeLegacyConfig(dataPath, { aiProvider: 'codex' });
    const all = new ConfigService(dataPath).getAllConfig();
    assert.equal(JSON.stringify(all).includes('legacy-access'), false);
    assert.equal(JSON.stringify(all).includes('legacy-refresh'), false);
    assert.equal(all.legacyCodexConfigured, true);
    assert.equal(all.aiProvider, 'chatgpt');
  });

  it('accepts a legacy codex write as chatgpt', () => {
    const dataPath = freshDataPath('legacy-codex-write');
    const cfg = new ConfigService(dataPath);
    cfg.updateConfig({ aiProvider: 'codex' as never });
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataPath, 'config.json'), 'utf-8'));
    assert.equal(onDisk.aiProvider, 'chatgpt');
  });

  it('clearLegacyCodexSignIn removes the tokens from disk', () => {
    const dataPath = freshDataPath('legacy-codex-clear');
    writeLegacyConfig(dataPath);
    const cfg = new ConfigService(dataPath);
    cfg.clearLegacyCodexSignIn();
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataPath, 'config.json'), 'utf-8'));
    assert.equal(onDisk.codexOAuth, undefined);
    assert.equal(cfg.hasLegacyCodexSignIn(), false);
  });
});

describe('ConfigService: chatgptPlanNoticeAcknowledged', () => {
  it('persists through a settings save and reads back in getAllConfig', () => {
    const dataPath = freshDataPath('plan-notice');
    const cfg = new ConfigService(dataPath);
    assert.equal(cfg.getAllConfig().chatgptPlanNoticeAcknowledged, false);
    cfg.updateConfig({ chatgptPlanNoticeAcknowledged: true });
    const reloaded = new ConfigService(dataPath);
    assert.equal(reloaded.getAllConfig().chatgptPlanNoticeAcknowledged, true);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataPath, 'config.json'), 'utf-8'));
    assert.equal(onDisk.chatgptPlanNoticeAcknowledged, true);
  });

  it('ignores a non-boolean value', () => {
    const cfg = new ConfigService(freshDataPath('plan-notice-invalid'));
    cfg.updateConfig({ chatgptPlanNoticeAcknowledged: 'yes' as never });
    assert.equal(cfg.getAllConfig().chatgptPlanNoticeAcknowledged, false);
  });

  it('is neither agent-readable, agent-writable nor a CLI key', () => {
    assert.equal(
      AGENT_WRITABLE_CONFIG_KEYS.includes('chatgptPlanNoticeAcknowledged' as never),
      false,
    );
    assert.equal(
      AGENT_READABLE_CONFIG_KEYS.includes('chatgptPlanNoticeAcknowledged' as never),
      false,
    );
    assert.equal(KNOWN_CONFIG_KEYS.includes('chatgptPlanNoticeAcknowledged' as never), false);
  });
});

describe('ConfigService: LISTENER_AI_PROVIDER env override', () => {
  it('overrides configured provider', () => {
    const cfg = new ConfigService(freshDataPath('env-override'));
    cfg.setAiProvider('gemini');
    process.env.LISTENER_AI_PROVIDER = 'chatgpt';
    assert.equal(cfg.getAiProvider(), 'chatgpt');
  });

  it('treats a legacy LISTENER_AI_PROVIDER=codex as chatgpt', () => {
    const cfg = new ConfigService(freshDataPath('env-override-legacy'));
    process.env.LISTENER_AI_PROVIDER = 'codex';
    assert.equal(cfg.getAiProvider(), 'chatgpt');
  });

  it('warns exactly once when env disagrees with configured value', () => {
    const cfg = new ConfigService(freshDataPath('env-warn'));
    cfg.setAiProvider('gemini');
    process.env.LISTENER_AI_PROVIDER = 'chatgpt';

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
    assert.match(warnings[0], /LISTENER_AI_PROVIDER=chatgpt/);
    assert.match(warnings[0], /aiProvider=gemini/);
  });

  it('does not warn when env matches configured value', () => {
    const cfg = new ConfigService(freshDataPath('env-no-warn'));
    cfg.setAiProvider('chatgpt');
    process.env.LISTENER_AI_PROVIDER = 'chatgpt';

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

  it(
    'tightens an existing 0o644 config.json down to 0o600 on next save (POSIX)',
    { skip: process.platform === 'win32' },
    () => {
      // Simulates the upgrade path: a user from a prior version has a
      // world-readable config.json on disk. The new save must explicitly
      // chmod it -- writeFileSync's `mode` option only applies on create.
      const dataPath = freshDataPath('mode-upgrade');
      const configPath = path.join(dataPath, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({ geminiApiKey: 'pre-existing' }));
      fs.chmodSync(configPath, 0o644);
      assert.equal(fs.statSync(configPath).mode & 0o777, 0o644);

      const cfg = new ConfigService(dataPath);
      cfg.setGeminiApiKey('rotated');

      assert.equal(
        fs.statSync(configPath).mode & 0o777,
        0o600,
        'existing file must be tightened to 0o600 after a save',
      );
    },
  );

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

describe('ConfigService: summary prompt default migration', () => {
  const legacyDefault = `Based on this meeting transcript, provide:

1. A concise meeting title in Korean (10-20 characters that captures the main topic)
2. A concise summary in Korean (2-3 paragraphs)
3. Key points discussed in Korean (as a bullet list)
4. Action items mentioned in Korean (as a bullet list)
5. An appropriate emoji that represents the meeting

Return as JSON:
{
  "suggestedTitle": "concise title in Korean",
  "summary": "summary in Korean",
  "keyPoints": ["point 1", "point 2"],
  "actionItems": ["action 1", "action 2"],
  "emoji": "📝"
}`;

  it('keeps the structured prompt contract decision-useful and evidence-grounded', () => {
    assert.match(DEFAULT_SUMMARY_PROMPT, /full transcript/);
    assert.match(DEFAULT_SUMMARY_PROMPT, /operational and commercial detail/);
    assert.match(DEFAULT_SUMMARY_PROMPT, /4-7 sections with 3-6 bullets/);
    assert.match(
      DEFAULT_SUMMARY_PROMPT,
      /explicit assignment, accepted request, or first-person commitment/,
    );
    assert.match(
      DEFAULT_SUMMARY_PROMPT,
      /decision about desired system behavior is not itself an action item/,
    );
    assert.match(
      DEFAULT_SUMMARY_PROMPT,
      /Do not infer ownership from the topic, expertise, or apparent role/,
    );
    assert.match(DEFAULT_SUMMARY_PROMPT, /"Speaker 2", "Participant 5", or "참가자 2"/);
    assert.match(
      DEFAULT_SUMMARY_PROMPT,
      /Keep unresolved issues in the summary unless the transcript explicitly creates a follow-up action/,
    );
    assert.doesNotMatch(
      DEFAULT_SUMMARY_PROMPT,
      /Convert unresolved issues into explicit alignment actions/,
    );
    assert.match(DEFAULT_SUMMARY_PROMPT, /exactly one primary owner/);
    assert.match(DEFAULT_SUMMARY_PROMPT, /empty array/);
    assert.match(DEFAULT_SUMMARY_PROMPT, /meeting's primary language/);
    assert.match(DEFAULT_SUMMARY_PROMPT, /"summarySections"/);
    assert.match(DEFAULT_SUMMARY_PROMPT, /"actionItemGroups"/);
  });

  it('guards against laundering transcript defects into confident claims', () => {
    // Store audit (#197): hedged values were resolved to one value, garbled
    // terms acquired invented English spellings, and finished work showed up
    // as pending action items.
    assert.match(DEFAULT_SUMMARY_PROMPT, /Keep the transcript's hedge/);
    assert.match(
      DEFAULT_SUMMARY_PROMPT,
      /Never invent an English, romanized, or corrected spelling/,
    );
    assert.match(
      DEFAULT_SUMMARY_PROMPT,
      /Exclude work the transcript describes as already completed/,
    );
  });

  it('replaces an exactly matching legacy default with the current default once', () => {
    const dataPath = freshDataPath('summary-legacy-default');
    const configPath = path.join(dataPath, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ summaryPrompt: legacyDefault }));

    const cfg = new ConfigService(dataPath);
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    assert.equal(cfg.getSummaryPrompt(), DEFAULT_SUMMARY_PROMPT);
    assert.equal(onDisk.summaryPrompt, undefined);
    assert.equal(onDisk.summaryPromptMigratedToStructured, true);
  });

  it('preserves a custom prompt while marking the migration complete', () => {
    const dataPath = freshDataPath('summary-custom');
    const configPath = path.join(dataPath, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ summaryPrompt: 'Return my custom schema.' }));

    const cfg = new ConfigService(dataPath);
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    assert.equal(cfg.getSummaryPrompt(), 'Return my custom schema.');
    assert.equal(onDisk.summaryPrompt, 'Return my custom schema.');
    assert.equal(onDisk.summaryPromptMigratedToStructured, true);
  });

  it('exposes the reset prompt without persisting the renderer-only field', () => {
    const dataPath = freshDataPath('summary-reset-payload');
    const cfg = new ConfigService(dataPath);

    assert.equal(cfg.getAllConfig().defaultSummaryPrompt, DEFAULT_SUMMARY_PROMPT);
    cfg.updateConfig({ defaultSummaryPrompt: 'renderer attempted write' });

    const onDisk = JSON.parse(fs.readFileSync(path.join(dataPath, 'config.json'), 'utf-8'));
    assert.equal(onDisk.defaultSummaryPrompt, undefined);
  });

  it('does not persist the current default as a custom prompt', () => {
    const dataPath = freshDataPath('summary-current-default');
    const cfg = new ConfigService(dataPath);

    cfg.updateConfig({ summaryPrompt: DEFAULT_SUMMARY_PROMPT });

    const onDisk = JSON.parse(fs.readFileSync(path.join(dataPath, 'config.json'), 'utf-8'));
    assert.equal(onDisk.summaryPrompt, undefined);
    assert.equal(cfg.getSummaryPrompt(), DEFAULT_SUMMARY_PROMPT);
  });
});

describe('ConfigService: geminiThinkingLevel', () => {
  it('returns "medium" when not set', () => {
    const cfg = new ConfigService(freshDataPath('thinking-default'));
    assert.equal(cfg.getGeminiThinkingLevel(), 'medium');
  });

  it('persists and retrieves a set value', () => {
    const cfg = new ConfigService(freshDataPath('thinking-set'));
    cfg.setGeminiThinkingLevel('high');
    assert.equal(cfg.getGeminiThinkingLevel(), 'high');
  });

  it('falls back to default for unrecognized on-disk values', () => {
    // A future client could write a wider level (e.g. "xhigh") or a legacy
    // value could survive in config.json -- the getter must not surface
    // something the rest of the codebase doesn't accept.
    const dataPath = freshDataPath('thinking-unknown');
    const configPath = path.join(dataPath, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ geminiThinkingLevel: 'xhigh' }));

    const cfg = new ConfigService(dataPath);
    assert.equal(cfg.getGeminiThinkingLevel(), 'medium');
  });

  it('round-trips through disk', () => {
    const dataPath = freshDataPath('thinking-roundtrip');
    const a = new ConfigService(dataPath);
    a.setGeminiThinkingLevel('low');

    const b = new ConfigService(dataPath);
    assert.equal(b.getGeminiThinkingLevel(), 'low');
  });

  it('updateConfig drops out-of-domain values instead of persisting them', () => {
    // The renderer save-config IPC and the agent set_config flow both land in
    // updateConfig with raw payloads. Without the normalize-or-drop arm there,
    // an attacker-controlled or buggy caller could persist e.g. 'xhigh' and
    // surface it back through getAllConfig() (the getter normalizes but disk
    // would still hold the bogus value).
    const dataPath = freshDataPath('thinking-update-invalid');
    const cfg = new ConfigService(dataPath);
    cfg.updateConfig({ geminiThinkingLevel: 'xhigh' as 'low' });

    const onDisk = JSON.parse(fs.readFileSync(path.join(dataPath, 'config.json'), 'utf-8'));
    assert.equal(onDisk.geminiThinkingLevel, undefined);
    assert.equal(cfg.getGeminiThinkingLevel(), 'medium');
  });
});

describe('ConfigService: updateConfig validation for aiProvider', () => {
  it('drops invalid aiProvider values', () => {
    const dataPath = freshDataPath('provider-update-invalid');
    const cfg = new ConfigService(dataPath);
    cfg.setAiProvider('gemini');
    cfg.updateConfig({ aiProvider: 'openai' as 'gemini' });

    const onDisk = JSON.parse(fs.readFileSync(path.join(dataPath, 'config.json'), 'utf-8'));
    assert.equal(onDisk.aiProvider, 'gemini', 'invalid update must not overwrite valid value');
  });

  it('accepts valid aiProvider values', () => {
    const dataPath = freshDataPath('provider-update-valid');
    const cfg = new ConfigService(dataPath);
    cfg.updateConfig({ aiProvider: 'chatgpt' });
    assert.equal(cfg.getAiProvider(), 'chatgpt');
  });
});

describe('ConfigService: live STT config', () => {
  it('returns env live STT keys when config has none', () => {
    process.env.OPENAI_API_KEY = 'env-openai';

    const cfg = new ConfigService(freshDataPath('live-env'));
    assert.equal(cfg.getOpenAiApiKey(), 'env-openai');
    assert.equal(cfg.hasStreamingLiveSttAuth(), true);
  });

  it('does not count a ChatGPT sign-in or legacy Codex tokens as OpenAI live Realtime auth', () => {
    const dataPath = freshDataPath('live-chatgpt');
    fs.writeFileSync(
      path.join(dataPath, 'config.json'),
      JSON.stringify({ codexOAuth: { access: 'a', refresh: 'r', expires: Date.now() + 60_000 } }),
    );
    const cfg = new ConfigService(dataPath);
    cfg.updateConfig({ liveSttProvider: 'openai' });
    cfg.setChatGPTStatus({ connected: true, planEnabled: true, profileId: 'p1' });

    assert.equal(cfg.getOpenAiApiKey(), undefined);
    assert.equal(cfg.hasStreamingLiveSttAuth(), false);
  });

  it('does not count a ChatGPT sign-in as auto live streaming auth', () => {
    const cfg = new ConfigService(freshDataPath('live-auto-chatgpt'));
    cfg.updateConfig({ liveSttProvider: 'auto' });
    cfg.setChatGPTStatus({ connected: true, planEnabled: true, profileId: 'p1' });

    assert.equal(cfg.hasStreamingLiveSttAuth(), false);
  });

  it('accepts Gemini API key as Gemini live auth', () => {
    process.env.GEMINI_API_KEY = 'env-gemini';

    const cfg = new ConfigService(freshDataPath('live-gemini-env'));
    cfg.updateConfig({ liveSttProvider: 'gemini' });
    assert.equal(cfg.getGeminiApiKey(), 'env-gemini');
    assert.equal(cfg.hasStreamingLiveSttAuth(), true);
  });

  it('config live STT keys win over env values', () => {
    process.env.OPENAI_API_KEY = 'env-openai';

    const cfg = new ConfigService(freshDataPath('live-config-wins'));
    cfg.setOpenAiApiKey('config-openai');
    assert.equal(cfg.getOpenAiApiKey(), 'config-openai');
  });

  it('drops invalid liveSttProvider values on updateConfig', () => {
    const cfg = new ConfigService(freshDataPath('live-provider-validation'));
    cfg.updateConfig({ liveSttProvider: 'openai' });
    assert.equal(cfg.getLiveSttProvider(), 'openai');
    cfg.updateConfig({ liveSttProvider: 'claude' as never });
    assert.equal(cfg.getLiveSttProvider(), 'openai');
  });

  it('accepts a Soniox API key as Soniox live auth', () => {
    const cfg = new ConfigService(freshDataPath('live-soniox-key'));
    cfg.updateConfig({ liveSttProvider: 'soniox' });
    assert.equal(cfg.hasStreamingLiveSttAuth(), false);
    cfg.setSonioxApiKey('soniox-key');
    assert.equal(cfg.hasStreamingLiveSttAuth(), true);
  });

  it('auto ignores the Soniox key', () => {
    const cfg = new ConfigService(freshDataPath('live-auto-ignores-soniox'));
    cfg.updateConfig({ liveSttProvider: 'auto' });
    cfg.setSonioxApiKey('soniox-key');
    assert.equal(cfg.hasStreamingLiveSttAuth(), false);
  });
});

describe('ConfigService: transcription provider', () => {
  it('defaults to auto, which follows Gemini and refuses for ChatGPT', () => {
    const cfg = new ConfigService(freshDataPath('transcription-default'));
    assert.equal(cfg.getTranscriptionProvider(), 'auto');
    cfg.setAiProvider('gemini');
    assert.equal(cfg.resolveTranscriptionProvider(), 'gemini');
    cfg.setAiProvider('chatgpt');
    assert.throws(() => cfg.resolveTranscriptionProvider(), TranscriptionProviderSelectionError);
    assert.equal(cfg.getTranscriptionResolution().issue, 'chatgpt-auto');
  });

  it('ChatGPT + auto refuses even when every STT key is configured (no silent provider)', () => {
    const cfg = new ConfigService(freshDataPath('transcription-chatgpt-auto-keys'));
    cfg.setAiProvider('chatgpt');
    cfg.setChatGPTStatus({ connected: true, planEnabled: true, profileId: 'p1' });
    cfg.setGeminiApiKey('gemini-key');
    cfg.setOpenAiApiKey('sk-openai');
    cfg.setSonioxApiKey('soniox-key');
    cfg.setNotionApiKey('notion-key');
    cfg.setNotionDatabaseId('db-id');

    assert.equal(cfg.getTranscriptionResolution().provider, undefined);
    assert.equal(cfg.hasAiAuth(), true);
    assert.equal(cfg.hasTranscriptionAuth(), false);
    assert.equal(cfg.hasRequiredConfig(), false);
    assert.deepEqual(cfg.getMissingConfigs(), [
      'Transcription provider (choose Gemini, OpenAI, or Soniox)',
    ]);
    assert.match(cfg.getAllConfig().transcriptionProviderIssue?.message ?? '', /cannot transcribe/);
  });

  it('a stored legacy transcriptionProvider=codex never resolves, not even with an OpenAI key', () => {
    for (const aiProvider of ['gemini', 'chatgpt'] as const) {
      const dataPath = freshDataPath(`transcription-legacy-codex-${aiProvider}`);
      fs.writeFileSync(
        path.join(dataPath, 'config.json'),
        JSON.stringify({
          aiProvider,
          transcriptionProvider: 'codex',
          geminiApiKey: 'gemini-key',
          openaiApiKey: 'sk-openai',
        }),
      );
      const cfg = new ConfigService(dataPath);
      assert.equal(cfg.isLegacyCodexTranscriptionConfigured(), true);
      const resolution = cfg.getTranscriptionResolution();
      assert.equal(resolution.provider, undefined);
      assert.equal(resolution.issue, 'legacy-codex');
      assert.match(resolution.message ?? '', /transcriptionProvider openai/);
      assert.equal(cfg.hasTranscriptionAuth(), false);
    }
  });

  it('OpenAI transcription is explicit and needs its own API key', () => {
    const cfg = new ConfigService(freshDataPath('transcription-openai'));
    cfg.setAiProvider('chatgpt');
    cfg.setChatGPTStatus({ connected: true, planEnabled: true, profileId: 'p1' });
    cfg.setTranscriptionProvider('openai');
    assert.equal(cfg.resolveTranscriptionProvider(), 'openai');
    assert.equal(cfg.hasTranscriptionAuth(), false, 'a ChatGPT sign-in never pays for audio');
    cfg.setOpenAiApiKey('sk-openai');
    assert.equal(cfg.hasTranscriptionAuth(), true);
    assert.equal(cfg.getOpenAiTranscriptionModel(), 'gpt-4o-transcribe-diarize');
  });

  it('round-trips an explicit provider through disk and ignores aiProvider', () => {
    const dataPath = freshDataPath('transcription-roundtrip');
    const cfg = new ConfigService(dataPath);
    cfg.setAiProvider('chatgpt');
    cfg.setTranscriptionProvider('soniox');

    const reloaded = new ConfigService(dataPath);
    assert.equal(reloaded.getTranscriptionProvider(), 'soniox');
    assert.equal(reloaded.resolveTranscriptionProvider(), 'soniox');
  });

  it('drops invalid transcriptionProvider values on updateConfig', () => {
    const cfg = new ConfigService(freshDataPath('transcription-validation'));
    cfg.updateConfig({ transcriptionProvider: 'soniox' });
    assert.equal(cfg.getTranscriptionProvider(), 'soniox');
    cfg.updateConfig({ transcriptionProvider: 'whisper' as never });
    assert.equal(cfg.getTranscriptionProvider(), 'soniox');
  });

  it('reports transcription auth separately from summary auth', () => {
    const cfg = new ConfigService(freshDataPath('transcription-auth'));
    cfg.setGeminiApiKey('gemini-key');
    cfg.setTranscriptionProvider('soniox');
    assert.equal(cfg.hasAiAuth(), true, 'summary auth still comes from aiProvider');
    assert.equal(cfg.hasTranscriptionAuth(), false);
    cfg.setSonioxApiKey('soniox-key');
    assert.equal(cfg.hasTranscriptionAuth(), true);
  });

  it('a Soniox key alone does not satisfy summary auth', () => {
    const cfg = new ConfigService(freshDataPath('transcription-auth-no-summary'));
    cfg.setTranscriptionProvider('soniox');
    cfg.setSonioxApiKey('soniox-key');
    assert.equal(cfg.hasTranscriptionAuth(), true);
    assert.equal(cfg.hasAiAuth(), false);
  });

  // Auto mode gates on hasRequiredConfig/getMissingConfigs before it spends
  // any transcription work, so a diverging transcription backend has to be
  // represented there too -- otherwise a missing Soniox key only surfaces as a
  // pipeline failure after the recording is already done.
  it('reports the transcription backend credential as a missing config', () => {
    const cfg = new ConfigService(freshDataPath('missing-soniox'));
    cfg.setGeminiApiKey('gemini-key');
    cfg.setNotionApiKey('notion-key');
    cfg.setNotionDatabaseId('db-id');
    cfg.setTranscriptionProvider('soniox');

    assert.equal(cfg.hasRequiredConfig(), false);
    assert.deepEqual(cfg.getMissingConfigs(), ['Soniox API key']);

    cfg.setSonioxApiKey('soniox-key');
    assert.equal(cfg.hasRequiredConfig(), true);
    assert.deepEqual(cfg.getMissingConfigs(), []);
  });

  it('reports a missing Gemini transcription credential while the chat provider is signed in', () => {
    const cfg = new ConfigService(freshDataPath('missing-gemini-backend'));
    cfg.setChatGPTStatus({ connected: true, planEnabled: true, profileId: 'p1' });
    cfg.setAiProvider('chatgpt');
    cfg.setNotionApiKey('notion-key');
    cfg.setNotionDatabaseId('db-id');
    cfg.setTranscriptionProvider('gemini');

    assert.equal(cfg.hasAiAuth(), true, 'chat provider credentials are fine');
    assert.equal(cfg.hasRequiredConfig(), false);
    assert.deepEqual(cfg.getMissingConfigs(), ['Gemini API Key']);
  });

  it('names one credential when both gates resolve to the same missing provider', () => {
    const cfg = new ConfigService(freshDataPath('missing-shared'));
    cfg.setNotionApiKey('notion-key');
    cfg.setNotionDatabaseId('db-id');

    // aiProvider gemini, transcriptionProvider auto -> both want the same key.
    assert.deepEqual(cfg.getMissingConfigs(), ['Gemini API Key']);
  });

  it('falls back to SONIOX_API_KEY but never surfaces it to the settings form', () => {
    process.env.SONIOX_API_KEY = 'env-soniox';

    const cfg = new ConfigService(freshDataPath('soniox-env'));
    assert.equal(cfg.getSonioxApiKey(), 'env-soniox');
    assert.equal(cfg.getAllConfig().sonioxApiKey, undefined);

    cfg.setSonioxApiKey('config-soniox');
    assert.equal(cfg.getSonioxApiKey(), 'config-soniox');
    assert.equal(cfg.getAllConfig().sonioxApiKey, 'config-soniox');
  });
});

describe('ConfigService: codexTranscriptionModel migration to diarize default', () => {
  it('clears the legacy `gpt-4o-transcribe` value and stamps the marker', () => {
    const dataPath = freshDataPath('migrate-legacy');
    const configPath = path.join(dataPath, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ codexTranscriptionModel: 'gpt-4o-transcribe' }));

    new ConfigService(dataPath);

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.equal(
      onDisk.codexTranscriptionModel,
      undefined,
      'legacy default must be cleared so the new default applies',
    );
    assert.equal(onDisk.codexTranscriptionMigratedToDiarize, true);
  });

  it('stamps the marker even for fresh installs that never had the legacy default', () => {
    // Regression for the P2 review: if the marker only landed when the
    // migration cleared something, a user who never had a stored value
    // could later explicitly opt back into `gpt-4o-transcribe` and have
    // their choice clobbered on the next restart.
    const dataPath = freshDataPath('migrate-fresh');
    const configPath = path.join(dataPath, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({}));

    new ConfigService(dataPath);

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.equal(onDisk.codexTranscriptionMigratedToDiarize, true);
  });

  it('does not re-run the migration once the marker is set', () => {
    const dataPath = freshDataPath('migrate-idempotent');
    const configPath = path.join(dataPath, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        codexTranscriptionModel: 'gpt-4o-transcribe',
        codexTranscriptionMigratedToDiarize: true,
      }),
    );

    new ConfigService(dataPath);

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    // Marker already there -> user's explicit choice is preserved.
    assert.equal(onDisk.codexTranscriptionModel, 'gpt-4o-transcribe');
  });
});

// Pins the full `getAllConfig()` projection: which keys it emits, and the
// stored/env/default resolution behind each one. The trivial getters are
// derived from the `configKeys.ts` registry, so this literal is the regression
// guard that the generic resolution still reproduces the hand-written getters
// (including the `||` vs `??` distinction and the two deliberately stored-only
// API keys).
describe('ConfigService: getAllConfig projection', () => {
  function writeFixture(dataPath: string, extra: Record<string, unknown> = {}): void {
    fs.writeFileSync(
      path.join(dataPath, 'config.json'),
      JSON.stringify({
        aiProvider: 'codex',
        transcriptionProvider: 'soniox',
        geminiModel: 'custom-gemini',
        geminiThinkingLevel: 'high',
        liveSttProvider: 'soniox',
        // Stored empty string: the getter falls through to OPENAI_API_KEY but
        // getAllConfig must still report the stored value.
        openaiApiKey: '',
        liveSttLanguage: '  en  ',
        liveTranslationLanguage: '   ',
        notionDatabaseId: 'stored-db',
        autoMode: true,
        meetingDetection: false,
        globalShortcut: '',
        knownWords: ['alpha', 'beta'],
        maxRecordingMinutes: 90,
        minRecordingSeconds: 0,
        recordSystemAudio: true,
        audioDeviceId: '',
        lastSeenVersion: '2.0.0',
        slackAutoShare: true,
        ...extra,
      }),
    );
  }

  function setEnv(dataPath: string): void {
    process.env.GEMINI_API_KEY = 'env-gemini-key';
    process.env.OPENAI_API_KEY = 'env-openai-key';
    process.env.SONIOX_API_KEY = 'env-soniox-key';
    process.env.NOTION_API_KEY = 'env-notion-key';
    process.env.NOTION_DATABASE_ID = 'env-db';
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.example/env';
    // A Codex CLI auth file must not influence anything anymore; point the
    // retired override at nothing to prove the projection ignores it.
    process.env.LISTENER_CODEX_AUTH_PATH = path.join(dataPath, 'no-such-codex-auth.json');
  }

  const expected = {
    // Stored legacy `codex` reads as `chatgpt`.
    aiProvider: 'chatgpt',
    transcriptionProvider: 'soniox',
    geminiApiKey: 'env-gemini-key',
    geminiModel: 'custom-gemini',
    geminiFlashModel: 'gemini-2.5-flash',
    geminiThinkingLevel: 'high',
    chatgptModel: undefined,
    chatgptPlanNoticeAcknowledged: false,
    openaiTranscriptionModel: 'gpt-4o-transcribe-diarize',
    liveSttProvider: 'soniox',
    openaiApiKey: '',
    sonioxApiKey: undefined,
    openaiLiveTranscriptionModel: 'gpt-realtime-whisper',
    openaiLiveTranslationModel: 'gpt-realtime-translate',
    liveSttLanguage: 'en',
    liveTranslationLanguage: 'ko',
    chatgptStatus: { connected: false, planEnabled: false },
    // The fixture still stores aiProvider=codex.
    legacyCodexConfigured: true,
    googleOAuthConfigured: false,
    googleDriveEnabled: false,
    notionApiKey: 'env-notion-key',
    notionDatabaseId: 'stored-db',
    autoMode: true,
    meetingDetection: false,
    displayDetection: false,
    globalShortcut: 'CommandOrControl+Shift+L',
    knownWords: ['alpha', 'beta'],
    summaryPrompt: DEFAULT_SUMMARY_PROMPT,
    defaultSummaryPrompt: DEFAULT_SUMMARY_PROMPT,
    maxRecordingMinutes: 90,
    recordingReminderMinutes: 0,
    minRecordingSeconds: 0,
    recordSystemAudio: true,
    crashReportingEnabled: true,
    audioDeviceId: '',
    lastSeenVersion: '2.0.0',
    slackWebhookUrl: 'https://hooks.example/env',
    slackAutoShare: true,
  };

  it('resolves stored, env and default values across every key kind', () => {
    const dataPath = freshDataPath('all-config-projection');
    writeFixture(dataPath);
    setEnv(dataPath);

    const config = new ConfigService(dataPath);

    assert.deepStrictEqual(config.getAllConfig(), expected);
  });

  it('reports crashReportingEnabled false only when explicitly disabled', () => {
    const dataPath = freshDataPath('all-config-crash-off');
    writeFixture(dataPath, { crashReportingEnabled: false });
    setEnv(dataPath);

    const config = new ConfigService(dataPath);

    assert.deepStrictEqual(config.getAllConfig(), { ...expected, crashReportingEnabled: false });
  });
});

// #210: the settings form is prefilled from resolved values, so saving it back
// wholesale leaked env secrets and froze defaults into config.json. The
// renderer now diffs the save-time read against the prefill read; these tests
// drive that diff against the real ConfigService.
describe('ConfigService: settings save only persists edited fields', () => {
  // Stands in for the renderer's prefill-then-read. The diff only needs the
  // baseline and the save-time read to go through the same transform.
  function readSettingsForm(config: ConfigService): Record<string, unknown> {
    const all = config.getAllConfig() as Record<string, unknown>;
    return Object.fromEntries(
      CONFIG_KEY_DEFINITIONS.filter((row) => row.payload).map((row) => [row.key, all[row.key]]),
    );
  }

  function setSecretEnv(dataPath: string): void {
    process.env.GEMINI_API_KEY = 'env-gemini-key';
    process.env.OPENAI_API_KEY = 'env-openai-key';
    process.env.SONIOX_API_KEY = 'env-soniox-key';
    process.env.NOTION_API_KEY = 'env-notion-key';
    process.env.NOTION_DATABASE_ID = 'env-db';
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.example/env';
    process.env.LISTENER_AI_PROVIDER = 'chatgpt';
    process.env.LISTENER_CODEX_AUTH_PATH = path.join(dataPath, 'no-such-codex-auth.json');
  }

  it('leaves config.json byte-identical on a no-op save', () => {
    const dataPath = freshDataPath('settings-save-noop');
    setSecretEnv(dataPath);
    const configPath = path.join(dataPath, 'config.json');
    // Hand-formatted legacy-style file: any rewrite would change its bytes.
    fs.writeFileSync(
      configPath,
      '{"globalShortcut":"Alt+R","knownWords":["alpha"],"autoMode":true,' +
        '"codexTranscriptionMigratedToDiarize":true,"summaryPromptMigratedToStructured":true}\n',
    );
    const before = fs.readFileSync(configPath);

    const config = new ConfigService(dataPath);
    const baseline = readSettingsForm(config);
    config.updateConfig(diffConfigPayload(baseline, readSettingsForm(config)));

    assert.deepEqual(fs.readFileSync(configPath), before);
  });

  it('does not rewrite config.json for an empty update', () => {
    const dataPath = freshDataPath('settings-save-empty-update');
    const config = new ConfigService(dataPath);
    const configPath = config.getConfigPath();
    fs.writeFileSync(configPath, '{ "autoMode": true }');

    config.updateConfig({});

    assert.equal(fs.readFileSync(configPath, 'utf-8'), '{ "autoMode": true }');
  });

  it('keeps env secrets and resolved defaults off disk when another field changes', () => {
    const dataPath = freshDataPath('settings-save-env-secrets');
    setSecretEnv(dataPath);
    const config = new ConfigService(dataPath);
    const markers = JSON.parse(fs.readFileSync(config.getConfigPath(), 'utf-8'));

    const baseline = readSettingsForm(config);
    // The form shows the env values, so a leak would be visible here.
    assert.equal(baseline.geminiApiKey, 'env-gemini-key');
    assert.equal(baseline.aiProvider, 'chatgpt');
    config.updateConfig(diffConfigPayload(baseline, { ...baseline, autoMode: true }));

    const disk = JSON.parse(fs.readFileSync(config.getConfigPath(), 'utf-8'));
    assert.deepEqual(disk, { ...markers, autoMode: true });
    // Env fallbacks still resolve at runtime.
    assert.equal(config.getGeminiApiKey(), 'env-gemini-key');
    assert.equal(config.getNotionApiKey(), 'env-notion-key');
    assert.equal(config.getSlackWebhookUrl(), 'https://hooks.example/env');
    assert.equal(config.getAiProvider(), 'chatgpt');
  });

  it('persists explicit edits and leaves untouched stored values alone', () => {
    const dataPath = freshDataPath('settings-save-explicit');
    setSecretEnv(dataPath);
    delete process.env.LISTENER_AI_PROVIDER;
    fs.writeFileSync(
      path.join(dataPath, 'config.json'),
      JSON.stringify({
        aiProvider: 'gemini',
        notionDatabaseId: 'stored-db',
        globalShortcut: 'Alt+R',
        geminiThinkingLevel: 'high',
        knownWords: ['alpha'],
      }),
    );
    const config = new ConfigService(dataPath);

    const baseline = readSettingsForm(config);
    config.updateConfig(
      diffConfigPayload(baseline, {
        ...baseline,
        geminiApiKey: 'typed-key',
        // Explicitly picking the default value still counts as an edit.
        geminiThinkingLevel: 'medium',
        knownWords: ['alpha', 'beta'],
      }),
    );

    const disk = JSON.parse(fs.readFileSync(config.getConfigPath(), 'utf-8'));
    assert.equal(disk.geminiApiKey, 'typed-key');
    assert.equal(disk.geminiThinkingLevel, 'medium');
    assert.deepEqual(disk.knownWords, ['alpha', 'beta']);
    assert.equal(disk.aiProvider, 'gemini');
    assert.equal(disk.notionDatabaseId, 'stored-db');
    assert.equal(disk.globalShortcut, 'Alt+R');
    for (const key of [
      'notionApiKey',
      'slackWebhookUrl',
      'openaiApiKey',
      'sonioxApiKey',
      'liveSttProvider',
      'transcriptionProvider',
      'liveTranslationLanguage',
      'crashReportingEnabled',
      'maxRecordingMinutes',
      'geminiModel',
      'summaryPrompt',
    ]) {
      assert.equal(key in disk, false, `${key} should not be persisted`);
    }
  });
});

describe('ConfigService: chunked live captions gate', () => {
  it('needs only the batch STT backend when translation is off', () => {
    // Signed-out ChatGPT plus an explicit OpenAI backend: captions can run,
    // translating them cannot.
    const cfg = new ConfigService(freshDataPath('chunked-transcription-only'));
    cfg.setAiProvider('chatgpt');
    cfg.setTranscriptionProvider('openai');
    cfg.setOpenAiApiKey('sk-openai');
    assert.equal(cfg.hasAiAuth(), false);
    assert.equal(cfg.getChunkedLiveCaptionsBlocker(false), null);
    assert.equal(cfg.getChunkedLiveCaptionsBlocker(true), 'ai');
  });

  it('follows the ChatGPT status projection, so a sign-in or sign-out counts', () => {
    const cfg = new ConfigService(freshDataPath('chunked-chatgpt-status'));
    cfg.setAiProvider('chatgpt');
    cfg.setTranscriptionProvider('openai');
    cfg.setOpenAiApiKey('sk-openai');
    cfg.setChatGPTStatus({ connected: true, planEnabled: true, profileId: 'p1' });
    assert.equal(cfg.getChunkedLiveCaptionsBlocker(true), null);
    cfg.setChatGPTStatus({ connected: false, planEnabled: false });
    assert.equal(cfg.getChunkedLiveCaptionsBlocker(true), 'ai');
  });

  it('blocks on an unresolvable or uncredentialed backend with an actionable message', () => {
    const chatgptAuto = new ConfigService(freshDataPath('chunked-chatgpt-auto'));
    chatgptAuto.setAiProvider('chatgpt');
    chatgptAuto.setChatGPTStatus({ connected: true, planEnabled: true, profileId: 'p1' });
    assert.equal(chatgptAuto.getChunkedLiveCaptionsBlocker(false), 'transcription');
    assert.equal(
      chatgptAuto.describeMissingTranscriptionAuth(),
      chatgptAuto.getTranscriptionResolution().message,
    );

    const missingKey = new ConfigService(freshDataPath('chunked-missing-openai-key'));
    missingKey.setTranscriptionProvider('openai');
    assert.equal(missingKey.getChunkedLiveCaptionsBlocker(false), 'transcription');
    assert.equal(
      missingKey.describeMissingTranscriptionAuth(),
      'Add the OpenAI API key for transcription.',
    );
  });
});
