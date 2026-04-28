// Drag-and-drop and clipboard-paste handling for audio files. Extracted from
// legacy.ts (~lines 2354-2568).
//
// The drop zone accepts files via drag, click-to-open-dialog, or paste. Each
// path lands in handleAudioFile which calls into FileHandler (cross-module
// service). On success the recordings list is refreshed and the user is
// prompted to transcribe immediately.

import { getFileHandler } from '../services/file-handler';
import { getDom } from '../state';
import { showToast } from './notifications';
import { refreshRecordingsList } from './recordings-list';
import { handleTranscribe } from './transcription-modal';

let dragDropZone: HTMLElement | null = null;

function preventDefaults(e: Event): void {
  e.preventDefault();
  e.stopPropagation();
}

function highlight(): void {
  dragDropZone?.classList.add('drag-over');
}

function unhighlight(): void {
  dragDropZone?.classList.remove('drag-over');
}

function handleDrop(e: DragEvent): void {
  const dt = e.dataTransfer;
  if (!dt) return;
  const files = dt.files;

  // Simply handle each dropped file
  Array.from(files).forEach((file) => {
    void handleAudioFile(file);
  });
}

// Handle successful file save
async function handleFileSuccess(filePath: string, fileName: string): Promise<void> {
  const fileHandler = getFileHandler();
  // Extract title from filename
  const title = fileHandler.extractTitle(fileName);

  // Refresh recordings list
  try {
    await refreshRecordingsList();
  } catch (refreshError) {
    console.error('Error refreshing recordings list:', refreshError);
  }

  // Ask if user wants to transcribe immediately
  if (confirm(`Audio file "${title}" has been added. Would you like to transcribe it now?`)) {
    try {
      await handleTranscribe(filePath, title);
    } catch (transcribeError) {
      console.error('Error starting transcription:', transcribeError);
      showToast('Failed to start transcription', 'error');
    }
  }

  const { statusText } = getDom();
  statusText.textContent = 'Ready to record';
}

async function handleAudioFile(file: File): Promise<void> {
  const fileHandler = getFileHandler();
  const { statusText } = getDom();
  // Update status
  statusText.textContent = 'Processing audio file...';

  try {
    const result = await fileHandler.processAudioFile(file);

    if (result?.success) {
      await handleFileSuccess(result.filePath as string, file.name);
    } else {
      const errorMsg = result ? result.error : 'Unknown error';
      showToast(`Failed to save audio file: ${errorMsg}`, 'error');
      statusText.textContent = 'Ready to record';
    }
  } catch (error) {
    showToast((error as Error).message, 'error');
    statusText.textContent = 'Ready to record';
  }
}

// Setup drag and drop functionality
export function setupDragAndDrop(): void {
  dragDropZone = document.getElementById('dragDropZone');
  if (!dragDropZone) return;

  // Prevent default drag behaviors
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((eventName) => {
    dragDropZone!.addEventListener(eventName, preventDefaults, false);
    document.body.addEventListener(eventName, preventDefaults, false);
  });

  // Highlight drop zone when item is dragged over it
  ['dragenter', 'dragover'].forEach((eventName) => {
    dragDropZone!.addEventListener(eventName, highlight, false);
  });

  ['dragleave', 'drop'].forEach((eventName) => {
    dragDropZone!.addEventListener(eventName, unhighlight, false);
  });

  // Handle dropped files
  dragDropZone.addEventListener('drop', handleDrop as EventListener, false);

  // Allow clicking the zone to open file dialog
  dragDropZone.addEventListener('click', async () => {
    const fileHandler = getFileHandler();
    try {
      const result = await fileHandler.selectFileViaDialog();
      if (result?.success) {
        await handleFileSuccess(
          result.filePath as string,
          fileHandler.extractTitle(result.filePath as string),
        );
      }
    } catch (error) {
      showToast((error as Error).message, 'error');
    }
  });
}

// Setup paste listener for audio files
export function setupPasteListener(): void {
  document.addEventListener('paste', async (e) => {
    // Check if user is typing in a text field
    const activeElement = document.activeElement;
    const isTextInput =
      activeElement &&
      (activeElement.tagName === 'INPUT' ||
        activeElement.tagName === 'TEXTAREA' ||
        (activeElement as HTMLElement).contentEditable === 'true');

    // If user is in a text field, allow normal paste behavior
    if (isTextInput) {
      return;
    }

    e.preventDefault();

    const clipboardData = e.clipboardData;
    if (!clipboardData) return;
    const items = clipboardData.items;
    let audioFile: File | null = null;

    // Look for audio files in clipboard
    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      // Check if it's an audio file
      if (
        item.type.startsWith('audio/') ||
        item.type === 'audio/mp3' ||
        item.type === 'audio/mpeg' ||
        item.type === 'audio/mp4' ||
        item.type === 'audio/x-m4a'
      ) {
        audioFile = item.getAsFile();
        break;
      }
    }

    // If no direct audio file, check for file items
    if (!audioFile) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file?.name) {
            const ext = file.name.toLowerCase().substring(file.name.lastIndexOf('.'));
            if (
              ext === '.mp3' ||
              ext === '.m4a' ||
              ext === '.webm' ||
              ext === '.ogg' ||
              ext === '.opus' ||
              ext === '.wav'
            ) {
              audioFile = file;
              break;
            }
          }
        }
      }
    }

    if (audioFile) {
      // Show visual feedback
      if (dragDropZone) {
        dragDropZone.classList.add('drag-over');
        setTimeout(() => {
          dragDropZone!.classList.remove('drag-over');
        }, 500);
      }

      void handleAudioFile(audioFile);
    } else {
      // Check if clipboard contains file paths (text)
      const text = clipboardData.getData('text');
      if (text && /\.(mp3|m4a|webm|ogg|opus|wav)$/i.test(text.toLowerCase())) {
        showToast('Please copy the actual audio file, not just its path', 'error');
      }
    }
  });

  // Add keyboard shortcut hint
  document.addEventListener('keydown', (e) => {
    // Show hint when Cmd/Ctrl is pressed
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
      if (dragDropZone && !dragDropZone.hasAttribute('data-paste-hint')) {
        dragDropZone.setAttribute('data-paste-hint', 'true');
        const hintElement = document.createElement('div');
        hintElement.className = 'paste-hint';
        hintElement.textContent = 'Press Cmd+V to paste audio files';
        if (window.electronAPI.platform === 'win32') {
          hintElement.textContent = 'Press Ctrl+V to paste audio files';
        }
        dragDropZone.appendChild(hintElement);
      }
    }
  });

  document.addEventListener('keyup', (e) => {
    // Remove hint when Cmd/Ctrl is released
    if (!e.metaKey && !e.ctrlKey) {
      const hint = document.querySelector('.paste-hint');
      if (hint) {
        hint.remove();
        dragDropZone?.removeAttribute('data-paste-hint');
      }
    }
  });
}
