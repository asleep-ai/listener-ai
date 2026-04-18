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

const DEFAULT_SUMMARY_PROMPT = `Based on this meeting transcript, provide:

1. A concise meeting title in Korean (10-20 characters that captures the main topic)
2. A concise summary in Korean (2-3 paragraphs)
3. Key points discussed in Korean (as a bullet list)
4. Action items mentioned in Korean (as a bullet list)
5. An appropriate emoji that represents the meeting

Return as JSON:
{
  "suggestedTitle": "concise title in Korean",
  "summary": "summary in Korean",
  "keyPoints": ["point 1", "point 2"],
  "actionItems": ["action 1", "action 2"],
  "emoji": "📝"
}`;

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

// Listen for auto-update events
if (window.electronAPI.onUpdateStatus) {
  window.electronAPI.onUpdateStatus((updateInfo) => {
    switch (updateInfo.event) {
      case 'checking-for-update':
        showNotification('Checking for updates...', 'info');
        break;
      case 'download-progress':
        if (updateInfo.data?.percent) {
          showNotification(`Downloading update: ${updateInfo.data.percent.toFixed(2)}%`, 'info');
        }
        break;
      case 'update-error':
        showNotification(`Update error: ${updateInfo.data}`, 'error');
        break;
    }
  });
}

