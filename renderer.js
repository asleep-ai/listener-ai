// Global error handler to catch any uncaught errors
window.addEventListener('error', (event) => {
  console.error('Renderer error:', event.error);
  // Only show alert in production
  if (!window.location.href.includes('localhost')) {
    alert(`Application error: ${event.error?.message || 'Unknown error'}\n\nPlease restart the application.`);
  }
});

// Check if electronAPI is available
if (!window.electronAPI) {
  console.error('electronAPI not found! Preload script may have failed.');
  document.body.innerHTML = '<div style="padding: 20px; color: red;">Error: Application failed to load properly. Please restart.</div>';
  throw new Error('electronAPI not available');
}

let isRecording = false;
let recordingStartTime = null;
let timerInterval = null;
let isAutoModeProcessing = false; // Track if auto mode is processing

// Initialize these after DOM loads to avoid null errors
let recordButton, statusIndicator, statusText, recordingTime, meetingTitle, recordingsList, autoModeToggle;
let progressContainer = null;
let progressFill = null;
let progressText = null;
let dragDropZone = null;

// Listen for transcription progress
window.electronAPI.onTranscriptionProgress((progress) => {
  if (progressContainer && progressFill && progressText) {
    progressFill.style.width = `${progress.percent}%`;
    progressText.textContent = progress.message;
  }
});

// Check for API keys on startup
window.addEventListener('DOMContentLoaded', async () => {
  try {
    // Initialize main UI elements
    recordButton = document.getElementById('recordButton');
    statusIndicator = document.getElementById('statusIndicator');
    statusText = document.getElementById('statusText');
    recordingTime = document.getElementById('recordingTime');
    meetingTitle = document.getElementById('meetingTitle');
    recordingsList = document.getElementById('recordingsList');
    autoModeToggle = document.getElementById('autoModeToggle');

    // Verify critical elements exist
    if (!recordButton) {
      throw new Error('Record button not found in DOM');
    }
    // Initialize modal elements first
    configModal = document.getElementById('configModal');
    transcriptionModal = document.getElementById('transcriptionModal');
    saveConfigBtn = document.getElementById('saveConfig');
    cancelConfigBtn = document.getElementById('cancelConfig');
    geminiApiKeyInput = document.getElementById('geminiApiKey');
    notionApiKeyInput = document.getElementById('notionApiKey');
    notionDatabaseIdInput = document.getElementById('notionDatabaseId');
    globalShortcutInput = document.getElementById('globalShortcut');
    closeTranscriptionBtn = document.querySelector('.close');
    uploadToNotionBtn = document.getElementById('uploadToNotion');
    progressContainer = document.getElementById('transcriptionProgress');
    progressFill = document.getElementById('progressFill');
    progressText = document.getElementById('progressText');
    dragDropZone = document.getElementById('dragDropZone');

    // Setup event listeners
    setupEventListeners();

    // Setup drag and drop listeners
    setupDragAndDrop();
    
    // Setup paste listener
    setupPasteListener();

    // Check for API configuration
    await checkAndPromptForConfig();

    // Add settings button listener
    const settingsButton = document.getElementById('settingsButton');
    if (settingsButton) {
      settingsButton.addEventListener('click', () => {
        showConfigModal();
      });
    }

    // Add open folder button listener
    const openFolderButton = document.getElementById('openFolderButton');
    if (openFolderButton) {
      openFolderButton.addEventListener('click', async () => {
        await window.electronAPI.openRecordingsFolder();
      });
    }

    // Load existing recordings
    await loadRecordings();

    // Hide loading indicator
    const loadingIndicator = document.getElementById('loadingIndicator');
    if (loadingIndicator) {
      loadingIndicator.style.display = 'none';
    }

  } catch (error) {
    console.error('Failed to initialize app:', error);
    document.body.innerHTML = `<div style="padding: 20px; color: red;">
      <h2>Failed to start application</h2>
      <p>${error.message}</p>
      <p>Please restart the application.</p>
    </div>`;
  }

  // Load auto mode preference
  const config = await window.electronAPI.getConfig();
  if (config.autoMode !== undefined) {
    autoModeToggle.checked = config.autoMode;
  }

  // Save auto mode preference when toggled
  autoModeToggle.addEventListener('change', async () => {
    await window.electronAPI.saveConfig({ autoMode: autoModeToggle.checked });
  });

  // Setup record button listener
  recordButton.addEventListener('click', async () => {
    if (!isRecording) {
      startRecording();
    } else {
      stopRecording();
    }
  });

  // Setup tray icon event handlers
  window.electronAPI.onTrayStartRecording(() => {
    // Programmatically click the record button if not recording
    if (!isRecording) {
      recordButton.click();
    }
  });

  window.electronAPI.onTrayStopRecording(() => {
    // Programmatically click the record button if recording
    if (isRecording) {
      recordButton.click();
    }
  });

  window.electronAPI.onOpenConfig(() => {
    // Open config modal when requested from tray
    if (configModal) {
      configModal.style.display = 'block';
    }
  });
});

