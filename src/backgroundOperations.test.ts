import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BackgroundOperations, type BackgroundOperationChange } from './backgroundOperations';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('concurrent duplicates share one result and one underlying invocation', async () => {
  const operations = new BackgroundOperations();
  const task = deferred<{ success: true; url: string }>();
  let calls = 0;
  const first = operations.run('notion-upload', 'meeting-a', () => {
    calls++;
    return task.promise;
  });
  const second = operations.run('notion-upload', 'meeting-a', () => {
    throw new Error('A duplicate task must never run.');
  });
  assert.equal(first, second);
  assert.equal(operations.snapshot().operations[0].status, 'running');
  await Promise.resolve();
  assert.equal(calls, 1);
  const result = { success: true as const, url: 'https://example.test/private-result' };
  task.resolve(result);
  assert.equal(await first, result);
  assert.equal(await second, result);
  assert.equal(operations.snapshot().operations[0].status, 'succeeded');
  assert.ok(!JSON.stringify(operations.snapshot()).includes(result.url));
});

test('both start observers and synchronous task reentry join the reserved promise', async () => {
  const operations = new BackgroundOperations();
  let observerJoined: Promise<number> | undefined;
  let taskJoined: Promise<number> | undefined;
  operations.onChange(({ operation }) => {
    if (operation.status === 'running') {
      observerJoined = operations.run('restore', 'meeting-a', () => -1);
    }
  });
  const first = operations.run('restore', 'meeting-a', () => {
    taskJoined = operations.run('restore', 'meeting-a', () => -2);
    return 42;
  });
  assert.equal(observerJoined, first);
  assert.equal(await first, 42);
  assert.equal(taskJoined, first);
  assert.equal(operations.snapshot().operations.length, 1);
});

test('synchronous throws and asynchronous rejections fail and allow a fresh retry', async () => {
  const operations = new BackgroundOperations();
  const syncError = new Error('private synchronous error');
  await assert.rejects(
    operations.run('restore', 'meeting-a', () => {
      throw syncError;
    }),
    (error) => error === syncError,
  );
  const firstId = operations.snapshot().operations[0].id;
  const asyncError = new Error('private asynchronous error');
  const retry = operations.run('restore', 'meeting-a', async () => {
    throw asyncError;
  });
  assert.equal(operations.snapshot().operations.length, 2);
  await assert.rejects(retry, (error) => error === asyncError);
  assert.ok(operations.snapshot().operations.every((operation) => operation.status === 'failed'));
  assert.equal(await operations.run('restore', 'meeting-a', () => 'restored'), 'restored');
  const last = operations.snapshot().operations.at(-1)!;
  assert.notEqual(last.id, firstId);
  assert.equal(last.status, 'succeeded');
  assert.ok(!JSON.stringify(operations.snapshot()).includes('private'));
});

test('failed result envelopes retain the original result and classify state correctly', async () => {
  const operations = new BackgroundOperations();
  const result = { success: false, error: 'private provider detail' };
  assert.equal(await operations.run('slack-send', 'meeting-a', () => result), result);
  assert.equal(operations.snapshot().operations[0].status, 'failed');
  assert.ok(!JSON.stringify(operations.snapshot()).includes(result.error));
  assert.equal(
    await operations
      .run('slack-send', 'meeting-a', () => ({ success: true }))
      .then((r) => r.success),
    true,
  );
  assert.equal(operations.snapshot().operations.at(-1)!.status, 'succeeded');
});

test('a custom failure classifier supports existing non-success result envelopes', async () => {
  const operations = new BackgroundOperations();
  const result = { removed: 2, failures: ['private recording name'] };
  assert.equal(
    await operations.run(
      'storage-free',
      'selected-meetings',
      () => result,
      (value) => value.failures.length > 0,
    ),
    result,
  );
  assert.equal(operations.snapshot().operations[0].status, 'failed');
  const error = new Error('classifier failure');
  await assert.rejects(
    operations.run(
      'storage-free',
      'selected-meetings',
      () => result,
      () => {
        throw error;
      },
    ),
    (value) => value === error,
  );
  assert.equal(operations.snapshot().operations.at(-1)!.status, 'failed');
});

