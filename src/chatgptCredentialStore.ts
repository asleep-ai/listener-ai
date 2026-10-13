import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// On-disk store for Sign in with ChatGPT. Layout under `<root>/`:
//
//   host.json              { version, extAgentHostId } -- one per install, never rotated
//   profiles.json          registration index: issued client IDs, verified
//                          identities, the active profile. Never holds tokens.
//   credentials/<id>.json  one protected token record per registration
//   locks/                 proper-lockfile lock files (index, one per profile)
//
// Every file is written atomically (temp file + rename) with mode 0600, and the
// Electron app and the CLI serialize writers through cross-process locks.

const lockfile = require('proper-lockfile') as {
  lock: (
    file: string,
    options: {
      realpath: false;
      lockfilePath: string;
      stale: number;
      retries: number;
      onCompromised: (error: Error) => void;
    },
  ) => Promise<() => Promise<void>>;
};

const STORE_VERSION = 1;
const PROFILE_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const HOST_ID_PATTERN =
  /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type ChatGPTRegistration = {
  id: string;
  // Issued client ID (never `dynamic_agent_client`).
  clientId: string;
  // A pending registration has an issued client ID but no validated identity
  // yet: it is persisted before the code exchange so a failed exchange can be
  // retried with the same client, and it is never listed or made active.
  pending?: boolean;
  subject?: string;
  issuer?: string;
  email?: string;
  createdAt: number;
};

export type ChatGPTIndex = {
  version: typeof STORE_VERSION;
  activeProfileId?: string;
  registrations: ChatGPTRegistration[];
};

export type ChatGPTCredentialRecord = {
  version: typeof STORE_VERSION;
  profileId: string;
  clientId: string;
  subject: string;
  issuer: string;
  email?: string;
  extAgentHostId: string;
  // Retained for `id_token_hint`; dropped on sign-out.
  idToken?: string;
  // Absent once a terminal refresh error cleared the session.
  sessionId?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenType?: string;
  expiresAt?: number;
  earliestRefreshAt?: number;
  scopes: string[];
  savedAt: number;
};

export class ChatGPTStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatGPTStoreError';
  }
}

export type ChatGPTStoreOptions = {
  lockRetryMs?: number;
  lockTimeoutMs?: number;
};

export class ChatGPTCredentialStore {
  private readonly lockRetryMs: number;
  private readonly lockTimeoutMs: number;

  constructor(
    readonly root: string,
    options: ChatGPTStoreOptions = {},
  ) {
    this.lockRetryMs = options.lockRetryMs ?? 100;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 60_000;
  }

  private get indexFile(): string {
    return path.join(this.root, 'profiles.json');
  }

  private get hostFile(): string {
    return path.join(this.root, 'host.json');
  }

  private credentialFile(profileId: string): string {
    assertProfileId(profileId);
    return path.join(this.root, 'credentials', `${profileId}.json`);
  }

  readIndex(): ChatGPTIndex {
    const raw = readJsonFile(this.indexFile);
    if (raw === undefined) return { version: STORE_VERSION, registrations: [] };
    if (!isRecord(raw) || raw.version !== STORE_VERSION || !Array.isArray(raw.registrations)) {
      throw new ChatGPTStoreError('ChatGPT profile index is unreadable.');
    }
    const registrations = raw.registrations.filter(isRegistration);
    const activeProfileId =
      typeof raw.activeProfileId === 'string' ? raw.activeProfileId : undefined;
    return { version: STORE_VERSION, activeProfileId, registrations };
  }

  writeIndex(index: ChatGPTIndex): void {
    writeJsonAtomic(this.indexFile, index);
  }

  readHostId(): string | undefined {
    const raw = readJsonFile(this.hostFile);
    if (raw === undefined) return undefined;
    if (
      !isRecord(raw) ||
      typeof raw.extAgentHostId !== 'string' ||
      !HOST_ID_PATTERN.test(raw.extAgentHostId)
    ) {
      // Never silently mint a replacement: the host ID is a stable identity.
      throw new ChatGPTStoreError('ChatGPT host identity file is unreadable.');
    }
    return raw.extAgentHostId;
  }

