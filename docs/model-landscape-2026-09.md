# Model landscape, September 2026

Inventory of every model Listener.AI runs today, its vendor status, and the alternatives worth
evaluating for Korean-first meetings. Research date 2026-09-17, official docs plus the two
independent benchmarks that exist (artificialanalysis.ai for speed, assemblyai.com/benchmarks
2026-09 snapshot for per-language accuracy). Companion to `docs/model-pricing.md` (prices) and
`docs/soniox-adoption-plan.md` (Soniox specifics). Anything marked UNVERIFIED is not from an
official page.

## Benchmark caveat

- Artificial Analysis has **no Korean coverage** at all; its speed factors and WER are English.
- AssemblyAI's benchmark reports Korean as **CER, not WER**, on FLEURS (read speech) and Common
  Voice (noisier, closer to meetings). It excludes Korean from its 9-language mean and lists itself
  as "not supported" for Korean, so it has no incentive to inflate the Korean table.
- Soniox's own Korean page shows every vendor 3 to 5x better than any other source with no dataset
  named. Do not mix scales. The 4.4% Soniox figure quoted in the adoption plan is a CER.
- No public benchmark measures Korean/English code-switching or Korean *meeting* audio, except
  ReturnZero's self-published AI-Hub meeting/conference numbers.

## 1. Models in production today

| Role | Config key | Default id | Vendor status (2026-09-17) | Price | Hard limits |
|---|---|---|---|---|---|
| Batch transcription (Gemini) | `geminiFlashModel` | `gemini-2.5-flash` | Stable, no shutdown | $1.00/1M audio in, $2.50/1M out | 9.5 h audio, 20 MB inline then Files API |
| Batch transcription (Codex, default) | `codexTranscriptionModel` | `gpt-4o-transcribe-diarize` | **Deprecated 2026-08-26, removed 2027-02-26** | $0.006/min ($0.36/hr) | 25 MB, ~1500 s undocumented cap |
| Batch transcription (Codex, non-diarize) | `codexTranscriptionModel` | `gpt-4o-transcribe` | **Deprecated, same dates** | $0.006/min | same |
| Quality judge | hardcoded | `gemini-2.5-flash-lite` | Stable | $0.10 in / $0.40 out per 1M | |
| Summary / agent / text translation (Gemini) | `geminiModel` | `gemini-3.5-flash` | GA, vendor now calls it "legacy Flash" (3.6, 3.7, 3.8 shipped; 3.8 on 2026-09-02) | $1.50 in / $9.00 out per 1M incl. thinking | 1M ctx |
| Summary / agent (Codex) | `codexModel` | `gpt-5.5`, reasoning `xhigh` | GA flagship | $5 in / $30 out list; subscription-metered via Codex OAuth | 1.05M ctx, >272k input doubles price |
| Live transcription (OpenAI WS) | `openaiLiveTranscriptionModel` | `gpt-realtime-whisper` | GA | $0.017/min ($1.02/hr) | session cap undocumented |
| Live session (OpenAI WebRTC) | hardcoded | `gpt-realtime-2` | GA, guidance points to `gpt-realtime-2.1`; not on the 2027-01-20 deprecation list | $32 / $64 per 1M audio tokens | **60 min session** |
| Live translation (OpenAI) | `openaiLiveTranslationModel` | `gpt-realtime-translate` | GA | $0.034/min ($2.04/hr) | |
| Live transcription (Gemini Live) | hardcoded | `gemini-3.1-flash-live-preview` | Preview, **flagged Legacy, migrate to `gemini-3.8-live`** (shipped 2026-09-15) | $3.00 / $12.00 per 1M audio | 15 min audio-only session, ~10 min socket, resumption |
| Live translation (Gemini Live) | hardcoded | `gemini-3.5-live-translate-preview` | Preview, current, no successor named | $3.50 in / $21.00 out per 1M | same |

Ids are live defaults in `src/aiProvider.ts`, `src/codexTranscription.ts:27`,
`src/geminiService.ts:543`, `src/openAiRealtimeClient.ts:46`.

### Action items from the audit

1. **Codex transcription loses diarization on 2027-02-26.** OpenAI's named successors are
   `gpt-transcribe` (batch, $0.0045/min) and `gpt-live-transcribe` (realtime, $0.017/min).
   `gpt-live-transcribe` states it returns no speaker labels; `gpt-transcribe` documents none.
   Codex-only users need a new speaker-identification path before then. This is the strongest
   argument for a third STT provider.
2. **Gemini Live default is flagged Legacy.** Plan a `gemini-3.1-flash-live-preview` to
   `gemini-3.8-live` bump; re-verify session limits and the resumption handle on the new model.
   `gemini-3.5-transcribe-live` also exists as a pure-STT WebSocket we do not use.
3. **Summary model is two generations behind.** `gemini-3.8-flash` is $0.75 / $3.75 per 1M
   (promo to 2026-12-31) vs $1.50 / $9.00 for 3.5-flash. `gemini-3.5-flash-lite` is $0.30 / $2.50.
