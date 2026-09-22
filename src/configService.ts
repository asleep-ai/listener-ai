import * as fs from 'fs';
import * as path from 'path';
import {
  DEFAULT_GEMINI_THINKING_LEVEL,
  DEFAULT_LIVE_STT_PROVIDER,
  type AiProvider,
  type BatchSttProvider,
  type GeminiThinkingLevel,
  type LiveSttProvider,
  type TranscriptionProvider,
  isTranscriptionProvider,
  normalizeAiProvider,
  normalizeGeminiThinkingLevel,
  normalizeLiveSttProvider,
  normalizeTranscriptionProvider,
  resolveBatchSttProvider,
} from './aiProvider';
import {
  type CodexOAuthCredentialSource,
  type CodexOAuthCredentials,
  getCodexOAuthCliCredentials,
  getCodexOAuthEnvCredentials,
} from './codexOAuth';
import {
  CONFIG_KEY_BY_NAME,
  CONFIG_KEY_DEFINITIONS,
  DEFAULT_LIVE_TRANSLATION_LANGUAGE,
  type ConfigKeyName,
  type ConfigReadResult,
  type ConfigValues,
  type GenericReadConfigKey,
} from './configKeys';
import {
  type GoogleOAuthCredentials,
  getGoogleOAuthEnvCredentials,
  hasGoogleOAuthEnvCredentials,
} from './googleOAuth';

// Keys that are not scalar registry rows: the two OAuth credential blobs, the
// read-only fields `getAllConfig()` derives, and the migration markers.
interface AppConfigExtras {
  codexOAuth?: CodexOAuthCredentials;
  codexOAuthConfigured?: boolean;
  codexOAuthSource?: CodexOAuthCredentialSource['source'];
  googleOAuth?: GoogleOAuthCredentials;
  googleOAuthConfigured?: boolean;
  // Read-only renderer payload field. It is never persisted by updateConfig.
  defaultSummaryPrompt?: string;
  // Idempotency marker for `migrateLegacyDefaults` -- once set we never
  // re-run the migration, so a user who deliberately re-selects the old
  // model after upgrade keeps their choice.
  codexTranscriptionMigratedToDiarize?: boolean;
  summaryPromptMigratedToStructured?: boolean;
}

type AppConfigShape = ConfigValues & AppConfigExtras;

// Flattened so `keyof AppConfig` stays a plain union of string literals and
// every property stays optional -- consumers only use `Partial<AppConfig>` and
// `keyof AppConfig`, both of which depend on that.
export type AppConfig = { [K in keyof AppConfigShape]?: AppConfigShape[K] };

// What the user has to go configure, named per provider. Keyed by
// `BatchSttProvider` (a superset of `AiProvider`) so both credential gates
// share one vocabulary and a new backend fails to compile until it says what
// its credential is called.
const CREDENTIAL_LABELS: Record<BatchSttProvider, string> = {
  gemini: 'Gemini API Key',
  codex: 'Codex OAuth sign-in',
  soniox: 'Soniox API key',
};

function credentialLabelFor(provider: BatchSttProvider): string {
  return CREDENTIAL_LABELS[provider];
}

const LEGACY_DEFAULT_SUMMARY_PROMPT = `Based on this meeting transcript, provide:

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

export const DEFAULT_SUMMARY_PROMPT = `Create a decision-useful shared meeting record from the full transcript in the meeting's primary language. Do not rely on a thin or pre-generated summary.

Grounding rules:
- Preserve important operational and commercial detail when present, including the current model, proposed end-to-end flow, participant roles, commercial terms, supply, billing, settlement, cancellation, refunds, rollout channels, channel ownership, account conflicts, risks, pilot scope, sequencing, success conditions, commitments, deadlines, and decision owners.
- Include names, numbers, owners, and deadlines only when the transcript clearly supports them. Omit or qualify uncertain details instead of guessing.
- Distinguish confirmed decisions and commitments from proposals, exploratory discussion, risks, and unresolved questions.
- Keep the transcript's hedge when a date, amount, count, or decision status is hedged (a range, "around", "or", "maybe", "not final yet"). Never resolve a hedged value to a single number or date, and never report a provisional pick as a final decision.
- Never invent an English, romanized, or corrected spelling for a garbled or uncertain name, product, or term. Use the transcript's own form or omit the term.

