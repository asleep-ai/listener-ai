# Soniox adoption plan

Status: proposal (research done 2026-09-17, nothing implemented). Research inputs: Soniox public
docs/pricing/status/npm registry, AssemblyAI's 2026-09-09 multilingual benchmark, and a source-anchored
map of Listener.AI's two provider seams. When code and this document disagree, fix one of them.

## 1. Why consider Soniox

| Dimension | Soniox (`stt-async-v5` / `stt-rt-v5`) | Today (Gemini / Codex) |
|---|---|---|
| Async price | $0.10/hr, diarization + LID + formatting + translation bundled | Gemini 2.5 Flash tokens; OpenAI diarize ~$0.36/hr |
| Realtime price | $0.12/hr | OpenAI realtime transcription, Gemini Live |
| Input | webm/opus accepted natively; raw s16le PCM on the socket | Codex path needs ffmpeg remux for some formats |
| Korean | Best of 13 providers on Korean FLEURS (4.4% WER); 8.7% on Common Voice Korean | No independent number |
| Code-switching | Token-level language tags, v5 claims mid-sentence switching. No ko/en benchmark exists | Gemini handles it; OpenAI diarize skips words |
| Diarization | Both modes, up to 15 speakers, whole-file consistent ids in async | Codex diarize renumbers per 5-min segment; Gemini infers from prompt |
| Custom vocab | `context.terms` (8000-token cap) | `knownWords` in prompt (dropped on Codex diarize) |
| Privacy | Zero retention by default, no training, SOC 2 Type 2 / ISO 27001 / HIPAA / GDPR, EU/JP regions | General LLM endpoints |
| Session cap | 300 min per file and per stream (fixed). No forced ~10-min disconnect | Gemini Live drops every ~10 min |
| Async turnaround | Vendor: "an hour comes back in a few minutes". Artificial Analysis median speed factor 37x on 10-min clips, so a 1-hour file is roughly 2 to 5 min. No SLA, no priority tier, cross-file parallelism undocumented | Artificial Analysis speed factors on the same clips: Gemini 2.5 Flash 73.9x, GPT-4o mini Transcribe 43.1x, GPT-4o Transcribe 36.2x. Provider caps (Gemini 9.5 h / 2 GB, OpenAI 25 MB and an undocumented ~1500 s rejection) are never hit because we segment at 300 s |

Sources: <https://soniox.com/pricing>, <https://soniox.com/docs/stt/models>,
<https://www.assemblyai.com/benchmarks>, <https://soniox.com/docs/security-and-privacy>.

### Measured on our own recordings (2026-09-17, `stt-async-v5`, whole file, diarization on)

| File | Duration | Upload | Process | Total | Current segmented Gemini pipeline | Content chars Gemini vs Soniox | Speakers Gemini vs Soniox |
|---|---|---|---|---|---|---|---|
| A | 120 min, 55.7 MB | 7 s | 184 s | 194 s | 472 s | 29,141 vs 30,253 | 4 vs 3 |
| B | 60 min, 27.9 MB | 8 s | 76 s | 87 s | 305 s | 12,789 vs 13,093 | 11 vs 3 |
| C | 31 min, 14.6 MB | 4 s | 52 s | 58 s | 33 s | 10,409 vs 9,890 | 1 vs 1 |

Content chars are whitespace-stripped with speaker labels removed. Speech content is equivalent;
Soniox drops most fillers ("어,", "음,") and merges same-speaker runs into fewer turns. Proper nouns
were noticeably worse because this run passed no `context.terms` glossary while the Gemini pipeline
had `knownWords` in its prompt. Whole-file Gemini 2.5 Flash and OpenAI were also tried: Gemini
truncates at the 32k output-token cap above ~30 min and loops, OpenAI rejects >25 MB and >1400 s.
Full table in issue #195.

