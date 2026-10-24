import * as path from 'node:path';
import type { LiveHint, LiveHintSource, RecordingLiveHintsV1 } from './liveHintTypes';

export const LIVE_HINTS_FILE = 'live-hints.json';
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && Array.from(value).length <= limit;
const offset = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

function sources(value: unknown): LiveHintSource[] | undefined {
  if (!Array.isArray(value) || value.length > 400) return;
  const result: LiveHintSource[] = [];
  for (const source of value) {
    if (
      !object(source) ||
      !text(source.ref, 200) ||
      !text(source.text, 12000) ||
      !offset(source.offsetMs) ||
      !['final', 'draft'].includes(String(source.state))
    )
      return;
    result.push({
      ref: source.ref,
      text: source.text,
      offsetMs: source.offsetMs,
      state: source.state as 'final' | 'draft',
      ...(source.uncertain === true ? { uncertain: true } : {}),
      ...(object(source.draft) &&
      offset(source.draft.streamEpoch) &&
      offset(source.draft.start) &&
      offset(source.draft.end) &&
      source.draft.end >= source.draft.start
        ? {
            draft: {
              streamEpoch: source.draft.streamEpoch,
              start: source.draft.start,
              end: source.draft.end,
            },
          }
        : {}),
    });
  }
  return result;
}

function hint(value: unknown, sessionId: string): LiveHint | undefined {
  if (
    !object(value) ||
    value.sessionId !== sessionId ||
    value.example === true ||
    !text(value.id, 200) ||
    !text(value.text, 160) ||
    !text(value.createdAt, 100) ||
    !offset(value.offsetMs) ||
    !Number.isInteger(value.revision) ||
    Number(value.revision) < 0 ||
    !['term', 'answer', 'question', 'action', 'catch-up'].includes(String(value.kind)) ||
    !['final', 'draft', 'retracted'].includes(String(value.sourceState)) ||
    !['auto', 'manual'].includes(String(value.trigger)) ||
    !Array.isArray(value.basis) ||
    value.basis.length > 3 ||
    !value.basis.every((b) => ['transcript', 'model-knowledge', 'suggestion'].includes(b))
  )
    return;
  const cited = sources(value.sources);
  if (!cited) return;
  const result: LiveHint = {
    id: value.id,
    sessionId,
    text: value.text,
    createdAt: value.createdAt,
    offsetMs: value.offsetMs,
    revision: Number(value.revision),
    kind: value.kind as LiveHint['kind'],
    sourceState: value.sourceState as LiveHint['sourceState'],
    trigger: value.trigger as LiveHint['trigger'],
    basis: [...value.basis],
    sources: cited,
    sourceSegmentIds: Array.isArray(value.sourceSegmentIds)
      ? value.sourceSegmentIds.filter((id): id is string => text(id, 200)).slice(0, 400)
      : [],
  };
  if (text(value.title, 48)) result.title = value.title;
  if (text(value.detail, 600)) result.detail = value.detail;
  if (text(value.language, 100)) result.language = value.language;
  if (offset(value.anchorOffsetMs)) result.anchorOffsetMs = value.anchorOffsetMs;
  if (offset(value.updatedOffsetMs)) result.updatedOffsetMs = value.updatedOffsetMs;
  if (object(value.topic) && text(value.topic.id, 200) && text(value.topic.label, 32))
    result.topic = { id: value.topic.id, label: value.topic.label };
  if (Array.isArray(value.history)) {
    result.history = value.history.slice(-5).flatMap((entry) => {
      if (
        !object(entry) ||
        !text(entry.text, 160) ||
        !offset(entry.producedOffsetMs) ||
        !Number.isInteger(entry.revision)
      )
        return [];
      return [
        {
          revision: Number(entry.revision),
          text: entry.text,
          producedOffsetMs: entry.producedOffsetMs,
          ...(text(entry.title, 48) ? { title: entry.title } : {}),
          ...(text(entry.detail, 600) ? { detail: entry.detail } : {}),
          ...(offset(entry.anchorOffsetMs) ? { anchorOffsetMs: entry.anchorOffsetMs } : {}),
          ...(sources(entry.sources) ? { sources: sources(entry.sources) } : {}),
          ...(['final', 'draft', 'retracted'].includes(String(entry.sourceState))
            ? { sourceState: entry.sourceState as LiveHint['sourceState'] }
            : {}),
        },
      ];
    });
  }
  return result;
}

