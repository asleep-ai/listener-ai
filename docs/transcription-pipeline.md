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

### 1. Segmentation (duration > `maxSegmentSeconds`, or file > `maxBytes`)

Both thresholds are properties of the selected batch backend
(`src/batchSttBackend.ts`), read by the pure `planSegmentation` helper rather
than branched on the provider name. Gemini declares `maxSegmentSeconds: 300`
and no byte cap; Codex declares the same 300s plus `maxBytes: 24 MB`, and a
file above that also shrinks the segment length proportionally (targeting
20 MB per cut, floored at 30s) so each segment fits one request. A backend
that keeps speaker identity consistent only within a single request raises
`maxSegmentSeconds` instead of relying on boundary reconciliation. Soniox is
that case: it declares `maxSegmentSeconds: 18_000` (its own 300-minute
per-file cap) so a whole meeting goes up as one async job and speaker ids stay
consistent end to end. Only a recording longer than five hours reaches
`computeSegmentPlan` and `reconcileOverlappingSegments` on that backend.

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
| Within-line character / token runs on raw lines (≥ 40 / ≥ 15) | one line holding a single repeated symbol or token (see Defect guards) |

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

Issue #197 adds three more per-segment guards inside this stage -- the
within-line flood detector, the speaker-aware exemption to the block rule, and
the prompt-echo drop -- plus label normalisation at assembly and a script-mix
check on the assembled text. See Defect guards below.

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
`transcriptQualityNotes` JSON array: short descriptions in the meeting's primary language of sections
that look like transcription artifacts. These are notes only. The model keeps
suspected artifacts out of the summary but never rewrites the transcript.
This adds no API calls.

`DEFAULT_SUMMARY_PROMPT` (`src/configService.ts`) also carries three grounding rules
aimed at defects the transcript carries into the summary. A store-wide audit found the
summariser laundering transcript defects into confident claims: hedged dates and amounts
were resolved to one value, a provisional pick was written up as a final decision,
garbled proper nouns acquired invented English spellings, and work the transcript
described as already finished reappeared as a pending action item. The prompt now
requires the summary to keep a hedge wherever the transcript hedges a date, amount,
count, or decision status; to never invent an English, romanized, or corrected spelling
for a garbled or uncertain name, product, or term; and to exclude completed work from
action items, which cover pending future work only. These rules constrain the summary
text only -- the transcript itself is never rewritten here.

The summary response is parsed leniently, because a parse failure must never
cost the user a transcript that is already paid for. The parser tries the
fence-stripped text, then the outermost `{...}` span, so a fenced object with
surrounding prose or an object followed by commentary still parses. When
neither parses (usually truncated output), the run keeps the `summary` string
if it closed before the cut, otherwise the raw model text as the summary, logs
the error and reports it to Sentry as `summary.parse` (warning), and saves the
note. A parsed object needs no particular key: a custom summary prompt may ask
only for action items, key points or custom fields, and the note is saved with
an empty summary. This matches v2.14.0; later builds briefly failed the whole
run on either shape.

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

`meta.json` → `customFields.transcriptQuality = { cleaned?,
uncertainSegments?, speakerLabels?, analyzer?, modelNotes?, lostSegments?,
lostSeconds? }` is written only when cleanup was accepted, uncertain text was
kept, or another quality finding exists. The transcript is stored after the
retry/cleanup gate and boundary reconciliation. Flagged but unrecovered text
is kept and marked.

## Defect guards

A store-wide audit of the saved store (2026-09-18; 102 substantive transcripts
from 85 recordings) found five defect classes the repetition work above does
not catch, and confirmed that its verdicts never reach the user at all.
Issue #197 answers them with six provider-independent guards. They are not
a seventh stage: each one sits inside a stage above, and none of them
branches on which backend produced the text.

**Within-line token floods** (stage 2). The four detectors above this one in
the table run on normalized text, which strips punctuation and symbols. One
line holding a single symbol repeated 30,391 times normalizes to an empty
string, so it was invisible to all of them; the shape appears in 10 of 102
transcripts.
`intraLineRuns` therefore scans the raw lines, with only the speaker label
stripped, and reports `maxIntraLineCharRun` and `maxIntraLineTokenRun`. A run
of 40 identical characters or 15 identical whitespace-separated tokens inside
one line adds the reason `intra-line-token-flood`. Laughter, ellipses and
short acknowledgement chants stay far below both thresholds.

The same change made the 1-4-word block rule speaker-aware. A genuine meeting
close where 참가자1 and 참가자2 trade `네.` for twenty turns tokenizes as a period-4
block and reached the four-repeat rule on entirely real speech (observed in a
Soniox whole-file eval). A candidate block carrying two or more distinct
speaker tokens is an exchange between real speakers, not a decoder loop, and
is exempt; a single-speaker loop still flags.

