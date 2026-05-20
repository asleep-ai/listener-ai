import * as fs from 'fs';
import * as path from 'path';
import { mimeTypeForExtension } from '../audioFormats';
import { type GoogleDriveClient, LISTENER_DRIVE_FOLDER_NAME } from './googleDriveService';

// Phase 3A: upload-only sync engine.
//
// Tracks per-file mtime in sync-state.json so subsequent runs only upload
// changed files. Idempotency at the Drive layer (uploadFile PATCH-on-collision)
// makes this safe even if the index gets out of sync -- worst case we re-upload
// unchanged content, never duplicate. Phase 3B will add the download path and
// conflict resolution.
//
// State is persisted after each meeting (not just at end of sync) so a crash
// mid-cycle doesn't lose the upload tracking that already succeeded. The state
// file is atomically replaced (write-temp + rename) to avoid corruption from
// concurrent processes (Electron app + CLI both running).

export type SyncStateVersion = 1;

export type FileSyncState = {
  driveFileId: string;
  localMtimeMs: number;
  mimeType: string;
  lastUploadedAt: string;
};

export type MeetingSyncState = {
  driveFolderId: string;
  files: Record<string, FileSyncState>;
  lastSyncedAt: string;
};

export type SyncState = {
  version: SyncStateVersion;
  appFolderId?: string;
  appFolderName: string;
  meetings: Record<string, MeetingSyncState>;
  lastSyncedAt?: string;
};

export type SyncResult = {
  uploaded: string[];
  skipped: string[];
  errors: Array<{ meeting: string; file?: string; error: string }>;
};

export type SyncEngineOptions = {
  driveClient: GoogleDriveClient;
  transcriptionsDir: string;
  syncStatePath: string;
  appFolderName?: string;
  // Files matching these names are skipped (hidden / system files). Pattern
  // mirrors what `listener google upload` already excludes.
  excludeFilePatterns?: RegExp[];
  logger?: (msg: string) => void;
};

const DEFAULT_EXCLUDES: RegExp[] = [/^\./];

export class SyncEngine {
  private readonly driveClient: GoogleDriveClient;
  private readonly transcriptionsDir: string;
  private readonly syncStatePath: string;
  private readonly appFolderName: string;
  private readonly excludePatterns: RegExp[];
  private readonly logger: (msg: string) => void;

  constructor(opts: SyncEngineOptions) {
    this.driveClient = opts.driveClient;
    this.transcriptionsDir = opts.transcriptionsDir;
    this.syncStatePath = opts.syncStatePath;
    this.appFolderName = opts.appFolderName ?? LISTENER_DRIVE_FOLDER_NAME;
    this.excludePatterns = opts.excludeFilePatterns ?? DEFAULT_EXCLUDES;
    this.logger = opts.logger ?? (() => {});
  }

  loadState(): SyncState {
    if (!fs.existsSync(this.syncStatePath)) {
      return this.defaultState();
    }
    try {
      const raw = fs.readFileSync(this.syncStatePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<SyncState>;
      if (parsed.version !== 1) {
        this.logger(
          `Sync state version mismatch (${parsed.version}), starting fresh.`,
        );
        return this.defaultState();
      }
      return {
        version: 1,
        appFolderId: parsed.appFolderId,
        appFolderName: parsed.appFolderName ?? this.appFolderName,
        meetings: parsed.meetings ?? {},
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
    };
  }

  saveState(state: SyncState): void {
    // Atomic write: temp file + rename. fs.rename is atomic on POSIX, so a
    // concurrent reader sees either the old or new file, never a partial write.
    fs.mkdirSync(path.dirname(this.syncStatePath), { recursive: true });
    const tmp = `${this.syncStatePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.syncStatePath);
  }

  async syncOnce(): Promise<SyncResult> {
    const result: SyncResult = { uploaded: [], skipped: [], errors: [] };
    const state = this.loadState();

    if (!state.appFolderId) {
      const folder = await this.driveClient.ensureFolder(this.appFolderName);
      state.appFolderId = folder.id;
      this.saveState(state);
      this.logger(`Created Drive app folder: ${this.appFolderName} (${folder.id})`);
    }

    if (!fs.existsSync(this.transcriptionsDir)) {
      this.logger(`No transcriptions directory at ${this.transcriptionsDir}, nothing to sync.`);
      state.lastSyncedAt = new Date().toISOString();
      this.saveState(state);
      return result;
    }

    const meetingEntries = fs
      .readdirSync(this.transcriptionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !this.shouldExcludeName(e.name))
      .map((e) => e.name)
      .sort();

    for (const meetingName of meetingEntries) {
      try {
        await this.syncMeeting(meetingName, state, result);
        // Persist after each meeting so a mid-cycle crash doesn't lose progress.
        this.saveState(state);
      } catch (err) {
        result.errors.push({ meeting: meetingName, error: (err as Error).message });
        this.logger(`Failed to sync meeting "${meetingName}": ${(err as Error).message}`);
        // Continue with other meetings; one bad meeting shouldn't block the rest.
      }
    }

    state.lastSyncedAt = new Date().toISOString();
    this.saveState(state);
    return result;
  }

  private async syncMeeting(
    meetingName: string,
    state: SyncState,
    result: SyncResult,
  ): Promise<void> {
    const folderPath = path.join(this.transcriptionsDir, meetingName);

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

    const fileEntries = fs
      .readdirSync(folderPath, { withFileTypes: true })
      .filter((e) => e.isFile() && !this.shouldExcludeName(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of fileEntries) {
      const fileLabel = `${meetingName}/${entry.name}`;
      try {
        const filePath = path.join(folderPath, entry.name);
        const stat = fs.statSync(filePath);
        const localMtimeMs = stat.mtimeMs;

        const prior = meetingState.files[entry.name];
        if (prior && prior.localMtimeMs === localMtimeMs && prior.driveFileId) {
          result.skipped.push(fileLabel);
          continue;
        }

        const content = fs.readFileSync(filePath);
        const mimeType = mimeTypeForFile(entry.name);
        const uploaded = await this.driveClient.uploadFile({
          name: entry.name,
          parentId: meetingState.driveFolderId,
          content,
          mimeType,
        });

        meetingState.files[entry.name] = {
          driveFileId: uploaded.id,
          localMtimeMs,
          mimeType,
          lastUploadedAt: new Date().toISOString(),
        };
        result.uploaded.push(fileLabel);
        this.logger(`Uploaded ${fileLabel} -> ${uploaded.id}`);
      } catch (err) {
        result.errors.push({
          meeting: meetingName,
          file: entry.name,
          error: (err as Error).message,
        });
        this.logger(`Failed to upload ${fileLabel}: ${(err as Error).message}`);
      }
    }

    meetingState.lastSyncedAt = new Date().toISOString();
  }

  private shouldExcludeName(name: string): boolean {
    return this.excludePatterns.some((pat) => pat.test(name));
  }
}

// Centralized mime detection for sync uploads. Mirrors the CLI helper but
// lives here so the engine doesn't depend on the CLI module.
export function mimeTypeForFile(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.md') return 'text/markdown';
  if (ext === '.json') return 'application/json';
  if (ext === '.txt') return 'text/plain';
  return mimeTypeForExtension(ext) ?? 'application/octet-stream';
}
