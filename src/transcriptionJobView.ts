// Renderer-side mirror of the main-owned transcription job registry
// (src/transcriptionJobs.ts). Pure and DOM-free so the ordering rules are
// unit-testable and shared by the renderer bundle.
//
// The renderer learns about jobs from two sources that can arrive in either
// order: pushed `transcription-job-changed` events and a `get-transcription-
// jobs` snapshot fetched on load. Every job carries the registry-wide revision
// of its last change, so the store keeps whichever copy is newer. A snapshot
// taken before a job finished can therefore never bring the job back to
// "running" after its terminal event was applied.

import type {
  TranscriptionJobKind,
  TranscriptionJobSnapshot,
  TranscriptionJobsList,
} from './transcriptionJobs';

export interface TranscriptionJobChange {
  job: TranscriptionJobSnapshot;
  previous?: TranscriptionJobSnapshot;
}

// Finished jobs kept for display, like main's registry (which drops them
// without telling the renderer).
const MAX_FINISHED = 20;
// Ids of finished jobs this store dropped, so a late event or snapshot copy of
// one cannot add it back. Past this many, the oldest ids give way to a
// revision floor below which unknown jobs are ignored.
const MAX_EVICTED_IDS = 200;

export class TranscriptionJobStore {
  private readonly jobs = new Map<string, TranscriptionJobSnapshot>();
  private listRevision = 0;
  private readonly evicted = new Map<string, number>();
  private evictedFloor = 0;
  // The renderer applies one snapshot, fetched once at load. Until it has
  // been applied (or given up on), no evicted id is forgotten: a snapshot
  // taken before a job finished must still find that job's tombstone, while a
  // job the snapshot lists as running that this store never saw (an idle,
  // long-running job) is still accepted.
  private snapshotSettled = false;

  constructor(private readonly maxFinished = MAX_FINISHED) {}

  applyEvent(job: TranscriptionJobSnapshot): TranscriptionJobChange | null {
    const previous = this.jobs.get(job.id);
    if (previous && previous.revision >= job.revision) return null;
    if (this.evicted.has(job.id)) return null;
    // Unknown and no newer than an applied snapshot that did not list it, or
    // than a job this store already dropped: a straggler of a finished job.
    if (!previous && job.revision <= Math.max(this.listRevision, this.evictedFloor)) return null;
    this.jobs.set(job.id, job);
    this.pruneFinished();
    return { job, ...(previous ? { previous } : {}) };
  }

  applyList(list: TranscriptionJobsList): TranscriptionJobChange[] {
    const changes: TranscriptionJobChange[] = [];
    const listed = new Set<string>();
    for (const job of list.jobs) {
      listed.add(job.id);
      if (this.evicted.has(job.id)) continue;
      const previous = this.jobs.get(job.id);
      if (previous && previous.revision >= job.revision) continue;
      this.jobs.set(job.id, job);
      changes.push({ job, ...(previous ? { previous } : {}) });
    }
    for (const [id, job] of this.jobs) {
      // Evicted in main before this snapshot was taken. A newer event for a
      // job the snapshot could not have seen yet is kept.
      if (!listed.has(id) && job.revision <= list.revision && !isActiveJob(job)) {
        this.jobs.delete(id);
      }
    }
    this.listRevision = Math.max(this.listRevision, list.revision);
    this.snapshotSettled = true;
    this.pruneFinished();
    return changes;
  }

  // For a renderer whose snapshot request failed: no snapshot will arrive, so
  // tombstones may start rolling off.
  markSnapshotSettled(): void {
    this.snapshotSettled = true;
    this.pruneFinished();
  }

  private pruneFinished(): void {
    const finished = [...this.jobs.values()]
      .filter((job) => !isActiveJob(job))
      .sort((a, b) => a.revision - b.revision);
    for (const job of finished.slice(0, Math.max(0, finished.length - this.maxFinished))) {
      this.jobs.delete(job.id);
      this.evicted.set(job.id, job.revision);
    }
    while (this.snapshotSettled && this.evicted.size > MAX_EVICTED_IDS) {
      const [oldestId, revision] = this.evicted.entries().next().value as [string, number];
      this.evicted.delete(oldestId);
      this.evictedFloor = Math.max(this.evictedFloor, revision);
    }
  }

  get(id: string): TranscriptionJobSnapshot | undefined {
    return this.jobs.get(id);
  }

  all(): TranscriptionJobSnapshot[] {
    return [...this.jobs.values()];
  }

  // The running job a recording row belongs to. `keys` are the row's path
  // plus the aliases main listed for it; the job matches through any of its
  // paths (requested or renamed) or the alias keys main matches on.
  activeForPath(
    keys: string | string[],
    kind: TranscriptionJobKind = 'transcribe',
  ): TranscriptionJobSnapshot | undefined {
    for (const job of this.jobs.values()) {
      if (job.kind === kind && isActiveJob(job) && jobMatchesPath(job, keys)) return job;
    }
    return undefined;
  }

  activeOfKind(kind: TranscriptionJobKind): TranscriptionJobSnapshot | undefined {
    for (const job of this.jobs.values()) {
      if (job.kind === kind && isActiveJob(job)) return job;
    }
    return undefined;
  }
}

export function jobMatchesPath(job: TranscriptionJobSnapshot, keys: string | string[]): boolean {
  const list = typeof keys === 'string' ? [keys] : keys;
  return list.some((key) => job.paths.includes(key) || job.aliases.includes(key));
}

export function isActiveJob(job: TranscriptionJobSnapshot): boolean {
  return job.status === 'running';
}

// True only for the change that ends a job this renderer had seen running.
export function endedJob(change: TranscriptionJobChange): boolean {
  return !isActiveJob(change.job) && change.previous !== undefined && isActiveJob(change.previous);
}

// Status line for an auto-mode job's export outcome. Mirrors the messages the
// renderer showed when it ran the exports itself.
export function describeAutoExports(exports: TranscriptionJobSnapshot['exports']): string {
  const notion = exports?.notion;
  const slack = exports?.slack;
  if (slack) {
    if (slack.status !== 'succeeded') return 'Auto mode: Failed to send to Slack';
    if (notion?.status === 'succeeded') return 'Auto mode: Sent to Notion and Slack.';
    if (notion) return 'Auto mode: Sent to Slack (Notion failed).';
    return 'Auto mode: Sent to Slack.';
  }
  if (notion) {
    return notion.status === 'succeeded'
      ? 'Auto mode: Successfully uploaded to Notion!'
      : 'Auto mode: Failed to upload to Notion';
  }
  return 'Auto mode: Transcription complete (Notion/Slack not configured)';
}
