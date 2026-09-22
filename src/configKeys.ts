// Single source of truth for the scalar Listener.AI config keys. Everything
// that used to be a hand-maintained list -- the `AppConfig` shape, the
// `getAllConfig()` projection, the CLI's `KNOWN_CONFIG_KEYS`, the agent's
// readable/writable whitelists, the renderer's `ConfigPayload` -- is derived
// from the one table below, so a new key cannot be added to some surfaces and
// silently forgotten on the others.
//
// The table encodes today's behaviour exactly, including the places where the
// surfaces deliberately disagree (see `cli`, `envSurfaced` and `secret`).
//
// Non-scalar and derived keys (`codexOAuth`, `googleOAuth`, the `*Configured`
// / `*Source` read-only fields, `defaultSummaryPrompt`, and the two migration
// markers) are NOT rows here; `configService.ts` declares them by hand.
//
// This module must stay importable from the renderer: no node builtins, no
// Electron, no runtime dependency beyond `./aiProvider`.

import {
  AI_PROVIDERS,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_TRANSCRIPTION_MODEL,
  DEFAULT_GEMINI_FLASH_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_THINKING_LEVEL,
  DEFAULT_LIVE_STT_PROVIDER,
  DEFAULT_OPENAI_LIVE_TRANSCRIPTION_MODEL,
  DEFAULT_OPENAI_LIVE_TRANSLATION_MODEL,
  DEFAULT_TRANSCRIPTION_PROVIDER,
  GEMINI_THINKING_LEVELS,
  LIVE_STT_PROVIDERS,
  TRANSCRIPTION_PROVIDERS,
} from './aiProvider';

export const DEFAULT_GLOBAL_SHORTCUT = 'CommandOrControl+Shift+L';
export const DEFAULT_LIVE_TRANSLATION_LANGUAGE = 'ko';

/**
 * Value domain of a key. Drives the TypeScript type, the CLI `config set`
 * parser and the agent's `set_config` coercion.
 * A `string[]` key has an implicit default of `[]`.
 */
export type ConfigKeyKind = 'string' | 'bool' | 'int' | 'enum' | 'string[]';

/**
 * How the agent coerces a writable string key. The three rules genuinely
 * differ per key and the CLI applies none of them, so they are recorded rather
 * than unified.
 */
export type AgentStringRule = 'trim' | 'trimOrDefault' | 'nonEmpty';

export interface ConfigKeyDefinition {
  readonly key: string;
  readonly kind: ConfigKeyKind;
  /** Allowed values for an `enum` key. Doubles as the source of its TS type. */
  readonly values?: readonly string[];
  /** Value the getters fall back to. Absent means "no default". */
  readonly default?: string | number | boolean;
  /** Environment variable consulted when the stored value is empty. */
  readonly envVar?: string;
  /**
   * `false` means `getAllConfig()` reports the STORED value only. Used by
   * `openaiApiKey` / `sonioxApiKey`: the settings form round-trips whatever it
   * receives, so surfacing an env-only key there would persist it to disk.
   */
  readonly envSurfaced?: boolean;
  /** Masked by `listener config list`. */
  readonly secret?: boolean;
  /** Accepted by `listener config get|set|unset`. */
  readonly cli?: boolean;
  /**
   * `config set` trims and lowercases an `enum` value before matching. Only
   * the two keys whose CLI branch went through a `normalize*` helper do this;
   * `aiProvider` and `transcriptionProvider` stay case-sensitive.
   */
  readonly cliNormalizesCase?: boolean;
  /** Overrides the generated `<key> must be one of: ...` CLI error text. */
  readonly cliEnumMessage?: string;
  /** Agent access level. `write` implies `read`. */
  readonly agent?: 'read' | 'write';
  /**
   * Position in `WRITABLE_CONFIG_KEYS`. That array is inlined verbatim into
   * the model-facing `set_config` tool description, so its order is part of
   * the prompt surface and does not follow the table order.
   */
  readonly agentOrder?: number;
  /** Coercion rule for an agent-writable `string` key. */
  readonly agentStringRule?: AgentStringRule;
  /** Part of the renderer `ConfigPayload`. */
  readonly payload?: boolean;
  /**
   * The resolved read has logic the table cannot express (env precedence,
   * normalize-or-default, trimming). `configService.ts` supplies a
   * hand-written getter and the generic reader refuses these keys.
   */
  readonly customRead?: boolean;
}

