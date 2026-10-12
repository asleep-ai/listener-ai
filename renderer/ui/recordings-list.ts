// Recordings list, item rendering, M4A export, and the merge-recordings dialog.
// Extracted from legacy.ts (~lines 1694-2092).
//
// loadRecordings re-renders the full list from main; refreshRecordingsList
// preserves an active search query if one is showing instead of the default
// list. Both use a monotonic token so a slow per-item metadata read can't
// overwrite a fresher snapshot.

import { getDom } from '../state';
import { formatUsd } from '../../src/usageFormat';
import { isActiveJob, jobMatchesPath } from '../../src/transcriptionJobView';
import type { TranscriptionJobSnapshot } from '../electronAPI';
import { requireAiSetup } from './config-modal';
import { showToast } from './notifications';
import {
  _setCurrentTranscription,
  getModalSession,
  populateTranscriptionUI,
  prepareTranscriptionModal,
  setModalProgress,
  showSavedTranscript,
  transcribeWithFfmpegRetry,
} from './transcription-modal';
import { activeJobForPath, activeMergeJob, onTranscriptionJobChange } from './transcription-jobs';

type Recording = {
  path: string;
  title: string;
  createdAt: string | number;
  size: number;
  // Path keys main matches transcription jobs on (resolved, symlink-free).
  aliases?: string[];
};

// Each row's path plus its aliases, for matching rows to running jobs.
const rowKeys = new WeakMap<HTMLElement, string[]>();
function keysForRow(item: HTMLElement): string[] {
  return rowKeys.get(item) ?? (item.dataset.filepath ? [item.dataset.filepath] : []);
}

type CostSnapshotShape = { usd: number; modelUnknown?: boolean };

type GetRecordingsResult = { success: boolean; recordings: Recording[] };
type GetMetadataResult = {
  success: boolean;
  data?: Record<string, unknown> & { transcript?: unknown; cost?: CostSnapshotShape };
};