function showNotification(message, type = 'info') {
  const notification = document.createElement('div');
  notification.className = `notification notification-${type}`;
  notification.textContent = message;
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    padding: 12px 20px;
    background: ${type === 'error' ? '#ef4444' : '#3b82f6'};
    color: white;
    border-radius: 8px;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    z-index: 10000;
    animation: slideIn 0.3s ease-out;
  `;
  
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.style.animation = 'slideOut 0.3s ease-out';
    setTimeout(() => notification.remove(), 300);
  }, 5000);
}

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
    geminiModelInput = document.getElementById('geminiModel');
    geminiFlashModelInput = document.getElementById('geminiFlashModel');
    notionApiKeyInput = document.getElementById('notionApiKey');
    notionDatabaseIdInput = document.getElementById('notionDatabaseId');
    globalShortcutInput = document.getElementById('globalShortcut');
    knownWordsInput = document.getElementById('knownWords');
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

  // Meeting detection toggle
  const meetingDetectionToggle = document.getElementById('meetingDetectionToggle');
  const meetingDetectionStatus = document.getElementById('meetingDetectionStatus');
  const meetingDetectionApp = document.getElementById('meetingDetectionApp');

  if (config.meetingDetection !== undefined) {
    meetingDetectionToggle.checked = config.meetingDetection;
  }

  meetingDetectionToggle.addEventListener('change', async () => {
    await window.electronAPI.saveConfig({ meetingDetection: meetingDetectionToggle.checked });
  });

  // Display detection toggle
  const displayDetectionToggle = document.getElementById('displayDetectionToggle');

  if (config.displayDetection !== undefined) {
    displayDetectionToggle.checked = config.displayDetection;
  }

  displayDetectionToggle.addEventListener('change', async () => {
    await window.electronAPI.saveConfig({ displayDetection: displayDetectionToggle.checked });
  });

  // Listen for meeting status changes
  window.electronAPI.onMeetingStatusChanged((status) => {
    if (status.active) {
      meetingDetectionStatus.style.display = 'flex';
      meetingDetectionApp.textContent = `${status.app} meeting detected`;
    } else {
      meetingDetectionStatus.style.display = 'none';
    }
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

function resetRecordingUI() {
  isRecording = false;
  stopTimer();
  recordButton.textContent = 'Start Recording';
  recordButton.classList.remove('recording');
  statusIndicator.classList.remove('recording');
  statusText.textContent = 'Ready to record';
  recordingTime.classList.remove('active');
}

async function processAutoMode(audioPath, recordingTitle) {
  if (!autoModeToggle.checked || !audioPath) return;

  isAutoModeProcessing = true;
  recordButton.disabled = true;
  recordButton.style.opacity = '0.5';
  recordButton.style.cursor = 'not-allowed';
  statusText.textContent = 'Auto mode: Processing recording...';

  try {
    console.log('Auto mode: Starting transcription...');
    const transcriptionResult = await window.electronAPI.transcribeAudio(audioPath);

    if (transcriptionResult.success) {
      console.log('Auto mode: Transcription complete');

      let finalAudioPath = audioPath;
      if (transcriptionResult.newFilePath) {
        finalAudioPath = transcriptionResult.newFilePath;
        console.log('Auto mode: File renamed to:', finalAudioPath);
      }

      const notionConfig = await window.electronAPI.getConfig();
      if (notionConfig.notionApiKey && notionConfig.notionDatabaseId) {
        console.log('Auto mode: Uploading to Notion...');

        const finalTitle = (recordingTitle === '' || recordingTitle === 'Untitled_Meeting') && transcriptionResult.data.suggestedTitle
          ? transcriptionResult.data.suggestedTitle
          : (recordingTitle || transcriptionResult.data.suggestedTitle || 'Untitled Meeting');

        const uploadResult = await window.electronAPI.uploadToNotion({
          title: finalTitle,
          transcriptionData: transcriptionResult.data,
          audioFilePath: finalAudioPath
        });

        if (uploadResult.success) {
          statusText.textContent = 'Auto mode: Successfully uploaded to Notion!';
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
    isAutoModeProcessing = false;
    recordButton.disabled = false;
    recordButton.style.opacity = '';
    recordButton.style.cursor = '';
  }

  setTimeout(() => {
    statusText.textContent = 'Ready to record';
  }, 5000);
}

async function handleRecordingStopped(audioPath, skipAutoUpload = false) {
  resetRecordingUI();
  const recordingTitle = meetingTitle.value.trim() || 'Untitled_Meeting';
  meetingTitle.value = '';
  await refreshRecordingsList();
  if (skipAutoUpload) {
    showToast('Recording too short — auto-upload skipped');
    console.log('Skipping auto-upload: recording below minimum duration');
    return;
  }
  await processAutoMode(audioPath, recordingTitle);
}

async function stopRecording() {
  try {
    const result = await window.electronAPI.stopRecording();
    if (result.success) {
      await handleRecordingStopped(result.filePath, result.skipAutoUpload);
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

if (window.electronAPI.onRecordingAutoStopped) {
  window.electronAPI.onRecordingAutoStopped(async (data) => {
    showToast('Recording auto-stopped - reached time limit');
    await handleRecordingStopped(data?.filePath);
  });
}

// Modal elements - will be initialized after DOM loads
let configModal, transcriptionModal, saveConfigBtn, cancelConfigBtn;
let geminiApiKeyInput, geminiModelInput, geminiFlashModelInput, notionApiKeyInput, notionDatabaseIdInput, globalShortcutInput, knownWordsInput;
let closeTranscriptionBtn, uploadToNotionBtn;


function setupEventListeners() {
  saveConfigBtn.addEventListener('click', async () => {
    const geminiKey = geminiApiKeyInput.value.trim();
    const geminiModel = geminiModelInput ? geminiModelInput.value.trim() : '';
    const geminiFlashModel = geminiFlashModelInput ? geminiFlashModelInput.value.trim() : '';
    const notionKey = notionApiKeyInput.value.trim();
    const notionDb = notionDatabaseIdInput.value.trim();
    const globalShortcut = globalShortcutInput.value.trim();
    const knownWords = knownWordsInput
      ? knownWordsInput.value.split('\n').map(w => w.trim()).filter(w => w.length > 0)
      : [];
    const summaryPromptInput = document.getElementById('summaryPrompt');
    const summaryPrompt = summaryPromptInput ? summaryPromptInput.value.trim() : '';
    const maxRecordingMinutesEl = document.getElementById('maxRecordingMinutes');
    const maxRecordingMinutes = Math.max(0, Math.floor(parseInt(maxRecordingMinutesEl?.value) || 0));
    const recordingReminderMinutesEl = document.getElementById('recordingReminderMinutes');
    const recordingReminderMinutes = Math.max(0, Math.floor(parseInt(recordingReminderMinutesEl?.value) || 0));

    if (geminiKey) {
      await window.electronAPI.saveConfig({
        geminiApiKey: geminiKey,
        geminiModel: geminiModel,
        geminiFlashModel: geminiFlashModel,
        notionApiKey: notionKey,
        notionDatabaseId: notionDb,
        globalShortcut: globalShortcut,
        knownWords: knownWords,
        summaryPrompt: summaryPrompt || DEFAULT_SUMMARY_PROMPT,
        maxRecordingMinutes: maxRecordingMinutes,
        recordingReminderMinutes: recordingReminderMinutes
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

  // Tab handling for transcription modal (event delegation for dynamic tabs)
  document.querySelector('.transcription-tabs').addEventListener('click', (e) => {
    const button = e.target.closest('.tab-button');
    if (!button) return;
    const targetTab = button.dataset.tab;
    document.querySelectorAll('.tab-button').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.remove('active'));
    button.classList.add('active');
    document.getElementById(targetTab)?.classList.add('active');
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

// Convert camelCase key to display label
function camelToLabel(key) {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
}

// Escape HTML to prevent XSS from untrusted content
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

// Convert structured transcription data to a markdown string
function structuredToMarkdown(data, section) {
  const lines = [];

  if (section === 'all' || section === 'summary') {
    if (data.summary) {
      if (section === 'all') lines.push('## Summary\n');
      lines.push(data.summary);
      lines.push('');
    }
  }

  if (section === 'all' || section === 'keypoints') {
    if (data.keyPoints?.length) {
      if (section === 'all') lines.push('## Key Points\n');
      for (const point of data.keyPoints) {
        lines.push(`- ${point}`);
      }
      lines.push('');
    }
  }

  if (section === 'all' || section === 'actions') {
    if (data.actionItems?.length) {
      if (section === 'all') lines.push('## Action Items\n');
      for (const item of data.actionItems) {
        lines.push(`- ${item}`);
      }
      lines.push('');
    }
  }

  if (section === 'all' && data.customFields) {
    for (const [key, value] of Object.entries(data.customFields)) {
      if (value == null) continue;
      lines.push(`## ${camelToLabel(key)}\n`);
      if (Array.isArray(value)) {
        for (const v of value) lines.push(`- ${v}`);
      } else if (typeof value === 'string') {
        lines.push(value);
      } else {
        lines.push('```json\n' + JSON.stringify(value, null, 2) + '\n```');
      }
      lines.push('');
    }
  }

  if (section?.startsWith('cf-') && data.customFields) {
    const cfKey = section.slice(3);
    const value = data.customFields[cfKey];
    if (Array.isArray(value)) {
      for (const v of value) lines.push(`- ${v}`);
    } else if (typeof value === 'string') {
      lines.push(value);
    } else if (value != null) {
      lines.push('```json\n' + JSON.stringify(value, null, 2) + '\n```');
    }
    lines.push('');
  }

  if (section === 'transcript') {
    lines.push(data.transcript || '');
  }

  return lines.join('\n').trim();
}

