import * as fs from 'fs';
import * as path from 'path';
import { isSupportedAudioExtension, mimeTypeForFile } from '../audioFormats';
import {
  type DriveFile,
  type GoogleDriveClient,
  LISTENER_DRIVE_FOLDER_NAME,
} from './googleDriveService';

// Phase 3A+3B: bidirectional sync engine.
//
// Per-file change detection on both sides (local mtime vs Drive modifiedTime).
// Conflict policy is last-write-wins by the newer of the two timestamps;
// the losing version is written to `<dataPath>/.listener-conflicts/<meeting>/`
// so no content is destroyed silently. Idempotency at the Drive layer
// (uploadFile PATCH-on-collision) means re-uploads are safe even if local
// state diverges from Drive.
//
// Audio policy (A1' decision): always upload audio to Drive, never auto-
// download. Audio files appear in the sync index as "cloudOnly" entries on
// non-recording devices; explicit user action (Phase 3D UI) hydrates them.
//
// State is persisted after each meeting (not just at end of sync) so a crash
// mid-cycle doesn't lose the upload tracking that already succeeded. The
// state file is atomically replaced (write-temp + rename) to avoid corruption
// from concurrent processes (Electron app + CLI both running).

export type SyncStateVersion = 1;

export type FileSyncState = {
  driveFileId: string;
  localMtimeMs: number;
  // Drive's modifiedTime at the moment we last synced this file. Used to
  // detect remote changes since our last visit (modifiedTime advances every
  // time Drive sees a write, including from other devices).
  driveModifiedTime?: string;
  mimeType: string;
  lastUploadedAt: string;
  // True when the file exists on Drive but was never downloaded to this
  // device (audio files on non-recording devices). The engine keeps the
  // sync state entry so we know about it; Phase 3D will provide the UI to
  // hydrate on demand.
  cloudOnly?: boolean;
};

export type MeetingSyncState = {
  driveFolderId: string;
  files: Record<string, FileSyncState>;
  lastSyncedAt: string;
};

// Tombstone marks a deletion that needs to propagate. Created when we detect
// a local deletion (meeting in state but not on disk), uploaded to Drive's
// `.listener-tombstones/` folder so other devices see + apply it. Tracked
// locally so we don't re-upload the meeting on the next sync.
export type TombstoneState = {
  // Drive file ID of the tombstone JSON in .listener-tombstones/, so we can
  // GC it after the retention window. Optional because a tombstone we
  // discover from a remote write may not need a local-side Drive ID until
  // we GC it.
  driveTombstoneId?: string;
  deletedAt: string;
};

export type SyncState = {
  version: SyncStateVersion;
  appFolderId?: string;
  tombstonesFolderId?: string;
  appFolderName: string;
  meetings: Record<string, MeetingSyncState>;
  tombstones?: Record<string, TombstoneState>;
  lastSyncedAt?: string;
};

export type SyncResult = {
  uploaded: string[];
  downloaded: string[];
  skipped: string[];
  conflicts: string[];
  deleted: string[];
  tombstoned: string[];
  errors: Array<{ meeting: string; file?: string; error: string }>;
};

export type SyncEngineOptions = {
  driveClient: GoogleDriveClient;
  transcriptionsDir: string;
  syncStatePath: string;
  // Conflict backups land here when LWW resolution picks a winner. Defaults
  // to `<dirname of syncStatePath>/.listener-conflicts/`.
  conflictsDir?: string;
  appFolderName?: string;
  // Files matching these names are skipped from sync (hidden / system files).
  excludeFilePatterns?: RegExp[];
  logger?: (msg: string) => void;
};

const DEFAULT_EXCLUDES: RegExp[] = [/^\./];
const TOMBSTONES_FOLDER_NAME = '.listener-tombstones';
const TOMBSTONE_RETENTION_DAYS = 30;

export class SyncEngine {
  private readonly driveClient: GoogleDriveClient;
  private readonly transcriptionsDir: string;
  private readonly syncStatePath: string;
  private readonly conflictsDir: string;
  private readonly appFolderName: string;
  private readonly excludePatterns: RegExp[];
  private readonly logger: (msg: string) => void;

