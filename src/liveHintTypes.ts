// Live AI hints: the additive contract shared by main, preload and the
// renderer. Types only -- importing it never emits runtime code, so the
// renderer can use it without pulling in the engine.
//
// Live hints may be stored with their owning recording; never added to report exports.

/** Automatic generation, manual requests only, or nothing. Per live session; default `off`. */
export type LiveHintsMode = 'off' | 'manual' | 'auto';

/** `catch-up` only answers an explicit request. */
export type LiveHintKind = 'term' | 'answer' | 'question' | 'action' | 'catch-up';

/**
 * What a cue rests on. `transcript` = the cited source speech,
 * `model-knowledge` = general knowledge (e.g. a definition), `suggestion` =
 * a proposed question/answer/action, never a meeting fact.
 */
export type LiveHintBasis = 'transcript' | 'model-knowledge' | 'suggestion';

/**
 * Provenance of the cited source.
 * - `final`: finalized original-language source segments.
 * - `draft`: a stable window of the live input transcript on a stream that
 *   emits no finals until it closes (OpenAI translation). Not provider-confirmed.
 * - `retracted`: the cited draft text was later rewritten by the provider, so
 *   the cue no longer has a matching source. Kept visible, never deleted.
 */
export type LiveHintSourceState = 'final' | 'draft' | 'retracted';

/** How the active stream delivers original-language source text. */
export type LiveHintSourceCapability = 'turn-finals' | 'session-final';

/** One cited source excerpt, kept with the cue so it stays inspectable. */
export interface LiveHintSource {
  /** Segment id (final) or draft id (`draft_<epoch>_<n>`). */
  ref: string;
  state: 'final' | 'draft';
  text: string;
  /** Live-session offset of the source, ms. */
  offsetMs: number;
  /** Draft only: stream epoch and Unicode code-point range in that epoch's input transcript. */
  draft?: { streamEpoch: number; start: number; end: number };
  /** The ASR quality analyzer flagged this final as possibly unreliable. */
  uncertain?: true;
}

/** A session-scoped topic. The engine owns the registry; ids are never reused for another label. */
export interface LiveHintTopic {
  /** Stable for the session (`<sessionId>_topic_<n>`). */
  id: string;
  /** <= 32 code points, plain text. */
  label: string;
}

/** Earlier content of a cue that a same-topic update replaced. */
export interface LiveHintRevisionEntry {
  /** The cue's `revision` while this content was current. */
  revision: number;
  title?: string;
  text: string;
  detail?: string;
  anchorOffsetMs?: number;
  /** Live-session offset when this content was produced, ms. */
  producedOffsetMs: number;
  /** Snapshot (copy) of the sources this content cited, so the earlier fact stays traceable. */
  sources?: LiveHintSource[];
  sourceState?: LiveHintSourceState;
}

export interface LiveHint {
  id: string;
  sessionId: string;
  kind: LiveHintKind;
  /** <= 160 code points, plain text (render with textContent). */
  text: string;
  /** <= 600 code points, plain text. */
  detail?: string;
  basis: LiveHintBasis[];
  sourceState: LiveHintSourceState;
  /** Final segment ids the cue cites (empty for draft-only cues until reconciled). */
  sourceSegmentIds: string[];
  sources: LiveHintSource[];
  trigger: 'auto' | 'manual';
  /** Increments on every `hintUpdated` (reconciliation, retraction or content update). */
  revision: number;
  createdAt: string;
  /** Live-session offset when the cue was produced, ms. */
  offsetMs: number;
  /** Requested output language, when one was set. */
  language?: string;
  /** Produced by the example feed from fictional fixtures; no AI call was made. */
  example?: true;
  /** <= 48 code points, plain text. Absent: show `text`. */
  title?: string;
  /** Absent: unclassified. */
  topic?: LiveHintTopic;
  /**
   * Evidence anchor: the latest `sources[].offsetMs` the cue cited when it was
   * accepted or last updated. Unlike `offsetMs` (production time) this is the
   * speech time. Absent on legacy cues.
   */
  anchorOffsetMs?: number;
  /** Live-session offset of the last same-topic content update, ms. Absent: never updated. */
  updatedOffsetMs?: number;
  /** Content replaced by same-topic updates, oldest first, at most 5. */
  history?: LiveHintRevisionEntry[];
}

