# Production live AI hints

## Product behavior

Live captions generate contextual hints automatically while speech continues. There is no separate automatic-generation switch, manual request button, preview preference, search/grouping setting, pin, or dismiss-to-history action. Production has no fictional live-experience entry point. The unreleased generation-mode configuration and manual-request IPC surface have been removed. Older local development files may still contain `liveHintsAutoEnabled`; it is ignored and preserved as unknown stored JSON, without rewriting real user configuration.

A new hint appears in a separate nonmodal popover at the top of the window for five seconds, including while the live-session dialog is open. It does not capture focus or block recording controls. Hover, keyboard focus, and text selection pause expiry. Closing or expiring the popover leaves the hint in the chronological history associated with its recording. Restoring a snapshot does not replay old hints as new popovers.

Rows emphasize the short title and cited speech time. Cue wording, source excerpts, and previous revisions remain inspectable. Missing source time is not replaced with generation time. Source correction and incomplete-history notices remain visible when applicable. Only explicit valid model updates revise existing cues; fuzzy wording matches do not merge them.

The prompt requires useful additions such as an explanation, implication, meaningful calculation, unresolved decision variable, or missing check. Rephrasing the conversation or extracting an already stated task is not sufficient. General knowledge and conditional advice must remain distinct from source facts. Question/answer candidates may be withheld when newer speech makes them stale.

## Text route and request bounds

`LiveSessionService` owns one `LiveHintEngine` per session. Hints use recent source text, never another audio upload. ChatGPT hints use account-discovered `gpt-6-luna` with low reasoning through the same signed-in ChatGPT plan route. An unavailable model fails explicitly; there is no silent model or billing fallback. Summary and agent model selection remain unchanged. Gemini hints retain the selected Gemini text route.

| Rule | Current default |
| --- | --- |
| Early request threshold | 24 normalized new source characters |
| Minimum automatic interval | 5 seconds |
| Maximum pending wait | 5 seconds for nonempty pending source |
| Additional quiet-period signal | 1.5 seconds |
| Recent source context | 300 seconds, at most 12,000 Unicode code points |
| Concurrent generation | One request; new speech coalesces |
| Automatic response usefulness deadline | 20 seconds after request start |
| Shared rolling allowance | 720 requests per hour |

The character threshold controls early admission, not maximum context length. Continuous speech does not need to become silent. Stability, an in-flight request, backoff, and the allowance can delay dispatch; these defaults do not promise end-to-end latency or optimal cost. Provider paths without incremental source finals can use stable original-input draft prefixes. Later finals reconcile citations; drafts do not become fabricated transcript finals.

## Recording history and compatibility

Main binds hints to the active recording identity. Multiple live sessions in one recording retain their own source snapshots and revisions, including when captions stop before the recording. On recording stop, the archive is saved with recording metadata. Transcription carries it into the optional versioned `live-hints.json` sidecar in the saved meeting folder. Without an active recording, history remains session-only.

The live list is bounded to 200 cues. Recording archives are independently bounded to 2,000 cues per session, 32 sessions per recording, and an 8 MB payload budget; truncation is disclosed. Existing recordings without hint history remain readable. Report regeneration preserves the sidecar. Merge does not transfer source-recording hints into the new meeting, and ordinary report exports do not include them.

Hint evidence stays local: Drive upload and download enumeration always exclude `live-hints.json`, including with custom sync exclusions. This does not mean inference is local: recent source context is sent to the selected text provider. Hints remain separate from confirmed action items and manually authored notes.

## Verification boundaries

See [verification record](live-hints-ux-qa.md). Historical fixture results establish their dated build behavior only. They do not establish current native UI acceptance after subsequent production cleanup, provider quality in arbitrary meetings, installed-package behavior, or assistive-technology usability.
