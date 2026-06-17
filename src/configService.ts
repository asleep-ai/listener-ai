import * as fs from 'fs';
import * as path from 'path';
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_TRANSCRIPTION_MODEL,
  DEFAULT_GEMINI_FLASH_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_THINKING_LEVEL,
  DEFAULT_LIVE_STT_PROVIDER,
  DEFAULT_OPENAI_LIVE_TRANSCRIPTION_MODEL,
  DEFAULT_OPENAI_LIVE_TRANSLATION_MODEL,
  type AiProvider,
  type GeminiThinkingLevel,
  type LiveSttProvider,
  normalizeAiProvider,
  normalizeGeminiThinkingLevel,
  normalizeLiveSttProvider,
} from './aiProvider';
import {
  type CodexOAuthCredentialSource,
  type CodexOAuthCredentials,
  getCodexOAuthCliCredentials,
  getCodexOAuthEnvCredentials,
} from './codexOAuth';
import {
  type GoogleOAuthCredentials,
  getGoogleOAuthEnvCredentials,
  hasGoogleOAuthEnvCredentials,
} from './googleOAuth';

export interface AppConfig {
  aiProvider?: AiProvider;
  geminiApiKey?: string;
  geminiModel?: string;
  geminiFlashModel?: string;
  geminiThinkingLevel?: GeminiThinkingLevel;
  codexModel?: string;
  codexTranscriptionModel?: string;
  liveSttProvider?: LiveSttProvider;
  openaiApiKey?: string;
  openaiLiveTranscriptionModel?: string;
  openaiLiveTranslationModel?: string;
  liveSttLanguage?: string;
  liveTranslationLanguage?: string;
  codexOAuth?: CodexOAuthCredentials;
  codexOAuthConfigured?: boolean;
  codexOAuthSource?: CodexOAuthCredentialSource['source'];
  googleOAuth?: GoogleOAuthCredentials;
  googleOAuthConfigured?: boolean;
  // When true, the app periodically syncs transcription folders to Drive
  // (and auto-syncs after each new transcription completes). When false,
  // sync only runs on explicit user trigger (CLI or "Sync now" button).
  googleDriveEnabled?: boolean;
  notionApiKey?: string;
  notionDatabaseId?: string;
  autoMode?: boolean;
  meetingDetection?: boolean;
  displayDetection?: boolean;
  globalShortcut?: string;
  knownWords?: string[];
  summaryPrompt?: string;
  maxRecordingMinutes?: number;
  recordingReminderMinutes?: number;
  minRecordingSeconds?: number;
  recordSystemAudio?: boolean;
  audioDeviceId?: string;
  lastSeenVersion?: string;
  slackWebhookUrl?: string;
  slackAutoShare?: boolean;
  // Idempotency marker for `migrateLegacyDefaults` -- once set we never
  // re-run the migration, so a user who deliberately re-selects the old
  // model after upgrade keeps their choice.
  codexTranscriptionMigratedToDiarize?: boolean;
}