async function startRecording() {
  // Prevent starting a new recording if auto mode is processing
  if (isAutoModeProcessing) {
    alert('Please wait for auto mode processing to complete before starting a new recording.');
    return;
  }

  // Check if FFmpeg is available
  const ffmpegCheck = await window.electronAPI.checkFFmpeg();
  if (!ffmpegCheck.available) {
    // Show download dialog
    await showFFmpegDownloadDialog();
    return;
  }

  const title = meetingTitle.value.trim() || 'Untitled_Meeting';

  try {
    const result = await window.electronAPI.startRecording(title);
    if (result.success) {
      isRecording = true;
      recordingStartTime = Date.now();

      recordButton.textContent = 'Stop Recording';
      recordButton.classList.add('recording');
      statusIndicator.classList.add('recording');
      statusText.textContent = 'Recording...';
      recordingTime.classList.add('active');

      startTimer();
    } else {
      // Handle error - check what type of error
      if (result.error && result.error.includes('FFmpeg not found')) {
        // FFmpeg check should have already happened above, but just in case
        await showFFmpegDownloadDialog();
      } else if (result.error && result.error.includes('Microphone permission denied')) {
        // Show permission error with button to open settings
        if (confirm('Microphone access is required to record audio.\n\nWould you like to open System Settings to grant permission?\n\nAfter granting permission, please restart Listener.AI.')) {
          await window.electronAPI.openMicrophoneSettings();
        }
      } else if (result.error && result.error.includes('No audio devices found')) {
        // This might be due to permissions or no microphone connected
        if (confirm('No microphone was detected.\n\nThis could be because:\n1. Microphone permissions are denied\n2. No microphone is connected\n3. Audio drivers need updating\n\nWould you like to check System Settings?')) {
          await window.electronAPI.openMicrophoneSettings();
        }
      } else {
        alert('Failed to start recording: ' + (result.error || 'Unknown error'));
      }
    }
  } catch (error) {
    alert('Failed to start recording: ' + error.message);
  }
}

async function stopRecording() {
  try {
    const result = await window.electronAPI.stopRecording();
    if (result.success) {
      isRecording = false;

      recordButton.textContent = 'Start Recording';
      recordButton.classList.remove('recording');
      statusIndicator.classList.remove('recording');
      statusText.textContent = 'Ready to record';
      recordingTime.classList.remove('active');

      stopTimer();

      // Store the title before clearing
      const recordingTitle = meetingTitle.value.trim() || 'Untitled_Meeting';
      let audioPath = result.filePath;

      // Clear the title input
      meetingTitle.value = '';

      // Refresh the recordings list
      await refreshRecordingsList();

      // Auto mode: transcribe and upload automatically
      if (autoModeToggle.checked && audioPath) {
        // Set auto mode processing flag and disable record button
        isAutoModeProcessing = true;
        recordButton.disabled = true;
        recordButton.style.opacity = '0.5';
        recordButton.style.cursor = 'not-allowed';

        // Show a notification that auto mode is running
        statusText.textContent = 'Auto mode: Processing recording...';

        try {
          // Start transcription
          console.log('Auto mode: Starting transcription...');
          const transcriptionResult = await window.electronAPI.transcribeAudio(audioPath);

          if (transcriptionResult.success) {
            console.log('Auto mode: Transcription complete');

            // Update audioPath if file was renamed
            let finalAudioPath = audioPath;
            if (transcriptionResult.newFilePath) {
              finalAudioPath = transcriptionResult.newFilePath;
              console.log('Auto mode: File renamed to:', finalAudioPath);
            }

            // Check if Notion is configured
            const notionConfig = await window.electronAPI.getConfig();
            if (notionConfig.notionApiKey && notionConfig.notionDatabaseId) {
              console.log('Auto mode: Uploading to Notion...');

              // Use generated title if recording was untitled
              const finalTitle = (recordingTitle === '' || recordingTitle === 'Untitled_Meeting') && transcriptionResult.data.suggestedTitle
                ? transcriptionResult.data.suggestedTitle
                : (recordingTitle || transcriptionResult.data.suggestedTitle || 'Untitled Meeting');

              console.log('Auto mode: Final title for Notion:', finalTitle);
              console.log('Auto mode: Recording title was:', recordingTitle);
              console.log('Auto mode: Suggested title was:', transcriptionResult.data.suggestedTitle);

              // Upload to Notion with the correct file path
              const uploadResult = await window.electronAPI.uploadToNotion({
                title: finalTitle,
                transcriptionData: transcriptionResult.data,
                audioFilePath: finalAudioPath
              });

              if (uploadResult.success) {
                statusText.textContent = 'Auto mode: Successfully uploaded to Notion!';

                // Open the Notion page if URL is available
                if (uploadResult.url) {
                  window.electronAPI.openExternal(uploadResult.url);
                }
              } else {
                statusText.textContent = 'Auto mode: Failed to upload to Notion';
                console.error('Auto mode: Notion upload failed:', uploadResult.error);
              }
            } else {
              statusText.textContent = 'Auto mode: Transcription complete (Notion not configured)';
            }

            // Refresh recordings list to show the renamed file
            await refreshRecordingsList();
          } else {
            statusText.textContent = 'Auto mode: Transcription failed';
            console.error('Auto mode: Transcription failed:', transcriptionResult.error);
          }
        } catch (error) {
          statusText.textContent = 'Auto mode: Error processing recording';
          console.error('Auto mode error:', error);
          console.error('Error details:', error.message, error.stack);
        } finally {
          // Clear auto mode processing flag and re-enable record button
          isAutoModeProcessing = false;
          recordButton.disabled = false;
          recordButton.style.opacity = '';
          recordButton.style.cursor = '';
        }

        // Reset status after 5 seconds
        setTimeout(() => {
          statusText.textContent = 'Ready to record';
        }, 5000);
      }
    }
  } catch (error) {
    alert('Failed to stop recording: ' + error.message);
  }
}

