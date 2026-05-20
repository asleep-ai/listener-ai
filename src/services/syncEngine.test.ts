// Phase 3A+3B sync engine: change detection via mtime, bidirectional sync,
// conflict resolution (LWW + .listener-conflicts/ backup), audio cloud-only
// policy. Drive client is a mock that records calls -- the real Drive query
// and multipart upload shapes are covered by googleDriveService.test.ts.

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

type RemoteFile = DriveFile & { content?: Buffer };

class MockDriveClient {
  uploads: UploadCall[] = [];
  ensureFolderCalls: Array<{ name: string; parentId?: string }> = [];
  downloadCalls: string[] = [];
  trashCalls: string[] = [];
  deleteCalls: string[] = [];
  // Simulated Drive content keyed by folder id.
  // Top-level "app folder" id is "app-1" by default; meeting folders are
  // children of that. Tests pre-seed this map to simulate remote-only data.
  folderContents = new Map<string, RemoteFile[]>();
  // file id -> content for downloadFile
  fileContents = new Map<string, Buffer>();

  private folderIdCounter = 0;
  private fileIdCounter = 0;
  private folderIds = new Map<string, string>();
  private fileIds = new Map<string, string>();
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
      // Newly created folders are empty until something is uploaded into them.
      if (!this.folderContents.has(id)) this.folderContents.set(id, []);
      // Add to parent's listing so listFolder reflects this folder.
      if (parentId) {
        const siblings = this.folderContents.get(parentId) ?? [];
        if (!siblings.find((f) => f.name === name)) {
          siblings.push({
            id,
            name,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [parentId],
          });
          this.folderContents.set(parentId, siblings);
        }
      }
    }
    return {
      id,
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: parentId ? [parentId] : undefined,
    };
  }

  async listFolder(folderId: string): Promise<DriveFile[]> {
    return (this.folderContents.get(folderId) ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      modifiedTime: f.modifiedTime,
      parents: f.parents,
    }));
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
    const isNew = !id;
    if (!id) {
      id = `file-${++this.fileIdCounter}`;
      this.fileIds.set(key, id);
    }
    const contentBuffer =
      typeof params.content === 'string'
        ? Buffer.from(params.content)
        : Buffer.isBuffer(params.content)
          ? params.content
          : Buffer.from(params.content);
    this.fileContents.set(id, contentBuffer);
    // Bump modifiedTime on every upload (Drive's behavior) so subsequent
    // syncs can detect "remote changed since prior".
    const modifiedTime = new Date().toISOString();
    const file: RemoteFile = {
      id,
      name: params.name,
      mimeType: params.mimeType,
      modifiedTime,
      parents: [params.parentId],
    };
    const siblings = this.folderContents.get(params.parentId) ?? [];
    if (isNew) {
      siblings.push(file);
    } else {
      const idx = siblings.findIndex((f) => f.id === id);
      if (idx >= 0) siblings[idx] = file;
      else siblings.push(file);
    }
    this.folderContents.set(params.parentId, siblings);
    return file;
  }

  async downloadFile(fileId: string): Promise<Buffer> {
    this.downloadCalls.push(fileId);
    const content = this.fileContents.get(fileId);
    if (!content) throw new Error(`MockDriveClient: no content for ${fileId}`);
    return content;
  }

  async trashFile(fileId: string): Promise<void> {
    this.trashCalls.push(fileId);
    // Remove from any parent's listing so subsequent listFolder calls don't
    // see it (Drive's default filter excludes trashed entries).
    for (const [folderId, files] of this.folderContents) {
      const filtered = files.filter((f) => f.id !== fileId);
      if (filtered.length !== files.length) this.folderContents.set(folderId, filtered);
    }
  }

  async deleteFile(fileId: string): Promise<void> {
    this.deleteCalls.push(fileId);
    this.fileContents.delete(fileId);
    for (const [folderId, files] of this.folderContents) {
      const filtered = files.filter((f) => f.id !== fileId);
      if (filtered.length !== files.length) this.folderContents.set(folderId, filtered);
    }
  }

  // Test helper: pre-seed a remote meeting folder with files (as if another
  // device synced first). Returns the meeting folder id.
  seedRemoteMeeting(
    meetingName: string,
    appFolderId: string,
    files: Array<{ name: string; content: string | Buffer; modifiedTime?: string }>,
  ): string {
    const meetingId = `folder-${++this.folderIdCounter}`;
    this.folderIds.set(`${appFolderId}::${meetingName}`, meetingId);
    const meetingFile: RemoteFile = {
      id: meetingId,
      name: meetingName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [appFolderId],
    };
    const appSiblings = this.folderContents.get(appFolderId) ?? [];
    appSiblings.push(meetingFile);
    this.folderContents.set(appFolderId, appSiblings);

    const meetingSiblings: RemoteFile[] = [];
    for (const f of files) {
      const fileId = `file-${++this.fileIdCounter}`;
      const buf = typeof f.content === 'string' ? Buffer.from(f.content) : f.content;
      this.fileContents.set(fileId, buf);
      this.fileIds.set(`${meetingId}::${f.name}`, fileId);
      meetingSiblings.push({
        id: fileId,
        name: f.name,
        mimeType: 'text/markdown',
        modifiedTime: f.modifiedTime ?? new Date().toISOString(),
        parents: [meetingId],
      });
    }
    this.folderContents.set(meetingId, meetingSiblings);
    return meetingId;
  }

  // Test helper: mutate a remote file's content + modifiedTime (simulating
  // another device editing it after our prior sync).
  mutateRemoteFile(fileId: string, newContent: string | Buffer, modifiedTime: string): void {
    const buf = typeof newContent === 'string' ? Buffer.from(newContent) : newContent;
    this.fileContents.set(fileId, buf);
    for (const [folderId, files] of this.folderContents) {
      const idx = files.findIndex((f) => f.id === fileId);
      if (idx >= 0) {
        files[idx] = { ...files[idx], modifiedTime, parents: files[idx].parents };
        this.folderContents.set(folderId, files);
      }
    }
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

describe('SyncEngine: upload-only (Phase 3A)', () => {
  it('creates app folder + meeting folder + uploads all files on first sync', async () => {
    makeMeeting('meeting-1', {
      'summary.md': '# Summary',
      'transcript.md': 'Full transcript text',
    });

    const result = await makeEngine().syncOnce();

    assert.deepEqual(result.uploaded.sort(), [
      'meeting-1/summary.md',
      'meeting-1/transcript.md',
    ]);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.downloaded, []);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.errors, []);
  });

  it('persists state to disk after first sync', async () => {
    makeMeeting('m1', { 'summary.md': 'x' });
    await makeEngine().syncOnce();

    const state = JSON.parse(fs.readFileSync(syncStatePath, 'utf-8')) as SyncState;
    assert.equal(state.version, 1);
    assert.ok(state.appFolderId);
    assert.ok(state.meetings['m1']);
    assert.ok(state.meetings['m1'].files['summary.md'].driveFileId);
    assert.ok(state.meetings['m1'].files['summary.md'].driveModifiedTime);
  });

  it('skips hidden files like .DS_Store', async () => {
    makeMeeting('m1', { 'summary.md': 's', '.DS_Store': 'noise' });

    const result = await makeEngine().syncOnce();
    assert.deepEqual(result.uploaded, ['m1/summary.md']);
    assert.equal(mockClient.uploads.length, 1);
  });

  it('second sync skips all when nothing changed', async () => {
    makeMeeting('m1', { 'summary.md': 's', 'transcript.md': 't' });
    await makeEngine().syncOnce();
    mockClient.uploads = [];

    const result = await makeEngine().syncOnce();
    assert.deepEqual(result.uploaded, []);
    assert.deepEqual(result.skipped.sort(), ['m1/summary.md', 'm1/transcript.md']);
    assert.equal(mockClient.uploads.length, 0);
  });

  it('uploads only the changed file on second sync', async () => {
    makeMeeting('m1', { 'summary.md': 's', 'transcript.md': 't' });
    await makeEngine().syncOnce();
    mockClient.uploads = [];

    const summaryPath = path.join(transcriptionsDir, 'm1', 'summary.md');
    fs.writeFileSync(summaryPath, 's updated');
    touchFile(summaryPath, Date.now() + 5000);

    const result = await makeEngine().syncOnce();
    assert.deepEqual(result.uploaded, ['m1/summary.md']);
    assert.deepEqual(result.skipped, ['m1/transcript.md']);
  });
});