// Strip raw HTML from markdown output to prevent XSS
marked.use({ renderer: { html: (token) => escapeHtml(token.raw) } });

// Render markdown string to HTML
function renderMarkdown(md) {
  return marked.parse(md || '', { breaks: true });
}

// Render dynamic field tabs (keyPoints, actionItems, and any custom fields)
function renderDynamicFields(data) {
  const fields = [];

  if (data.keyPoints?.length) {
    fields.push({ key: 'keypoints', label: 'Key Points', value: data.keyPoints });
  }
  if (data.actionItems?.length) {
    fields.push({ key: 'actions', label: 'Action Items', value: data.actionItems });
  }
  if (data.customFields) {
    for (const [key, value] of Object.entries(data.customFields)) {
      if (value != null && (typeof value !== 'string' || value.trim())) {
        fields.push({ key: `cf-${key}`, label: camelToLabel(key), value });
      }
    }
  }

  const tabsContainer = document.querySelector('.transcription-tabs');
  const contentContainer = document.querySelector('.tab-content');

  // Remove old dynamic elements and restore first tab as active
  tabsContainer.querySelectorAll('.tab-button.dynamic').forEach(el => el.remove());
  contentContainer.querySelectorAll('.tab-pane.dynamic').forEach(el => el.remove());
  tabsContainer.querySelector('.tab-button')?.classList.add('active');
  contentContainer.querySelector('.tab-pane')?.classList.add('active');

  const transcriptBtn = tabsContainer.querySelector('[data-tab="transcript"]');
  const transcriptPane = document.getElementById('transcript');

  for (const field of fields) {
    // Tab button
    const btn = document.createElement('button');
    btn.className = 'tab-button dynamic';
    btn.dataset.tab = field.key;
    btn.textContent = field.label;
    tabsContainer.insertBefore(btn, transcriptBtn);

    // Tab pane
    const pane = document.createElement('div');
    pane.id = field.key;
    pane.className = 'tab-pane dynamic';

    const safeKey = escapeHtml(field.key);
    const copyBtn = `<button class="copy-button" data-copy-target="${safeKey}">📋 Copy</button>`;
    const md = structuredToMarkdown(data, field.key);
    pane.innerHTML = `${copyBtn}<div class="${safeKey}-content markdown-body">${renderMarkdown(md)}</div>`;
    contentContainer.insertBefore(pane, transcriptPane);
  }
}

