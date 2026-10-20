import { contextBridge, ipcRenderer, webFrame } from 'electron';
import type { AiProvider, BatchSttProvider } from './aiProvider';
import type { ChatGPTModel, ChatGPTProfile, ChatGPTSignOutResult } from './chatgptAuth';
import type { ChatGPTStatusPayload } from './configService';
import type {
  AgentChatMessage,
  AgentConfirmRequest,
  AgentScope,
  ConfigPayload,
  GoogleSyncProgress,
  GoogleSyncResult,
  GoogleSyncStatus,
  LiveSessionEvent,
  LiveSessionSnapshot,
  LiveSessionStartResult,
  LiveTranscriptSegment,
  RendererLogPayload,
  SlackSendApiResult,
  SystemAudioStartResult,
  TranscriptCutoffApiResult,
  TranscriptionErrorPayload,
  TranscriptionJobExports,
  TranscriptionJobSnapshot,
  TranscriptionJobsList,
} from './electronApiTypes';
import type { LiveNote } from './outputService';
import type { FileInfoResult } from './services/fileInfoTypes';
import type { SyncProgressEvent } from './services/syncEngine';

// Only the main process's explicit background-test opt-in passes this argument.
// Install before renderer code so native JavaScript dialogs cannot steal focus.
if (process.argv.includes('--listener-background-test')) {
  void webFrame
    .executeJavaScript(`(() => {
    const state = { events: [], confirmResult: false, promptResult: null };
    Object.defineProperty(window, '__listenerBackgroundTestDialogs', { value: state });
    window.alert = (message) => {
      state.events.push({ type: 'alert', message: String(message) });
    };
    window.confirm = (message) => {
      state.events.push({ type: 'confirm', message: String(message) });
      return state.confirmResult;
    };
    window.prompt = (message) => {
      state.events.push({ type: 'prompt', message: String(message) });
      return state.promptResult;
    };
  })()`)
    .catch((error) => {
      console.error('Failed to install background-test dialog observer:', error);
    });
}

// `ipcRenderer.invoke` resolves to `any`, which would collapse every member
// below to `Promise<any>` in the derived `ElectronAPI`. Routing through this
// wrapper forces each member to state what its main-process handler resolves
// to, so the renderer keeps real return types.
const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args);

