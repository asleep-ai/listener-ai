import * as semver from 'semver';
import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs-extra';
import { GitHubAPI } from './githubAPI';
import { 
  UpdateCheckResult, 
  UpdatePreferences, 
  GitHubRelease 
} from '../types/update.types';

export class UpdateService {
  private githubAPI: GitHubAPI;
  private preferences: UpdatePreferences;
  private preferencesPath: string;
  private checkInterval: NodeJS.Timeout | null = null;
  private readonly CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  private readonly STABILITY_THRESHOLD_MS = 3 * 60 * 60 * 1000; // 3 hours
  
  constructor() {
    console.log('[UpdateService] Initializing UpdateService');
    this.githubAPI = new GitHubAPI();
    this.preferencesPath = path.join(app.getPath('userData'), 'update-preferences.json');
    console.log('[UpdateService] Preferences path:', this.preferencesPath);
    this.preferences = this.loadPreferences();
    console.log('[UpdateService] Loaded preferences:', this.preferences);
  }

  private loadPreferences(): UpdatePreferences {
    try {
      if (fs.existsSync(this.preferencesPath)) {
        return fs.readJsonSync(this.preferencesPath);
      }
    } catch (error) {
      console.error('Failed to load update preferences:', error);
    }
    
    // Default preferences
    return {
      checkEnabled: true,
      dismissedVersions: [],
      seenVersions: {}
    };
  }

  private savePreferences(): void {
    try {
      fs.ensureDirSync(path.dirname(this.preferencesPath));
      fs.writeJsonSync(this.preferencesPath, this.preferences, { spaces: 2 });
    } catch (error) {
      console.error('Failed to save update preferences:', error);
    }
  }

  async checkForUpdate(bypassStability: boolean = false): Promise<UpdateCheckResult> {
    const currentVersion = app.getVersion();
    console.log('[UpdateService] Checking for updates. Current version:', currentVersion);
    
    // Update last checked timestamp
    this.preferences.lastCheckedAt = new Date().toISOString();
    this.savePreferences();
    
    if (!this.preferences.checkEnabled) {
      console.log('[UpdateService] Update checking is disabled');
      return {
        hasUpdate: false,
        currentVersion
      };
    }
    
    try {
      console.log('[UpdateService] Fetching latest release from GitHub API...');
      const latestRelease = await this.githubAPI.getLatestRelease();
      
      if (!latestRelease) {
        console.log('[UpdateService] No latest release found');
        return {
          hasUpdate: false,
          currentVersion
        };
      }
      console.log('[UpdateService] Latest release found:', latestRelease.tag_name)
      
      // Clean version string (remove 'v' prefix if present)
      const latestVersion = latestRelease.tag_name.replace(/^v/, '');
      
      // Check if this is actually newer
      const isNewer = semver.gt(latestVersion, currentVersion);
      console.log('[UpdateService] Version comparison:', {
        current: currentVersion,
        latest: latestVersion,
        isNewer: isNewer
      });
      
      if (!isNewer) {
        console.log('[UpdateService] Current version is up to date');
        return {
          hasUpdate: false,
          currentVersion,
          latestVersion
        };
      }
      
      // Track when we first saw this version
      if (!this.preferences.seenVersions[latestVersion]) {
        this.preferences.seenVersions[latestVersion] = Date.now();
        this.savePreferences();
      }
      
      // Check stability (3 hours since first seen)
      const firstSeenTime = this.preferences.seenVersions[latestVersion];
      const timeSinceFirstSeen = Date.now() - firstSeenTime;
      const isStable = bypassStability || timeSinceFirstSeen >= this.STABILITY_THRESHOLD_MS;
      
      // Check if user dismissed this version
      const isDismissed = this.preferences.dismissedVersions.includes(latestVersion);
      
      const result = {
        hasUpdate: isNewer && isStable && !isDismissed,
        currentVersion,
        latestVersion,
        releaseInfo: latestRelease,
        isStable,
        stabilitySince: isStable ? new Date(firstSeenTime + this.STABILITY_THRESHOLD_MS) : undefined
      };
      console.log('[UpdateService] Update check result:', {
        hasUpdate: result.hasUpdate,
        isStable,
        isDismissed,
        stabilitySince: result.stabilitySince
      });
      
      // If manual check with update available, notify immediately
      if (bypassStability && result.hasUpdate) {
        this.notifyUpdate(result);
      }
      
      return result;
    } catch (error) {
      console.error('[UpdateService] Failed to check for updates:', error);
      return {
        hasUpdate: false,
        currentVersion
      };
    }
  }

  startPeriodicCheck(): void {
    console.log('[UpdateService] Starting periodic update checks');
    // Initial check
    this.checkForUpdate().then(result => {
      console.log('[UpdateService] Initial check completed');
      if (result.hasUpdate) {
        console.log('[UpdateService] Update available, notifying user');
        this.notifyUpdate(result);
      }
    }).catch(error => {
      console.error('[UpdateService] Error during initial check:', error);
    });
    
    // Set up periodic checks
    this.checkInterval = setInterval(() => {
      this.checkForUpdate().then(result => {
        if (result.hasUpdate) {
          this.notifyUpdate(result);
        }
      });
    }, this.CHECK_INTERVAL_MS);
  }

  stopPeriodicCheck(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  private notifyUpdate(result: UpdateCheckResult): void {
    console.log('[UpdateService] Notifying update to renderer process');
    // Send notification to renderer process
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow && result.releaseInfo) {
      // Always use the release page URL for better user experience
      const downloadUrl = result.releaseInfo.html_url;
      mainWindow.webContents.send('update-available', {
        version: result.latestVersion,
        releaseNotes: result.releaseInfo.body,
        downloadUrl: downloadUrl,
        publishedAt: result.releaseInfo.published_at,
        stabilitySince: result.stabilitySince
      });
    }
    console.log('[UpdateService] Update notification sent for version:', result.latestVersion);
  }

  dismissVersion(version: string): void {
    if (!this.preferences.dismissedVersions.includes(version)) {
      this.preferences.dismissedVersions.push(version);
      this.savePreferences();
    }
  }

  setCheckEnabled(enabled: boolean): void {
    this.preferences.checkEnabled = enabled;
    this.savePreferences();
    
    if (enabled) {
      this.startPeriodicCheck();
    } else {
      this.stopPeriodicCheck();
    }
  }

  getPreferences(): UpdatePreferences {
    return { ...this.preferences };
  }

}