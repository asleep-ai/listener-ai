import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { SimpleAudioRecorder } from './simpleAudioRecorder';
import { GeminiService } from './geminiService';
import { ConfigService } from './configService';
import { NotionService } from './notionService';

let mainWindow: BrowserWindow | null = null;
const audioRecorder = new SimpleAudioRecorder();
const configService = new ConfigService();
let geminiService: GeminiService | null = null;
let notionService: NotionService | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    title: 'Listener.AI',
    icon: path.join(__dirname, '../assets/icon.png') // We'll add this later
  });

  mainWindow.loadFile(path.join(__dirname, '../index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Helper function to rename audio file with generated title
async function renameAudioFile(oldPath: string, suggestedTitle: string): Promise<string> {
  try {
    const dir = path.dirname(oldPath);
    const ext = path.extname(oldPath);
    const oldFileName = path.basename(oldPath, ext);
    
    // Extract timestamp from old filename (format: Untitled_Meeting_2025-07-10T01-34-07-679Z)
    const timestampMatch = oldFileName.match(/_(\d{4}-\d{2}-\d{2}T[\d-]+Z)$/);
    const timestamp = timestampMatch ? timestampMatch[1] : new Date().toISOString().replace(/[:.]/g, '-');
    
    // Sanitize the suggested title
    const sanitizedTitle = suggestedTitle
      .replace(/[<>:"/\\|?*]/g, '_')  // Replace problematic characters
      .replace(/\s+/g, '_')           // Replace spaces with underscores
      .trim();
    
    const newFileName = `${sanitizedTitle}_${timestamp}${ext}`;
    const newPath = path.join(dir, newFileName);
    
    // Rename the file
    await fs.promises.rename(oldPath, newPath);
    console.log(`Renamed file from ${oldFileName} to ${newFileName}`);
    
    return newPath;
  } catch (error) {
    console.error('Error renaming file:', error);
    return oldPath; // Return original path if rename fails
  }
}

// IPC handlers for recording functionality
ipcMain.handle('start-recording', async (event, meetingTitle: string, useAlternativeMethod: boolean = false) => {
  try {
    // Try the CoreAudio method if alternative is requested or as a fallback
    const result = useAlternativeMethod 
      ? await audioRecorder.startRecordingCoreAudio(meetingTitle)
      : await audioRecorder.startRecording(meetingTitle);
    
    // If recording failed, show error dialog
    if (!result.success) {
      dialog.showErrorBox(
        'Recording Failed',
        `Failed to start recording: ${result.error || 'Unknown error'}\n\n` +
        'Please check:\n' +
        '1. Microphone permissions are granted\n' +
        '2. FFmpeg is installed (if on Windows)\n' +
        '3. No other app is using the microphone'
      );
    }
    
    return result;
  } catch (error) {
    console.error('Error starting recording:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    // Show error dialog for unexpected errors
    dialog.showErrorBox(
      'Recording Error',
      `An unexpected error occurred: ${errorMessage}\n\n` +
      'Please try restarting the application.'
    );
    
    return { success: false, error: errorMessage };
  }
});

ipcMain.handle('stop-recording', async () => {
  try {
    const result = await audioRecorder.stopRecording();
    return result;
  } catch (error) {
    console.error('Error stopping recording:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

// Configuration handlers

ipcMain.handle('save-config', async (event, config: { geminiApiKey?: string; notionApiKey?: string; notionDatabaseId?: string; autoMode?: boolean }) => {
  try {
    if (config.geminiApiKey) {
      configService.setGeminiApiKey(config.geminiApiKey);
      // Initialize Gemini service with the new API key
      geminiService = new GeminiService(config.geminiApiKey);
    }
    
    if (config.notionApiKey) {
      configService.setNotionApiKey(config.notionApiKey);
    }
    
    if (config.notionDatabaseId) {
      configService.setNotionDatabaseId(config.notionDatabaseId);
    }
    
    if (config.autoMode !== undefined) {
      configService.setAutoMode(config.autoMode);
    }
    
    // Initialize Notion service if both required fields are present
    if (config.notionApiKey && config.notionDatabaseId) {
      notionService = new NotionService({
        apiKey: config.notionApiKey,
        databaseId: config.notionDatabaseId
      });
    }
    
    return { 
      success: true,
      configPath: app.getPath('userData')
    };
  } catch (error) {
    console.error('Error saving config:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('get-config', async () => {
  return configService.getAllConfig();
});

ipcMain.handle('check-config', async () => {
  return {
    hasConfig: configService.hasRequiredConfig(),
    missing: configService.getMissingConfigs()
  };
});

// Transcription handler
ipcMain.handle('transcribe-audio', async (event, filePath: string) => {
  try {
    console.log('Transcription requested for:', filePath);
    
    // Send progress update
    if (mainWindow) {
      mainWindow.webContents.send('transcription-progress', { percent: 0, message: 'Initializing Gemini service...' });
    }
    
    // Initialize Gemini service if not already initialized
    if (!geminiService) {
      const apiKey = configService.getGeminiApiKey();
      console.log('API key configured:', !!apiKey);
      
      if (!apiKey) {
        return { success: false, error: 'Gemini API key not configured' };
      }
      geminiService = new GeminiService(apiKey);
    }

    // Send progress update
    if (mainWindow) {
      mainWindow.webContents.send('transcription-progress', { percent: 10, message: 'Starting transcription...' });
    }

    console.log('Starting transcription...');
    
    // Set up progress callback
    const progressCallback = (percent: number, message: string) => {
      if (mainWindow) {
        mainWindow.webContents.send('transcription-progress', { percent, message });
      }
    };
    
    const result = await geminiService.transcribeAudio(filePath, progressCallback);
    console.log('Transcription completed successfully');
    
    // Check if we need to rename the file (if it was untitled)
    const fileName = path.basename(filePath);
    if (fileName.includes('Untitled_Meeting') && result.suggestedTitle) {
      const newFilePath = await renameAudioFile(filePath, result.suggestedTitle);
      return { success: true, data: result, newFilePath };
    }
    
    return { success: true, data: result };
  } catch (error) {
    console.error('Error transcribing audio:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

// Notion upload handler
ipcMain.handle('upload-to-notion', async (event, data: { title: string; transcriptionData: any; audioFilePath?: string }) => {
  try {
    console.log('Uploading to Notion:', data.title);
    
    // Initialize Notion service if not already initialized
    if (!notionService) {
      const notionApiKey = configService.getNotionApiKey();
      const notionDatabaseId = configService.getNotionDatabaseId();
      
      if (!notionApiKey || !notionDatabaseId) {
        return { success: false, error: 'Notion configuration not found' };
      }
      
      notionService = new NotionService({
        apiKey: notionApiKey,
        databaseId: notionDatabaseId
      });
    }
    
    // Add "by L.AI" to the title for distinction
    const titleWithSuffix = `${data.title} by L.AI`;
    
    const result = await notionService.createMeetingNote(
      titleWithSuffix,
      new Date(),
      data.transcriptionData,
      data.audioFilePath
    );
    
    return result;
  } catch (error) {
    console.error('Error uploading to Notion:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

// Open external URL
ipcMain.handle('open-external', async (event, url: string) => {
  shell.openExternal(url);
});

// Open recordings folder
ipcMain.handle('open-recordings-folder', async () => {
  const recordingsPath = path.join(app.getPath('userData'), 'recordings');
  
  // Ensure the directory exists
  if (!fs.existsSync(recordingsPath)) {
    fs.mkdirSync(recordingsPath, { recursive: true });
  }
  
  // Open the folder in the system file explorer
  shell.openPath(recordingsPath);
});

// Get list of recordings
ipcMain.handle('get-recordings', async () => {
  try {
    const recordingsDir = path.join(app.getPath('userData'), 'recordings');
    
    // Ensure directory exists
    if (!fs.existsSync(recordingsDir)) {
      return { success: true, recordings: [] };
    }
    
    // Read all files in the recordings directory
    const files = fs.readdirSync(recordingsDir);
    
    // Filter for audio files and get their stats
    const recordings = files
      .filter((file: string) => {
        // Filter out segment files
        if (file.includes('_segment_')) return false;
        return file.endsWith('.mp3') || file.endsWith('.wav');
      })
      .map((file: string) => {
        const filePath = path.join(recordingsDir, file);
        const stats = fs.statSync(filePath);
        
        // Extract title from filename (format: title_timestamp.ext)
        const nameWithoutExt = path.basename(file, path.extname(file));
        const parts = nameWithoutExt.split('_');
        const timestamp = parts.pop(); // Remove timestamp
        const title = parts.join('_') || 'Untitled';
        
        return {
          filename: file,
          path: filePath,
          title: title,
          timestamp: timestamp,
          size: stats.size,
          createdAt: stats.birthtime,
          modifiedAt: stats.mtime
        };
      })
      .sort((a: any, b: any) => b.createdAt.getTime() - a.createdAt.getTime()); // Sort by newest first
    
    return { success: true, recordings };
  } catch (error) {
    console.error('Error getting recordings:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});