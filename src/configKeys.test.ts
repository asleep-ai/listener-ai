// Agreement tests for the config key registry. The six lists that used to be
// hand-maintained (`AppConfig`, `getAllConfig`, `KNOWN_CONFIG_KEYS`,
// `READABLE_CONFIG_KEYS`, `WRITABLE_CONFIG_KEYS`, `ConfigPayload`) are now
// derived from `configKeys.ts`. The type-level assertions below pin the key
// sets against each other; the runtime pins hold the exact arrays -- including
// their order, which `config list` prints and which is inlined verbatim into
// the agent's model-facing tool descriptions.
//
// `pnpm test` runs `tsc` first, so a broken type-level assertion fails the
// suite before any test executes.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  READABLE_CONFIG_KEYS,
  WRITABLE_CONFIG_KEYS,
  type WritableConfigKey,
  coerceConfigValue,
} from './agentService';
import { KNOWN_CONFIG_KEYS, SECRET_CONFIG_KEYS } from './configKeys';
import type { AppConfig } from './configService';
import type { ConfigPayload } from './electronApiTypes';
import type { ElectronAPI } from './preload';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type Expect<T extends true> = T;

// Documented exclusion set 1: `AppConfig` keys that deliberately never reach
// the renderer payload. The two OAuth blobs are credential objects that must
// not leave the main process; the three `*Configured` / `*Source` fields are
// derived read-only outputs (they live in `getAllConfig`, not in a save
// payload); `lastSeenVersion` is app-managed by releaseNotesService; the two
// migration markers are internal idempotency flags.
type NonPayloadKeys =
  | 'codexOAuth'
  | 'googleOAuth'
  | 'codexOAuthConfigured'
  | 'codexOAuthSource'
  | 'googleOAuthConfigured'
  | 'lastSeenVersion'
  | 'codexTranscriptionMigratedToDiarize'
  | 'summaryPromptMigratedToStructured';

// Documented exclusion set 2: `AppConfig` keys the CLI does not accept.
// `defaultSummaryPrompt` is a read-only renderer field and `audioDeviceId` is
// written by the renderer mic selector only.
//
// KNOWN GAP (do not fix here): `crashReportingEnabled` and `googleDriveEnabled`
// are ordinary user-facing scalars exposed in the settings UI, yet the CLI has
// never accepted them. Adding them would be a CLI behaviour change, so the
// registry records `cli: false` for both and this exclusion set makes the gap
// visible as data. Tracked as a follow-up.
type NonCliKeys =
  | NonPayloadKeys
  | 'defaultSummaryPrompt'
  | 'audioDeviceId'
  | 'crashReportingEnabled'
  | 'googleDriveEnabled';

// 1. The preload `saveConfig` parameter is the renderer's only write surface;
//    it must be exactly `ConfigPayload`.
export type AssertPayloadMatchesPreload = Expect<
  Equal<keyof ConfigPayload, keyof Parameters<ElectronAPI['saveConfig']>[0]>
>;

// 2. The payload is `AppConfig` minus the non-payload keys -- no config key can
//    be added without deciding whether the renderer sees it.
export type AssertPayloadMatchesAppConfig = Expect<
  Equal<keyof ConfigPayload, Exclude<keyof AppConfig, NonPayloadKeys>>
>;

// 3. Same guarantee for the CLI surface.
export type AssertKnownKeysMatchAppConfig = Expect<
  Equal<(typeof KNOWN_CONFIG_KEYS)[number], Exclude<keyof AppConfig, NonCliKeys>>
>;

// Literal copies of the three lists as they stood before the registry existed.
// These are the regression guard for the derivation: the derived arrays must
// still contain the same keys in the same order.
const TODAY_KNOWN_CONFIG_KEYS = [
  'aiProvider',
  'transcriptionProvider',
  'geminiApiKey',
  'geminiModel',
  'geminiFlashModel',
  'geminiThinkingLevel',
  'codexModel',
  'codexTranscriptionModel',
  'liveSttProvider',
  'openaiApiKey',
  'sonioxApiKey',
  'openaiLiveTranscriptionModel',
  'openaiLiveTranslationModel',
  'liveSttLanguage',
  'liveTranslationLanguage',
  'notionApiKey',
  'notionDatabaseId',
  'autoMode',
  'meetingDetection',
  'displayDetection',
  'globalShortcut',
  'knownWords',
  'summaryPrompt',
  'maxRecordingMinutes',
  'recordingReminderMinutes',
  'minRecordingSeconds',
  'recordSystemAudio',
  'slackWebhookUrl',
  'slackAutoShare',
];

const TODAY_WRITABLE_CONFIG_KEYS = [
  'autoMode',
  'meetingDetection',
  'displayDetection',
  'globalShortcut',
  'maxRecordingMinutes',
  'recordingReminderMinutes',
  'minRecordingSeconds',
  'recordSystemAudio',
  'liveSttProvider',
  'liveSttLanguage',
  'liveTranslationLanguage',
  'transcriptionProvider',
];

const TODAY_READABLE_CONFIG_KEYS = [
  ...TODAY_WRITABLE_CONFIG_KEYS,
  'aiProvider',
  'geminiModel',
  'geminiFlashModel',
  'codexModel',
  'codexTranscriptionModel',
  'openaiLiveTranscriptionModel',
  'openaiLiveTranslationModel',
];

describe('config key registry', () => {
  it('derives KNOWN_CONFIG_KEYS in the order `config list` prints', () => {
    assert.deepStrictEqual([...KNOWN_CONFIG_KEYS], TODAY_KNOWN_CONFIG_KEYS);
  });

  it('derives the agent whitelists in the order the tool descriptions inline', () => {
    assert.deepStrictEqual([...WRITABLE_CONFIG_KEYS], TODAY_WRITABLE_CONFIG_KEYS);
    assert.deepStrictEqual([...READABLE_CONFIG_KEYS], TODAY_READABLE_CONFIG_KEYS);
  });

  it('keeps the agent whitelists nested inside the CLI surface', () => {
    const readable = READABLE_CONFIG_KEYS as readonly string[];
    const known = KNOWN_CONFIG_KEYS as readonly string[];
    for (const key of WRITABLE_CONFIG_KEYS) {
      assert.ok(readable.includes(key), `${key} is writable but not readable`);
    }
    for (const key of READABLE_CONFIG_KEYS) {
      assert.ok(known.includes(key), `${key} is agent-readable but not a CLI key`);
    }
  });

  it('never exposes a secret key to the agent', () => {
    const readable = READABLE_CONFIG_KEYS as readonly string[];
    assert.ok(SECRET_CONFIG_KEYS.length > 0, 'registry must mark some keys secret');
    for (const key of SECRET_CONFIG_KEYS) {
      assert.equal(readable.includes(key), false, `${key} must not be agent-readable`);
    }
  });

  // The old `coerceConfigValue` was an exhaustive switch over
  // `WritableConfigKey`, so the compiler guaranteed every writable key had a
  // rule. The table lookup that replaced it cannot, so assert it at runtime: a
  // key with no coercion rule would fall through and accept anything.
  it('coerces every agent-writable key', () => {
    for (const key of WRITABLE_CONFIG_KEYS) {
      const result = coerceConfigValue(key as WritableConfigKey, {});
      assert.equal(result.ok, false, `${key} accepted a plain object`);
    }
  });
});
