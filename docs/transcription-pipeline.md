# Transcription Quality Pipeline

Ground truth for how a recording becomes a saved transcript and where each
repetition/hallucination ("repeat curse") guard sits. It covers the issue #182
batch path from finished recording to saved note. When code and this document
disagree, fix one of them.

## Batch pipeline

```
audio file
  │ 0. entry: duration probe (ffmpeg)
  │ 1. segmentation (long files): head-overlapped plan, re-encoded cuts
  │ 2. per-segment: transcribe → small-model judge → retry ladder
  │                  → one cleanup call if every rung stays flagged
  │                  analyzer supplies metrics + shared fallback verdict
  │ 3. assembly: boundary reconciliation → join
  │ 4. assembled-transcript analyzer (cross-segment loops)
  │ 5. summary call (+ piggybacked quality notes)
  │ 6. persistence: transcript + optional quality metadata
  ▼
saved note (meta.json carries transcriptQuality verdicts)
```

### 0. Entry

All file entrypoints (auto-record, modal, regenerate, drag-drop, IPC, CLI,
merge) converge on `GeminiService.transcribeAudio` → `transcribeWithTwoSteps`
(`src/geminiService.ts`).

### 1. Segmentation (duration > 300s, or Codex files > 24 MB)

`computeSegmentPlan` starts every segment after the first
`SEGMENT_OVERLAP_SECONDS` early (15s, capped at segmentDuration/4), so boundary
speech is deliberately transcribed twice. Each cut uses one ffmpeg `-ss/-t`
invocation and is always re-encoded (libopus 48k → `.webm`). Stream-copy
extraction on webm-opus was badly inaccurate: a 5s request produced an 8s
file, while boundary reconciliation depends on accurate cuts. If ffprobe
cannot determine the duration, the pipeline falls back to the legacy
no-overlap segment muxer. Boundary reconciliation is skipped entirely for
that fallback because matching text is not overlap evidence. Segment headers
retain nominal, non-overlapped time ranges.

### 2. Per-segment transcription, judge, retry ladder, and exhaustion cleanup

Each segment is transcribed independently. There is no cross-segment text
conditioning, so Whisper-style long-form error propagation cannot occur by
construction. The `[NO_SPEECH]` sentinel is stripped from the raw text first.
For every non-empty first result and retry result, one small-model call judges
whether the segment contains an ASR repetition loop. Empty text is clean
silence evidence and never calls the judge. The deterministic analyzer still
runs on every result for metrics and becomes the verdict fallback if the judge
call fails. Abort errors are never converted into fallback verdicts.

The analyzer (`src/transcriptQuality.ts`) measures:

| Detector | Catches |
|---|---|
| Consecutive near-duplicate lines (char-bigram Dice ≥ 0.9 on whitespace-stripped text) | line loops, Korean spacing variants compare equal |
| 1–4-word block repeat counting | word/n-gram loops (issue criterion: 4-gram ×4) |
| KMP smallest-period check | space-less character loops (`감사합니다감사합니다…`) |
| Local deflate compression ratio (≥ 4 over 200+ chars) | long low-entropy repetition (NOT a provider compression_ratio) |

Thresholds are conservative because they remain the fail-open fallback:
confirmations (`네, 네`), stutters, emphasis, and short chants never flag.

Judge-flagged output triggers the **retry ladder**
(`QUALITY_RETRY_TEMPERATURES = [0.4, 0.8]`): a context-cleared prompt (no
glossary, positional prefix, or examples) re-transcribes the same audio at
temperature 0.4, then 0.8 if the first rung is still flagged. Low temperature
can lock a decoder into a self-reinforcing loop; this is Whisper's escalating
fallback compressed to two rungs, with the low rung preserving recovered
speech accuracy when it succeeds. The first judge-clean rung wins, and an
empty result counts as silence evidence. A throwing rung is skipped.

If retries were configured and every rung ran and remained flagged, the gate
makes one last-resort cleanup call on the first result. The cleaned text
replaces the first result only when it does not grow
(`cleaned.length <= first.length`) and the same verdict path used for retries
(judge, analyzer fallback, and empty-is-clean) considers it clean. Accepted
cleanup is marked `cleaned`; an empty clean result is valid silence evidence.
Otherwise the first result is kept and marked uncertain exactly as before.
Cleanup does not run when no retries were configured, a rung throws, or any
rung succeeds. Provider or network errors use a separate three-attempt
backoff, unrelated to the quality retry ladder.

Production calibration (2026-07-21/22, real 1h Korean meetings): 0.2 retries
failed to recover looped segments; the ladder recovered 5 of 6 flagged
segments (4 at rung 0.4 — including a 2,280-line loop — and 1 at rung 0.8
after 0.4 itself looped).

### 3. Assembly + boundary reconciliation

`reconcileOverlappingSegments` performs boundary reconciliation. Because
segments N and N+1 transcribed the same overlap audio, matching boundary text
is evidence-backed and safe to drop from the later segment's head. Boundary
reconciliation is anchored at the boundary, limited to a
~400-normalized-character window, and uses per-line bigram similarity ≥ 0.85
plus an exact-suffix half-line case. It removes nothing when unsure and cannot
reach repetition deep inside a segment by design.

### 4. Assembled-transcript analyzer

`analyzeAssembledTranscript` runs the analyzer again over the joined text,
after stripping segment headers and `---` separators. Adjacent headers from
silent segments would otherwise false-flag. This pass detects cross-segment
loops, then logs and persists the verdict using metrics only.

