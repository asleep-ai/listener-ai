import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export interface AppConfig {
  geminiApiKey?: string;
  notionApiKey?: string;
  notionDatabaseId?: string;
  autoMode?: boolean;
  globalShortcut?: string;
}

export class ConfigService {
  private configPath: string;
  private config: AppConfig = {};

  constructor() {
    const userDataPath = app.getPath('userData');
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

  getGlobalShortcut(): string {
    return this.config.globalShortcut || 'CommandOrControl+Shift+L';
  }

  setGlobalShortcut(shortcut: string): void {
    this.config.globalShortcut = shortcut;
    this.saveConfig();
  }

  getAllConfig(): AppConfig {
    return {
      geminiApiKey: this.getGeminiApiKey(),
      notionApiKey: this.getNotionApiKey(),
      notionDatabaseId: this.getNotionDatabaseId(),
      autoMode: this.getAutoMode(),
      globalShortcut: this.getGlobalShortcut()
    };
  }
}