import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TranscriptionJobSnapshot } from './transcriptionJobs';
import { TranscriptionJobStore, describeAutoExports, endedJob } from './transcriptionJobView';

function job(overrides: Partial<TranscriptionJobSnapshot>): TranscriptionJobSnapshot {
  return {
    id: 'job-1',
    kind: 'transcribe',
    origin: 'manual',
    status: 'running',
    phase: 'transcribing',
    revision: 1,
    filePath: '/rec/Untitled_Meeting_x.webm',
    paths: ['/rec/Untitled_Meeting_x.webm'],
    aliases: ['/rec/Untitled_Meeting_x.webm'],
    percent: 0,
    message: '',
    cancellable: true,
    cancelRequested: false,
    startedAt: '2026-10-12T05:00:00.000Z',
    ...overrides,
  };
}

describe('TranscriptionJobStore', () => {
  it('never lets a delayed snapshot resurrect a job whose terminal event was applied', () => {
    const store = new TranscriptionJobStore();
    store.applyEvent(job({ revision: 3, percent: 40 }));
    const ended = store.applyEvent(job({ revision: 7, status: 'succeeded', percent: 100 }));
    assert.ok(ended && endedJob(ended));
    // Snapshot fetched before completion, answered after the terminal event.
    const changes = store.applyList({ revision: 5, jobs: [job({ revision: 5, percent: 60 })] });
    assert.deepEqual(changes, []);
    assert.equal(store.get('job-1')?.status, 'succeeded');
    assert.equal(store.activeForPath('/rec/Untitled_Meeting_x.webm'), undefined);
  });

  it('drops events older than what it holds and ignores evicted jobs', () => {
    const store = new TranscriptionJobStore();
    store.applyEvent(job({ revision: 4, percent: 50 }));
    assert.equal(store.applyEvent(job({ revision: 2, percent: 10 })), null);
    assert.equal(store.get('job-1')?.percent, 50);

    // A snapshot at revision 9 without job-1: it finished and was evicted.
    store.applyEvent(job({ revision: 6, status: 'failed' }));
    store.applyList({ revision: 9, jobs: [] });
    assert.equal(store.get('job-1'), undefined);
    // A straggling event from before that snapshot cannot re-add it.
    assert.equal(store.applyEvent(job({ revision: 8, status: 'failed' })), null);
    assert.equal(store.get('job-1'), undefined);
  });

  it('restores a running job from a snapshot after reload and follows newer events', () => {
    const store = new TranscriptionJobStore();
    const [change] = store.applyList({ revision: 12, jobs: [job({ revision: 12, percent: 25 })] });
    assert.equal(change.previous, undefined);
    assert.equal(endedJob(change), false);
    assert.equal(store.activeForPath('/rec/Untitled_Meeting_x.webm')?.percent, 25);
    const renamed = '/rec/Weekly_Sync_x.webm';
    store.applyEvent(job({ revision: 13, paths: ['/rec/Untitled_Meeting_x.webm', renamed] }));
    assert.equal(store.activeForPath(renamed)?.id, 'job-1');
    const done = store.applyEvent(job({ revision: 14, status: 'cancelled' }));
    assert.ok(done && endedJob(done));
  });

  it('keeps a running job a snapshot predates instead of dropping it', () => {
    const store = new TranscriptionJobStore();
    store.applyEvent(job({ id: 'job-2', revision: 20 }));
    store.applyList({ revision: 19, jobs: [] });
    assert.equal(store.activeOfKind('transcribe')?.id, 'job-2');
  });

  it('separates merge jobs from recording rows', () => {
    const store = new TranscriptionJobStore();
    store.applyEvent(job({ id: 'merge-1', kind: 'merge', paths: [], filePath: '' }));
    assert.equal(store.activeForPath('/rec/Untitled_Meeting_x.webm'), undefined);
    assert.equal(store.activeOfKind('merge')?.id, 'merge-1');
  });
});

