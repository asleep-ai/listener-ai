// Shared mutable state for the renderer. Modules import this object and
// read/write fields directly. ES modules are singletons so all importers
// see the same reference.
//
// Migrated from the top-level `let` variables in the legacy `renderer.js`
// (lines ~34-57, 262, 292-296). Field names are preserved for greppability
// against the original code during review.

export type LiveNote = {
  offsetMs: number;
  text: string;
};

export type RecorderState = {
  isRecording: boolean;
  recordingStartTime: number | null;
  timerInterval: ReturnType<typeof setInterval> | null;
  isAutoModeProcessing: boolean;

  // MediaRecorder + source stream
  mediaStream: MediaStream | null;
  mediaRecorder: MediaRecorder | null;
  recordingMimeType: string;

  // Web Audio graph
  audioContext: AudioContext | null;
  processedStream: MediaStream | null;
  sourceNode: MediaStreamAudioSourceNode | null;
  graphHead: AudioNode | null;

  // Serializes ondataavailable -> IPC writes so chunks land in order.
  // Stop awaits this chain's tail before issuing finalize.
  chunkSendChain: Promise<unknown>;

  // System-audio cleanup (set by createSystemAudioSource).
  systemAudioCleanup: (() => void | Promise<void>) | null;

  // Timestamped notes captured while recording. Cleared on start. Forwarded
  // to main via transcribeAudio so they land in summary.md + Notion.
  liveNotes: LiveNote[];
};

export const state: RecorderState = {
  isRecording: false,
  recordingStartTime: null,
  timerInterval: null,
  isAutoModeProcessing: false,
  mediaStream: null,
  mediaRecorder: null,
  recordingMimeType: '',
  audioContext: null,
  processedStream: null,
  sourceNode: null,
  graphHead: null,
  chunkSendChain: Promise.resolve(),
  systemAudioCleanup: null,
  liveNotes: [],
};

// DOM references resolved once at DOMContentLoaded, used by many UI modules.
// Populated by `initDom()` in `main.ts` before any setup function runs.
export type DomRefs = {
  recordButton: HTMLButtonElement;
  statusIndicator: HTMLElement;
  statusText: HTMLElement;
  recordingTime: HTMLElement;
  meetingTitle: HTMLInputElement;
  recordingsList: HTMLElement;
  autoModeToggle: HTMLInputElement;
  progressContainer: HTMLElement | null;
  progressFill: HTMLElement | null;
  progressText: HTMLElement | null;
  dragDropZone: HTMLElement | null;
};

// Sentinel until initDom runs. Modules should call `getDom()` lazily.
let domRefs: DomRefs | null = null;

export function initDom(refs: DomRefs): void {
  domRefs = refs;
}

export function getDom(): DomRefs {
  if (!domRefs) {
    throw new Error('DOM refs accessed before initDom() ran');
  }
  return domRefs;
}

// Default summary prompt -- moved out of renderer.js global scope so the
// config modal can import it.
export const DEFAULT_SUMMARY_PROMPT = `Based on this meeting transcript, provide:

1. A concise meeting title in Korean (10-20 characters that captures the main topic)
2. A concise summary in Korean (2-3 paragraphs)
3. Key points discussed in Korean (as a bullet list)
4. Action items mentioned in Korean (as a bullet list)
5. An appropriate emoji that represents the meeting

Return as JSON:
{
  "suggestedTitle": "concise title in Korean",
  "summary": "summary in Korean",
  "keyPoints": ["point 1", "point 2"],
  "actionItems": ["action 1", "action 2"],
  "emoji": "📝"
}`;
