import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { it } from 'node:test';
import * as path from 'node:path';
import * as os from 'node:os';
import { withMeetingLock } from './meetingLock';

it('waits for a meeting reader before replacing that meeting', async () => {
  let releaseRead!: () => void;
  let signalReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    signalReady = resolve;
  });
  const read = withMeetingLock(
    '/tmp/meeting-lock-test/note-a',
    () =>
      new Promise<void>((resolve) => {
        releaseRead = resolve;
        signalReady();
      }),
  );
  await ready;

  let replaced = false;
  const write = withMeetingLock('/tmp/meeting-lock-test/note-a', () => {
    replaced = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(replaced, false);

  releaseRead();
  await Promise.all([read, write]);
  assert.equal(replaced, true);
});

it('waits for a note lock held by another process', async () => {
  const folder = path.join(os.tmpdir(), `meeting-lock-${process.pid}-${Date.now()}`, 'note');
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const {withMeetingLock}=require(${JSON.stringify(require.resolve('./meetingLock'))});` +
        `withMeetingLock(${JSON.stringify(folder)}, async () => {` +
        `process.stdout.write('locked\\n'); await new Promise(r => process.stdin.once('data', r));` +
        `});`,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', (data: Buffer) => {
        if (data.toString().includes('locked')) resolve();
        else reject(new Error(`Unexpected child output: ${data}`));
      });
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`Lock child exited ${code}`)));
    });

    let acquired = false;
    const waiting = withMeetingLock(folder, () => {
      acquired = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    assert.equal(acquired, false);
    child.stdin.write('release\n');
    await waiting;
    assert.equal(acquired, true);
  } finally {
    child.stdin.end();
    child.kill();
  }
});

it('stops waiting when a transcription is cancelled', async () => {
  const folder = path.join(os.tmpdir(), `meeting-lock-cancel-${process.pid}`, 'note');
  let release!: () => void;
  let ready!: () => void;
  const acquired = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const held = withMeetingLock(
    folder,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
        ready();
      }),
  );
  await acquired;
  try {
    const controller = new AbortController();
    const waiting = withMeetingLock(folder, () => {}, { signal: controller.signal });
    controller.abort();
    await assert.rejects(waiting, /abort/i);
  } finally {
    release();
    await held;
  }
});