export type LiveHintState =
  /** Mode off: no generation. */
  | 'off'
  /** Waiting for enough new speech (auto) or for a request (manual). */
  | 'listening'
  /** A request is in flight. */
  | 'generating'
  /** Auto generation paused, e.g. the stream delivers translation but no source text. */
  | 'paused'
  /** The hourly allowance is used up. */
  | 'limited'
  /** The text provider failed or is not configured; captions continue. */
  | 'unavailable'
  /** begin-stop/stop: no new requests; existing cues may still be reconciled. */
  | 'stopped';

export interface LiveHintStatus {
  sessionId: string;
  mode: LiveHintsMode;
  state: LiveHintState;
  /** Short user-facing explanation for paused/limited/unavailable/last error. */
  reason?: string;
  sourceCapability: LiveHintSourceCapability;
  /** Normalized characters of new source not yet covered by a request. */
  pendingChars: number;
  /** Calls admitted in the last rolling hour (shared by auto, manual and all sessions). */
  callsLastHour: number;
  callsPerHourLimit: number;
  /** ISO time the most recent request completed (any outcome). */
  lastRequestAt?: string;
  example?: true;
}

export interface LiveHintsSnapshot {
  status: LiveHintStatus;
  hints: LiveHint[];
}

/** Manual request intents. `suggest` = best cue for the latest speech. */
export type LiveHintIntent = 'suggest' | 'catch-up';

// --- Events, added to the live-session event union -------------------------
export type LiveHintEvent =
  | { type: 'hint'; sessionId: string; hint: LiveHint }
  | { type: 'hintUpdated'; sessionId: string; hint: LiveHint }
  | { type: 'hintStatus'; sessionId: string; status: LiveHintStatus };

// --- IPC payloads -----------------------------------------------------------
export type LiveHintsApiResult =
  | { success: true; hints: LiveHintsSnapshot }
  | { success: false; error: string };

export type LiveHintRequestApiResult =
  | {
      success: true;
      /** False when the request could not start (reason says why). Results arrive as `hint` events. */
      accepted: boolean;
      reason?: string;
      hints: LiveHintsSnapshot;
    }
  | { success: false; error: string };

export type LiveHintApiStopResult = { success: true } | { success: false; error: string };

export type LiveHintExampleScenario = 'continuous' | 'translation-draft';

/**
 * Example feed for the live panel. Fictional fixture speech is replayed on an
 * accelerated clock through the real hint engine, with a scripted generator in
 * place of the AI provider. No microphone, no provider call, no user data.
 * Events use the live-session event shapes (`status`, `interim`,
 * `translationInterim`, `segment`, hint events) with the example session id,
 * on the separate `live-hints-example-event` channel, plus `exampleEnded` when the
 * fictional speech is over (the session stays open until stopped).
 */
export type LiveHintExampleEvent =
  | (import('./electronApiTypes').LiveSessionEvent & { example: true })
  | { type: 'exampleEnded'; sessionId: string; example: true };

export type LiveHintExampleStartResult =
  | {
      success: true;
      sessionId: string;
      scenario: LiveHintExampleScenario;
      title: string;
      /** Fictional meeting length (fixture clock), ms. */
      durationMs: number;
      /** Fixture-clock ms per real ms. */
      speed: number;
      hints: LiveHintsSnapshot;
    }
  | { success: false; error: string };

/** Versioned recording history. Hint offsets remain relative to their live session. */
export interface RecordingLiveHintsV1 {
  version: 1;
  recordingId: string;
  /** Storage limits omitted some history; show a persistent notice. */
  truncated?: true;
  sessions: Array<{
    sessionId: string;
    startedAt: string;
    /** Add this to hint/source offsets to seek within the recording. */
    recordingOffsetMs: number;
    hints: LiveHint[];
    truncated?: true;
  }>;
}

export type RecordingLiveHintsReadResult =
  | { success: true; liveHints?: RecordingLiveHintsV1 }
  | { success: false; error: string };
