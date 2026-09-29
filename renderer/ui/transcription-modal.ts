// Transcription modal: viewer for transcripts/summaries, handler for new
// transcriptions, copy buttons, and Notion upload trigger.
// Extracted from legacy.ts (~lines 1244-1291, 1417-1872, 2205-2231).
// Behavior preserved verbatim.

import { getDom } from '../state';
import { resetModalChatFor } from './chat-panel';
import { showConfigModal } from './config-modal';
import { camelToLabel } from '../../src/meetingRecord';
import {
  includedTranscript,
  resolveTranscriptCutoff,
  titleForSavedReport,
} from '../../src/transcriptCutoff';
import {
  type TranscriptionData,
  renderDynamicFields,
  renderMarkdown,
  structuredToMarkdown,
} from './markdown-utils';
import { showToast } from './notifications';
import { refreshRecordingsList } from './recordings-list';
import { showTranscriptionErrorDialog } from './transcription-error-dialog';
import {
  clearTranscriptCutoffBusy,
  describeFlaggedNotes,
  focusTranscriptCutoffStatus,
  renderTranscriptPane,
  clearTranscriptSelectionOnPointerDown,
  setTranscriptCutoffBusy,
  showTranscriptCutoffMessage,
  trackTranscriptSelection,
} from './transcript-cutoff';

// Modal-level mutable state. These were top-level `let`s in legacy.ts; keeping
// them module-private mirrors the original visibility (handleTranscribe,
// showSavedTranscript, performMerge all mutate them).
let currentTranscriptionData: TranscriptionData | null = null;
let currentMeetingTitle = '';
let currentFilePath: string | null | undefined = '';
let currentTranscriptionPath: string | null = null;
let currentGenerationId: string | null | undefined;
let currentNotionUrl: string | null = null;
// Notion page uploaded before the last cutoff change; it still shows the older report.
let supersededNotionUrl: string | null = null;
let currentSlackSentAt: string | null = null;
let cutoffInFlight = false;

let transcriptionModal: HTMLDialogElement | null = null;
let closeTranscriptionBtn: Element | null = null;
let uploadToNotionBtn: HTMLButtonElement | null = null;
let notionButtonLabel: HTMLElement | null = null;
let sendToSlackBtn: HTMLButtonElement | null = null;
let slackButtonLabel: HTMLElement | null = null;

function refreshSlackButtonLabel(): void {
  if (!slackButtonLabel || !sendToSlackBtn) return;
  if (currentSlackSentAt) {
    slackButtonLabel.textContent = 'Resend to Slack';
    sendToSlackBtn.classList.add('is-resend');
  } else {
    slackButtonLabel.textContent = 'Send to Slack';
    sendToSlackBtn.classList.remove('is-resend');
  }
}

function refreshNotionButtonLabel(): void {
  if (!notionButtonLabel) return;
  notionButtonLabel.textContent = currentNotionUrl
    ? 'View in Notion'
    : supersededNotionUrl
      ? 'Upload new version to Notion'
      : 'Upload to Notion';
  refreshNotionSupersededNotice();
}

// Visible on every tab: after a cutoff change the earlier Notion page still
// shows the previous report, and nothing in the app edits it.
function refreshNotionSupersededNotice(): void {
  const notice = document.getElementById('notionSupersededNotice');
  if (!notice) return;
  const show = !!supersededNotionUrl && !currentNotionUrl;
  notice.hidden = !show;
  if (!show) {
    notice.replaceChildren();
    return;
  }
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'link-button';
  open.textContent = 'Open the earlier Notion page';
  const url = supersededNotionUrl;
  open.addEventListener('click', () => {
    if (url) void window.electronAPI.openExternal(url);
  });
  notice.replaceChildren(
    document.createTextNode(
      'The report changed after it was uploaded to Notion. The earlier Notion page was not changed and still shows the previous report. Upload to Notion to publish the current report as a new page. ',
    ),
    open,
  );
}

function ensureTranscriptionModal(): HTMLDialogElement | null {
  if (!transcriptionModal) {
    transcriptionModal = document.getElementById('transcriptionModal') as HTMLDialogElement | null;
  }
  return transcriptionModal;
}

