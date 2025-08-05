export interface GitHubRelease {
  id: number;
  tag_name: string;
  name: string;
  body?: string;
  prerelease: boolean;
  draft: boolean;
  published_at: string;
  html_url: string;
  assets: GitHubAsset[];
}

export interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface UpdateCheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion?: string;
  releaseInfo?: GitHubRelease;
  isStable?: boolean;
  stabilitySince?: Date;
}

export interface UpdatePreferences {
  checkEnabled: boolean;
  lastCheckedAt?: string;
  dismissedVersions: string[];
  seenVersions: { [version: string]: number };
}

export interface UpdateNotification {
  version: string;
  releaseNotes?: string;
  downloadUrl: string;
  publishedAt: string;
}
