// Ties Drive work to the Google sign-in it started under. A sync, local audio
// removal, restore, or token refresh that began as account A must not keep
// acting (or write A's tokens back) after the user signed out or switched to
// account B -- not even after switching back to A, since a sign-in is a new
// session. The generation changes on every sign-in and sign-out in this
// process. Across processes the account key is compared against the sign-in
// persisted in config.json (callers pass a reader that re-reads the file), so
// a CLI sign-out or switch to another account stops the work. A CLI re-sign-in
// to the same account does not: the Drive copies stay readable by it.

import * as path from 'path';
import { withMeetingLock } from '../meetingLock';

export type GoogleSession = { generation: number; accountKey: string };

/**
 * Cross-process lock (app and CLI) around every write of the stored Google
 * sign-in: sign-in, sign-out, and refreshed-token write-back. A refresh
 * compares the stored account and writes under it, so a sign-out or switch
 * in another process lands either entirely before (the compare fails) or
 * entirely after (it replaces the refreshed tokens) -- never in between,
 * which would resurrect the signed-out account.
 */
export function withGoogleCredentialLock<T>(
  dataPath: string,
  action: () => T | Promise<T>,
): Promise<T> {
  // withMeetingLock keys a lock file under <dataPath>/.listener-meeting-locks.
  return withMeetingLock(path.join(dataPath, '.google-oauth', 'credentials'), action);
}

type Credentials = { email?: string; refresh: string } | undefined | null;

export function googleAccountKey(credentials: Credentials): string | null {
  if (!credentials) return null;
  return credentials.email || credentials.refresh || null;
}

export class GoogleSessionTracker<C extends { email?: string; refresh: string }> {
  private generation = 0;

  /**
   * `currentCredentials` reads the sign-in as persisted now (stored or env).
   * `storedCredentials` reads only what is stored; refreshed tokens are
   * written back only over a stored sign-in of the same account.
   */
  constructor(
    private readonly currentCredentials: () => C | undefined | null,
    private readonly storedCredentials: () => C | undefined | null = currentCredentials,
    /** Serializes the compare-and-write (withGoogleCredentialLock in the app and CLI). */
    private readonly credentialLock: <T>(action: () => T | Promise<T>) => Promise<T> = async (
      action,
    ) => action(),
  ) {}

  /** Call on every sign-in and sign-out. Returns the new generation. */
  bump(): number {
    return ++this.generation;
  }

  /**
   * One persisted read yielding both the credentials to use and the session
   * they belong to, so a client can never carry one account's tokens under
   * another account's session. Null when signed out.
   */
  snapshot(): { credentials: C; session: GoogleSession } | null {
    const credentials = this.currentCredentials();
    const accountKey = googleAccountKey(credentials);
    if (!credentials || !accountKey) return null;
    return { credentials, session: { generation: this.generation, accountKey } };
  }

  /** The current session, or null when signed out. */
  capture(): GoogleSession | null {
    return this.snapshot()?.session ?? null;
  }

  isCurrent(session: GoogleSession | null): boolean {
    if (!session) return false;
    return (
      session.generation === this.generation &&
      googleAccountKey(this.currentCredentials()) === session.accountKey
    );
  }

  /**
   * Refreshed tokens are written back only while the session that refreshed
   * them is still current and a stored sign-in of that same account exists;
   * otherwise a slow refresh would overwrite (or resurrect) another sign-in,
   * or persist env-only credentials.
   */
  persistRefreshed<T>(
    session: GoogleSession | null,
    next: T,
    write: (next: T) => void,
  ): Promise<boolean> {
    return this.credentialLock(() => {
      if (!this.isCurrent(session)) return false;
      if (googleAccountKey(this.storedCredentials()) !== session!.accountKey) return false;
      write(next);
      return true;
    });
  }
}
