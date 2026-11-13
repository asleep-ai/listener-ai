# Local storage and Google Drive backed audio

Listener.AI works like a conventional cloud storage app for recording audio:
notes always stay on the device, and audio that is safely in Google Drive can
be removed locally and downloaded again on demand.

## What is stored where

| Data | Location | Synced |
|---|---|---|
| Recordings (audio) | `<dataPath>/recordings/` | Linked recordings upload into their meeting's Drive folder |
| Notes | `<dataPath>/transcriptions/<folder>/` | Yes, every file except `live-hints.json` |
| Recording sidecars | `<dataPath>/metadata/` | No |
| Local audio records | `<dataPath>/local-audio/<hash>.json` | No (device-local) |
| Read leases | `<dataPath>/.listener-audio-leases/` | No |

A note links its recording through `meta.audioFile`. Only "managed" audio is
ever uploaded as source audio or removed: a regular file (not a symlink)
directly inside `recordings/` with an audio extension. Audio the CLI
transcribed where it was (`listener <file>` on a file elsewhere) is never
uploaded or removed. Legacy v1 notes are migrated at startup and behave the
same once they have `meta.audioFile`.

## Backup (sync)

Each sync uploads a note's managed recording into `Listener.AI/<meeting>/`
under the file's name and records the md5 and size of exactly the bytes sent.
If Drive's returned checksum or size differs, the sync reports an error and
nothing counts as backed up. Unchanged audio is not uploaded again. Notes that
share one recording each get their own copy in their meeting folder.

## Freeing space

- **Manually**: a recording row's "Remove local copy…", Settings >
  Integrations > Storage on this device > "Free up space now", or
  `listener storage free <ref>... | --all`.
- **Automatically**: "Remove audio from this device automatically"
  (`audioOffloadAfterDays`). Default is Never. When set to N days, the app
  removes audio not used for N days after each automatic sync. "Used" is the
  latest of the file's modification time, its last download from Drive, and
  its last read (transcription, merge, export). Downloading a recording
  therefore restarts its clock.

Before removing a file, Listener.AI requires:

1. every note that links the file to have a recorded copy from the last sync;
2. fresh Drive metadata for each copy: not trashed, inside that note's Drive
   folder, and the same size and md5 as the local file hashed right now;
3. no read lease from the app or the CLI, and nothing in the app recording,
   remuxing, transcribing, or merging it;
4. under the audio's lock, immediately before unlinking: the same size and
   mtime, no lease, still unused for the retention window, and the same Google
   session the run started under.

Removal deletes only the local file. The note, its sidecar, and the Drive copy
are untouched, and the next sync keeps treating the audio as cloud-only: it is
neither uploaded again nor deleted on Drive. Deleting a meeting (Delete…) is a
separate action that still removes the note and propagates as a tombstone.

Recordings without a saved meeting have no Drive copy and always stay.

## Downloading again

Cloud-only recordings stay in the list marked "In Google Drive, not on this
device". "Download audio", and any action that needs the file (regenerate,
merge, export as M4A, show in Finder), downloads it first. The CLI's
`listener storage restore <ref>` does the same, and `listener merge`
downloads cloud-only sources automatically.

A download is written to a hidden temp file, checked against Drive's size and
md5, and only then given its name with `link()`, which never replaces an
existing file. If the name is taken by different audio (a note from another
device whose basename collides), the copy is saved as `name (2).ext` and so
on; the same bytes already present are reused. A note from another device
gets a sidecar linking the restored file so it appears as a recording. A file
that already exists at the note's own path is used only when it matches the
Drive copy byte for byte (same size and md5); a note synced from another
device can name a path that exists here with unrelated audio, and then the
note's audio is downloaded under a numbered name instead. Merge applies the
same check before reading a source, and neither sync nor `listener google
upload` sends such an unrelated file over the other device's Drive copy
(upload also refuses to replace a Drive copy with different bytes unless this
device uploaded that copy itself). Notes that share one restored file
each keep their own Drive copy, and removal verifies every one of them. A
cancelled or failed download leaves nothing behind (stale temps older than an
hour are cleaned up).

## Accounts and other processes

Drive work in the app and in the CLI storage commands is bound to the Google
sign-in it started under. The credentials and that session come from one read
of config.json, so a sign-out or switch made by another process before the
operation starts is honored, not just one made during it. Signing out or
switching accounts cancels removal and downloads in progress.

Every write of the stored Google sign-in -- sign-in, sign-out, and saving
refreshed tokens, in the app and in every CLI command (`google login`,
`logout`, `upload`, `sync`, `storage`, `merge`) -- takes one shared
cross-process lock (`withGoogleCredentialLock`, a lock file under
`<dataPath>/.listener-meeting-locks/`). Refreshed tokens are compared and
written inside that lock: they are saved only if config.json still holds a
stored sign-in of the same account, so a sign-out or switch in another
process either happens first (and the refresh is dropped) or waits for the
refresh to finish (and then replaces it). Env-only credentials are never
persisted. Re-signing in to the same account
elsewhere does not cancel anything: its Drive copies stay readable.
If the signed-in account cannot see a Drive copy (404), nothing is removed and
the download explains that the copy is not available to the current account.

## Known limits

- The CLI does not apply the automatic setting; use
  `listener storage free --all --older-than <days>`.
- Another device keeps its own copies; removing audio on one device never
  affects another.
- If a Drive copy is deleted outside Listener.AI after the local copy was
  removed, the audio cannot be restored. The report still lists it as in
  Google Drive, and a download fails with a message instead of changing
  anything.
