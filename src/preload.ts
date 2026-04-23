import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  startRecording: (meetingTitle: string) => ipcRenderer.invoke('start-recording', meetingTitle),
  stopRecording: () => ipcRenderer.invoke('stop-recording'),
  onRecordingStatus: (callback: (status: string) => void) => {
    ipcRenderer.on('recording-status', (_, status) => callback(status));
  },
  checkConfig: () => ipcRenderer.invoke('check-config'),
  saveConfig: (config: { geminiApiKey?: string; notionApiKey?: string; notionDatabaseId?: string; autoMode?: boolean; meetingDetection?: boolean; displayDetection?: boolean; globalShortcut?: string; knownWords?: string[]; summaryPrompt?: string }) =>
    ipcRenderer.invoke('save-config', config),
  getConfig: () => ipcRenderer.invoke('get-config'),
  transcribeAudio: (filePath: string) => ipcRenderer.invoke('transcribe-audio', filePath),
  uploadToNotion: (data: { title: string; transcriptionData: any; audioFilePath?: string }) =>
    ipcRenderer.invoke('upload-to-notion', data),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  openRecordingsFolder: () => ipcRenderer.invoke('open-recordings-folder'),
  getRecordings: () => ipcRenderer.invoke('get-recordings'),
  searchTranscriptions: (opts: { query: string; fields?: string[]; limit?: number }) =>
    ipcRenderer.invoke('search-transcriptions', opts),
  agentChat: (opts: { question: string; history?: Array<{ role: 'user' | 'model'; text: string }>; scope: { kind: 'all' } | { kind: 'single'; folderName: string } }) =>
    ipcRenderer.invoke('agent-chat', opts),
  onAgentConfirmRequest: (callback: (req: { id: string; proposal: { kind: 'setConfig'; key: string; value: unknown; currentValue?: unknown; description: string } }) => void) => {
    ipcRenderer.on('agent-confirm-request', (_, req) => callback(req));
  },
  sendAgentConfirmResponse: (payload: { id: string; approved: boolean }) =>
    ipcRenderer.invoke('agent-confirm-response', payload),
  onConfigChanged: (callback: (config: unknown) => void) => {
    ipcRenderer.on('config-changed', (_, config) => callback(config));
  },
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
  },
  onRecordingAutoStopped: (callback: (data: unknown) => void) => {
    ipcRenderer.on('recording-auto-stopped', (_event, data) => callback(data));
  },

  // File handling
  saveAudioFile: (fileData: { name: string; data: number[] }) => ipcRenderer.invoke('save-audio-file', fileData),
  saveAudioFileBase64: (fileData: { name: string; dataBase64: string }) => ipcRenderer.invoke('save-audio-file-base64', fileData),
  copyAudioFile: (fileData: { sourcePath: string; name: string }) => ipcRenderer.invoke('copy-audio-file', fileData),
  selectAudioFile: () => ipcRenderer.invoke('select-audio-file'),
  getFileInfo: (filePath: string) => ipcRenderer.invoke('get-file-info', filePath),

  // Metadata handling
  getMetadata: (filePath: string) => ipcRenderer.invoke('get-metadata', filePath),
  saveMetadata: (filePath: string, metadata: any) => ipcRenderer.invoke('save-metadata', filePath, metadata),

  // Auto-update events
  onUpdateStatus: (callback: (updateInfo: { event: string; data?: any }) => void) => {
    ipcRenderer.on('update-status', (_, updateInfo) => callback(updateInfo));
  },

  // Release notes (shown after a version update)
  onShowReleaseNotes: (callback: (notes: { version: string; body: string; url: string }) => void) => {
    ipcRenderer.on('show-release-notes', (_, notes) => callback(notes));
  },
  onOpenReleaseHistory: (callback: () => void) => {
    ipcRenderer.on('open-release-history', () => callback());
  },
  getAllReleases: () => ipcRenderer.invoke('get-all-releases'),

  // Meeting detection
  getMeetingStatus: () => ipcRenderer.invoke('get-meeting-status'),
  onMeetingStatusChanged: (callback: (status: { active: boolean; app?: string }) => void) => {
    ipcRenderer.on('meeting-status-changed', (_, status) => callback(status));
  }
});
