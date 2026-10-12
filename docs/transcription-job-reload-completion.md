# Reload-safe transcription jobs: completion report

## Outcome

Batch transcription and merge jobs are now owned by the main process
(`src/transcriptionJobs.ts`). If the renderer goes away while main keeps
running, the job keeps running and the UI reconnects to it. That covers a
reload, a renderer crash followed by a reload, a window close and reactivate,
and a recording-list rebuild. Quitting the whole app is out of scope: jobs
live in main-process memory only and are not resumed on the next launch.

The pipeline-level description is in
[transcription-pipeline.md](transcription-pipeline.md), section "0. Entry".

## Behaviour

| Area | Behaviour |
| --- | --- |
| Job ownership | Main owns admission, progress, cancellation, results, and the configured auto-mode Notion/Slack follow-ups. The renderer rebuilds row progress and Cancel, the auto-mode status, and the merge modal from a snapshot plus revisioned events (`src/transcriptionJobView.ts`, `renderer/ui/transcription-jobs.ts`). |
| Duplicate requests | A duplicate request joins the running job and never aborts or restarts it. That includes a request made while the job's cancel is still rolling back: it gets the same cancelled result. A new run starts only after the job ends. |
| Path identity | A job is identified by the resolved path and the path the filesystem reports for it (symlinks resolved). For a file that does not exist yet, that is the real parent directory plus the name. Unicode normalization is never inferred. Each path belongs to at most one running job. |
| Untitled rename | A name that already holds a file, or that another running job owns or has reserved, is refused without touching the filesystem. Otherwise the new name is reserved privately: it is not listed, not emitted, and nothing joins or cancels through it. A request or cancel for that name waits until the move settles. The reservation becomes one of the job's paths once the file is ours (hard link created, or exclusive copy finished). If the move fails, the reservation is dropped. |
| Rename and rollback | Neither ever replaces another file. The destination is claimed with `link`, or with `COPYFILE_EXCL` where hard links are unsupported, and only then is the old name removed. If the rollback is blocked, the audio stays at the renamed path and the response carries `newFilePath`. |
| Cancel and save | Cancel works until the note is saved. After that it returns `reason: 'committed'`. |
| Merge | Merge is still single-flight with `merge-busy`. A refused second merge leaves the modal alone. |
| Renderer store | The renderer keeps at most 20 finished jobs. Tombstones stop late events from reviving a dropped job, and so does a revision floor once a tombstone rolls off. No tombstone is dropped before the one load snapshot has been applied or its request has failed. |
| Row display | A row whose job holds the note lock is drawn without waiting for the lock. The list is reconciled with disk whenever a job ends. A row bound through a path the job no longer answers to goes back to its own state. |

## Compatibility

Every change is additive:
- `aliases` on snapshots and on `get-recordings` items
- `jobId`, `joined` and `exports` on results
- `reason: 'committed'`
- the optional third `transcribe-audio` argument
- the `get-transcription-jobs` and `transcription-job-changed` channels

Recording names keep the `<title>_<timestamp>` form, and a collision keeps the
original name. Persisted `meta.json` and sidecar shapes are unchanged. The CLI
and the `package.json` `files` whitelist are untouched.

## Background test infrastructure (test-only)

Product code and the packaged smoke test (`e2e/smoke.spec.ts`) use none of
this.
- `e2e/support/launch.ts` preloads `e2e/support/hidden-electron.cjs` with
  Electron's `-r` argument. Windows are created hidden and ignore show and
  focus, background throttling is off, DevTools stay closed, and the macOS
  Dock icon is hidden. Set `LISTENER_E2E_SHOW=1` to watch.
- `e2e/support/dialogs.ts` scripts `alert`, `confirm` and `prompt` and records
  every prompt. Specs assert the recorded prompts rather than raising a native
  sheet, because a native sheet would make a hidden window visible.

## Verification

The following results describe the original PR219 implementation before the
review follow-ups below. They are historical evidence, not a rerun of the latest
local corrections.

| Check | Result |
| --- | --- |
| `pnpm run build` (main and renderer), `build:check-renderer`, `lint`, `format:check`, `git diff --check` | PASS |
| `pnpm test` (unit and CLI) | 1044/1044 PASS |
| Focused suites: `transcriptionJobs.test.ts`, `transcriptionJobView.test.ts`, `ipc/transcription.jobs.test.ts` | 14/14, 11/11, 17/17 PASS |
| Hidden Electron acceptance on macOS | 30/30 PASS (detail below) |
| Independent source reviews (Codex, then a final Claude Opus review) | No blocking findings |

