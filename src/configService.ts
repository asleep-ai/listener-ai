import * as fs from 'fs';
import * as path from 'path';

export interface AppConfig {
  geminiApiKey?: string;
  geminiModel?: string;
  geminiFlashModel?: string;
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
  lastSeenVersion?: string;
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

  private saveConfig(): void {
    try {
      fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    } catch (error) {
      console.error('Error saving config:', error);
    }
  }

  getGeminiApiKey(): string | undefined {
    return this.config.geminiApiKey || process.env.GEMINI_API_KEY;
  }

  setGeminiApiKey(apiKey: string): void {
    this.config.geminiApiKey = apiKey;
    this.saveConfig();
  }

  getNotionApiKey(): string | undefined {
    return this.config.notionApiKey || process.env.NOTION_API_KEY;
  }

  setNotionApiKey(apiKey: string): void {
    this.config.notionApiKey = apiKey;
    this.saveConfig();
  }

  getNotionDatabaseId(): string | undefined {
    return this.config.notionDatabaseId || process.env.NOTION_DATABASE_ID;
  }

  setNotionDatabaseId(databaseId: string): void {
    this.config.notionDatabaseId = databaseId;
    this.saveConfig();
  }

  hasRequiredConfig(): boolean {
    return !!this.getGeminiApiKey() && !!this.getNotionApiKey() && !!this.getNotionDatabaseId();
  }
  
  getMissingConfigs(): string[] {
    const missing: string[] = [];
    if (!this.getGeminiApiKey()) missing.push('Gemini API Key');
    if (!this.getNotionApiKey()) missing.push('Notion Integration Token');
    if (!this.getNotionDatabaseId()) missing.push('Notion Database ID');
    return missing;
  }

  getAutoMode(): boolean {
    return this.config.autoMode || false;
  }

  setAutoMode(enabled: boolean): void {
    this.config.autoMode = enabled;
    this.saveConfig();
  }

  getMeetingDetection(): boolean {
    return this.config.meetingDetection || false;
  }

  getDisplayDetection(): boolean {
    return this.config.displayDetection || false;
  }

  setDisplayDetection(enabled: boolean): void {
    this.config.displayDetection = enabled;
    this.saveConfig();
  }

  getGlobalShortcut(): string {
    return this.config.globalShortcut || 'CommandOrControl+Shift+L';
  }

  setGlobalShortcut(shortcut: string): void {
    this.config.globalShortcut = shortcut;
    this.saveConfig();
  }

  getKnownWords(): string[] {
    return this.config.knownWords || [];
  }

  setKnownWords(words: string[]): void {
    this.config.knownWords = words;
    this.saveConfig();
  }

  getGeminiModel(): string {
    return this.config.geminiModel || 'gemini-2.5-pro';
  }

  setGeminiModel(model: string): void {
    this.config.geminiModel = model;
    this.saveConfig();
  }

  getGeminiFlashModel(): string {
    return this.config.geminiFlashModel || 'gemini-2.5-flash';
  }

  setGeminiFlashModel(model: string): void {
    this.config.geminiFlashModel = model;
    this.saveConfig();
  }

  getMaxRecordingMinutes(): number {
    return this.config.maxRecordingMinutes || 0;
  }

  setMaxRecordingMinutes(minutes: number): void {
    this.config.maxRecordingMinutes = Math.max(0, Math.floor(minutes));
    this.saveConfig();
  }

  getRecordingReminderMinutes(): number {
    return this.config.recordingReminderMinutes || 0;
  }

  setRecordingReminderMinutes(minutes: number): void {
    this.config.recordingReminderMinutes = Math.max(0, Math.floor(minutes));
    this.saveConfig();
  }

  getMinRecordingSeconds(): number {
    return this.config.minRecordingSeconds || 0;
  }

  setMinRecordingSeconds(seconds: number): void {
    this.config.minRecordingSeconds = Math.max(0, Math.floor(seconds));
    this.saveConfig();
  }

  getLastSeenVersion(): string | undefined {
    return this.config.lastSeenVersion;
  }

  setLastSeenVersion(version: string): void {
    this.config.lastSeenVersion = version;
    this.saveConfig();
  }

  getSummaryPrompt(): string {
    return this.config.summaryPrompt || DEFAULT_SUMMARY_PROMPT;
  }

  setSummaryPrompt(prompt: string): void {
    this.config.summaryPrompt = prompt;
    this.saveConfig();
  }

  updateConfig(partial: Partial<AppConfig>): void {
    for (const [key, value] of Object.entries(partial)) {
      if (value !== undefined) {
        (this.config as Record<string, unknown>)[key] = value;
      }
    }
    this.saveConfig();
  }

  getAllConfig(): AppConfig {
    return {
      geminiApiKey: this.getGeminiApiKey(),
      geminiModel: this.getGeminiModel(),
      geminiFlashModel: this.getGeminiFlashModel(),
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
      lastSeenVersion: this.getLastSeenVersion()
    };
  }
}