Meeting summary rules:
- Organize the summary by the meeting's actual major agendas; do not force irrelevant categories.
- Use concise but sufficiently detailed bullets under each agenda heading.
- For a substantive multi-agenda meeting, aim for 4-7 sections with 3-6 bullets each. Shorten when the meeting itself is simple.

Action item rules:
- Include an action only when the transcript contains an explicit assignment, accepted request, or first-person commitment to concrete future work. A decision about desired system behavior is not itself an action item.
- Use a named person, company, or team as the owner only when the transcript explicitly establishes that ownership. Do not infer ownership from the topic, expertise, or apparent role. Never use transcript placeholders such as "Speaker 2", "Participant 5", or "참가자 2" as owners, and never infer a person's identity or role from a placeholder.
- Group confirmed actions by owner and put each action under exactly one primary owner. Create a joint group only when shared ownership is explicit; do not duplicate jointly owned work under individual owners.
- Arrange related actions in practical execution order and include the deliverable, dependency, and timing when explicitly discussed.
- Keep unresolved issues in the summary unless the transcript explicitly creates a follow-up action. Never invent documentation, issue filing, review, alignment, or implementation work merely because it would be useful.
- Exclude work the transcript describes as already completed. Action items cover pending future work only.
- Use "Unassigned" in the primary language only when concrete future work is explicit but its owner is not. If there are no grounded action items, return actionItemGroups as an empty array.

Also provide a concise meeting title, a short list of the most important key points without repeating every summary bullet, and an appropriate emoji.

