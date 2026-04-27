// FFmpeg download progress dialog.
// Extracted from legacy.ts (~lines 2258-2353). Behavior preserved verbatim.

// `startRecording` lives in audio/recorder; this module is only invoked when
// the user clicks Record and ffmpeg is missing. Once the download completes we
// re-trigger startRecording. We import lazily via a globally-resolved symbol
// to avoid a circular dependency between the audio recorder and this UI module.
declare global {
  interface Window {
    __startRecording?: () => Promise<void> | void;
  }
}

type FFmpegProgress =
  | { status: 'preparing' }
  | { status: 'downloading'; percent: number; speed: string; eta: string }
  | { status: 'extracting' }
  | { status: 'verifying' }
  | { status: 'complete' }
  | { status: 'error' };

export async function showFFmpegDownloadDialog(): Promise<void> {
  const overlay = document.getElementById('ffmpegDownloadOverlay');
  if (!overlay) return;

  // Show the overlay
  overlay.style.display = 'block';

  // Reset progress
  const progressFillEl = document.getElementById('ffmpegProgressFill');
  const progressPercentEl = document.getElementById('ffmpegProgressPercent');
  const downloadSpeedEl = document.getElementById('downloadSpeed');
  const downloadEtaEl = document.getElementById('downloadEta');
  const downloadStatusEl = document.getElementById('downloadStatus');

  if (progressFillEl) (progressFillEl as HTMLElement).style.width = '0%';
  if (progressPercentEl) progressPercentEl.textContent = '0%';
  if (downloadSpeedEl) downloadSpeedEl.textContent = '0 MB/s';
  if (downloadEtaEl) downloadEtaEl.textContent = 'Calculating...';
  if (downloadStatusEl) downloadStatusEl.textContent = 'Downloading FFmpeg for audio recording...';

  // Setup cancel button
  const cancelBtn = document.getElementById('cancelDownload') as HTMLButtonElement | null;
  if (cancelBtn) {
    cancelBtn.onclick = async () => {
      await window.electronAPI.cancelFFmpegDownload();
      overlay.style.display = 'none';
    };
  }

  // Listen for progress updates
  const progressHandler = (progress: FFmpegProgress) => {
    switch (progress.status) {
      case 'preparing':
        if (downloadStatusEl) downloadStatusEl.textContent = 'Preparing download...';
        break;
      case 'downloading':
        if (downloadStatusEl) downloadStatusEl.textContent = 'Downloading FFmpeg...';
        if (progressFillEl) (progressFillEl as HTMLElement).style.width = `${progress.percent}%`;
        if (progressPercentEl) progressPercentEl.textContent = `${progress.percent}%`;
        if (downloadSpeedEl) downloadSpeedEl.textContent = progress.speed;
        if (downloadEtaEl) downloadEtaEl.textContent = progress.eta;
        break;
      case 'extracting':
        if (downloadStatusEl) downloadStatusEl.textContent = 'Extracting FFmpeg...';
        if (progressFillEl) (progressFillEl as HTMLElement).style.width = '90%';
        if (progressPercentEl) progressPercentEl.textContent = '90%';
        break;
      case 'verifying':
        if (downloadStatusEl) downloadStatusEl.textContent = 'Verifying installation...';
        if (progressFillEl) (progressFillEl as HTMLElement).style.width = '95%';
        if (progressPercentEl) progressPercentEl.textContent = '95%';
        break;
      case 'complete':
        if (downloadStatusEl) downloadStatusEl.textContent = 'FFmpeg installed successfully!';
        if (progressFillEl) (progressFillEl as HTMLElement).style.width = '100%';
        if (progressPercentEl) progressPercentEl.textContent = '100%';
        setTimeout(() => {
          overlay.style.display = 'none';
          // Try to start recording again
          if (typeof window.__startRecording === 'function') {
            window.__startRecording();
          }
        }, 1000);
        break;
      case 'error':
        if (downloadStatusEl) {
          downloadStatusEl.textContent = 'Download failed. Please try again.';
          (downloadStatusEl as HTMLElement).style.color = '#e74c3c';
        }
        if (cancelBtn) cancelBtn.textContent = 'Close';
        break;
    }
  };

  // Register progress handler
  window.electronAPI.onFFmpegDownloadProgress(progressHandler);

  // Start download
  try {
    const result = await window.electronAPI.downloadFFmpeg();
    if (!result.success) {
      if (downloadStatusEl) {
        downloadStatusEl.textContent = `Download failed: ${result.error}`;
        (downloadStatusEl as HTMLElement).style.color = '#e74c3c';
      }
      if (cancelBtn) cancelBtn.textContent = 'Close';
    }
  } catch (error) {
    const downloadStatus = document.getElementById('downloadStatus');
    if (downloadStatus) {
      const message = error instanceof Error ? error.message : String(error);
      downloadStatus.textContent = `Download error: ${message}`;
      (downloadStatus as HTMLElement).style.color = '#e74c3c';
    }
    if (cancelBtn) cancelBtn.textContent = 'Close';
  }
}
