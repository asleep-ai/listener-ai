# AI Model Pricing Reference

Pricing for the AI models Listener.AI uses (or could switch to) for transcription, summarization, and the chat agent. Verified May 2026.

When prices drift, update the date in the cell and re-cite from the provider's own pricing page (not blogs).

## Models currently in production

| Use case | Provider config | Model | Pricing | Notes |
|---|---|---|---|---|
| Transcription (Gemini) | `geminiFlashModel` | gemini-2.5-flash | $1.00/M audio-input tokens, $2.50/M output | Audio input only at this rate; text/image input is $0.30/M. Speaker diarization works via prompt instructions. |
| Summary + agent (Gemini) | `geminiModel` | gemini-2.5-pro | $1.25/M input, $10.00/M output (≤200k ctx) | Doubles to $2.50/$15.00 at >200k ctx. Context cache at $0.125/M/hr storage. |
| Transcription (Codex) | `codexTranscriptionModel` | gpt-4o-transcribe | $0.006/min ($2.50/M audio in, $10.00/M text out) | No speaker diarization. `prompt` param is vocabulary/style hint only. |
| Summary + agent (Codex) | `codexModel` | gpt-5.5 (via ChatGPT Codex Responses) | $5.00/M input, $30.00/M output (API price; ChatGPT subscription absorbs cost) | Rejects `temperature`/sampling params (reasoning model). Cached input $0.50/M. |

## Provider notes

**Google Gemini** — API key via Google AI Studio or Vertex AI. Free tier exists for AI Studio but is rate-limited and not for production. No announced end-of-life for 2.5 Flash or 2.5 Pro as of May 2026.

**OpenAI Codex (ChatGPT subscription)** — OAuth via `@earendil-works/pi-ai/oauth`. Codex GUI usage on Plus/Pro plans is metered against shared 5-hour message-window allowances. Business/Enterprise plans switched to per-token credits aligned with API rates on 2026-04-02. The same models are also accessible directly via API key at the per-token prices below.

**OpenAI Transcription** — API key. Metered separately from the ChatGPT subscription. Listener.AI's OAuth flow currently passes the ChatGPT access token as the Bearer for `/v1/audio/transcriptions`, which OpenAI accepts. End-of-life: `whisper-1` is still available at the same per-minute rate as `gpt-4o-transcribe`.

## Full pricing tables

### Gemini (Google)

All prices per 1M tokens unless noted.

| Model | Input | Output | Notes |
|---|---|---|---|
| gemini-2.5-pro (≤200k ctx) | $1.25 | $10.00 | Context cache: $0.125/M/hr storage |
| gemini-2.5-pro (>200k ctx) | $2.50 | $15.00 | Same model, higher-context tier |
| gemini-2.5-flash (text/image/video in) | $0.30 | $2.50 | Context cache: $0.03/M/hr |
| gemini-2.5-flash (audio in) | $1.00 | $2.50 | Output price same regardless of input modality |

Batch tier: 50% of standard. Priority tier: ~1.8× standard. Source: <https://ai.google.dev/pricing> (verified 2026-05-13).

### OpenAI Chat / Codex

All prices per 1M tokens.

| Model | Input | Output | Notes |
|---|---|---|---|
| gpt-5.5 | $5.00 | $30.00 | Current Codex flagship. Cached input $0.50/M. |
| gpt-5.4 | $2.50 | $15.00 | Cached input $0.25/M |
| gpt-5.4-mini | $0.75 | $4.50 | Cached input $0.075/M |
| gpt-5.4-nano | $0.20 | $1.25 | Cached input $0.02/M |
| gpt-5 | $1.25 | $10.00 | Previous-gen flagship; no caching listed |
| gpt-4o | $2.50 | $10.00 | Legacy; still accessible. 4.1 family is OpenAI's recommended replacement. |
| gpt-4o-mini | $0.15 | $0.60 | Legacy; still accessible |
| gpt-4o-audio-preview | unverified | — | Not on the public pricing page as of May 2026; superseded by the realtime API |

Sources: <https://developers.openai.com/api/docs/pricing>, <https://developers.openai.com/codex/pricing> (verified 2026-05-13).

### OpenAI Transcription

Prices per audio minute (primary). Token-based alternative shown for reference.

| Model | $/min | Token alt | Speaker diarization | Notes |
|---|---|---|---|---|
| gpt-4o-transcribe | $0.006 | $2.50/M audio in, $10.00/M text out | No | Current default in Listener.AI. `prompt` = vocabulary/style hint, not instruction. |
| gpt-4o-mini-transcribe | $0.003 | $1.25/M audio in, $5.00/M text out | No | Cheaper, lower accuracy. |
| gpt-4o-transcribe-diarize | $0.006 | Same as gpt-4o-transcribe | **Yes** (`response_format: 'diarized_json'`) | Released 2025-10-18. No `prompt` support. `chunking_strategy: 'auto'` required for >30s audio. Known quirks: word skipping, occasional hallucinated speaker counts. |
| whisper-1 | $0.006 | — | No | Same price as gpt-4o-transcribe. |