// Populate all transcription tabs with data and set up copy handlers
export function populateTranscriptionUI(data: TranscriptionData): void {
  // All tab
  const allMd = structuredToMarkdown(data, 'all');
  const allDiv = document.getElementById('all');
  if (allDiv) {
    allDiv.innerHTML = allMd
      ? `<button class="copy-button" data-copy-target="all">📋 Copy All</button>
       <div class="all-content markdown-body">${renderMarkdown(allMd)}</div>`
      : '<p class="loading">No content available</p>';
  }

  // Summary tab
  const summaryMd = structuredToMarkdown(data, 'summary');
  const summaryDiv = document.getElementById('summary');
  if (summaryDiv) {
    summaryDiv.innerHTML = summaryMd
      ? `<button class="copy-button" data-copy-target="summary">📋 Copy</button>
       <div class="summary-content markdown-body">${renderMarkdown(summaryMd)}</div>`
      : '<p class="loading">No summary available</p>';
  }

  // Transcript tab: the full transcript, with any excluded tail marked.
  const transcriptDiv = document.getElementById('transcript');
  if (transcriptDiv) {
    const transcript = String(data.transcript || '').trim();
    renderTranscriptPane(transcriptDiv, {
      transcript,
      cutoff: resolveTranscriptCutoff(transcript, data.transcriptCutoff),
      cutoffMismatch: data.transcriptCutoffMismatch === true,
      flaggedNotes: Array.isArray(data.liveNotes)
        ? data.liveNotes
        : Array.isArray(data.highlights)
          ? data.highlights
          : undefined,
      // Only a saved note whose generation we know can be changed safely.
      editable: !!currentTranscriptionPath && currentGenerationId !== undefined,
      onApply: (offset) => void applyTranscriptCutoff(offset),
    });
  }

  renderDynamicFields(data);
  setupCopyButtons(data);
}

// Function to show saved transcript
export function showSavedTranscript(
  filePath: string,
  title: string,
  metadata: TranscriptionData & {
    folderName?: string;
    reportTitle?: string;
    reportSuggestedTitle?: string;
  },
  folderName?: string | null,
): void {
  // Make sure modal elements are loaded
  const modal = ensureTranscriptionModal();

  // Show transcription modal
  if (modal) {
    if (!modal.open) modal.showModal();
    const titleEl = document.getElementById('transcriptionTitle');
    const reportTitle = titleForSavedReport(
      title,
      metadata.suggestedTitle,
      metadata.reportTitle ?? title,
    );
    if (titleEl) titleEl.textContent = `Transcription - ${reportTitle}`;

    // Hide progress bar since we're showing saved data
    const { progressContainer } = getDom();
    if (progressContainer) {
      progressContainer.style.display = 'none';
    }

    // Store transcription data for Notion upload
    currentTranscriptionData = {
      transcript: metadata.transcript,
      summary: metadata.summary,
      summarySections: metadata.summarySections,
      keyPoints: metadata.keyPoints || [],
      actionItems: metadata.actionItems || [],
      actionItemGroups: metadata.actionItemGroups,
      suggestedTitle: metadata.reportSuggestedTitle ?? metadata.suggestedTitle,
      customFields: metadata.customFields,
      emoji: metadata.emoji,
      liveNotes: metadata.liveNotes,
      highlights: metadata.highlights,
      transcriptCutoff: metadata.transcriptCutoff,
      transcriptCutoffMismatch: metadata.transcriptCutoffMismatch,
    };
    currentMeetingTitle = reportTitle;
    currentFilePath = filePath;
    currentTranscriptionPath =
      (metadata as { transcriptionPath?: string }).transcriptionPath ?? null;
    currentGenerationId = currentTranscriptionPath
      ? (metadata as { generationId?: string | null }).generationId
      : undefined;
    currentNotionUrl = (metadata as { notionPageUrl?: string }).notionPageUrl ?? null;
    supersededNotionUrl =
      (metadata as { supersededNotionPageUrl?: string }).supersededNotionPageUrl ?? null;
    currentSlackSentAt = (metadata as { slackSentAt?: string }).slackSentAt ?? null;
    refreshSlackButtonLabel();
    refreshNotionButtonLabel();

    // Prefer an explicit folderName; fall back to the one get-metadata attaches.
    resetModalChatFor(folderName || metadata?.folderName || null);

    populateTranscriptionUI(currentTranscriptionData);

    window.electronAPI.getConfig().then((config) => {
      if (uploadToNotionBtn) {
        uploadToNotionBtn.style.display =
          config.notionApiKey && config.notionDatabaseId ? 'flex' : 'none';
      }
      if (sendToSlackBtn) {
        sendToSlackBtn.style.display = config.slackWebhookUrl ? 'flex' : 'none';
      }
    });
  }
}

