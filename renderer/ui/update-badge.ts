// Auto-update badge in the header.
// Extracted from legacy.ts (~lines 403-489). Behavior preserved verbatim.

type BadgeState =
  | { type: 'idle' }
  | { type: 'available'; version?: string }
  | { type: 'downloading'; version?: string; percent?: number }
  | { type: 'downloaded'; version?: string };

let updateBadgeEl: HTMLButtonElement | null = null;
let updateBadgeState: BadgeState = { type: 'idle' };

function renderUpdateBadge(state: BadgeState | undefined | null): void {
  updateBadgeState = state || { type: 'idle' };
  if (!updateBadgeEl) return;

  updateBadgeEl.classList.remove('is-downloading', 'is-ready');

  switch (updateBadgeState.type) {
    case 'available':
      updateBadgeEl.hidden = false;
      updateBadgeEl.disabled = false;
      updateBadgeEl.title = updateBadgeState.version
        ? `Click to download version ${updateBadgeState.version}`
        : 'Click to download the new version';
      updateBadgeEl.textContent = updateBadgeState.version
        ? `Update to v${updateBadgeState.version}`
        : 'Update available';
      break;
    case 'downloading': {
      updateBadgeEl.hidden = false;
      updateBadgeEl.disabled = true;
      updateBadgeEl.classList.add('is-downloading');
      const percent = Math.max(0, Math.min(100, Math.round(updateBadgeState.percent || 0)));
      updateBadgeEl.title = 'Downloading update...';
      updateBadgeEl.textContent = `Downloading ${percent}%`;
      break;
    }
    case 'downloaded':
      updateBadgeEl.hidden = false;
      updateBadgeEl.disabled = false;
      updateBadgeEl.classList.add('is-ready');
      updateBadgeEl.title = 'Click to restart and install';
      updateBadgeEl.textContent = updateBadgeState.version
        ? `Restart to install v${updateBadgeState.version}`
        : 'Restart to install';
      break;
    default:
      updateBadgeEl.hidden = true;
      updateBadgeEl.disabled = false;
      updateBadgeEl.textContent = '';
      updateBadgeEl.title = '';
  }
}

export function setupUpdateBadge(): void {
  updateBadgeEl = document.getElementById('updateBadge') as HTMLButtonElement | null;

  if (updateBadgeEl) {
    updateBadgeEl.addEventListener('click', () => {
      if (updateBadgeState.type === 'available' && window.electronAPI.downloadUpdate) {
        window.electronAPI.downloadUpdate();
      } else if (updateBadgeState.type === 'downloaded' && window.electronAPI.installUpdate) {
        window.electronAPI.installUpdate();
      }
    });
  }

  if (window.electronAPI.getUpdateState) {
    window.electronAPI
      .getUpdateState()
      .then((s) => renderUpdateBadge(s as BadgeState))
      .catch(() => renderUpdateBadge({ type: 'idle' }));
  }

  if (window.electronAPI.onUpdateStatus) {
    window.electronAPI.onUpdateStatus((updateInfo) => {
      switch (updateInfo.event) {
        case 'update-available':
          renderUpdateBadge({ type: 'available', version: updateInfo.data?.version });
          break;
        case 'download-progress':
          renderUpdateBadge({
            type: 'downloading',
            version: updateInfo.data?.version,
            percent: updateInfo.data?.percent || 0,
          });
          break;
        case 'update-downloaded':
          renderUpdateBadge({ type: 'downloaded', version: updateInfo.data?.version });
          break;
        case 'update-error':
        case 'update-not-available':
          renderUpdateBadge({ type: 'idle' });
          break;
      }
    });
  }
}