**Prompt echo** (stage 2). A provider sometimes returns the instructions it
was given instead of a transcript: the audit found one segment holding the
whole transcription prompt, positional prefix and the glossary of colleagues'
names included, and another holding its preamble sentence. That text reached
the summary, Notion, the Markdown export and Drive sync. `detectPromptEcho`
matches built-in instruction markers, which survive prompt customisation, plus
verbatim lines of at least 24 characters from the prompt actually sent, which
covers a user's custom `--prompt` text and the glossary entries. Short prompt
lines are excluded on purpose: a one-term glossary bullet is exactly what a
legitimate mention of that term looks like in speech.

The check runs inside the gate before the judge, so an echo drives the same
retry ladder as a loop. If every rung is exhausted and the result still
echoes, the gate returns empty text with `dropped: 'prompt-echo'` and skips
the cleanup call. This is the one case where the gate deletes text instead of
keeping it and marking it uncertain: instruction text in a transcript is
always wrong, never merely suspicious. A dropped segment keeps its time-range
header over an empty body, so the rest of a long recording survives, while a
whole-file drop fails the run with `Transcription returned the prompt text
instead of speech`. Live snippets (`qualityRetry: false`) keep their silent
path, because an error toast every 12 seconds is worse than a dropped chunk.

**Speaker-label normalisation and runaway id cap** (stage 2, as each segment
body is assembled).
Corrupted leading labels -- `참가1:`, `참자2:`, `참참가자1:`, `참가자 3:`, `[참가자1]` --
appear in 63 of 102 transcripts, and runaway id counters reach `참가자147` where
the diarizer gave almost every bare `어.` line a new speaker. Owner-grouped
action items cannot be attributed on that output. `normalizeSpeakerLabels`
rewrites every Korean variant to the canonical `참가자N: ` shape and requires a
colon or a closing bracket before it will touch a line, so `참가자 3명이 참석했습니다`
keeps its first word. English labels and unlabeled lines come back
byte-identical: `Speaker 2:` arrives well formed, and renaming it would
destroy the only speaker information an English meeting carries. A segment
with more distinct ids than `SPEAKER_ID_CAP` (12) is marked uncertain -- the
text stays, but it must not be trusted for owner attribution -- and its ids
are collapsed onto the last valid id only when the runaway signature is
there: ids that only climb, each spent on a single line. Any id reused later
in the segment says the diarizer was still following people, so a fifteen-
participant meeting keeps every id it was given, however far past the cap it
runs; collapsing them would merge real participants, which is worse than a
high id count. The guard runs on both the segmented and the whole-file path,
and its counts persist as `speakerLabels`, where `collapsed: true` marks the
segments whose ids were rewritten.

**Foreign-script insertion** (stage 4). Fabricated but fluent passages in
another language -- a Portuguese podcast interview as the closing segment of a
Korean meeting, an English narration, Chinese and Japanese runs -- appear in
four transcripts plus fragments in a fifth. They pass every repetition-shaped
detector, and the summary presents them as discussion. `scriptMix` measures
the Hangul / Latin / other letter shares of a block, and
`findScriptMixOutliers` calls a block an outlier when it holds at least 120
letters, the recording has a dominant script at 60% or more, and the block
holds at most 20% of that script. English jargon and acronyms inside Korean
speech keep a Hangul share well above that ceiling, so they never flag. A
segmented run compares real segments; a whole-file run has none, so
`splitIntoScriptWindows` cuts the transcript into 1,500-letter windows of
whole turns, which keeps a mid-file foreign run from being diluted by the
speech around it. Outlier segments join `uncertainSegments`, the finding
persists under `analyzer.scriptMix` with the reason `foreign-script-segment`,
and one sentence naming the positions is appended to the summary call's
quality block. That sentence is advisory rather than an instruction to drop
the block: the check is a letter-share heuristic that cannot hear the audio,
so it asks the model to weigh the block against the surrounding context and
keep it if it reads as genuine discussion. Notes only: transcript text is
never rewritten.

**Silent loss notice** (stages 5 and 6). Everything above is diagnostic
metadata the user never sees, and that is the failure the audit found most
damaging: the summary reads as a complete record of the meeting even when a
quarter of the audio produced nothing. Each segment now carries a `lossReason`
-- `empty`, `cleaned` when a cleanup call was accepted with empty output, or
`prompt-echo` -- and the list is collected from the bodies that survive
overlap reconciliation, so a segment whose only text was its predecessor's
overlap is counted as lost rather than left as a bare header nobody mentions.
`formatTranscriptLossNotice` turns the collected segments into one plain
sentence: `N minutes of this recording produced no transcript
(segments: 3 [00:10:00 ~ 00:15:00], ...)`. `transcribeWithTwoSteps` prepends
that notice to the flat `summary` string and also inserts it as the first
`summarySections` entry, under the heading `Transcript coverage`, because the
app summary tab, `listener show` and the Notion page all render the sections;
a notice written to the flat string alone would be invisible in all three. The
list persists as `lostSegments` alongside `lostSeconds`. A segment that
exhausts its provider retries still throws and fails the whole run, so a
failed segment can never reach a transcript: the notice covers segments that
came back empty, were cleaned to empty, or had an echoed prompt dropped. It is
the only part of `transcriptQuality` that is deliberately user-visible.