// Gate transcription on both credential sets: the AI provider (summary, quality
// judge, agent) and the selected transcription backend, which can be a
// different vendor with its own key. Returns true when the caller can proceed;
// false when the user needs to configure first (and the appropriate UI has
// already been surfaced). Checking here keeps a missing backend key from
// failing only after the ffmpeg work. Shared by the modal and the inline-row
// transcribe flows.
export async function requireAiAuth(): Promise<boolean> {
  const configCheck = await window.electronAPI.checkConfig();
  if (configCheck.hasAiAuth && configCheck.hasTranscriptionAuth) return true;
  const message = !configCheck.hasAiAuth
    ? 'Please configure your AI provider first'
    : configCheck.transcriptionProvider === 'soniox'
      ? 'Transcription is set to Soniox, but no Soniox API key is saved. Add the key in Settings, or set Transcription back to "Follow AI provider".'
      : 'The selected transcription backend has no credentials saved. Check the Transcription setting in Settings.';
  if (document.getElementById('configModal')) {
    // The provider case is self-evident once Settings opens; a missing backend
    // key is not, so name it before the modal appears.
    if (configCheck.hasAiAuth) alert(message);
    void showConfigModal();
  } else {
    alert(message);
  }
  return false;
}

// Retry `transcribeAudio` once after the ffmpeg-missing download dialog if the
// first call surfaced that specific failure. Returns the (possibly retried)
// result so callers don't need to know about the recovery path.
export async function transcribeWithFfmpegRetry(
  filePath: string,
): Promise<Awaited<ReturnType<typeof window.electronAPI.transcribeAudio>>> {
  let result = await window.electronAPI.transcribeAudio(filePath);
  if (!result.success && (result as { code?: string }).code === 'ffmpeg-missing') {
    const { showFFmpegDownloadDialog } = await import('./ffmpeg-dialog');
    const dlResult = await showFFmpegDownloadDialog();
    if (dlResult.success) {
      result = await window.electronAPI.transcribeAudio(filePath);
    }
  }
  return result;
}

