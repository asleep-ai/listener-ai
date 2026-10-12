// Renderer view of the main-owned transcription/merge jobs.
//
// Main keeps running a job when this window reloads, so the UI is rebuilt from
// main's state instead of from memory: subscribe to pushed job changes first,
// then fetch a snapshot, and let the revision-guarded store reconcile the two
// (src/transcriptionJobView.ts). Feature modules (recording rows, auto mode,
// the transcription modal) register listeners here.

import { type TranscriptionJobChange, TranscriptionJobStore } from '../../src/transcriptionJobView';
import type { TranscriptionJobSnapshot } from '../electronAPI';

export type JobChangeSource = 'event' | 'snapshot';
type JobListener = (change: TranscriptionJobChange, source: JobChangeSource) => void;

const store = new TranscriptionJobStore();
const listeners = new Set<JobListener>();
let setupDone = false;

function notify(change: TranscriptionJobChange, source: JobChangeSource): void {
  for (const listener of listeners) {
    try {
      listener(change, source);
    } catch (error) {
      console.error('Transcription job listener failed:', error);
    }
  }
}

export function setupTranscriptionJobs(): Promise<void> {
  if (setupDone) return Promise.resolve();
  setupDone = true;
  const api = window.electronAPI;
  if (!api.onTranscriptionJobChanged || !api.getTranscriptionJobs) {
    store.markSnapshotSettled();
    return Promise.resolve();
  }
  api.onTranscriptionJobChanged((job) => {
    const change = store.applyEvent(job);
    if (change) notify(change, 'event');
  });
  return api
    .getTranscriptionJobs()
    .then((list) => {
      for (const change of store.applyList(list)) notify(change, 'snapshot');
    })
    .catch((error) => {
      console.error('Failed to load transcription jobs:', error);
      store.markSnapshotSettled();
    });
}

export function onTranscriptionJobChange(listener: JobListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// `keys`: a path, or a row's path plus the aliases main listed for it.
export function activeJobForPath(keys: string | string[]): TranscriptionJobSnapshot | undefined {
  return store.activeForPath(keys, 'transcribe');
}

export function activeMergeJob(): TranscriptionJobSnapshot | undefined {
  return store.activeOfKind('merge');
}

export function getTranscriptionJob(id: string): TranscriptionJobSnapshot | undefined {
  return store.get(id);
}
