// Batch (whole-file / per-segment) speech-to-text backend seam.
//
// `GeminiService` used to branch on `this.provider` at eight points in the
// audio path -- pre-conversion, segmentation thresholds, segment re-encode,
// the two transcription call sites, and the two retry-ladder width sites.
// Adding a third engine meant widening `AiProvider`, which also governs the
// summary/judge/agent paths that must stay on the user's chat provider.
//
// A backend answers three kinds of question instead:
//   - what audio can it take (`acceptedExtensions`, `maxBytes`,
//     `maxSegmentSeconds`, `requiresReencodedSegments`);
//   - which request knobs does it honor (`supportsPrompt`,
//     `supportsTemperature`), which is what the quality-retry ladder needs to
//     size itself;
//   - how does it transcribe one file and bill for it (`transcribe`,
//     `recordUsage`).
//
// Everything in this module is pure or provider-agnostic; the concrete
// backends are built by `GeminiService` because they need its lazily
// resolved credentials and its replaceable transcription methods.

import type { CostSession } from './services/usageTracker';

export const BATCH_STT_BACKEND_IDS = ['gemini', 'codex', 'soniox'] as const;

export type BatchSttBackendId = (typeof BATCH_STT_BACKEND_IDS)[number];

// Default per-segment length. Segmentation is deliberate even when the
// provider would accept the whole file: N parallel 5-minute requests finish
// much faster than one sequential pass. A backend whose speaker ids are only
// consistent within a single request raises this instead.
export const DEFAULT_MAX_SEGMENT_SECONDS = 300;

// Target size for a size-shrunk segment, kept below `maxBytes` so a segment
// that encodes slightly larger than predicted still fits. Clamped to
// `maxBytes` for a backend with a tighter cap than the Codex 24 MB rule.
const SEGMENT_SIZE_TARGET_BYTES = 20 * 1024 * 1024;

// Shortest segment the size shrink may produce. Below this the per-request
// overhead and the 15s boundary overlap dominate the audio.
const MIN_SHRUNK_SEGMENT_SECONDS = 30;

// Whisper's fallback ladder compressed to two points -- the low rung keeps
// recovered speech accurate when it is enough to break the loop, while the
// high rung maximizes escape probability. Bounded at two extra calls per
// flagged transcript.
export const QUALITY_RETRY_TEMPERATURES = [0.4, 0.8] as const;

export interface BatchSttTranscribeParams {
  audioFilePath: string;
  /** Transcription instructions. Ignored when `supportsPrompt` is false. */
  prompt?: string;
  /** Ignored when `supportsTemperature` is false. */
  temperature?: number;
  /**
   * User glossary (`knownWords`) for backends that take vocabulary out of
   * band. Backends that accept a prompt already have the glossary inside it
   * and ignore this. Absent on the context-cleared quality-retry rungs, which
   * deliberately drop the glossary.
   */
  glossary?: string[];
  /** Audio length in seconds when known; 0/undefined when ffprobe failed. */
  audioSeconds?: number;
  /** Opaque value from `prepareWholeFile`, absent on the segment path. */
  fileHandle?: unknown;
  /**
   * Progress sink for a backend whose `transcribe` call is itself the
   * long-running step -- Soniox uploads, creates and polls an async job
   * inside one call, with no `prepareWholeFile` to narrate it. Passed only on
   * the first whole-file attempt; the segment loop and the quality-retry
   * rungs report their own progress and leave this undefined so the bar never
   * jumps backwards.
   */
  onProgress?: (percent: number, message: string) => void;
  /**
   * True when this call is the non-segmented whole-file path. Only a backend
   * that retries its own transport needs it: `transcribeSingleSegment`
   * already wraps the segment path in a bounded retry loop, while
   * `getShortAudioTranscript` has none, so a self-retrying backend would
   * otherwise multiply the two.
   */
  wholeFile?: boolean;
  /**
   * False when the caller does not want the backend to retry its own
   * transport. The live-snippet path sets it: a 12s snippet is re-cut every
   * ~12s, so a provider outage would otherwise multiply into three full jobs
   * per snippet against a caller that treats one failure as normal. Defaults
   * to true, and only matters together with `wholeFile`.
   */
  retryTransport?: boolean;
  session?: CostSession;
  signal?: AbortSignal;
}