function formatCostBadge(cost: CostSnapshotShape | undefined): string {
  if (!cost || typeof cost.usd !== 'number' || cost.usd <= 0) return '';
  return formatUsd(cost.usd, 'omit');
}
type ExportM4AResult = { success?: boolean; canceled?: boolean; code?: string; error?: string };
type MergeRecordingsResult = {
  success?: boolean;
  error?: string;
  code?: string;
  data?: Record<string, unknown>;
  mergedAudioPath?: string;
  transcriptionPath?: string;
  generationId?: string | null;
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
  const sizeStr = formatFileSize(recording.size);
  const metaStr = formatRecordingMeta(date, sizeStr);
  const keys = [recording.path, ...(recording.aliases ?? [])];
  rowKeys.set(item, keys);

  // A row whose recording is still transcribing is built without reading its
  // saved note: the job may hold that note's lock (Regenerate saving), and the
  // read would wait for it, keeping the whole list (and Cancel) off screen.
  // The list is rebuilt with the note when the job ends.
  const runningJob = activeJobForPath(keys);
  const metadataResult = runningJob
    ? null
    : ((await window.electronAPI.getMetadata(recording.path)) as unknown as GetMetadataResult);
  const hasTranscript = !!(
    metadataResult?.success &&
    metadataResult.data &&
    metadataResult.data.transcript
  );

  item.dataset.hasTranscript = hasTranscript ? 'true' : 'false';
  // Identifier so external callers (drag-drop, file-import) can locate a row
  // by audio path after a list refresh and trigger the inline progress flow
  // on it instead of falling back to the modal.
  item.dataset.filepath = recording.path;
  if (hasTranscript) {
    item.setAttribute('role', 'button');
    item.setAttribute('tabindex', '0');
    item.setAttribute('aria-label', `Open transcript for ${recording.title}`);
  }

  const status = document.createElement('span');
  status.className = 'recording-status';
  status.setAttribute('aria-hidden', 'true');
  item.appendChild(status);

  const info = document.createElement('div');
  info.className = 'recording-info';
  const title = document.createElement('h3');
  title.textContent = recording.title;
  const meta = document.createElement('p');
  meta.className = 'recording-meta';
  meta.textContent = metaStr;
  const costBadge = formatCostBadge(metadataResult?.data?.cost as CostSnapshotShape | undefined);
  if (costBadge) {
    const sep = document.createTextNode(' · ');
    const costSpan = document.createElement('span');
    costSpan.className = 'recording-cost';
    costSpan.textContent = costBadge;
    costSpan.title = 'Estimated API cost (best-effort; actual invoice may differ)';
    // title alone doesn't surface to keyboard / touch / screen-reader users.
    // aria-label gives all of them the same context without changing layout.
    costSpan.setAttribute('aria-label', `Estimated API cost ${costBadge}`);
    meta.append(sep, costSpan);
  }
  info.append(title, meta);
  item.appendChild(info);

  const actions = document.createElement('div');
  actions.className = 'recording-actions';

  // Secondary actions live in a "More actions" menu so they don't claim most
  // of the row width (squeezing the title) or the row's centre (swallowing
  // the whole-row click). The primary CTA (Transcribe / chevron entry) sits
  // last at the right edge.
  const menuItems = [
    createMenuItem('merge-btn', 'Merge with other recordings…'),
    createMenuItem('reveal-btn', 'Show in Finder'),
    createMenuItem('export-m4a-btn', 'Export as M4A'),
    createMenuItem('delete-recording-btn', 'Delete…'),
  ];
  if (hasTranscript) {
    menuItems.unshift(createMenuItem('regenerate-btn', 'Regenerate transcript'));
  }
  actions.append(...createMoreActionsMenu(recording.title, menuItems));

  if (hasTranscript) {
    const chevron = document.createElement('span');
    chevron.className = 'recording-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '›';
    actions.appendChild(chevron);
  } else {
    actions.appendChild(createActionButton('transcribe-btn', 'Transcribe'));
  }

  item.appendChild(actions);

  if (hasTranscript) {
    // Whole-row entry: clicking (or Enter/Space) opens the transcript.
    // Action buttons inside the row stop propagation so they don't double-fire.
    item.querySelectorAll<HTMLButtonElement>('.action-button').forEach((btn) => {
      btn.addEventListener('click', (e) => e.stopPropagation());
    });
    const open = () => {
      // Suspend whole-row entry while the row is showing an inline transcribe.
      // Otherwise a stray click on the progress area opens the stale (pre-
      // regenerate) transcript while a regenerate is mid-flight.
      if (item.dataset.transcribing) return;
      showSavedTranscript(recording.path, recording.title, metadataResult.data);
    };
    item.addEventListener('click', open);
    item.addEventListener('keydown', (e) => {
      // Only act on key presses targeting the row itself; ignore bubbling
      // Enter/Space from focused child buttons so they keep their native
      // keyboard activation.
      if (e.target !== item) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });

    const regenerateBtn = item.querySelector('.regenerate-btn') as HTMLButtonElement | null;
    regenerateBtn?.addEventListener('click', () => {
      if (
        confirm(
          'Are you sure you want to regenerate the transcript? This will overwrite the existing one.',
        )
      ) {
        void runInlineTranscription(item, recording.path);
      }
    });
  } else {
    const transcribeBtn = item.querySelector('.transcribe-btn') as HTMLButtonElement | null;
    transcribeBtn?.addEventListener('click', () => {
      void runInlineTranscription(item, recording.path);
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

  const deleteBtn = item.querySelector('.delete-recording-btn') as HTMLButtonElement | null;
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      void openDeleteRecordingDialog(recording.path, recording.title);
    });
  }

  // A rebuilt row (list refresh, reload) keeps following a job that is still
  // running in main for this recording.
  const job = activeJobForPath(keys);
  if (job) bindRowToJob(item, job);

  return item;
}

