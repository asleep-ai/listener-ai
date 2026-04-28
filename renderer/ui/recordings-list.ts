// Recordings list, item rendering, M4A export, and the merge-recordings dialog.
// Extracted from legacy.ts (~lines 1694-2092).
//
// loadRecordings re-renders the full list from main; refreshRecordingsList
// preserves an active search query if one is showing instead of the default
// list. Both use a monotonic token so a slow per-item metadata read can't
// overwrite a fresher snapshot.

import { getDom } from '../state';
import { showToast } from './notifications';
import {
  _setCurrentTranscription,
  handleTranscribe,
  populateTranscriptionUI,
  prepareTranscriptionModal,
  showSavedTranscript,
} from './transcription-modal';

type Recording = {
  path: string;
  title: string;
  createdAt: string | number;
  size: number;
};

type GetRecordingsResult = { success: boolean; recordings: Recording[] };
type GetMetadataResult = {
  success: boolean;
  data?: Record<string, unknown> & { transcript?: unknown };
};
type ExportM4AResult = { success?: boolean; canceled?: boolean; code?: string; error?: string };
type MergeRecordingsResult = {
  success?: boolean;
  error?: string;
  code?: string;
  data?: Record<string, unknown>;
  mergedAudioPath?: string;
};

// Monotonic token so a slow loadRecordings (per-item async metadata reads)
// can't overwrite a fresher snapshot's render. Mirrors lastSearchToken.
let lastLoadRecordingsToken = 0;

export async function loadRecordings(): Promise<void> {
  const { recordingsList } = getDom();
  const myToken = ++lastLoadRecordingsToken;
  try {
    const result = (await window.electronAPI.getRecordings()) as unknown as GetRecordingsResult;

    if (result.success && result.recordings.length > 0) {
      const items = await Promise.all(
        result.recordings.map((recording) => createRecordingItem(recording)),
      );
      // Drop if a newer load started while we were awaiting metadata.
      if (myToken !== lastLoadRecordingsToken) return;
      recordingsList.innerHTML = '';
      items.forEach((item) => recordingsList.appendChild(item));
    } else {
      if (myToken !== lastLoadRecordingsToken) return;
      recordingsList.innerHTML = '<p class="no-recordings">No recordings yet</p>';
    }
  } catch (error) {
    if (myToken !== lastLoadRecordingsToken) return;
    console.error('Error loading recordings:', error);
    recordingsList.innerHTML = '<p class="no-recordings">Error loading recordings</p>';
  }
}

