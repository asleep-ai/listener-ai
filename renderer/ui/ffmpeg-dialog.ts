// FFmpeg download progress dialog.
//
// Shows the download overlay (`#ffmpegDownloadOverlay`) and drives it via the
// `download-ffmpeg` IPC + `onFFmpegDownloadProgress` events. Returns a Promise
// that resolves once the download completes, fails, or is cancelled. Callers
// decide what to do next (e.g. retry transcription).

type FFmpegProgress =
  | { status: 'preparing' }
  | { status: 'downloading'; percent: number; speed: string; eta: string }
  | { status: 'extracting' }
  | { status: 'verifying' }
  | { status: 'complete' }
  | { status: 'error' };

export type FFmpegDialogResult =
  | { success: true }
  | { success: false; reason: 'cancelled' | 'error'; error?: string };

export function showFFmpegDownloadDialog(): Promise<FFmpegDialogResult> {
  return new Promise((resolve) => {
    const overlay = document.getElementById('ffmpegDownloadOverlay') as HTMLDialogElement | null;
    if (!overlay) {
      resolve({ success: false, reason: 'error', error: 'FFmpeg dialog overlay not found' });
      return;
    }

    if (!overlay.open) overlay.showModal();

    const progressFillEl = document.getElementById('ffmpegProgressFill');
    const progressPercentEl = document.getElementById('ffmpegProgressPercent');
    const downloadSpeedEl = document.getElementById('downloadSpeed');
    const downloadEtaEl = document.getElementById('downloadEta');
    const downloadStatusEl = document.getElementById('downloadStatus');
    const cancelBtn = document.getElementById('cancelDownload') as HTMLButtonElement | null;

    // Reset visual state -- a previous run could have left it stuck on success.
    if (progressFillEl) (progressFillEl as HTMLElement).style.width = '0%';
    if (progressPercentEl) progressPercentEl.textContent = '0%';
    if (downloadSpeedEl) downloadSpeedEl.textContent = '0 MB/s';
    if (downloadEtaEl) downloadEtaEl.textContent = 'Calculating...';
    if (downloadStatusEl) {
      downloadStatusEl.textContent = 'Downloading FFmpeg for audio recording...';
      (downloadStatusEl as HTMLElement).style.color = '';
    }
    if (cancelBtn) cancelBtn.textContent = 'Cancel';

    // Route ESC through the cancel button so it cancels the in-flight download
    // and settles the promise, instead of the dialog's default close-only
    // behavior (which would leave the caller awaiting forever).
    const onEscape = (e: Event): void => {
      e.preventDefault();
      cancelBtn?.click();
    };
    overlay.addEventListener('cancel', onEscape);

    let settled = false;
    const settle = (result: FFmpegDialogResult) => {
      if (settled) return;
      settled = true;
      overlay.removeEventListener('cancel', onEscape);
      overlay.close();
      resolve(result);
    };

    if (cancelBtn) {
      cancelBtn.onclick = async () => {
        await window.electronAPI.cancelFFmpegDownload();
        settle({ success: false, reason: 'cancelled' });
      };
    }

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
          // Drop ESC routing now -- during the 1s success-display window an
          // ESC would otherwise race the setTimeout below and settle as
          // `cancelled` for a download that actually succeeded.
          overlay.removeEventListener('cancel', onEscape);
          setTimeout(() => settle({ success: true }), 1000);
          break;
        case 'error':
          if (downloadStatusEl) {
            downloadStatusEl.textContent = 'Download failed. Please try again.';
            (downloadStatusEl as HTMLElement).style.color = '#e74c3c';
          }
          if (cancelBtn) cancelBtn.textContent = 'Close';
          // settle on error too -- but only after the user dismisses, so caller
          // can show a toast and the user can retry without the dialog stuck.
          if (cancelBtn) {
            cancelBtn.onclick = () => settle({ success: false, reason: 'error' });
          }
          break;
      }
    };

    window.electronAPI.onFFmpegDownloadProgress(progressHandler);

    // Drive the actual download. The progress handler above resolves the
    // promise on `complete`/`error`; this catches network/spawn failures that
    // bypass the progress channel.
    (async () => {
      try {
        const result = await window.electronAPI.downloadFFmpeg();
        if (!result.success) {
          if (downloadStatusEl) {
            downloadStatusEl.textContent = `Download failed: ${result.error}`;
            (downloadStatusEl as HTMLElement).style.color = '#e74c3c';
          }
          if (cancelBtn) {
            cancelBtn.textContent = 'Close';
            cancelBtn.onclick = () =>
              settle({ success: false, reason: 'error', error: result.error });
          } else {
            settle({ success: false, reason: 'error', error: result.error });
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (downloadStatusEl) {
          downloadStatusEl.textContent = `Download error: ${message}`;
          (downloadStatusEl as HTMLElement).style.color = '#e74c3c';
        }
        if (cancelBtn) {
          cancelBtn.textContent = 'Close';
          cancelBtn.onclick = () => settle({ success: false, reason: 'error', error: message });
        } else {
          settle({ success: false, reason: 'error', error: message });
        }
      }
    })();
  });
}