### Hidden Electron acceptance, macOS: 30/30 PASS

| Group | Result |
| --- | --- |
| `e2e/hidden-launch.spec.ts` | 1/1 |
| `e2e/transcription-reload.spec.ts`: reload, list rebuild, duplicate request, Cancel, completion, renamed-row rollback, auto-mode Notion/Slack phases, Notion failure, merge reconnect and single-flight, parallel jobs, note-lock wait, symlink canonical row, refused second merge, import fallback modal, declined import | 15/15 |
| `e2e/transcript-cutoff.spec.ts` | 2/2 |
| External lifecycle boundaries: delayed list after completion and after cancellation, renamed-row rollback while the original call is pending, abort-ignoring provider, real note-lock wait, no-watcher rollback, symlink canonical row | 7/7 |
| Renderer crash with progress while no renderer is present and reconnect from the surviving window; saved-source merge provenance | 2/2 |
| Native rename reservation: foreign destination refused before `link`; real raced `EEXIST` keeps the reservation private while the other request and Cancel wait; canonical alias promotion and canonical Cancel rollback | 3/3 |

Every case used deferred fixtures for the provider, Notion, Slack,
ffmpeg/concat and `shell.openExternal`, and blocked renderer HTTP(S). No live
provider call was made and no message was sent.

## Review follow-ups: automatic joins and modal isolation

The original implementation was authored by Claude. The following local
corrections and regressions were authored by Codex after explicit user routing
authorization; no independent review or native execution is claimed here.

- A joining automatic request promotes the existing job's observable origin and
  preserves the first automatic recording title. A main-owned finalization gate
  consumes that intent after persistence, including post-commit metadata waits,
  and runs one configured export chain. Manual-only completion settles together
  with its no-export decision.
- Every modal terminal outcome and rejection checks session ownership.
  Cancellation is silent, stale success still refreshes the list, button cleanup
  remains unconditional, and ffmpeg recovery/retry checks ownership at each
  asynchronous boundary.

| Follow-up check | Result |
| --- | --- |
| Baseline regressions before product edits | 8 FAIL / 18 PASS across the IPC and modal suites: early and post-commit auto promotion; stale failure, cancellation, rejection, ffmpeg failure/recovery; current-session cancellation |
| Latest `pnpm test` | 1056/1056 PASS |
| `pnpm run build`, `build:check-renderer`, `lint`, `format:check`, `git diff --check` | PASS |
| New hidden Electron cases in `e2e/transcription-reload.spec.ts` | 7 authored, NOT-RUN pending separate executor |
| Playwright discovery (`--list`) | 22 cases discovered, including all 7 new cases; no Electron launched |
| Optional standalone strict E2E type check | Blocked by two existing diagnostics in `e2e/support/launch.ts` and the pre-existing saved-source fixture; no new-case diagnostics |
| Independent review, signed commit, push, CI, squash merge | Pending coordinator |

New native acceptance covers manual-first automatic joins before provider
completion and after commit, alias repeats, reload restoration, exactly-once
Notion/Slack export, and stale modal failure/cancellation/IPC rejection/ffmpeg
recovery. Run `pnpm exec playwright test e2e/transcription-reload.spec.ts` after
building, using the existing hidden launcher and scripted dialogs. The earlier
30-case acceptance remains historical until the separate executor reruns it.

## Not run and known limits

| Item | Status |
| --- | --- |
| Whole-app quit and resume | Out of scope: jobs live in main-process memory only |
| Native JavaScript dialog appearance and focus | NOT RUN (background runs use scripted dialogs) |
| Packaged app smoke test | NOT RUN |
| Native Linux and Windows: the `COPYFILE_EXCL` path on a filesystem without hard links, and Unicode identity on a normalization-sensitive filesystem | NOT RUN (unit and IPC tests only) |
| Live provider transcription and real Notion/Slack delivery | NOT RUN |

Known and deferred:
- A manual and an automatic Notion upload of the same note can still create
  two pages. This predates the change and is unchanged.
- When a transcription started through the modal fallback (an import whose
  row is not listed) fails, the user sees both the error dialog and a
  "Failed to transcribe" toast. This is cosmetic and left for a follow-up.
