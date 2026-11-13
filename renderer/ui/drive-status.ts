// Main-window Google Drive sync line. Sync runs in main on its own schedule
// whether or not any window is open; this line only shows that work (and the
// last failure) without opening Settings. It re-reads main's status on every
// sync event and once a minute, so a reload or a long idle stretch shows the
// current state rather than whatever this page last saw. Deliberately not a
// live region: a periodic background sync must not interrupt screen readers.

let lineEl: HTMLElement | null = null;
let refreshToken = 0;

export function formatLastSynced(iso: string | null | undefined): string {
  if (!iso) return 'Never synced';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'Synced just now';
  if (mins < 60) return `Synced ${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `Synced ${hrs}h ago`;
  return `Synced ${Math.floor(hrs / 24)}d ago`;
}

export function driveStatusLineText(s: {
  inFlight: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
}): string {
  if (s.inFlight) return 'Google Drive: Syncing...';
  if (s.lastError) return `Google Drive: ${s.lastError} (${formatLastSynced(s.lastSyncedAt)})`;
  return `Google Drive: ${formatLastSynced(s.lastSyncedAt)}`;
}

async function refreshDriveStatusLine(): Promise<void> {
  if (!lineEl) return;
  const token = ++refreshToken;
  try {
    const s = await window.electronAPI.getGoogleSyncStatus();
    if (token !== refreshToken || !lineEl) return;
    const visible = s.enabled && s.authenticated;
    lineEl.hidden = !visible;
    if (!visible) return;
    const text = driveStatusLineText(s);
    if (lineEl.textContent !== text) lineEl.textContent = text;
    lineEl.dataset.tone = s.inFlight ? 'busy' : s.lastError ? 'error' : 'ok';
  } catch {
    // Status is informational; a failed read keeps the previous line.
  }
}

export function setupDriveStatusLine(): void {
  lineEl = document.getElementById('driveSyncStatus');
  if (!lineEl) return;
  window.electronAPI.onGoogleSyncStatus(() => void refreshDriveStatusLine());
  setInterval(() => void refreshDriveStatusLine(), 60_000);
  void refreshDriveStatusLine();
}
