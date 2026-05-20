// Covers Phase 3A sync engine: change detection via mtime, idempotent re-runs,
// state persistence across cycles, atomic state writes, and graceful error
// recovery (one bad meeting doesn't block others). Drive client is a mock that
// records calls -- googleDriveService.test.ts already covers the real Drive
// query/upload shape.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as fs from 'fs';
import * as path from 'path';
import { makeTempDir, rmDir } from '../test-helpers';
import type { DriveFile, GoogleDriveClient } from './googleDriveService';
import { SyncEngine, type SyncState } from './syncEngine';

type UploadCall = {
  name: string;
  parentId: string;
  content: Buffer | Uint8Array | string;
  mimeType: string;
};

type EnsureFolderCall = { name: string; parentId?: string };

class MockDriveClient {
  uploads: UploadCall[] = [];
  ensureFolderCalls: EnsureFolderCall[] = [];
  private folderIdCounter = 0;
  private fileIdCounter = 0;
  // (name, parentId) -> id for ensureFolder idempotency
  private folderIds = new Map<string, string>();
  // (name, parentId) -> id for uploadFile idempotency
  private fileIds = new Map<string, string>();
  // Inject a per-call failure to test error paths.
  failNextUpload?: (call: UploadCall) => Error | undefined;

  asDriveClient(): GoogleDriveClient {
    return this as unknown as GoogleDriveClient;
  }

  async ensureFolder(name: string, parentId?: string): Promise<DriveFile> {
    this.ensureFolderCalls.push({ name, parentId });
    const key = `${parentId ?? '__root__'}::${name}`;
    let id = this.folderIds.get(key);
    if (!id) {
      id = `folder-${++this.folderIdCounter}`;
      this.folderIds.set(key, id);
    }
    return {
      id,
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: parentId ? [parentId] : undefined,
    };
  }

  async uploadFile(params: UploadCall): Promise<DriveFile> {
    if (this.failNextUpload) {
      const err = this.failNextUpload(params);
      this.failNextUpload = undefined;
      if (err) throw err;
    }
    this.uploads.push(params);
    const key = `${params.parentId}::${params.name}`;
    let id = this.fileIds.get(key);
    if (!id) {
      id = `file-${++this.fileIdCounter}`;
      this.fileIds.set(key, id);
    }
    return {
      id,
      name: params.name,
      mimeType: params.mimeType,
      parents: [params.parentId],
    };
  }
}

let workDir: string;
let transcriptionsDir: string;
let syncStatePath: string;
let mockClient: MockDriveClient;

function makeMeeting(name: string, files: Record<string, string>): string {
  const dir = path.join(transcriptionsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [filename, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, filename), content);
  }
  return dir;
}

function touchFile(filePath: string, mtimeMs: number): void {
  const ts = new Date(mtimeMs);
  fs.utimesSync(filePath, ts, ts);
}

beforeEach(() => {
  workDir = makeTempDir('sync-engine');
  transcriptionsDir = path.join(workDir, 'transcriptions');
  syncStatePath = path.join(workDir, 'sync-state.json');
  fs.mkdirSync(transcriptionsDir, { recursive: true });
  mockClient = new MockDriveClient();
});

afterEach(() => {
  rmDir(workDir);
});

function makeEngine() {
  return new SyncEngine({
    driveClient: mockClient.asDriveClient(),
    transcriptionsDir,
    syncStatePath,
  });
}

describe('SyncEngine: first sync', () => {
  it('creates app folder + meeting folder + uploads all files', async () => {
    makeMeeting('meeting-1', {
      'summary.md': '# Summary',
      'transcript.md': 'Full transcript text',
    });

    const engine = makeEngine();
    const result = await engine.syncOnce();

    assert.deepEqual(result.uploaded.sort(), [
      'meeting-1/summary.md',
      'meeting-1/transcript.md',
    ]);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.errors, []);
    assert.equal(mockClient.uploads.length, 2);

    // ensureFolder called once for app folder + once for the meeting
    assert.deepEqual(
      mockClient.ensureFolderCalls.map((c) => c.name),
      ['Listener.AI', 'meeting-1'],
    );
  });

  it('persists state to disk after first sync', async () => {
    makeMeeting('m1', { 'summary.md': 'x' });
    await makeEngine().syncOnce();

    const raw = fs.readFileSync(syncStatePath, 'utf-8');
    const state = JSON.parse(raw) as SyncState;
    assert.equal(state.version, 1);
    assert.ok(state.appFolderId);
    assert.ok(state.meetings['m1']);
    assert.ok(state.meetings['m1'].files['summary.md'].driveFileId);
    assert.ok(state.meetings['m1'].files['summary.md'].localMtimeMs > 0);
  });

  it('skips hidden files like .DS_Store', async () => {
    makeMeeting('m1', { 'summary.md': 's', '.DS_Store': 'noise' });

    const result = await makeEngine().syncOnce();
    assert.deepEqual(result.uploaded, ['m1/summary.md']);
    assert.equal(mockClient.uploads.length, 1);
  });
});

