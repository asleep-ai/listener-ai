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
      retries: { retries: number; factor: number; minTimeout: number; maxTimeout: number };
    },
  ) => Promise<() => Promise<void>>;
};

export async function withMeetingLock<T>(
  folderPath: string,
  action: () => Promise<T> | T,
): Promise<T> {
  const key = path.resolve(folderPath);
  const lockDir = path.join(path.dirname(path.dirname(key)), '.listener-meeting-locks');
  fs.mkdirSync(lockDir, { recursive: true });
  const lockfilePath = path.join(lockDir, `${createHash('sha256').update(key).digest('hex')}.lock`);
  const release = await lockfile.lock(key, {
    realpath: false,
    lockfilePath,
    stale: 30_000,
    retries: { retries: 240, factor: 1, minTimeout: 50, maxTimeout: 500 },
  });
  try {
    return await action();
  } finally {
    await release();
  }
}