  constructor(opts: SyncEngineOptions) {
    this.driveClient = opts.driveClient;
    this.transcriptionsDir = opts.transcriptionsDir;
    this.syncStatePath = opts.syncStatePath;
    this.conflictsDir =
      opts.conflictsDir ?? path.join(path.dirname(opts.syncStatePath), '.listener-conflicts');
    this.appFolderName = opts.appFolderName ?? LISTENER_DRIVE_FOLDER_NAME;
    this.excludePatterns = opts.excludeFilePatterns ?? DEFAULT_EXCLUDES;
    this.logger = opts.logger ?? (() => {});
  }

  loadState(): SyncState {
    if (!fs.existsSync(this.syncStatePath)) return this.defaultState();
    try {
      const raw = fs.readFileSync(this.syncStatePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<SyncState>;
      if (parsed.version !== 1) {
        this.logger(`Sync state version mismatch (${parsed.version}), starting fresh.`);
        return this.defaultState();
      }
      return {
        version: 1,
        appFolderId: parsed.appFolderId,
        tombstonesFolderId: parsed.tombstonesFolderId,
        appFolderName: parsed.appFolderName ?? this.appFolderName,
        meetings: parsed.meetings ?? {},
        tombstones: parsed.tombstones ?? {},
        lastSyncedAt: parsed.lastSyncedAt,
      };
    } catch (err) {
      this.logger(`Failed to read sync state (${(err as Error).message}), starting fresh.`);
      return this.defaultState();
    }
  }

  private defaultState(): SyncState {
    return {
      version: 1,
      appFolderName: this.appFolderName,
      meetings: {},
      tombstones: {},
    };
  }

  saveState(state: SyncState): void {
    fs.mkdirSync(path.dirname(this.syncStatePath), { recursive: true });
    const tmp = `${this.syncStatePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.syncStatePath);
  }

  async syncOnce(): Promise<SyncResult> {
    const result: SyncResult = {
      uploaded: [],
      downloaded: [],
      skipped: [],
      conflicts: [],
      deleted: [],
      tombstoned: [],
      errors: [],
    };
    const state = this.loadState();
    state.tombstones = state.tombstones ?? {};

    if (!state.appFolderId) {
      const folder = await this.driveClient.ensureFolder(this.appFolderName);
      state.appFolderId = folder.id;
      this.saveState(state);
      this.logger(`Created Drive app folder: ${this.appFolderName} (${folder.id})`);
    }
    if (!state.tombstonesFolderId) {
      const folder = await this.driveClient.ensureFolder(TOMBSTONES_FOLDER_NAME, state.appFolderId);
      state.tombstonesFolderId = folder.id;
      this.saveState(state);
      this.logger(`Created tombstones folder: ${folder.id}`);
    }

    fs.mkdirSync(this.transcriptionsDir, { recursive: true });

    // 1. Process remote tombstones first -- delete local meetings that were
    //    deleted on another device. Must come BEFORE the upload pass so we
    //    don't immediately re-upload a meeting we're about to delete.
    await this.processRemoteTombstones(state, result);

    // Capture the local + remote snapshot once. We need both for the
    // deletion detection pass and the upload/download pass that follows.
    const localMeetingNames = this.scanLocalMeetingNames();
    const remoteMeetingEntries = await this.scanRemoteMeetingFolders(state.appFolderId);
    const remoteByName = new Map(remoteMeetingEntries.map((m) => [m.name, m]));

    // 2. Detect locally-deleted meetings: anything tracked in state.meetings
    //    that's no longer on disk AND not already tombstoned. Must come
    //    BEFORE the main upload/download loop, or the remote folder would
    //    look like "first download from another device" and we'd re-create
    //    the local folder instead of propagating the deletion.
    for (const name of Object.keys(state.meetings)) {
      if (state.tombstones[name]) continue;
      if (localMeetingNames.includes(name)) continue;
      const remoteEntry = remoteByName.get(name);
      if (remoteEntry) {
        await this.tombstoneLocalDeletion(name, state, result);
      } else {
        // Both sides gone (e.g. another device deleted + GC'd its tombstone
        // while we were offline). Clean up the orphan state entry.
        delete state.meetings[name];
      }
      this.saveState(state);
    }

    // 3. Enumerate the join: union of local meeting folders + remote subfolders.
    //    Tombstoned meetings are skipped (their state entry was removed in 2
    //    or 1 already; the tombstones map keeps us from resurrecting).
    const allNames = new Set<string>([
      ...localMeetingNames,
      ...remoteMeetingEntries.map((m) => m.name),
    ]);

    for (const name of [...allNames].sort()) {
      if (state.tombstones[name]) {
        // Local file resurrected after deletion (manual restore, backup
        // tool, etc.) -- re-delete to honor the user's prior deletion.
        if (localMeetingNames.includes(name)) {
          const localPath = path.join(this.transcriptionsDir, name);
          try {
            fs.rmSync(localPath, { recursive: true, force: true });
            result.deleted.push(name);
            this.logger(`Deleted resurrected local meeting "${name}" (tombstoned).`);
          } catch (err) {
            result.errors.push({ meeting: name, error: (err as Error).message });
          }
        }
        continue;
      }

      const localExists = localMeetingNames.includes(name);
      const remoteEntry = remoteByName.get(name);
      try {
        if (localExists && remoteEntry) {
          await this.syncMeetingBidirectional(name, remoteEntry, state, result);
        } else if (localExists) {
          await this.syncMeetingUploadOnly(name, state, result);
        } else if (remoteEntry) {
          await this.syncMeetingDownloadOnly(name, remoteEntry, state, result);
        }
        this.saveState(state);
      } catch (err) {
        result.errors.push({ meeting: name, error: (err as Error).message });
        this.logger(`Failed to sync meeting "${name}": ${(err as Error).message}`);
      }
    }

    // 4. GC tombstones older than the retention window.
    await this.gcOldTombstones(state, result);

    state.lastSyncedAt = new Date().toISOString();
    this.saveState(state);
    return result;
  }

  // Reads .listener-tombstones/ on Drive, marks any new tombstones in our
  // local state, and deletes the corresponding local meeting folders. A
  // tombstone we created ourselves (driveTombstoneId already in state) is
  // skipped here -- we already handled the local deletion at creation time.
  private async processRemoteTombstones(state: SyncState, result: SyncResult): Promise<void> {
    if (!state.tombstonesFolderId) return;
    const remoteTombstones = await this.driveClient.listFolder(state.tombstonesFolderId);
    for (const entry of remoteTombstones) {
      if (!entry.name.endsWith('.json')) continue;
      const meetingName = entry.name.slice(0, -'.json'.length);
      if (state.tombstones?.[meetingName]) {
        // Already processed locally; refresh the driveTombstoneId in case
        // another device rewrote the tombstone (e.g. echo).
        state.tombstones[meetingName].driveTombstoneId = entry.id;
        continue;
      }
      try {
        // Drive's modifiedTime is set on tombstone create and never updated
        // (we don't PATCH tombstone files), so we can use it as deletedAt
        // without downloading the JSON body. Saves one API call per
        // tombstone, which matters during back-to-back sync recovery when
        // many tombstones accumulate before GC.
        const deletedAt = entry.modifiedTime ?? new Date().toISOString();
        state.tombstones![meetingName] = {
          driveTombstoneId: entry.id,
          deletedAt,
        };

        // Remove from meetings map and from disk if present.
        delete state.meetings[meetingName];
        const localPath = path.join(this.transcriptionsDir, meetingName);
        if (fs.existsSync(localPath)) {
          fs.rmSync(localPath, { recursive: true, force: true });
          result.deleted.push(meetingName);
          this.logger(`Applied remote tombstone for "${meetingName}".`);
        }
      } catch (err) {
        result.errors.push({
          meeting: meetingName,
          error: `tombstone apply: ${(err as Error).message}`,
        });
      }
    }
  }

  // Single-meeting deletion: trash the Drive folder (soft delete, Drive
  // auto-purges trash after ~30 days), upload a tombstone JSON to
  // .listener-tombstones/, and remove the meeting from state. Called from
  // syncOnce when a tracked meeting is no longer on disk.
  private async tombstoneLocalDeletion(
    name: string,
    state: SyncState,
    result: SyncResult,
  ): Promise<void> {
    if (!state.tombstonesFolderId) return;
    const meetingState = state.meetings[name];
    if (!meetingState) return;

    try {
      // Trash the Drive folder. Failure is non-fatal -- the tombstone is the
      // durable signal; folder may already be gone (404).
      if (meetingState.driveFolderId) {
        try {
          await this.driveClient.trashFile(meetingState.driveFolderId);
        } catch (trashErr) {
          this.logger(
            `trashFile failed for "${name}" (continuing): ${(trashErr as Error).message}`,
          );
        }
      }

      const tombstonePayload = {
        meetingName: name,
        deletedAt: new Date().toISOString(),
        driveFolderId: meetingState.driveFolderId,
      };
      const uploaded = await this.driveClient.uploadFile({
        name: `${name}.json`,
        parentId: state.tombstonesFolderId,
        content: JSON.stringify(tombstonePayload, null, 2),
        mimeType: 'application/json',
      });

      state.tombstones![name] = {
        driveTombstoneId: uploaded.id,
        deletedAt: tombstonePayload.deletedAt,
      };
      delete state.meetings[name];
      result.tombstoned.push(name);
      this.logger(`Uploaded tombstone for locally-deleted "${name}".`);
    } catch (err) {
      result.errors.push({ meeting: name, error: (err as Error).message });
    }
  }

  // Remove tombstones older than TOMBSTONE_RETENTION_DAYS from both Drive
  // and local state. After GC, an offline device that comes back online
  // beyond the retention window won't see the deletion signal and could
  // re-upload the meeting -- acceptable edge case for a rare scenario.
  private async gcOldTombstones(state: SyncState, result: SyncResult): Promise<void> {
    if (!state.tombstones) return;
    const cutoff = Date.now() - TOMBSTONE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const names = Object.keys(state.tombstones);
    for (const name of names) {
      const tombstone = state.tombstones[name];
      const deletedAtMs = Date.parse(tombstone.deletedAt);
      if (!Number.isFinite(deletedAtMs) || deletedAtMs >= cutoff) continue;
      try {
        if (tombstone.driveTombstoneId) {
          await this.driveClient.deleteFile(tombstone.driveTombstoneId);
        }
        delete state.tombstones[name];
        this.logger(`GC'd tombstone for "${name}" (older than ${TOMBSTONE_RETENTION_DAYS}d).`);
      } catch (err) {
        result.errors.push({ meeting: name, error: `tombstone GC: ${(err as Error).message}` });
      }
    }
  }

  private scanLocalMeetingNames(): string[] {
    if (!fs.existsSync(this.transcriptionsDir)) return [];
    return fs
      .readdirSync(this.transcriptionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !this.shouldExcludeName(e.name))
      .map((e) => e.name)
      .sort();
  }

  private async scanRemoteMeetingFolders(appFolderId: string): Promise<DriveFile[]> {
    const contents = await this.driveClient.listFolder(appFolderId);
    return contents.filter(
      (f) => f.mimeType === 'application/vnd.google-apps.folder' && !this.shouldExcludeName(f.name),
    );
  }

  // Path A: local-only meeting (no Drive folder yet, or remote folder existed
  // but was deleted by another device). Phase 3C tombstones will let us
  // distinguish those cases; for now we always (re)create + upload, which is
  // idempotent at the Drive layer.
  private async syncMeetingUploadOnly(
    meetingName: string,
    state: SyncState,
    result: SyncResult,
  ): Promise<void> {
    let meetingState = state.meetings[meetingName];
    if (!meetingState?.driveFolderId) {
      const folder = await this.driveClient.ensureFolder(meetingName, state.appFolderId);
      meetingState = {
        driveFolderId: folder.id,
        files: meetingState?.files ?? {},
        lastSyncedAt: new Date().toISOString(),
      };
      state.meetings[meetingName] = meetingState;
      this.logger(`Drive folder for "${meetingName}": ${folder.id}`);
    }

    const folderPath = path.join(this.transcriptionsDir, meetingName);
    const localFiles = this.scanLocalFiles(folderPath);
    for (const entry of localFiles) {
      await this.uploadLocalFile(meetingName, entry.name, folderPath, meetingState, result);
    }
    meetingState.lastSyncedAt = new Date().toISOString();
  }

  // Path B: remote-only meeting (downloaded from another device for the first
  // time). Creates the local folder, downloads text files, leaves audio as
  // cloudOnly entries (no auto-hydrate per A1' decision).
  private async syncMeetingDownloadOnly(
    meetingName: string,
    remoteFolder: DriveFile,
    state: SyncState,
    result: SyncResult,
  ): Promise<void> {
    let meetingState = state.meetings[meetingName];
    if (!meetingState) {
      meetingState = {
        driveFolderId: remoteFolder.id,
        files: {},
        lastSyncedAt: new Date().toISOString(),
      };
      state.meetings[meetingName] = meetingState;
    }
    meetingState.driveFolderId = remoteFolder.id;

    const folderPath = path.join(this.transcriptionsDir, meetingName);
    fs.mkdirSync(folderPath, { recursive: true });

    const remoteFiles = await this.driveClient.listFolder(remoteFolder.id);
    for (const remote of remoteFiles) {
      if (this.shouldExcludeName(remote.name)) continue;
      if (this.isAudioFile(remote.name)) {
        // Track but don't download. Phase 3D will surface a "Download for
        // playback" affordance per file.
        this.trackCloudOnly(meetingState, remote.name, remote);
        this.logger(`Cloud-only audio tracked: ${meetingName}/${remote.name}`);
        continue;
      }
      try {
        const content = await this.driveClient.downloadFile(remote.id);
        const target = path.join(folderPath, remote.name);
        fs.writeFileSync(target, content);
        const stat = fs.statSync(target);
        meetingState.files[remote.name] = {
          driveFileId: remote.id,
          localMtimeMs: stat.mtimeMs,
          driveModifiedTime: remote.modifiedTime,
          mimeType: remote.mimeType,
          lastUploadedAt: new Date().toISOString(),
        };
        result.downloaded.push(`${meetingName}/${remote.name}`);
        this.logger(`Downloaded ${meetingName}/${remote.name} from ${remote.id}`);
      } catch (err) {
        result.errors.push({
          meeting: meetingName,
          file: remote.name,
          error: (err as Error).message,
        });
      }
    }
    meetingState.lastSyncedAt = new Date().toISOString();
  }

  // Path C: meeting exists on both sides. Diff each file and resolve.
  private async syncMeetingBidirectional(
    meetingName: string,
    remoteFolder: DriveFile,
    state: SyncState,
    result: SyncResult,
  ): Promise<void> {
    let meetingState = state.meetings[meetingName];
    if (!meetingState) {
      meetingState = {
        driveFolderId: remoteFolder.id,
        files: {},
        lastSyncedAt: new Date().toISOString(),
      };
      state.meetings[meetingName] = meetingState;
    } else {
      // Trust the remote folder id we just looked up -- handles the case
      // where a previous Drive folder was deleted and recreated by another
      // device.
      meetingState.driveFolderId = remoteFolder.id;
    }

    const folderPath = path.join(this.transcriptionsDir, meetingName);
    const localFiles = this.scanLocalFiles(folderPath);
    const remoteFiles = await this.driveClient.listFolder(remoteFolder.id);

    const localByName = new Map(localFiles.map((e) => [e.name, e]));
    const remoteByName = new Map(remoteFiles.map((f) => [f.name, f]));
    const allFilenames = new Set<string>([...localByName.keys(), ...remoteByName.keys()]);

    for (const filename of [...allFilenames].sort()) {
      if (this.shouldExcludeName(filename)) continue;
      const localEntry = localByName.get(filename);
      const remoteEntry = remoteByName.get(filename);
      const prior = meetingState.files[filename];

      try {
        if (localEntry && remoteEntry) {
          await this.resolveBothSidesPresent(
            meetingName,
            filename,
            folderPath,
            remoteEntry,
            prior,
            meetingState,
            result,
          );
        } else if (localEntry) {
          // Local-only: upload (new file on this device, or remote was deleted
          // elsewhere -- treat as upload; Phase 3C tombstones will distinguish).
          await this.uploadLocalFile(meetingName, filename, folderPath, meetingState, result);
        } else if (remoteEntry) {
          // Remote-only: download (new file from another device), unless audio.
          if (this.isAudioFile(filename)) {
            this.trackCloudOnly(meetingState, filename, remoteEntry);
            this.logger(`Cloud-only audio tracked: ${meetingName}/${filename}`);
            continue;
          }
          await this.downloadRemoteFile(
            meetingName,
            filename,
            folderPath,
            remoteEntry,
            meetingState,
            result,
          );
        }
      } catch (err) {
        result.errors.push({
          meeting: meetingName,
          file: filename,
          error: (err as Error).message,
        });
      }
    }
    meetingState.lastSyncedAt = new Date().toISOString();
  }

  // Both sides have the file. Decide: skip / upload / download / conflict.
  private async resolveBothSidesPresent(
    meetingName: string,
    filename: string,
    folderPath: string,
    remoteEntry: DriveFile,
    prior: FileSyncState | undefined,
    meetingState: MeetingSyncState,
    result: SyncResult,
  ): Promise<void> {
    const filePath = path.join(folderPath, filename);
    const stat = fs.statSync(filePath);
    const localMtimeMs = stat.mtimeMs;
    const remoteModifiedTime = remoteEntry.modifiedTime;

    if (prior) {
      const localChanged = localMtimeMs !== prior.localMtimeMs;
      // Legacy Phase 3A state has no driveModifiedTime; treat it as
      // "remote unchanged" to avoid mass spurious downloads after upgrade.
      // The next time local changes and re-uploads, driveModifiedTime gets
      // recorded and remote-change detection kicks in normally.
      const remoteChanged =
        prior.driveModifiedTime !== undefined &&
        remoteModifiedTime !== undefined &&
        remoteModifiedTime !== prior.driveModifiedTime;

      if (!localChanged && !remoteChanged) {
        result.skipped.push(`${meetingName}/${filename}`);
        return;
      }

      if (localChanged && !remoteChanged) {
        await this.uploadLocalFile(meetingName, filename, folderPath, meetingState, result);
        return;
      }

      if (!localChanged && remoteChanged) {
        if (this.isAudioFile(filename)) {
          // Audio: don't auto-download even on remote change.
          meetingState.files[filename] = {
            ...prior,
            driveModifiedTime: remoteModifiedTime,
            cloudOnly: true,
          };
          return;
        }
        await this.downloadRemoteFile(
          meetingName,
          filename,
          folderPath,
          remoteEntry,
          meetingState,
          result,
        );
        return;
      }

      // Both changed -- conflict. LWW by which timestamp is newer.
      await this.resolveConflict(
        meetingName,
        filename,
        folderPath,
        localMtimeMs,
        remoteEntry,
        meetingState,
        result,
      );
      return;
    }

    // No prior state: first time we're seeing this file on both sides. This
    // happens on the very first sync of a meeting created on another device
    // that someone else also created locally with the same name. Treat as a
    // conflict so we don't silently overwrite either side.
    await this.resolveConflict(
      meetingName,
      filename,
      folderPath,
      localMtimeMs,
      remoteEntry,
      meetingState,
      result,
    );
  }

  private async resolveConflict(
    meetingName: string,
    filename: string,
    folderPath: string,
    localMtimeMs: number,
    remoteEntry: DriveFile,
    meetingState: MeetingSyncState,
    result: SyncResult,
  ): Promise<void> {
    const remoteMtime = remoteEntry.modifiedTime ? Date.parse(remoteEntry.modifiedTime) : 0;
    const localWins = localMtimeMs >= remoteMtime;
    const label = `${meetingName}/${filename}`;
    result.conflicts.push(label);
    this.logger(`Conflict on ${label}: ${localWins ? 'local wins' : 'remote wins'}`);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const conflictMeetingDir = path.join(this.conflictsDir, meetingName);
    fs.mkdirSync(conflictMeetingDir, { recursive: true });

    if (localWins) {
      // Back up the losing remote version, then upload local on top.
      const remoteContent = await this.driveClient.downloadFile(remoteEntry.id);
      fs.writeFileSync(
        path.join(conflictMeetingDir, `${filename}.remote.${timestamp}`),
        remoteContent,
      );
      await this.uploadLocalFile(meetingName, filename, folderPath, meetingState, result);
    } else {
      // Back up local, then download remote.
      const localPath = path.join(folderPath, filename);
      const localContent = fs.readFileSync(localPath);
      fs.writeFileSync(
        path.join(conflictMeetingDir, `${filename}.local.${timestamp}`),
        localContent,
      );
      await this.downloadRemoteFile(
        meetingName,
        filename,
        folderPath,
        remoteEntry,
        meetingState,
        result,
      );
    }
  }

  private async uploadLocalFile(
    meetingName: string,
    filename: string,
    folderPath: string,
    meetingState: MeetingSyncState,
    result: SyncResult,
  ): Promise<void> {
    const filePath = path.join(folderPath, filename);
    const stat = fs.statSync(filePath);
    const localMtimeMs = stat.mtimeMs;
    const prior = meetingState.files[filename];

    if (prior && prior.localMtimeMs === localMtimeMs && prior.driveFileId && !prior.cloudOnly) {
      result.skipped.push(`${meetingName}/${filename}`);
      return;
    }

    const content = fs.readFileSync(filePath);
    const mimeType = mimeTypeForFile(filename);
    const uploaded = await this.driveClient.uploadFile({
      name: filename,
      parentId: meetingState.driveFolderId,
      content,
      mimeType,
    });
    meetingState.files[filename] = {
      driveFileId: uploaded.id,
      localMtimeMs,
      driveModifiedTime: uploaded.modifiedTime,
      mimeType,
      lastUploadedAt: new Date().toISOString(),
    };
    result.uploaded.push(`${meetingName}/${filename}`);
    this.logger(`Uploaded ${meetingName}/${filename} -> ${uploaded.id}`);
  }

  private async downloadRemoteFile(
    meetingName: string,
    filename: string,
    folderPath: string,
    remoteEntry: DriveFile,
    meetingState: MeetingSyncState,
    result: SyncResult,
  ): Promise<void> {
    const content = await this.driveClient.downloadFile(remoteEntry.id);
    fs.mkdirSync(folderPath, { recursive: true });
    const target = path.join(folderPath, filename);
    fs.writeFileSync(target, content);
    const stat = fs.statSync(target);
    meetingState.files[filename] = {
      driveFileId: remoteEntry.id,
      localMtimeMs: stat.mtimeMs,
      driveModifiedTime: remoteEntry.modifiedTime,
      mimeType: remoteEntry.mimeType,
      lastUploadedAt: new Date().toISOString(),
    };
    result.downloaded.push(`${meetingName}/${filename}`);
    this.logger(`Downloaded ${meetingName}/${filename} from ${remoteEntry.id}`);
  }

  private scanLocalFiles(folderPath: string): fs.Dirent[] {
    if (!fs.existsSync(folderPath)) return [];
    return fs
      .readdirSync(folderPath, { withFileTypes: true })
      .filter((e) => e.isFile() && !this.shouldExcludeName(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private shouldExcludeName(name: string): boolean {
    return this.excludePatterns.some((pat) => pat.test(name));
  }

  private isAudioFile(filename: string): boolean {
    return isSupportedAudioExtension(path.extname(filename));
  }

  // Records a remote-only audio file in the sync state without downloading
  // it. Used by both download-only and bidirectional paths to keep the
  // cloud-only entry shape in one place.
  private trackCloudOnly(
    meetingState: MeetingSyncState,
    filename: string,
    remote: DriveFile,
  ): void {
    meetingState.files[filename] = {
      driveFileId: remote.id,
      localMtimeMs: 0,
      driveModifiedTime: remote.modifiedTime,
      mimeType: remote.mimeType,
      lastUploadedAt: new Date().toISOString(),
      cloudOnly: true,
    };
  }
}
