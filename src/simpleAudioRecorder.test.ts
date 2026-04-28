import * as fs from 'fs';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as os from 'os';
import * as path from 'path';
import { SimpleAudioRecorder } from './simpleAudioRecorder';

let tmpDir: string;
let recorder: SimpleAudioRecorder;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-test-'));
  recorder = new SimpleAudioRecorder(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('SimpleAudioRecorder', () => {
  it('writes appended chunks to disk and reports accurate byte count', async () => {
    const start = await recorder.startRecording('Test Meeting', 'audio/webm');
    assert.equal(start.success, true);

    recorder.appendChunk(Buffer.from([1, 2, 3, 4]));
    recorder.appendChunk(Buffer.from([5, 6, 7, 8]));
    recorder.appendChunk(Buffer.from([9, 10]));

    const stop = await recorder.stopRecording();
    assert.equal(stop.success, true, `expected success, got ${stop.error ?? stop.reason}`);
    assert.equal(stop.bytesWritten, 10);
    assert.ok(stop.filePath);

    // Regression guard: the counter must include writes that landed during the
    // stop's `await writeChain`. Snapshotting too early would return 0.
    const onDisk = fs.readFileSync(stop.filePath!);
    assert.equal(onDisk.length, 10);
    assert.deepEqual(Array.from(onDisk), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('returns reason="empty" and deletes the file when no chunks were appended', async () => {
    const start = await recorder.startRecording('Empty', 'audio/webm');
    assert.equal(start.success, true);
    const filePath = start.filePath!;
    assert.ok(fs.existsSync(filePath));

    const stop = await recorder.stopRecording();
    assert.equal(stop.success, false);
    assert.equal(stop.reason, 'empty');
    assert.equal(fs.existsSync(filePath), false);
  });

  it('replays the finalized result on a second stopRecording call (grace-timer race)', async () => {
    await recorder.startRecording('Race', 'audio/webm');
    recorder.appendChunk(Buffer.from([0xff, 0xee]));

    const first = await recorder.stopRecording();
    assert.equal(first.success, true);
    assert.equal(first.bytesWritten, 2);

    // A late caller (e.g. renderer's IPC stop after grace timer already finalized)
    // must see the saved path, not a spurious "No recording in progress" error.
    const second = await recorder.stopRecording();
    assert.equal(second.success, true);
    assert.equal(second.filePath, first.filePath);
    assert.equal(second.bytesWritten, first.bytesWritten);
  });

  it('rejects concurrent startRecording calls (race guard)', async () => {
    const [first, second] = await Promise.all([
      recorder.startRecording('A', 'audio/webm'),
      recorder.startRecording('B', 'audio/webm'),
    ]);
    // Exactly one must succeed; the other hits the recordingActive guard.
    const successes = [first, second].filter((r) => r.success).length;
    assert.equal(successes, 1);
  });

  it('discards the in-progress file on abort', async () => {
    const start = await recorder.startRecording('Abort', 'audio/webm');
    recorder.appendChunk(Buffer.from([1, 2, 3]));
    await recorder.abortRecording();
    assert.equal(fs.existsSync(start.filePath!), false);
    assert.equal(recorder.isRecording(), false);
  });

  it('uses the mime type to pick an extension', async () => {
    const ogg = await recorder.startRecording('Oggy', 'audio/ogg;codecs=opus');
    assert.ok(ogg.filePath!.endsWith('.ogg'));
    await recorder.abortRecording();

    const webm = await recorder.startRecording('Webby', 'audio/webm;codecs=opus');
    assert.ok(webm.filePath!.endsWith('.webm'));
    await recorder.abortRecording();
  });
});