describe('TranscriptionJobStore alias matching and retention', () => {
  it('matches a row through the canonical aliases main lists, not only requested paths', () => {
    const store = new TranscriptionJobStore();
    // Started through a symlinked directory; main lists the real path too.
    store.applyEvent(
      job({
        revision: 2,
        filePath: '/data/alias/Rec_x.wav',
        paths: ['/data/alias/Rec_x.wav'],
        aliases: ['/data/alias/Rec_x.wav', '/private/data/recordings/Rec_x.wav'],
      }),
    );
    // The canonical row: its own path differs, one of its aliases matches.
    assert.equal(store.activeForPath('/data/recordings/Rec_x.wav'), undefined);
    assert.equal(
      store.activeForPath(['/data/recordings/Rec_x.wav', '/private/data/recordings/Rec_x.wav'])?.id,
      'job-1',
    );
  });

  it('keeps a bounded finished history and never revives an evicted job from a stale copy', () => {
    const store = new TranscriptionJobStore(20);
    for (let i = 0; i < 25; i++) {
      store.applyEvent(job({ id: `job-${i}`, revision: i * 2 + 1 }));
      store.applyEvent(job({ id: `job-${i}`, revision: i * 2 + 2, status: 'succeeded' }));
    }
    assert.equal(store.all().length, 20);
    assert.equal(store.get('job-0'), undefined);
    assert.ok(store.get('job-24'));
    // A straggling running copy of an evicted job, by event or snapshot.
    assert.equal(store.applyEvent(job({ id: 'job-0', revision: 1 })), null);
    assert.deepEqual(
      store.applyList({ revision: 50, jobs: [job({ id: 'job-1', revision: 3 })] }),
      [],
    );
    assert.equal(store.activeOfKind('transcribe'), undefined);
    // Running jobs are never evicted, and new jobs still arrive.
    const fresh = store.applyEvent(job({ id: 'job-new', revision: 60 }));
    assert.ok(fresh);
    assert.equal(store.activeOfKind('transcribe')?.id, 'job-new');
  });

  it('rejects stragglers below the revision floor once evicted ids roll off', () => {
    const store = new TranscriptionJobStore(0);
    store.applyList({ revision: 0, jobs: [] });
    for (let i = 0; i < 205; i++) {
      store.applyEvent(job({ id: `old-${i}`, revision: i + 1, status: 'failed' }));
    }
    // old-0's id rolled off the bounded tombstones; the floor still holds.
    assert.equal(store.applyEvent(job({ id: 'old-0', revision: 1 })), null);
    assert.ok(store.applyEvent(job({ id: 'next', revision: 300 })));
  });
});

describe('TranscriptionJobStore before its load snapshot', () => {
  it('keeps every tombstone until the snapshot arrives, so a late snapshot cannot revive a finished job', () => {
    const store = new TranscriptionJobStore(0);
    store.applyEvent(job({ id: 'victim', revision: 2 }));
    store.applyEvent(job({ id: 'victim', revision: 3, status: 'succeeded' }));
    for (let i = 0; i < 225; i++) {
      store.applyEvent(job({ id: `done-${i}`, revision: 10 + i, status: 'failed' }));
    }
    // Snapshot taken at revision 2 (victim still running), delivered last; it
    // also lists an idle long-running job the store never saw an event for.
    const changes = store.applyList({
      revision: 2,
      jobs: [job({ id: 'victim', revision: 2 }), job({ id: 'idle', revision: 1 })],
    });
    assert.deepEqual(
      changes.map((c) => c.job.id),
      ['idle'],
    );
    assert.equal(store.get('victim'), undefined);
    assert.equal(store.activeOfKind('transcribe')?.id, 'idle');
  });

  it('bounds its tombstones once the snapshot is settled, also when the request failed', () => {
    const store = new TranscriptionJobStore(0);
    store.applyEvent(job({ id: 'first', revision: 1, status: 'failed' }));
    for (let i = 0; i < 250; i++) {
      store.applyEvent(job({ id: `done-${i}`, revision: 10 + i, status: 'failed' }));
    }
    store.markSnapshotSettled();
    // `first` rolled off the tombstones; the floor still rejects it.
    assert.equal(store.applyEvent(job({ id: 'first', revision: 1 })), null);
    assert.ok(store.applyEvent(job({ id: 'next', revision: 400 })));
  });
});

describe('describeAutoExports', () => {
  it('reports each destination outcome, including partial failures', () => {
    assert.equal(
      describeAutoExports({ notion: { status: 'succeeded' }, slack: { status: 'succeeded' } }),
      'Auto mode: Sent to Notion and Slack.',
    );
    assert.equal(
      describeAutoExports({ notion: { status: 'failed' }, slack: { status: 'succeeded' } }),
      'Auto mode: Sent to Slack (Notion failed).',
    );
    assert.equal(
      describeAutoExports({ slack: { status: 'failed' } }),
      'Auto mode: Failed to send to Slack',
    );
    assert.equal(
      describeAutoExports({ notion: { status: 'failed' } }),
      'Auto mode: Failed to upload to Notion',
    );
    assert.equal(
      describeAutoExports({}),
      'Auto mode: Transcription complete (Notion/Slack not configured)',
    );
  });
});