// Row order is load-bearing: filtering by `cli` must reproduce the exact order
// `listener config list` prints, and filtering by `agent: 'read'` must
// reproduce the tail of `READABLE_CONFIG_KEYS`.
export const CONFIG_KEYS = [
  {
    key: 'aiProvider',
    kind: 'enum',
    values: AI_PROVIDERS,
    // No `default`: the resolved value depends on the LISTENER_AI_PROVIDER env
    // override (which WINS over the stored value, the inverse of the generic
    // env fallback) and on whether Codex OAuth is present. See getAiProvider().
    customRead: true,
    cliEnumMessage: 'aiProvider must be "gemini" or "codex"',
    cli: true,
    agent: 'read',
    payload: true,
  },
  {
    // Batch (file) speech-to-text backend. `auto` follows `aiProvider`;
    // summary, judge and agent calls stay on `aiProvider` whatever this says.
    key: 'transcriptionProvider',
    kind: 'enum',
    values: TRANSCRIPTION_PROVIDERS,
    default: DEFAULT_TRANSCRIPTION_PROVIDER,
    customRead: true,
    cli: true,
    agent: 'write',
    agentOrder: 12,
    payload: true,
  },
  {
    key: 'geminiApiKey',
    kind: 'string',
    envVar: 'GEMINI_API_KEY',
    secret: true,
    cli: true,
    payload: true,
  },
  {
    key: 'geminiModel',
    kind: 'string',
    default: DEFAULT_GEMINI_MODEL,
    cli: true,
    agent: 'read',
    payload: true,
  },
  {
    key: 'geminiFlashModel',
    kind: 'string',
    default: DEFAULT_GEMINI_FLASH_MODEL,
    cli: true,
    agent: 'read',
    payload: true,
  },
  {
    key: 'geminiThinkingLevel',
    kind: 'enum',
    values: GEMINI_THINKING_LEVELS,
    default: DEFAULT_GEMINI_THINKING_LEVEL,
    customRead: true,
    cliNormalizesCase: true,
    cli: true,
    payload: true,
  },
  {
    key: 'codexModel',
    kind: 'string',
    default: DEFAULT_CODEX_MODEL,
    cli: true,
    agent: 'read',
    payload: true,
  },
  {
    key: 'codexTranscriptionModel',
    kind: 'string',
    default: DEFAULT_CODEX_TRANSCRIPTION_MODEL,
    cli: true,
    agent: 'read',
    payload: true,
  },
  {
    key: 'liveSttProvider',
    kind: 'enum',
    values: LIVE_STT_PROVIDERS,
    default: DEFAULT_LIVE_STT_PROVIDER,
    customRead: true,
    cliNormalizesCase: true,
    cli: true,
    agent: 'write',
    agentOrder: 9,
    payload: true,
  },
  {
    key: 'openaiApiKey',
    kind: 'string',
    envVar: 'OPENAI_API_KEY',
    envSurfaced: false,
    secret: true,
    cli: true,
    payload: true,
  },
  {
    key: 'sonioxApiKey',
    kind: 'string',
    envVar: 'SONIOX_API_KEY',
    envSurfaced: false,
    secret: true,
    cli: true,
    payload: true,
  },
  {
    key: 'openaiLiveTranscriptionModel',
    kind: 'string',
    default: DEFAULT_OPENAI_LIVE_TRANSCRIPTION_MODEL,
    cli: true,
    agent: 'read',
    payload: true,
  },
  {
    key: 'openaiLiveTranslationModel',
    kind: 'string',
    default: DEFAULT_OPENAI_LIVE_TRANSLATION_MODEL,
    cli: true,
    agent: 'read',
    payload: true,
  },
  {
    key: 'liveSttLanguage',
    kind: 'string',
    // Trimmed, and an all-whitespace value reads back as undefined.
    customRead: true,
    cli: true,
    agent: 'write',
    agentOrder: 10,
    agentStringRule: 'trim',
    payload: true,
  },
  {
    key: 'liveTranslationLanguage',
    kind: 'string',
    default: DEFAULT_LIVE_TRANSLATION_LANGUAGE,
    customRead: true,
    cli: true,
    agent: 'write',
    agentOrder: 11,
    agentStringRule: 'trimOrDefault',
    payload: true,
  },
  {
    // When true, the app periodically syncs transcription folders to Drive
    // (and auto-syncs after each new transcription completes). When false,
    // sync only runs on explicit user trigger (CLI or "Sync now" button).
    key: 'googleDriveEnabled',
    kind: 'bool',
    default: false,
    payload: true,
  },
  {
    key: 'notionApiKey',
    kind: 'string',
    envVar: 'NOTION_API_KEY',
    secret: true,
    cli: true,
    payload: true,
  },
  {
    key: 'notionDatabaseId',
    kind: 'string',
    envVar: 'NOTION_DATABASE_ID',
    // Deliberately not secret: `config list` has always printed it in full.
    cli: true,
    payload: true,
  },
  {
    key: 'autoMode',
    kind: 'bool',
    default: false,
    cli: true,
    agent: 'write',
    agentOrder: 1,
    payload: true,
  },
  {
    key: 'meetingDetection',
    kind: 'bool',
    default: false,
    cli: true,
    agent: 'write',
    agentOrder: 2,
    payload: true,
  },
  {
    key: 'displayDetection',
    kind: 'bool',
    default: false,
    cli: true,
    agent: 'write',
    agentOrder: 3,
    payload: true,
  },
  {
    key: 'globalShortcut',
    kind: 'string',
    default: DEFAULT_GLOBAL_SHORTCUT,
    cli: true,
    agent: 'write',
    agentOrder: 4,
    // The default is NOT an agent fallback: an empty value is rejected.
    agentStringRule: 'nonEmpty',
    payload: true,
  },
  {
    key: 'knownWords',
    kind: 'string[]',
    cli: true,
    payload: true,
  },
  {
    key: 'summaryPrompt',
    kind: 'string',
    // Defaults to DEFAULT_SUMMARY_PROMPT, which lives in configService.ts
    // (importing it here would be circular) and is elided on write.
    customRead: true,
    cli: true,
    payload: true,
  },
  {
    key: 'maxRecordingMinutes',
    kind: 'int',
    default: 0,
    cli: true,
    agent: 'write',
    agentOrder: 5,
    payload: true,
  },
  {
    key: 'recordingReminderMinutes',
    kind: 'int',
    default: 0,
    cli: true,
    agent: 'write',
    agentOrder: 6,
    payload: true,
  },
  {
    key: 'minRecordingSeconds',
    kind: 'int',
    default: 0,
    cli: true,
    agent: 'write',
    agentOrder: 7,
    payload: true,
  },
  {
    key: 'recordSystemAudio',
    kind: 'bool',
    default: false,
    cli: true,
    agent: 'write',
    agentOrder: 8,
    payload: true,
  },
  {
    // Crash/error reporting to Sentry, and never agent-writable.
    key: 'crashReportingEnabled',
    kind: 'bool',
    // Opt-out: absence means ON, only an explicit `false` disables reporting.
    default: true,
    // KNOWN GAP: settings-UI togglable but never CLI-accepted. Adding it would
    // be a CLI behaviour change; recorded as data, tracked as a follow-up.
    payload: true,
  },
  {
    key: 'audioDeviceId',
    kind: 'string',
    // Neither env fallback nor default: the stored value is returned verbatim.
    payload: true,
  },
  {
    key: 'lastSeenVersion',
    kind: 'string',
    // App-managed by releaseNotesService; no CLI and no renderer payload.
  },
  {
    key: 'slackWebhookUrl',
    kind: 'string',
    envVar: 'SLACK_WEBHOOK_URL',
    secret: true,
    cli: true,
    payload: true,
  },
  {
    key: 'slackAutoShare',
    kind: 'bool',
    default: false,
    cli: true,
    payload: true,
  },
] as const satisfies readonly ConfigKeyDefinition[];

