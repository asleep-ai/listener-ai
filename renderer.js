let isRecording = false;
let recordingStartTime = null;
let timerInterval = null;

const recordButton = document.getElementById('recordButton');
const statusIndicator = document.getElementById('statusIndicator');
const statusText = document.getElementById('statusText');
const recordingTime = document.getElementById('recordingTime');
const meetingTitle = document.getElementById('meetingTitle');
const recordingsList = document.getElementById('recordingsList');

recordButton.addEventListener('click', async () => {
  if (!isRecording) {
    startRecording();
  } else {
    stopRecording();
  }
});

async function startRecording() {
  const title = meetingTitle.value.trim();
  if (!title) {
    alert('Please enter a meeting title');
    meetingTitle.focus();
    return;
  }

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
      
      // Add to recent recordings with file path
      addRecordingToList(meetingTitle.value, new Date(), result.filePath);
      
      // Clear the title input
      meetingTitle.value = '';
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

// Check for API configuration on startup
window.addEventListener('DOMContentLoaded', async () => {
  // Initialize modal elements after DOM is loaded
  configModal = document.getElementById('configModal');
  transcriptionModal = document.getElementById('transcriptionModal');
  saveConfigBtn = document.getElementById('saveConfig');
  cancelConfigBtn = document.getElementById('cancelConfig');
  geminiApiKeyInput = document.getElementById('geminiApiKey');
  notionApiKeyInput = document.getElementById('notionApiKey');
  notionDatabaseIdInput = document.getElementById('notionDatabaseId');
  closeTranscriptionBtn = document.querySelector('.close');
  uploadToNotionBtn = document.getElementById('uploadToNotion');
  
  // Debug modal elements
  console.log('Modal elements:', {
    configModal: !!configModal,
    transcriptionModal: !!transcriptionModal,
    closeTranscriptionBtn: !!closeTranscriptionBtn
  });
  
  // Setup event listeners after elements are loaded
  setupEventListeners();
  
  const hasConfig = await window.electronAPI.checkConfig();
  if (!hasConfig) {
    configModal.style.display = 'block';
  }
});

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