// Type surface for `window.electronAPI` exposed by `src/preload.ts` via
// contextBridge. Keep in sync with that file -- the preload TypeScript
// definition is the source of truth, this is a renderer-side mirror.

export type AgentChatMessage = { role: 'user' | 'model'; text: string };
export type AgentScope = { kind: 'all' } | { kind: 'single'; folderName: string };

export type AgentConfirmRequest = {
  id: string;
  proposal: {
    kind: 'setConfig';
    key: string;
    value: unknown;
    currentValue?: unknown;
    description: string;
  };
};

export type ConfigPayload = {
  geminiApiKey?: string;
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
};

export type SlackSendApiResult =
  | { success: true; sentAt: string }
  | { success: false; error: string };

export type SystemAudioStartResult =
  | { success: true; format: { sampleRate: number; channelCount: number; bytesPerSample: number } }
  | {
      success: false;
      reason: 'unsupported-platform' | 'permission-denied' | 'error';
      message?: string;
    };

export type ElectronAPI = {
  platform: NodeJS.Platform;
  startRecording: (payload: { title: string; mimeType: string }) => Promise<{
    success: boolean;
    error?: string;
    filePath?: string;
  }>;
  sendRecordingChunk: (data: ArrayBuffer) => void;
  stopRecording: () => Promise<{
    success: boolean;
    filePath?: string;
    durationMs?: number;
    reason?: string;
    error?: string;
  }>;
  abortRecording: () => Promise<{ success: boolean; error?: string }>;
  onRecordingStatus: (cb: (status: string) => void) => void;
  checkConfig: () => Promise<{
    hasGeminiKey: boolean;
    hasNotionConfig: boolean;
    autoMode: boolean;
  }>;
  saveConfig: (config: ConfigPayload) => Promise<{ success: boolean; error?: string }>;
  getConfig: () => Promise<Record<string, unknown>>;
  transcribeAudio: (filePath: string) => Promise<{
    success: boolean;
    data?: any;
    newFilePath?: string;
    transcriptionPath?: string;
    error?: string;
  }>;
  uploadToNotion: (data: {
    title: string;
    transcriptionData: any;
    audioFilePath?: string;
    transcriptionPath?: string;
  }) => Promise<{ success: boolean; url?: string; error?: string }>;
  sendToSlack: (data: {
    title: string;
    transcriptionData: any;
    transcriptionPath?: string;
    notionUrl?: string;
    notionError?: string;
  }) => Promise<SlackSendApiResult>;
  testSlackWebhook: (webhookUrl?: string) => Promise<SlackSendApiResult>;
  openExternal: (url: string) => Promise<void>;
  openRecordingsFolder: () => Promise<void>;
  showInFinder: (filePath: string) => Promise<void>;
  getRecordings: () => Promise<Array<Record<string, any>>>;
  searchTranscriptions: (opts: { query: string; fields?: string[]; limit?: number }) => Promise<
    Array<Record<string, any>>
  >;
  agentChat: (opts: {
    question: string;
    history?: AgentChatMessage[];
    scope: AgentScope;
  }) => Promise<{ success: true; result: any } | { success: false; error: string }>;
  onAgentConfirmRequest: (cb: (req: AgentConfirmRequest) => void) => void;
  sendAgentConfirmResponse: (payload: { id: string; approved: boolean }) => Promise<void>;
  cancelAgentPending: () => Promise<void>;
  onConfigChanged: (cb: (config: unknown) => void) => void;
  onTranscriptionProgress: (cb: (progress: { percent: number; message: string }) => void) => void;
  checkFFmpeg: () => Promise<{ available: boolean; path?: string }>;
  downloadFFmpeg: () => Promise<{ success: boolean; error?: string }>;
  cancelFFmpegDownload: () => Promise<void>;
  onFFmpegDownloadProgress: (cb: (progress: any) => void) => void;
  exportRecordingM4A: (
    srcPath: string,
  ) => Promise<{ success: boolean; outPath?: string; error?: string }>;
  mergeRecordings: (opts: { paths: string[]; title?: string }) => Promise<{
    success: boolean;
    folderName?: string;
    error?: string;
  }>;
  onRecordingsChanged: (cb: () => void) => void;
  openMicrophoneSettings: () => Promise<void>;
  openScreenRecordingSettings: () => Promise<void>;
  startSystemAudio: () => Promise<SystemAudioStartResult>;
  stopSystemAudio: () => Promise<{ success: boolean }>;
  onSystemAudioChunk: (cb: (chunk: Uint8Array) => void) => void;
  offSystemAudioChunk: () => void;
  onSystemAudioError: (cb: (err: { message: string }) => void) => void;
  validateShortcut: (shortcut: string) => Promise<{ valid: boolean; error?: string }>;
  onTrayStartRecording: (cb: () => void) => void;
  onTrayStopRecording: (cb: () => void) => void;
  onOpenConfig: (cb: () => void) => void;
  onRecordingAutoStopped: (cb: (data: unknown) => void) => void;
  saveAudioFile: (fileData: { name: string; data: number[] }) => Promise<{
    success: boolean;
    filePath?: string;
    error?: string;
  }>;
  saveAudioFileBase64: (fileData: { name: string; dataBase64: string }) => Promise<{
    success: boolean;
    filePath?: string;
    error?: string;
  }>;
  copyAudioFile: (fileData: { sourcePath: string; name: string }) => Promise<{
    success: boolean;
    filePath?: string;
    error?: string;
  }>;
  selectAudioFile: () => Promise<{ success: boolean; filePath?: string; canceled?: boolean }>;
  getFileInfo: (filePath: string) => Promise<{ exists: boolean; size?: number; name?: string }>;
  getMetadata: (filePath: string) => Promise<Record<string, any> | null>;
  saveMetadata: (filePath: string, metadata: any) => Promise<{ success: boolean }>;
  onUpdateStatus: (cb: (updateInfo: { event: string; data?: any }) => void) => void;
  getUpdateState: () => Promise<{ type: string; version?: string; percent?: number }>;
  downloadUpdate: () => Promise<{ success: boolean; error?: string }>;
  installUpdate: () => Promise<void>;
  simulateUpdateEvent: (event: string, data?: any) => Promise<void>;
  onShowReleaseNotes: (cb: (notes: { version: string; body: string; url: string }) => void) => void;
  onOpenReleaseHistory: (cb: () => void) => void;
  getAllReleases: () => Promise<
    Array<{
      name?: string;
      tag?: string;
      body?: string;
      publishedAt?: string;
      prerelease?: boolean;
      url?: string;
    }>
  >;
  getMeetingStatus: () => Promise<{ active: boolean; app?: string }>;
  onMeetingStatusChanged: (cb: (status: { active: boolean; app?: string }) => void) => void;
};

declare global {
  interface Window {
    electronAPI: ElectronAPI;
    fileHandler?: import('./services/file-handler').FileHandler;
  }
}
