// Type surface for `window.electronAPI` exposed by `src/preload.ts` via
// contextBridge. Derived from the object the preload actually exposes, so the
// compiler keeps the two in step; the payload shapes live in
// `src/electronApiTypes.ts` and are re-exported here for renderer imports.

import type { ElectronAPI } from '../src/preload';

export type { ElectronAPI };
export type {
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
  TranscriptionErrorPayload,
} from '../src/electronApiTypes';

declare global {
  interface Window {
    electronAPI: ElectronAPI;
    fileHandler?: import('./services/file-handler').FileHandler;
  }
}