function startTimer() {
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    recordingTime.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  recordingTime.textContent = '00:00';
}


// Listen for recording status updates
window.electronAPI.onRecordingStatus((status) => {
  console.log('Recording status:', status);
});

// Modal elements - will be initialized after DOM loads
let configModal, transcriptionModal, saveConfigBtn, cancelConfigBtn;
let geminiApiKeyInput, notionApiKeyInput, notionDatabaseIdInput, globalShortcutInput;
let closeTranscriptionBtn, uploadToNotionBtn;


function setupEventListeners() {
  saveConfigBtn.addEventListener('click', async () => {
    const geminiKey = geminiApiKeyInput.value.trim();
    const notionKey = notionApiKeyInput.value.trim();
    const notionDb = notionDatabaseIdInput.value.trim();
    const globalShortcut = globalShortcutInput.value.trim();

    if (geminiKey) {
      await window.electronAPI.saveConfig({
        geminiApiKey: geminiKey,
        notionApiKey: notionKey,
        notionDatabaseId: notionDb,
        globalShortcut: globalShortcut
      });
      configModal.style.display = 'none';
    } else {
      alert('Please enter at least the Gemini API key');
    }
  });

  cancelConfigBtn.addEventListener('click', () => {
    configModal.style.display = 'none';
  });

  // Global shortcut input handling
  if (globalShortcutInput) {
    globalShortcutInput.addEventListener('focus', () => {
      globalShortcutInput.placeholder = 'Press your shortcut keys...';
    });

    globalShortcutInput.addEventListener('keydown', async (e) => {
      e.preventDefault();

      const modifiers = [];
      if (e.metaKey || e.ctrlKey) modifiers.push('CommandOrControl');
      if (e.altKey) modifiers.push('Alt');
      if (e.shiftKey) modifiers.push('Shift');

      // Get the key (excluding modifier keys)
      let key = e.key;
      if (['Control', 'Alt', 'Shift', 'Meta', 'Command'].includes(key)) {
        return; // Don't capture modifier keys alone
      }

      // Convert special keys
      if (key === ' ') key = 'Space';
      if (key === 'ArrowUp') key = 'Up';
      if (key === 'ArrowDown') key = 'Down';
      if (key === 'ArrowLeft') key = 'Left';
      if (key === 'ArrowRight') key = 'Right';
      if (key.length === 1) key = key.toUpperCase();

      if (modifiers.length > 0) {
        const shortcut = [...modifiers, key].join('+');
        globalShortcutInput.value = shortcut;

        // Validate the shortcut
        const result = await window.electronAPI.validateShortcut(shortcut);
        if (!result.valid) {
          globalShortcutInput.style.borderColor = '#ff4444';
          alert('This shortcut is already in use or invalid. Please try another combination.');
        } else {
          globalShortcutInput.style.borderColor = '';
        }
      }
    });

    globalShortcutInput.addEventListener('blur', () => {
      globalShortcutInput.placeholder = 'Press shortcut keys';
    });
  }

  closeTranscriptionBtn.addEventListener('click', () => {
    transcriptionModal.style.display = 'none';
  });

  // Tab handling for transcription modal
  const tabButtons = document.querySelectorAll('.tab-button');
  const tabPanes = document.querySelectorAll('.tab-pane');

  tabButtons.forEach(button => {
    button.addEventListener('click', () => {
      const targetTab = button.dataset.tab;

      // Update active states
      tabButtons.forEach(btn => btn.classList.remove('active'));
      tabPanes.forEach(pane => pane.classList.remove('active'));

      button.classList.add('active');
      document.getElementById(targetTab).classList.add('active');
    });
  });

  // Handle upload to Notion
  uploadToNotionBtn.addEventListener('click', async () => {
    if (!currentTranscriptionData || !currentMeetingTitle) {
      alert('No transcription data available');
      return;
    }

    uploadToNotionBtn.disabled = true;
    uploadToNotionBtn.textContent = 'Uploading...';

    try {
      const result = await window.electronAPI.uploadToNotion({
        title: currentMeetingTitle,
        transcriptionData: currentTranscriptionData,
        audioFilePath: currentFilePath
      });

      if (result.success) {
        alert('Successfully uploaded to Notion!');
        if (result.url) {
          // Open the Notion page in browser
          window.electronAPI.openExternal(result.url);
        }
      } else {
        alert('Failed to upload to Notion: ' + result.error);
      }
    } catch (error) {
      alert('Error uploading to Notion: ' + error.message);
    } finally {
      uploadToNotionBtn.disabled = false;
      uploadToNotionBtn.innerHTML = '<span class="notion-icon">📝</span> Upload to Notion';
    }
  });
}

