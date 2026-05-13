import { contextBridge, ipcRenderer } from 'electron';
import type { LiveNote } from './outputService';

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  startRecording: (payload: { title: string; mimeType: string }) =>
    ipcRenderer.invoke('start-recording', payload),
  sendRecordingChunk: (data: ArrayBuffer) => ipcRenderer.send('recording-chunk', data),
  stopRecording: (opts?: { liveNotes?: LiveNote[] }) => ipcRenderer.invoke('stop-recording', opts),
  abortRecording: () => ipcRenderer.invoke('abort-recording'),
  onRecordingStatus: (callback: (status: string) => void) => {
    ipcRenderer.on('recording-status', (_, status) => callback(status));
  },
  checkConfig: () => ipcRenderer.invoke('check-config'),
  saveConfig: (config: {
    aiProvider?: 'gemini' | 'codex';
    geminiApiKey?: string;
    codexModel?: string;
    codexTranscriptionModel?: string;
    notionApiKey?: string;
    notionDatabaseId?: string;
    autoMode?: boolean;
    meetingDetection?: boolean;
    displayDetection?: boolean;
    globalShortcut?: string;
    knownWords?: string[];
    summaryPrompt?: string;
    recordSystemAudio?: boolean;
    audioDeviceId?: string;
    slackWebhookUrl?: string;
    slackAutoShare?: boolean;
  }) => ipcRenderer.invoke('save-config', config),
  getConfig: () => ipcRenderer.invoke('get-config'),
  loginCodexOAuth: () => ipcRenderer.invoke('codex-oauth-login'),
  clearCodexOAuth: () => ipcRenderer.invoke('codex-oauth-clear'),
  transcribeAudio: (filePath: string, liveNotes?: LiveNote[]) =>
    ipcRenderer.invoke('transcribe-audio', filePath, liveNotes),
  uploadToNotion: (data: {
    title: string;
    transcriptionData: any;
    audioFilePath?: string;
    transcriptionPath?: string;
  }) => ipcRenderer.invoke('upload-to-notion', data),
  sendToSlack: (data: {
    title: string;
    transcriptionData: any;
    transcriptionPath?: string;
    notionUrl?: string;
    notionError?: string;
  }) => ipcRenderer.invoke('send-to-slack', data),
  testSlackWebhook: (webhookUrl?: string) => ipcRenderer.invoke('test-slack-webhook', webhookUrl),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  openRecordingsFolder: () => ipcRenderer.invoke('open-recordings-folder'),
  showInFinder: (filePath: string) => ipcRenderer.invoke('show-in-finder', filePath),
  getRecordings: () => ipcRenderer.invoke('get-recordings'),
  searchTranscriptions: (opts: { query: string; fields?: string[]; limit?: number }) =>
    ipcRenderer.invoke('search-transcriptions', opts),
  agentChat: (opts: {
    question: string;
    history?: Array<{
      role: 'user' | 'model';
      text: string;
      turns?: unknown[];
      codexItems?: unknown[];
    }>;
    scope: { kind: 'all' } | { kind: 'single'; folderName: string };
  }) => ipcRenderer.invoke('agent-chat', opts),
  onAgentConfirmRequest: (
    callback: (req: {
      id: string;
      proposal: {
        kind: 'setConfig';
        key: string;
        value: unknown;
        currentValue?: unknown;
        description: string;
      };
    }) => void,
  ) => {
    ipcRenderer.on('agent-confirm-request', (_, req) => callback(req));
  },
  sendAgentConfirmResponse: (payload: { id: string; approved: boolean }) =>
    ipcRenderer.invoke('agent-confirm-response', payload),
  cancelAgentPending: () => ipcRenderer.invoke('agent-cancel-pending'),
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

  // Recording export
  exportRecordingM4A: (srcPath: string) => ipcRenderer.invoke('export-recording-m4a', srcPath),

  // Merge multiple recordings into a single re-transcribed note
  mergeRecordings: (opts: { paths: string[]; title?: string }) =>
    ipcRenderer.invoke('merge-recordings', opts),

  // Pushed by main when the recordings directory changes externally
  // (CLI run, manual file ops). Renderer should re-fetch the list.
  onRecordingsChanged: (callback: () => void) => {
    ipcRenderer.on('recordings-changed', () => callback());
  },

  // System settings
  openMicrophoneSettings: () => ipcRenderer.invoke('open-microphone-settings'),
  openScreenRecordingSettings: () => ipcRenderer.invoke('open-screen-recording-settings'),

  // Native macOS system-audio capture (audiotee / Core Audio Tap).
  startSystemAudio: () => ipcRenderer.invoke('system-audio-start'),
  stopSystemAudio: () => ipcRenderer.invoke('system-audio-stop'),
  onSystemAudioChunk: (callback: (chunk: Uint8Array) => void) => {
    ipcRenderer.on('system-audio-chunk', (_event, chunk: Uint8Array) => callback(chunk));
  },
  offSystemAudioChunk: () => ipcRenderer.removeAllListeners('system-audio-chunk'),
  onSystemAudioError: (callback: (err: { message: string }) => void) => {
    ipcRenderer.on('system-audio-error', (_event, err: { message: string }) => callback(err));
  },

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
  saveAudioFile: (fileData: { name: string; data: number[] }) =>
    ipcRenderer.invoke('save-audio-file', fileData),
  saveAudioFileBase64: (fileData: { name: string; dataBase64: string }) =>
    ipcRenderer.invoke('save-audio-file-base64', fileData),
  copyAudioFile: (fileData: { sourcePath: string; name: string }) =>
    ipcRenderer.invoke('copy-audio-file', fileData),
  selectAudioFile: () => ipcRenderer.invoke('select-audio-file'),
  getFileInfo: (filePath: string) => ipcRenderer.invoke('get-file-info', filePath),

  // Metadata handling
  getMetadata: (filePath: string) => ipcRenderer.invoke('get-metadata', filePath),
  saveMetadata: (filePath: string, metadata: any) =>
    ipcRenderer.invoke('save-metadata', filePath, metadata),

  // Auto-update events
  onUpdateStatus: (callback: (updateInfo: { event: string; data?: any }) => void) => {
    ipcRenderer.on('update-status', (_, updateInfo) => callback(updateInfo));
  },
  getUpdateState: () => ipcRenderer.invoke('update:get-state'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  simulateUpdateEvent: (event: string, data?: any) =>
    ipcRenderer.invoke('update:simulate', event, data),

  // Release notes (shown after a version update)
  onShowReleaseNotes: (
    callback: (notes: { version: string; body: string; url: string }) => void,
  ) => {
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
  },
});
