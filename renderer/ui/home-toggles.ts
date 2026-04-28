// Home-screen toggle wiring extracted from legacy.ts.
//
// Covers the four config-backed checkboxes shown above the recording controls:
//   - autoModeToggle           (autoMode)
//   - meetingDetectionToggle   (meetingDetection)
//   - displayDetectionToggle   (displayDetection)
//   - recordSystemAudioToggle  (recordSystemAudio, macOS-only)
//
// Both the user toggling them and the agent applying a set_config write
// should land here -- the agent path goes through the 'config-changed' event
// subscription installed below.

import { probeSystemAudio } from '../audio/system-audio';
import { populateAudioDevices } from './mic-selector';
import { showNotification } from './notifications';
import { refreshSystemAudioPermissionStatus } from './permission-status';

type HomeConfig = {
  autoMode?: boolean;
  meetingDetection?: boolean;
  displayDetection?: boolean;
  recordSystemAudio?: boolean;
  audioDeviceId?: string;
};

function applyHomeTogglesFromConfig(
  cfg: HomeConfig | undefined,
  refs: {
    autoModeToggle: HTMLInputElement;
    meetingDetectionToggle: HTMLInputElement;
    displayDetectionToggle: HTMLInputElement;
    recordSystemAudioToggle: HTMLInputElement | null;
    audioDeviceIdSelect: HTMLSelectElement | null;
  },
): void {
  if (!cfg) return;
  if (cfg.autoMode !== undefined) refs.autoModeToggle.checked = !!cfg.autoMode;
  if (cfg.meetingDetection !== undefined)
    refs.meetingDetectionToggle.checked = !!cfg.meetingDetection;
  if (cfg.displayDetection !== undefined)
    refs.displayDetectionToggle.checked = !!cfg.displayDetection;
  if (cfg.recordSystemAudio !== undefined && refs.recordSystemAudioToggle) {
    refs.recordSystemAudioToggle.checked = !!cfg.recordSystemAudio;
  }
  if (refs.audioDeviceIdSelect && typeof cfg.audioDeviceId === 'string') {
    void populateAudioDevices(cfg.audioDeviceId);
  }
}

export async function setupHomeToggles(): Promise<void> {
  const autoModeToggle = document.getElementById('autoModeToggle') as HTMLInputElement | null;
  const meetingDetectionToggle = document.getElementById(
    'meetingDetectionToggle',
  ) as HTMLInputElement | null;
  const meetingDetectionStatus = document.getElementById('meetingDetectionStatus');
  const meetingDetectionApp = document.getElementById('meetingDetectionApp');
  const displayDetectionToggle = document.getElementById(
    'displayDetectionToggle',
  ) as HTMLInputElement | null;
  const systemAudioContainer = document.getElementById('systemAudioContainer');
  const recordSystemAudioToggle = document.getElementById(
    'recordSystemAudioToggle',
  ) as HTMLInputElement | null;
  const audioDeviceIdSelect = document.getElementById('audioDeviceId') as HTMLSelectElement | null;

  if (!autoModeToggle || !meetingDetectionToggle || !displayDetectionToggle) return;

  // System audio loopback only works on macOS (SCK/Catap are macOS-only features).
  if (systemAudioContainer && window.electronAPI.platform === 'darwin') {
    systemAudioContainer.style.display = '';
  }

  const refs = {
    autoModeToggle,
    meetingDetectionToggle,
    displayDetectionToggle,
    recordSystemAudioToggle,
    audioDeviceIdSelect,
  };

  const config = (await window.electronAPI.getConfig()) as HomeConfig;
  applyHomeTogglesFromConfig(config, refs);
  refreshSystemAudioPermissionStatus();
  if (audioDeviceIdSelect) void populateAudioDevices(config.audioDeviceId || '');

  autoModeToggle.addEventListener('change', async () => {
    await window.electronAPI.saveConfig({ autoMode: autoModeToggle.checked });
  });
  meetingDetectionToggle.addEventListener('change', async () => {
    await window.electronAPI.saveConfig({ meetingDetection: meetingDetectionToggle.checked });
  });
  displayDetectionToggle.addEventListener('change', async () => {
    await window.electronAPI.saveConfig({ displayDetection: displayDetectionToggle.checked });
  });
  if (recordSystemAudioToggle) {
    // Probe the system-audio permission at toggle time so the user sees the macOS
    // prompt (and any denial UX) up front rather than mid-recording.
    recordSystemAudioToggle.addEventListener('change', async () => {
      if (!recordSystemAudioToggle.checked) {
        await window.electronAPI.saveConfig({ recordSystemAudio: false });
        refreshSystemAudioPermissionStatus();
        return;
      }
      const probe = await probeSystemAudio();
      if (probe.ok) {
        await window.electronAPI.saveConfig({ recordSystemAudio: true });
      } else {
        recordSystemAudioToggle.checked = false;
        if (probe.denied) {
          const open = confirm(
            'System Audio Recording permission is required.\n\n' +
              'Open System Settings to grant it?',
          );
          if (open) {
            await window.electronAPI.openScreenRecordingSettings();
          }
        } else {
          showNotification('System audio capture unavailable on this system.', 'error');
        }
      }
      refreshSystemAudioPermissionStatus();
    });
  }

  // Agent-applied config writes arrive here so the home toggles stay in sync
  // without requiring the user to reopen the settings dialog.
  window.electronAPI.onConfigChanged((cfg) => {
    applyHomeTogglesFromConfig(cfg as HomeConfig, refs);
  });

  // Listen for meeting status changes
  window.electronAPI.onMeetingStatusChanged((status) => {
    if (!meetingDetectionStatus || !meetingDetectionApp) return;
    if (status.active) {
      meetingDetectionStatus.style.display = 'flex';
      meetingDetectionApp.textContent = `${status.app} meeting detected`;
    } else {
      meetingDetectionStatus.style.display = 'none';
    }
  });
}
