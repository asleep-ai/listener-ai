import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isSupportedAudioExtension } from '../audioFormats';
import { withMeetingLock } from '../meetingLock';
import type { GoogleDriveClient } from './googleDriveService';
import { GoogleDriveError } from './googleDriveService';
import type { FileSyncState, SyncState } from './syncEngine';

// Local storage management for recording audio backed up to Google Drive.
//
// Ownership rules (the whole safety story rests on them):
// - Only "managed" audio is ever uploaded as a note's source audio or removed
//   locally: a regular file directly inside `<dataPath>/recordings/`, with a
//   supported audio extension, not hidden, not a symlink. Originals the CLI
//   transcribed in place (meta.audioFile outside recordings/) are never
//   uploaded or removed.
// - Removing the local copy ("free up space") never touches Drive and never
//   touches the note folder, so it can never become a tombstone. The sync
//   engine treats a missing managed source audio with a known Drive copy as
//   cloud-only.
// - Removal requires every note that links the file to hold a Drive copy that
//   is re-verified right before removal (fresh metadata: not trashed, inside
//   the note's Drive folder, same size and md5 as the local bytes hashed now).
// - Readers (transcription, merge, export) hold a shared read lease; removal
//   holds the audio's exclusive lock only briefly and refuses while any live
//   lease exists. The audio lock is never held while taking a note lock, and
//   no note lock is held while taking it, so there is no lock-order cycle.
//
// Device-local bookkeeping lives in `<dataPath>/local-audio/<hash>.json`, one
// small file per audio path, written under that audio's lock. It is never
// synced: whether this device keeps a copy is not something other devices
// should learn.

export const RECORDINGS_DIRNAME = 'recordings';
const LOCAL_AUDIO_DIRNAME = 'local-audio';
const LEASES_DIRNAME = '.listener-audio-leases';
const METADATA_DIRNAME = 'metadata';
const DAY_MS = 24 * 60 * 60 * 1000;

// Allowed automatic cleanup windows, in days. 0 = never remove automatically.
export const AUDIO_OFFLOAD_DAY_CHOICES = [0, 7, 14, 30, 90] as const;

export function recordingsDirFor(dataPath: string): string {
  return path.join(dataPath, RECORDINGS_DIRNAME);
}

function syncStatePathFor(dataPath: string): string {
  return path.join(dataPath, 'sync-state.json');
}

function pathHash(p: string): string {
  return createHash('sha256').update(path.resolve(p)).digest('hex');
}

/**
 * True when `p` names (lexically) a managed recording: a direct child of the
 * recordings directory with a supported audio extension and no leading dot.
 * Does not touch the filesystem, so it also answers for a removed file.
 */
export function isManagedAudioPathLexical(recordingsDir: string, p: string): boolean {
  if (typeof p !== 'string' || !p) return false;
  const resolved = path.resolve(p);
  if (path.dirname(resolved) !== path.resolve(recordingsDir)) return false;
  const base = path.basename(resolved);
  if (base.startsWith('.')) return false;
  return isSupportedAudioExtension(path.extname(base));
}

/**
 * Filesystem-checked variant: the file must exist as a regular file (not a
 * symlink) and its real path must still sit directly inside the real
 * recordings directory. Returns the stat when managed, otherwise null.
 */
export function statManagedAudio(recordingsDir: string, p: string): fs.Stats | null {
  if (!isManagedAudioPathLexical(recordingsDir, p)) return null;
  try {
    const lst = fs.lstatSync(p);
    if (!lst.isFile() || lst.isSymbolicLink()) return null;
    const realRoot = fs.realpathSync(recordingsDir);
    if (path.dirname(fs.realpathSync(p)) !== realRoot) return null;
    return lst;
  } catch {
    return null;
  }
}

export async function md5File(p: string): Promise<string> {
  const hash = createHash('md5');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(p);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve());
  });
  return hash.digest('hex');
}

export function md5Buffer(buf: Buffer | Uint8Array): string {
  return createHash('md5').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// Device-local record

export type LocalAudioRecord = {
  version: 1;
  path: string;
  /** Note folder names that link this audio, as of the last write. */
  meetings?: string[];
  /** Last time this device downloaded the file back from Drive. */
  hydratedAt?: string;
  /** Last time a reader (transcription, merge, export) used the file. */
  lastUsedAt?: string;
  /** Set while the local copy is removed; cleared on restore. */
  removedAt?: string;
  driveFileId?: string;
  md5Checksum?: string;
  size?: number;
  /** mtime of the restored file, so a later edit is not mistaken for the Drive bytes. */
  localMtimeMs?: number;
  /**
   * Each linked meeting's own Drive copy (meeting folder name -> Drive file
   * id). Notes sharing one restored file each keep a copy in their own Drive
   * folder, so removal verifies every one of them.
   */
  copies?: Record<string, string>;
};

function recordPath(dataPath: string, audioPath: string): string {
  return path.join(dataPath, LOCAL_AUDIO_DIRNAME, `${pathHash(audioPath)}.json`);
}

export function readLocalAudioRecord(dataPath: string, audioPath: string): LocalAudioRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(recordPath(dataPath, audioPath), 'utf-8'));
    if (parsed && parsed.version === 1 && typeof parsed.path === 'string') return parsed;
  } catch {
    /* absent or unreadable: no record */
  }
  return null;
}

