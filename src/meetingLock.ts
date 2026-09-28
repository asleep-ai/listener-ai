import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// The CLI and Electron can run at the same time. Keep each multi-file read,
// Drive sync, and note replacement exclusive across both processes.
const lockfile = require('proper-lockfile') as {
  lock: (
    file: string,
    options: {
      realpath: false;
      lockfilePath: string;
      stale: number;
      retries: number;
    },
  ) => Promise<() => Promise<void>>;
};

export async function withMeetingLock<T>(
  folderPath: string,
  action: () => Promise<T> | T,
  options: { signal?: AbortSignal; allowUnlockedReadOnly?: boolean } = {},
): Promise<T> {
  const key = path.resolve(folderPath);
  const lockDir = path.join(path.dirname(path.dirname(key)), '.listener-meeting-locks');
  try {
    fs.mkdirSync(lockDir, { recursive: true });
  } catch (error) {
    if (options.allowUnlockedReadOnly && isReadOnlyError(error)) return action();
    throw error;
  }
  const lockfilePath = path.join(lockDir, `${createHash('sha256').update(key).digest('hex')}.lock`);
  const deadline = Date.now() + 15 * 60_000;
  let release: () => Promise<void>;
  for (;;) {
    options.signal?.throwIfAborted();
    try {
      release = await lockfile.lock(key, {
        realpath: false,
        lockfilePath,
        stale: 30_000,
        retries: 0,
      });
      break;
    } catch (error) {
      if (options.allowUnlockedReadOnly && isReadOnlyError(error)) return action();
      if ((error as NodeJS.ErrnoException).code !== 'ELOCKED' || Date.now() >= deadline) {
        throw error;
      }
      await waitForRetry(options.signal);
    }
  }
  try {
    options.signal?.throwIfAborted();
    return await action();
  } finally {
    await release();
  }
}

function isReadOnlyError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
}

function waitForRetry(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(done, 250);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason ?? new Error('Meeting lock wait cancelled'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
