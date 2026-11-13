// Microphone selector dropdown wiring extracted from legacy.ts.
// - populateAudioDevices fills #audioDeviceId with the available audio inputs.
// - setupMicSelector wires the change handler so the user's pick is persisted
//   and (when actively recording) hot-swapped into the capture host's audio graph.
//
// State.isRecording lives on the shared state object so a switchMicDevice call
// only fires when a session is in progress.

import { state } from '../state';
import { reportError } from '../sentry';
import { showToast } from './notifications';

let audioDeviceIdSelect: HTMLSelectElement | null = null;

function getSelect(): HTMLSelectElement | null {
  if (!audioDeviceIdSelect) {
    audioDeviceIdSelect = document.getElementById('audioDeviceId') as HTMLSelectElement | null;
  }
  return audioDeviceIdSelect;
}

// Without prior mic permission, enumerateDevices returns entries with empty
// labels; fall back to a deviceId-prefix so users can at least distinguish them.
// Chromium's virtual "default"/"communications" aliases are dropped — our
// explicit "System default" option already covers that.
export async function populateAudioDevices(selectedId?: string): Promise<void> {
  const select = getSelect();
  if (!select) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter(
      (d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications',
    );
    select.innerHTML = '<option value="">System default (at start)</option>';
    for (const device of inputs) {
      const option = document.createElement('option');
      option.value = device.deviceId;
      if (device.label) {
        option.textContent = device.label;
      } else {
        const suffix = device.deviceId ? device.deviceId.slice(0, 8) : '';
        option.textContent = suffix ? `Microphone (${suffix}…)` : 'Microphone';
      }
      select.appendChild(option);
    }
    select.value = selectedId && inputs.some((d) => d.deviceId === selectedId) ? selectedId : '';
  } catch (error) {
    console.warn('Failed to enumerate audio devices:', error);
    reportError(error, { operation: 'mic.enumerate', severity: 'warning' });
  }
}

export function setupMicSelector(): void {
  const select = getSelect();
  if (!select) return;

  if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === 'function') {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      void populateAudioDevices(select.value);
    });
  }

  select.addEventListener('change', async () => {
    const newId = select.value;
    await window.electronAPI.saveConfig({ audioDeviceId: newId });
    if (state.isRecording) {
      // The capture host owns the graph; main forwards the hot-swap to it.
      const { success } = await window.electronAPI.switchRecordingMic(newId);
      showToast(
        success ? 'Switched mic' : 'Failed to switch mic — keeping current',
        success ? 'success' : 'error',
      );
    }
  });
}
