# Electron test session reuse

The behavioral suites keep one main process and one hidden native window per
compatible group. They reload the renderer between cases. Development and
packaged artifacts never share a process.

| Project         |     Cases | Process lifetime                | State reset                                                                                         |
| --------------- | --------: | ------------------------------- | --------------------------------------------------------------------------------------------------- |
| settings        |         5 | One development process         | Raw config, client caches, renderer, synthetic files                                                |
| meeting-list    |         2 | One development process         | Saved-note fixtures, config, renderer                                                               |
| cutoff          |         2 | One development process         | Saved-note fixtures, config, renderer                                                               |
| reload          |        23 | One development process         | Deferred jobs and exports, reservations, locks, IPC and provider overrides, renderer                |
| live            |         6 | One development process         | Synthetic live capture, providers, config, renderer                                                 |
| chatgpt         |        22 | One packaged process            | Pending sign-in/preflight, auth and agent overrides, global fetch, IPC, raw config, synthetic files |
| chatgpt-startup |         4 | Fresh packaged process per case | Independent startup configuration                                                                   |
| hidden-startup  |         1 | Fresh development process       | Hidden construction contract                                                                        |
| package-smoke   |         1 | Fresh packaged process          | Packaged boot contract                                                                              |
| settings-shots  | 1, opt-in | Fresh development process       | Independent screenshot evidence                                                                     |

The normal run discovers 67 cases and expects 12 process launches, with the
optional screenshot case skipped. Enabling `LISTENER_E2E_SHOTS` adds one launch.
These are expected budgets, not execution evidence.

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