**Summary grounding rules** (stage 5). The sixth guard constrains the summary
rather than the transcript: three rules in `DEFAULT_SUMMARY_PROMPT` keep
hedged dates and amounts hedged, forbid invented English spellings for garbled
names, and exclude completed work from action items. Described in section 5
above.

## Provider matrix

Each row below is a property of the `BatchSttBackend` the pipeline holds
(`src/batchSttBackend.ts`), not a branch inside `geminiService.ts`.
`acceptedExtensions` (`null` = no pre-conversion) drives the ffmpeg remux.
`supportsPrompt: false` means no prompt is assembled at all — no glossary
block, no positional segment prefix, no format instructions — and the
vocabulary is handed over as a separate `glossary` field instead.
`supportsTemperature` sizes the retry ladder via `retryTemperaturesFor`, and
`maxBytes` / `maxSegmentSeconds` feed `planSegmentation`. Adding an engine
means adding a backend, not another provider branch.

| Stage | Gemini (default) | Codex — `gpt-4o-transcribe`, `whisper-1` | Codex — `gpt-4o-transcribe-diarize` (codex default) | Soniox — `stt-async-v5` (opt-in) |
|---|---|---|---|---|
| Transcription call | `generateContent` on `geminiFlashModel` (inline ≤ 20 MB, files API above) | `POST /v1/audio/transcriptions` | same endpoint, `diarized_json` + `chunking_strategy=auto` | async job: `POST /v1/files` → `POST /v1/transcriptions` → poll → `GET .../transcript`, then `DELETE` both (account quotas) |
| Per-result quality judge | `gemini-2.5-flash-lite` via text-only `generateContent` | configured `codexModel` via pi-ai | configured `codexModel` via pi-ai | judge follows the chat provider (`aiProvider`), not the backend |
| Exhaustion cleanup | `gemini-2.5-flash-lite` via text-only `generateContent` | configured `codexModel` via pi-ai | configured `codexModel` via pi-ai | same — cleanup also follows `aiProvider` |
| Prompt (glossary, instructions, `[NO_SPEECH]`) — `supportsPrompt` | sent | sent | **not sent** — model rejects `prompt`, so the pipeline never assembles one | **not sent** — no prompt surface at all; the glossary goes out of band as `context.terms` |
| First-attempt temperature | 0.2 | provider default (field omitted) | provider default | no temperature parameter exists |
| Retry ladder temperatures | 0.4 → 0.8 via `config.temperature` | 0.4 → 0.8 via `temperature` form field | **no temperature knob** — one re-roll relying on provider nondeterminism | **no temperature knob** — one re-roll, same as the diarize model |
| Empty result semantics | `text === ''` → `EmptyTranscriptionError` | empty `text` → `EmptyTranscriptionError`; missing `text` → malformed-response error | zero/all-empty segments → `EmptyTranscriptionError` | no tokens, or only audio-event/whitespace tokens → `EmptyTranscriptionError` |
| Speaker labels | prompted `참가자N` | none (plain text) | provider speakers re-labeled to `참가자N` | provider speaker ids re-labeled to `참가자N` by first appearance, consistent across the whole file below the 300-minute segmentation threshold; a longer file is segmented and renumbers per segment |
| Segmentation trigger (`maxSegmentSeconds`, `maxBytes`) | > 300s | > 300s or > 24 MB (size-shrunk segment length) | same | > 18,000s (300 min), no byte cap |
| Pre-conversion (`acceptedExtensions`) | none — `null`, any container ffmpeg reads | remux to `.webm` outside mp3/mp4/mpeg/mpga/m4a/wav/webm | same | remux to `.webm` outside webm/mp3/m4a/mp4/wav/ogg/flac/aac/aiff/amr/asf |
| Segment re-encode flag (`requiresReencodedSegments`) | false | true | true | true |

Implication: the diarize model and Soniox have the weakest retry surface (no
prompt, no temperature), so a judge-flagged result gets one
provider-nondeterministic re-roll before uncertainty marking. Soniox trades
that away for whole-file speaker consistency and per-second billing; its
transcription usage row is `{ modelId: 'stt-async-v5', kind: 'transcription',
usage: { audioSeconds } }`, taken from the provider's own
`audio_duration_ms` when it reports one. Note that a quality re-roll on this
backend is a whole second job: another upload, another transcription, and two
more entries against the 1,000-stored-file / 2,000-transcription account
quotas, all deleted as they complete. The whole-file path also retries a
transient 5xx up to three times on its own, because only the segment path has
a retry loop above it. The live-snippet caller (`qualityRetry: false`) opts
out of that through `retryTransport: false`: it starts a fresh job every ~12s,
so retrying a failed one only multiplies load on a provider that is already
failing.

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