// Confirmation modal for permanent recording deletion. Uses the native
// <dialog> pattern -- ESC + Cancel + close button all settle the in-flight
// promise as `cancelled`, and successful delete dismisses the modal then
// settles as `confirmed`. Mirrors the other modal lifecycle in this file.
async function openDeleteRecordingDialog(audioFilePath: string, title: string): Promise<void> {
  const modal = document.getElementById('deleteRecordingModal') as HTMLDialogElement | null;
  if (!modal) return;
  // Re-entry guard: don't open a second modal over the first.
  if (modal.open) return;

  const targetEl = document.getElementById('deleteRecordingTarget') as HTMLElement | null;
  const statusEl = document.getElementById('deleteRecordingStatus') as HTMLElement | null;
  const cancelBtn = document.getElementById('deleteRecordingCancel') as HTMLButtonElement | null;
  const confirmBtn = document.getElementById('deleteRecordingConfirm') as HTMLButtonElement | null;
  const closeBtn = document.getElementById('deleteRecordingClose') as HTMLElement | null;
  if (!cancelBtn || !confirmBtn) return;

  if (targetEl) targetEl.textContent = title;
  if (statusEl) statusEl.textContent = '';
  confirmBtn.disabled = false;

  const cleanup = () => {
    cancelBtn.removeEventListener('click', onCancel);
    confirmBtn.removeEventListener('click', onConfirm);
    closeBtn?.removeEventListener('click', onCancel);
    modal.removeEventListener('cancel', onEscape);
  };
  const close = () => {
    cleanup();
    if (modal.open) modal.close();
  };
  const onCancel = () => close();
  // <dialog> emits `cancel` on ESC. preventDefault routes through the same
  // cleanup so listeners don't leak across modal reopens.
  const onEscape = (e: Event) => {
    e.preventDefault();
    close();
  };
  const onConfirm = async () => {
    confirmBtn.disabled = true;
    if (statusEl) statusEl.textContent = 'Deleting…';
    try {
      const result = await window.electronAPI.deleteMeeting(audioFilePath);
      if (result.success) {
        close();
        // The main process broadcasts `recordings-changed` after a
        // successful delete; loadRecordings is the registered handler so
        // the list refresh happens automatically. Belt-and-suspenders:
        // refresh once more in case the broadcast races a re-render.
        void loadRecordings();
      } else {
        if (statusEl) statusEl.textContent = result.error;
        confirmBtn.disabled = false;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (statusEl) statusEl.textContent = msg;
      confirmBtn.disabled = false;
    }
  };

  cancelBtn.addEventListener('click', onCancel);
  confirmBtn.addEventListener('click', onConfirm);
  closeBtn?.addEventListener('click', onCancel);
  modal.addEventListener('cancel', onEscape);
  modal.showModal();
}

function createActionButton(
  className: string,
  label: string,
  options: { title?: string; ariaLabel?: string } = {},
): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = `action-button ${className}`;
  button.type = 'button';
  if (options.title) button.title = options.title;
  if (options.ariaLabel) button.setAttribute('aria-label', options.ariaLabel);
  button.textContent = label;
  return button;
}

let moreActionsMenuSeq = 0;

function createMenuItem(className: string, label: string): HTMLButtonElement {
  const item = document.createElement('button');
  item.className = `recording-menu-item ${className}`;
  item.type = 'button';
  item.setAttribute('role', 'menuitem');
  item.tabIndex = -1;
  item.textContent = label;
  return item;
}

