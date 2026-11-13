// Renderer view of main's background operations (Notion upload, Slack send,
// transcript-cutoff report regeneration, freeing and restoring local audio).
// The work itself runs in main; this page may have started it, or may have
// reloaded or been reopened while it runs. Consumers ask whether an operation
// is running for a target and are told when one changes.

import { BackgroundOperationsView } from '../../src/backgroundOperationsView';
import type { BackgroundOperationSnapshot } from '../electronAPI';

const view = new BackgroundOperationsView();
const listeners = new Set<(operation: BackgroundOperationSnapshot) => void>();

function notify(op: BackgroundOperationSnapshot): void {
  for (const listener of listeners) listener(op);
}

export function isOperationRunning(kind: string, target: string | null | undefined): boolean {
  return view.isRunning(kind, target);
}

export function onBackgroundOperation(
  listener: (operation: BackgroundOperationSnapshot) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Subscribes first, then reads the snapshot, so nothing between the two is
// lost (see BackgroundOperationsView for the reconciliation rules).
export function setupBackgroundOperations(): Promise<void> {
  window.electronAPI.onBackgroundOperationChanged((change) => {
    const op = view.applyChange(change);
    if (op) notify(op);
  });
  return window.electronAPI
    .getBackgroundOperations()
    .then((snapshot) => {
      for (const op of view.applySnapshot(snapshot)) notify(op);
    })
    .catch(() => {});
}
