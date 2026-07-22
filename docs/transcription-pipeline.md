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
  │ 2. per-segment: transcribe → analyzer → retry ladder
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
no-overlap segment muxer. Segment headers retain nominal, non-overlapped time
ranges.

### 2. Per-segment transcription, analyzer, and retry ladder

Each segment is transcribed independently. There is no cross-segment text
conditioning, so Whisper-style long-form error propagation cannot occur by
construction. The `[NO_SPEECH]` sentinel is stripped from the raw text before
the analyzer runs (`src/transcriptQuality.ts`):

| Detector | Catches |
|---|---|
| Consecutive near-duplicate lines (char-bigram Dice ≥ 0.9 on whitespace-stripped text) | line loops, Korean spacing variants compare equal |
| 1–4-word block repeat counting | word/n-gram loops (issue criterion: 4-gram ×4) |
| KMP smallest-period check | space-less character loops (`감사합니다감사합니다…`) |
| Local deflate compression ratio (≥ 4 over 200+ chars) | long low-entropy repetition (NOT a provider compression_ratio) |

Thresholds are conservative: confirmations (`네, 네`), stutters, emphasis,
and short chants never flag.

Flagged output triggers the **retry ladder**
(`QUALITY_RETRY_TEMPERATURES = [0.4, 0.8]`): a context-cleared prompt (no
glossary, positional prefix, or examples) re-transcribes the same audio at
temperature 0.4, then 0.8 if the first rung is still flagged. Low temperature
can lock a decoder into a self-reinforcing loop; this is Whisper's escalating
fallback compressed to two rungs, with the low rung preserving recovered
speech accuracy when it succeeds. The first analyzer-clean rung wins, and an
empty result counts as silence evidence. A throwing rung is skipped. If every
rung fails, the first result is kept and marked uncertain. The analyzer never
deletes text. Provider or network errors use a separate three-attempt backoff,
unrelated to the retry ladder.

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

> **Removed stages (both by user decision, 2026-07-22 — do not reintroduce
> without a new decision):**
> - *LLM text-cleanup pass* (small model rewrites the transcript with
>   artifacts deleted): removed after a production incident — asked to clean
>   a transcript at temperature 0, the cleanup model itself entered a
>   repetition loop and returned 61,318 chars for a 20,349-char input.
>   The audio-level retry ladder and marking are the retained strategy.
> - *Pre-upload energy gate* (ffmpeg volumedetect skip below −50 dBFS):
>   removed to keep the pipeline simple. Silent audio now reaches the
>   provider and resolves through the `[NO_SPEECH]` sentinel / empty-response
>   semantics at normal provider cost.

### 6. Persistence

`meta.json` → `customFields.transcriptQuality = { analyzer?, modelNotes? }` is
written only when something was found. The transcript is stored after the
retry ladder and boundary reconciliation. Flagged but unrecovered text is
kept and marked, never silently deleted.

## Provider matrix

| Stage | Gemini (default) | Codex — `gpt-4o-transcribe`, `whisper-1` | Codex — `gpt-4o-transcribe-diarize` (codex default) |
|---|---|---|---|
| Transcription call | `generateContent` on `geminiFlashModel` (inline ≤ 20 MB, files API above) | `POST /v1/audio/transcriptions` | same endpoint, `diarized_json` + `chunking_strategy=auto` |
| Prompt (glossary, instructions, `[NO_SPEECH]`) | sent | sent | **not sent** — model rejects `prompt` |
| First-attempt temperature | 0.2 | provider default (field omitted) | provider default |
| Retry ladder temperatures | 0.4 → 0.8 via `config.temperature` | 0.4 → 0.8 via `temperature` form field | **no temperature knob** — ladder rungs are effectively identical resends relying on provider nondeterminism |
| Empty result semantics | `text === ''` → `EmptyTranscriptionError` | empty `text` → `EmptyTranscriptionError`; missing `text` → malformed-response error | zero/all-empty segments → `EmptyTranscriptionError` |
| Speaker labels | prompted `참가자N` | none (plain text) | provider speakers re-labeled to `참가자N` |
| Segmentation trigger | > 300s | > 300s or > 24 MB (size-shrunk segment length) | same |

Implication: the diarize model has the weakest guard surface (no prompt, no
temperature), so it leans hardest on the analyzer and uncertainty marking.

## Live path (light safety net by design)

The main quality investment is the batch pipeline above; live captions get:

- Exact-duplicate final suppression: normalized text identical to the
  previous final within 30s (≥ 6 normalized chars) is dropped — the shape a
  provider stuck on silence emits every window. No fuzzy dedupe: without
  timestamp/audio evidence, deletion is unsafe.
- Flagged finals are kept and carry `segment.quality = { flagged, reasons }`.
- Live snippets never run the retry ladder (`qualityRetry: false`) — re-sending
  the same low-signal 12s blob buys no new evidence. A silent snippet resolves
  to `''` via the no-speech semantics after the provider call.

## Observability

All quality logs are metrics-only — transcript text never appears in logs.
While the retry ladder runs, the UI progress message shows
`quality retry N/M`, so long-running segments remain explainable.

```
[transcript-quality] segment 7/12: flagged (repeated-ngram-loop; normalizedLength=…, blockRepeats=…, compression=…)
[transcript-quality] segment 7/12: retry 1/2 still flagged (…)
[transcript-quality] segment 7/12: retry 2/2 is clean; using retry result
[transcript-quality] segment 3/12: all retries exhausted; keeping first result marked uncertain
[transcript-quality] boundary 1/2: removed 142 overlap chars
[transcript-quality] assembled transcript flagged (…)
```

## Open items (tracked in issue #182)

- Renderer-side VAD/energy gating before live chunk upload (would restore
  zero-cost silence handling client-side).
- Opt-in quality-triggered provider fallback (requires both providers
  configured plus a config surface).
- Threshold calibration against a labeled Korean/English corpus.