A reviewed quality comparison (three opus reviewers, 8 aligned passages per file, verifying a
haiku first pass) is in issue #195's comment thread. Soniox was judged the better summarizer input
on all three files: the segmented Gemini pipeline showed empty or collapsed tail segments (A
01:50-01:55 empty; B 38-55 min degraded), per-segment speaker renumbering that flips roles, and
duplicated text at most segment joins despite `reconcileOverlappingSegments`. Soniox's defects were
isolated proper nouns (no glossary was passed), two meaning flips, and one-paragraph repetition
loops. Phase 0 must rerun with `context.terms` = `knownWords` before judging noun accuracy.

A separate diarization-only audit (same method, identity flips proven via the 15 s segment overlap)
scored the segmented pipeline 1/5 on identity consistency for A and B: labels change person at 9 of
17 checkable boundaries on A and 4 of 6 on B, 11 ids appear in B's first five minutes, and ~15 min
of A and ~20 min of B have no speaker structure at all. Soniox async held one person per id for 109
of 120 min on A (one clean swap at ~01:50, noise-sink id abandoned after ~01:03) and for all of B,
and correctly returned a single speaker on C. Owner-grouped action items cannot be attributed from
the current output; they can from Soniox's. The "speakers" column above counts label strings, not
people: A has 2 real participants plus café noise on both sides.

## 2. Risks that shape the plan

1. **Korean-English code-switching is unmeasured.** Every published code-switching pair is European.
   This is the primary use case, so a paid in-house eval gates everything else.
2. **No free credits** (discontinued 2025-10-27). Fund an account before the eval; cost is cents.
3. **No realtime reconnect/resumption is documented.** We build it, reusing the `GeminiLiveSession`
   pattern (`{ connect, sleep }` DI seam, first connect rejects so fallback works, only an
   established connection drives the reconnect loop). Measured 2026-09-17: the server processes at
   ~1.1x realtime regardless of send rate, and a sustained backlog of a few minutes closes the
   socket with code 1006 and no error frame. Live mic input (1x) is fine; the provider must pace
   sends and treat 1006 as a reconnect trigger. Per-token language identification returned zero
   `en` tags on Korean-dominant meetings, so do not use it as a code-switching signal. Account
   concurrency for our key: 10 transcriptions (org level, not on public docs).
   Realtime diarization on the 31-min single-speaker file split one voice across two ids during
   the first ~6 min and then stabilised; a 5-min clip reproduced it. Our test harness also turned
   the `<end>` endpoint token into a phantom third speaker because it keyed turn assembly on
   `token.speaker` without filtering control tokens; any realtime client must drop tokens with no
   language before speaker assembly.
4. **Model churn is roughly annual** (v3 retired 2026-02, v4 retired 2026-06, auto-routed to the
   successor). No `/docs/changelog`; deprecations live on the models page, releases on the blog.
   Log the resolved model id and tolerate silent re-routing.
5. **Small company** (founded 2020, headcount not disclosed). Mitigation: keep the integration
   behind the provider interfaces so a swap stays cheap; never make Soniox the only path.
6. **Third-party key breaks the "ChatGPT subscription only" promise for Codex users**
   (`docs/model-pricing.md`). Soniox must be opt-in, never a silent default.
7. **Async quotas** force cleanup into the happy path: 2,000 total transcriptions, 1,000 stored
   files, 100 pending. Delete the job and the uploaded file after the transcript is persisted.
8. **Segmenting destroys Soniox's main diarization advantage.** Our pipeline cuts at 300 s with
   15 s overlap and reconciles boundaries. Soniox returns whole-file-consistent speaker ids only
   when the file is sent whole. The batch backend must raise the segmentation threshold to the
   300-minute cap (see 5.2), so `computeSegmentPlan` and `reconcileOverlappingSegments` only run
   for recordings longer than 5 hours.
9. **npm namespace confusion.** `@soniox/node` 2.3.0 (dual ESM+CJS, zero deps, MIT) is current.
   `@soniox/soniox-node` (gRPC, 2023) is dead. `@soniox/speech-to-text-web` is browser-only.

## 3. Decisions to take before coding