  // Call only while holding the index lock.
  ensureHostIdLocked(create: () => string): string {
    const existing = this.readHostId();
    if (existing) return existing;
    const hostId = create();
    if (!HOST_ID_PATTERN.test(hostId)) throw new ChatGPTStoreError('Invalid host identity.');
    writeJsonAtomic(this.hostFile, { version: STORE_VERSION, extAgentHostId: hostId });
    return hostId;
  }

  readCredentials(profileId: string): ChatGPTCredentialRecord | undefined {
    let raw: unknown;
    try {
      raw = readJsonFile(this.credentialFile(profileId));
    } catch {
      return undefined;
    }
    if (!isRecord(raw) || raw.version !== STORE_VERSION) return undefined;
    if (
      raw.profileId !== profileId ||
      typeof raw.clientId !== 'string' ||
      typeof raw.subject !== 'string' ||
      typeof raw.issuer !== 'string' ||
      typeof raw.extAgentHostId !== 'string' ||
      !Array.isArray(raw.scopes)
    ) {
      return undefined;
    }
    return raw as ChatGPTCredentialRecord;
  }

  writeCredentials(record: ChatGPTCredentialRecord): void {
    writeJsonAtomic(this.credentialFile(record.profileId), record);
  }

  deleteCredentials(profileId: string): void {
    fs.rmSync(this.credentialFile(profileId), { force: true });
  }

  withIndexLock<T>(action: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    return this.withLock('index', action, signal);
  }

  withProfileLock<T>(
    profileId: string,
    action: () => Promise<T> | T,
    signal?: AbortSignal,
  ): Promise<T> {
    assertProfileId(profileId);
    return this.withLock(`profile-${profileId}`, action, signal);
  }

  // Cross-process mutual exclusion. proper-lockfile is not reentrant, so a
  // caller must never take the same lock twice, and must never take a profile
  // lock while holding the index lock (profile -> index is the only order).
  private async withLock<T>(
    name: string,
    action: () => Promise<T> | T,
    signal?: AbortSignal,
  ): Promise<T> {
    const lockDir = path.join(this.root, 'locks');
    ensureDir(lockDir);
    const lockfilePath = path.join(lockDir, `${name}.lock`);
    const deadline = Date.now() + this.lockTimeoutMs;
    let release: () => Promise<void>;
    for (;;) {
      signal?.throwIfAborted();
      try {
        release = await lockfile.lock(path.join(lockDir, name), {
          realpath: false,
          lockfilePath,
          stale: 30_000,
          retries: 0,
          // The default handler throws asynchronously and would crash the
          // process. A compromised lock only weakens serialization; the
          // refresh path rereads the record under the lock anyway.
          onCompromised: () => {},
        });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ELOCKED' || Date.now() >= deadline)
          throw error;
        await delay(this.lockRetryMs, signal);
      }
    }
    try {
      return await action();
    } finally {
      await release().catch(() => {});
    }
  }
}

function assertProfileId(profileId: string): void {
  if (!PROFILE_ID_PATTERN.test(profileId))
    throw new ChatGPTStoreError('Invalid ChatGPT profile id.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRegistration(value: unknown): value is ChatGPTRegistration {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    PROFILE_ID_PATTERN.test(value.id) &&
    typeof value.clientId === 'string' &&
    value.clientId.length > 0 &&
    typeof value.createdAt === 'number' &&
    (value.pending === true || typeof value.subject === 'string')
  );
}

function readJsonFile(file: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ChatGPTStoreError(`${path.basename(file)} is not valid JSON.`);
  }
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// Temp file in the same directory, fsync, then rename: readers in another
// process see either the old or the new record, never a partial write. The
// temp file is created 0600 so tokens are never briefly world-readable.
function writeJsonAtomic(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
