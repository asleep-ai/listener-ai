import * as path from 'path';

// Main-process, per-note serialization of work that reads a saved report and
// publishes it (Notion upload, Slack send) against work that replaces the
// report (a transcript cutoff change).
//
// Regenerate (a linked note replaced by a re-transcription) takes the same
// queue for its save, so an export never straddles that replacement either.
//
// An export snapshots the report, waits on a remote service, then records the
// result against that snapshot's generation. A cutoff that committed inside
// that window would leave the remote copy showing text the user just
// excluded, with no record of it on the note. Running both through one queue
// per note means an export sees either the report before a cutoff (and its
// page is then marked superseded by it) or the report after it, never both.
//
// This is deliberately separate from `withMeetingLock`: that cross-process
// file lock is not reentrant, and both sides already take it internally for
// each read and write. Holding it across a remote request or a summary call
// would deadlock those inner reads and block Drive sync for minutes.
const tails = new Map<string, Promise<void>>();

/**
 * Run `action` after every earlier operation queued for the same note has
 * settled. An aborted `signal` rejects right away while still waiting, and
 * `action` is then skipped when its turn comes; once `action` has started,
 * its own result stands.
 */
export function withNoteOperation<T>(
  folderPath: string,
  action: () => Promise<T>,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const { signal } = options;
  const key = path.resolve(folderPath);
  let started = false;
  const run = (tails.get(key) ?? Promise.resolve()).then(() => {
    signal?.throwIfAborted();
    started = true;
    return action();
  });
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  if (!signal) return run;
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      if (!started) reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    run.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