Return JSON using this core structure (additional fields requested by appended instructions may be included):
{
  "suggestedTitle": "concise title",
  "summarySections": [
    {
      "heading": "agenda or topic",
      "bullets": ["Discussion: ...", "Decision: ..."]
    }
  ],
  "keyPoints": ["important point"],
  "actionItemGroups": [
    {
      "owner": "responsible company, team, or person",
      "items": ["action item"]
    }
  ],
  "emoji": "📝"
}`;

export class ConfigService {
  private configPath: string;
  private config: AppConfig = {};
  // Keys this process has explicitly modified since the last successful save.
  // saveConfig() re-reads the file on every write and applies only these keys on
  // top of disk state, so a concurrent process (Electron app + CLI hitting the
  // same config.json during OAuth refresh, etc.) cannot clobber unrelated keys.
  private dirtyKeys = new Set<keyof AppConfig>();
  private envProviderWarned = false;

  getConfigPath(): string {
    return this.configPath;
  }

  constructor(dataPath?: string) {
    let userDataPath: string;
    if (dataPath) {
      userDataPath = dataPath;
    } else {
      try {
        userDataPath = require('electron').app.getPath('userData');
      } catch {
        throw new Error('ConfigService requires dataPath when running outside Electron.');
      }
    }
    this.configPath = path.join(userDataPath, 'config.json');
    this.loadConfig();
    this.migrateLegacyDefaults();
  }

  // One-shot upgrade hook for keys that older versions auto-persisted from
  // their then-current default. The settings modal in those versions wrote
  // back the full payload on save -- including fields the user never
  // touched -- so the next default change can't reach existing installs.
  // Today's case: `codexTranscriptionModel: 'gpt-4o-transcribe'` was the
  // legacy default before gpt-4o-transcribe-diarize shipped; clearing it
  // here lets `getCodexTranscriptionModel()` return the current default
  // (diarize) without forcing every user to manually unset it.
  //
  // The marker semantics are "we've considered migrating this user" --
  // it lands on EVERY install on first launch, not just the ones we
  // actually had to migrate. That way if a user later opts back into
  // `gpt-4o-transcribe` deliberately (e.g. for glossary support), the
  // next ConfigService construction sees the marker and skips the
  // migration entirely instead of clobbering their explicit choice.
  private migrateLegacyDefaults(): void {
    if (!this.config.codexTranscriptionMigratedToDiarize) {
      if (this.config.codexTranscriptionModel === 'gpt-4o-transcribe') {
        this.setKey('codexTranscriptionModel', undefined);
      }
      this.setKey('codexTranscriptionMigratedToDiarize', true);
    }
    if (!this.config.summaryPromptMigratedToStructured) {
      if (this.config.summaryPrompt === LEGACY_DEFAULT_SUMMARY_PROMPT) {
        this.setKey('summaryPrompt', undefined);
      }
      this.setKey('summaryPromptMigratedToStructured', true);
    }
    if (this.dirtyKeys.size > 0) this.saveConfig();
  }

  private loadConfig(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, 'utf-8');
        this.config = JSON.parse(data);
      }
    } catch (error) {
      console.error('Error loading config:', error);
      this.config = {};
    }
  }

  private setKey<K extends keyof AppConfig>(key: K, value: AppConfig[K] | undefined): void {
    if (value === undefined) {
      delete this.config[key];
    } else {
      this.config[key] = value;
    }
    this.dirtyKeys.add(key);
  }

  private saveConfig(): void {
    try {
      fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
      let merged: AppConfig = {};
      if (fs.existsSync(this.configPath)) {
        try {
          merged = JSON.parse(fs.readFileSync(this.configPath, 'utf-8')) as AppConfig;
        } catch {
          // ignore corrupt disk file; treat as empty and let our writes recover it
        }
      }
      for (const key of this.dirtyKeys) {
        const value = this.config[key];
        if (value === undefined) {
          delete merged[key];
        } else {
          (merged as Record<string, unknown>)[key as string] = value;
        }
      }
      // 0o600 keeps API keys + OAuth refresh tokens off other users on shared
      // machines. writeFileSync's `mode` option only applies when the OS
      // creates the file -- existing config.json from prior versions keeps its
      // umask-derived mode (typically 0o644). Explicitly chmod after writing
      // so upgrade paths get tightened too. chmodSync is a no-op for the bits
      // that matter on Windows but doesn't throw, so the call is unconditional.
      fs.writeFileSync(this.configPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
      try {
        fs.chmodSync(this.configPath, 0o600);
      } catch (chmodError) {
        // Don't fail the save if chmod fails (e.g. exotic filesystem) -- the
        // write succeeded and the override above already covers fresh files.
        console.warn('Could not chmod config.json to 0o600:', chmodError);
      }
      this.config = merged;
      this.dirtyKeys.clear();
    } catch (error) {
      console.error('Error saving config:', error);
    }
  }

  // Generic resolved read for the registry keys whose getter is pure
  // stored/env/default coalescing. Keys with real logic (env precedence,
  // normalize-or-default, trimming) are excluded by `GenericReadConfigKey` and
  // keep their hand-written getters below.
  private read<K extends GenericReadConfigKey>(key: K): ConfigReadResult<K> {
    const row = CONFIG_KEY_BY_NAME[key];
    const stored = (this.config as Record<string, unknown>)[key];
    if (row.kind === 'string[]') {
      // Fresh array per call, so a caller mutating the result cannot reach the
      // stored config or a shared default.
      return ((stored as string[] | undefined) ?? []) as ConfigReadResult<K>;
    }
    if (row.kind !== 'string' && row.kind !== 'enum') {
      // Booleans and integers use `??`: only `crashReportingEnabled` (default
      // true) depends on it, but `?? false` / `?? 0` match the old `|| false` /
      // `|| 0` for anything JSON can store.
      return (stored ?? row.default) as ConfigReadResult<K>;
    }
    // Strings use `||`, so an empty stored value falls through to the env
    // fallback and then to the default -- as the original getters did.
    if (row.envVar === undefined && row.default === undefined) {
      // No `||` chain existed at all for these, so a stored '' stays ''.
      return stored as ConfigReadResult<K>;
    }
    const env = row.envVar !== undefined ? process.env[row.envVar] : undefined;
    if (row.default === undefined) return (stored || env) as ConfigReadResult<K>;
    return (stored || env || row.default) as ConfigReadResult<K>;
  }

  private write<K extends ConfigKeyName>(key: K, value: AppConfig[K]): void {
    this.setKey(key, value);
    this.saveConfig();
  }

  getGeminiApiKey(): string | undefined {
    return this.read('geminiApiKey');
  }

  setGeminiApiKey(apiKey: string): void {
    this.write('geminiApiKey', apiKey);
  }

  getAiProvider(): AiProvider {
    const envProvider = normalizeAiProvider(process.env.LISTENER_AI_PROVIDER);
    if (envProvider) {
      const configured = normalizeAiProvider(this.config.aiProvider);
      if (configured && configured !== envProvider && !this.envProviderWarned) {
        console.warn(
          `LISTENER_AI_PROVIDER=${envProvider} overrides configured aiProvider=${configured}.`,
        );
        this.envProviderWarned = true;
      }
      return envProvider;
    }

    const configured = normalizeAiProvider(this.config.aiProvider);
    if (configured) return configured;

    if (!this.getGeminiApiKey() && this.hasCodexOAuth()) return 'codex';
    return 'gemini';
  }

  setAiProvider(provider: AiProvider): void {
    this.write('aiProvider', provider);
  }

  getTranscriptionProvider(): TranscriptionProvider {
    return normalizeTranscriptionProvider(this.config.transcriptionProvider);
  }

  setTranscriptionProvider(provider: TranscriptionProvider): void {
    this.write('transcriptionProvider', provider);
  }

  // The backend a transcription actually runs on. `auto` follows the chat
  // provider so existing installs keep their behavior; everything else is an
  // explicit opt-in that leaves summary/judge/agent on `aiProvider`.
  resolveTranscriptionProvider(): BatchSttProvider {
    return resolveBatchSttProvider(this.getTranscriptionProvider(), this.getAiProvider());
  }

  // Returns the active OAuth credentials whether they came from config, env, or
  // the Codex CLI auth file. Preference is:
  //   1. Fresh config credentials (app sign-in)
  //   2. Fresh env credentials (ephemeral automation)
  //   3. Fresh Codex CLI credentials (~/.codex/auth.json, read-only fallback)
  //   4. Any stale source in the same order, so the refresh helper can still try
  //
  // The source distinction matters: only config-sourced refreshes may be
  // persisted back into config.json.
  getCodexOAuthSource(): CodexOAuthCredentialSource | undefined {
    const candidates: CodexOAuthCredentialSource[] = [];
    const config = this.config.codexOAuth;
    if (config?.access && config.refresh && Number.isFinite(config.expires)) {
      candidates.push({ source: 'config', credentials: config });
    }
    const env = getCodexOAuthEnvCredentials();
    if (env) candidates.push({ source: 'env', credentials: env });
    const cli = getCodexOAuthCliCredentials();
    if (cli) candidates.push({ source: 'codexCli', credentials: cli });
    if (candidates.length === 0) return undefined;
    return (
      candidates.find((candidate) => candidate.credentials.expires > Date.now()) ?? candidates[0]
    );
  }

  // Returns the active OAuth credentials whether they came from config, env, or
  // the Codex CLI auth file.
  // Callers that intend to PERSIST refreshed credentials must additionally check
  // `getCodexOAuthSource()?.source === 'config'` and skip the persistence
  // callback for env/CLI sources. Otherwise a normal token refresh writes
  // external credentials to plaintext app config.
  getCodexOAuth(): CodexOAuthCredentials | undefined {
    return this.getCodexOAuthSource()?.credentials;
  }

  // True only when credentials are stored in config.json. Env-only credentials
  // return false here. Use this to gate `onCodexOAuthUpdate` persistence callbacks.
  hasStoredCodexOAuth(): boolean {
    const c = this.config.codexOAuth;
    return !!(c?.access && c.refresh && Number.isFinite(c.expires));
  }

  setCodexOAuth(credentials: CodexOAuthCredentials): void {
    this.setKey('codexOAuth', credentials);
    this.saveConfig();
  }

  clearCodexOAuth(): void {
    this.setKey('codexOAuth', undefined);
    this.saveConfig();
  }

  hasCodexOAuth(): boolean {
    return !!this.getCodexOAuthSource();
  }

  // Mirrors the Codex OAuth surface. The stored-vs-env distinction matters
  // for the same reason: if credentials came from env, persisting refreshed
  // tokens would silently leak ephemeral env values into config.json. Callers
  // that handle refresh callbacks must gate persistence on hasStoredGoogleOAuth().
  getGoogleOAuth(): GoogleOAuthCredentials | undefined {
    return this.config.googleOAuth || getGoogleOAuthEnvCredentials();
  }

  hasStoredGoogleOAuth(): boolean {
    const c = this.config.googleOAuth;
    return !!(c?.access && c.refresh && Number.isFinite(c.expires));
  }

  setGoogleOAuth(credentials: GoogleOAuthCredentials): void {
    this.setKey('googleOAuth', credentials);
    this.saveConfig();
  }

  clearGoogleOAuth(): void {
    this.setKey('googleOAuth', undefined);
    this.saveConfig();
  }

  hasGoogleOAuth(): boolean {
    return hasGoogleOAuthEnvCredentials() || this.hasStoredGoogleOAuth();
  }

  getGoogleDriveEnabled(): boolean {
    return this.read('googleDriveEnabled');
  }

  setGoogleDriveEnabled(enabled: boolean): void {
    this.write('googleDriveEnabled', enabled);
  }

  // Summary, judge and agent auth. A Soniox key alone never satisfies this:
  // those calls always run on `aiProvider`.
  hasAiAuth(): boolean {
    const provider = this.getAiProvider();
    if (provider === 'codex') return this.hasCodexOAuth();
    return !!this.getGeminiApiKey();
  }

  // Credentials for the resolved batch transcription backend. Only diverges
  // from `hasAiAuth()` when `transcriptionProvider` points somewhere else.
  hasTranscriptionAuth(): boolean {
    const provider = this.resolveTranscriptionProvider();
    if (provider === 'soniox') return !!this.getSonioxApiKey();
    if (provider === 'codex') return this.hasCodexOAuth();
    return !!this.getGeminiApiKey();
  }

  getNotionApiKey(): string | undefined {
    return this.read('notionApiKey');
  }

  setNotionApiKey(apiKey: string): void {
    this.write('notionApiKey', apiKey);
  }

  getNotionDatabaseId(): string | undefined {
    return this.read('notionDatabaseId');
  }

  setNotionDatabaseId(databaseId: string): void {
    this.write('notionDatabaseId', databaseId);
  }

  // Everything an unattended end-to-end run (auto mode) needs. The
  // transcription backend is a separate gate from `hasAiAuth()`: with
  // `transcriptionProvider: soniox` and no Soniox key, the summary credentials
  // are fine and the run still cannot produce a transcript.
  hasRequiredConfig(): boolean {
    return (
      this.hasAiAuth() &&
      this.hasTranscriptionAuth() &&
      !!this.getNotionApiKey() &&
      !!this.getNotionDatabaseId()
    );
  }

  getMissingConfigs(): string[] {
    const missing: string[] = [];
    if (!this.hasAiAuth()) {
      missing.push(credentialLabelFor(this.getAiProvider()));
    }
    if (!this.hasTranscriptionAuth()) {
      // Deduped rather than suppressed: when both gates resolve to the same
      // provider one entry says it all, but a diverging backend has to be
      // named or the user fixes the chat key and hits the same wall.
      const label = credentialLabelFor(this.resolveTranscriptionProvider());
      if (!missing.includes(label)) missing.push(label);
    }
    if (!this.getNotionApiKey()) missing.push('Notion Integration Token');
    if (!this.getNotionDatabaseId()) missing.push('Notion Database ID');
    return missing;
  }

  getAutoMode(): boolean {
    return this.read('autoMode');
  }

  setAutoMode(enabled: boolean): void {
    this.write('autoMode', enabled);
  }

  getMeetingDetection(): boolean {
    return this.read('meetingDetection');
  }

  getDisplayDetection(): boolean {
    return this.read('displayDetection');
  }

  setDisplayDetection(enabled: boolean): void {
    this.write('displayDetection', enabled);
  }

  getGlobalShortcut(): string {
    return this.read('globalShortcut');
  }

  setGlobalShortcut(shortcut: string): void {
    this.write('globalShortcut', shortcut);
  }

  getKnownWords(): string[] {
    return this.read('knownWords');
  }

  setKnownWords(words: string[]): void {
    this.write('knownWords', words);
  }

  getGeminiModel(): string {
    return this.read('geminiModel');
  }

  setGeminiModel(model: string): void {
    this.write('geminiModel', model);
  }

  getGeminiFlashModel(): string {
    return this.read('geminiFlashModel');
  }

  setGeminiFlashModel(model: string): void {
    this.write('geminiFlashModel', model);
  }

  // Stored values from older clients that no longer match the allowed set
  // fall back to the default rather than throwing, so partial/legacy configs
  // stay loadable.
  getGeminiThinkingLevel(): GeminiThinkingLevel {
    return (
      normalizeGeminiThinkingLevel(this.config.geminiThinkingLevel) ?? DEFAULT_GEMINI_THINKING_LEVEL
    );
  }

  setGeminiThinkingLevel(level: GeminiThinkingLevel): void {
    this.write('geminiThinkingLevel', level);
  }

  getCodexModel(): string {
    return this.read('codexModel');
  }

  setCodexModel(model: string): void {
    this.write('codexModel', model);
  }

  getCodexTranscriptionModel(): string {
    return this.read('codexTranscriptionModel');
  }

  setCodexTranscriptionModel(model: string): void {
    this.write('codexTranscriptionModel', model);
  }

  getLiveSttProvider(): LiveSttProvider {
    return normalizeLiveSttProvider(this.config.liveSttProvider) ?? DEFAULT_LIVE_STT_PROVIDER;
  }

  setLiveSttProvider(provider: LiveSttProvider): void {
    this.write('liveSttProvider', provider);
  }

  getOpenAiApiKey(): string | undefined {
    return this.read('openaiApiKey');
  }

  setOpenAiApiKey(apiKey: string): void {
    this.write('openaiApiKey', apiKey);
  }

  getSonioxApiKey(): string | undefined {
    return this.read('sonioxApiKey');
  }

  setSonioxApiKey(apiKey: string): void {
    this.write('sonioxApiKey', apiKey);
  }

  getOpenAiLiveTranscriptionModel(): string {
    return this.read('openaiLiveTranscriptionModel');
  }

  getOpenAiLiveTranslationModel(): string {
    return this.read('openaiLiveTranslationModel');
  }

  getLiveSttLanguage(): string | undefined {
    return this.config.liveSttLanguage?.trim() || undefined;
  }

  getLiveTranslationLanguage(): string {
    return this.config.liveTranslationLanguage?.trim() || DEFAULT_LIVE_TRANSLATION_LANGUAGE;
  }

  hasStreamingLiveSttAuth(): boolean {
    const provider = this.getLiveSttProvider();
    const hasOpenAiRealtimeAuth = !!this.getOpenAiApiKey();
    if (provider === 'openai') return hasOpenAiRealtimeAuth;
    if (provider === 'gemini') return !!this.getGeminiApiKey();
    if (provider === 'soniox') return !!this.getSonioxApiKey();
    if (provider === 'chunked') return false;
    // `auto` deliberately ignores the Soniox key: Soniox stays explicit-only
    // until the evaluation passes and a release has soaked.
    return hasOpenAiRealtimeAuth || !!this.getGeminiApiKey();
  }

  getMaxRecordingMinutes(): number {
    return this.read('maxRecordingMinutes');
  }

  setMaxRecordingMinutes(minutes: number): void {
    this.write('maxRecordingMinutes', Math.max(0, Math.floor(minutes)));
  }

  getRecordingReminderMinutes(): number {
    return this.read('recordingReminderMinutes');
  }

  setRecordingReminderMinutes(minutes: number): void {
    this.write('recordingReminderMinutes', Math.max(0, Math.floor(minutes)));
  }

  getMinRecordingSeconds(): number {
    return this.read('minRecordingSeconds');
  }

  setMinRecordingSeconds(seconds: number): void {
    this.write('minRecordingSeconds', Math.max(0, Math.floor(seconds)));
  }

  getRecordSystemAudio(): boolean {
    return this.read('recordSystemAudio');
  }

  setRecordSystemAudio(enabled: boolean): void {
    this.write('recordSystemAudio', enabled);
  }

  // Opt-out: absence means ON. The registry default is `true` and the generic
  // read uses `??`, so only an explicit `false` disables reporting.
  getCrashReportingEnabled(): boolean {
    return this.read('crashReportingEnabled');
  }

  setCrashReportingEnabled(enabled: boolean): void {
    this.write('crashReportingEnabled', enabled);
  }

  getAudioDeviceId(): string | undefined {
    return this.read('audioDeviceId');
  }

  getLastSeenVersion(): string | undefined {
    return this.read('lastSeenVersion');
  }

  setLastSeenVersion(version: string): void {
    this.write('lastSeenVersion', version);
  }

  getSummaryPrompt(): string {
    return this.config.summaryPrompt || DEFAULT_SUMMARY_PROMPT;
  }

  setSummaryPrompt(prompt: string): void {
    const normalized = prompt.trim();
    this.setKey(
      'summaryPrompt',
      normalized && normalized !== DEFAULT_SUMMARY_PROMPT ? normalized : undefined,
    );
    this.saveConfig();
  }

  getSlackWebhookUrl(): string | undefined {
    return this.read('slackWebhookUrl');
  }

  setSlackWebhookUrl(url: string): void {
    this.write('slackWebhookUrl', url);
  }

  getSlackAutoShare(): boolean {
    return this.read('slackAutoShare');
  }

  setSlackAutoShare(enabled: boolean): void {
    this.write('slackAutoShare', enabled);
  }

  updateConfig(partial: Partial<AppConfig>): void {
    for (const [key, value] of Object.entries(partial)) {
      if (value === undefined) continue;
      // Enum-domain keys need write-time validation; the IPC payload from the
      // renderer (and any future agent write paths) bypasses the typed setters
      // that already validate, so without this an out-of-domain value would
      // persist and only get caught on read. The getter falls back to the
      // default, but the on-disk state would still be misleading.
      if (key === 'aiProvider') {
        const provider = normalizeAiProvider(value);
        if (!provider) continue;
        this.setKey('aiProvider', provider);
        continue;
      }
      if (key === 'geminiThinkingLevel') {
        const level = normalizeGeminiThinkingLevel(value);
        if (!level) continue;
        this.setKey('geminiThinkingLevel', level);
        continue;
      }
      if (key === 'liveSttProvider') {
        const provider = normalizeLiveSttProvider(value);
        if (!provider) continue;
        this.setKey('liveSttProvider', provider);
        continue;
      }
      if (key === 'transcriptionProvider') {
        // `normalizeTranscriptionProvider` returns the fallback for junk rather
        // than undefined, so validate first; otherwise an out-of-domain write
        // would silently persist as `auto`.
        const candidate = typeof value === 'string' ? value.trim().toLowerCase() : '';
        if (!isTranscriptionProvider(candidate)) continue;
        this.setKey('transcriptionProvider', candidate);
        continue;
      }
      if (key === 'defaultSummaryPrompt') continue;
      if (key === 'summaryPrompt') {
        const prompt = typeof value === 'string' ? value.trim() : '';
        this.setKey(
          'summaryPrompt',
          prompt && prompt !== DEFAULT_SUMMARY_PROMPT ? prompt : undefined,
        );
        continue;
      }
      this.setKey(key as keyof AppConfig, value as AppConfig[keyof AppConfig]);
    }
    this.saveConfig();
  }

  unsetKey(key: keyof AppConfig): void {
    this.setKey(key, undefined);
    this.saveConfig();
  }

  // Every registry key plus the four derived read-only fields. Stays typed as
  // `AppConfig` (all-optional): `cli.ts` relies on `val ?? ''` still being
  // reachable for keys a narrower "resolved" type would mark non-optional.
  getAllConfig(): AppConfig {
    const all: Record<string, unknown> = {};
    for (const row of CONFIG_KEY_DEFINITIONS) {
      if (row.customRead) continue;
      all[row.key] =
        row.envSurfaced === false
          ? // Stored value only -- never surface the env fallback to the
            // settings form, or saving any change would persist an env-only
            // key to config.json.
            (this.config as Record<string, unknown>)[row.key]
          : this.read(row.key as GenericReadConfigKey);
    }
    // Keys whose resolved read has logic the registry cannot express.
    all.aiProvider = this.getAiProvider();
    all.transcriptionProvider = this.getTranscriptionProvider();
    all.geminiThinkingLevel = this.getGeminiThinkingLevel();
    all.liveSttProvider = this.getLiveSttProvider();
    all.liveSttLanguage = this.getLiveSttLanguage();
    all.liveTranslationLanguage = this.getLiveTranslationLanguage();
    all.summaryPrompt = this.getSummaryPrompt();
    // Derived read-only fields: never persisted, so they have no registry row.
    all.codexOAuthConfigured = this.hasCodexOAuth();
    all.codexOAuthSource = this.getCodexOAuthSource()?.source;
    all.googleOAuthConfigured = this.hasGoogleOAuth();
    all.defaultSummaryPrompt = DEFAULT_SUMMARY_PROMPT;
    return all as AppConfig;
  }
}
