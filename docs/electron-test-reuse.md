# Electron test session reuse

The behavioral suites keep one main process per compatible group, with its
hidden native windows in fixed roles: the main window and, once a recording
has started, the hidden capture host (`src/captureHost.ts`). Every window must
stay hidden, unfocused and non-focusable, each role keeps a stable ID, and no
other window may appear; a replaced window must be adopted explicitly. They reload the renderer between cases. Development and
packaged artifacts never share a process.

| Project         |     Cases | Process lifetime                | State reset                                                                                         |
| --------------- | --------: | ------------------------------- | --------------------------------------------------------------------------------------------------- |
| settings        |         5 | One development process         | Raw config, client caches, renderer, synthetic files                                                |
| meeting-list    |         5 | Dev, or packaged (see below)    | Saved-note fixtures, config, renderer                                                               |
| cutoff          |         2 | One development process         | Saved-note fixtures, config, renderer                                                               |
| reload          |        25 | One development process         | Deferred jobs and exports, reservations, locks, IPC and provider overrides, renderer                |
| live            |         9 | One development process         | Synthetic live capture, providers, config, renderer                                                 |
| recording       |         3 | Dev, or packaged                | Synthetic capture, recordings, config, renderer                                                     |
| recording-window|         3 | Fresh process each, dev or pkg  | Main window destroyed and recreated: recording, OpenAI Realtime WebRTC loopback, queued Settings     |
| recording-quit  |         2 | Fresh process each, dev or pkg  | Real app.quit(): with a stalled live tail, and after a stop the capture host never confirmed        |
| chatgpt         |        22 | One packaged process            | Pending sign-in/preflight, auth and agent overrides, global fetch, IPC, raw config, synthetic files |
| chatgpt-startup |         4 | Fresh packaged process per case | Independent startup configuration                                                                   |
| hidden-startup  |         1 | Fresh development process       | Hidden construction contract                                                                        |
| package-smoke   |         1 | Fresh packaged process          | Packaged boot contract                                                                              |
| settings-shots  | 1, opt-in | Fresh development process       | Independent screenshot evidence                                                                     |

The normal run discovers 83 cases and expects 18 process launches (one fewer on Windows/Linux, where the menu Settings case does not apply), with the
optional screenshot case skipped. Enabling `LISTENER_E2E_SHOTS` adds one launch.
These are expected budgets, not execution evidence.

meeting-list runs in one development process unless `LISTENER_SMOKE_BUILD_DIR`
is set; then the same cases, including the fake-Drive storage cases, run in one
packaged process. Its seeds use `synthetic-unused-key` and, for the signed-in
Drive case, the fixed `SYNTHETIC_GOOGLE_OAUTH` sign-in, which
`assertPackagedSeed` accepts only with `googleDriveEnabled: false`. CI
package-check runs it against the Linux unpacked build; the manually dispatched
macOS test build runs it against the `.app` staged for the uploaded DMG. Both
jobs upload `test-results/` (coverage, launch summary, per-case
`native-proof.json`) as an artifact named with the commit SHA.

## Commands

Run `pnpm run test:e2e:harness` and `pnpm run test:e2e:types` without launching
Electron. The lifecycle harness uses synthetic reset implementations and negative
controls: omitting cleanup leaves dirty fixtures, while applying cleanup passes
the generic isolation assertions. Actual module, IPC and job restoration is
verified by the native suites.

After building main and renderer, set `LISTENER_SMOKE_BUILD_DIR` to an external
unpacked build and run `pnpm run test:e2e`. Existing CI selectors for smoke and
cutoff still select only their respective projects. `--list` discovers cases
without launching an app. Ordinary runs reject `LISTENER_E2E_SHOW=1`.

`test-results/coverage.json` lists every selected case, its shared/fresh reason,
execution status and reset proof. `launch-summary.json` records owned PIDs and
launch counts. Missing or repeated launches, changed PIDs, or missing successful
shared-case resets fail the run. Retries are disabled. A dirty worker cannot
silently launch a replacement shared process.
The first failed case stops the run (`maxFailures: 1`). Packaged native snapshots
are written synchronously to each case's `native-proof.json` before an invariant
failure is thrown or the owned process is closed. The evidence directory is
outside the disposable application data root.

## Isolation and ownership

The helper keeps a fixed temporary data root because main-process singletons
cache paths. Each case seeds synthetic data; cleanup waits for cancellable jobs,
committed exports and tracked IPC calls before removing those files. Finished
job records are cleared only after settlement; listeners and revision counters
remain intact.

