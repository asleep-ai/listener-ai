import { app, net } from 'electron';
import * as fs from 'fs-extra';
import * as path from 'path';

export interface DownloadProgress {
  status: 'preparing' | 'downloading' | 'extracting' | 'verifying' | 'complete' | 'error';
  percent: number;
  bytesDownloaded: number;
  totalBytes: number;
  speed: string;
  eta: string;
}

interface FFmpegRelease {
  platform: string;
  arch: string;
  url: string;
  sha256: string;
  version: string;
}

// FFmpeg static releases from https://github.com/eugeneware/ffmpeg-static
// Note: SHA256 checksums should be verified in production for security
const FFMPEG_RELEASES: FFmpegRelease[] = [
  {
    platform: 'darwin',
    arch: 'x64',
    url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-darwin-x64',
    sha256: '', // TODO: Add actual checksum from release page
    version: '6.0'
  },
  {
    platform: 'darwin',
    arch: 'arm64',
    url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-darwin-arm64',
    sha256: '', // TODO: Add actual checksum from release page
    version: '6.0'
  },
  {
    platform: 'win32',
    arch: 'x64',
    url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-win32-x64',
    sha256: '', // TODO: Add actual checksum from release page
    version: '6.0'
  },
  {
    platform: 'linux',
    arch: 'x64',
    url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-linux-x64',
    sha256: '', // TODO: Add actual checksum from release page
    version: '6.0'
  }
];

export class FFmpegManager {
  private ffmpegDir: string;
  private ffmpegPath: string;
  private downloadController: AbortController | null = null;

  constructor() {
    this.ffmpegDir = path.join(app.getPath('userData'), 'ffmpeg');
    const execName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    this.ffmpegPath = path.join(this.ffmpegDir, execName);
  }

  async ensureFFmpeg(): Promise<string | null> {
    // Check if already downloaded
    if (await this.isFFmpegValid()) {
      return this.ffmpegPath;
    }

    // Check system FFmpeg as fallback
    const systemFFmpeg = await this.findSystemFFmpeg();
    if (systemFFmpeg) {
      return systemFFmpeg;
    }

    return null;
  }

  async downloadFFmpeg(onProgress: (progress: DownloadProgress) => void): Promise<string> {
    try {
      // Find appropriate release
      const release = this.getRelease();
      if (!release) {
        throw new Error(`No FFmpeg release available for ${process.platform} ${process.arch}`);
      }

      onProgress({
        status: 'preparing',
        percent: 0,
        bytesDownloaded: 0,
        totalBytes: 0,
        speed: '0 MB/s',
        eta: 'Preparing...'
      });

      // Ensure directory exists
      await fs.ensureDir(this.ffmpegDir);

      // Download file directly (no gzip)
      const tempPath = path.join(this.ffmpegDir, 'ffmpeg.tmp');
      await this.downloadFile(release.url, tempPath, onProgress);

      // Move to final location
      onProgress({
        status: 'extracting',
        percent: 90,
        bytesDownloaded: 0,
        totalBytes: 0,
        speed: '0 MB/s',
        eta: 'Installing...'
      });

      await fs.move(tempPath, this.ffmpegPath, { overwrite: true });

      // Make executable on Unix
      if (process.platform !== 'win32') {
        await fs.chmod(this.ffmpegPath, 0o755);
      }

      // Verify installation
      onProgress({
        status: 'verifying',
        percent: 95,
        bytesDownloaded: 0,
        totalBytes: 0,
        speed: '0 MB/s',
        eta: 'Verifying...'
      });

      if (await this.isFFmpegValid()) {
        onProgress({
          status: 'complete',
          percent: 100,
          bytesDownloaded: 0,
          totalBytes: 0,
          speed: '0 MB/s',
          eta: 'Complete!'
        });
        return this.ffmpegPath;
      }

      throw new Error('FFmpeg verification failed');
    } catch (error) {
      onProgress({
        status: 'error',
        percent: 0,
        bytesDownloaded: 0,
        totalBytes: 0,
        speed: '0 MB/s',
        eta: 'Error'
      });
      throw error;
    }
  }