// Menu button (WAI-ARIA APG pattern) for a row's secondary actions. The menu
// is a `popover="auto"` so it renders in the top layer (not clipped by the
// scrolling list) and gets native light-dismiss + ESC. The trigger is its
// declarative invoker, so a second click on it toggles closed instead of
// light-dismissing and reopening. Click listeners registered here run before
// the per-action handlers wired in createRecordingItem, so the menu is closed
// (and focus back on the trigger) before an action opens a confirm or modal.
function createMoreActionsMenu(
  recordingTitle: string,
  items: HTMLButtonElement[],
): [HTMLButtonElement, HTMLElement] {
  const seq = ++moreActionsMenuSeq;
  const menu = document.createElement('div');
  menu.className = 'recording-menu';
  menu.id = `recording-menu-${seq}`;
  menu.popover = 'auto';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', `Actions for ${recordingTitle}`);
  menu.append(...items);

  const trigger = createActionButton('more-actions-btn', '⋯', {
    title: 'More actions',
    ariaLabel: `More actions for ${recordingTitle}`,
  });
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', menu.id);
  trigger.popoverTargetElement = menu;
  // Per-row anchor name so each menu positions against its own trigger.
  trigger.style.setProperty('anchor-name', `--recording-menu-${seq}`);
  menu.style.setProperty('position-anchor', `--recording-menu-${seq}`);

  const enabledItems = () => items.filter((item) => !item.disabled);
  let focusOnOpen: 'first' | 'last' = 'first';

  // Menu clicks must not reach the row, whose click handler opens the
  // transcript. The popover lives in the top layer but is still a DOM child.
  menu.addEventListener('click', (e) => e.stopPropagation());
  for (const item of items) {
    item.addEventListener('click', () => menu.hidePopover());
  }

  menu.addEventListener('toggle', (e) => {
    const open = (e as ToggleEvent).newState === 'open';
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      const targets = enabledItems();
      (focusOnOpen === 'last' ? targets[targets.length - 1] : targets[0])?.focus();
      focusOnOpen = 'first';
    }
  });

  trigger.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    focusOnOpen = e.key === 'ArrowUp' ? 'last' : 'first';
    if (!menu.matches(':popover-open')) menu.showPopover();
  });

  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      // Menus aren't tab stops: close and let Tab continue from the trigger.
      menu.hidePopover();
      return;
    }
    const targets = enabledItems();
    if (targets.length === 0) return;
    const index = targets.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (e.key === 'ArrowDown') next = (index + 1) % targets.length;
    else if (e.key === 'ArrowUp') next = (index - 1 + targets.length) % targets.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = targets.length - 1;
    else return;
    e.preventDefault();
    targets[next].focus();
  });

  return [trigger, menu];
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
  const modal = document.getElementById('mergeModal') as HTMLDialogElement | null;
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
  if (!modal.open) modal.showModal();

  let recordings: Recording[] = [];
  try {
    const result = (await window.electronAPI.getRecordings()) as unknown as GetRecordingsResult;
    recordings = result?.success ? result.recordings : [];
  } catch {
    list.innerHTML = '<p class="merge-list-empty">Failed to load recordings.</p>';
    return;
  }

  // ESC during the recordings-load await would default-close the dialog
  // (cancel listener is only attached at the end of this function). Bail so we
  // don't attach button/cancel listeners to an already-dismissed dialog and
  // leak them across reopens.
  if (!modal.open) return;

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
    const meta = formatRecordingMeta(date, formatFileSize(rec.size));
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
    modal.close();
    titleInput.dataset.userEdited = '';
    titleInput.removeEventListener('input', onTitleInput);
    cancelBtn.removeEventListener('click', onCancel);
    closeBtn.removeEventListener('click', onCancel);
    confirmBtn.removeEventListener('click', onConfirm);
    modal.removeEventListener('cancel', onEscape);
  };
  const onCancel = (): void => cleanup();
  // Route ESC through the same cleanup path so listeners get removed; the
  // default `cancel` action would just close the dialog and leak this run's
  // handlers.
  const onEscape = (e: Event): void => {
    e.preventDefault();
    cleanup();
  };
  const onConfirm = async (): Promise<void> => {
    if (selection.length < 2) return;
    const title = titleInput.value.trim() || titleInput.placeholder || 'Merged Meeting';
    cleanup();
    await performMerge(selection.slice(), title);
  };
  cancelBtn.addEventListener('click', onCancel);
  closeBtn.addEventListener('click', onCancel);
  confirmBtn.addEventListener('click', onConfirm);
  modal.addEventListener('cancel', onEscape);
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

// How many merge-recordings calls this renderer is awaiting; a merge seen only
// through job state (after a reload) is reconnected separately. A count, not
// a flag: a refused second request must not mark the first one as not local.
let localMerges = 0;

