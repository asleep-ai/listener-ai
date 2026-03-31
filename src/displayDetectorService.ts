import { EventEmitter } from 'events';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export class DisplayDetectorService extends EventEmitter {
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private isPolling = false;
  private lastDisplayCount = 0;
  private consecutiveDetections = 0;
  private consecutiveNonDetections = 0;
  private externalConnected = false;
  private static readonly POLL_MS = 5000;
  private static readonly START_THRESHOLD = 2;  // 2 consecutive detections to confirm connection
  private static readonly END_THRESHOLD = 3;    // 3 consecutive non-detections to confirm disconnection

  start(): void {
    if (this.pollInterval) return;
    this.initBaselineCount().then(() => {
      this.pollInterval = setInterval(() => this.poll(), DisplayDetectorService.POLL_MS);
      console.log('Display detector started');
    });
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.consecutiveDetections = 0;
    this.consecutiveNonDetections = 0;
    this.externalConnected = false;
    console.log('Display detector stopped');
  }

  setEnabled(enabled: boolean): void {
    if (enabled && !this.pollInterval) {
      this.start();
    } else if (!enabled && this.pollInterval) {
      this.stop();
    }
  }

  isActive(): boolean {
    return this.externalConnected;
  }

  private async initBaselineCount(): Promise<void> {
    try {
      this.lastDisplayCount = await this.getDisplayCount();
      console.log(`Display detector baseline: ${this.lastDisplayCount} display(s)`);
    } catch (error) {
      console.error('Failed to get baseline display count:', error);
      this.lastDisplayCount = 1; // assume single built-in display
    }
  }

  private async poll(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;
    try {
      const count = await this.getDisplayCount();
      const increased = count > this.lastDisplayCount;
      const decreased = count < this.lastDisplayCount;

      if (increased) {
        this.consecutiveNonDetections = 0;
        this.consecutiveDetections++;

        if (!this.externalConnected && this.consecutiveDetections >= DisplayDetectorService.START_THRESHOLD) {
          this.externalConnected = true;
          this.lastDisplayCount = count;
          this.emit('display-connected', { count });
          console.log(`External display connected (${count} displays)`);
        }
      } else if (decreased) {
        this.consecutiveDetections = 0;
        this.consecutiveNonDetections++;

        if (this.externalConnected && this.consecutiveNonDetections >= DisplayDetectorService.END_THRESHOLD) {
          this.externalConnected = false;
          this.lastDisplayCount = count;
          this.emit('display-disconnected', { count });
          console.log(`External display disconnected (${count} displays)`);
        }
      } else {
        // No change -- reset counters
        this.consecutiveDetections = 0;
        this.consecutiveNonDetections = 0;
      }
    } catch (error) {
      console.error('Display detection poll error:', error);
    } finally {
      this.isPolling = false;
    }
  }

  private async getDisplayCount(): Promise<number> {
    if (process.platform === 'darwin') {
      return this.getDisplayCountMacOS();
    } else if (process.platform === 'win32') {
      return this.getDisplayCountWindows();
    }
    return 1; // unsupported platform, assume single display
  }

  private async getDisplayCountMacOS(): Promise<number> {
    const script = 'tell application "System Events" to return count of desktops';
    try {
      const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 5000 });
      const count = parseInt(stdout.trim(), 10);
      return isNaN(count) ? 1 : count;
    } catch {
      return 1;
    }
  }

  private async getDisplayCountWindows(): Promise<number> {
    const psCommand = '(Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorBasicDisplayParams | Measure-Object).Count';
    try {
      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', psCommand], { timeout: 5000 });
      const count = parseInt(stdout.trim(), 10);
      return isNaN(count) ? 1 : count;
    } catch {
      return 1;
    }
  }
}