4. Gemini per-tier rate limits are no longer on the static docs (AI Studio dashboard only).

Sources: <https://developers.openai.com/api/docs/deprecations>,
<https://ai.google.dev/gemini-api/docs/models>, <https://ai.google.dev/gemini-api/docs/pricing>,
<https://developers.openai.com/api/docs/pricing>.

## 2. Candidate batch STT

| Vendor / model | $/hr | Korean CER (FLEURS / CV) | Diarization | Max duration | Node | Free tier | Privacy | Verdict |
|---|---|---|---|---|---|---|---|---|
| Soniox `stt-async-v5` | $0.10 | 4.4 / 8.7 (best FLEURS) | included, 15 spk | 300 min | `@soniox/node` or raw REST | none | zero retention default | Cheapest and best measured Korean; see adoption plan |
| ElevenLabs Scribe v2 | $0.22 | 4.6 / 11.0 | included, 32 spk | 10 h | `@elevenlabs/elevenlabs-js` | 4.5 h/mo | ZDR enterprise-only | Second on Korean, longest files, no segmentation needed |
| Gemini 3.5 Transcribe | ~$0.30 blended | not benchmarked | native, 8 spk + word timestamps | 1 h, **30 min with diarization** | `@google/genai` (already a dep) | token free tier | Files API 48 h | Lowest migration cost; cap forces segmentation |
| Mistral Voxtral Mini Transcribe V2 | $0.18 | 5.8 / 14.3 | native | 3 h | `@mistralai/mistralai` | UNVERIFIED | UNVERIFIED | Open-weights base is a self-host escape hatch |
| AWS Transcribe | $0.36 | 4.9 / **7.5 (best CV)** | free | 4 h / 2 GB | AWS SDK v3 | 60 min/mo, 12 mo | trains on audio unless Organizations opt-out | Boring, consistently good; opt-out mandatory |
| Azure Speech batch | $0.18 | 9.4 / 10.4 | free on batch | 4 h | official | 5 h/mo F0 | UNVERIFIED | Cheap, mediocre Korean |
| Google Chirp 3 | $0.18 | not benchmarked | batch-only | 8 h | `@google-cloud/speech` | none | logging opt-in | Google steers to 3.5 Transcribe now |
| Gemini 3.5 Flash multimodal | ~$0.17 | not benchmarked | prompt-only labels | 9.5 h | already a dep | yes | Files API 48 h | Today's Gemini path |
| OpenAI `gpt-4o-transcribe-diarize` | $0.36 | 6.7 / 12.1 | yes | 25 MB | official | none | ZDR-eligible | Today's Codex path, being removed |
| OpenAI `gpt-4o-mini-transcribe` | $0.18 | 7.6 / 12.2 | no | 25 MB | official | none | ZDR-eligible | Cheap, no speakers |
| Speechmatics Enhanced | ~$1.04 UNVERIFIED | 5.4 / 7.2 | free | 1 GB | split packages | $100 credit | 7-day default | Good Korean, worst price |
| Gladia Solaria-1 | $0.61 (to $0.20 volume) | 6.6 / 9.6 | free | UNVERIFIED | `@gladiaio/sdk` | yes | EU residency | Solaria-3 lacks Korean |
| Deepgram Nova-3 | $0.26 mono / $0.31 multi | not in benchmark; Nova-2 21.0% in RTZR test | included | 2 GB | `@deepgram/sdk` | $200 credit | **trains unless `mip_opt_out=true`** | Korean unproven, wrong privacy default |
| Rev.ai | $0.30 | not benchmarked | UNVERIFIED | | yes | none | HIPAA | Open Reverb model is English-only |
| Groq `whisper-large-v3-turbo` | **$0.04** | Whisper Korean ~11% class | none | 100 MB | REST | yes | | Cheapest bulk pass, no speakers |
| AssemblyAI Universal-3.5 Pro | $0.21 | **no Korean** | +$0.02/hr | 10 h | yes | $50 | | Disqualified |
| Cartesia Ink-2 | plan-based | **no Korean** | | | | | | Disqualified |
| NVIDIA Parakeet / Canary | not public | **no Korean** | | | | | | Disqualified |

## 3. Candidate realtime STT

| Vendor / model | $/hr | Korean | Diarization | Session cap | Verdict |
|---|---|---|---|---|---|
| Soniox `stt-rt-v5` | $0.12 | 4.4 CER | included | 300 min | Cheapest realtime by 2x, no reconnect API |
| Deepgram Nova-3 streaming | $0.29 promo / $0.46 | unproven | **+$0.12/hr** | | Diarization is paid on RT only |
| Mistral Voxtral Realtime | $0.36 | yes | yes | | Open-weights sibling |
| ElevenLabs Scribe v2 Realtime | $0.39 | yes | UNVERIFIED | not stated | Pairs with batch runner-up |
| Gemini 3.5 Transcribe Live | $0.54 | yes | native | | Cheapest path that also covers batch |
| AWS Transcribe streaming | $0.60 | ko-KR, Seoul endpoint | free | 4 h | Longest session |
| Gladia RT | $0.75 (to $0.25) | UNVERIFIED | free | | |
| Google Cloud STT streaming | $0.96 | yes | not on streaming | **5 min** | Unusable here |
| Azure realtime | $1.00 + $0.30 diarization | yes | paid add-on | | Most expensive per feature |
| OpenAI `gpt-realtime-whisper` / `gpt-live-transcribe` | $1.02 | yes | no | | Today's path, 3 to 8x the alternatives |
| OpenAI `gpt-realtime-translate` | $2.04 | yes | no | | Only turnkey realtime translation besides Gemini Live |
| Speechmatics RT | $1.04 / $1.35 | yes | free | | Premium |
| AssemblyAI streaming | $0.45 | **none** | +$0.12 | | Disqualified |