describe('SyncEngine: download path (Phase 3B)', () => {
  it('downloads a meeting that exists only on Drive', async () => {
    // Pre-create app folder, then seed a remote-only meeting in it.
    const appFolder = await mockClient.ensureFolder('Listener.AI');
    mockClient.seedRemoteMeeting('remote-meeting', appFolder.id, [
      { name: 'summary.md', content: '# from device 2' },
      { name: 'transcript.md', content: 'Transcript from device 2' },
    ]);

    const result = await makeEngine().syncOnce();

    assert.deepEqual(result.downloaded.sort(), [
      'remote-meeting/summary.md',
      'remote-meeting/transcript.md',
    ]);
    assert.deepEqual(result.uploaded, []);

    // Files materialized locally with correct content.
    const summary = fs.readFileSync(
      path.join(transcriptionsDir, 'remote-meeting', 'summary.md'),
      'utf-8',
    );
    assert.equal(summary, '# from device 2');
  });

  it('does not auto-download audio files (cloudOnly policy)', async () => {
    const appFolder = await mockClient.ensureFolder('Listener.AI');
    mockClient.seedRemoteMeeting('m-with-audio', appFolder.id, [
      { name: 'summary.md', content: 'text' },
      { name: 'recording.webm', content: Buffer.from([0x1a, 0x45]) },
    ]);

    const result = await makeEngine().syncOnce();

    assert.ok(result.downloaded.includes('m-with-audio/summary.md'));
    assert.ok(!result.downloaded.includes('m-with-audio/recording.webm'));

    // Audio is not on disk
    assert.equal(
      fs.existsSync(path.join(transcriptionsDir, 'm-with-audio', 'recording.webm')),
      false,
    );

    // But tracked in state as cloudOnly so Phase 3D can hydrate it later
    const state = JSON.parse(fs.readFileSync(syncStatePath, 'utf-8')) as SyncState;
    const audioEntry = state.meetings['m-with-audio'].files['recording.webm'];
    assert.ok(audioEntry);
    assert.equal(audioEntry.cloudOnly, true);
  });

  it('downloads remote changes when local file is unchanged', async () => {
    // Initial state: local + Drive in sync after first upload.
    makeMeeting('m1', { 'summary.md': 'v1' });
    await makeEngine().syncOnce();

    // Another device "edits" the remote summary.md without us touching local.
    const state = JSON.parse(fs.readFileSync(syncStatePath, 'utf-8')) as SyncState;
    const fileId = state.meetings['m1'].files['summary.md'].driveFileId;
    mockClient.mutateRemoteFile(fileId, 'v2 from other device', '2030-01-01T00:00:00.000Z');

    const result = await makeEngine().syncOnce();
    assert.deepEqual(result.downloaded, ['m1/summary.md']);
    assert.equal(
      fs.readFileSync(path.join(transcriptionsDir, 'm1', 'summary.md'), 'utf-8'),
      'v2 from other device',
    );
  });
});