export type ConfigRow = (typeof CONFIG_KEYS)[number];
export type ConfigKeyName = ConfigRow['key'];

type RowFor<K extends ConfigKeyName> = Extract<ConfigRow, { key: K }>;

type ValueForRow<R> = R extends { kind: 'enum'; values: readonly (infer V)[] }
  ? V
  : R extends { kind: 'bool' }
    ? boolean
    : R extends { kind: 'int' }
      ? number
      : R extends { kind: 'string[]' }
        ? string[]
        : string;

/** The TypeScript type stored under `key`. */
export type ConfigValueFor<K extends ConfigKeyName> = ValueForRow<RowFor<K>>;

/** An all-optional object over a subset of the table's keys. */
export type ConfigValues<K extends ConfigKeyName = ConfigKeyName> = {
  [P in K]?: ConfigValueFor<P>;
};

/** Keys the generic reader handles; the rest have hand-written getters. */
export type GenericReadConfigKey = Exclude<
  ConfigKeyName,
  Extract<ConfigRow, { customRead: true }>['key']
>;

/** What a generic read resolves to: defaulted keys never read back undefined. */
export type ConfigReadResult<K extends GenericReadConfigKey> =
  RowFor<K> extends {
    default: unknown;
  }
    ? ConfigValueFor<K>
    : RowFor<K> extends { kind: 'string[]' }
      ? ConfigValueFor<K>
      : ConfigValueFor<K> | undefined;