| # | Decision | Recommendation |
|---|---|---|
| D1 | Scope order | Live first, batch second. Live already has a clean `LiveSttSession` seam and needs zero renderer changes; batch needs a refactor first. |
| D2 | SDK or raw protocol | Raw `ws` + native `fetch`, matching `codexTranscription.ts` and the two existing live classes. The protocol is one JSON config frame + binary audio + JSON token messages. `@soniox/node` is a fine fallback (dual-CJS, no `importEsm()`), but it is 7 months old with 12 releases; a hand-rolled client is smaller than the SDK surface we would use. |
| D3 | Position in `liveSttProvider: auto` | Do not enter `auto`. Explicit `soniox` only until the eval passes and a release has soaked. Revisit ordering (Soniox before OpenAI?) afterwards. |
| D4 | Config key for batch | New `transcriptionProvider: 'auto' \| 'gemini' \| 'codex' \| 'soniox'` (default `auto` = follow `aiProvider`). Summary/judge/agent stay on `aiProvider`. |
| D5 | Live diarization | Off by default for realtime. Soniox says endpoint detection and manual finalization degrade realtime diarization, and our measurement agrees (one presenter split into two ids in the first 6 min of C). Our live renderer does not show speakers today. If enabled later, treat labels as turn hints and never persist them into saved notes. |
| D6 | Live translation | Use Soniox one-way translation so `kind = 'translation'` and we avoid one Gemini `translateText` call per final segment. |
| D7 | Region | US endpoint by default. EU/JP residency is project-bound at console level; expose an endpoint override key only if a customer asks. |
| D8 | `EmptyTranscriptionError` home | Move it (and `TranscriptionApiError`) to `src/transcriptionErrors.ts` in the refactor PR so `sonioxTranscription.ts` does not import from `codexTranscription.ts`. Whitelist the new file. |

## 4. Phase 0: paid evaluation (gate)

Goal: answer the one question no benchmark answers, on our own audio.

1. Create a Soniox account, fund it (a few dollars covers hundreds of hours), record the default
   concurrency limits from `GET /v1/.../concurrency` since they are not published.
2. Pick 5 to 8 real Korean/English meeting recordings from the local transcriptions store,
   spanning 2, 3, and 4+ speakers, one with heavy English jargon, one noisy.
3. Write `scripts/eval-soniox.ts` (dev-only, not in the npm `files` whitelist): upload the whole
   file, create `stt-async-v5` job with `language_hints: ['ko','en']`,
   `enable_speaker_diarization: true`, `enable_language_identification: true`,
   `context.terms` from `knownWords`; poll; dump tokens JSON and a `참가자N` text rendering next to
   the existing `transcript.md`; delete job + file.
4. Score by hand (no gold transcript exists): count of wrong-language renderings of English terms,
   dropped/merged utterances, speaker-swap events per 10 min, proper-noun hit rate against
   `knownWords`, and whether summary quality changes when the Soniox transcript is fed to the
   unchanged summary prompt.
5. Also stream two of the files through `stt-rt-v5` from the same script (paced 120 ms chunks) to
   compare realtime vs async output and measure end-to-end latency. Filter tokens with no
   language (`<end>`, `<fin>`) before speaker assembly, or the endpoint marker becomes a phantom speaker.
6. Exit criteria: Soniox is at least as good as the current provider on code-switched segments and
   clearly better on speaker consistency. If code-switching is worse, stop here and record the
   result in `docs/model-pricing.md`.

## 5. Implementation phases

### 5.1 Phase 1: live captions provider

New file `src/sonioxLiveProvider.ts` implementing `LiveSttSession`:

- `ws` connection to `wss://stt-rt.soniox.com/transcribe-websocket`; first frame is the JSON config
  with `api_key`, `model: 'stt-rt-v5'`, `audio_format: 's16le'`, `sample_rate: 16000`,
  `num_channels: 1`, `language_hints` from `liveSttLanguage` (+ `en`), `enable_endpoint_detection`,
  `context.terms` from `knownWords`, optional `translation: { type: 'one_way', target_language }`.
- `sendPcm`: reuse `downsamplePcm16` to a new `SONIOX_PCM_RATE = 16_000`, drop non-mono frames like
  the other two providers.
- Token handling: keep a finals buffer, reset non-finals on every message. Emit `onInterim` with
  finals-since-last-final + non-finals; emit `onFinal` when endpoint detection finalizes a run
  (offsetMs/durationMs from token `start_ms`/`end_ms`). Translation tokens carry no timestamps;
  attach them to the matching source final by order.