export interface BatchSttPrepareParams {
  audioFilePath: string;
  fileSizeMb: number;
  session?: CostSession;
  signal?: AbortSignal;
  onProgress?: (percent: number, message: string) => void;
}

export interface BatchSttBackend {
  readonly id: BatchSttBackendId;
  /** Resolved model id, for logs and usage rows. */
  readonly modelId: string;
  /**
   * Extensions the provider accepts directly. `null` means "anything ffmpeg
   * can read" -- no pre-conversion step. Anything else triggers a remux to
   * `.webm` before upload.
   */
  readonly acceptedExtensions: ReadonlySet<string> | null;
  readonly supportsPrompt: boolean;
  readonly supportsTemperature: boolean;
  /** Per-request size cap in bytes. Files above it are segmented. */
  readonly maxBytes?: number;
  /** Longest segment this backend should receive, in seconds. */
  readonly maxSegmentSeconds: number;
  /**
   * Whether the legacy unknown-duration segment muxer must re-encode rather
   * than stream-copy. The overlapped plan path always re-encodes regardless.
   */
  readonly requiresReencodedSegments: boolean;
  /**
   * Optional one-time preparation for the non-segmented whole-file path:
   * a provider-side upload plus the progress narrative that goes with it.
   * The returned opaque handle comes back as `fileHandle` on every
   * `transcribe` call for that file, so the quality-retry ladder reuses one
   * upload instead of re-uploading per rung. Segments never call this.
   */
  prepareWholeFile?(params: BatchSttPrepareParams): Promise<unknown>;
  transcribe(params: BatchSttTranscribeParams): Promise<string>;
  /**
   * Record one usage row for a completed `transcribe` call. Called by the
   * backend's own `transcribe`, because only the backend knows whether its
   * provider bills per audio second (`audioSeconds`) or per token (`extra`
   * carries the provider's usage metadata).
   */
  recordUsage(session: CostSession | undefined, audioSeconds: number, extra?: unknown): void;
}

/**
 * Decide whether a recording is split and how long each segment is.
 *
 * Two independent triggers: a duration above what the backend should receive
 * in one request, and a file above its per-request byte cap. A size-capped
 * backend also shrinks the segment length proportionally so each cut lands
 * under the target size.
 */
export function planSegmentation(
  backend: Pick<BatchSttBackend, 'maxBytes' | 'maxSegmentSeconds'>,
  durationSeconds: number,
  fileSizeMb: number,
): { shouldSegment: boolean; segmentDuration: number } {
  const fileSizeBytes = fileSizeMb * 1024 * 1024;
  const { maxBytes, maxSegmentSeconds } = backend;
  const shouldSegment =
    durationSeconds > maxSegmentSeconds || (maxBytes !== undefined && fileSizeBytes > maxBytes);

  // Duration is required to convert a size budget into a time budget; when
  // ffprobe failed (0) the caller falls back to the legacy segment muxer.
  if (maxBytes === undefined || durationSeconds <= 0) {
    return { shouldSegment, segmentDuration: maxSegmentSeconds };
  }
  const targetBytes = Math.min(SEGMENT_SIZE_TARGET_BYTES, maxBytes);
  if (fileSizeBytes <= targetBytes) {
    return { shouldSegment, segmentDuration: maxSegmentSeconds };
  }
  const shrunk = Math.floor((targetBytes / fileSizeBytes) * durationSeconds);
  return {
    shouldSegment,
    segmentDuration: Math.max(MIN_SHRUNK_SEGMENT_SECONDS, Math.min(maxSegmentSeconds, shrunk)),
  };
}

/**
 * Rungs of the bounded quality-retry ladder (issue #182). A backend with no
 * temperature knob gets exactly one re-roll and relies on provider
 * nondeterminism, because two identical requests are not new evidence.
 */
export function retryTemperaturesFor(
  backend: Pick<BatchSttBackend, 'supportsTemperature'>,
): Array<number | undefined> {
  return backend.supportsTemperature ? [...QUALITY_RETRY_TEMPERATURES] : [undefined];
}