// Store current transcription data for Notion upload
let currentTranscriptionData = null;
let currentMeetingTitle = '';
let currentFilePath = '';

// Function to show saved transcript
function showSavedTranscript(filePath, title, metadata) {
  // Make sure modal elements are loaded
  if (!transcriptionModal) {
    transcriptionModal = document.getElementById('transcriptionModal');
  }

  // Show transcription modal
  if (transcriptionModal) {
    transcriptionModal.style.display = 'block';
    document.getElementById('transcriptionTitle').textContent = `Transcription - ${title}`;

    // Hide progress bar since we're showing saved data
    if (progressContainer) {
      progressContainer.style.display = 'none';
    }

    // Store transcription data for Notion upload
    currentTranscriptionData = {
      transcript: metadata.transcript,
      summary: metadata.summary,
      keyPoints: metadata.keyPoints || [],
      actionItems: metadata.actionItems || [],
      suggestedTitle: metadata.suggestedTitle
    };
    currentMeetingTitle = title;
    currentFilePath = filePath;

    // Update the UI with transcription results
    // Format transcript with proper line breaks
    const formattedTranscript = (metadata.transcript || '')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join('\n');

    // Update transcript
    const transcriptDiv = document.getElementById('transcript');
    transcriptDiv.innerHTML = `
      <button class="copy-button" data-copy-target="transcript">
        📋 Copy
      </button>
      <div class="transcript-content">${formattedTranscript}</div>
    `;

    // Update summary
    const summaryDiv = document.getElementById('summary');
    summaryDiv.innerHTML = `
      <button class="copy-button" data-copy-target="summary">
        📋 Copy
      </button>
      <p class="summary-content">${metadata.summary || 'No summary available'}</p>
    `;

    // Key points
    const keyPointsList = (metadata.keyPoints || []).map(point => `<li>${point}</li>`).join('');
    const keyPointsDiv = document.getElementById('keypoints');
    if (keyPointsList) {
      keyPointsDiv.innerHTML = `
        <button class="copy-button" data-copy-target="keypoints">
          📋 Copy
        </button>
        <ul class="keypoints-content">${keyPointsList}</ul>
      `;
    } else {
      keyPointsDiv.innerHTML = '<p>No key points identified</p>';
    }

    // Action items
    const actionItemsList = (metadata.actionItems || []).map(item => `<li>${item}</li>`).join('');
    const actionsDiv = document.getElementById('actions');
    if (actionItemsList) {
      actionsDiv.innerHTML = `
        <button class="copy-button" data-copy-target="actions">
          📋 Copy
        </button>
        <ul class="actions-content">${actionItemsList}</ul>
      `;
    } else {
      actionsDiv.innerHTML = '<p>No action items identified</p>';
    }

    // Setup copy button event listeners
    setupCopyButtons(currentTranscriptionData);

    // Show upload to Notion button if configured
    window.electronAPI.getConfig().then(config => {
      if (config.notionApiKey && config.notionDatabaseId) {
        uploadToNotionBtn.style.display = 'flex';
      }
    });
  }
}

