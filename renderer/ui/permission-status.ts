// Manages the #systemAudioPermissionStatus badge and the related #systemAudioTip.
// Extracted from the system-audio toggle block in legacy.ts.
//
// The system-audio permission (macOS "System Audio Recording Only") isn't
// queryable via Electron's systemPreferences API. We reflect the UI state from
// the toggle: if it's on, config says the probe succeeded before, so assume
// granted. The home-toggles module re-probes on toggle interaction and calls
// refreshSystemAudioPermissionStatus() afterwards to update from the result.

let permissionStatusEl: HTMLElement | null = null;
let systemAudioTipEl: HTMLElement | null = null;
let recordSystemAudioToggleEl: HTMLInputElement | null = null;

type PermissionState = 'not-determined' | 'granted';

function setPermissionStatus(stateLabel: PermissionState, build: (el: HTMLElement) => void): void {
  if (!permissionStatusEl) return;
  permissionStatusEl.hidden = false;
  permissionStatusEl.replaceChildren();
  permissionStatusEl.dataset.state = stateLabel;
  build(permissionStatusEl);
}

export function refreshSystemAudioPermissionStatus(): void {
  if (!permissionStatusEl) return;
  const on = !!recordSystemAudioToggleEl?.checked;
  if (systemAudioTipEl) systemAudioTipEl.hidden = !on;
  if (!on) {
    setPermissionStatus('not-determined', (el) => {
      el.textContent = 'Permission will be requested when you enable this';
    });
    return;
  }
  setPermissionStatus('granted', (el) => {
    el.textContent = '✓ System Audio permission granted';
  });
}

export function setupPermissionStatus(): void {
  permissionStatusEl = document.getElementById('systemAudioPermissionStatus');
  systemAudioTipEl = document.getElementById('systemAudioTip');
  recordSystemAudioToggleEl = document.getElementById(
    'recordSystemAudioToggle',
  ) as HTMLInputElement | null;
}
