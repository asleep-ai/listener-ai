import { GitHubRelease } from '../types/update.types';

export class GitHubAPI {
  private readonly repoOwner = 'asleep-ai';
  private readonly repoName = 'listener-ai';
  private readonly apiBase = 'https://api.github.com';
  private readonly maxRetries = 3;
  private readonly retryDelay = 1000; // Start with 1 second
  
  private async fetchWithRetry(url: string, retries = this.maxRetries): Promise<Response> {
    try {
      console.log(`[GitHubAPI] Making request to: ${url}`);
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'Listener-AI-Update-Checker'
        },
        signal: AbortSignal.timeout(10000) // 10 second timeout
      });
      
      console.log(`[GitHubAPI] Response status: ${response.status}`);
      
      // Handle rate limiting
      if (response.status === 403) {
        const rateLimitRemaining = response.headers.get('x-ratelimit-remaining');
        if (rateLimitRemaining === '0') {
          const resetTime = response.headers.get('x-ratelimit-reset');
          if (resetTime) {
            const resetDate = new Date(parseInt(resetTime) * 1000);
            console.log(`[GitHubAPI] GitHub API rate limit exceeded. Resets at: ${resetDate.toISOString()}`);
          }
          throw new Error('GitHub API rate limit exceeded');
        }
      }
      
      return response;
    } catch (error) {
      console.error('[GitHubAPI] Request failed:', error);
      if (retries > 0) {
        // Exponential backoff
        const delay = this.retryDelay * Math.pow(2, this.maxRetries - retries);
        console.log(`[GitHubAPI] Request failed, retrying in ${delay}ms... (${retries} retries left)`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.fetchWithRetry(url, retries - 1);
      }
      throw error;
    }
  }
  
  async getLatestRelease(): Promise<GitHubRelease | null> {
    try {
      const url = `${this.apiBase}/repos/${this.repoOwner}/${this.repoName}/releases/latest`;
      console.log('[GitHubAPI] Fetching latest release from:', url);
      const response = await this.fetchWithRetry(url);

      if (!response.ok) {
        if (response.status === 404) {
          console.log('[GitHubAPI] No releases found (404)');
          return null;
        }
        console.error('[GitHubAPI] API error:', response.status);
        throw new Error(`GitHub API error: ${response.status}`);
      }

      const release = await response.json() as GitHubRelease;
      console.log('[GitHubAPI] Release fetched:', {
        tag_name: release.tag_name,
        prerelease: release.prerelease,
        draft: release.draft,
        published_at: release.published_at
      });
      
      // Filter out drafts and prereleases by default
      if (release.draft) {
        console.log('[GitHubAPI] Filtering out draft release');
        return null;
      }
      
      return release;
    } catch (error) {
      console.error('[GitHubAPI] Failed to fetch latest release:', error);
      return null;
    }
  }

}