describe('SyncEngine: conflict resolution (Phase 3B)', () => {
  it('LWW: local newer wins, remote backed up to .listener-conflicts/', async () => {
    makeMeeting('m1', { 'summary.md': 'original' });
    await makeEngine().syncOnce();
    const state1 = JSON.parse(fs.readFileSync(syncStatePath, 'utf-8')) as SyncState;
    const fileId = state1.meetings['m1'].files['summary.md'].driveFileId;

    // Remote edited at T (old)
    mockClient.mutateRemoteFile(fileId, 'remote edit', '2025-01-01T00:00:00.000Z');

    // Local edited later (newer)
    const localPath = path.join(transcriptionsDir, 'm1', 'summary.md');
    fs.writeFileSync(localPath, 'local edit (newer)');
    touchFile(localPath, Date.parse('2030-06-01T00:00:00.000Z'));

    const result = await makeEngine().syncOnce();
    assert.deepEqual(result.conflicts, ['m1/summary.md']);
    // Local wins -> uploaded to Drive
    assert.ok(result.uploaded.includes('m1/summary.md'));

    // Conflict backup exists for the losing remote version
    const conflictDir = path.join(workDir, '.listener-conflicts', 'm1');
    const backups = fs.readdirSync(conflictDir);
    const remoteBackup = backups.find((n) => n.startsWith('summary.md.remote.'));
    assert.ok(remoteBackup, 'expected remote conflict backup');
    assert.equal(
      fs.readFileSync(path.join(conflictDir, remoteBackup!), 'utf-8'),
      'remote edit',
    );
  });

  it('LWW: remote newer wins, local backed up', async () => {
    makeMeeting('m1', { 'summary.md': 'original' });
    await makeEngine().syncOnce();
    const state1 = JSON.parse(fs.readFileSync(syncStatePath, 'utf-8')) as SyncState;
    const fileId = state1.meetings['m1'].files['summary.md'].driveFileId;

    // Local edited at T (old)
    const localPath = path.join(transcriptionsDir, 'm1', 'summary.md');
    fs.writeFileSync(localPath, 'local edit (older)');
    touchFile(localPath, Date.parse('2025-01-01T00:00:00.000Z'));

    // Remote edited later (newer)
    mockClient.mutateRemoteFile(fileId, 'remote edit (newer)', '2030-06-01T00:00:00.000Z');

    const result = await makeEngine().syncOnce();
    assert.deepEqual(result.conflicts, ['m1/summary.md']);
    // Remote wins -> downloaded locally
    assert.ok(result.downloaded.includes('m1/summary.md'));
    assert.equal(
      fs.readFileSync(localPath, 'utf-8'),
      'remote edit (newer)',
    );

    // Conflict backup exists for the losing local version
    const conflictDir = path.join(workDir, '.listener-conflicts', 'm1');
    const backups = fs.readdirSync(conflictDir);
    const localBackup = backups.find((n) => n.startsWith('summary.md.local.'));
    assert.ok(localBackup, 'expected local conflict backup');
    assert.equal(
      fs.readFileSync(path.join(conflictDir, localBackup!), 'utf-8'),
      'local edit (older)',
    );
  });
});

