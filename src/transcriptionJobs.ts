// Main-owned registry of batch transcription and merge jobs.
//
// The renderer used to be the only place that knew a transcription was
// running: progress listeners, the row's Cancel button and the auto-mode
// Notion/Slack follow-ups all lived in renderer memory, so a reload lost them
// and the next click on Transcribe aborted the job it could no longer see.
// This registry keeps that state in the main process, which outlives renderer
// reloads, so a reloaded or re-rendered window can ask for a snapshot and keep
// following the same job. Nothing here survives the app quitting.
//
// Pure module: no Electron import, so it is unit-testable under `node --test`.

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type TranscriptionJobKind = 'transcribe' | 'merge';
export type TranscriptionJobOrigin = 'manual' | 'auto';
export type TranscriptionJobStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';
// `exporting` is the auto-mode Notion/Slack follow-up after the note is saved.
export type TranscriptionJobPhase = 'transcribing' | 'exporting';

export interface TranscriptionJobExportOutcome {
  status: 'running' | 'succeeded' | 'failed';
  url?: string;
  error?: string;
}

export interface TranscriptionJobExports {
  notion?: TranscriptionJobExportOutcome;
  slack?: TranscriptionJobExportOutcome;
}

// Serializable view sent to the renderer. `revision` grows with every change
// of any job, so a renderer can drop an event or snapshot older than what it
// already applied (a delayed snapshot must never resurrect a finished job).
export interface TranscriptionJobSnapshot {
  id: string;
  kind: TranscriptionJobKind;
  origin: TranscriptionJobOrigin;
  status: TranscriptionJobStatus;
  phase: TranscriptionJobPhase;
  revision: number;
  // The path the job was started for.
  filePath: string;
  // Every path that names this job: the requested path and, once the audio is
  // renamed to its suggested title, the renamed path too.
  paths: string[];
  // The exact keys main matches requests against (`pathKeys` of every path:
  // the resolved path and the path the filesystem reports for it). A renderer
  // row matches the job when any of its own keys is listed here.
  aliases: string[];
  // Merge inputs. They are not aliases: transcribing a source recording is a
  // separate job.
  sourcePaths?: string[];
  title?: string;
  percent: number;
  message: string;
  // False once the note is saved: from then on the result is kept.
  cancellable: boolean;
  cancelRequested: boolean;
  startedAt: string;
  finishedAt?: string;
  newFilePath?: string;
  mergedAudioPath?: string;
  transcriptionPath?: string;
  generationId?: string | null;
  error?: string;
  code?: string;
  errorDetails?: unknown;
  exports?: TranscriptionJobExports;
}

export interface TranscriptionJobsList {
  revision: number;
  jobs: TranscriptionJobSnapshot[];
}

// Fields a runner may report while it works.
export type TranscriptionJobUpdate = Partial<
  Pick<
    TranscriptionJobSnapshot,
    | 'phase'
    | 'title'
    | 'newFilePath'
    | 'mergedAudioPath'
    | 'transcriptionPath'
    | 'generationId'
    | 'exports'
  >
>;

export interface TranscriptionJobHandle {
  readonly id: string;
  readonly signal: AbortSignal;
  progress(percent: number, message: string): void;
  // Registers another path (the renamed audio) that identifies this job.
  // Returns false, and registers nothing, when another running job already
  // answers to that path. Call it BEFORE creating the file: the claim is
  // synchronous, so it doubles as the reservation that keeps any other job
  // from taking the path while the move is in progress.
  addPath(filePath: string): boolean;
  // Two-step form of addPath for a path whose file is still being created.
  // reservePath claims the path privately: other jobs cannot claim it, and a
  // request or cancel for it waits (see pendingReservation), but nothing
  // matches it, lists it, or emits it yet, so a request for an unrelated
  // recording that turns out to hold the name is never redirected to this
  // job. commitPath publishes it once the file is ours; removePath drops it.
  reservePath(filePath: string): boolean;
  commitPath(filePath: string): void;
  // Releases a path claimed with addPath, or a reservation, whose file could
  // not be created. The path the job was started for is never released.
  removePath(filePath: string): void;
  update(patch: TranscriptionJobUpdate): void;
  // Marks the commit boundary: the note is saved, so cancel no longer aborts.
  commit(): void;
}

