import { EventEmitter } from 'events';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

interface MeetingInfo {
  app: string;
  detectedAt: Date;
}

export class MeetingDetectorService extends EventEmitter {
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private isPolling = false;
  private currentMeeting: MeetingInfo | null = null;
  private consecutiveDetections = 0;
  private consecutiveNonDetections = 0;
  private static readonly POLL_MS = 5000;
  private static readonly START_THRESHOLD = 2;  // 2 consecutive detections to confirm start
  private static readonly END_THRESHOLD = 3;    // 3 consecutive non-detections to confirm end

  start(): void {
    if (this.pollInterval) return;
    this.poll(); // immediate first check
    this.pollInterval = setInterval(() => this.poll(), MeetingDetectorService.POLL_MS);
    console.log('Meeting detector started');
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.consecutiveDetections = 0;
    this.consecutiveNonDetections = 0;
    console.log('Meeting detector stopped');
  }

  setEnabled(enabled: boolean): void {
    if (enabled && !this.pollInterval) {
      this.start();
    } else if (!enabled && this.pollInterval) {
      this.stop();
    }
  }

  isActive(): boolean {
    return this.currentMeeting !== null;
  }

  getActiveMeeting(): MeetingInfo | null {
    return this.currentMeeting;
  }

  private async poll(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;
    try {
      const detected = process.platform === 'darwin'
        ? await this.detectMacOS()
        : process.platform === 'win32'
          ? await this.detectWindows()
          : null;

      if (detected) {
        this.consecutiveNonDetections = 0;
        this.consecutiveDetections++;

        if (!this.currentMeeting && this.consecutiveDetections >= MeetingDetectorService.START_THRESHOLD) {
          this.currentMeeting = { app: detected, detectedAt: new Date() };
          this.emit('meeting-started', { app: detected, detectedAt: this.currentMeeting.detectedAt });
          console.log(`Meeting started: ${detected}`);
        }
      } else {
        this.consecutiveDetections = 0;
        this.consecutiveNonDetections++;

        if (this.currentMeeting && this.consecutiveNonDetections >= MeetingDetectorService.END_THRESHOLD) {
          const duration = Date.now() - this.currentMeeting.detectedAt.getTime();
          const app = this.currentMeeting.app;
          this.currentMeeting = null;
          this.emit('meeting-ended', { app, duration });
          console.log(`Meeting ended: ${app} (${Math.round(duration / 1000)}s)`);
        }
      }
    } catch (error) {
      console.error('Meeting detection poll error:', error);
    } finally {
      this.isPolling = false;
    }
  }

  private async detectMacOS(): Promise<string | null> {
    // Check native meeting apps via pgrep (lightweight, no full process list)
    // and Google Meet via AppleScript in parallel
    const [hasZoom, hasTeamsNew, hasTeamsOld, meetBrowser] = await Promise.all([
      this.pgrepExists('CptHost'),
      this.pgrepExists('MSTeams'),
      this.pgrepExists('ms-teams'),
      this.checkGoogleMeetMacOS()
    ]);
    const hasTeams = hasTeamsNew || hasTeamsOld;

    // Zoom: CptHost child process only exists during active calls
    if (hasZoom) return 'Zoom';

    // Microsoft Teams
    if (hasTeams) return 'Microsoft Teams';

    // Google Meet via browser window title
    if (meetBrowser) return 'Google Meet';

    return null;
  }

  private async pgrepExists(name: string): Promise<boolean> {
    try {
      await execFileAsync('pgrep', ['-x', name]);
      return true;
    } catch {
      return false; // pgrep exits non-zero when no match
    }
  }

  private async checkGoogleMeetMacOS(): Promise<string | null> {
    const script = `
tell application "System Events"
  set browserList to {"Google Chrome", "Arc", "Microsoft Edge", "Brave Browser", "Safari", "ChatGPT Atlas", "Comet", "Opera", "Vivaldi", "Zen Browser", "Orion", "Sidekick", "Wavebox", "Naver Whale", "Firefox"}
  repeat with browserName in browserList
    if exists (process browserName) then
      tell process browserName
        repeat with w in windows
          set winName to name of w
          if winName contains "Meet -" or winName contains "Meet \u2013" then
            return browserName as text
          end if
        end repeat
      end tell
    end if
  end repeat
end tell
return "none"`;
    try {
      const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 3000 });
      const result = stdout.trim();
      return result !== 'none' && result !== '' ? result : null;
    } catch {
      return null;
    }
  }

  private async detectWindows(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('tasklist', ['/FO', 'CSV', '/NH']);
      if (stdout.includes('"CptHost.exe"')) return 'Zoom';
      if (stdout.includes('"ms-teams.exe"') || stdout.includes('"Teams.exe"')) return 'Microsoft Teams';
      return null;
    } catch {
      return null;
    }
  }
}
