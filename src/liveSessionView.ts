// Main-screen indicator for the live caption session. Pure and DOM-free so the
// renderer has one source for the launcher button and its status line, and the
// mapping is unit-testable.
//
// The live dialog can be minimized while captions keep running, so the main
// screen is the only place the user sees whether captions are connecting,
// listening, failing, finishing, or have ended with text still available.

export type LiveIndicatorPhase = 'idle' | 'connecting' | 'active' | 'finalizing' | 'ended';

/**
 * Why the last session ended. `renderer-lost` means main closed the provider
 * because the window that captured audio reloaded or crashed; `failed` means
 * the session could not start or its fallback failed.
 */
export type LiveIndicatorEndReason = 'user' | 'renderer-lost' | 'failed';

export interface LiveIndicatorState {
  /** A recording is running, so a new live session can be started. */
  recording: boolean;
  phase: LiveIndicatorPhase;
  /** Only read when `phase` is `ended`. */
  endedReason?: LiveIndicatorEndReason | null;
  /** Last provider error since the last good status/caption. */
  error?: string | null;
  /** Final captions currently held by the dialog. */
  captionCount: number;
}

export type LiveIndicatorTone =
  | 'none'
  | 'connecting'
  | 'listening'
  | 'error'
  | 'finalizing'
  | 'ended';

export interface LiveIndicatorView {
  visible: boolean;
  /** Accessible name of the launcher. Changes only between start and open. */
  buttonLabel: string;
  /** True when the launcher opens the existing dialog instead of starting. */
  opensDialog: boolean;
  /** Short phase line, rendered in a polite live region. Empty = nothing to say. */
  statusText: string;
  /** Caption count, rendered outside the live region so it is not announced. */
  detailText: string;
  tone: LiveIndicatorTone;
  /** The dialog shows retained text that can no longer receive captions. */
  readOnly: boolean;
}

function captionDetail(count: number, kept: boolean): string {
  if (count <= 0) return '';
  const noun = count === 1 ? 'caption' : 'captions';
  return kept ? `${count} ${noun} kept` : `${count} ${noun}`;
}

export function describeLiveIndicator(state: LiveIndicatorState): LiveIndicatorView {
  const count = Math.max(0, Math.floor(state.captionCount || 0));
  const error = state.error?.trim() || '';
  const recordingNote = state.recording ? ' Recording continues.' : '';

  if (state.phase === 'connecting') {
    return {
      visible: true,
      buttonLabel: 'Open live captions',
      opensDialog: true,
      statusText: 'Connecting live captions...',
      detailText: '',
      tone: 'connecting',
      readOnly: false,
    };
  }
  if (state.phase === 'finalizing') {
    return {
      visible: true,
      buttonLabel: 'Open live captions',
      opensDialog: true,
      statusText: 'Finishing live captions...',
      detailText: captionDetail(count, false),
      tone: 'finalizing',
      readOnly: false,
    };
  }
  if (state.phase === 'active') {
    return {
      visible: true,
      buttonLabel: 'Open live captions',
      opensDialog: true,
      statusText: error ? `Live captions problem: ${error}.${recordingNote}` : 'Live captions on',
      detailText: captionDetail(count, false),
      tone: error ? 'error' : 'listening',
      readOnly: false,
    };
  }
  if (state.phase === 'ended') {
    if (state.endedReason === 'renderer-lost' && count > 0) {
      return {
        visible: true,
        buttonLabel: 'Open live captions',
        opensDialog: true,
        statusText: 'Live captions ended when the window reloaded',
        detailText: captionDetail(count, true),
        tone: 'ended',
        readOnly: true,
      };
    }
    if (state.endedReason === 'failed') {
      // Retained text stays reachable; otherwise the launcher retries.
      return {
        visible: state.recording || count > 0,
        buttonLabel: count > 0 ? 'Open live captions' : 'Live captions',
        opensDialog: count > 0,
        statusText: `Live captions stopped${error ? `: ${error}` : ''}.${recordingNote}`,
        detailText: captionDetail(count, true),
        tone: 'error',
        readOnly: true,
      };
    }
    if (state.endedReason === 'user') {
      // Say captions stopped even when none arrived; with no text to show,
      // the launcher starts a new session instead of opening an empty dialog.
      return {
        visible: state.recording,
        buttonLabel: count > 0 ? 'Open live captions' : 'Live captions',
        opensDialog: count > 0,
        statusText: 'Live captions stopped',
        detailText: captionDetail(count, true),
        tone: 'ended',
        readOnly: count > 0,
      };
    }
  }
  return {
    visible: state.recording,
    buttonLabel: 'Live captions',
    opensDialog: false,
    statusText: '',
    detailText: '',
    tone: 'none',
    readOnly: false,
  };
}