// The handler response shapes this registry settles from. Both
// `transcribe-audio` and `merge-recordings` responses fit.
export interface TranscriptionJobResultLike {
  success?: boolean;
  cancelled?: boolean;
  error?: string;
  code?: string;
  errorDetails?: unknown;
  newFilePath?: string;
  mergedAudioPath?: string;
  transcriptionPath?: string;
  generationId?: string | null;
  exports?: TranscriptionJobExports;
}

export type CancelJobResult =
  | { success: true }
  | { success: false; reason: 'not-running' | 'committed' };

export interface StartJobOptions {
  kind: TranscriptionJobKind;
  origin?: TranscriptionJobOrigin;
  // Required for a transcription; a merge has no output path until it runs.
  filePath?: string;
  sourcePaths?: string[];
  title?: string;
}

export interface StartedJob<R> {
  job: TranscriptionJobSnapshot;
  // True when an active job for the same path already existed and this call
  // attached to it instead of starting another run.
  joined: boolean;
  promise: Promise<R>;
}

interface JobRecord {
  snapshot: TranscriptionJobSnapshot;
  keys: Set<string>;
  // The keys each path contributed, so a released path drops only its own.
  pathKeys: Map<string, string[]>;
  // Private claims on paths whose files are still being created.
  reserved: Map<string, Reservation>;
  controller: AbortController;
  committed: boolean;
  promise: Promise<unknown>;
}

export interface RegistryOptions {
  maxFinished?: number;
  finishedTtlMs?: number;
  now?: () => number;
}

// Keys that identify a path regardless of spelling: the resolved path and the
// path the filesystem itself resolves it to (symlinks such as macOS /tmp vs
// /private/tmp; on a normalization-insensitive filesystem like APFS, also the
// stored Unicode form). Identity is never inferred beyond what the filesystem
// reports: two names that are distinct files stay distinct.
export function pathKeys(filePath: string): string[] {
  const resolved = path.resolve(filePath);
  const keys = new Set([resolved]);
  try {
    keys.add(fs.realpathSync.native(resolved));
  } catch {
    // Missing file (not created yet, renamed away, deleted): the real parent
    // directory plus the unchanged name is the path the file will have, so a
    // spelling through a symlinked directory still shares a key with the
    // canonical one.
    try {
      keys.add(path.join(fs.realpathSync.native(path.dirname(resolved)), path.basename(resolved)));
    } catch {
      // Missing directory too: the resolved path is all we have.
    }
  }
  return [...keys];
}

export class TranscriptionJobRegistry {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly listeners = new Set<(job: TranscriptionJobSnapshot) => void>();
  private revision = 0;
  private readonly maxFinished: number;
  private readonly finishedTtlMs: number;
  private readonly now: () => number;

  constructor(options: RegistryOptions = {}) {
    this.maxFinished = options.maxFinished ?? 20;
    this.finishedTtlMs = options.finishedTtlMs ?? 15 * 60_000;
    this.now = options.now ?? Date.now;
  }