// Function to create a recording item element
export async function createRecordingItem(recording: Recording): Promise<HTMLElement> {
  const item = document.createElement('div');
  item.className = 'recording-item';

  const date = new Date(recording.createdAt);
  const dateStr = date.toLocaleDateString();
  const timeStr = date.toLocaleTimeString();
  const sizeStr = formatFileSize(recording.size);

  // Check if metadata exists for this recording
  const metadataResult = (await window.electronAPI.getMetadata(
    recording.path,
  )) as unknown as GetMetadataResult;
  const hasTranscript = !!(
    metadataResult?.success &&
    metadataResult.data &&
    metadataResult.data.transcript
  );

  item.innerHTML = `
    <div class="recording-info">
      <h3>${recording.title}</h3>
      <p class="recording-meta">${dateStr} ${timeStr} • ${sizeStr}</p>
    </div>
    <div class="recording-actions">
      ${
        hasTranscript
          ? `
        <button class="action-button view-transcript-btn" data-path="${recording.path}" data-title="${recording.title}">
          View Transcript
        </button>
        <button class="action-button regenerate-btn" data-path="${recording.path}" data-title="${recording.title}" title="Regenerate transcript">
          🔄
        </button>
      `
          : `
        <button class="action-button transcribe-btn" data-path="${recording.path}" data-title="${recording.title}">
          Transcribe
        </button>
      `
      }
      <button class="action-button merge-btn" data-path="${recording.path}" title="Merge this with other recordings into a single note">
        Merge
      </button>
      <button class="action-button reveal-btn" data-path="${recording.path}" title="Reveal in Finder (right-click in Finder to share)">
        Show
      </button>
      <button class="action-button export-m4a-btn" data-path="${recording.path}" title="Export as M4A for sharing">
        M4A
      </button>
    </div>
  `;

  // Add event listeners based on available actions
  if (hasTranscript) {
    const viewBtn = item.querySelector('.view-transcript-btn') as HTMLButtonElement | null;
    viewBtn?.addEventListener('click', () => {
      showSavedTranscript(recording.path, recording.title, metadataResult.data);
    });

    const regenerateBtn = item.querySelector('.regenerate-btn') as HTMLButtonElement | null;
    regenerateBtn?.addEventListener('click', () => {
      if (
        confirm(
          'Are you sure you want to regenerate the transcript? This will overwrite the existing one.',
        )
      ) {
        void handleTranscribe(recording.path, recording.title);
      }
    });
  } else {
    const transcribeBtn = item.querySelector('.transcribe-btn') as HTMLButtonElement | null;
    transcribeBtn?.addEventListener('click', () => {
      void handleTranscribe(recording.path, recording.title);
    });
  }

  const revealBtn = item.querySelector('.reveal-btn') as HTMLButtonElement | null;
  if (revealBtn && window.electronAPI.showInFinder) {
    revealBtn.addEventListener('click', () => {
      void window.electronAPI.showInFinder(recording.path);
    });
  }

  const exportBtn = item.querySelector('.export-m4a-btn') as HTMLButtonElement | null;
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      void handleExportM4A(recording.path, exportBtn);
    });
  }

  const mergeBtn = item.querySelector('.merge-btn') as HTMLButtonElement | null;
  if (mergeBtn) {
    mergeBtn.addEventListener('click', () => {
      void openMergeDialog(recording.path);
    });
  }

  return item;
}