test('different kinds and targets do not join, including delimiter-shaped names', async () => {
  const operations = new BackgroundOperations();
  const pending = deferred<number>();
  const promises = [
    operations.run('notion-upload', 'meeting-a', () => pending.promise),
    operations.run('slack-send', 'meeting-a', () => pending.promise),
    operations.run('notion-upload', 'meeting-b', () => pending.promise),
    operations.run('a:b', 'c', () => pending.promise),
    operations.run('a', 'b:c', () => pending.promise),
  ];
  assert.equal(new Set(promises).size, 5);
  assert.equal(operations.snapshot().operations.length, 5);
  pending.resolve(1);
  assert.deepEqual(await Promise.all(promises), [1, 1, 1, 1, 1]);
});

test('revisioned changes support reattach and are isolated from observer mutation or throws', async () => {
  const operations = new BackgroundOperations();
  const changes: BackgroundOperationChange[] = [];
  const stopFaulty = operations.onChange((change) => {
    change.operation.kind = 'corrupted';
    change.removedIds.push('invented');
    throw new Error('disconnected renderer');
  });
  const unsubscribe = operations.onChange((change) => changes.push(change));
  const pending = deferred<string>();
  const promise = operations.run('restore', 'meeting-a', () => pending.promise);
  const reattached = operations.snapshot();
  assert.equal(reattached.revision, 1);
  reattached.operations[0].kind = 'also corrupted';
  assert.equal(operations.snapshot().operations[0].kind, 'restore');
  pending.resolve('ready');
  await promise;
  assert.deepEqual(
    changes.map((change) => change.revision),
    [1, 2],
  );
  assert.equal(changes[0].operation.id, changes[1].operation.id);
  assert.deepEqual(
    changes.map((change) => change.operation.status),
    ['running', 'succeeded'],
  );
  assert.equal(changes[0].operation.kind, 'restore');
  assert.deepEqual(changes[1].removedIds, []);
  assert.ok(changes[1].operation.finishedAt);
  assert.equal(operations.snapshot().revision, 2);
  stopFaulty();
  unsubscribe();
  await operations.run('restore', 'meeting-b', () => 'ready');
  assert.equal(changes.length, 2);
});

test('reentrant observers never deliver a newer event before an older event', async () => {
  const operations = new BackgroundOperations();
  let nested: Promise<number> | undefined;
  operations.onChange(({ operation }) => {
    if (operation.target === 'first' && operation.status === 'running') {
      nested = operations.run('restore', 'second', () => 2);
    }
  });
  const seen: number[] = [];
  operations.onChange(({ revision }) => seen.push(revision));
  const first = operations.run('restore', 'first', () => 1);
  assert.deepEqual(seen, [1, 2]);
  await Promise.all([first, nested]);
  assert.deepEqual(seen, [1, 2, 3, 4]);
});

test('finished retention is bounded without evicting any running operation', async () => {
  const operations = new BackgroundOperations({ maxFinished: 2 });
  const active = Array.from({ length: 25 }, () => deferred<number>());
  const running = active.map((pending, index) =>
    operations.run('restore', String(index), () => pending.promise),
  );
  const ids = operations.snapshot().operations.map((operation) => operation.id);
  const removals: string[] = [];
  operations.onChange(({ removedIds }) => removals.push(...removedIds));
  for (let index = 0; index < 5; index++) {
    await operations.run('slack-send', String(index), () => index);
  }
  let snapshot = operations.snapshot();
  assert.equal(
    snapshot.operations.filter((operation) => operation.status === 'running').length,
    25,
  );
  assert.equal(snapshot.operations.length, 27);
  assert.ok(ids.every((id) => snapshot.operations.some((operation) => operation.id === id)));
  assert.equal(removals.length, 3);
  for (const pending of active) pending.resolve(1);
  await Promise.all(running);
  snapshot = operations.snapshot();
  assert.equal(snapshot.operations.length, 2);
  assert.ok(snapshot.operations.every((operation) => operation.status === 'succeeded'));
  assert.equal(removals.length, 28);
});

test('zero retention still emits terminal state and explicit eviction', async () => {
  const operations = new BackgroundOperations({ maxFinished: 0 });
  const changes: BackgroundOperationChange[] = [];
  operations.onChange((change) => changes.push(change));
  await operations.run('restore', 'meeting-a', () => 1);
  assert.equal(operations.snapshot().operations.length, 0);
  assert.equal(changes[1].operation.status, 'succeeded');
  assert.deepEqual(changes[1].removedIds, [changes[1].operation.id]);
});

test('invalid retention bounds fail immediately', () => {
  for (const maxFinished of [-1, 0.5, NaN, Infinity]) {
    assert.throws(() => new BackgroundOperations({ maxFinished }), RangeError);
  }
});