describe('SyncEngine: state persistence', () => {
  it('reuses appFolderId across syncs (no recreate)', async () => {
    makeMeeting('m1', { 'summary.md': 's' });
    await makeEngine().syncOnce();
    const firstEnsureCount = mockClient.ensureFolderCalls.length;

    mockClient.ensureFolderCalls = [];
    await makeEngine().syncOnce();
    // No new ensureFolder calls needed -- app folder + tombstones folder +
    // meeting folder all cached in sync state.
    assert.equal(mockClient.ensureFolderCalls.length, 0);
    // First sync ensures: Listener.AI, .listener-tombstones, m1
    assert.equal(firstEnsureCount, 3);
  });

  it('starts fresh when state file is corrupt', async () => {
    fs.writeFileSync(syncStatePath, '{ not valid json');
    makeMeeting('m1', { 'summary.md': 's' });

    const result = await makeEngine().syncOnce();
    assert.deepEqual(result.uploaded, ['m1/summary.md']);
  });

  it('starts fresh when state file has unknown version', async () => {
    fs.writeFileSync(syncStatePath, JSON.stringify({ version: 999, meetings: {} }));
    makeMeeting('m1', { 'summary.md': 's' });

    const result = await makeEngine().syncOnce();
    assert.deepEqual(result.uploaded, ['m1/summary.md']);
    const state = JSON.parse(fs.readFileSync(syncStatePath, 'utf-8')) as SyncState;
    assert.equal(state.version, 1);
  });

  it('writes state atomically (rename pattern, no leftover .tmp)', async () => {
    makeMeeting('m1', { 'summary.md': 's' });
    await makeEngine().syncOnce();

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

    // Fail the first upload to the "bad" meeting folder. Folder ids are
    // assigned sequentially: Listener.AI=folder-1, .listener-tombstones=
    // folder-2, then meeting folders in sort order: bad=folder-3, good=
    // folder-4. We can't predict ids cleanly across engine refactors, so
    // match by filename + first-call instead.
    let failed = false;
    mockClient.failNextUpload = (call) => {
      if (call.name === 'summary.md' && !failed) {
        failed = true;
        return new Error('drive 500');
      }
      return undefined;
    };

    const result = await makeEngine().syncOnce();
    assert.ok(result.errors.length >= 1);
    // good's upload should still succeed
    assert.ok(result.uploaded.some((u) => u.startsWith('good/')));
  });

  it('re-uploads on next sync after a failed upload', async () => {
    makeMeeting('m1', { 'summary.md': 's' });
    mockClient.failNextUpload = () => new Error('transient');

    const first = await makeEngine().syncOnce();
    assert.equal(first.errors.length, 1);

    const second = await makeEngine().syncOnce();
    assert.deepEqual(second.uploaded, ['m1/summary.md']);
  });
});

