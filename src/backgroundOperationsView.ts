// Renderer-shared reconciliation of main's background operations: revisioned
// change events plus a snapshot read after subscribing. Pure, so the
// reconnect rules are unit-tested here and used by renderer/ui.

import type {
  BackgroundOperationChange,
  BackgroundOperationSnapshot,
  BackgroundOperationsSnapshot,
} from './electronApiTypes';

export class BackgroundOperationsView {
  private readonly operations = new Map<string, BackgroundOperationSnapshot>();
  // Records main already evicted; a snapshot read that was in flight when the
  // removal arrived must not bring them back as running.
  private readonly removed = new Set<string>();
  private appliedRevision = 0;

  /** Applies a change event; returns the operation when it was new to this view. */
  applyChange(change: BackgroundOperationChange): BackgroundOperationSnapshot | null {
    if (change.revision <= this.appliedRevision) return null;
    this.appliedRevision = change.revision;
    this.operations.set(change.operation.id, change.operation);
    for (const id of change.removedIds) {
      this.operations.delete(id);
      this.removed.add(id);
    }
    return change.operation;
  }

  /**
   * Merges a snapshot read after subscribing. Each record keeps whichever
   * copy is newer; evicted records stay evicted. Returns the records taken
   * from the snapshot.
   */
  applySnapshot(snapshot: BackgroundOperationsSnapshot): BackgroundOperationSnapshot[] {
    this.appliedRevision = Math.max(this.appliedRevision, snapshot.revision);
    const taken: BackgroundOperationSnapshot[] = [];
    for (const op of snapshot.operations) {
      const known = this.operations.get(op.id);
      if (this.removed.has(op.id) || (known && known.revision >= op.revision)) continue;
      this.operations.set(op.id, op);
      taken.push(op);
    }
    return taken;
  }

  isRunning(kind: string, target: string | null | undefined): boolean {
    if (!target) return false;
    for (const op of this.operations.values()) {
      if (op.kind === kind && op.target === target && op.status === 'running') return true;
    }
    return false;
  }
}
