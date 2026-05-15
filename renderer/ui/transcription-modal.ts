// Transcription modal: viewer for transcripts/summaries, handler for new
// transcriptions, copy buttons, and Notion upload trigger.
// Extracted from legacy.ts (~lines 1244-1291, 1417-1872, 2205-2231).
// Behavior preserved verbatim.

import { getDom } from '../state';
import { resetModalChatFor } from './chat-panel';
import { showConfigModal } from './config-modal';
import {
  type TranscriptionData,
  camelToLabel,
  escapeHtml,
  renderDynamicFields,
  renderMarkdown,
  structuredToMarkdown,
} from './markdown-utils';
import { showToast } from './notifications';
import { refreshRecordingsList } from './recordings-list';

// Modal-level mutable state. These were top-level `let`s in legacy.ts; keeping
// them module-private mirrors the original visibility (handleTranscribe,
// showSavedTranscript, performMerge all mutate them).
let currentTranscriptionData: TranscriptionData | null = null;
let currentMeetingTitle = '';
let currentFilePath: string | null | undefined = '';
let currentTranscriptionPath: string | null = null;
let currentNotionUrl: string | null = null;
let currentSlackSentAt: string | null = null;

let transcriptionModal: HTMLElement | null = null;
let closeTranscriptionBtn: Element | null = null;
let uploadToNotionBtn: HTMLButtonElement | null = null;
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
  if (!uploadToNotionBtn) return;
  uploadToNotionBtn.innerHTML = currentNotionUrl
    ? '<span class="notion-icon">📝</span> View in Notion'
    : '<span class="notion-icon">📝</span> Upload to Notion';
}

function ensureTranscriptionModal(): HTMLElement | null {
  if (!transcriptionModal) {
    transcriptionModal = document.getElementById('transcriptionModal');
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

  // Transcript tab
  const formattedTranscript = (data.transcript || '')
    .split('\n')
    .map((line: string) => line.trim())
    .filter((line: string) => line.length > 0)
    .join('\n');
  const transcriptDiv = document.getElementById('transcript');
  if (transcriptDiv) {
    transcriptDiv.innerHTML = `
    <button class="copy-button" data-copy-target="transcript">📋 Copy</button>
    <div class="transcript-content">${escapeHtml(formattedTranscript)}</div>
  `;
  }

  renderDynamicFields(data);
  setupCopyButtons(data);
}

// Function to show saved transcript
export function showSavedTranscript(
  filePath: string,
  title: string,
  metadata: TranscriptionData & { folderName?: string },
  folderName?: string | null,
): void {
  // Make sure modal elements are loaded
  const modal = ensureTranscriptionModal();

  // Show transcription modal
  if (modal) {
    modal.style.display = 'block';
    const titleEl = document.getElementById('transcriptionTitle');
    if (titleEl) titleEl.textContent = `Transcription - ${title}`;

    // Hide progress bar since we're showing saved data
    const { progressContainer } = getDom();
    if (progressContainer) {
      progressContainer.style.display = 'none';
    }

    // Store transcription data for Notion upload
    currentTranscriptionData = {
      transcript: metadata.transcript,
      summary: metadata.summary,
      keyPoints: metadata.keyPoints || [],
      actionItems: metadata.actionItems || [],
      suggestedTitle: metadata.suggestedTitle,
      customFields: metadata.customFields,
      emoji: metadata.emoji,
      liveNotes: metadata.liveNotes,
      highlights: metadata.highlights,
    };
    currentMeetingTitle = title;
    currentFilePath = filePath;
    currentTranscriptionPath =
      (metadata as { transcriptionPath?: string }).transcriptionPath ?? null;
    currentNotionUrl = (metadata as { notionPageUrl?: string }).notionPageUrl ?? null;
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

export async function handleTranscribe(filePath: string, title: string): Promise<void> {
  console.log('handleTranscribe called with:', { filePath, title });

  // Check if API key is configured
  const configCheck = await window.electronAPI.checkConfig();
  console.log('Has config:', configCheck);

  if (!configCheck.hasConfig) {
    if (document.getElementById('configModal')) {
      void showConfigModal();
    } else {
      alert('Please configure your API keys first');
    }
    return;
  }

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
    // Call the transcription API
    let result = await window.electronAPI.transcribeAudio(filePath);

    // FFmpeg is required for transcription. If it's missing, prompt the user
    // to download it via the dialog and then retry once. The dialog handles
    // its own progress UI; we just await its outcome.
    if (!result.success && (result as { code?: string }).code === 'ffmpeg-missing') {
      const { showFFmpegDownloadDialog } = await import('./ffmpeg-dialog');
      const dlResult = await showFFmpegDownloadDialog();
      if (dlResult.success) {
        result = await window.electronAPI.transcribeAudio(filePath);
      }
    }

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
      currentNotionUrl = null;
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
      alert(`Failed to transcribe audio: ${result.error}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    alert(`Error transcribing audio: ${message}`);
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
  modal.style.display = 'block';
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
      const textToCopy = structuredToMarkdown(transcriptionData, target);

      try {
        await navigator.clipboard.writeText(textToCopy);
        showToast(`${sectionName} copied to clipboard`);
      } catch (err) {
        console.error('Failed to copy:', err);
        showToast('Failed to copy to clipboard', 'error');
      }
    });
  });
}

export function setupTranscriptionModal(): void {
  transcriptionModal = document.getElementById('transcriptionModal');
  closeTranscriptionBtn = document.querySelector('#transcriptionModal .close');
  uploadToNotionBtn = document.getElementById('uploadToNotion') as HTMLButtonElement | null;
  sendToSlackBtn = document.getElementById('sendToSlack') as HTMLButtonElement | null;
  slackButtonLabel = document.getElementById('slackButtonLabel');

  if (closeTranscriptionBtn) {
    closeTranscriptionBtn.addEventListener('click', () => {
      if (transcriptionModal) transcriptionModal.style.display = 'none';
    });
  }

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
      if (!uploadToNotionBtn || uploadToNotionBtn.disabled) return;

      uploadToNotionBtn.disabled = true;
      uploadToNotionBtn.textContent = 'Uploading...';

      try {
        const result = await window.electronAPI.uploadToNotion({
          title: currentMeetingTitle,
          transcriptionData: currentTranscriptionData,
          audioFilePath: currentFilePath || undefined,
          transcriptionPath: currentTranscriptionPath || undefined,
        });

        if (result.success) {
          if (result.url) {
            currentNotionUrl = result.url;
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
      if (!sendToSlackBtn || sendToSlackBtn.disabled) return;

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
}): void {
  currentTranscriptionData = data.transcriptionData;
  currentMeetingTitle = data.title;
  currentFilePath = data.filePath;
  currentTranscriptionPath = data.transcriptionPath ?? null;
  currentNotionUrl = null;
  currentSlackSentAt = null;
  refreshSlackButtonLabel();
  refreshNotionButtonLabel();
}
