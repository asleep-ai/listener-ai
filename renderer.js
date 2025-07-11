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
  closeTranscriptionBtn = document.querySelector('.close');
  uploadToNotionBtn = document.getElementById('uploadToNotion');
  progressContainer = document.getElementById('transcriptionProgress');
  progressFill = document.getElementById('progressFill');
  progressText = document.getElementById('progressText');
  
  // Setup event listeners
  setupEventListeners();
  
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
});

async function startRecording() {
  // Prevent starting a new recording if auto mode is processing
  if (isAutoModeProcessing) {
    alert('Please wait for auto mode processing to complete before starting a new recording.');
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

function addRecordingToList(title, date, filePath) {
  // Remove the "no recordings" message if it exists
  const noRecordings = recordingsList.querySelector('.no-recordings');
  if (noRecordings) {
    noRecordings.remove();
  }
  
  const recordingItem = document.createElement('div');
  recordingItem.className = 'recording-item';
  recordingItem.innerHTML = `
    <div class="recording-info">
      <div class="recording-title">${title}</div>
      <div class="recording-date">${date.toLocaleString()}</div>
    </div>
    <button class="transcribe-button" data-filepath="${filePath}" data-title="${title}">
      Transcribe
    </button>
  `;
  
  recordingsList.insertBefore(recordingItem, recordingsList.firstChild);
  
  // Add event listener to transcribe button
  const transcribeBtn = recordingItem.querySelector('.transcribe-button');
  transcribeBtn.addEventListener('click', () => {
    console.log('Transcribe button clicked');
    console.log('File path:', filePath);
    console.log('Title:', title);
    handleTranscribe(filePath, title);
  });
}

// Listen for recording status updates
window.electronAPI.onRecordingStatus((status) => {
  console.log('Recording status:', status);
});

// Modal elements - will be initialized after DOM loads
let configModal, transcriptionModal, saveConfigBtn, cancelConfigBtn;
let geminiApiKeyInput, notionApiKeyInput, notionDatabaseIdInput;
let closeTranscriptionBtn, uploadToNotionBtn;


function setupEventListeners() {
  saveConfigBtn.addEventListener('click', async () => {
    const geminiKey = geminiApiKeyInput.value.trim();
    const notionKey = notionApiKeyInput.value.trim();
    const notionDb = notionDatabaseIdInput.value.trim();
    
    if (geminiKey) {
      await window.electronAPI.saveConfig({ 
        geminiApiKey: geminiKey,
        notionApiKey: notionKey,
        notionDatabaseId: notionDb
      });
      configModal.style.display = 'none';
    } else {
      alert('Please enter at least the Gemini API key');
    }
  });

  cancelConfigBtn.addEventListener('click', () => {
    configModal.style.display = 'none';
  });

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
      
      document.getElementById('transcript').textContent = formattedTranscript;
      document.getElementById('summary').innerHTML = `<p>${result.data.summary}</p>`;
      
      // Key points
      const keyPointsList = result.data.keyPoints.map(point => `<li>${point}</li>`).join('');
      document.getElementById('keypoints').innerHTML = keyPointsList ? `<ul>${keyPointsList}</ul>` : '<p>No key points identified</p>';
      
      // Action items
      const actionItemsList = result.data.actionItems.map(item => `<li>${item}</li>`).join('');
      document.getElementById('actions').innerHTML = actionItemsList ? `<ul>${actionItemsList}</ul>` : '<p>No action items identified</p>';
      
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
  
  // Show the modal
  if (configModal) {
    configModal.style.display = 'block';
  }
}

// Function to prompt for individual API keys
async function promptForApiKeys(missingKeys) {
  const config = {};
  
  for (const key of missingKeys) {
    let value = '';
    let promptMessage = '';
    let configKey = '';
    
    switch (key) {
      case 'Gemini API Key':
        promptMessage = 'Enter your Gemini API key:\n(Get one at https://makersuite.google.com/app/apikey)';
        configKey = 'geminiApiKey';
        break;
      case 'Notion Integration Token':
        promptMessage = 'Enter your Notion Integration token:\n(Create one at https://www.notion.so/my-integrations)';
        configKey = 'notionApiKey';
        break;
      case 'Notion Database ID':
        promptMessage = 'Enter your Notion Database ID:\n(Found in your database URL after the workspace name)';
        configKey = 'notionDatabaseId';
        break;
    }
    
    value = prompt(promptMessage);
    if (value && value.trim()) {
      config[configKey] = value.trim();
    }
  }
  
  // Save the configuration
  if (Object.keys(config).length > 0) {
    const result = await window.electronAPI.saveConfig(config);
    if (result.success) {
      alert('API keys saved successfully!');
      
      // Show platform-specific config location
      const configPath = result.configPath || 'application data directory';
      alert(`Configuration saved to:\n${configPath}\n\nThis location is specific to your operating system.`);
    } else {
      alert('Failed to save API keys: ' + result.error);
    }
  }
}

// Function to load and display recordings
async function loadRecordings() {
  try {
    const result = await window.electronAPI.getRecordings();
    
    if (result.success && result.recordings.length > 0) {
      recordingsList.innerHTML = '';
      
      result.recordings.forEach(recording => {
        const recordingItem = createRecordingItem(recording);
        recordingsList.appendChild(recordingItem);
      });
    } else {
      recordingsList.innerHTML = '<p class="no-recordings">No recordings yet</p>';
    }
  } catch (error) {
    console.error('Error loading recordings:', error);
    recordingsList.innerHTML = '<p class="no-recordings">Error loading recordings</p>';
  }
}

// Function to create a recording item element
function createRecordingItem(recording) {
  const item = document.createElement('div');
  item.className = 'recording-item';
  
  const date = new Date(recording.createdAt);
  const dateStr = date.toLocaleDateString();
  const timeStr = date.toLocaleTimeString();
  const sizeStr = formatFileSize(recording.size);
  
  item.innerHTML = `
    <div class="recording-info">
      <h3>${recording.title}</h3>
      <p class="recording-meta">${dateStr} ${timeStr} • ${sizeStr}</p>
    </div>
    <div class="recording-actions">
      <button class="action-button transcribe-btn" data-path="${recording.path}" data-title="${recording.title}">
        Transcribe
      </button>
    </div>
  `;
  
  // Add event listener to transcribe button
  const transcribeBtn = item.querySelector('.transcribe-btn');
  transcribeBtn.addEventListener('click', () => {
    handleTranscribe(recording.path, recording.title);
  });
  
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