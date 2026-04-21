import { EventEmitter } from 'events';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

interface MeetingInfo {
  app: string;
  detectedAt: Date;
}

// True if `pmset -g assertions` output has any `PreventUserIdle{Display,System}Sleep`
// assertion whose owning process matches `processPattern`. Video-call apps raise
// these assertions only while a call is active, so this distinguishes "app open"
// from "in a call" when the app's main process stays alive throughout.
export function hasSleepAssertionFrom(pmsetOutput: string, processPattern: RegExp): boolean {
  if (!pmsetOutput) return false;
  let ownerMatches = false;
  for (const line of pmsetOutput.split('\n')) {
    const pidMatch = line.match(/pid \d+\((.+?)\):/);
    if (pidMatch) {
      ownerMatches = processPattern.test(pidMatch[1]);
    }
    if (ownerMatches && /PreventUserIdle(Display|System)Sleep/.test(line)) return true;
  }
  return false;
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
    if (this.currentMeeting) {
      const duration = Date.now() - this.currentMeeting.detectedAt.getTime();
      const app = this.currentMeeting.app;
      this.currentMeeting = null;
      this.emit('meeting-ended', { app, duration });
      console.log(`Meeting ended: ${app} (${Math.round(duration / 1000)}s)`);
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
    // Zoom uses a call-only subprocess (CptHost). Teams and Webex keep their main
    // process running as long as the app is open, so we inspect pmset power assertions
    // instead: both apps create a PreventUserIdleDisplaySleep assertion only while a
    // call is active.
    const [hasZoom, assertions, meetBrowser, hasSlackHuddle] = await Promise.all([
      this.pgrepExists('CptHost'),
      this.getPmsetAssertions(),
      this.checkGoogleMeetMacOS(),
      this.checkSlackHuddleMacOS()
    ]);

    if (hasZoom) return 'Zoom';

    if (assertions.includes('Microsoft Teams Call in progress')) return 'Microsoft Teams';

    if (hasSleepAssertionFrom(assertions, /^Webex$|^Cisco Webex/i)) return 'Webex';

    if (meetBrowser) return 'Google Meet';

    if (hasSlackHuddle) return 'Slack Huddle';

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

  private async getPmsetAssertions(): Promise<string> {
    try {
      const { stdout } = await execFileAsync('pmset', ['-g', 'assertions'], { timeout: 3000 });
      return stdout;
    } catch {
      return '';
    }
  }

  private async checkGoogleMeetMacOS(): Promise<string | null> {
    // Two-step: first get running process names (fast), then only check windows of matching browsers
    const script = `
tell application "System Events"
  set allProcs to name of every process
  set browserList to {"Google Chrome", "Arc", "Microsoft Edge", "Brave Browser", "Safari", "ChatGPT Atlas", "Comet", "Opera", "Vivaldi", "Zen Browser", "Orion", "Sidekick", "Wavebox", "Naver Whale", "Firefox"}
  repeat with browserName in browserList
    if allProcs contains browserName then
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
      const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 5000 });
      const result = stdout.trim();
      return result !== 'none' && result !== '' ? result : null;
    } catch {
      return null;
    }
  }

  private async checkSlackHuddleMacOS(): Promise<boolean> {
    const script = `
tell application "System Events"
  if exists process "Slack" then
    tell process "Slack"
      if (count of (windows whose name starts with "Huddle:")) > 0 then return true
    end tell
  end if
end tell
return false`;
    try {
      const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 3000 });
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  private async detectWindows(): Promise<string | null> {
    // Pick call-only child processes so background app presence doesn't false-trigger:
    // - Zoom: CptHost.exe (existing)
    // - Teams (New, Jan 2026+): ms-teams_modulehost.exe hosts the calling stack
    // - Webex: webexhost.exe is spawned for the meeting session (CiscoCollabHost.exe
    //   would false-trigger because it runs while the app is idle)
    const [hasZoom, hasTeamsCall, hasWebexCall] = await Promise.all([
      this.tasklistExists('CptHost.exe'),
      this.tasklistExists('ms-teams_modulehost.exe'),
      this.tasklistExists('webexhost.exe')
    ]);
    if (hasZoom) return 'Zoom';
    if (hasTeamsCall) return 'Microsoft Teams';
    if (hasWebexCall) return 'Webex';
    return null;
  }

  private async tasklistExists(imageName: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('tasklist', ['/FI', `IMAGENAME eq ${imageName}`, '/NH']);
      return stdout.includes(imageName);
    } catch {
      return false;
    }
  }
}
