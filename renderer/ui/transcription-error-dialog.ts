// Transcription error dialog. Friendly message as the headline; HTTP
// status / request-id / error code / raw response body live behind a
// collapsible "Show details" with a clipboard copy button, so a failing
// run can be reported with the actual upstream response intact.

import type { TranscriptionErrorPayload } from '../electronAPI';
import { showToast } from './notifications';

export function showTranscriptionErrorDialog(
  details: TranscriptionErrorPayload | undefined,
  fallbackMessage: string,
): Promise<void> {
  return new Promise((resolve) => {
    const dialog = document.getElementById('transcriptionErrorDialog') as HTMLDialogElement | null;
    const messageEl = document.getElementById('transcriptionErrorMessage');
    const detailsBlock = document.getElementById(
      'transcriptionErrorDetailsBlock',
    ) as HTMLDetailsElement | null;
    const detailTextEl = document.getElementById('transcriptionErrorDetailText');
    const copyBtn = document.getElementById(
      'transcriptionErrorCopyBtn',
    ) as HTMLButtonElement | null;
    const okBtn = document.getElementById('transcriptionErrorOkBtn') as HTMLButtonElement | null;

    // Defensive fallback: if the markup is missing for any reason, surface the
    // friendly message via the browser alert so the user still sees something.
    if (!dialog || !messageEl || !detailsBlock || !detailTextEl || !copyBtn || !okBtn) {
      alert(details?.userMessage ?? fallbackMessage);
      resolve();
      return;
    }

    const headline = details?.userMessage ?? fallbackMessage;
    messageEl.textContent = headline;

    const detailLines: string[] = [];
    if (details) {
      if (details.status !== undefined) {
        detailLines.push(`HTTP ${details.status} ${details.statusText ?? ''}`.trim());
      }
      if (details.errorType) detailLines.push(`error.type:  ${details.errorType}`);
      if (details.errorCode) detailLines.push(`error.code:  ${details.errorCode}`);
      if (details.requestId) detailLines.push(`x-request-id: ${details.requestId}`);
      if (details.rawMessage && details.rawMessage !== details.userMessage) {
        detailLines.push('', `raw message: ${details.rawMessage}`);
      }
      if (details.rawBody) {
        detailLines.push('', '--- response body ---', details.rawBody);
      }
    }
    const hasDetails = detailLines.length > 0;
    detailsBlock.style.display = hasDetails ? '' : 'none';
    detailsBlock.open = false;
    detailTextEl.textContent = detailLines.join('\n');

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      dialog.removeEventListener('cancel', onCancel);
      okBtn.onclick = null;
      copyBtn.onclick = null;
      if (dialog.open) dialog.close();
      resolve();
    };

    const onCancel = (e: Event) => {
      // No async cleanup needed, but route ESC through `settle()` so we always
      // remove listeners -- the dialog might be reopened on a retry, and stale
      // handlers would fire twice. Default ESC behavior would just close.
      e.preventDefault();
      settle();
    };
    dialog.addEventListener('cancel', onCancel);

    okBtn.onclick = settle;

    copyBtn.onclick = async () => {
      const payload = [headline, '', ...detailLines].filter((s) => s.length > 0).join('\n');
      try {
        await navigator.clipboard.writeText(payload);
        showToast('Details copied to clipboard');
      } catch {
        showToast('Copy failed', 'error');
      }
    };

    if (!dialog.open) dialog.showModal();
  });
}