  // Admit a job, or join the active one for the same path. Joining never
  // aborts the running job: a deliberate restart is cancel, then start.
  start<R extends TranscriptionJobResultLike>(
    options: StartJobOptions,
    runner: (handle: TranscriptionJobHandle) => Promise<R>,
  ): StartedJob<R> {
    if (options.kind === 'transcribe' && options.filePath) {
      const existing = this.findActiveRecord(options.filePath, 'transcribe');
      if (existing) {
        return {
          job: clone(existing.snapshot),
          joined: true,
          promise: existing.promise as Promise<R>,
        };
      }
    }

    const controller = new AbortController();
    const record: JobRecord = {
      snapshot: {
        id: randomUUID(),
        kind: options.kind,
        origin: options.origin ?? 'manual',
        status: 'running',
        phase: 'transcribing',
        revision: 0,
        filePath: options.filePath ?? '',
        paths: options.filePath ? [options.filePath] : [],
        aliases: options.filePath ? pathKeys(options.filePath) : [],
        ...(options.sourcePaths ? { sourcePaths: [...options.sourcePaths] } : {}),
        ...(options.title ? { title: options.title } : {}),
        percent: 0,
        message: '',
        cancellable: true,
        cancelRequested: false,
        startedAt: new Date(this.now()).toISOString(),
      },
      keys: new Set(options.filePath ? pathKeys(options.filePath) : []),
      pathKeys: new Map(options.filePath ? [[options.filePath, pathKeys(options.filePath)]] : []),
      reserved: new Map(),
      controller,
      committed: false,
      promise: Promise.resolve(),
    };
    this.jobs.set(record.snapshot.id, record);

    const handle: TranscriptionJobHandle = {
      id: record.snapshot.id,
      signal: controller.signal,
      progress: (percent, message) => {
        if (record.snapshot.status !== 'running') return;
        record.snapshot.percent = percent;
        record.snapshot.message = message;
        this.emit(record);
      },
      addPath: (filePath) => {
        if (!handle.reservePath(filePath)) return false;
        handle.commitPath(filePath);
        return true;
      },
      reservePath: (filePath) => {
        if (record.snapshot.paths.includes(filePath) || record.reserved.has(filePath)) return true;
        const keys = pathKeys(filePath);
        // One owner per path: a key another running job answers to, or has
        // reserved, is never shared, so cancel and join can never reach the
        // wrong job.
        if (this.ownedByOtherActiveJob(keys, record)) return false;
        let settle!: () => void;
        const settled = new Promise<void>((resolve) => {
          settle = resolve;
        });
        record.reserved.set(filePath, { keys, settled, settle });
        return true;
      },
      commitPath: (filePath) => {
        const reservation = record.reserved.get(filePath);
        if (!reservation) return;
        record.reserved.delete(filePath);
        // The file exists now: add whatever the filesystem reports for it.
        const keys = [...new Set([...reservation.keys, ...pathKeys(filePath)])];
        record.snapshot.paths.push(filePath);
        record.pathKeys.set(filePath, keys);
        addKeys(record, keys);
        this.emit(record);
        reservation.settle();
      },
      removePath: (filePath) => {
        const reservation = record.reserved.get(filePath);
        if (reservation) {
          record.reserved.delete(filePath);
          reservation.settle();
          return;
        }
        if (filePath === record.snapshot.filePath || !record.pathKeys.has(filePath)) return;
        record.pathKeys.delete(filePath);
        record.snapshot.paths = record.snapshot.paths.filter((p) => p !== filePath);
        record.keys = new Set([...record.pathKeys.values()].flat());
        record.snapshot.aliases = [...record.keys];
        this.emit(record);
      },
      update: (patch) => {
        if (record.snapshot.status !== 'running') return;
        Object.assign(record.snapshot, patch);
        this.emit(record);
      },
      commit: () => {
        if (record.committed) return;
        record.committed = true;
        record.snapshot.cancellable = false;
        this.emit(record);
      },
    };

    this.emit(record);
    const promise = (async () => {
      try {
        const result = await runner(handle);
        this.settle(record, result);
        return result;
      } catch (error) {
        this.settle(record, {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    })();
    record.promise = promise;
    return { job: clone(record.snapshot), joined: false, promise };
  }

  cancel(filePath: string): CancelJobResult {
    const record = this.findActiveRecord(filePath, 'transcribe');
    if (!record) return { success: false, reason: 'not-running' };
    if (record.committed) return { success: false, reason: 'committed' };
    record.snapshot.cancelRequested = true;
    record.controller.abort();
    this.emit(record);
    return { success: true };
  }

  // Resolves when a running job's private reservation on `filePath` is
  // published or dropped; undefined when there is none. A request or cancel
  // for that path waits for it, so it never reads a file that is still being
  // created and never reaches a job that only tried to take the name.
  pendingReservation(filePath: string): Promise<void> | undefined {
    const keys = pathKeys(filePath);
    for (const record of this.jobs.values()) {
      if (record.snapshot.status !== 'running') continue;
      for (const reservation of record.reserved.values()) {
        if (keys.some((key) => reservation.keys.includes(key))) return reservation.settled;
      }
    }
    return undefined;
  }

  findActive(filePath: string, kind: TranscriptionJobKind): TranscriptionJobSnapshot | undefined {
    const record = this.findActiveRecord(filePath, kind);
    return record ? clone(record.snapshot) : undefined;
  }

  hasActive(kind: TranscriptionJobKind): boolean {
    for (const record of this.jobs.values()) {
      if (record.snapshot.kind === kind && record.snapshot.status === 'running') return true;
    }
    return false;
  }

  list(): TranscriptionJobsList {
    this.prune();
    return {
      revision: this.revision,
      jobs: [...this.jobs.values()].map((record) => clone(record.snapshot)),
    };
  }

  subscribe(listener: (job: TranscriptionJobSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private ownedByOtherActiveJob(keys: string[], self: JobRecord): boolean {
    for (const record of this.jobs.values()) {
      if (record === self || record.snapshot.status !== 'running') continue;
      if (keys.some((key) => record.keys.has(key))) return true;
      for (const reservation of record.reserved.values()) {
        if (keys.some((key) => reservation.keys.includes(key))) return true;
      }
    }
    return false;
  }

  private findActiveRecord(filePath: string, kind: TranscriptionJobKind): JobRecord | undefined {
    const keys = pathKeys(filePath);
    for (const record of this.jobs.values()) {
      if (record.snapshot.kind !== kind || record.snapshot.status !== 'running') continue;
      if (keys.some((key) => record.keys.has(key))) return record;
    }
    return undefined;
  }

  private settle(record: JobRecord, result: TranscriptionJobResultLike): void {
    const snapshot = record.snapshot;
    if (snapshot.status !== 'running') return;
    // A reservation never outlives its job.
    for (const reservation of record.reserved.values()) reservation.settle();
    record.reserved.clear();
    snapshot.status = result.cancelled ? 'cancelled' : result.success ? 'succeeded' : 'failed';
    snapshot.cancellable = false;
    snapshot.finishedAt = new Date(this.now()).toISOString();
    if (snapshot.status === 'succeeded') snapshot.percent = 100;
    if (result.error !== undefined) snapshot.error = result.error;
    if (result.code !== undefined) snapshot.code = result.code;
    if (result.errorDetails !== undefined) snapshot.errorDetails = result.errorDetails;
    if (result.newFilePath !== undefined) {
      snapshot.newFilePath = result.newFilePath;
      if (!snapshot.paths.includes(result.newFilePath)) {
        snapshot.paths.push(result.newFilePath);
        const keys = pathKeys(result.newFilePath);
        record.pathKeys.set(result.newFilePath, keys);
        addKeys(record, keys);
      }
    }
    if (result.mergedAudioPath !== undefined) snapshot.mergedAudioPath = result.mergedAudioPath;
    if (result.transcriptionPath !== undefined) {
      snapshot.transcriptionPath = result.transcriptionPath;
    }
    if (result.generationId !== undefined) snapshot.generationId = result.generationId;
    if (result.exports !== undefined) snapshot.exports = result.exports;
    this.emit(record);
    this.prune();
  }

  private emit(record: JobRecord): void {
    record.snapshot.revision = ++this.revision;
    const snapshot = clone(record.snapshot);
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.error('Transcription job listener failed:', error);
      }
    }
  }

  // Finished jobs stay listed for a while so a renderer that reloaded during
  // the run can still see how it ended.
  private prune(): void {
    const finished = [...this.jobs.values()].filter((r) => r.snapshot.status !== 'running');
    const cutoff = this.now() - this.finishedTtlMs;
    const excess = finished.length - this.maxFinished;
    finished.forEach((record, index) => {
      const finishedAt = Date.parse(record.snapshot.finishedAt ?? '');
      if (index < excess || finishedAt < cutoff) this.jobs.delete(record.snapshot.id);
    });
  }
}

interface Reservation {
  keys: string[];
  settled: Promise<void>;
  settle: () => void;
}

function addKeys(record: JobRecord, keys: string[]): void {
  for (const key of keys) {
    if (record.keys.has(key)) continue;
    record.keys.add(key);
    record.snapshot.aliases.push(key);
  }
}

function clone(snapshot: TranscriptionJobSnapshot): TranscriptionJobSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as TranscriptionJobSnapshot;
}

// One registry per main process, shared by the transcription and merge IPC.
export const transcriptionJobs = new TranscriptionJobRegistry();
