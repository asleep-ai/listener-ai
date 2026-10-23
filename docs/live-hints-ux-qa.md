# Live hint verification record

## Current production scope

The product behavior is documented in [Production live AI hints](live-ai-hints-prototype.md). It uses automatic hints, a separate five-second top popover, and recording-bound chronological history. Demo entry points and generation/preview/manual/pin/history controls are absent. The final PR checks below cover this interface. Earlier checks are retained as dated evidence only.

## Final PR checks, 2026-10-23

The final candidate was based on `74a71df` and built outside the checkout to preserve the running user app. Evidence is under `/tmp/listener-pr-review-20261023/`.

| Check | Result |
| --- | --- |
| TypeScript and Vite build | Passed |
| Full source tests | 1,418 passed, 1 failed; the same foreign-script reason mismatch was reproduced independently on unchanged `74a71df` |
| Background lifecycle/guard harness | 62 passed |
| Strict E2E types | Passed |
| Automatic popup expiry, reading pauses, announcement, and dismiss focus | 1 passed |
| Compiled responsive top popover and silent renderer recovery | 2 passed |
| Recording history through IPC, reload, and legacy compatibility | 1 passed |
| npm pack and extracted CLI help | Passed |
| Review | Independent Codex findings fixed; Opus verified all seven review fixes and found no blocking regression |

Native captures cover 1200, 820, and 390 pixel widths. Four owned hidden processes and data directories were cleaned up, source hashes matched, and protected user processes were preserved. The first 390-pixel expiry failure was retained: a tab click left the pointer over the popup, intentionally pausing expiry. The test now explicitly moves the pointer away and verifies it is not hovering before the unchanged five-second expiry assertion.

## Bounded Luna route check, 2026-10-23

`/tmp/listener-luna-quality-check.log` records two actual ChatGPT-plan requests using `gpt-6-luna` and outgoing `reasoning.effort: low`. The term case produced a contextual circuit-breaker explanation; the already-resolved case returned no hints. Logged request durations were approximately 3.85 and 1.94 seconds; the enclosing term case took approximately 8.02 seconds. These are two examples, not a quality, latency, or subscription-quota benchmark. Summary and agent models were not changed by the hint-only override.

## Historical rebased native checks, 2026-10-23

`/tmp/listener-rebased-layout-20261023/report.md` records 12 passing cases against a candidate based on HEAD `48fe72bb74a75715bf9063bfa9855d3f42129871`:

| Scope | Dated result |
| --- | --- |
| Upstream live-session lifecycle | 6 passed; one shared launch and six resets |
| Renderer-lost snapshot and late hint/revision recovery | 1 passed |
| Preview timing, mode recovery, unknown mode, reference captures | 4 passed |
| Whole session at 1200/820/390 widths | 1 passed |
| Background lifecycle/guard harness | 62 passed |
| Strict E2E type checks | Passed |
| Long integrated lifecycle case | Earlier failure; corrected case not run |
| Saved-history case in this rebased run | Not run |

These cases used the then-current inline preview and controls, before the top-popover production cleanup. They must not be reported as a fresh passing native suite for the final interface. Additional execution stopped when the user narrowed validation scope. Preserved first failures, source/build identities, captures, and cleanup receipts remain under that report directory. The report records all 14 owned main processes exited and protected user app processes preserved at that time.

## Earlier implementation evidence

`/tmp/listener-ux-complete-20261023/native-report.md` describes an earlier UI revision: 336 related Node tests, 62 harness tests, five integrated cases, and one saved-history case passed. That interface included search, modes, pins, and dismissed history. Its results and visual comparisons are historical evidence only. The broader source run passed 1,389 of 1,390 tests; the existing foreign-script fixture also triggered `high-text-compression`, contrary to its single-reason expectation. It was not a green whole-repository run.

## Limits

Hidden native scenarios used deterministic fixtures rather than real microphone or system-audio capture. The final saved-history case read isolated files through IPC and exercised reload, literal HTML escaping, and legacy no-hints behavior. Installed Electron-package boot, live meeting quality, and interactive VoiceOver validation are not established by these records. Source tests, synthetic replay, and two provider calls are distinct evidence layers.
