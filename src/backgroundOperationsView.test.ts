import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BackgroundOperationsView } from './backgroundOperationsView';
import type { BackgroundOperationSnapshot } from './electronApiTypes';

const op = (
  id: string,
  revision: number,
  status: BackgroundOperationSnapshot['status'] = 'running',
): BackgroundOperationSnapshot => ({
  id,
  kind: 'notion-upload',
  target: `/notes/${id}`,
  status,
  revision,
  startedAt: '2026-11-13T00:00:00.000Z',
});

test('a snapshot read before an eviction arrived does not resurrect the evicted record', () => {
  const view = new BackgroundOperationsView();
  // Stale snapshot (read earlier, delivered late) still lists `a` as running.
  const stale = { revision: 1, operations: [op('a', 1)] };
  view.applyChange({ revision: 2, operation: op('a', 2, 'succeeded'), removedIds: [] });
  view.applyChange({ revision: 3, operation: op('b', 3), removedIds: ['a'] });
  view.applySnapshot(stale);
  assert.equal(stale.revision, 1);
  assert.equal(view.isRunning('notion-upload', '/notes/a'), false);
  assert.equal(view.isRunning('notion-upload', '/notes/b'), true);
});

test('a snapshot keeps the newer copy of each record and skips older events afterwards', () => {
  const view = new BackgroundOperationsView();
  view.applyChange({ revision: 2, operation: op('a', 2, 'succeeded'), removedIds: [] });
  assert.deepEqual(view.applySnapshot({ revision: 2, operations: [op('a', 1), op('c', 1)] }), [
    op('c', 1),
  ]);
  assert.equal(view.isRunning('notion-upload', '/notes/a'), false, 'the finished event wins');
  assert.equal(view.isRunning('notion-upload', '/notes/c'), true, 'started before subscribing');
  assert.equal(view.applyChange({ revision: 2, operation: op('c', 2), removedIds: [] }), null);
});
