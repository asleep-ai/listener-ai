# Transcription Quality Pipeline

Ground truth for how a recording becomes a saved transcript, and where each
repetition/hallucination ("repeat curse") guard sits. Covers the batch path
(recording finished → note saved) built for issue #182. Source of truth for
behavior; when code and this document disagree, fix one of them.

## Batch pipeline

```
audio file
  │ 0. duration probe (ffmpeg)
  │ 1. energy gate ── provably silent → no-speech outcome, zero API calls
  │ 2. segmentation (long files): head-overlapped plan, re-encoded cuts
  │ 3. per-segment: transcribe → analyzer → escalating retry ladder
  │ 4. assembly: boundary reconciliation → join
  │ 5. assembled-transcript analyzer (cross-segment loops)
  │ 6. summary call (+ piggybacked quality notes)
  ▼
saved note (meta.json carries transcriptQuality verdicts)
```

### 0. Entry

All file entrypoints (auto-record, modal, regenerate, drag-drop, IPC, CLI,
merge) converge on `GeminiService.transcribeAudio` → `transcribeWithTwoSteps`
(`src/geminiService.ts`).

### 1. Energy gate (audio evidence, pre-provider)

`measureMaxVolumeDb` runs ffmpeg `volumedetect`. Peak below
`SILENT_SEGMENT_MAX_VOLUME_DB` (−50 dBFS) means digital silence: the audio is
never uploaded. A silent whole file surfaces "No intelligible speech was found
in this recording."; a silent segment keeps its time-range header with an
empty body; a silent live snippet resolves to `''`. Measurement failure FAILS
OPEN to normal transcription — the gate can only skip provable silence.

### 2. Segmentation (duration > 300s, or Codex files > 24 MB)

`computeSegmentPlan`: every segment after the first starts
`SEGMENT_OVERLAP_SECONDS` (15s, capped at segmentDuration/4) early, so
boundary speech is transcribed twice on purpose. Cuts are one ffmpeg
`-ss/-t` invocation per segment, always re-encoded (libopus 48k → `.webm`):
stream-copy extraction on webm-opus measured wildly wrong (a 5s request
produced an 8s file) and reconciliation depends on cut accuracy. Unknown
duration (ffprobe failed) falls back to the legacy no-overlap segment muxer.
Segment headers keep nominal (non-overlapped) time ranges.

### 3. Per-segment transcription + quality gate

Each segment is transcribed independently (no cross-segment text
conditioning — Whisper-style long-form error propagation cannot occur by
construction). The raw text is stripped of the `[NO_SPEECH]` sentinel, then
analyzed (`src/transcriptQuality.ts`):

| Detector | Catches |
|---|---|
| Consecutive near-duplicate lines (char-bigram Dice ≥ 0.9 on whitespace-stripped text) | line loops, Korean spacing variants compare equal |
| 1–4-word block repeat counting | word/n-gram loops (issue criterion: 4-gram ×4) |
| KMP smallest-period check | space-less character loops (`감사합니다감사합니다…`) |
| Local deflate compression ratio (≥ 4 over 200+ chars) | long low-entropy repetition (NOT a provider compression_ratio) |

Thresholds are conservative: confirmations (`네, 네`), stutters, emphasis,
and short chants never flag.

Flagged output triggers the **escalating retry ladder**
(`QUALITY_RETRY_TEMPERATURES = [0.4, 0.8]`): a context-cleared prompt (no
glossary, no positional prefix, no examples) re-transcribes the SAME audio,
first at temperature 0.4, then 0.8 if still flagged. Rationale: low
temperature is what locks a decoder into a self-reinforcing loop (Whisper's
escalating fallback, compressed to two rungs — the low rung preserves
recovered-speech accuracy when it suffices). The first analyzer-clean rung
wins (empty counts as silence evidence); a throwing rung is skipped; if every
rung fails, the FIRST result is kept and marked uncertain. Detection never
deletes text on its own. Provider/network errors use a separate 3-attempt
backoff retry, unrelated to this ladder.

Production calibration (2026-07-21/22, real 1h Korean meetings): 0.2 retries
failed to recover looped segments; the ladder recovered 5 of 6 flagged
segments (4 at rung 0.4 — including a 2,280-line loop — and 1 at rung 0.8
after 0.4 itself looped).

### 4. Assembly + boundary reconciliation

`reconcileOverlappingSegments`: because segment N and N+1 transcribed the
same overlap audio, matching text at the boundary is evidence-backed and safe
to drop from the LATER segment's head. Matching is anchored at the boundary,
bounded to a ~400-normalized-char window, per-line bigram similarity ≥ 0.85
(plus an exact-suffix half-line case), and removes nothing when unsure.
Repetition deep inside a segment is unreachable by design.

### 5. Assembled-transcript analyzer

`analyzeAssembledTranscript` re-runs the analyzer over the joined text with
segment headers/`---` separators stripped (adjacent headers from silent
segments would false-flag). This is what sees cross-segment loops. Verdict is
logged (metrics only) and persisted.

### 6. Summary + piggybacked review

The summary call (the provider's large model) additionally returns a
`transcriptQualityNotes` JSON array — short Korean descriptions of sections
that look like transcription artifacts. Notes only: the model is instructed
to keep suspected artifacts out of the summary but never rewrite the
transcript. Zero extra API calls.

> **Removed stage (decision 2026-07-22):** a post-assembly LLM text-cleanup
> pass (small model rewrites the transcript with artifacts deleted) ran
> briefly and was removed after a production incident: asked to clean a
> transcript at temperature 0, the cleanup model itself entered a repetition
> loop and returned 61,318 chars for a 20,349-char input. Audio-level
> retries + marking are the retained strategy; text-level rewriting is not.

### 7. Persistence

`meta.json` → `customFields.transcriptQuality = { analyzer?, modelNotes? }`,
written only when something was found. The transcript itself is stored as
transcribed (post-ladder, post-reconciliation); flagged-but-unrecovered text
is kept and marked, never silently deleted.

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
temperature), so it leans hardest on the energy gate, the analyzer, and
uncertainty marking.

## Live path (light safety net by design)

The main quality investment is the batch pipeline above; live captions get:

- Exact-duplicate final suppression: normalized text identical to the
  previous final within 30s (≥ 6 normalized chars) is dropped — the shape a
  provider stuck on silence emits every window. No fuzzy dedupe: without
  timestamp/audio evidence, deletion is unsafe.
- Flagged finals are kept and carry `segment.quality = { flagged, reasons }`.
- Live snippets never auto-retry (`qualityRetry: false`) — re-sending the
  same low-signal 12s blob buys no new evidence. The energy gate still
  applies (silent snippet → `''` at zero provider cost).

## Observability

All quality logs are metrics-only — transcript text never appears in logs.

```
[transcript-quality] segment 7/12: flagged (repeated-ngram-loop; normalizedLength=…, blockRepeats=…, compression=…)
[transcript-quality] segment 7/12: retry 1/2 still flagged (…)
[transcript-quality] segment 7/12: retry 2/2 is clean; using retry result
[transcript-quality] segment 3/12: all retries exhausted; keeping first result marked uncertain
[transcript-quality] segment 2/12 is silent (max_volume -91 dB); skipping transcription
[transcript-quality] boundary 1/2: removed 142 overlap chars
[transcript-quality] assembled transcript flagged (…)
```

## Open items (tracked in issue #182)

- Renderer-side VAD/energy gating before live chunk upload (batch-side gate
  covers snippets only after upload).
- Opt-in quality-triggered provider fallback (requires both providers
  configured plus a config surface).
- Threshold calibration against a labeled Korean/English corpus.