## 4. Korean vendors

| Vendor | Self-serve API | $/hr (KRW 1,350) | Korean accuracy | Diarization | Realtime | KO/EN mix | Max | Verdict |
|---|---|---|---|---|---|---|---|---|
| ReturnZero (RTZR) VITO / Sommers | yes, developers.rtzr.ai | KRW 1,000 = $0.74 tier 1, down to $0.22 at 25k h/mo | 5.91% avg CER on AI-Hub incl. meeting/conference sets (self-published) | included | gRPC / WS | Sommers multilingual, specifics UNVERIFIED | not published | Only vendor with Korean *meeting* audio numbers; domestic billing |
| Naver CLOVA Speech | yes, NCP | ~$0.89 base, 15 s units | 7.5 to 9.5% CER (third-party tests) | yes, extra cost UNVERIFIED | yes | explicitly sells KO+EN simultaneous | 6 h async / 2 h sync | Only explicit code-switch product; 4 to 9x global leaders |
| Daglo (ActionPower) | credit-based, rates unpublished | n/a | vendor claims 8 to 10% better than Whisper, no method | >90% claimed | yes | KO/EN/JA mixed | 4 h / 2 GB | Needs a sales conversation |
| Kakao | **no** (public Speech API ended 2022-07) | | | | | | | Dead |
| Selvas AI, Saltlux | enterprise only | | | | | | | Not viable |

No self-serve STT API found for SKT, KT, Typecast, Sionic, Gooroomee.

## 5. LLM summarizers

| Model | In $/1M | Out $/1M | Context | Note |
|---|---|---|---|---|
| gemini-3.5-flash-lite | $0.30 | $2.50 | ~1M | 5x cheaper input than today |
| gemini-3.8-flash | $0.75 | $3.75 | 1M | promo to 2026-12-31 |
| gemini-3.5-flash (today) | $1.50 | $9.00 | 1M | vendor-labelled legacy |
| gemini-3.1-pro-preview | $2.00 / $4.00 >200k | $12.00 / $18.00 | 1M | current Pro; there is no 3.5-pro |
| claude-sonnet-5 | $2.00 | $10.00 | 1M | |
| claude-haiku-4-5 | $1.00 | $5.00 | 200k | |
| gpt-5.5 (today, Codex) | $5.00 | $30.00 | 1.05M | subscription-metered via OAuth |
| gpt-5.4-mini | $0.75 | $4.50 | 272k | |
| gpt-5 | $1.25 | $10.00 | 272k | |

All handle a 100k-token Korean transcript. All have 50% batch discounts.

## 6. Ranking for evaluation

1. **Soniox**: best measured Korean CER at the lowest price, one vendor for batch and realtime.
2. **ElevenLabs Scribe v2 (+ Realtime)**: second on Korean, 32 speakers, 10-hour files remove
   segmentation and boundary reconciliation entirely.
3. **ReturnZero**: the only meeting-audio Korean benchmark, diarization and realtime included,
   $0.22/hr at volume, domestic billing. Discount the self-published number.
4. **Gemini 3.5 Transcribe**: cheapest migration (client, key, upload path exist), native
   8-speaker labels with word timestamps, but a 30-minute cap with diarization keeps segmentation.
5. **AWS Transcribe**: best Common Voice Korean, free diarization, 4-hour files and sessions,
   Seoul endpoint. Requires an Organizations opt-out for training.

Runners-up: Mistral Voxtral (open weights), Groq Whisper turbo ($0.04/hr bulk, no speakers).
Do not pursue: AssemblyAI, Cartesia, NVIDIA (no Korean), Deepgram (unproven Korean, trains by
default).

## 7. Suggested next steps

1. Decide the Codex diarization replacement before 2027-02-26 (Soniox eval is the obvious first
   candidate; ElevenLabs and ReturnZero are the fallbacks).
2. Run the Phase 0 eval in `docs/soniox-adoption-plan.md` with ElevenLabs Scribe v2 and ReturnZero
   added to the same corpus, so one paid session ranks all three on real Korean/English meetings.
3. Bump `gemini-3.1-flash-live-preview` to `gemini-3.8-live` and re-verify session caps.
4. Trial `gemini-3.8-flash` or `gemini-3.5-flash-lite` for the summary stage on the same corpus.