// On ffmpeg-missing, point the user at transcription (which downloads ffmpeg)
// rather than re-running the download UI for a one-off export.
async function handleExportM4A(srcPath: string, button: HTMLButtonElement): Promise<void> {
  if (!window.electronAPI.exportRecordingM4A) return;
  const originalLabel = button ? button.textContent : '';
  if (button) {
    button.disabled = true;
    button.textContent = 'Exporting…';
  }
  try {
    const result = (await window.electronAPI.exportRecordingM4A(
      srcPath,
    )) as unknown as ExportM4AResult;
    if (result?.canceled) {
      return;
    }
    if (result?.success) {
      showToast('Exported M4A');
      return;
    }
    if (result && result.code === 'ffmpeg-missing') {
      showToast('FFmpeg is required. Transcribe a recording to install it first.', 'error');
      return;
    }
    const message = result?.error ? result.error : 'Unknown error';
    showToast(`Failed to export M4A: ${message}`, 'error');
  } catch (error) {
    const message = error && (error as Error).message ? (error as Error).message : String(error);
    showToast(`Failed to export M4A: ${message}`, 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }
}

// --- Merge Recordings dialog ----------------------------------------------

async function openMergeDialog(initialFilePath: string): Promise<void> {
  const modal = document.getElementById('mergeModal');
  const list = document.getElementById('mergeList');
  const status = document.getElementById('mergeStatus');
  const titleInput = document.getElementById('mergeTitleInput') as HTMLInputElement | null;
  const confirmBtn = document.getElementById('mergeConfirmBtn') as HTMLButtonElement | null;
  const cancelBtn = document.getElementById('mergeCancelBtn');
  const closeBtn = document.getElementById('mergeModalClose');
  if (!modal || !list || !status || !titleInput || !confirmBtn || !cancelBtn || !closeBtn) {
    console.error('Merge modal elements missing');
    return;
  }

  status.textContent = '';
  status.classList.remove('error');
  titleInput.value = '';
  list.innerHTML = '<p class="merge-list-empty">Loading recordings...</p>';
  modal.style.display = 'block';

  let recordings: Recording[] = [];
  try {
    const result = (await window.electronAPI.getRecordings()) as unknown as GetRecordingsResult;
    recordings = result?.success ? result.recordings : [];
  } catch {
    list.innerHTML = '<p class="merge-list-empty">Failed to load recordings.</p>';
    return;
  }

  if (recordings.length < 2) {
    list.innerHTML = '<p class="merge-list-empty">Need at least 2 recordings to merge.</p>';
    confirmBtn.disabled = true;
    return;
  }

  // Seed with the clicked recording so the title-prefix heuristic below has
  // something to work with even before the user picks anything else.
  const selection: string[] = initialFilePath ? [initialFilePath] : [];

  list.innerHTML = '';
  for (const rec of recordings) {
    const li = document.createElement('li');
    li.dataset.path = rec.path;
    const date = new Date(rec.createdAt);
    const meta = `${date.toLocaleDateString()} ${date.toLocaleTimeString()} • ${formatFileSize(rec.size)}`;
    li.innerHTML = `
      <input type="checkbox" />
      <div class="merge-list-item-info">
        <div class="merge-list-item-title"></div>
        <div class="merge-list-item-meta"></div>
      </div>
      <div class="merge-list-order"></div>
    `;
    (li.querySelector('.merge-list-item-title') as HTMLElement).textContent =
      rec.title || 'Untitled';
    (li.querySelector('.merge-list-item-meta') as HTMLElement).textContent = meta;
    const checkbox = li.querySelector('input[type="checkbox"]') as HTMLInputElement;
    if (selection.includes(rec.path)) {
      checkbox.checked = true;
      li.classList.add('selected');
    }
    li.addEventListener('click', (e) => {
      // Skip when the click hits the checkbox itself -- otherwise the change
      // event fires twice.
      if (e.target !== checkbox) {
        checkbox.checked = !checkbox.checked;
      }
      onSelectionChange(rec.path, checkbox.checked, li);
    });
    list.appendChild(li);
  }

  function onSelectionChange(filePath: string, checked: boolean, li: HTMLElement): void {
    if (checked) {
      if (!selection.includes(filePath)) selection.push(filePath);
      li.classList.add('selected');
    } else {
      const idx = selection.indexOf(filePath);
      if (idx >= 0) selection.splice(idx, 1);
      li.classList.remove('selected');
    }
    updateOrderBadges();
    updateConfirmState();
    updateDefaultTitle();
  }

  function updateOrderBadges(): void {
    const items = list!.querySelectorAll('li');
    items.forEach((el) => {
      const badge = el.querySelector('.merge-list-order') as HTMLElement | null;
      const path = (el as HTMLElement).dataset.path || '';
      const idx = selection.indexOf(path);
      if (badge) badge.textContent = idx >= 0 ? String(idx + 1) : '';
    });
  }

  function updateConfirmState(): void {
    confirmBtn!.disabled = selection.length < 2;
    if (selection.length === 1) {
      status!.textContent = 'Select at least one more recording.';
      status!.classList.remove('error');
    } else {
      status!.textContent = '';
      status!.classList.remove('error');
    }
  }

  function updateDefaultTitle(): void {
    if (titleInput!.dataset.userEdited === 'true') return;
    const titles = selection
      .map((p) => recordings.find((r) => r.path === p))
      .filter((r): r is Recording => Boolean(r))
      .map((r) => r.title || '');
    const prefix = commonTitlePrefix(titles);
    titleInput!.placeholder = prefix || 'Merged Meeting';
  }

  const onTitleInput = (): void => {
    titleInput.dataset.userEdited = titleInput.value.trim() === '' ? '' : 'true';
  };
  titleInput.addEventListener('input', onTitleInput);

  updateOrderBadges();
  updateConfirmState();
  updateDefaultTitle();

  const cleanup = (): void => {
    modal.style.display = 'none';
    titleInput.dataset.userEdited = '';
    titleInput.removeEventListener('input', onTitleInput);
    cancelBtn.removeEventListener('click', onCancel);
    closeBtn.removeEventListener('click', onCancel);
    confirmBtn.removeEventListener('click', onConfirm);
  };
  const onCancel = (): void => cleanup();
  const onConfirm = async (): Promise<void> => {
    if (selection.length < 2) return;
    const title = titleInput.value.trim() || titleInput.placeholder || 'Merged Meeting';
    cleanup();
    await performMerge(selection.slice(), title);
  };
  cancelBtn.addEventListener('click', onCancel);
  closeBtn.addEventListener('click', onCancel);
  confirmBtn.addEventListener('click', onConfirm);
}

// Longest shared prefix across titles, trimmed of trailing whitespace and
// trailing single digits ("Meeting 1" / "Meeting 2" -> "Meeting").
function commonTitlePrefix(titles: string[]): string {
  if (titles.length === 0) return '';
  if (titles.length === 1) return titles[0];
  let prefix = titles[0];
  for (let i = 1; i < titles.length; i++) {
    const t = titles[i];
    let j = 0;
    while (j < prefix.length && j < t.length && prefix[j] === t[j]) j++;
    prefix = prefix.slice(0, j);
    if (!prefix) break;
  }
  return prefix.replace(/[\s_\-]*\d*\s*$/, '').trim();
}

async function performMerge(paths: string[], title: string): Promise<void> {
  if (
    !prepareTranscriptionModal(
      `Merging - ${title}`,
      'Preparing merge...',
      'Merging audio and re-transcribing...',
    )
  ) {
    return;
  }

  const progressContainer = document.getElementById('transcriptionProgress');
  const transcriptionModal = document.getElementById('transcriptionModal');

  try {
    const result = (await window.electronAPI.mergeRecordings({
      paths,
      title,
    })) as unknown as MergeRecordingsResult;
    if (!result || !result.success) {
      const message = result?.error || 'Unknown error';
      if (result && result.code === 'ffmpeg-missing') {
        alert(
          'FFmpeg is required to merge recordings. Transcribe a recording first to install it.',
        );
      } else {
        alert(`Failed to merge recordings: ${message}`);
      }
      if (progressContainer) progressContainer.style.display = 'none';
      if (transcriptionModal) transcriptionModal.style.display = 'none';
      return;
    }

    if (progressContainer) progressContainer.style.display = 'none';
    const transcriptionTitle = document.getElementById('transcriptionTitle');
    if (transcriptionTitle) transcriptionTitle.textContent = `Transcription - ${title}`;
    const uploadToNotionBtn = document.getElementById('uploadToNotion') as HTMLElement | null;
    _setCurrentTranscription({
      transcriptionData: (result.data || {}) as never,
      title,
      filePath: result.mergedAudioPath || null,
    });
    populateTranscriptionUI((result.data || {}) as never);

    await refreshRecordingsList();

    const notionConfig = await window.electronAPI.getConfig();
    if (notionConfig.notionApiKey && notionConfig.notionDatabaseId && uploadToNotionBtn) {
      uploadToNotionBtn.style.display = 'flex';
    }
  } catch (err) {
    alert(
      `Error merging recordings: ${err && (err as Error).message ? (err as Error).message : String(err)}`,
    );
    if (progressContainer) progressContainer.style.display = 'none';
  }
}

// Function to format file size
function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Number.parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
}

// Function to refresh recordings list after a new recording.
// If a search query is active, runSearch handles the re-render via search.ts.
export async function refreshRecordingsList(): Promise<void> {
  const searchInput = document.getElementById('searchInput') as HTMLInputElement | null;
  if (searchInput?.value.trim()) {
    // search.ts owns search rendering; import lazily to avoid a circular dep.
    const { runSearch } = await import('./search');
    await runSearch(searchInput.value.trim());
    return;
  }
  await loadRecordings();
}

export function setupRecordingsList(): void {
  if (window.electronAPI.onRecordingsChanged) {
    window.electronAPI.onRecordingsChanged(() => {
      void refreshRecordingsList();
    });
  }
}