describe('SyncEngine: deletions and tombstones (Phase 3C)', () => {
  it('local deletion uploads a tombstone and trashes the Drive folder', async () => {
    // First sync: meeting exists on both sides.
    makeMeeting('m1', { 'summary.md': 's' });
    await makeEngine().syncOnce();
    const state1 = JSON.parse(fs.readFileSync(syncStatePath, 'utf-8')) as SyncState;
    const driveFolderId = state1.meetings['m1'].driveFolderId;

    // User deletes the meeting locally between syncs.
    rmDir(path.join(transcriptionsDir, 'm1'));

    const result = await makeEngine().syncOnce();

    assert.deepEqual(result.tombstoned, ['m1']);
    assert.ok(mockClient.trashCalls.includes(driveFolderId), 'expected trashFile on meeting folder');

    // Tombstone JSON uploaded under .listener-tombstones/
    const tombstoneUpload = mockClient.uploads.find((u) => u.name === 'm1.json');
    assert.ok(tombstoneUpload, 'expected tombstone JSON upload');
    const payload = JSON.parse((tombstoneUpload!.content as string).toString());
    assert.equal(payload.meetingName, 'm1');
    assert.ok(payload.deletedAt);

    // State: meeting moved from meetings to tombstones
    const state2 = JSON.parse(fs.readFileSync(syncStatePath, 'utf-8')) as SyncState;
    assert.ok(!state2.meetings['m1'], 'meeting removed from state.meetings');
    assert.ok(state2.tombstones!['m1'], 'tombstone recorded in state.tombstones');
  });

  it('does not re-upload a tombstoned meeting on subsequent syncs', async () => {
    makeMeeting('m1', { 'summary.md': 's' });
    await makeEngine().syncOnce();
    rmDir(path.join(transcriptionsDir, 'm1'));
    await makeEngine().syncOnce(); // first sync after delete: tombstones

    mockClient.uploads = [];
    mockClient.trashCalls = [];

    // Third sync: should be a no-op for m1 (tombstoned + no local + remote trashed).
    const result = await makeEngine().syncOnce();
    assert.deepEqual(result.uploaded, []);
    assert.deepEqual(result.tombstoned, []);
    assert.deepEqual(result.deleted, []);
  });

  it('remote tombstone deletes local meeting on next sync', async () => {
    // Device A's perspective: sync up m1 normally so state knows about it.
    makeMeeting('m1', { 'summary.md': 's' });
    await makeEngine().syncOnce();

    // Simulate Device B deleting m1: insert a tombstone JSON in the
    // .listener-tombstones folder on Drive (the folder id was created
    // during the first sync).
    const state1 = JSON.parse(fs.readFileSync(syncStatePath, 'utf-8')) as SyncState;
    const tombstonesFolderId = state1.tombstonesFolderId!;
    // Simulate "another device" by uploading the tombstone through the same
    // mock client so it lands in the seeded folderContents.
    await mockClient.uploadFile({
      name: 'm1.json',
      parentId: tombstonesFolderId,
      content: JSON.stringify({
        meetingName: 'm1',
        deletedAt: new Date().toISOString(),
      }),
      mimeType: 'application/json',
    });

    // Device A re-syncs and should pick up the tombstone.
    const result = await makeEngine().syncOnce();

    assert.deepEqual(result.deleted, ['m1']);
    assert.equal(
      fs.existsSync(path.join(transcriptionsDir, 'm1')),
      false,
      'local meeting folder should be removed',
    );
    const state2 = JSON.parse(fs.readFileSync(syncStatePath, 'utf-8')) as SyncState;
    assert.ok(!state2.meetings['m1']);
    assert.ok(state2.tombstones!['m1']);
  });

  it('re-deletes a meeting whose folder was resurrected locally after tombstoning', async () => {
    makeMeeting('m1', { 'summary.md': 's' });
    await makeEngine().syncOnce();
    rmDir(path.join(transcriptionsDir, 'm1'));
    await makeEngine().syncOnce(); // tombstone uploaded

    // User accidentally recreates the local folder (or restores from
    // backup) -- tombstone is still in state, so engine should re-delete.
    makeMeeting('m1', { 'summary.md': 'resurrected' });

    const result = await makeEngine().syncOnce();
    assert.deepEqual(result.deleted, ['m1']);
    assert.equal(fs.existsSync(path.join(transcriptionsDir, 'm1')), false);
  });

  it('GC removes tombstones older than the retention window', async () => {
    makeMeeting('m1', { 'summary.md': 's' });
    await makeEngine().syncOnce();
    rmDir(path.join(transcriptionsDir, 'm1'));
    await makeEngine().syncOnce();

    // Backdate the tombstone to 31 days ago.
    const stateRaw = JSON.parse(fs.readFileSync(syncStatePath, 'utf-8')) as SyncState;
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    stateRaw.tombstones!['m1'].deletedAt = oldDate;
    fs.writeFileSync(syncStatePath, JSON.stringify(stateRaw));
    const tombstoneFileId = stateRaw.tombstones!['m1'].driveTombstoneId!;

    mockClient.deleteCalls = [];
    const result = await makeEngine().syncOnce();

    assert.ok(mockClient.deleteCalls.includes(tombstoneFileId), 'tombstone file deleted');
    const state3 = JSON.parse(fs.readFileSync(syncStatePath, 'utf-8')) as SyncState;
    assert.ok(!state3.tombstones!['m1'], 'tombstone removed from state');
    // No errors from GC
    assert.deepEqual(result.errors, []);
  });
});

describe('SyncEngine: empty cases', () => {
  it('returns empty result when no meetings exist', async () => {
    const result = await makeEngine().syncOnce();
    assert.deepEqual(result.uploaded, []);
    assert.deepEqual(result.downloaded, []);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.errors, []);
  });

  it('handles missing transcriptions directory gracefully', async () => {
    rmDir(transcriptionsDir);
    const result = await makeEngine().syncOnce();
    assert.deepEqual(result.uploaded, []);
    assert.deepEqual(result.downloaded, []);
    assert.deepEqual(result.errors, []);
  });
});
