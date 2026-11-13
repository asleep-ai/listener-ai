// Main-owned, process-local operations that outlive a renderer connection.
// Callers supply a canonical target and use one result type for each kind.
// Results and error messages stay on the returned promise, never in snapshots.

import { randomUUID } from 'crypto';

export type BackgroundOperationStatus = 'running' | 'succeeded' | 'failed';

export interface BackgroundOperationSnapshot {
  id: string;
  kind: string;
  target: string;
  status: BackgroundOperationStatus;
  revision: number;
  startedAt: string;
  finishedAt?: string;
}

export interface BackgroundOperationsSnapshot {
  revision: number;
  operations: BackgroundOperationSnapshot[];
}

export interface BackgroundOperationChange {
  revision: number;
  operation: BackgroundOperationSnapshot;
  // Apply the changed operation first, then remove these records.
  removedIds: string[];
}

interface OperationRecord {
  snapshot: BackgroundOperationSnapshot;
  promise: Promise<unknown>;
}

export interface BackgroundOperationsOptions {
  maxFinished?: number;
}

function failedResult(result: unknown): boolean {
  return (
    typeof result === 'object' && result !== null && 'success' in result && result.success === false
  );
}

export class BackgroundOperations {
  private readonly records = new Map<string, OperationRecord>();
  private readonly running = new Map<string, OperationRecord>();
  private readonly finishedIds: string[] = [];
  private readonly listeners = new Set<(change: BackgroundOperationChange) => void>();
  private readonly changes: BackgroundOperationChange[] = [];
  private readonly maxFinished: number;
  private revision = 0;
  private notifying = false;

  constructor(options: BackgroundOperationsOptions = {}) {
    this.maxFinished = options.maxFinished ?? 20;
    if (!Number.isSafeInteger(this.maxFinished) || this.maxFinished < 0) {
      throw new RangeError('maxFinished must be a non-negative safe integer.');
    }
  }

  // Joins an active operation with exactly the same kind and canonical target.
  // A later request after settlement starts a fresh operation, including after
  // failure. Other result envelopes can supply a pure failure classifier.
  // `joinKey` (default: the target) narrows joining when inputs that must not
  // appear in snapshots, such as the signed-in account, change the result.
  run<R>(
    kind: string,
    target: string,
    task: () => R | PromiseLike<R>,
    isFailure: (result: R) => boolean = failedResult,
    joinKey: string = target,
  ): Promise<R> {
    const key = JSON.stringify([kind, joinKey]);
    const active = this.running.get(key);
    // The caller owns the correspondence between a kind and its result type.
    if (active) return active.promise as Promise<R>;

    let resolveResult!: (result: R | PromiseLike<R>) => void;
    let rejectResult!: (error: unknown) => void;
    const promise = new Promise<R>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const record: OperationRecord = {
      snapshot: {
        id: randomUUID(),
        kind,
        target,
        status: 'running',
        revision: ++this.revision,
        startedAt: new Date().toISOString(),
      },
      promise,
    };
    this.records.set(record.snapshot.id, record);
    this.running.set(key, record);
    this.notify(record, []);

    // Both observer reentry and synchronous task reentry see the reserved
    // promise. A thrown task or classifier settles the same failed operation.
    void Promise.resolve()
      .then(task)
      .then(
        (result) => {
          const failed = isFailure(result);
          this.finish(key, record, failed ? 'failed' : 'succeeded');
          resolveResult(result);
        },
        (error: unknown) => {
          this.finish(key, record, 'failed');
          rejectResult(error);
        },
      )
      .catch((error: unknown) => {
        this.finish(key, record, 'failed');
        rejectResult(error);
      });
    return promise;
  }

  // Subscribe before requesting a snapshot; consumers discard events or
  // snapshots not newer than the latest global revision they already applied.
  onChange(listener: (change: BackgroundOperationChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): BackgroundOperationsSnapshot {
    return {
      revision: this.revision,
      operations: [...this.records.values()].map((record) => ({ ...record.snapshot })),
    };
  }

  private finish(
    key: string,
    record: OperationRecord,
    status: Exclude<BackgroundOperationStatus, 'running'>,
  ): void {
    if (record.snapshot.status !== 'running') return;
    this.running.delete(key);
    record.snapshot = {
      ...record.snapshot,
      status,
      revision: ++this.revision,
      finishedAt: new Date().toISOString(),
    };
    this.finishedIds.push(record.snapshot.id);
    const removedIds: string[] = [];
    while (this.finishedIds.length > this.maxFinished) {
      const id = this.finishedIds.shift()!;
      this.records.delete(id);
      removedIds.push(id);
    }
    this.notify(record, removedIds);
  }

  private notify(record: OperationRecord, removedIds: string[]): void {
    this.changes.push({
      revision: this.revision,
      operation: { ...record.snapshot },
      removedIds,
    });
    if (this.notifying) return;
    this.notifying = true;
    try {
      // Queue reentrant notifications so every observer receives increasing
      // revisions, even when an earlier observer starts another operation.
      while (this.changes.length > 0) {
        const change = this.changes.shift()!;
        const listeners = [...this.listeners];
        for (const listener of listeners) {
          try {
            listener({
              ...change,
              operation: { ...change.operation },
              removedIds: [...change.removedIds],
            });
          } catch {
            // A disconnected or faulty observer cannot fail the operation.
          }
        }
      }
    } finally {
      this.notifying = false;
    }
  }
}