// Populate all transcription tabs with data and set up copy handlers
function populateTranscriptionUI(data) {
  // All tab
  const allMd = structuredToMarkdown(data, 'all');
  const allDiv = document.getElementById('all');
  allDiv.innerHTML = allMd
    ? `<button class="copy-button" data-copy-target="all">📋 Copy All</button>
       <div class="all-content markdown-body">${renderMarkdown(allMd)}</div>`
    : '<p class="loading">No content available</p>';

  // Summary tab
  const summaryMd = structuredToMarkdown(data, 'summary');
  const summaryDiv = document.getElementById('summary');
  summaryDiv.innerHTML = summaryMd
    ? `<button class="copy-button" data-copy-target="summary">📋 Copy</button>
       <div class="summary-content markdown-body">${renderMarkdown(summaryMd)}</div>`
    : '<p class="loading">No summary available</p>';

  // Transcript tab
  const formattedTranscript = (data.transcript || '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join('\n');
  const transcriptDiv = document.getElementById('transcript');
  transcriptDiv.innerHTML = `
    <button class="copy-button" data-copy-target="transcript">📋 Copy</button>
    <div class="transcript-content">${escapeHtml(formattedTranscript)}</div>
  `;

  renderDynamicFields(data);
  setupCopyButtons(data);
}

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
      suggestedTitle: metadata.suggestedTitle,
      customFields: metadata.customFields,
    };
    currentMeetingTitle = title;
    currentFilePath = filePath;

    populateTranscriptionUI(currentTranscriptionData);

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
  document.getElementById('all').innerHTML = '<p class="loading">Loading...</p>';
  document.getElementById('summary').innerHTML = '<p class="loading">Loading summary...</p>';
  document.getElementById('transcript').innerHTML = '<p class="loading">Loading transcription...</p>';
  document.querySelectorAll('.tab-button.dynamic').forEach(el => el.remove());
  document.querySelectorAll('.tab-pane.dynamic').forEach(el => el.remove());
  document.querySelectorAll('.tab-button').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.querySelector('[data-tab="all"]').classList.add('active');
  document.getElementById('all').classList.add('active');

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

      populateTranscriptionUI(result.data);

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
  if (geminiModelInput) {
    geminiModelInput.value = config.geminiModel || '';
  }
  if (geminiFlashModelInput) {
    geminiFlashModelInput.value = config.geminiFlashModel || '';
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
  if (knownWordsInput) {
    knownWordsInput.value = (config.knownWords || []).join('\n');
  }
  const maxRecordingMinutesInput = document.getElementById('maxRecordingMinutes');
  if (maxRecordingMinutesInput) {
    maxRecordingMinutesInput.value = config.maxRecordingMinutes || '';
  }
  const recordingReminderMinutesInput = document.getElementById('recordingReminderMinutes');
  if (recordingReminderMinutesInput) {
    recordingReminderMinutesInput.value = config.recordingReminderMinutes || '';
  }

  // Pre-fill summary prompt
  const summaryPromptInput = document.getElementById('summaryPrompt');
  if (summaryPromptInput) {
    summaryPromptInput.value = config.summaryPrompt || DEFAULT_SUMMARY_PROMPT;
  }

  // Reset to default buttons
  const resetGeminiModelBtn = document.getElementById('resetGeminiModel');
  if (resetGeminiModelBtn) {
    resetGeminiModelBtn.onclick = () => {
      if (geminiModelInput) geminiModelInput.value = '';
    };
  }
  const resetGeminiFlashModelBtn = document.getElementById('resetGeminiFlashModel');
  if (resetGeminiFlashModelBtn) {
    resetGeminiFlashModelBtn.onclick = () => {
      if (geminiFlashModelInput) geminiFlashModelInput.value = '';
    };
  }
  const resetPromptBtn = document.getElementById('resetPrompt');
  if (resetPromptBtn) {
    resetPromptBtn.onclick = () => {
      if (summaryPromptInput) {
        summaryPromptInput.value = DEFAULT_SUMMARY_PROMPT;
      }
    };
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

  const sectionLabels = {
    all: 'All', summary: 'Summary', keypoints: 'Key Points',
    actions: 'Action Items', transcript: 'Transcript',
  };

  copyButtons.forEach(button => {
    button.addEventListener('click', async () => {
      const target = button.dataset.copyTarget;
      const sectionName = target.startsWith('cf-')
        ? camelToLabel(target.slice(3))
        : (sectionLabels[target] || target);
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
  dragDropZone.addEventListener('click', async () => {
    try {
      const result = await window.fileHandler.selectFileViaDialog();
      if (result && result.success) {
        await handleFileSuccess(result.filePath, window.fileHandler.extractTitle(result.filePath));
      }
    } catch (error) {
      showToast(error.message, 'error');
    }
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

  // Simply handle each dropped file
  ([...files]).forEach(handleAudioFile);
}

// Handle successful file save
async function handleFileSuccess(filePath, fileName) {
  // Extract title from filename
  const title = window.fileHandler.extractTitle(fileName);

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

  statusText.textContent = 'Ready to record';
}

async function handleAudioFile(file) {
  // Update status
  statusText.textContent = 'Processing audio file...';

  try {
    const result = await window.fileHandler.processAudioFile(file);

    if (result && result.success) {
      await handleFileSuccess(result.filePath, file.name);
    } else {
      const errorMsg = result ? result.error : 'Unknown error';
      showToast(`Failed to save audio file: ${errorMsg}`, 'error');
      statusText.textContent = 'Ready to record';
    }
  } catch (error) {
    showToast(error.message, 'error');
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
        dragDropZone.removeAttribute('data-paste-hint');
      }
    }
  });
}
