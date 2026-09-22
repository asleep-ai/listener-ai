// Named payload shapes for the `window.electronAPI` bridge. They live outside
// `preload.ts` so both the preload annotations and the renderer (which
// re-exports them from `renderer/electronAPI.d.ts`) reference one declaration
// instead of two hand-synced copies. Types only -- nothing here emits runtime
// code, so importing it never pulls Electron into the renderer bundle.

import type {
  AiProvider,
  GeminiThinkingLevel,
  LiveSttProvider,
  TranscriptionProvider,
} from './aiProvider';
import type { StreamingLiveSttProvider } from './liveSttProvider';

export interface TranscriptionErrorPayload {
  userMessage: string;
  rawMessage: string;
  status?: number;
  statusText?: string;
  requestId?: string;
  errorType?: string;
  errorCode?: string;
  rawBody?: string;
}

export type AgentChatMessage = {
  role: 'user' | 'model';
  text: string;
  // Opaque pi-ai message cluster (assistant turn + tool results). Round-trips
  // through IPC unchanged so the next agent run can replay tool-use history.
  piaiMessages?: unknown[];
};
export type AgentScope =
  | { kind: 'all' }
  | { kind: 'single'; folderName: string }
  | {
      kind: 'live';
      title: string;
      transcript: string;
      interimTranscript?: string;
      interimTranslation?: string;
      translation?: string;
    };

export type LiveTranscriptSegment = {
  id: string;
  offsetMs: number;
  durationMs: number;
  transcript: string;
  translation?: string;
  translationError?: string;
  final: boolean;
  createdAt: string;
};

export type LiveSessionStartResult = {
  sessionId: string;
  title: string;
  startedAt: string;
  translate: boolean;
  mode: 'streaming' | 'chunked';
  provider: StreamingLiveSttProvider | 'chunked';
  realtimeClient?: {
    transport: 'webrtc';
    endpoint: 'realtime' | 'translation';
    clientSecret: string;
  };
};

export type LiveSessionSnapshot = {
  sessionId: string;
  title: string;
  startedAt: string;
  active: boolean;
  translate: boolean;
  mode: 'streaming' | 'chunked';
  provider: StreamingLiveSttProvider | 'chunked';
  segments: LiveTranscriptSegment[];
  interimTranscript: string;
  interimTranslation: string;
  transcript: string;
  translation: string;
};

export type LiveSessionEvent =
  | {
      type: 'status';
      sessionId: string;
      status: string;
      mode?: 'streaming' | 'chunked';
      provider?: StreamingLiveSttProvider | 'chunked';
    }
  | { type: 'interim'; sessionId: string; text: string; offsetMs?: number }
  | { type: 'translationInterim'; sessionId: string; text: string; offsetMs?: number }
  | { type: 'segment'; sessionId: string; segment: LiveTranscriptSegment }
  | { type: 'error'; sessionId: string; error: string };

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
  aiProvider?: AiProvider;
  transcriptionProvider?: TranscriptionProvider;
  geminiApiKey?: string;
  geminiModel?: string;
  geminiFlashModel?: string;
  geminiThinkingLevel?: GeminiThinkingLevel;
  codexModel?: string;
  codexTranscriptionModel?: string;
  liveSttProvider?: LiveSttProvider;
  openaiApiKey?: string;
  sonioxApiKey?: string;
  openaiLiveTranscriptionModel?: string;
  openaiLiveTranslationModel?: string;
  liveSttLanguage?: string;
  liveTranslationLanguage?: string;
  notionApiKey?: string;
  notionDatabaseId?: string;
  autoMode?: boolean;
  meetingDetection?: boolean;
  displayDetection?: boolean;
  globalShortcut?: string;
  knownWords?: string[];
  summaryPrompt?: string;
  defaultSummaryPrompt?: string;
  maxRecordingMinutes?: number;
  recordingReminderMinutes?: number;
  minRecordingSeconds?: number;
  recordSystemAudio?: boolean;
  crashReportingEnabled?: boolean;
  audioDeviceId?: string;
  slackWebhookUrl?: string;
  slackAutoShare?: boolean;
  googleDriveEnabled?: boolean;
};

export type RendererLogPayload = {
  level: 'debug' | 'log' | 'info' | 'warn' | 'error';
  timestamp: string;
  url: string;
  args: unknown[];
};

export type GoogleSyncResult = {
  uploaded: string[];
  downloaded: string[];
  skipped: string[];
  conflicts: string[];
  deleted: string[];
  tombstoned: string[];
  errors: Array<{ meeting: string; file?: string; error: string }>;
};

export type GoogleSyncStatus = {
  phase: 'idle' | 'syncing' | 'success' | 'error';
  lastSyncedAt: string | null;
  result?: GoogleSyncResult;
  error?: string;
};

export type GoogleSyncProgress =
  | { type: 'scanning' }
  | { type: 'meeting'; meeting: string; index: number; total: number };

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