async function handleTranscribe(filePath, title) {
  console.log('handleTranscribe called with:', { filePath, title });

  // Check if API key is configured
  const hasConfig = await window.electronAPI.checkConfig();
  console.log('Has config:', hasConfig);

  if (!hasConfig) {
    if (configModal) {
      configModal.style.display = 'block';
    } else {
      alert('Please configure your API keys first');
    }
    return;
  }

  // Make sure modal elements are loaded
  if (!transcriptionModal) {
    transcriptionModal = document.getElementById('transcriptionModal');
  }

  // Show transcription modal
  if (transcriptionModal) {
    transcriptionModal.style.display = 'block';
    document.getElementById('transcriptionTitle').textContent = `Transcription - ${title}`;

    // Show progress bar
    if (progressContainer) {
      progressContainer.style.display = 'block';
      progressFill.style.width = '0%';
      progressText.textContent = 'Initializing transcription...';
    }
  } else {
    console.error('Transcription modal not found');
    return;
  }

  // Reset all tabs to loading state
  document.getElementById('transcript').innerHTML = '<p class="loading">Loading transcription...</p>';
  document.getElementById('summary').innerHTML = '<p class="loading">Loading summary...</p>';
  document.getElementById('keypoints').innerHTML = '<ul class="loading">Loading key points...</ul>';
  document.getElementById('actions').innerHTML = '<ul class="loading">Loading action items...</ul>';

  // Disable the transcribe button
  const button = document.querySelector(`[data-filepath="${filePath}"]`);
  if (button) {
    button.disabled = true;
    button.textContent = 'Transcribing...';
  }

  try {
    // Call the transcription API
    const result = await window.electronAPI.transcribeAudio(filePath);

    if (result.success) {
      // Hide progress bar
      if (progressContainer) {
        progressContainer.style.display = 'none';
      }

      // Update file path if it was renamed
      if (result.newFilePath) {
        filePath = result.newFilePath;
        // Update the title if it was generated
        if (result.data.suggestedTitle && title === 'Untitled_Meeting') {
          title = result.data.suggestedTitle;
          document.getElementById('transcriptionTitle').textContent = `Transcription - ${title}`;
        }
      }

      // Store transcription data for Notion upload
      currentTranscriptionData = result.data;
      currentMeetingTitle = title;
      currentFilePath = filePath;

      // Update the UI with transcription results
      // Format transcript with proper line breaks
      const formattedTranscript = result.data.transcript
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .join('\n');

      // Update transcript
      const transcriptDiv = document.getElementById('transcript');
      transcriptDiv.innerHTML = `
        <button class="copy-button" data-copy-target="transcript">
          📋 Copy
        </button>
        <div class="transcript-content">${formattedTranscript}</div>
      `;

      // Update summary
      const summaryDiv = document.getElementById('summary');
      summaryDiv.innerHTML = `
        <button class="copy-button" data-copy-target="summary">
          📋 Copy
        </button>
        <p class="summary-content">${result.data.summary}</p>
      `;

      // Key points
      const keyPointsList = result.data.keyPoints.map(point => `<li>${point}</li>`).join('');
      const keyPointsDiv = document.getElementById('keypoints');
      if (keyPointsList) {
        keyPointsDiv.innerHTML = `
          <button class="copy-button" data-copy-target="keypoints">
            📋 Copy
          </button>
          <ul class="keypoints-content">${keyPointsList}</ul>
        `;
      } else {
        keyPointsDiv.innerHTML = '<p>No key points identified</p>';
      }

      // Action items
      const actionItemsList = result.data.actionItems.map(item => `<li>${item}</li>`).join('');
      const actionsDiv = document.getElementById('actions');
      if (actionItemsList) {
        actionsDiv.innerHTML = `
          <button class="copy-button" data-copy-target="actions">
            📋 Copy
          </button>
          <ul class="actions-content">${actionItemsList}</ul>
        `;
      } else {
        actionsDiv.innerHTML = '<p>No action items identified</p>';
      }

      // Setup copy button event listeners
      setupCopyButtons(result.data);

      // Show upload to Notion button if configured
      const notionConfig = await window.electronAPI.getConfig();
      if (notionConfig.notionApiKey && notionConfig.notionDatabaseId) {
        uploadToNotionBtn.style.display = 'flex';
      }
    } else {
      alert('Failed to transcribe audio: ' + result.error);
    }
  } catch (error) {
    alert('Error transcribing audio: ' + error.message);
  } finally {
    // Re-enable the button
    if (button) {
      button.disabled = false;
      button.textContent = 'Transcribe';
    }
  }
}

// Function to check and prompt for API keys
async function checkAndPromptForConfig() {
  const configCheck = await window.electronAPI.checkConfig();

  if (!configCheck.hasConfig) {
    const missing = configCheck.missing;
    const message = `The following API keys are missing:\n${missing.join('\n')}\n\nWould you like to configure them now?`;

    if (confirm(message)) {
      // Show the config modal instead of using prompts
      showConfigModal();
    }
  }
}

// Function to show the config modal
async function showConfigModal() {
  // Load current config
  const config = await window.electronAPI.getConfig();

  // Pre-fill the form if values exist
  if (geminiApiKeyInput && config.geminiApiKey) {
    geminiApiKeyInput.value = config.geminiApiKey;
  }
  if (notionApiKeyInput && config.notionApiKey) {
    notionApiKeyInput.value = config.notionApiKey;
  }
  if (notionDatabaseIdInput && config.notionDatabaseId) {
    notionDatabaseIdInput.value = config.notionDatabaseId;
  }
  if (globalShortcutInput && config.globalShortcut) {
    globalShortcutInput.value = config.globalShortcut;
  }

  // Show the modal
  if (configModal) {
    configModal.style.display = 'block';
  }
}


// Function to load and display recordings
async function loadRecordings() {
  try {
    const result = await window.electronAPI.getRecordings();

    if (result.success && result.recordings.length > 0) {
      recordingsList.innerHTML = '';

      // Use Promise.all to handle async createRecordingItem
      const items = await Promise.all(
        result.recordings.map(recording => createRecordingItem(recording))
      );
      items.forEach(item => recordingsList.appendChild(item));
    } else {
      recordingsList.innerHTML = '<p class="no-recordings">No recordings yet</p>';
    }
  } catch (error) {
    console.error('Error loading recordings:', error);
    recordingsList.innerHTML = '<p class="no-recordings">Error loading recordings</p>';
  }
}