  private async downloadFile(url: string, destPath: string, onProgress: (progress: DownloadProgress) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      this.downloadController = new AbortController();
      const startTime = Date.now();
      let receivedBytes = 0;
      let totalBytes = 0;

      const request = net.request({
        url,
        redirect: 'follow'
      });

      request.on('response', (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`Download failed with status ${response.statusCode}`));
          return;
        }

        totalBytes = parseInt(response.headers['content-length'] as string) || 0;
        const fileStream = fs.createWriteStream(destPath);

        response.on('data', (chunk) => {
          if (this.downloadController?.signal.aborted) {
            fileStream.destroy();
            reject(new Error('Download cancelled'));
            return;
          }

          receivedBytes += chunk.length;
          fileStream.write(chunk);

          const progress = this.calculateProgress(receivedBytes, totalBytes, startTime);
          onProgress({
            status: 'downloading',
            ...progress
          });
        });

        response.on('end', () => {
          fileStream.end();
          resolve();
        });

        response.on('error', (error) => {
          fileStream.destroy();
          reject(error);
        });
      });

      request.on('error', reject);
      request.end();
    });
  }

  private calculateProgress(received: number, total: number, startTime: number): Omit<DownloadProgress, 'status'> {
    const percent = total > 0 ? Math.round((received / total) * 100) : 0;
    const elapsed = (Date.now() - startTime) / 1000;
    const speed = received / elapsed;
    const remaining = total > 0 ? (total - received) / speed : 0;

    return {
      percent,
      bytesDownloaded: received,
      totalBytes: total,
      speed: this.formatSpeed(speed),
      eta: this.formatTime(remaining)
    };
  }

  private formatSpeed(bytesPerSecond: number): string {
    const mbps = bytesPerSecond / (1024 * 1024);
    return `${mbps.toFixed(1)} MB/s`;
  }

  private formatTime(seconds: number): string {
    if (seconds <= 0) return 'Complete';
    if (seconds < 60) return `${Math.round(seconds)} seconds`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes} minute${minutes > 1 ? 's' : ''}`;
  }


  private getRelease(): FFmpegRelease | null {
    const arch = process.arch as string;
    const platform = process.platform;
    
    // Handle architecture mapping
    let targetArch = arch;
    if (arch === 'ia32') targetArch = 'x64'; // 32-bit x86 -> use x64 build
    if (arch === 'x32') targetArch = 'x64'; // x32 ABI -> use x64 build
    
    return FFMPEG_RELEASES.find(r => 
      r.platform === platform && r.arch === targetArch
    ) || null;
  }

  private async isFFmpegValid(): Promise<boolean> {
    try {
      await fs.access(this.ffmpegPath, fs.constants.X_OK);
      const stats = await fs.stat(this.ffmpegPath);
      return stats.size > 1000000; // Basic size check (>1MB)
    } catch {
      return false;
    }
  }

  private async findSystemFFmpeg(): Promise<string | null> {
    const { platform } = process;
    const paths: string[] = [];

    if (platform === 'darwin') {
      paths.push(
        '/opt/homebrew/bin/ffmpeg',
        '/usr/local/bin/ffmpeg',
        '/usr/bin/ffmpeg'
      );
    } else if (platform === 'win32') {
      const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
      paths.push(
        path.join(programFiles, 'ffmpeg', 'bin', 'ffmpeg.exe'),
        'C:\\ffmpeg\\bin\\ffmpeg.exe'
      );
    } else {
      paths.push(
        '/usr/bin/ffmpeg',
        '/usr/local/bin/ffmpeg'
      );
    }

    // Check hardcoded paths first
    for (const ffmpegPath of paths) {
      try {
        await fs.access(ffmpegPath, fs.constants.X_OK);
        return ffmpegPath;
      } catch {
        continue;
      }
    }

    // Check if ffmpeg is in PATH
    try {
      const { execSync } = require('child_process');
      const command = platform === 'win32' ? 'where ffmpeg' : 'which ffmpeg';
      const result = execSync(command, { encoding: 'utf8' }).trim();
      if (result) {
        const ffmpegPath = result.split('\n')[0]; // Take first result if multiple
        // Verify it's executable
        await fs.access(ffmpegPath, fs.constants.X_OK);
        return ffmpegPath;
      }
    } catch (e) {
      // ffmpeg not in PATH or not executable
    }

    return null;
  }

  cancelDownload(): void {
    this.downloadController?.abort();
  }
}