### 5. Summary + piggybacked review

The summary call to the provider's large model also returns a
`transcriptQualityNotes` JSON array: short Korean descriptions of sections
that look like transcription artifacts. These are notes only. The model keeps
suspected artifacts out of the summary but never rewrites the transcript.
This adds no API calls.

> **Decision history:**
> - *LLM text cleanup.* A broad cleanup pass was removed by user decision on
>   2026-07-22 after a production incident: the cleanup model entered its own
>   repetition loop and returned 61,318 characters for a 20,349-character
>   input. On 2026-07-23, the user reintroduced only one narrow form: a single
>   per-segment cleanup call after a configured retry ladder fully exhausts
>   with every rung still flagged. It rewrites the first result and is
>   accepted only when it never grows (`cleaned.length <= first.length`) and
>   the existing verdict path (judge, analyzer fallback, empty-is-clean) says
>   it is clean. It completes before assembly; there is no assembled-transcript
>   or summary rewrite.
> - *Pre-upload energy gate* (ffmpeg volumedetect skip below −50 dBFS):
>   removed to keep the pipeline simple. Silent audio now reaches the
>   provider and resolves through the `[NO_SPEECH]` sentinel / empty-response
>   semantics at normal provider cost.

### 6. Persistence

`meta.json` →
`customFields.transcriptQuality = { cleaned?, analyzer?, modelNotes? }` is
written only when cleanup was accepted or another quality finding exists.
The transcript is stored after the retry/cleanup gate and boundary
reconciliation. Flagged but unrecovered text is kept and marked.

## Provider matrix

| Stage | Gemini (default) | Codex — `gpt-4o-transcribe`, `whisper-1` | Codex — `gpt-4o-transcribe-diarize` (codex default) |
|---|---|---|---|
| Transcription call | `generateContent` on `geminiFlashModel` (inline ≤ 20 MB, files API above) | `POST /v1/audio/transcriptions` | same endpoint, `diarized_json` + `chunking_strategy=auto` |
| Per-result quality judge | `gemini-2.5-flash-lite` via text-only `generateContent` | configured `codexModel` via pi-ai | configured `codexModel` via pi-ai |
| Exhaustion cleanup | `gemini-2.5-flash-lite` via text-only `generateContent` | configured `codexModel` via pi-ai | configured `codexModel` via pi-ai |
| Prompt (glossary, instructions, `[NO_SPEECH]`) | sent | sent | **not sent** — model rejects `prompt` |
| First-attempt temperature | 0.2 | provider default (field omitted) | provider default |
| Retry ladder temperatures | 0.4 → 0.8 via `config.temperature` | 0.4 → 0.8 via `temperature` form field | **no temperature knob** — one re-roll relying on provider nondeterminism |
| Empty result semantics | `text === ''` → `EmptyTranscriptionError` | empty `text` → `EmptyTranscriptionError`; missing `text` → malformed-response error | zero/all-empty segments → `EmptyTranscriptionError` |
| Speaker labels | prompted `참가자N` | none (plain text) | provider speakers re-labeled to `참가자N` |
| Segmentation trigger | > 300s | > 300s or > 24 MB (size-shrunk segment length) | same |

Implication: the diarize model has the weakest retry surface (no prompt, no
temperature), so a judge-flagged result gets one provider-nondeterministic
re-roll before uncertainty marking.

## Live path (light safety net by design)

The main quality investment is the batch pipeline above; live captions get:

- Exact-duplicate final suppression: normalized text identical to the
  previous final within 30s (≥ 6 normalized chars) is dropped — the shape a
  provider stuck on silence emits every window. No fuzzy dedupe: without
  timestamp/audio evidence, deletion is unsafe.
- Flagged finals are kept and carry `segment.quality = { flagged, reasons }`.
- Live snippets run neither the judge, retry ladder, nor cleanup
  (`qualityRetry: false`) — re-sending the same low-signal 12s blob buys no new
  evidence. A silent snippet resolves to `''` via the no-speech semantics after
  the provider call.

## Observability

Quality logs contain only metrics, reasons, counts, and capped error messages —
transcript text never appears in logs. While the retry ladder runs, the UI
progress message shows `quality retry N/M`, so long-running segments remain
explainable.

```
[transcript-quality] segment 7/12: flagged by judge (repeated-ngram-loop; normalizedLength=…, blockRepeats=…, compression=…)
[transcript-quality] segment 7/12: retry 1/2 still flagged by judge (…)
[transcript-quality] segment 7/12: retry 2/2 judged clean; using retry result
[transcript-quality] segment 4/12: judge failed (request timed out); falling back to analyzer
[transcript-quality] segment 4/12: flagged by analyzer (…)
[transcript-quality] segment 3/12: cleanup accepted (removed N chars)
[transcript-quality] segment 4/12: cleanup rejected (grew|still flagged); keeping first result
[transcript-quality] segment 5/12: all retries exhausted; keeping first result marked uncertain
[transcript-quality] boundary 1/2: removed 142 overlap chars
[transcript-quality] assembled transcript flagged (…)
```

## Open items (tracked in issue #182)

- Renderer-side VAD/energy gating before live chunk upload (would restore
  zero-cost silence handling client-side).
- Opt-in quality-triggered provider fallback (requires both providers
  configured plus a config surface).
- Threshold calibration against a labeled Korean/English corpus.