// Function to create a recording item element
async function createRecordingItem(recording) {
  const item = document.createElement('div');
  item.className = 'recording-item';

  const date = new Date(recording.createdAt);
  const dateStr = date.toLocaleDateString();
  const timeStr = date.toLocaleTimeString();
  const sizeStr = formatFileSize(recording.size);

  // Check if metadata exists for this recording
  const metadataResult = await window.electronAPI.getMetadata(recording.path);
  const hasTranscript = metadataResult.success && metadataResult.data && metadataResult.data.transcript;

  item.innerHTML = `
    <div class="recording-info">
      <h3>${recording.title}</h3>
      <p class="recording-meta">${dateStr} ${timeStr} • ${sizeStr}</p>
    </div>
    <div class="recording-actions">
      ${hasTranscript ? `
        <button class="action-button view-transcript-btn" data-path="${recording.path}" data-title="${recording.title}">
          View Transcript
        </button>
        <button class="action-button regenerate-btn" data-path="${recording.path}" data-title="${recording.title}" title="Regenerate transcript">
          🔄
        </button>
      ` : `
        <button class="action-button transcribe-btn" data-path="${recording.path}" data-title="${recording.title}">
          Transcribe
        </button>
      `}
    </div>
  `;

  // Add event listeners based on available actions
  if (hasTranscript) {
    const viewBtn = item.querySelector('.view-transcript-btn');
    viewBtn.addEventListener('click', () => {
      showSavedTranscript(recording.path, recording.title, metadataResult.data);
    });

    const regenerateBtn = item.querySelector('.regenerate-btn');
    regenerateBtn.addEventListener('click', () => {
      if (confirm('Are you sure you want to regenerate the transcript? This will overwrite the existing one.')) {
        handleTranscribe(recording.path, recording.title);
      }
    });
  } else {
    const transcribeBtn = item.querySelector('.transcribe-btn');
    transcribeBtn.addEventListener('click', () => {
      handleTranscribe(recording.path, recording.title);
    });
  }

  return item;
}

// Function to format file size
function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Function to refresh recordings list after a new recording
async function refreshRecordingsList() {
  await loadRecordings();
}