export type CliConfigKey = Extract<ConfigRow, { cli: true }>['key'];
export type AgentWritableConfigKey = Extract<ConfigRow, { agent: 'write' }>['key'];
export type AgentReadableConfigKey = Extract<ConfigRow, { agent: 'read' | 'write' }>['key'];
export type PayloadConfigKey = Extract<ConfigRow, { payload: true }>['key'];

/** Loosely typed view of the table, for the runtime lookups below. */
export const CONFIG_KEY_DEFINITIONS: readonly ConfigKeyDefinition[] = CONFIG_KEYS;

export const CONFIG_KEY_BY_NAME: Readonly<Record<string, ConfigKeyDefinition>> = Object.fromEntries(
  CONFIG_KEY_DEFINITIONS.map((row) => [row.key, row]),
);

/** CLI surface, in the order `listener config list` prints. */
export const KNOWN_CONFIG_KEYS: readonly CliConfigKey[] = CONFIG_KEY_DEFINITIONS.filter(
  (row) => row.cli,
).map((row) => row.key) as CliConfigKey[];

/** Keys `listener config list` masks. */
export const SECRET_CONFIG_KEYS: readonly ConfigKeyName[] = CONFIG_KEY_DEFINITIONS.filter(
  (row) => row.secret,
).map((row) => row.key) as ConfigKeyName[];

/** Agent `set_config` whitelist, ordered as the tool description inlines it. */
export const AGENT_WRITABLE_CONFIG_KEYS: readonly AgentWritableConfigKey[] =
  CONFIG_KEY_DEFINITIONS.filter((row) => row.agent === 'write')
    .sort((a, b) => (a.agentOrder ?? 0) - (b.agentOrder ?? 0))
    .map((row) => row.key) as AgentWritableConfigKey[];

/** Agent `get_config` whitelist: the writable keys first, then read-only ones. */
export const AGENT_READABLE_CONFIG_KEYS: readonly AgentReadableConfigKey[] = [
  ...AGENT_WRITABLE_CONFIG_KEYS,
  ...(CONFIG_KEY_DEFINITIONS.filter((row) => row.agent === 'read').map(
    (row) => row.key,
  ) as AgentReadableConfigKey[]),
];
