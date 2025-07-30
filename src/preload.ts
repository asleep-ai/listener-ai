import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  startRecording: (meetingTitle: string) => ipcRenderer.invoke('start-recording', meetingTitle),
  stopRecording: () => ipcRenderer.invoke('stop-recording'),
  onRecordingStatus: (callback: (status: string) => void) => {
    ipcRenderer.on('recording-status', (_, status) => callback(status));
  },
  checkConfig: () => ipcRenderer.invoke('check-config'),
  saveConfig: (config: { geminiApiKey?: string; notionApiKey?: string; notionDatabaseId?: string; autoMode?: boolean; globalShortcut?: string }) =>
    ipcRenderer.invoke('save-config', config),
  getConfig: () => ipcRenderer.invoke('get-config'),
  transcribeAudio: (filePath: string) => ipcRenderer.invoke('transcribe-audio', filePath),
  uploadToNotion: (data: { title: string; transcriptionData: any; audioFilePath?: string }) =>
    ipcRenderer.invoke('upload-to-notion', data),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  openRecordingsFolder: () => ipcRenderer.invoke('open-recordings-folder'),
  getRecordings: () => ipcRenderer.invoke('get-recordings'),
  onTranscriptionProgress: (callback: (progress: { percent: number; message: string }) => void) => {
    ipcRenderer.on('transcription-progress', (_, progress) => callback(progress));
  },
  // FFmpeg management
  checkFFmpeg: () => ipcRenderer.invoke('check-ffmpeg'),
  downloadFFmpeg: () => ipcRenderer.invoke('download-ffmpeg'),
  cancelFFmpegDownload: () => ipcRenderer.invoke('cancel-ffmpeg-download'),
  onFFmpegDownloadProgress: (callback: (progress: any) => void) => {
    ipcRenderer.on('ffmpeg-download-progress', (_, progress) => callback(progress));
  },

  // System settings
  openMicrophoneSettings: () => ipcRenderer.invoke('open-microphone-settings'),

  // Global shortcut
  validateShortcut: (shortcut: string) => ipcRenderer.invoke('validate-shortcut', shortcut),

  // Tray icon events
  onTrayStartRecording: (callback: () => void) => {
    ipcRenderer.on('tray-start-recording', () => callback());
  },
  onTrayStopRecording: (callback: () => void) => {
    ipcRenderer.on('tray-stop-recording', () => callback());
  },
  onOpenConfig: (callback: () => void) => {
    ipcRenderer.on('open-config', () => callback());
  }
});