// Copy functionality
function setupCopyButtons(transcriptionData) {
  const copyButtons = document.querySelectorAll('.copy-button');

  copyButtons.forEach(button => {
    button.addEventListener('click', async () => {
      const target = button.dataset.copyTarget;
      let textToCopy = '';
      let sectionName = '';

      switch (target) {
        case 'transcript':
          textToCopy = transcriptionData.transcript;
          sectionName = 'Transcript';
          break;
        case 'summary':
          textToCopy = transcriptionData.summary;
          sectionName = 'Summary';
          break;
        case 'keypoints':
          textToCopy = transcriptionData.keyPoints.join('\n');
          sectionName = 'Key Points';
          break;
        case 'actions':
          textToCopy = transcriptionData.actionItems.join('\n');
          sectionName = 'Action Items';
          break;
      }

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

// Show toast notification
function showToast(message, type = 'success') {
  // Remove any existing toast
  const existingToast = document.querySelector('.toast');
  if (existingToast) {
    existingToast.remove();
  }

  // Create new toast
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;

  if (type === 'error') {
    toast.style.background = '#e74c3c';
  }

  document.body.appendChild(toast);

  // Remove toast after 3 seconds
  setTimeout(() => {
    toast.remove();
  }, 3000);
}

// FFmpeg download management
async function showFFmpegDownloadDialog() {
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

  if (progressFillEl) progressFillEl.style.width = '0%';
  if (progressPercentEl) progressPercentEl.textContent = '0%';
  if (downloadSpeedEl) downloadSpeedEl.textContent = '0 MB/s';
  if (downloadEtaEl) downloadEtaEl.textContent = 'Calculating...';
  if (downloadStatusEl) downloadStatusEl.textContent = 'Downloading FFmpeg for audio recording...';

  // Setup cancel button
  const cancelBtn = document.getElementById('cancelDownload');
  if (cancelBtn) {
    cancelBtn.onclick = async () => {
      await window.electronAPI.cancelFFmpegDownload();
      overlay.style.display = 'none';
    };
  }

  // Listen for progress updates
  const progressHandler = (progress) => {
    switch (progress.status) {
      case 'preparing':
        if (downloadStatusEl) downloadStatusEl.textContent = 'Preparing download...';
        break;
      case 'downloading':
        if (downloadStatusEl) downloadStatusEl.textContent = 'Downloading FFmpeg...';
        if (progressFillEl) progressFillEl.style.width = `${progress.percent}%`;
        if (progressPercentEl) progressPercentEl.textContent = `${progress.percent}%`;
        if (downloadSpeedEl) downloadSpeedEl.textContent = progress.speed;
        if (downloadEtaEl) downloadEtaEl.textContent = progress.eta;
        break;
      case 'extracting':
        if (downloadStatusEl) downloadStatusEl.textContent = 'Extracting FFmpeg...';
        if (progressFillEl) progressFillEl.style.width = '90%';
        if (progressPercentEl) progressPercentEl.textContent = '90%';
        break;
      case 'verifying':
        if (downloadStatusEl) downloadStatusEl.textContent = 'Verifying installation...';
        if (progressFillEl) progressFillEl.style.width = '95%';
        if (progressPercentEl) progressPercentEl.textContent = '95%';
        break;
      case 'complete':
        if (downloadStatusEl) downloadStatusEl.textContent = 'FFmpeg installed successfully!';
        if (progressFillEl) progressFillEl.style.width = '100%';
        if (progressPercentEl) progressPercentEl.textContent = '100%';
        setTimeout(() => {
          overlay.style.display = 'none';
          // Try to start recording again
          startRecording();
        }, 1000);
        break;
      case 'error':
        if (downloadStatusEl) {
          downloadStatusEl.textContent = 'Download failed. Please try again.';
          downloadStatusEl.style.color = '#e74c3c';
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
        downloadStatusEl.style.color = '#e74c3c';
      }
      if (cancelBtn) cancelBtn.textContent = 'Close';
    }
  } catch (error) {
    const downloadStatus = document.getElementById('downloadStatus');
    if (downloadStatus) {
      downloadStatus.textContent = `Download error: ${error.message}`;
      downloadStatus.style.color = '#e74c3c';
    }
    if (cancelBtn) cancelBtn.textContent = 'Close';
  }
}

// Setup drag and drop functionality
function setupDragAndDrop() {
  if (!dragDropZone) return;

  // Prevent default drag behaviors
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dragDropZone.addEventListener(eventName, preventDefaults, false);
    document.body.addEventListener(eventName, preventDefaults, false);
  });

  // Highlight drop zone when item is dragged over it
  ['dragenter', 'dragover'].forEach(eventName => {
    dragDropZone.addEventListener(eventName, highlight, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dragDropZone.addEventListener(eventName, unhighlight, false);
  });

  // Handle dropped files
  dragDropZone.addEventListener('drop', handleDrop, false);

  // Allow clicking the zone to open file dialog
  dragDropZone.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.mp3,.m4a';
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (file) {
        handleAudioFile(file);
      }
    };
    input.click();
  });
}

function preventDefaults(e) {
  e.preventDefault();
  e.stopPropagation();
}

function highlight(e) {
  dragDropZone.classList.add('drag-over');
}

function unhighlight(e) {
  dragDropZone.classList.remove('drag-over');
}

function handleDrop(e) {
  const dt = e.dataTransfer;
  const files = dt.files;

  ([...files]).forEach(handleAudioFile);
}

async function handleAudioFile(file) {
  // Check if file is audio (mp3 or m4a)
  const validTypes = ['audio/mp3', 'audio/mpeg', 'audio/mp4', 'audio/x-m4a'];
  const validExtensions = ['.mp3', '.m4a'];
  
  const fileExtension = file.name.toLowerCase().substring(file.name.lastIndexOf('.'));
  
  if (!validTypes.includes(file.type) && !validExtensions.includes(fileExtension)) {
    showToast('Please drop an MP3 or M4A audio file', 'error');
    return;
  }

  // Update status
  statusText.textContent = 'Processing audio file...';

  try {
    // Read file as buffer
    const buffer = await file.arrayBuffer();
    const uint8Array = new Uint8Array(buffer);
    
    // Send file data to main process
    const result = await window.electronAPI.saveAudioFile({
      name: file.name,
      data: Array.from(uint8Array)
    });
    
    if (result.success) {
      // Extract title from filename (remove extension)
      const title = file.name.replace(/\.[^/.]+$/, '');
      
      // Refresh recordings list
      await refreshRecordingsList();
      
      // Ask if user wants to transcribe immediately
      if (confirm(`Audio file "${title}" has been added. Would you like to transcribe it now?`)) {
        handleTranscribe(result.filePath, title);
      }
      
      statusText.textContent = 'Ready to record';
    } else {
      showToast('Failed to process audio file: ' + result.error, 'error');
      statusText.textContent = 'Ready to record';
    }
  } catch (error) {
    showToast('Error processing audio file: ' + error.message, 'error');
    statusText.textContent = 'Ready to record';
  }
}

// Setup paste listener for audio files
function setupPasteListener() {
  document.addEventListener('paste', async (e) => {
    // Check if user is typing in a text field
    const activeElement = document.activeElement;
    const isTextInput = activeElement && (
      activeElement.tagName === 'INPUT' || 
      activeElement.tagName === 'TEXTAREA' || 
      activeElement.contentEditable === 'true'
    );
    
    // If user is in a text field, allow normal paste behavior
    if (isTextInput) {
      return;
    }
    
    e.preventDefault();
    
    const items = e.clipboardData.items;
    let audioFile = null;
    
    // Look for audio files in clipboard
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      
      // Check if it's an audio file
      if (item.type.startsWith('audio/') || 
          item.type === 'audio/mp3' || 
          item.type === 'audio/mpeg' || 
          item.type === 'audio/mp4' || 
          item.type === 'audio/x-m4a') {
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
          if (file && file.name) {
            const ext = file.name.toLowerCase().substring(file.name.lastIndexOf('.'));
            if (ext === '.mp3' || ext === '.m4a') {
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
          dragDropZone.classList.remove('drag-over');
        }, 500);
      }
      
      handleAudioFile(audioFile);
    } else {
      // Check if clipboard contains file paths (text)
      const text = e.clipboardData.getData('text');
      if (text && (text.toLowerCase().endsWith('.mp3') || text.toLowerCase().endsWith('.m4a'))) {
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
        if (process.platform === 'win32') {
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
        dragDropZone.removeAttribute('data-paste-hint');
      }
    }
  });
}

// Update Notification Handlers
function initUpdateNotifications() {
  const updateNotification = document.getElementById('updateNotification');
  const updateVersion = document.getElementById('updateVersion');
  const updateStability = document.getElementById('updateStability');
  const stabilityText = document.getElementById('stabilityText');
  const downloadButton = document.getElementById('downloadUpdate');
  const remindLaterButton = document.getElementById('remindLater');
  const dismissButton = document.getElementById('dismissUpdate');
  const dontShowAgainCheckbox = document.getElementById('dontShowAgain');
  
  let currentUpdateInfo = null;
  
  // Listen for update available events
  window.electronAPI.onUpdateAvailable((updateInfo) => {
    currentUpdateInfo = updateInfo;
    
    // Update UI with version info
    updateVersion.textContent = `Version ${updateInfo.version} is ready to download`;
    
    // Show stability indicator if stable
    if (updateInfo.stabilitySince) {
      updateStability.style.display = 'flex';
      const hoursStable = Math.floor((Date.now() - new Date(updateInfo.stabilitySince).getTime()) / (1000 * 60 * 60));
      stabilityText.textContent = `This version has been stable for ${hoursStable}+ hours`;
    } else {
      updateStability.style.display = 'none';
    }
    
    // Show notification
    updateNotification.style.display = 'block';
    
    // Reset checkbox
    dontShowAgainCheckbox.checked = false;
  });
  
  // Download button handler
  downloadButton.addEventListener('click', async () => {
    if (currentUpdateInfo && currentUpdateInfo.downloadUrl) {
      // Open download URL in browser
      await window.electronAPI.openExternal(currentUpdateInfo.downloadUrl);
      updateNotification.style.display = 'none';
    }
  });
  
  // Remind later button handler
  remindLaterButton.addEventListener('click', () => {
    updateNotification.style.display = 'none';
    // Will be reminded on next check (1 hour)
  });
  
  // Dismiss button handler
  dismissButton.addEventListener('click', async () => {
    if (dontShowAgainCheckbox.checked && currentUpdateInfo) {
      // Dismiss this version permanently
      await window.electronAPI.dismissUpdateVersion(currentUpdateInfo.version);
    }
    updateNotification.style.display = 'none';
  });
  
  // Check for updates on startup (after a short delay)
  setTimeout(async () => {
    const result = await window.electronAPI.checkForUpdates();
    if (result.success && result.data.hasUpdate) {
      // Update will be shown automatically via the onUpdateAvailable listener
      console.log('Update available:', result.data.latestVersion);
    }
  }, 5000); // Check 5 seconds after app starts
}

// Initialize update notifications when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initUpdateNotifications);
} else {
  initUpdateNotifications();
}