const api = {
  platform: process.platform,
  logRenderer: (payload: RendererLogPayload) => ipcRenderer.send('renderer-log', payload),
  startRecording: (payload: {
    title: string;
    mimeType: string;
  }): Promise<{ success: boolean; error?: string; filePath?: string }> =>
    invoke('start-recording', payload),
  sendRecordingChunk: (data: ArrayBuffer) => ipcRenderer.send('recording-chunk', data),
  stopRecording: (opts?: {
    liveNotes?: LiveNote[];
  }): Promise<{
    success: boolean;
    filePath?: string;
    durationMs?: number;
    reason?: string;
    error?: string;
  }> => invoke('stop-recording', opts),
  abortRecording: (): Promise<{ success: boolean; error?: string }> => invoke('abort-recording'),
  onRecordingStatus: (callback: (status: string) => void) => {
    ipcRenderer.on('recording-status', (_, status) => callback(status));
  },
  checkConfig: (): Promise<{
    hasConfig: boolean;
    hasAiAuth: boolean;
    hasTranscriptionAuth: boolean;
    aiProvider: AiProvider;
    /** Null when the selection cannot run (see transcriptionProviderIssue). */
    transcriptionProvider: BatchSttProvider | null;
    transcriptionProviderIssue?: string;
    chatgptStatus: ChatGPTStatusPayload;
    missing: string[];
  }> => invoke('check-config'),
  saveConfig: (config: ConfigPayload): Promise<{ success: boolean; error?: string }> =>
    invoke('save-config', config),
  getConfig: (): Promise<Record<string, unknown>> => invoke('get-config'),
  // Sign in with ChatGPT (official SIWC). Errors carry the auth store's
  // `code` when it has one (e.g. 'access_denied', 'plan_disabled').
  loginChatGPT: (opts?: {
    newProfile?: boolean;
    /** Alias of `newProfile`. */
    addProfile?: boolean;
    profileId?: string;
    /** Only for the explicit "Enable ChatGPT plan" action. */
    requestPlanConsent?: boolean;
  }): Promise<
    | { success: true; status: ChatGPTStatusPayload; config: Record<string, unknown> }
    | { success: false; error: string; code?: string; cancelled?: boolean }
  > => invoke('chatgpt-oauth-login', opts),
  cancelChatGPTLogin: (): Promise<{ success: boolean }> => invoke('chatgpt-oauth-cancel'),
  logoutChatGPT: (
    profileId?: string,
  ): Promise<
    | ({
        success: true;
        status: ChatGPTStatusPayload;
        config: Record<string, unknown>;
      } & ChatGPTSignOutResult)
    | { success: false; error: string; code?: string }
  > => invoke('chatgpt-oauth-clear', profileId),
  getChatGPTStatus: (): Promise<
    ChatGPTStatusPayload & {
      success: true;
      status: ChatGPTStatusPayload;
      legacyCodexConfigured: boolean;
    }
  > => invoke('chatgpt-oauth-status'),
  listChatGPTModels: (
    profileId?: string,
  ): Promise<
    { success: true; models: ChatGPTModel[] } | { success: false; error: string; code?: string }
  > => invoke('chatgpt-list-models', profileId),
  listChatGPTProfiles: (): Promise<
    { success: true; profiles: ChatGPTProfile[] } | { success: false; error: string; code?: string }
  > => invoke('chatgpt-list-profiles'),
  selectChatGPTProfile: (
    profileId: string,
  ): Promise<
    | { success: true; status: ChatGPTStatusPayload; config: Record<string, unknown> }
    | { success: false; error: string; code?: string }
  > => invoke('chatgpt-select-profile', profileId),
  openChatGPTUsage: (): Promise<{ success: true }> => invoke('chatgpt-manage-usage'),
  onChatGPTProgress: (
    callback: (status: { phase: 'browser-opened' | 'progress'; message?: string }) => void,
  ) => {
    ipcRenderer.on('chatgpt-oauth-progress', (_, status) => callback(status));
  },
  loginGoogleOAuth: (): Promise<
    | { success: true; config: Record<string, unknown> }
    | { success: false; error: string; cancelled?: boolean }
  > => invoke('google-oauth-login'),
  cancelGoogleOAuth: (): Promise<{ success: boolean }> => invoke('google-oauth-cancel'),
  clearGoogleOAuth: (): Promise<
    { success: true; config: Record<string, unknown> } | { success: false; error: string }
  > => invoke('google-oauth-clear'),
  onGoogleOAuthProgress: (
    callback: (status: { phase: 'browser-opened' | 'progress'; message?: string }) => void,
  ) => {
    ipcRenderer.on('google-oauth-progress', (_, status) => callback(status));
  },
  syncGoogleDriveNow: (): Promise<
    | { success: true; result: GoogleSyncResult; lastSyncedAt: string | null }
    | { success: false; error: string }
  > => invoke('google-drive-sync-now'),
  getGoogleSyncStatus: (): Promise<{
    inFlight: boolean;
    lastSyncedAt: string | null;
    lastResult: GoogleSyncResult | null;
    progress: GoogleSyncProgress | null;
    enabled: boolean;
    authenticated: boolean;
  }> => invoke('google-drive-sync-status'),
  onGoogleSyncStatus: (callback: (status: GoogleSyncStatus) => void) => {
    ipcRenderer.on('google-sync-status', (_, status) => callback(status));
  },
  onGoogleSyncProgress: (callback: (event: SyncProgressEvent) => void) => {
    ipcRenderer.on('google-sync-progress', (_, event) => callback(event));
  },
  // A request for a recording that is already transcribing joins that job
  // (`joined: true`) instead of starting another. `autoExport` makes main run
  // the configured Notion/Slack follow-ups as part of the job.
  transcribeAudio: (
    filePath: string,
    liveNotes?: LiveNote[],
    options?: { autoExport?: boolean; recordingTitle?: string },
  ): Promise<{
    success: boolean;
    data?: any;
    newFilePath?: string;
    transcriptionPath?: string;
    folderName?: string;
    generationId?: string | null;
    error?: string;
    errorDetails?: TranscriptionErrorPayload;
    cancelled?: boolean;
    jobId?: string;
    joined?: true;
    exports?: TranscriptionJobExports;
  }> => invoke('transcribe-audio', filePath, liveNotes, options),
  // `committed`: the note is already saved, so the job finishes normally.
  cancelTranscription: (
    filePath: string,
  ): Promise<{ success: boolean; reason?: 'not-running' | 'committed' }> =>
    invoke('cancel-transcription', filePath),
  getTranscriptionJobs: (): Promise<TranscriptionJobsList> => invoke('get-transcription-jobs'),
  onTranscriptionJobChanged: (callback: (job: TranscriptionJobSnapshot) => void) => {
    ipcRenderer.on('transcription-job-changed', (_, job) => callback(job));
  },
  uploadToNotion: (data: {
    title: string;
    transcriptionData: any;
    audioFilePath?: string;
    transcriptionPath?: string;
    expectedGenerationId?: string | null;
  }): Promise<{ success: boolean; url?: string; error?: string }> =>
    invoke('upload-to-notion', data),
  sendToSlack: (data: {
    title: string;
    transcriptionData: any;
    transcriptionPath?: string;
    expectedGenerationId?: string | null;
    notionUrl?: string;
    notionError?: string;
  }): Promise<SlackSendApiResult> => invoke('send-to-slack', data),
  // Set (offset) or remove (null) a saved note's transcript tail cutoff and
  // regenerate its report from the included text. Never re-transcribes.
  applyTranscriptCutoff: (data: {
    transcriptionPath: string;
    expectedGenerationId: string | null;
    cutoffOffset: number | null;
  }): Promise<TranscriptCutoffApiResult> => invoke('apply-transcript-cutoff', data),
  testSlackWebhook: (webhookUrl?: string): Promise<SlackSendApiResult> =>
    invoke('test-slack-webhook', webhookUrl),
  openExternal: (url: string): Promise<void> => invoke('open-external', url),
  openRecordingsFolder: (): Promise<void> => invoke('open-recordings-folder'),
  showInFinder: (filePath: string): Promise<void> => invoke('show-in-finder', filePath),
  getRecordings: (): Promise<Array<Record<string, any>>> => invoke('get-recordings'),
  searchTranscriptions: (opts: {
    query: string;
    fields?: string[];
    limit?: number;
  }): Promise<Array<Record<string, any>>> => invoke('search-transcriptions', opts),
  startLiveSession: (opts: {
    title?: string;
    translate?: boolean;
  }): Promise<
    { success: true; session: LiveSessionStartResult } | { success: false; error: string }
  > => invoke('live-session-start', opts),
  handleLiveRealtimeFailure: (opts: {
    sessionId: string;
    error?: string;
  }): Promise<
    { success: true; session: LiveSessionStartResult } | { success: false; error: string }
  > => invoke('live-session-realtime-failed', opts),
  processLiveAudioChunk: (opts: {
    sessionId: string;
    audioData: ArrayBuffer;
    mimeType: string;
    offsetMs: number;
    durationMs: number;
    translate?: boolean;
  }): Promise<
    | { success: true; segment: LiveTranscriptSegment | null; snapshot: LiveSessionSnapshot | null }
    | { success: false; error: string }
  > => invoke('live-session-process-chunk', opts),
  sendLivePcmChunk: (opts: {
    sessionId: string;
    audioData: ArrayBuffer;
    sampleRate: number;
    channelCount: number;
    offsetMs: number;
    durationMs: number;
    sequence: number;
  }) => ipcRenderer.send('live-session-pcm-chunk', opts),
  updateLiveSessionInterim: (opts: {
    sessionId: string;
    text: string;
    translation?: boolean;
    offsetMs?: number;
  }) => ipcRenderer.send('live-session-interim', opts),
  completeLiveSessionSegment: (opts: {
    sessionId: string;
    text: string;
    offsetMs?: number;
    durationMs?: number;
    translation?: string;
  }): Promise<{ success: boolean; error?: string }> => invoke('live-session-final', opts),
  stopLiveSession: (
    sessionId: string,
  ): Promise<
    { success: true; snapshot: LiveSessionSnapshot | null } | { success: false; error: string }
  > => invoke('live-session-stop', sessionId),
  getLiveSessionSnapshot: (): Promise<{
    success: true;
    snapshot: LiveSessionSnapshot | null;
  }> => invoke('live-session-snapshot'),
  setLiveSessionTranslate: (opts: {
    sessionId: string;
    translate: boolean;
  }): Promise<
    { success: true; snapshot: LiveSessionSnapshot | null } | { success: false; error: string }
  > => invoke('live-session-set-translate', opts),
  askLiveSession: (opts: {
    sessionId: string;
    question: string;
    history?: AgentChatMessage[];
  }): Promise<{ success: true; result: any } | { success: false; error: string }> =>
    invoke('live-session-ask', opts),
  onLiveSessionEvent: (callback: (event: LiveSessionEvent) => void) => {
    ipcRenderer.on('live-session-event', (_event, payload) => callback(payload));
  },
  agentChat: (opts: {
    question: string;
    history?: AgentChatMessage[];
    scope: AgentScope;
  }): Promise<
    | { success: true; result: any }
    | {
        success: false;
        error: string;
        /** Set for ChatGPT plan failures; `errorCode` is the ChatGPT code. */
        errorType?: 'chatgpt';
        errorCode?: string;
        manageUsageUrl?: string;
      }
  > => invoke('agent-chat', opts),
  onAgentConfirmRequest: (callback: (req: AgentConfirmRequest) => void) => {
    ipcRenderer.on('agent-confirm-request', (_, req) => callback(req));
  },
  sendAgentConfirmResponse: (payload: { id: string; approved: boolean }): Promise<void> =>
    invoke('agent-confirm-response', payload),
  cancelAgentPending: (): Promise<void> => invoke('agent-cancel-pending'),
  onConfigChanged: (callback: (config: unknown) => void) => {
    ipcRenderer.on('config-changed', (_, config) => callback(config));
  },
  onTranscriptionProgress: (
    callback: (progress: {
      percent: number;
      message: string;
      filePath?: string;
      jobId?: string;
    }) => void,
  ) => {
    ipcRenderer.on('transcription-progress', (_, progress) => callback(progress));
  },
  // FFmpeg management
  checkFFmpeg: (): Promise<{ available: boolean; path?: string }> => invoke('check-ffmpeg'),
  downloadFFmpeg: (): Promise<{ success: boolean; error?: string }> => invoke('download-ffmpeg'),
  cancelFFmpegDownload: (): Promise<void> => invoke('cancel-ffmpeg-download'),
  onFFmpegDownloadProgress: (callback: (progress: any) => void) => {
    ipcRenderer.on('ffmpeg-download-progress', (_, progress) => callback(progress));
  },

  // Recording export
  exportRecordingM4A: (
    srcPath: string,
  ): Promise<{ success: boolean; outPath?: string; error?: string }> =>
    invoke('export-recording-m4a', srcPath),

  // Permanent removal: audio file + metadata + transcription folder.
  // Triggers a Drive sync if enabled so deletion propagates to other devices.
  deleteMeeting: (
    audioFilePath: string,
  ): Promise<{ success: true } | { success: false; error: string }> =>
    invoke('delete-meeting', audioFilePath),

  // Merge multiple recordings into a single re-transcribed note
  mergeRecordings: (opts: {
    paths: string[];
    title?: string;
  }): Promise<{
    success: boolean;
    folderName?: string;
    generationId?: string | null;
    error?: string;
    jobId?: string;
  }> => invoke('merge-recordings', opts),

  // Pushed by main when the recordings directory changes externally
  // (CLI run, manual file ops). Renderer should re-fetch the list.
  onRecordingsChanged: (callback: () => void) => {
    ipcRenderer.on('recordings-changed', () => callback());
  },

  // System settings
  openMicrophoneSettings: (): Promise<void> => invoke('open-microphone-settings'),
  openScreenRecordingSettings: (): Promise<void> => invoke('open-screen-recording-settings'),

  // Native macOS system-audio capture (audiotee / Core Audio Tap).
  startSystemAudio: (): Promise<SystemAudioStartResult> => invoke('system-audio-start'),
  stopSystemAudio: (): Promise<{ success: boolean }> => invoke('system-audio-stop'),
  onSystemAudioChunk: (callback: (chunk: Uint8Array) => void) => {
    ipcRenderer.on('system-audio-chunk', (_event, chunk: Uint8Array) => callback(chunk));
  },
  offSystemAudioChunk: () => {
    ipcRenderer.removeAllListeners('system-audio-chunk');
  },
  onSystemAudioError: (callback: (err: { message: string }) => void) => {
    ipcRenderer.on('system-audio-error', (_event, err: { message: string }) => callback(err));
  },

  // Global shortcut
  validateShortcut: (shortcut: string): Promise<{ valid: boolean; error?: string }> =>
    invoke('validate-shortcut', shortcut),

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
  saveAudioFile: (fileData: {
    name: string;
    data: number[];
  }): Promise<{ success: boolean; filePath?: string; error?: string }> =>
    invoke('save-audio-file', fileData),
  saveAudioFileBase64: (fileData: {
    name: string;
    dataBase64: string;
  }): Promise<{ success: boolean; filePath?: string; error?: string }> =>
    invoke('save-audio-file-base64', fileData),
  copyAudioFile: (fileData: {
    sourcePath: string;
    name: string;
  }): Promise<{ success: boolean; filePath?: string; error?: string }> =>
    invoke('copy-audio-file', fileData),
  selectAudioFile: (): Promise<{ success: boolean; filePath?: string; canceled?: boolean }> =>
    invoke('select-audio-file'),
  getFileInfo: (filePath: string): Promise<FileInfoResult> => invoke('get-file-info', filePath),

  // Metadata handling
  getMetadata: (filePath: string): Promise<Record<string, any> | null> =>
    invoke('get-metadata', filePath),
  saveMetadata: (filePath: string, metadata: any): Promise<{ success: boolean }> =>
    invoke('save-metadata', filePath, metadata),

  // Usage / cost tracking
  getUsageSummary: (opts?: {
    month?: string;
  }): Promise<
    | {
        success: true;
        month: string;
        summary: {
          totalUsd: number;
          count: number;
          modelUnknownCount: number;
          byModel: Array<{
            modelId: string;
            kind: 'summary' | 'transcription' | 'agent';
            /** `chatgpt-plan`: subscription usage, `usd` is not an API price. */
            billing?: 'chatgpt-plan';
            usd: number;
            count: number;
            tokens: {
              input?: number;
              output?: number;
              cacheRead?: number;
              cacheWrite?: number;
              audioSeconds?: number;
            };
          }>;
        };
      }
    | { success: false; error: string }
  > => invoke('get-usage-summary', opts),

  // Auto-update events
  onUpdateStatus: (callback: (updateInfo: { event: string; data?: any }) => void) => {
    ipcRenderer.on('update-status', (_, updateInfo) => callback(updateInfo));
  },
  getUpdateState: (): Promise<{ type: string; version?: string; percent?: number }> =>
    invoke('update:get-state'),
  downloadUpdate: (): Promise<{ success: boolean; error?: string }> => invoke('update:download'),
  installUpdate: (): Promise<void> => invoke('update:install'),
  simulateUpdateEvent: (event: string, data?: any): Promise<void> =>
    invoke('update:simulate', event, data),

  // Release notes (shown after a version update)
  onShowReleaseNotes: (
    callback: (notes: { version: string; body: string; url: string }) => void,
  ) => {
    ipcRenderer.on('show-release-notes', (_, notes) => callback(notes));
  },
  onOpenReleaseHistory: (callback: () => void) => {
    ipcRenderer.on('open-release-history', () => callback());
  },
  getAllReleases: (): Promise<
    Array<{
      name?: string;
      tag?: string;
      body?: string;
      publishedAt?: string;
      prerelease?: boolean;
      url?: string;
    }>
  > => invoke('get-all-releases'),

  // Meeting detection
  getMeetingStatus: (): Promise<{ active: boolean; app?: string }> => invoke('get-meeting-status'),
  onMeetingStatusChanged: (callback: (status: { active: boolean; app?: string }) => void) => {
    ipcRenderer.on('meeting-status-changed', (_, status) => callback(status));
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);

// The renderer's `window.electronAPI` type is derived from this object
// (`renderer/electronAPI.d.ts`), so the bridge shape has one definition.
export type ElectronAPI = typeof api;