Source: <https://costgoat.com/pricing/openai-transcription> (verified 2026-05-13), <https://platform.openai.com/docs/models/gpt-4o-transcribe-diarize>.

### Third-party transcription (with diarization)

For comparison only — none of these are wired into Listener.AI today.

| Service / Model | Price | Korean | Diarization | Free tier | Source |
|---|---|---|---|---|---|
| AssemblyAI Universal-2 | $0.15/hr (~$0.0025/min) | Yes | +$0.02/hr | 185 hrs pre-recorded | <https://www.assemblyai.com/pricing/> |
| AssemblyAI Universal-3 Pro | $0.21/hr (~$0.0035/min) | Not yet | +$0.02/hr | 185 hrs pre-recorded | <https://www.assemblyai.com/pricing/> |
| Deepgram Nova-3 Multilingual | $0.0092/min pre-rec, $0.0058/min stream | Yes | +$0.0020/min | $200 credit | <https://deepgram.com/pricing> |
| Deepgram Nova-3 Monolingual | $0.0077/min pre-rec, $0.0048/min stream | n/a | +$0.0020/min | $200 credit | <https://deepgram.com/pricing> |
| Rev.ai Reverb | $0.20/hr (~$0.0033/min) | Yes | unverified | 5 hr credit | <https://www.rev.ai/pricing> |
| Rev.ai Reverb Turbo | $0.10/hr (~$0.0017/min) | Yes | unverified | 5 hr credit | <https://www.rev.ai/pricing> |
| Speechmatics (Pro tier) | from $0.24/hr (~$0.004/min) | Yes | not publicly itemized | 480 min/month | <https://www.speechmatics.com/pricing> |

All verified 2026-05-13.

## Speaker diarization options

The Gemini path natively returns "참가자1: ... / 참가자2: ..." because `gemini-2.5-flash` is a multimodal LLM and follows the system prompt. The Codex path through `/v1/audio/transcriptions` does not — `prompt` is documented as a vocabulary/style hint only. Three viable paths if speaker labels are needed on the Codex side:

1. **`gpt-4o-transcribe-diarize`** (default since this PR) — same endpoint, same price, native diarization. Loses the `prompt` parameter, so user glossaries (`knownWords`) can't be passed. Output is `{segments: [{speaker, start, end, text}]}` which we remap onto our `참가자N` convention.
2. **Post-process via Codex chat** — transcribe with `gpt-4o-transcribe` as today, then send the plain transcript to `gpt-5.5` with a "label by speaker" instruction. Adds one round-trip; quality drops for 3+ speakers since the model can only infer from conversational cues, not voice.
3. **Third-party API** (AssemblyAI / Deepgram / Speechmatics) — requires a separate API key and breaks the "ChatGPT subscription only" promise. Highest accuracy but worst UX for Codex users.

### Known limitations of the diarize default

- **Cross-segment speaker incoherence.** We intentionally split long audio into 5-minute chunks and upload them in parallel — this is much faster than a single long upload for both Gemini and OpenAI. The diarize model re-numbers speakers per request, so "참가자1" in segment 1 is not guaranteed to be the same physical person as "참가자1" in segment 2. Each chunk is internally consistent. To merge speakers across chunks you would need to seed `known_speaker_references` from the first chunk and re-upload — not implemented today.
- **`knownWords` glossary is dropped.** The diarize model rejects the `prompt` parameter. Users who depend on vocabulary biasing should run `listener config set codexTranscriptionModel gpt-4o-transcribe` to go back to the pre-diarize path (no speaker labels).
- **Word skipping + speaker count hallucination.** Reported by the OpenAI community at launch (Oct 2025). Language-agnostic, no Korean-specific benchmark.
- **No forced `language` hint.** We let Whisper's auto-detection (first ~30s) decide. Forcing `language: 'ko'` slightly improves accuracy for purely Korean audio but degrades English/code-switched sections (acronyms transcribed phonetically, e.g. "API" → "에이피아이"). Most meetings here are bilingual, so auto-detect wins on average.

For Korean meetings the data points are thin. AssemblyAI Universal-2 has confirmed Korean diarization with consistent speaker IDs across the whole recording, which is the obvious fallback if cross-chunk incoherence becomes a real problem.

## Sources

- [Google AI Pricing](https://ai.google.dev/pricing)
- [OpenAI API Pricing](https://developers.openai.com/api/docs/pricing)
- [OpenAI Codex Pricing](https://developers.openai.com/codex/pricing)
- [OpenAI Transcription pricing aggregator](https://costgoat.com/pricing/openai-transcription)
- [gpt-4o-transcribe-diarize model card](https://platform.openai.com/docs/models/gpt-4o-transcribe-diarize)
- [AssemblyAI Pricing](https://www.assemblyai.com/pricing/)
- [AssemblyAI supported languages](https://www.assemblyai.com/docs/pre-recorded-audio/supported-languages)
- [Deepgram Pricing](https://deepgram.com/pricing)
- [Rev.ai Pricing](https://www.rev.ai/pricing)
- [Speechmatics Pricing](https://www.speechmatics.com/pricing)