describe('SyncEngine: idempotency', () => {
  it('second sync skips all files when nothing changed', async () => {
    makeMeeting('m1', { 'summary.md': 's', 'transcript.md': 't' });

    await makeEngine().syncOnce();
    mockClient.uploads = []; // reset call log

    const result = await makeEngine().syncOnce();
    assert.deepEqual(result.uploaded, []);
    assert.deepEqual(result.skipped.sort(), [
      'm1/summary.md',
      'm1/transcript.md',
    ]);
    assert.equal(mockClient.uploads.length, 0, 'no Drive upload calls on no-op sync');
  });

  it('uploads only the changed file on second sync', async () => {
    makeMeeting('m1', { 'summary.md': 's', 'transcript.md': 't' });
    await makeEngine().syncOnce();
    mockClient.uploads = [];

    // Modify summary.md (write new content + touch newer mtime)
    const summaryPath = path.join(transcriptionsDir, 'm1', 'summary.md');
    fs.writeFileSync(summaryPath, 's updated');
    touchFile(summaryPath, Date.now() + 5000);

    const result = await makeEngine().syncOnce();
    assert.deepEqual(result.uploaded, ['m1/summary.md']);
    assert.deepEqual(result.skipped, ['m1/transcript.md']);
    assert.equal(mockClient.uploads.length, 1);
    assert.equal(mockClient.uploads[0].name, 'summary.md');
  });

  it('syncs a new meeting added between runs', async () => {
    makeMeeting('m1', { 'summary.md': 's' });
    await makeEngine().syncOnce();
    mockClient.uploads = [];

    makeMeeting('m2', { 'summary.md': 's2' });

    const result = await makeEngine().syncOnce();
    assert.deepEqual(result.uploaded, ['m2/summary.md']);
    assert.equal(mockClient.uploads.length, 1);
  });
});

describe('SyncEngine: state persistence', () => {
  it('reuses appFolderId across syncs (no recreate)', async () => {
    makeMeeting('m1', { 'summary.md': 's' });
    await makeEngine().syncOnce();
    const firstEnsureCount = mockClient.ensureFolderCalls.length;

    // No changes; second sync shouldn't ensureFolder again
    mockClient.ensureFolderCalls = [];
    await makeEngine().syncOnce();
    assert.equal(
      mockClient.ensureFolderCalls.length,
      0,
      'app folder + meeting folder should be cached in sync state',
    );
    assert.equal(firstEnsureCount, 2);
  });

  it('starts fresh when state file is corrupt', async () => {
    fs.writeFileSync(syncStatePath, '{ not valid json');
    makeMeeting('m1', { 'summary.md': 's' });

    const result = await makeEngine().syncOnce();
    assert.deepEqual(result.uploaded, ['m1/summary.md']);
  });

  it('starts fresh when state file has unknown version', async () => {
    fs.writeFileSync(
      syncStatePath,
      JSON.stringify({ version: 999, meetings: {} }),
    );
    makeMeeting('m1', { 'summary.md': 's' });

    const result = await makeEngine().syncOnce();
    assert.deepEqual(result.uploaded, ['m1/summary.md']);
    const state = JSON.parse(fs.readFileSync(syncStatePath, 'utf-8')) as SyncState;
    assert.equal(state.version, 1);
  });

  it('writes state atomically (rename pattern)', async () => {
    makeMeeting('m1', { 'summary.md': 's' });
    await makeEngine().syncOnce();

    // No leftover .tmp file
    const tmpFiles = fs
      .readdirSync(workDir)
      .filter((n) => n.startsWith(path.basename(syncStatePath)) && n.includes('.tmp'));
    assert.deepEqual(tmpFiles, []);
  });
});

describe('SyncEngine: error recovery', () => {
  it('records error and continues with next meeting when one upload fails', async () => {
    makeMeeting('bad', { 'summary.md': 's' });
    makeMeeting('good', { 'summary.md': 's' });

    mockClient.failNextUpload = (call) =>
      call.name === 'summary.md' && call.parentId.includes('folder-2')
        ? new Error('drive 500')
        : undefined;

    const result = await makeEngine().syncOnce();
    // The "bad" meeting fails its only file; "good" meeting succeeds.
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].error, /drive 500/);
    // good still got uploaded
    assert.ok(result.uploaded.some((u) => u.startsWith('good/')));
  });

  it('re-uploads on next sync after a failed upload (no state poisoning)', async () => {
    makeMeeting('m1', { 'summary.md': 's' });
    mockClient.failNextUpload = () => new Error('transient');

    const first = await makeEngine().syncOnce();
    assert.equal(first.errors.length, 1);
    assert.deepEqual(first.uploaded, []);

    // Next sync: no failure injected, should retry
    const second = await makeEngine().syncOnce();
    assert.deepEqual(second.uploaded, ['m1/summary.md']);
  });
});

describe('SyncEngine: empty cases', () => {
  it('returns empty result when no meetings exist', async () => {
    const result = await makeEngine().syncOnce();
    assert.deepEqual(result.uploaded, []);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.errors, []);
    // app folder still ensured eagerly
    assert.equal(mockClient.ensureFolderCalls.length, 1);
  });

  it('handles missing transcriptions directory gracefully', async () => {
    rmDir(transcriptionsDir);
    const result = await makeEngine().syncOnce();
    assert.deepEqual(result.uploaded, []);
    assert.deepEqual(result.errors, []);
  });
});