/** Tolerant reader; only bounded, public hint fields cross the storage boundary. */
export function parseRecordingLiveHints(value: unknown): RecordingLiveHintsV1 | undefined {
  if (
    !object(value) ||
    value.version !== 1 ||
    !text(value.recordingId, 300) ||
    !Array.isArray(value.sessions)
  )
    return;
  let truncated = value.truncated === true || value.sessions.length > 32;
  let remaining = 8 * 1024 * 1024;
  const sessions: RecordingLiveHintsV1['sessions'] = [];
  for (const session of value.sessions.slice(0, 32)) {
    if (
      !object(session) ||
      !text(session.sessionId, 200) ||
      !text(session.startedAt, 100) ||
      !Number.isFinite(Date.parse(session.startedAt)) ||
      !offset(session.recordingOffsetMs) ||
      !Array.isArray(session.hints)
    ) {
      truncated = true;
      continue;
    }
    let sessionTruncated = session.truncated === true || session.hints.length > 2000;
    const hints: LiveHint[] = [];
    for (const candidate of session.hints.slice(0, 2000)) {
      const parsed = hint(candidate, session.sessionId);
      if (!parsed) {
        sessionTruncated = true;
        continue;
      }
      const size = Buffer.byteLength(JSON.stringify(parsed), 'utf8');
      if (size > remaining) {
        sessionTruncated = true;
        break;
      }
      remaining -= size;
      hints.push(parsed);
    }
    truncated ||= sessionTruncated;
    if (hints.length || sessionTruncated)
      sessions.push({
        sessionId: session.sessionId,
        startedAt: session.startedAt,
        recordingOffsetMs: session.recordingOffsetMs,
        hints,
        ...(sessionTruncated ? { truncated: true } : {}),
      });
  }
  return sessions.length || truncated
    ? {
        version: 1,
        recordingId: value.recordingId,
        sessions,
        ...(truncated ? { truncated: true } : {}),
      }
    : undefined;
}

/** A basename sidecar lookup must never authorize a different audio path. */
export function recordingHintsBelongToAudio(filePath: string, metadata: unknown): boolean {
  return (
    object(metadata) &&
    typeof metadata.filePath === 'string' &&
    path.resolve(metadata.filePath) === path.resolve(filePath)
  );
}

/** Preserve the newest evidence even when the audio stop retains a partial file. */
export async function finishRecordingWithHints(options: {
  activeFilePath?: string;
  stop(): Promise<import('./simpleAudioRecorder').StopResult>;
  hints: {
    takeRecordingHints(filePath: string, consume?: boolean): RecordingLiveHintsV1 | undefined;
    markRecordingHintsSaveFailed(filePath: string): void;
  };
  save(filePath: string, history: RecordingLiveHintsV1): Promise<void>;
  onSaveError(error: unknown): void;
  /** A live stop already in flight; its late finals are taken after the audio closes. */
  liveDrain?: Promise<unknown>;
}): Promise<import('./simpleAudioRecorder').StopResult> {
  const { activeFilePath, hints } = options;
  if (activeFilePath) hints.takeRecordingHints(activeFilePath, false);
  const result = await options.stop();
  await options.liveDrain?.catch(() => {});
  if (result.filePath) {
    const history = hints.takeRecordingHints(result.filePath, false);
    try {
      if (history) await options.save(result.filePath, history);
      hints.takeRecordingHints(result.filePath);
      if (history?.truncated)
        return {
          ...result,
          liveHintsSaveError:
            'Some AI hints could not be retained. The saved history is incomplete.',
        };
    } catch (error) {
      hints.markRecordingHintsSaveFailed(result.filePath);
      options.onSaveError(error);
      return {
        ...result,
        liveHintsSaveError:
          'AI hints could not be saved. They are temporarily retained in memory and may be lost when quitting.',
      };
    }
  } else if (!result.success && result.reason === 'empty' && activeFilePath) {
    hints.takeRecordingHints(activeFilePath);
  }
  return result;
}