export async function handleTranscribe(filePath: string, title: string): Promise<void> {
  console.log('handleTranscribe called with:', { filePath, title });

  // Transcription only needs the AI provider auth; Notion is for the optional
  // upload step and shouldn't gate the recording -> transcript flow.
  if (!(await requireAiAuth())) return;

  if (!prepareTranscriptionModal(`Transcription - ${title}`, 'Initializing transcription...')) {
    return;
  }

  const button = document.querySelector(
    `[data-filepath="${filePath}"]`,
  ) as HTMLButtonElement | null;
  if (button) {
    button.disabled = true;
    button.textContent = 'Transcribing...';
  }

  try {
    const result = await transcribeWithFfmpegRetry(filePath);

    if (result.success) {
      // Hide progress bar
      const { progressContainer } = getDom();
      if (progressContainer) {
        progressContainer.style.display = 'none';
      }

      const data = result.data as { suggestedTitle?: string } & TranscriptionData;
      const newFilePath = (result as { newFilePath?: string }).newFilePath;
      // Update file path if it was renamed
      if (newFilePath) {
        filePath = newFilePath;
        // Update the title if it was generated
        if (data.suggestedTitle && title === 'Untitled_Meeting') {
          title = data.suggestedTitle;
          const titleEl = document.getElementById('transcriptionTitle');
          if (titleEl) titleEl.textContent = `Transcription - ${title}`;
        }
      }

      // Store transcription data for Notion upload
      currentTranscriptionData = result.data;
      currentMeetingTitle = title;
      currentFilePath = filePath;
      currentTranscriptionPath =
        (result as { transcriptionPath?: string }).transcriptionPath ?? null;
      currentGenerationId = currentTranscriptionPath
        ? (result as { generationId?: string | null }).generationId
        : undefined;
      currentNotionUrl = null;
      supersededNotionUrl = null;
      currentSlackSentAt = null;
      refreshSlackButtonLabel();
      refreshNotionButtonLabel();

      populateTranscriptionUI(result.data);

      // Refresh the main recordings list so the renamed file and "View Transcript"
      // state appear without requiring a manual reload.
      await refreshRecordingsList();

      const cfg = await window.electronAPI.getConfig();
      if (uploadToNotionBtn) {
        uploadToNotionBtn.style.display =
          cfg.notionApiKey && cfg.notionDatabaseId ? 'flex' : 'none';
      }
      if (sendToSlackBtn) {
        sendToSlackBtn.style.display = cfg.slackWebhookUrl ? 'flex' : 'none';
      }
    } else {
      await showTranscriptionErrorDialog(
        result.errorDetails,
        `Failed to transcribe audio: ${result.error ?? 'unknown error'}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await showTranscriptionErrorDialog(undefined, `Error transcribing audio: ${message}`);
  } finally {
    // Re-enable the button
    if (button) {
      button.disabled = false;
      button.textContent = 'Transcribe';
    }
  }
}

// Shared by handleTranscribe and performMerge. Returns false if the modal can't
// be located (handler should bail).
export function prepareTranscriptionModal(
  modalTitle: string,
  progressMessage: string,
  allLoadingText?: string,
): boolean {
  const modal = ensureTranscriptionModal();
  if (!modal) {
    console.error('Transcription modal not found');
    return false;
  }
  if (!modal.open) modal.showModal();
  const titleEl = document.getElementById('transcriptionTitle');
  if (titleEl) titleEl.textContent = modalTitle;
  const { progressContainer, progressFill, progressText } = getDom();
  if (progressContainer) {
    progressContainer.style.display = 'block';
    if (progressFill) progressFill.style.width = '0%';
    if (progressText) progressText.textContent = progressMessage;
  }
  const allEl = document.getElementById('all');
  if (allEl) allEl.innerHTML = `<p class="loading">${allLoadingText || 'Loading...'}</p>`;
  const summaryEl = document.getElementById('summary');
  if (summaryEl) summaryEl.innerHTML = '<p class="loading">Loading summary...</p>';
  const transcriptEl = document.getElementById('transcript');
  if (transcriptEl) transcriptEl.innerHTML = '<p class="loading">Loading transcription...</p>';
  resetModalChatFor(null);
  document.querySelectorAll('.tab-button.dynamic').forEach((el) => el.remove());
  document.querySelectorAll('.tab-pane.dynamic').forEach((el) => el.remove());
  document.querySelectorAll('.tab-button').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
  document.querySelector('[data-tab="all"]')?.classList.add('active');
  document.getElementById('all')?.classList.add('active');
  return true;
}

// Copy functionality
export function setupCopyButtons(transcriptionData: TranscriptionData): void {
  const copyButtons = document.querySelectorAll('.copy-button');

  const sectionLabels: Record<string, string> = {
    all: 'All',
    summary: 'Summary',
    keypoints: 'Key Points',
    actions: 'Action Items',
    transcript: 'Transcript',
  };

  copyButtons.forEach((button) => {
    button.addEventListener('click', async () => {
      const target = (button as HTMLElement).dataset.copyTarget || '';
      const sectionName = target.startsWith('cf-')
        ? camelToLabel(target.slice(3))
        : sectionLabels[target] || target;
      // With a cutoff, copy what the report covers: the text before it.
      const cutTranscript =
        target === 'transcript' &&
        resolveTranscriptCutoff(
          String(transcriptionData.transcript || '').trim(),
          transcriptionData.transcriptCutoff,
        );
      const textToCopy = cutTranscript
        ? includedTranscript(
            String(transcriptionData.transcript || '').trim(),
            transcriptionData.transcriptCutoff,
          )
        : structuredToMarkdown(transcriptionData, target);

      try {
        await navigator.clipboard.writeText(textToCopy);
        showToast(
          cutTranscript
            ? 'Transcript before the cutoff copied to clipboard'
            : `${sectionName} copied to clipboard`,
        );
      } catch (err) {
        console.error('Failed to copy:', err);
        showToast('Failed to copy to clipboard', 'error');
      }
    });
  });
}

export function setupTranscriptionModal(): void {
  transcriptionModal = document.getElementById('transcriptionModal') as HTMLDialogElement | null;
  closeTranscriptionBtn = document.querySelector('#transcriptionModal .close');
  uploadToNotionBtn = document.getElementById('uploadToNotion') as HTMLButtonElement | null;
  notionButtonLabel = document.getElementById('notionButtonLabel');
  sendToSlackBtn = document.getElementById('sendToSlack') as HTMLButtonElement | null;
  slackButtonLabel = document.getElementById('slackButtonLabel');

  if (closeTranscriptionBtn) {
    closeTranscriptionBtn.addEventListener('click', () => {
      transcriptionModal?.close();
    });
  }

  document.addEventListener('selectionchange', trackTranscriptSelection);
  document.addEventListener('pointerdown', clearTranscriptSelectionOnPointerDown);

  // Tab handling for transcription modal (event delegation for dynamic tabs)
  const tabsContainer = document.querySelector('.transcription-tabs');
  if (tabsContainer) {
    tabsContainer.addEventListener('click', (e) => {
      const button = (e.target as HTMLElement).closest('.tab-button') as HTMLElement | null;
      if (!button) return;
      const targetTab = button.dataset.tab;
      document.querySelectorAll('.tab-button').forEach((btn) => btn.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach((pane) => pane.classList.remove('active'));
      button.classList.add('active');
      if (targetTab) document.getElementById(targetTab)?.classList.add('active');
    });
  }

  // Handle upload to Notion (or open existing page if already uploaded)
  if (uploadToNotionBtn) {
    uploadToNotionBtn.addEventListener('click', async () => {
      if (currentNotionUrl) {
        window.electronAPI.openExternal(currentNotionUrl);
        return;
      }

      if (!currentTranscriptionData || !currentMeetingTitle) {
        alert('No transcription data available');
        return;
      }
      if (!uploadToNotionBtn || uploadToNotionBtn.disabled || cutoffInFlight) return;

      uploadToNotionBtn.disabled = true;
      if (notionButtonLabel) notionButtonLabel.textContent = 'Uploading...';

      try {
        const result = await window.electronAPI.uploadToNotion({
          title: currentMeetingTitle,
          transcriptionData: currentTranscriptionData,
          audioFilePath: currentFilePath || undefined,
          transcriptionPath: currentTranscriptionPath || undefined,
          ...(currentGenerationId !== undefined
            ? { expectedGenerationId: currentGenerationId }
            : {}),
        });

        if (result.success) {
          if (result.url) {
            currentNotionUrl = result.url;
            supersededNotionUrl = null;
            window.electronAPI.openExternal(result.url);
          }
          alert('Successfully uploaded to Notion!');
        } else {
          alert(`Failed to upload to Notion: ${result.error}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        alert(`Error uploading to Notion: ${message}`);
      } finally {
        if (uploadToNotionBtn) uploadToNotionBtn.disabled = false;
        refreshNotionButtonLabel();
      }
    });
  }

  if (sendToSlackBtn) {
    sendToSlackBtn.addEventListener('click', async () => {
      if (!currentTranscriptionData || !currentMeetingTitle) {
        alert('No transcription data available');
        return;
      }
      if (!sendToSlackBtn || sendToSlackBtn.disabled || cutoffInFlight) return;

      // Disable before confirm() to block double-clicks during the prompt.
      sendToSlackBtn.disabled = true;

      if (currentSlackSentAt) {
        const when = new Date(currentSlackSentAt).toLocaleString();
        if (!confirm(`Already sent to Slack on ${when}. Send again?`)) {
          sendToSlackBtn.disabled = false;
          return;
        }
      }

      if (slackButtonLabel) slackButtonLabel.textContent = 'Sending…';

      try {
        const result = await window.electronAPI.sendToSlack({
          title: currentMeetingTitle,
          transcriptionData: currentTranscriptionData,
          transcriptionPath: currentTranscriptionPath || undefined,
          ...(currentGenerationId !== undefined
            ? { expectedGenerationId: currentGenerationId }
            : {}),
          notionUrl: currentNotionUrl || undefined,
        });

        if (result.success) {
          currentSlackSentAt = result.sentAt;
          showToast('Sent to Slack');
        } else {
          alert(`Failed to send to Slack: ${result.error}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        alert(`Error sending to Slack: ${message}`);
      } finally {
        if (sendToSlackBtn) sendToSlackBtn.disabled = false;
        refreshSlackButtonLabel();
      }
    });
  }
}

// Internal helpers other extracted modules may need.
export function _setCurrentTranscription(data: {
  transcriptionData: TranscriptionData | null;
  title: string;
  filePath: string | null | undefined;
  transcriptionPath?: string | null;
  generationId?: string | null;
}): void {
  currentTranscriptionData = data.transcriptionData;
  currentMeetingTitle = data.title;
  currentFilePath = data.filePath;
  currentTranscriptionPath = data.transcriptionPath ?? null;
  currentGenerationId = currentTranscriptionPath ? data.generationId : undefined;
  currentNotionUrl = null;
  supersededNotionUrl = null;
  currentSlackSentAt = null;
  refreshSlackButtonLabel();
  refreshNotionButtonLabel();
}

// Set (offset) or remove (null) the saved note's transcript cutoff, then show
// the report main regenerated from the included text. Uploads and sends stay
// blocked meanwhile so nothing publishes the report being replaced.
async function applyTranscriptCutoff(offset: number | null): Promise<void> {
  const transcriptionPath = currentTranscriptionPath;
  const generationId = currentGenerationId;
  if (!transcriptionPath || generationId === undefined || cutoffInFlight) return;
  if (uploadToNotionBtn?.disabled || sendToSlackBtn?.disabled) {
    showTranscriptCutoffMessage(
      'Wait for the Notion upload or Slack send to finish, then try again.',
      true,
    );
    return;
  }
  if (
    currentNotionUrl &&
    !confirm(
      'This report was already uploaded to Notion. That page will not be changed and will keep showing the current report. After the report is regenerated, you can upload the new version as a new Notion page.\n\nContinue?',
    )
  ) {
    return;
  }

  cutoffInFlight = true;
  setExportButtonsDisabled(true);
  setTranscriptCutoffBusy(
    true,
    offset === null
      ? 'Regenerating the report from the whole transcript...'
      : 'Regenerating the report from the transcript text before the cutoff...',
  );
  try {
    const result = await window.electronAPI.applyTranscriptCutoff({
      transcriptionPath,
      expectedGenerationId: generationId,
      cutoffOffset: offset,
    });
    // The modal may show another note by now; its state is not ours to touch.
    if (currentTranscriptionPath !== transcriptionPath) {
      if (result.success) showToast('Report regenerated');
      return;
    }
    if (!result.success) {
      setTranscriptCutoffBusy(false);
      showTranscriptCutoffMessage(`The report was not changed: ${result.error}`, true);
      return;
    }

    const note = result.data;
    const nextTitle = titleForSavedReport(
      currentMeetingTitle,
      currentTranscriptionData.suggestedTitle,
      note.title,
    );
    const titleWasUpdated = nextTitle !== currentMeetingTitle;
    currentMeetingTitle = nextTitle;
    const titleEl = document.getElementById('transcriptionTitle');
    if (titleEl) titleEl.textContent = `Transcription - ${nextTitle}`;
    currentTranscriptionData = {
      ...currentTranscriptionData,
      suggestedTitle: note.suggestedTitle,
      transcript: note.transcript,
      summary: note.summary,
      summarySections: note.summarySections,
      keyPoints: note.keyPoints || [],
      actionItems: note.actionItems || [],
      actionItemGroups: note.actionItemGroups,
      customFields: note.customFields,
      emoji: note.emoji,
      liveNotes: note.liveNotes,
      highlights: note.highlights,
      transcriptCutoff: note.transcriptCutoff,
      transcriptCutoffMismatch: undefined,
    };
    currentGenerationId = note.generationId;
    currentNotionUrl = note.notionPageUrl ?? null;
    supersededNotionUrl = note.supersededNotionPageUrl ?? null;
    currentSlackSentAt = note.slackSentAt ?? null;
    refreshSlackButtonLabel();
    refreshNotionButtonLabel();

    populateTranscriptionUI(currentTranscriptionData);
    showTab('transcript');
    showTranscriptCutoffMessage(
      note.transcriptCutoff
        ? `Report regenerated from the transcript text before the cutoff. The summary, key points, action items and highlights now cover only that part.${describeFlaggedNotes(note.transcriptCutoff.offset)} ${titleWasUpdated ? 'The suggested meeting title was updated.' : 'The meeting title was kept.'}`
        : 'Report regenerated from the whole transcript and every flagged note.',
    );
    focusTranscriptCutoffStatus();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (currentTranscriptionPath === transcriptionPath) {
      setTranscriptCutoffBusy(false);
      showTranscriptCutoffMessage(`The report was not changed: ${message}`, true);
    }
  } finally {
    cutoffInFlight = false;
    setExportButtonsDisabled(false);
    // Every exit, including success and a modal that now shows another note,
    // must end the busy state or assistive technology keeps the whole modal
    // body marked as loading.
    clearTranscriptCutoffBusy();
  }
}

function setExportButtonsDisabled(disabled: boolean): void {
  if (uploadToNotionBtn) uploadToNotionBtn.disabled = disabled;
  if (sendToSlackBtn) sendToSlackBtn.disabled = disabled;
}

function showTab(tab: string): void {
  document.querySelectorAll('.tab-button').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
  document.querySelector(`.tab-button[data-tab="${tab}"]`)?.classList.add('active');
  document.getElementById(tab)?.classList.add('active');
}