export const DEFAULT_SUMMARY_PROMPT = `Based on this meeting transcript, provide:

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
    if (this.config.codexTranscriptionMigratedToDiarize) return;
    if (this.config.codexTranscriptionModel === 'gpt-4o-transcribe') {
      this.setKey('codexTranscriptionModel', undefined);
    }
    this.setKey('codexTranscriptionMigratedToDiarize', true);
    this.saveConfig();
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

  getGeminiApiKey(): string | undefined {
    return this.config.geminiApiKey || process.env.GEMINI_API_KEY;
  }

  setGeminiApiKey(apiKey: string): void {
    this.setKey('geminiApiKey', apiKey);
    this.saveConfig();
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
    this.setKey('aiProvider', provider);
    this.saveConfig();
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
    return this.config.googleDriveEnabled ?? false;
  }

  setGoogleDriveEnabled(enabled: boolean): void {
    this.setKey('googleDriveEnabled', enabled);
    this.saveConfig();
  }

  hasAiAuth(): boolean {
    const provider = this.getAiProvider();
    if (provider === 'codex') return this.hasCodexOAuth();
    return !!this.getGeminiApiKey();
  }

  getNotionApiKey(): string | undefined {
    return this.config.notionApiKey || process.env.NOTION_API_KEY;
  }

  setNotionApiKey(apiKey: string): void {
    this.setKey('notionApiKey', apiKey);
    this.saveConfig();
  }

  getNotionDatabaseId(): string | undefined {
    return this.config.notionDatabaseId || process.env.NOTION_DATABASE_ID;
  }

  setNotionDatabaseId(databaseId: string): void {
    this.setKey('notionDatabaseId', databaseId);
    this.saveConfig();
  }

  hasRequiredConfig(): boolean {
    return this.hasAiAuth() && !!this.getNotionApiKey() && !!this.getNotionDatabaseId();
  }

  getMissingConfigs(): string[] {
    const missing: string[] = [];
    if (!this.hasAiAuth()) {
      missing.push(this.getAiProvider() === 'codex' ? 'Codex OAuth sign-in' : 'Gemini API Key');
    }
    if (!this.getNotionApiKey()) missing.push('Notion Integration Token');
    if (!this.getNotionDatabaseId()) missing.push('Notion Database ID');
    return missing;
  }

  getAutoMode(): boolean {
    return this.config.autoMode || false;
  }

  setAutoMode(enabled: boolean): void {
    this.setKey('autoMode', enabled);
    this.saveConfig();
  }

  getMeetingDetection(): boolean {
    return this.config.meetingDetection || false;
  }

  getDisplayDetection(): boolean {
    return this.config.displayDetection || false;
  }

  setDisplayDetection(enabled: boolean): void {
    this.setKey('displayDetection', enabled);
    this.saveConfig();
  }

  getGlobalShortcut(): string {
    return this.config.globalShortcut || 'CommandOrControl+Shift+L';
  }

  setGlobalShortcut(shortcut: string): void {
    this.setKey('globalShortcut', shortcut);
    this.saveConfig();
  }

  getKnownWords(): string[] {
    return this.config.knownWords || [];
  }

  setKnownWords(words: string[]): void {
    this.setKey('knownWords', words);
    this.saveConfig();
  }

  getGeminiModel(): string {
    return this.config.geminiModel || DEFAULT_GEMINI_MODEL;
  }

  setGeminiModel(model: string): void {
    this.setKey('geminiModel', model);
    this.saveConfig();
  }

  getGeminiFlashModel(): string {
    return this.config.geminiFlashModel || DEFAULT_GEMINI_FLASH_MODEL;
  }

  setGeminiFlashModel(model: string): void {
    this.setKey('geminiFlashModel', model);
    this.saveConfig();
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
    this.setKey('geminiThinkingLevel', level);
    this.saveConfig();
  }

  getCodexModel(): string {
    return this.config.codexModel || DEFAULT_CODEX_MODEL;
  }

  setCodexModel(model: string): void {
    this.setKey('codexModel', model);
    this.saveConfig();
  }

  getCodexTranscriptionModel(): string {
    return this.config.codexTranscriptionModel || DEFAULT_CODEX_TRANSCRIPTION_MODEL;
  }

  setCodexTranscriptionModel(model: string): void {
    this.setKey('codexTranscriptionModel', model);
    this.saveConfig();
  }

  getLiveSttProvider(): LiveSttProvider {
    return normalizeLiveSttProvider(this.config.liveSttProvider) ?? DEFAULT_LIVE_STT_PROVIDER;
  }

  setLiveSttProvider(provider: LiveSttProvider): void {
    this.setKey('liveSttProvider', provider);
    this.saveConfig();
  }

  getOpenAiApiKey(): string | undefined {
    return this.config.openaiApiKey || process.env.OPENAI_API_KEY;
  }

  setOpenAiApiKey(apiKey: string): void {
    this.setKey('openaiApiKey', apiKey);
    this.saveConfig();
  }

  getOpenAiLiveTranscriptionModel(): string {
    return this.config.openaiLiveTranscriptionModel || DEFAULT_OPENAI_LIVE_TRANSCRIPTION_MODEL;
  }

  getOpenAiLiveTranslationModel(): string {
    return this.config.openaiLiveTranslationModel || DEFAULT_OPENAI_LIVE_TRANSLATION_MODEL;
  }

  getLiveSttLanguage(): string | undefined {
    return this.config.liveSttLanguage?.trim() || undefined;
  }

  getLiveTranslationLanguage(): string {
    return this.config.liveTranslationLanguage?.trim() || 'ko';
  }

  hasStreamingLiveSttAuth(): boolean {
    const provider = this.getLiveSttProvider();
    const hasOpenAiRealtimeAuth = !!this.getOpenAiApiKey();
    if (provider === 'openai') return hasOpenAiRealtimeAuth;
    if (provider === 'gemini') return !!this.getGeminiApiKey();
    if (provider === 'chunked') return false;
    return hasOpenAiRealtimeAuth || !!this.getGeminiApiKey();
  }

  getMaxRecordingMinutes(): number {
    return this.config.maxRecordingMinutes || 0;
  }

  setMaxRecordingMinutes(minutes: number): void {
    this.setKey('maxRecordingMinutes', Math.max(0, Math.floor(minutes)));
    this.saveConfig();
  }

  getRecordingReminderMinutes(): number {
    return this.config.recordingReminderMinutes || 0;
  }

  setRecordingReminderMinutes(minutes: number): void {
    this.setKey('recordingReminderMinutes', Math.max(0, Math.floor(minutes)));
    this.saveConfig();
  }

  getMinRecordingSeconds(): number {
    return this.config.minRecordingSeconds || 0;
  }

  setMinRecordingSeconds(seconds: number): void {
    this.setKey('minRecordingSeconds', Math.max(0, Math.floor(seconds)));
    this.saveConfig();
  }

  getRecordSystemAudio(): boolean {
    return this.config.recordSystemAudio || false;
  }

  setRecordSystemAudio(enabled: boolean): void {
    this.setKey('recordSystemAudio', enabled);
    this.saveConfig();
  }

  getAudioDeviceId(): string | undefined {
    return this.config.audioDeviceId;
  }

  getLastSeenVersion(): string | undefined {
    return this.config.lastSeenVersion;
  }

  setLastSeenVersion(version: string): void {
    this.setKey('lastSeenVersion', version);
    this.saveConfig();
  }

  getSummaryPrompt(): string {
    return this.config.summaryPrompt || DEFAULT_SUMMARY_PROMPT;
  }

  setSummaryPrompt(prompt: string): void {
    this.setKey('summaryPrompt', prompt);
    this.saveConfig();
  }

  getSlackWebhookUrl(): string | undefined {
    return this.config.slackWebhookUrl || process.env.SLACK_WEBHOOK_URL;
  }

  setSlackWebhookUrl(url: string): void {
    this.setKey('slackWebhookUrl', url);
    this.saveConfig();
  }

  getSlackAutoShare(): boolean {
    return this.config.slackAutoShare || false;
  }

  setSlackAutoShare(enabled: boolean): void {
    this.setKey('slackAutoShare', enabled);
    this.saveConfig();
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
      this.setKey(key as keyof AppConfig, value as AppConfig[keyof AppConfig]);
    }
    this.saveConfig();
  }

  unsetKey(key: keyof AppConfig): void {
    this.setKey(key, undefined);
    this.saveConfig();
  }

  getAllConfig(): AppConfig {
    return {
      aiProvider: this.getAiProvider(),
      geminiApiKey: this.getGeminiApiKey(),
      geminiModel: this.getGeminiModel(),
      geminiFlashModel: this.getGeminiFlashModel(),
      geminiThinkingLevel: this.getGeminiThinkingLevel(),
      codexModel: this.getCodexModel(),
      codexTranscriptionModel: this.getCodexTranscriptionModel(),
      liveSttProvider: this.getLiveSttProvider(),
      openaiApiKey: this.getOpenAiApiKey(),
      openaiLiveTranscriptionModel: this.getOpenAiLiveTranscriptionModel(),
      openaiLiveTranslationModel: this.getOpenAiLiveTranslationModel(),
      liveSttLanguage: this.getLiveSttLanguage(),
      liveTranslationLanguage: this.getLiveTranslationLanguage(),
      codexOAuthConfigured: this.hasCodexOAuth(),
      codexOAuthSource: this.getCodexOAuthSource()?.source,
      googleOAuthConfigured: this.hasGoogleOAuth(),
      googleDriveEnabled: this.getGoogleDriveEnabled(),
      notionApiKey: this.getNotionApiKey(),
      notionDatabaseId: this.getNotionDatabaseId(),
      autoMode: this.getAutoMode(),
      meetingDetection: this.getMeetingDetection(),
      displayDetection: this.getDisplayDetection(),
      globalShortcut: this.getGlobalShortcut(),
      knownWords: this.getKnownWords(),
      summaryPrompt: this.getSummaryPrompt(),
      maxRecordingMinutes: this.getMaxRecordingMinutes(),
      recordingReminderMinutes: this.getRecordingReminderMinutes(),
      minRecordingSeconds: this.getMinRecordingSeconds(),
      recordSystemAudio: this.getRecordSystemAudio(),
      audioDeviceId: this.getAudioDeviceId(),
      lastSeenVersion: this.getLastSeenVersion(),
      slackWebhookUrl: this.getSlackWebhookUrl(),
      slackAutoShare: this.getSlackAutoShare(),
    };
  }
}