// Development helpers (only available in dev mode)
if (!window.location.href.includes('app://')) {
  window.testUpdate = {
    // Test stable update (4+ hours old)
    stable: () => {
      window.electronAPI.onUpdateAvailable({
        version: '2.0.0',
        releaseNotes: '## What\'s New\n\n- Amazing new features\n- Performance improvements\n- Bug fixes',
        downloadUrl: 'https://github.com/asleep-ai/listener-ai/releases/tag/v2.0.0',
        publishedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
        stabilitySince: new Date(Date.now() - 2 * 60 * 60 * 1000)
      });
    },
    
    // Test unstable update (less than 3 hours old)
    unstable: () => {
      window.electronAPI.onUpdateAvailable({
        version: '2.1.0-beta',
        releaseNotes: '## Beta Release\n\n- Experimental features\n- Not yet stable',
        downloadUrl: 'https://github.com/asleep-ai/listener-ai/releases/tag/v2.1.0-beta',
        publishedAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
        stabilitySince: undefined
      });
    },
    
    // Force check for updates
    check: async () => {
      const result = await window.electronAPI.checkForUpdates();
      console.log('Update check result:', result);
      return result;
    }
  };
  
  console.log('🧪 Update test helpers available:');
  console.log('  window.testUpdate.stable()   - Show stable update notification');
  console.log('  window.testUpdate.unstable() - Show unstable update notification');
  console.log('  window.testUpdate.check()    - Force check for updates');
}