export function listLocalAudioRecords(dataPath: string): LocalAudioRecord[] {
  const dir = path.join(dataPath, LOCAL_AUDIO_DIRNAME);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: LocalAudioRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8'));
      if (parsed && parsed.version === 1 && typeof parsed.path === 'string') out.push(parsed);
    } catch {
      /* skip */
    }
  }
  return out;
}

// Callers hold the audio lock.
function updateLocalAudioRecord(
  dataPath: string,
  audioPath: string,
  patch: Partial<LocalAudioRecord>,
): void {
  const existing = readLocalAudioRecord(dataPath, audioPath);
  const next: LocalAudioRecord = {
    ...existing,
    ...patch,
    version: 1,
    path: path.resolve(audioPath),
  };
  for (const key of Object.keys(next) as Array<keyof LocalAudioRecord>) {
    if (next[key] === undefined) delete next[key];
  }
  const file = recordPath(dataPath, audioPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Shared read leases

function leaseDir(dataPath: string, audioPath: string): string {
  return path.join(dataPath, LEASES_DIRNAME, pathHash(audioPath));
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Live read leases on `audioPath`; leases of dead processes are removed. */
export function liveReadLeases(dataPath: string, audioPath: string): number {
  const dir = leaseDir(dataPath, audioPath);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let live = 0;
  for (const name of names) {
    const pid = Number(name.split('-')[0]);
    if (pidAlive(pid)) {
      live++;
    } else {
      fs.rmSync(path.join(dir, name), { force: true });
    }
  }
  return live;
}

/**
 * Runs `action` while holding a shared read lease on a managed recording, so
 * no process (app or CLI) removes the local copy mid-read. Non-managed paths
 * (imported originals) run unchanged. The audio lock is held only while the
 * lease is created, never during `action`.
 */
export async function withAudioReadLease<T>(
  dataPath: string,
  audioPath: string,
  action: () => Promise<T> | T,
): Promise<T> {
  const recordingsDir = recordingsDirFor(dataPath);
  if (!audioPath || !isManagedAudioPathLexical(recordingsDir, audioPath)) return action();
  const dir = leaseDir(dataPath, audioPath);
  const leaseFile = path.join(dir, `${process.pid}-${randomUUID()}.lease`);
  // Fails closed: if the lease cannot be taken, the read does not start.
  // Lock contention is waited out inside withMeetingLock, so an error here is
  // a real failure, and reading unprotected could race a removal.
  await withMeetingLock(audioPath, () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(leaseFile, JSON.stringify({ pid: process.pid, path: audioPath }));
    if (fs.existsSync(audioPath)) {
      updateLocalAudioRecord(dataPath, audioPath, { lastUsedAt: new Date().toISOString() });
    }
  });
  try {
    return await action();
  } finally {
    fs.rmSync(leaseFile, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Note scan

type NoteAudioLink = {
  meeting: string;
  folderPath: string;
  title?: string;
  audioFile: string;
};

function readNoteMeta(folderPath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(folderPath, 'meta.json'), 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** meta.audioFile of a note folder, or null. */
export function readNoteAudioFile(folderPath: string): string | null {
  const meta = readNoteMeta(folderPath);
  return typeof meta?.audioFile === 'string' && meta.audioFile ? meta.audioFile : null;
}

function scanNoteAudioLinks(dataPath: string): NoteAudioLink[] {
  const dir = path.join(dataPath, 'transcriptions');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: NoteAudioLink[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const folderPath = path.join(dir, entry.name);
    const meta = readNoteMeta(folderPath);
    if (typeof meta?.audioFile !== 'string' || !meta.audioFile) continue;
    out.push({
      meeting: entry.name,
      folderPath,
      title: typeof meta.title === 'string' ? meta.title : undefined,
      audioFile: meta.audioFile,
    });
  }
  return out;
}

function loadSyncState(syncStatePath: string): SyncState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(syncStatePath, 'utf-8')) as SyncState;
    return parsed?.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

/** Drive bookkeeping for a note's source audio, by file name. */
export function driveEntryFor(
  state: SyncState | null,
  meeting: string,
  audioName: string,
): (FileSyncState & { driveFolderId: string }) | null {
  const meetingState = state?.meetings?.[meeting];
  const entry = meetingState?.files?.[audioName];
  if (!meetingState || !entry?.driveFileId) return null;
  return { ...entry, driveFolderId: meetingState.driveFolderId };
}

// An uploaded copy matches the local file as of the last sync: same size and
// mtime as when the bytes were hashed and sent. Cheap, offline, and only a
// hint -- removal re-verifies against Drive.
function recordedUploadMatches(entry: FileSyncState | null, stat: fs.Stats): boolean {
  return (
    !!entry &&
    !!entry.driveFileId &&
    entry.sourceAudio === true &&
    typeof entry.md5Checksum === 'string' &&
    entry.size === stat.size &&
    entry.localMtimeMs === stat.mtimeMs
  );
}

// ---------------------------------------------------------------------------
// Storage report

export type AudioStorageStatus =
  | 'uploaded' // local copy present, Drive copy recorded (re-verified on removal)
  | 'not-backed-up' // local copy present, no matching Drive copy recorded yet
  | 'cloud-only' // no local copy, Drive copy recorded
  | 'missing' // neither a local copy nor a recorded Drive copy
  | 'external'; // original outside the app's recordings folder: never uploaded or removed

export type AudioStorageItem = {
  /** Local path (or the path meta.audioFile names when there is no local copy). */
  path: string;
  meetings: string[];
  titles: string[];
  status: AudioStorageStatus;
  /** Local bytes when present, otherwise the Drive copy's recorded size. */
  bytes: number;
  mtimeMs?: number;
  lastUsedMs?: number;
};

type DriveCopy = {
  driveFileId: string;
  md5Checksum?: string;
  size?: number;
  driveFolderId?: string;
};

type CollectedItem = AudioStorageItem & {
  stat: fs.Stats | null;
  copies: Array<DriveCopy | null>;
};

// One entry per local audio file (shared references collapse into one), plus
// one per note whose audio exists only on Drive or outside the app folder.
function collectAudioItems(dataPath: string, state: SyncState | null): CollectedItem[] {
  const recordingsDir = recordingsDirFor(dataPath);
  const records = listLocalAudioRecords(dataPath);
  const groups = new Map<
    string,
    {
      stat: fs.Stats | null;
      refs: NoteAudioLink[];
      copies: Array<DriveCopy | null>;
      restored?: LocalAudioRecord;
    }
  >();
  const items: CollectedItem[] = [];

  for (const link of scanNoteAudioLinks(dataPath)) {
    const name = path.basename(link.audioFile);
    const drive = driveEntryFor(state, link.meeting, name);
    // A copy restored for this note under another path (a note from another
    // device, or a collision-safe numbered name because the note's own path
    // holds unrelated audio here) is the note's audio on this device. Resolve
    // it before grouping by meta.audioFile, or the restored copy would look
    // unlinked and the unrelated file would be attributed to the note.
    const restoredElsewhere = records.find(
      (r) =>
        !r.removedAt &&
        r.meetings?.includes(link.meeting) &&
        path.resolve(r.path) !== path.resolve(link.audioFile) &&
        fs.existsSync(r.path),
    );
    if (!restoredElsewhere && isManagedAudioPathLexical(recordingsDir, link.audioFile)) {
      const key = path.resolve(link.audioFile);
      const stat = statManagedAudio(recordingsDir, key);
      const group = groups.get(key) ?? { stat, refs: [], copies: [] };
      group.refs.push(link);
      group.copies.push(
        stat && recordedUploadMatches(drive, stat)
          ? {
              driveFileId: drive!.driveFileId,
              md5Checksum: drive!.md5Checksum,
              size: drive!.size,
              driveFolderId: drive!.driveFolderId,
            }
          : !stat && drive
            ? {
                driveFileId: drive.driveFileId,
                size: drive.size,
                driveFolderId: drive.driveFolderId,
              }
            : null,
      );
      groups.set(key, group);
      continue;
    }
    // Not an app recording here: either another device's path (restorable
    // from Drive) or an original the CLI transcribed in place.
    const restored =
      restoredElsewhere ??
      records.find(
        (r) => !r.removedAt && r.meetings?.includes(link.meeting) && fs.existsSync(r.path),
      );
    if (restored) {
      const stat = statManagedAudio(recordingsDir, restored.path);
      if (stat) {
        const key = path.resolve(restored.path);
        const group = groups.get(key) ?? { stat, refs: [], copies: [], restored };
        group.refs.push(link);
        // This note's own Drive copy: sync bookkeeping first, then the id
        // recorded when it was restored. Never another note's copy.
        const ownCopyId =
          drive?.driveFileId ??
          restored.copies?.[link.meeting] ??
          (restored.meetings?.length === 1 ? restored.driveFileId : undefined);
        const matches =
          !!ownCopyId &&
          !!restored.md5Checksum &&
          restored.size === stat.size &&
          restored.localMtimeMs === stat.mtimeMs;
        group.copies.push(
          matches
            ? {
                driveFileId: ownCopyId!,
                md5Checksum: restored.md5Checksum,
                size: restored.size,
                driveFolderId: drive?.driveFolderId,
              }
            : null,
        );
        groups.set(key, group);
        continue;
      }
    }
    items.push({
      path: link.audioFile,
      meetings: [link.meeting],
      titles: [link.title ?? link.meeting],
      status: drive ? 'cloud-only' : 'external',
      bytes: drive?.size ?? 0,
      stat: null,
      copies: [drive ? { driveFileId: drive.driveFileId, size: drive.size } : null],
    });
  }

  for (const [audioPath, group] of groups) {
    const { stat, refs, copies } = group;
    let status: AudioStorageStatus;
    if (stat) {
      status = copies.every((c) => c?.md5Checksum) ? 'uploaded' : 'not-backed-up';
    } else {
      status = copies.some((c) => c) ? 'cloud-only' : 'missing';
    }
    items.push({
      path: audioPath,
      meetings: refs.map((r) => r.meeting),
      titles: refs.map((r) => r.title ?? r.meeting),
      status,
      bytes: stat ? stat.size : (copies.find((c) => c)?.size ?? 0),
      ...(stat ? { mtimeMs: stat.mtimeMs, lastUsedMs: lastUsedMs(dataPath, audioPath, stat) } : {}),
      stat,
      copies,
    });
  }
  return items;
}

export type LocalStorageReport = {
  totalBytes: number;
  audioBytes: number;
  audioFiles: number;
  notesBytes: number;
  otherBytes: number;
  /**
   * Local audio whose every linked note has a recorded Drive copy. A hint
   * from the last sync, not a promise: removal re-verifies each copy with
   * Drive and keeps the file when anything does not match.
   */
  eligibleBytes: number;
  eligibleFiles: number;
  notBackedUpBytes: number;
  notBackedUpFiles: number;
  /** Recordings no note links to. Never removed (nothing else holds them). */
  unlinkedBytes: number;
  unlinkedFiles: number;
  cloudOnlyBytes: number;
  cloudOnlyFiles: number;
  /** Notes whose audio lives outside the app folder: never uploaded or removed. */
  externalFiles: number;
  items: AudioStorageItem[];
};

function dirBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += dirBytes(p);
      else if (entry.isFile()) total += fs.statSync(p).size;
    } catch {
      /* raced away */
    }
  }
  return total;
}

function lastUsedMs(dataPath: string, audioPath: string, stat?: fs.Stats): number {
  const record = readLocalAudioRecord(dataPath, audioPath);
  const candidates = [
    stat?.mtimeMs ?? 0,
    record?.hydratedAt ? Date.parse(record.hydratedAt) : 0,
    record?.lastUsedAt ? Date.parse(record.lastUsedAt) : 0,
  ].filter((n) => Number.isFinite(n));
  return Math.max(0, ...candidates);
}

function publicItem(item: CollectedItem): AudioStorageItem {
  const { stat: _stat, copies: _copies, ...rest } = item;
  return rest;
}

export function buildLocalStorageReport(
  dataPath: string,
  options: { syncStatePath?: string } = {},
): LocalStorageReport {
  const recordingsDir = recordingsDirFor(dataPath);
  const state = loadSyncState(options.syncStatePath ?? syncStatePathFor(dataPath));
  const items = collectAudioItems(dataPath, state);
  const linkedPaths = new Set(items.filter((i) => i.stat).map((i) => path.resolve(i.path)));

  let audioBytes = 0;
  let audioFiles = 0;
  let unlinkedBytes = 0;
  let unlinkedFiles = 0;
  try {
    for (const name of fs.readdirSync(recordingsDir)) {
      const p = path.join(recordingsDir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      audioBytes += st.size;
      if (!isManagedAudioPathLexical(recordingsDir, p)) continue;
      audioFiles++;
      if (!linkedPaths.has(path.resolve(p))) {
        unlinkedBytes += st.size;
        unlinkedFiles++;
      }
    }
  } catch {
    /* no recordings dir yet */
  }

  const sum = (status: AudioStorageStatus) =>
    items.filter((i) => i.status === status).reduce((n, i) => n + i.bytes, 0);
  const count = (status: AudioStorageStatus) => items.filter((i) => i.status === status).length;
  const notesBytes = dirBytes(path.join(dataPath, 'transcriptions'));
  const totalBytes = dirBytes(dataPath);

  return {
    totalBytes,
    audioBytes,
    audioFiles,
    notesBytes,
    otherBytes: Math.max(0, totalBytes - audioBytes - notesBytes),
    eligibleBytes: sum('uploaded'),
    eligibleFiles: count('uploaded'),
    notBackedUpBytes: sum('not-backed-up'),
    notBackedUpFiles: count('not-backed-up'),
    unlinkedBytes,
    unlinkedFiles,
    cloudOnlyBytes: sum('cloud-only'),
    cloudOnlyFiles: count('cloud-only'),
    externalFiles: count('external'),
    items: items.map(publicItem),
  };
}

// ---------------------------------------------------------------------------
// Reclaim (remove local copies)

export type ReclaimSkipReason =
  | 'not-managed'
  | 'not-linked'
  | 'not-backed-up'
  | 'drive-mismatch'
  | 'drive-unavailable'
  | 'changed'
  | 'in-use'
  | 'too-recent'
  | 'cancelled'
  | 'error';

export type ReclaimResult = {
  removed: Array<{ path: string; bytes: number }>;
  skipped: Array<{ path: string; reason: ReclaimSkipReason; detail?: string }>;
  freedBytes: number;
};

export type ReclaimOptions = {
  dataPath: string;
  driveClient: GoogleDriveClient;
  syncStatePath?: string;
  /** Specific recordings; omitted = every eligible recording. */
  paths?: string[];
  /** Only remove recordings not used for at least this many days. */
  olderThanDays?: number;
  /** In-process users the lease files cannot see (active capture, jobs). */
  isInUse?: (audioPath: string) => boolean;
  /** Checked between files; false stops the run (sign-out, setting changed). */
  shouldContinue?: () => boolean;
  dryRun?: boolean;
  now?: number;
  logger?: (msg: string) => void;
};

function isNotFound(error: unknown): boolean {
  return error instanceof GoogleDriveError && error.status === 404;
}

export async function reclaimLocalAudio(opts: ReclaimOptions): Promise<ReclaimResult> {
  const { dataPath, driveClient } = opts;
  const log = opts.logger ?? (() => {});
  const recordingsDir = recordingsDirFor(dataPath);
  const now = opts.now ?? Date.now();
  const result: ReclaimResult = { removed: [], skipped: [], freedBytes: 0 };
  const state = loadSyncState(opts.syncStatePath ?? syncStatePathFor(dataPath));
  const local = new Map(
    collectAudioItems(dataPath, state)
      .filter((i) => i.stat)
      .map((i) => [path.resolve(i.path), i] as const),
  );

  const targets = opts.paths
    ? [...new Set(opts.paths.map((p) => path.resolve(p)))]
    : [...local.keys()];

  for (const audioPath of targets) {
    const skip = (reason: ReclaimSkipReason, detail?: string) => {
      result.skipped.push({ path: audioPath, reason, ...(detail ? { detail } : {}) });
    };
    if (opts.shouldContinue && !opts.shouldContinue()) {
      skip('cancelled');
      continue;
    }
    const stat = statManagedAudio(recordingsDir, audioPath);
    if (!stat) {
      skip('not-managed');
      continue;
    }
    const item = local.get(audioPath);
    if (!item || item.meetings.length === 0) {
      skip('not-linked');
      continue;
    }
    if (opts.olderThanDays !== undefined) {
      const ageMs = now - lastUsedMs(dataPath, audioPath, stat);
      if (ageMs < opts.olderThanDays * DAY_MS) {
        skip('too-recent');
        continue;
      }
    }
    if (opts.isInUse?.(audioPath)) {
      skip('in-use');
      continue;
    }
    if (item.status !== 'uploaded' || item.stat?.mtimeMs !== stat.mtimeMs) {
      skip('not-backed-up');
      continue;
    }

    try {
      // Hash what is on disk now, then check every note's Drive copy fresh.
      const localMd5 = await md5File(audioPath);
      let verified = true;
      for (const copy of item.copies) {
        const c = copy!;
        if (c.md5Checksum !== localMd5) {
          verified = false;
          skip('changed', 'local audio changed since it was uploaded');
          break;
        }
        let remote;
        try {
          remote = await driveClient.getFile(c.driveFileId);
        } catch (error) {
          verified = false;
          skip(
            'drive-unavailable',
            isNotFound(error)
              ? 'Drive copy not found for the signed-in Google account'
              : (error as Error).message,
          );
          break;
        }
        const sizeOk = remote.size !== undefined && Number(remote.size) === stat.size;
        // The expected folder must be known and match: a copy elsewhere (or
        // one whose folder this device never recorded) does not count.
        const parentOk = !!c.driveFolderId && (remote.parents ?? []).includes(c.driveFolderId);
        if (remote.trashed || !sizeOk || remote.md5Checksum !== localMd5 || !parentOk) {
          verified = false;
          skip('drive-mismatch', 'Drive copy does not match the local audio');
          break;
        }
      }
      if (!verified) continue;
      if (opts.dryRun) {
        result.removed.push({ path: audioPath, bytes: stat.size });
        result.freedBytes += stat.size;
        continue;
      }

      // Everything the async checks above relied on is re-checked under the
      // audio lock, immediately before unlinking.
      const outcome = await withMeetingLock(audioPath, () => {
        if (opts.shouldContinue && !opts.shouldContinue()) return 'cancelled' as const;
        if (liveReadLeases(dataPath, audioPath) > 0) return 'in-use' as const;
        if (opts.isInUse?.(audioPath)) return 'in-use' as const;
        if (
          opts.olderThanDays !== undefined &&
          now - lastUsedMs(dataPath, audioPath, stat) < opts.olderThanDays * DAY_MS
        ) {
          return 'too-recent' as const;
        }
        const again = statManagedAudio(recordingsDir, audioPath);
        if (!again || again.size !== stat.size || again.mtimeMs !== stat.mtimeMs) {
          return 'changed' as const;
        }
        fs.unlinkSync(audioPath);
        updateLocalAudioRecord(dataPath, audioPath, {
          removedAt: new Date(now).toISOString(),
          meetings: item.meetings,
          driveFileId: item.copies[0]!.driveFileId,
          md5Checksum: localMd5,
          size: stat.size,
          localMtimeMs: undefined,
        });
        return 'removed' as const;
      });
      if (outcome === 'removed') {
        result.removed.push({ path: audioPath, bytes: stat.size });
        result.freedBytes += stat.size;
        log(
          `Removed local audio ${path.basename(audioPath)} (${stat.size} bytes); Drive copy kept.`,
        );
      } else {
        skip(outcome);
      }
    } catch (error) {
      skip('error', (error as Error).message);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Restore (download back from Drive)

export type RestoreResult = {
  path: string;
  /** False when a matching local copy was already present. */
  downloaded: boolean;
  bytes: number;
};

export class AudioRestoreError extends Error {
  code: 'no-audio' | 'no-drive-copy' | 'drive-unavailable' | 'verification-failed' | 'cancelled';
  constructor(code: AudioRestoreError['code'], message: string) {
    super(message);
    this.name = 'AudioRestoreError';
    this.code = code;
  }
}

/**
 * Local path that currently holds a note's audio: meta.audioFile when present,
 * otherwise a copy this device restored for the note (for example a note
 * created on another device whose absolute path does not exist here).
 */
export function resolveNoteAudioPath(
  dataPath: string,
  meeting: string,
  metaAudioFile: string | undefined | null,
): string | null {
  // A copy restored for this note is checksum-verified, so it wins over
  // whatever happens to exist at meta.audioFile on this device.
  const restored = restoredCopyFor(dataPath, meeting);
  if (restored) return restored;
  if (metaAudioFile && fs.existsSync(metaAudioFile)) return metaAudioFile;
  return null;
}

/**
 * True when `audioPath` is a copy this device restored for `meeting` and its
 * bytes are still exactly the ones verified against that meeting's Drive copy
 * at restore time. Regenerate uses it to replace the linked note even though
 * meta.audioFile names another path (the originating device's, or the path an
 * unrelated local file occupies). Anything else -- another recording, or the
 * restored copy after it changed -- is not this note's audio.
 */
export function isVerifiedRestoredCopy(
  dataPath: string,
  audioPath: string,
  meeting: string,
): boolean {
  const record = readLocalAudioRecord(dataPath, audioPath);
  if (!record || record.removedAt || !record.md5Checksum) return false;
  if (!record.meetings?.includes(meeting)) return false;
  if (record.copies && !record.copies[meeting]) return false;
  try {
    const st = fs.statSync(audioPath);
    if (!st.isFile() || (record.size !== undefined && st.size !== record.size)) return false;
    return (
      createHash('md5').update(fs.readFileSync(audioPath)).digest('hex') === record.md5Checksum
    );
  } catch {
    return false;
  }
}

function restoredCopyFor(dataPath: string, meeting: string): string | null {
  for (const record of listLocalAudioRecords(dataPath)) {
    if (record.removedAt || !record.meetings?.includes(meeting)) continue;
    try {
      const st = fs.statSync(record.path);
      if (st.isFile() && (record.size === undefined || st.size === record.size)) return record.path;
    } catch {
      /* gone */
    }
  }
  return null;
}

/**
 * Like resolveNoteAudioPath, but a file at meta.audioFile is only accepted
 * when it matches what sync recorded for this note (size and md5). A note
 * synced from another device can name a path that exists here with
 * unrelated audio; consumers that read the bytes (merge) must not use it.
 * When nothing was recorded the file is accepted as before.
 */
export async function resolveVerifiedNoteAudioPath(
  dataPath: string,
  meeting: string,
  metaAudioFile: string | undefined | null,
  options: { syncStatePath?: string } = {},
): Promise<string | null> {
  const restored = restoredCopyFor(dataPath, meeting);
  if (restored) return restored;
  if (!metaAudioFile || !fs.existsSync(metaAudioFile)) return null;
  const state = loadSyncState(options.syncStatePath ?? syncStatePathFor(dataPath));
  const entry = driveEntryFor(state, meeting, path.basename(metaAudioFile));
  if (!entry?.md5Checksum) return metaAudioFile;
  const st = fs.statSync(metaAudioFile);
  if (entry.size !== undefined && entry.size !== st.size) return null;
  return (await md5File(metaAudioFile)) === entry.md5Checksum ? metaAudioFile : null;
}

/** Note folder names whose meta.audioFile names `audioPath`. */
export function meetingsForAudio(dataPath: string, audioPath: string): string[] {
  const key = path.resolve(audioPath);
  const fromNotes = scanNoteAudioLinks(dataPath)
    .filter((l) => path.resolve(l.audioFile) === key)
    .map((l) => l.meeting);
  if (fromNotes.length > 0) return fromNotes;
  return readLocalAudioRecord(dataPath, audioPath)?.meetings ?? [];
}

/** Audio items (no directory size walk); used to annotate list rows. */
export function listAudioStorageItems(
  dataPath: string,
  options: { syncStatePath?: string } = {},
): AudioStorageItem[] {
  const state = loadSyncState(options.syncStatePath ?? syncStatePathFor(dataPath));
  return collectAudioItems(dataPath, state).map(publicItem);
}

function numberedRestorePath(recordingsDir: string, name: string, n: number): string {
  const ext = path.extname(name);
  return path.join(recordingsDir, `${path.basename(name, ext)} (${n})${ext}`);
}

function writeSidecarIfAbsent(
  dataPath: string,
  audioPath: string,
  link: { folderPath: string; title?: string },
): void {
  const dir = path.join(dataPath, METADATA_DIRNAME);
  const file = path.join(dir, `${path.basename(audioPath, path.extname(audioPath))}.json`);
  fs.mkdirSync(dir, { recursive: true });
  const payload = {
    filePath: audioPath,
    title: link.title ?? path.basename(audioPath, path.extname(audioPath)),
    timestamp: new Date().toISOString(),
    transcriptionPath: link.folderPath,
  };
  try {
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

export async function restoreLocalAudio(opts: {
  dataPath: string;
  driveClient: GoogleDriveClient;
  meetingFolder: string;
  syncStatePath?: string;
  signal?: AbortSignal;
  /** Checked before the restored file is given its name (sign-in changes). */
  shouldContinue?: () => boolean;
}): Promise<RestoreResult> {
  const { dataPath, driveClient } = opts;
  const recordingsDir = recordingsDirFor(dataPath);
  const meeting = path.basename(opts.meetingFolder);
  const folderPath = path.join(dataPath, 'transcriptions', meeting);
  const meta = readNoteMeta(folderPath);
  const audioFile = typeof meta?.audioFile === 'string' ? meta.audioFile : '';
  if (!audioFile) throw new AudioRestoreError('no-audio', 'This meeting has no source audio.');
  const name = path.basename(audioFile);
  if (!isSupportedAudioExtension(path.extname(name)) || name.startsWith('.')) {
    throw new AudioRestoreError('no-audio', 'This meeting has no source audio.');
  }

  // A copy already restored for this note was verified when it was written.
  const restoredCopy = restoredCopyFor(dataPath, meeting);
  if (restoredCopy) {
    return { path: restoredCopy, downloaded: false, bytes: fs.statSync(restoredCopy).size };
  }

  // Locate the Drive copy: sync bookkeeping first, then the meeting's Drive
  // folder by name (covers a wiped sync-state.json).
  const state = loadSyncState(opts.syncStatePath ?? syncStatePathFor(dataPath));
  let driveFileId = driveEntryFor(state, meeting, name)?.driveFileId;
  const driveFolderId = state?.meetings?.[meeting]?.driveFolderId;
  if (!driveFileId && driveFolderId) {
    const listing = await driveClient.listFolder(driveFolderId);
    driveFileId = listing.find((f) => f.name === name)?.id;
  }
  const existingAtPath = fs.existsSync(audioFile) && fs.statSync(audioFile).isFile();
  if (!driveFileId) {
    // Nothing in Drive to compare with: the file the note names is all there is.
    if (existingAtPath) {
      return { path: audioFile, downloaded: false, bytes: fs.statSync(audioFile).size };
    }
    throw new AudioRestoreError('no-drive-copy', 'No Google Drive copy of this audio was found.');
  }

  let remote;
  try {
    remote = await driveClient.getFile(driveFileId);
  } catch (error) {
    if (isNotFound(error)) {
      throw new AudioRestoreError(
        'drive-unavailable',
        'The Drive copy is not available to the signed-in Google account.',
      );
    }
    throw error;
  }
  if (remote.trashed) {
    throw new AudioRestoreError(
      'drive-unavailable',
      'The Drive copy is in the Google Drive trash. Restore it there first.',
    );
  }

  // A file at the note's path counts only if it is this note's audio: same
  // size and md5 as the Drive copy. Another device's path can exist here
  // holding unrelated audio; then a collision-safe download follows.
  if (
    existingAtPath &&
    remote.md5Checksum &&
    remote.size !== undefined &&
    Number(remote.size) === fs.statSync(audioFile).size &&
    (await md5File(audioFile)) === remote.md5Checksum
  ) {
    return { path: audioFile, downloaded: false, bytes: fs.statSync(audioFile).size };
  }

  const content = await driveClient.downloadFile(driveFileId, { signal: opts.signal });
  opts.signal?.throwIfAborted();
  const md5 = md5Buffer(content);
  if (
    (remote.size !== undefined && Number(remote.size) !== content.length) ||
    (remote.md5Checksum !== undefined && remote.md5Checksum !== md5)
  ) {
    throw new AudioRestoreError(
      'verification-failed',
      'The downloaded audio did not match the Drive copy. Nothing was changed.',
    );
  }

  fs.mkdirSync(recordingsDir, { recursive: true });
  // Hidden, non-audio name: the recordings list and watcher ignore it, and a
  // crash leaves only a temp file, never a partial recording.
  const tmp = path.join(recordingsDir, `.restore-${randomUUID()}.part`);
  const fd = fs.openSync(tmp, 'wx');
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  try {
    const preferred = isManagedAudioPathLexical(recordingsDir, audioFile)
      ? path.resolve(audioFile)
      : path.join(recordingsDir, name);
    // Claim a destination under its audio lock. An existing file is adopted
    // only when it holds exactly these bytes (checked under the lock);
    // anything else keeps its name and the next free name is tried.
    let target = preferred;
    for (let attempt = 2; ; attempt++) {
      const claimed = await withMeetingLock(target, async () => {
        if (opts.shouldContinue && !opts.shouldContinue()) {
          throw new AudioRestoreError(
            'cancelled',
            'Download cancelled: the Google sign-in changed.',
          );
        }
        if (fs.existsSync(target)) {
          const lst = fs.lstatSync(target);
          if (!lst.isFile() || lst.isSymbolicLink() || (await md5File(target)) !== md5) {
            return false;
          }
        } else {
          // link() claims the name atomically; it fails instead of overwriting.
          fs.linkSync(tmp, target);
        }
        const existing = readLocalAudioRecord(dataPath, target);
        const sameBytes = existing?.md5Checksum === md5;
        // A shared copy keeps every note that uses it, each with its own
        // Drive copy.
        const meetings = [...new Set([...(sameBytes ? (existing.meetings ?? []) : []), meeting])];
        const copies: Record<string, string> = {
          ...(sameBytes ? existing.copies : undefined),
          [meeting]: driveFileId!,
        };
        updateLocalAudioRecord(dataPath, target, {
          removedAt: undefined,
          hydratedAt: new Date().toISOString(),
          meetings,
          copies,
          driveFileId,
          md5Checksum: md5,
          size: content.length,
          localMtimeMs: fs.statSync(target).mtimeMs,
        });
        return true;
      });
      if (claimed) break;
      // Same order every time, so an earlier restore of these bytes under a
      // numbered name is adopted rather than duplicated.
      target = numberedRestorePath(recordingsDir, name, attempt);
    }
    writeSidecarIfAbsent(dataPath, target, {
      folderPath,
      title: typeof meta?.title === 'string' ? meta.title : undefined,
    });
    return { path: target, downloaded: true, bytes: content.length };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Removes temp files a crashed restore left behind (older than an hour). */
export function cleanupRestoreTemps(dataPath: string, now = Date.now()): void {
  const dir = recordingsDirFor(dataPath);
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith('.restore-') || !name.endsWith('.part')) continue;
      const p = path.join(dir, name);
      try {
        if (now - fs.statSync(p).mtimeMs > 60 * 60 * 1000) fs.rmSync(p, { force: true });
      } catch {
        /* raced away */
      }
    }
  } catch {
    /* nothing to clean */
  }
}