Warm case seeds use the existing config load and migration methods on the same
singleton; cleanup restores the raw seed after settlement. Startup contracts
remain fresh processes.

The test harness restores the original IPC handlers, module/prototype overrides,
auth methods and global fetch. Existing config IPC invalidates client caches,
then the exact raw seed is restored in memory and on disk. Every successful
shared cleanup checks active jobs, pending IPC, config equality, mock identity,
empty fixture directories and the same single hidden, unfocused native window.
No production reset IPC is added.

The development test-only preload uses the native BrowserWindow constructor
through a Proxy, retaining real window enumeration. It denies native dialogs,
external opens, permission requests and unmocked provider fetches before app code.
Packaged runs retain the actual executable and ASAR entry point: they preflight
product background support and synthetic startup inputs, verify the initial
native window and Dock state without correcting them, then install a mandatory
effect recorder and blockers before case interactions. The packaged dialog
replacement remains the product's own preload contract.
Credential environment overrides are removed. The user's HOME and installed
application are unchanged. Shutdown targets only the owned child process, never
all Electron or Node processes by name.

## Evidence limits

This change reduces repeated process launches. It does not identify the previous
input/focus interference or prove continuous absence of OS activation. The
packaged recorder observes only the period after installation; the earlier boot
interval relies on product source preflight and the first native observation.
Native
permissions, real audio, live provider accounts and updater installation remain
separate validation. Two-order native execution is deferred; reuse across
different groups must not be expanded before that check.

The pure Node watcher regression passes: child-only cleanup preserves the watched
directory inode and an existing `fs.watch` receives new recording events after
both reset modes. This does not establish automatic Electron watcher delivery.
The refused-second-merge modal ownership case refreshes the list through the
existing search Escape action while its first merge remains pending; it retains
the merged-row, second-merge refusal and closed-modal assertions. Automatic
Electron watcher delivery remains a separate verification limit.

## Verification on 2026-10-13

| Check                                                                         | Actual result                                                           |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Existing unit/CLI suite                                                       | 1,234 PASS in the earlier build validation; production source unchanged |
| Pure Node lifecycle and native-guard harness                                  | 62 PASS, 0 FAIL                                                         |
| Targeted helper/reporter types, lint, format and diff checks                  | PASS                                                                    |
| Final native suite                                                            | 57 PASS, 1 existing opt-in SKIP, 0 FAIL; 58 selected                    |
| Native process budget and reset proof                                         | 10 launches; 51 verified shared resets; no replacement launches         |
| Packaged native evidence                                                      | 27 per-case proofs with matching fields and empty effect ledgers        |
| Owned main-process cleanup                                                    | All 10 recorded PIDs exited; no synthetic session roots remained        |
| Reverse-order native run, live providers, real audio and updater installation | NOT-RUN                                                                 |

The final native run used Node 24.13.0 and Electron 43.3.0 with an unsigned
external package. Its ASAR SHA256 was
`330d7523b783dff239b2c06808f579ee18ed67c93abeb11eede6082512f88239`.
The executor verified frozen source hashes before and after execution.
Descendant processes were not independently inventoried.

An earlier native run remains **45 PASS / 12 FAIL / 1 SKIP**, including a native
window or Dock invariant failure whose changed field was not recorded at that
time. Its cause remains unresolved. After adding persisted diagnostics, the
standalone case, original eleven-case prefix and final full run did not reproduce
it. The final PASS does not reclassify the earlier failure or prove that the
previous input interference has been fixed.

Execution evidence and review results are recorded in the pull request.

## Saved-meeting list limits

Only a recording sidecar's linked transcription is suppressed from saved-note
rows. Independent reports sharing an audio file remain reachable, including old
or transient duplicate reports. Note-only rows do not add deletion or audio
hydration, and these tests do not establish real Drive or assistive-technology
behavior.

## Main-window replacement and quit cases

The `recording-window` cases destroy the main window and recreate it. A
packaged run re-pins the guards' main window with
`__listenerPackagedGuards.adoptMainWindow()`, which refuses while the pinned
window still exists or unless exactly one replacement main window exists, and
then re-checks every hidden-window invariant. The menu Settings case applies
only on macOS (`caseApplies` in `e2e/support/case-policy.ts`); on Windows and
Linux the same request comes from the tray, which background test mode never
creates. The `recording-quit` case ends its own process through `app.quit()`;
`closeOwnedElectron` then confirms the owned PID is gone (signal 0 probe)
instead of signalling it.
