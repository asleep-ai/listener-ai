// Renderer entry. Replaces the legacy `<script src="renderer.js">` tag.
// Wires every feature module's `setup*()` after DOMContentLoaded so each
// module owns its own DOM and IPC bindings.

import { setupRecorder } from './audio/recorder';
import { setupFileHandler } from './services/file-handler';
import { getDom, initDom } from './state';
import { setupAgentConfirmHandler, setupHomeChat, setupModalChat } from './ui/chat-panel';
import { checkAndPromptForConfig, setupConfigModal } from './ui/config-modal';
import { setupDragAndDrop, setupPasteListener } from './ui/drag-drop';
import { setupHomeToggles } from './ui/home-toggles';
import { setupLiveNotes } from './ui/live-notes';
import { setupMicSelector } from './ui/mic-selector';
import { setupNotifications } from './ui/notifications';
import { setupPermissionStatus } from './ui/permission-status';
import { loadRecordings, setupRecordingsList } from './ui/recordings-list';
import { setupReleaseNotes } from './ui/release-notes';
import { setupSearch } from './ui/search';
import { setupTranscriptionModal } from './ui/transcription-modal';
import { setupUpdateBadge } from './ui/update-badge';

// Global error handler -- shows a user-visible alert in production builds.
window.addEventListener('error', (event) => {
  console.error('Renderer error:', event.error);
  if (!window.location.href.includes('localhost')) {
    const msg = event.error?.message ?? 'Unknown error';
    alert(`Application error: ${msg}\n\nPlease restart the application.`);
  }
});

// Verify the preload bridge succeeded before any module tries to use it.
if (!window.electronAPI) {
  console.error('electronAPI not found! Preload script may have failed.');
  document.body.innerHTML =
    '<div style="padding: 20px; color: red;">Error: Application failed to load properly. Please restart.</div>';
  throw new Error('electronAPI not available');
}

// File handler is a service singleton consumed by drag-drop, paste, and
// dialog flows. Set up at module load (no DOM dependency) so callers can
// rely on `window.fileHandler` from the first DOMContentLoaded handler.
setupFileHandler();

window.addEventListener('DOMContentLoaded', async () => {
  try {
    const recordButton = document.getElementById('recordButton') as HTMLButtonElement | null;
    const statusIndicator = document.getElementById('statusIndicator');
    const statusText = document.getElementById('statusText');
    const recordingTime = document.getElementById('recordingTime');
    const meetingTitle = document.getElementById('meetingTitle') as HTMLInputElement | null;
    const recordingsListEl = document.getElementById('recordingsList');
    const autoModeToggle = document.getElementById('autoModeToggle') as HTMLInputElement | null;

    if (
      !recordButton ||
      !statusIndicator ||
      !statusText ||
      !recordingTime ||
      !meetingTitle ||
      !recordingsListEl ||
      !autoModeToggle
    ) {
      throw new Error('Required DOM elements missing');
    }

    initDom({
      recordButton,
      statusIndicator,
      statusText,
      recordingTime,
      meetingTitle,
      recordingsList: recordingsListEl,
      autoModeToggle,
      progressContainer: document.getElementById('transcriptionProgress'),
      progressFill: document.getElementById('progressFill'),
      progressText: document.getElementById('progressText'),
      dragDropZone: document.getElementById('dragDropZone'),
    });

    // Setup order: notifications first (other modules call showNotification),
    // recorder before UI that triggers it, then UI modules in any order.
    setupNotifications();
    setupRecorder();
    setupLiveNotes();
    setupHomeToggles();
    setupMicSelector();
    setupPermissionStatus();
    setupRecordingsList();
    setupSearch();
    setupConfigModal();
    setupTranscriptionModal();
    setupHomeChat();
    setupModalChat();
    setupAgentConfirmHandler();
    setupReleaseNotes();
    setupUpdateBadge();
    setupDragAndDrop();
    setupPasteListener();

    // Cross-cutting IPC listeners that aren't owned by a single feature module.
    window.electronAPI.onTranscriptionProgress((progress) => {
      const dom = getDom();
      if (dom.progressContainer && dom.progressFill && dom.progressText) {
        dom.progressFill.style.width = `${progress.percent}%`;
        dom.progressText.textContent = progress.message;
      }
    });

    window.electronAPI.onOpenConfig(() => {
      const configModal = document.getElementById('configModal');
      if (configModal) configModal.style.display = 'block';
    });

    // Open recordings folder button (header).
    const openFolderButton = document.getElementById('openFolderButton');
    if (openFolderButton) {
      openFolderButton.addEventListener('click', async () => {
        await window.electronAPI.openRecordingsFolder();
      });
    }

    // Initial async work: prompt for missing API keys, load recordings list.
    await checkAndPromptForConfig();
    await loadRecordings();

    const loadingIndicator = document.getElementById('loadingIndicator');
    if (loadingIndicator) loadingIndicator.style.display = 'none';
  } catch (error) {
    console.error('Failed to initialize app:', error);
    const msg = error instanceof Error ? error.message : String(error);
    document.body.innerHTML = `<div style="padding: 20px; color: red;">
      <h2>Failed to start application</h2>
      <p>${msg}</p>
      <p>Please restart the application.</p>
    </div>`;
  }
});