- Keepalive control message every ~10 s of silence; close by sending an empty frame and waiting
  for `finished: true` with a timeout.
- Reconnect: copy the `GeminiLiveSession` policy (max 5 attempts, 500 ms to 4 s backoff, counter
  reset after 30 s uptime, 15 s connect timeout) behind a `{ createWebSocket, sleep,
  connectTimeoutMs }` deps seam. There is no resumption handle, so a reconnect starts a fresh
  stream; accept a short gap.
- Errors: map the JSON error frame (`error_code`, `error_type`, `request_id`) to an `Error` with a
  `status` field; 429/503/408 retry, 401/402 surface immediately. Never put transcript text in
  Sentry `extra`.

Wiring (all existing files):

- `src/aiProvider.ts`: add `'soniox'` to `LIVE_STT_PROVIDERS`.
- `src/liveSttProvider.ts`: widen `StreamingLiveSttProvider`, add `sonioxApiKey` to
  `LiveSttProviderConfig`, handle `soniox` in `resolveStreamingProvider` (explicit only, per D3)
  and `createLiveSttSession`.
- `src/liveSessionService.ts`: five type positions with the provider union,
  `resolveLiveUsageModelId` (return `stt-rt-v5`), `buildRealtimeFallbackConfigs` (Soniox falls
  back to the existing OpenAI/Gemini chain).
- `src/configService.ts`: `sonioxApiKey` in `AppConfig`, getter/setter through `setKey`, env
  fallback `SONIOX_API_KEY`, masking, `hasStreamingLiveSttAuth`.
- `src/main.ts`: `getLiveSttConfig()` passes the key.
- `src/cli.ts`: `KNOWN_CONFIG_KEYS`, set switch, `isSensitiveKey`.
- `src/agentService.ts`: no change; verify the key is in neither READABLE nor WRITABLE lists.
- `renderer/index.html` + `renderer/ui/config-modal.ts`: select option, password input, advisory
  text. Replace the two inline provider-literal copies with an import from `aiProvider.ts`.
- `renderer/electronAPI.d.ts`: config payload type.
- `src/services/usageTracker.ts`: `MODEL_PRICING` entry for `stt-rt-v5` ($0.12/hr) so spend is not
  silently under-reported.
- `package.json` `files`: add `dist/sonioxLiveProvider.js`.

Tests: `src/sonioxLiveProvider.test.ts` driven through the deps seam with a scripted fake
WebSocket (mirror `liveSttProvider.test.ts:39-64`): config frame shape, interim/final split,
translation pairing, keepalive, clean close, reconnect after established drop, give-up after cap,
no reconnect after `close()`. Extend `liveSessionService.test.ts` for fallback ordering.

### 5.2 Phase 2a: batch refactor (no behavior change)

Extract `BatchSttBackend` from `GeminiService` so a third backend does not widen `AiProvider`:

```ts
interface BatchSttBackend {
  readonly id: string;
  readonly acceptedExtensions: ReadonlySet<string>;
  readonly supportsPrompt: boolean;
  readonly supportsTemperature: boolean;
  readonly maxBytes?: number;
  readonly maxSegmentSeconds: number;      // 300 today; 18_000 for Soniox
  readonly requiresAccurateCuts: boolean;
  transcribe(p: { audioFilePath: string; prompt?: string; temperature?: number;
                  language?: string; signal?: AbortSignal }): Promise<string>;
  recordUsage(session: CostSession | undefined, audioSeconds: number): void;
}
```

Replace the eight `this.provider` audio branches in `geminiService.ts` (`prepareAudioForProvider`,
`shouldSegment`/`segmentDuration`, force re-encode, `getShortAudioTranscript`,
`transcribeSegmentRaw`, the two retry-ladder width sites, `annotateTranscriptionError` copy) with
property reads. `transcribeSegmentRaw` stays a replaceable method so `geminiService.test.ts`'s
monkey-patching keeps working. Move the two error classes per D8. Ship this as its own PR with
the existing test suite green and `docs/transcription-pipeline.md` updated.