async function performMerge(paths: string[], title: string): Promise<void> {
  // A merge is already running (possibly in a modal the user closed): say so
  // without taking over the modal, which still belongs to that merge or to
  // whatever the user opened since.
  if (activeMergeJob()) {
    alert('Failed to merge recordings: Another merge is already running. Wait for it to finish.');
    return;
  }
  // Merging re-transcribes the joined audio, so it needs both credential sets.
  if (!(await requireAiSetup({ transcription: true }))) return;
  if (
    !prepareTranscriptionModal(
      `Merging - ${title}`,
      'Preparing merge...',
      'Merging audio and re-transcribing...',
      { kind: 'merge' },
    )
  ) {
    return;
  }
  const session = getModalSession();

  const progressContainer = document.getElementById('transcriptionProgress');
  const transcriptionModal = document.getElementById(
    'transcriptionModal',
  ) as HTMLDialogElement | null;

  localMerges++;
  try {
    const result = (await window.electronAPI.mergeRecordings({
      paths,
      title,
    })) as unknown as MergeRecordingsResult;
    // The modal moved on to another note: don't overwrite what it shows.
    if (session !== getModalSession()) {
      if (result?.success) {
        showToast('Merge complete');
        await refreshRecordingsList();
      } else if (result?.code !== 'merge-busy') {
        showToast(`Failed to merge recordings: ${result?.error || 'Unknown error'}`, 'error');
      }
      return;
    }
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
      transcriptionModal?.close();
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
      transcriptionPath: result.transcriptionPath ?? null,
      generationId: result.generationId,
    });
    populateTranscriptionUI((result.data || {}) as never);

    await refreshRecordingsList();

    const cfg = await window.electronAPI.getConfig();
    if (uploadToNotionBtn) {
      uploadToNotionBtn.style.display = cfg.notionApiKey && cfg.notionDatabaseId ? 'flex' : 'none';
    }
    const sendToSlackBtn = document.getElementById('sendToSlack') as HTMLElement | null;
    if (sendToSlackBtn) {
      sendToSlackBtn.style.display = cfg.slackWebhookUrl ? 'flex' : 'none';
    }
  } catch (err) {
    alert(
      `Error merging recordings: ${err && (err as Error).message ? (err as Error).message : String(err)}`,
    );
    if (progressContainer) progressContainer.style.display = 'none';
  } finally {
    localMerges--;
  }
}

// A merge still running in main after a reload: reopen its progress in the
// modal, then show the merged note when it finishes (if the modal still shows
// this merge).
let reconnectedMerge: { jobId: string; session: number } | null = null;

function followMergeJob(job: TranscriptionJobSnapshot): void {
  if (isActiveJob(job)) {
    if (localMerges > 0 || reconnectedMerge?.jobId === job.id) return;
    const title = job.title || 'Merged Meeting';
    if (
      !prepareTranscriptionModal(
        `Merging - ${title}`,
        job.message || 'Merging audio and re-transcribing...',
        'Merging audio and re-transcribing...',
        { kind: 'merge', jobId: job.id },
      )
    ) {
      return;
    }
    setModalProgress(job.percent, job.message);
    reconnectedMerge = { jobId: job.id, session: getModalSession() };
    return;
  }
  if (reconnectedMerge?.jobId !== job.id) return;
  const { session } = reconnectedMerge;
  reconnectedMerge = null;
  void (async () => {
    await refreshRecordingsList();
    if (session !== getModalSession()) return;
    const modal = document.getElementById('transcriptionModal') as HTMLDialogElement | null;
    const progressContainer = document.getElementById('transcriptionProgress');
    if (job.status === 'succeeded' && job.mergedAudioPath) {
      const meta = (await window.electronAPI.getMetadata(
        job.mergedAudioPath,
      )) as unknown as GetMetadataResult;
      if (session !== getModalSession()) return;
      if (meta?.success && meta.data) {
        if (progressContainer) progressContainer.style.display = 'none';
        showSavedTranscript(job.mergedAudioPath, job.title || 'Merged Meeting', meta.data as never);
        return;
      }
    }
    if (progressContainer) progressContainer.style.display = 'none';
    modal?.close();
    if (job.status === 'failed') {
      showToast(`Failed to merge recordings: ${job.error || 'Unknown error'}`, 'error');
    }
  })();
}

// Function to format file size
function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Number.parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
}