### 5.3 Phase 2b: Soniox batch backend

New file `src/sonioxTranscription.ts` (raw `fetch`, shape of `codexTranscription.ts`):

- `POST /v1/files` (multipart) then `POST /v1/transcriptions` with `model: 'stt-async-v5'`,
  `language_hints`, `enable_speaker_diarization: true`, `enable_language_identification: true`,
  `context.terms` from `knownWords`, `client_reference_id` = `telemetryHash(folderName)`.
- Poll `GET /v1/transcriptions/{id}` with backoff and `signal`; on `completed` fetch the transcript;
  always `DELETE` the transcription and the file in a `finally` (quota risk 7).
- `supportsPrompt: false`, `supportsTemperature: false` so the quality ladder degenerates to one
  provider-nondeterministic re-roll (same as Codex diarize). Glossary goes through `context.terms`
  instead of the prompt, so `includeGlossary` maps to that field.
- `maxSegmentSeconds: 18_000` so whole meetings go up as one file and speaker ids stay
  consistent. Recordings over 300 min still flow through the existing segment plan.
- Map tokens to `참가자N` lines: group consecutive same-speaker tokens, join text, one line per
  speaker turn (the `formatDiarizedSegments` template). Zero tokens or whitespace-only text
  throws `EmptyTranscriptionError`; HTTP failures throw `TranscriptionApiError` with
  `status`/`errorCode`/`requestId`.
- Usage: `{ modelId: 'stt-async-v5', kind: 'transcription', usage: { audioSeconds } }` and a
  `MODEL_PRICING` entry at $0.10/hr.
- Error copy: add a Soniox branch in `annotateTranscriptionError` / `friendlyMessageForApiError`
  so 401/402 say "check your Soniox API key / balance" instead of the Gemini text.

Wiring: `transcriptionProvider` config key (D4) in `configService.ts`, `cli.ts`, settings modal,
`main.ts`/`cli.ts` service construction; `package.json` `files` adds `dist/sonioxTranscription.js`
and `dist/transcriptionErrors.js`.

Tests: `src/sonioxTranscription.test.ts` swapping `globalThis.fetch` (mirror
`codexTranscription.test.ts`): upload/create/poll/fetch/delete sequence, delete-on-failure,
signal propagation, empty-token mapping, speaker grouping, 4xx vs 5xx classification.
Extend `cli.test.ts` for `config set transcriptionProvider soniox` validation.

### 5.4 Phase 3: rollout

- Ship behind explicit opt-in (`liveSttProvider: soniox`, `transcriptionProvider: soniox`); no
  change for existing configs.
- Docs: `docs/model-pricing.md` (add the Soniox row and the eval result), `docs/transcription-pipeline.md`
  (provider routing section, the 300-min segmentation rule), `CLAUDE.md` (config table, provider
  stack, `files` whitelist prose, live captions section).
- Monitoring: Sentry `operation` tags `transcription.soniox.*` and `live.soniox.*`; log the model id
  the server reports so an auto-routed retirement is visible.
- Release notes entry; soak one release before revisiting D3 (`auto` ordering).
- Add `@soniox` docs/models page and the status page to the dependency-watch list; there is no
  changelog feed to subscribe to.

## 6. Estimated effort

| Phase | Size | Notes |
|---|---|---|
| 0 Eval | 1 day + funded account | Script is throwaway; the judgment is the work |
| 1 Live provider | 2 to 3 days | Reconnect + tests dominate |
| 2a Batch refactor | 1 to 2 days | Pure refactor, must stay behavior-identical |
| 2b Batch backend | 1 to 2 days | Polling client + speaker mapping + tests |
| 3 Rollout | 0.5 day | Docs and pricing entries |

## 7. Open items to verify against the live account

- REST auth header form (docs did not spell out `Authorization: Bearer` vs custom header).
- Default concurrency limits per project/org.
- Whether EU residency needs an enterprise plan; BAA availability.
- Actual behavior of a reconnect mid-stream (whether the server tolerates a new stream from the same
  key within seconds).