// Compact meta line for the recordings list. Drops seconds, uses relative
// labels for today/yesterday, and falls back to a short month-day format.
function formatRecordingMeta(date: Date, sizeStr: string): string {
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();
  const sameYear = date.getFullYear() === now.getFullYear();
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  let label: string;
  if (sameDay) label = `Today, ${time}`;
  else if (isYesterday) label = `Yesterday, ${time}`;
  else if (sameYear)
    label = `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
  else
    label = date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  return `${label} · ${sizeStr}`;
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

// --- Inline transcription progress ----------------------------------------
//
// Per-row progress UI: replaces the item's action buttons and meta line while
// a transcription job runs for the row's recording, with a Cancel control. No
// modal opens during transcription; on success the list refreshes so the row
// gains its "View Transcript" affordance. The user then clicks the row to
// open the modal viewer.
//
// The row follows the main-owned job (renderer/ui/transcription-jobs.ts), not
// the request that started it, so a reload or a list refresh rebuilds the same
// progress and Cancel for a job that is still running.

type ProgressListener = (progress: { percent: number; message: string }) => void;

interface RowBinding {
  item: HTMLElement;
  setProgress: ProgressListener;
  restore: () => void;
  cancelBtn: HTMLButtonElement | null;
}
const rowBindings = new Map<string, RowBinding[]>();
// Recordings this renderer is awaiting a transcribe-audio response for. That
// call reports the outcome (toast, list refresh); other rows only follow.
const awaitingPaths = new Map<string, number>();

function mountInlineProgressUI(item: HTMLElement): {
  setProgress: ProgressListener;
  restore: () => void;
} {
  // Snapshot the existing children so we can put them back when transcription
  // ends, regardless of outcome. The row keeps its grid layout: status |
  // info (title + progress) | actions (just Cancel).
  const info = item.querySelector('.recording-info') as HTMLElement | null;
  const actions = item.querySelector('.recording-actions') as HTMLElement | null;
  const originalActions = actions ? Array.from(actions.children) : [];
  const meta = info?.querySelector('.recording-meta') as HTMLElement | null;
  const savedHasTranscript = item.dataset.hasTranscript;
  const savedRole = item.getAttribute('role');
  const savedTabindex = item.getAttribute('tabindex');
  const savedAriaLabel = item.getAttribute('aria-label');

  // Suspend whole-row click-to-open while transcribing so misclicks don't open
  // an older transcript mid-regenerate. role/tabindex restoration on `restore`
  // brings the keyboard affordances back.
  if (savedHasTranscript === 'true') {
    item.removeAttribute('role');
    item.removeAttribute('tabindex');
    item.removeAttribute('aria-label');
  }
  item.dataset.transcribing = 'true';

  const progressLine = document.createElement('p');
  progressLine.className = 'recording-progress';
  const messageSpan = document.createElement('span');
  messageSpan.className = 'recording-progress-message';
  messageSpan.textContent = 'Starting transcription…';
  const percentSpan = document.createElement('span');
  percentSpan.className = 'recording-progress-percent';
  percentSpan.textContent = '';
  progressLine.append(messageSpan, percentSpan);
  if (meta) meta.insertAdjacentElement('afterend', progressLine);
  else info?.appendChild(progressLine);

  const bar = document.createElement('div');
  bar.className = 'recording-progress-bar';
  const fill = document.createElement('div');
  fill.className = 'recording-progress-fill';
  bar.appendChild(fill);
  item.appendChild(bar);

  let cancelBtn: HTMLButtonElement | null = null;
  if (actions) {
    cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'cancel-transcribe-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.setAttribute('aria-label', 'Cancel transcription');
    // Stop the click from bubbling to the row -- transcript-bearing rows have
    // a click handler that opens the modal viewer, which would race against
    // our cancel/restore flow and show a stale transcript while the row
    // reverts. Mirrors the stopPropagation wired onto `.action-button`.
    cancelBtn.addEventListener('click', (e) => e.stopPropagation());
    actions.appendChild(cancelBtn);
  }

  const setProgress: ProgressListener = ({ percent, message }) => {
    const clamped = Math.max(0, Math.min(100, percent));
    fill.style.width = `${clamped}%`;
    if (message) messageSpan.textContent = message;
    percentSpan.textContent = clamped > 0 ? `${Math.round(clamped)}%` : '';
  };

  const restore = (): void => {
    item.removeAttribute('data-transcribing');
    item.removeAttribute('data-transcribing-job');
    progressLine.remove();
    bar.remove();
    if (actions) {
      // Strip whatever the inline flow appended, restore the original children
      // in their original order so hover-reveal CSS keeps working.
      while (actions.firstChild) actions.removeChild(actions.firstChild);
      for (const child of originalActions) actions.appendChild(child);
    }
    if (savedHasTranscript === 'true') {
      if (savedRole) item.setAttribute('role', savedRole);
      if (savedTabindex) item.setAttribute('tabindex', savedTabindex);
      if (savedAriaLabel) item.setAttribute('aria-label', savedAriaLabel);
    }
  };

  return {
    setProgress,
    restore: () => {
      restore();
      cancelBtn = null;
    },
  };
}

function bindRowToJob(item: HTMLElement, job: TranscriptionJobSnapshot): void {
  if (item.dataset.transcribingJob === job.id) return;
  if (item.dataset.transcribingJob) return;
  const { setProgress, restore } = mountInlineProgressUI(item);
  item.dataset.transcribingJob = job.id;
  const filePath = item.dataset.filepath || job.filePath;
  const cancelBtn = item.querySelector('.cancel-transcribe-btn') as HTMLButtonElement | null;
  cancelBtn?.addEventListener('click', () => {
    if (cancelBtn.disabled) return;
    cancelBtn.disabled = true;
    cancelBtn.textContent = 'Cancelling…';
    void window.electronAPI.cancelTranscription(filePath).then((result) => {
      // Already saved: the job finishes normally, so say what is happening.
      if (!result.success && result.reason === 'committed') cancelBtn.textContent = 'Saving…';
    });
  });
  const binding: RowBinding = { item, setProgress, restore, cancelBtn };
  rowBindings.set(job.id, [...(rowBindings.get(job.id) ?? []), binding]);
  updateRowBinding(binding, job);
}

function updateRowBinding(binding: RowBinding, job: TranscriptionJobSnapshot): void {
  binding.setProgress({ percent: job.percent, message: job.message });
  const btn = binding.cancelBtn;
  if (!btn) return;
  if (job.cancelRequested) {
    btn.disabled = true;
    btn.textContent = 'Cancelling…';
  } else if (!job.cancellable) {
    // Past the commit boundary (note saved, exports running): nothing to cancel.
    btn.disabled = true;
    btn.textContent = job.phase === 'exporting' ? 'Sending…' : 'Saving…';
    btn.setAttribute('aria-label', 'Transcription saved, finishing');
  }
}

function followTranscriptionJob(
  job: TranscriptionJobSnapshot,
  previous: TranscriptionJobSnapshot | undefined,
): void {
  if (isActiveJob(job)) {
    // A row whose path the job no longer answers to (a released rename name)
    // goes back to its own state instead of showing this job's progress.
    const bound = rowBindings.get(job.id) ?? [];
    const kept = bound.filter((binding) => jobMatchesPath(job, keysForRow(binding.item)));
    for (const binding of bound) if (!kept.includes(binding)) binding.restore();
    rowBindings.set(job.id, kept);
    document.querySelectorAll<HTMLElement>('.recording-item[data-filepath]').forEach((row) => {
      if (jobMatchesPath(job, keysForRow(row))) bindRowToJob(row, job);
    });
    for (const binding of rowBindings.get(job.id) ?? []) updateRowBinding(binding, job);
    return;
  }
  const bindings = rowBindings.get(job.id) ?? [];
  rowBindings.delete(job.id);
  for (const binding of bindings) binding.restore();
  // Seen only as already finished (snapshot after reload): nothing to report.
  if (!previous || !isActiveJob(previous)) return;
  // Always reconcile the list with disk: a rebuilt row can name audio that a
  // cancelled job just renamed back, and rows built while the job ran were
  // built without their saved note. A request awaited here still reports the
  // outcome itself, so only the toast depends on that.
  void refreshRecordingsList();
  if (job.paths.some((p) => awaitingPaths.has(p))) return;
  // Auto mode reports its own outcome in the status line.
  if (job.status === 'failed' && job.origin !== 'auto') {
    showToast(`Failed to transcribe: ${job.error || 'Unknown error'}`, 'error');
  }
}

async function runInlineTranscription(item: HTMLElement, filePath: string): Promise<void> {
  // Synchronous double-fire guard. Slam the marker on now, before any await;
  // the renderer's event loop guarantees a second click in the same tick is
  // the only race window, and DOM dataset writes are synchronous.
  if (item.dataset.transcribing) return;
  // Already running in main (started before a reload, or from another entry
  // point): follow that job instead of asking again.
  const running = activeJobForPath(keysForRow(item));
  if (running) {
    bindRowToJob(item, running);
    return;
  }
  item.dataset.transcribing = 'pending';

  if (!(await requireAiSetup({ transcription: true }))) {
    item.removeAttribute('data-transcribing');
    return;
  }

  awaitingPaths.set(filePath, (awaitingPaths.get(filePath) ?? 0) + 1);
  try {
    // Main registers the job before its first await, so the job event that
    // mounts this row's progress and Cancel arrives right after the request.
    // A request for a recording that is already transcribing joins that job.
    const result = await transcribeWithFfmpegRetry(filePath);
    if (result.cancelled) {
      // Row goes back to its pre-transcribe state; no toast — user chose this.
      // A failed rename rollback can leave the audio under its new path.
      if (result.newFilePath) await refreshRecordingsList();
      return;
    }
    if (!result.success) {
      const message = (result as { error?: string }).error || 'Unknown error';
      showToast(`Failed to transcribe: ${message}`, 'error');
      return;
    }
    // Success: refresh so the row picks up its renamed filePath (if any) and
    // the "View Transcript" / chevron affordance. The renderer's row entry no
    // longer auto-opens the modal — the user clicks to view.
    await refreshRecordingsList();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showToast(`Error transcribing: ${message}`, 'error');
  } finally {
    const count = (awaitingPaths.get(filePath) ?? 1) - 1;
    if (count > 0) awaitingPaths.set(filePath, count);
    else awaitingPaths.delete(filePath);
    // No job ever bound this row (e.g. the request failed before starting).
    if (item.dataset.transcribing === 'pending') item.removeAttribute('data-transcribing');
  }
}

// Public entry point for callers that have a file path but no row reference
// (drag-drop, file-import, paste). Locates the row by `data-filepath` and
// drives it through the inline transcribe flow so every user-initiated
// transcription looks the same. Falls back to the modal flow when the row
// isn't in the DOM (e.g. caller didn't refresh the list, the file isn't in
// the recordings dir).
export async function transcribeByPath(filePath: string, fallbackTitle: string): Promise<void> {
  const selector = `.recording-item[data-filepath="${CSS.escape(filePath)}"]`;
  const row = document.querySelector(selector) as HTMLElement | null;
  if (row) {
    await runInlineTranscription(row, filePath);
    return;
  }
  // Lazy import keeps the static dep graph free of the modal flow for callers
  // that only ever go through `runInlineTranscription`.
  const { handleTranscribe } = await import('./transcription-modal');
  await handleTranscribe(filePath, fallbackTitle);
}

export function setupRecordingsList(): void {
  if (window.electronAPI.onRecordingsChanged) {
    window.electronAPI.onRecordingsChanged(() => {
      void refreshRecordingsList();
    });
  }

  // Rows and the merge modal follow main-owned job state; progress arrives as
  // job changes, so a reload or list refresh picks up where the job is.
  onTranscriptionJobChange(({ job, previous }) => {
    if (job.kind === 'merge') followMergeJob(job);
    else followTranscriptionJob(job, previous);
  });
  // Covers a merge job already in the store before this listener existed.
  const merge = activeMergeJob();
  if (merge) followMergeJob(merge);
}
