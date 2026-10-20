# Listener.AI genuine landing demo

## Deliverables

- `docs/assets/demos/listener-demo.mp4`: silent product tour, actual Electron renderer video plus explicitly documented held real UI frames; H.264, 1440 × 1080, 30 fps, 29.033 seconds, fast-start MP4.
- `docs/assets/demos/listener-demo.jpg`: frame extracted from that video.
- `docs/assets/demos/listener-demo.ko.vtt`: Korean descriptive captions. These describe the tour, rather than claiming to transcribe a soundtrack.
- `evidence/`: real saved provider output, metadata, provider timing evidence and the visible final Ask text. No credentials or private meetings are included.

## Source, attribution and license

Meeting audio: **AMI Meeting Corpus, meeting ES2002a, headset mix**, provided by the AMI Project / AMI Consortium.

- Official download and license statement: https://groups.inf.ed.ac.uk/ami/download/
- Original WAV: https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/ES2002a/audio/ES2002a.Mix-Headset.wav
- License: **Creative Commons Attribution 4.0 International**, https://creativecommons.org/licenses/by/4.0/
- Source excerpt: **00:02:00–00:04:00**, 120 seconds, converted to mono 16 kHz WAV with ffmpeg; no speech was added or replaced. The excerpt covers the design-process introduction and whiteboard icebreaker, not a fabricated product meeting.
- Original SHA-256: `9c76866990fcc8b84006dc32d273ad99df439090b748ebe72103bb78c3216ee7`
- Excerpt SHA-256: `ad17340d90a45ca1cc8b4a1cc28bd6aef1209c2df755f92eceb1c83791de0430`

The audio is not included as a soundtrack. Its genuine transcript and derived report appear inside the app capture. The corpus attribution applies to the displayed derived meeting material as well. The video frames, captions, cuts and held frames are demo adaptations; AMI does not endorse Listener.AI.

## Real processing provenance

- Source checkout: `7bc1b08c8c83749f1601c366bae69d1340eae444` (Listener.AI 2.17.0); TypeScript/Vite build prepared by the coordinator.
- Actual source renderer loaded from `dist/renderer/index.html` in Electron 43; visible window at 1280 × 900.
- Isolated runtime: `NODE_ENV=test`, `LISTENER_DATA_PATH=/tmp/listener-landing-demo-6c6014`, background test mode disabled for this explicitly authorized visible demonstration. Real recordings/configuration were not modified. Only selected provider configuration was copied privately; credentials were never put in capture frames or checked-in files.
- Imported through the real drop-zone click and app ingestion flow. Playwright selected the sample file by instrumenting the native file picker response, and accepted the app's normal import/transcribe confirmation. No transcription, report, IPC service result or provider response was mocked.
- Actual STT: **Soniox `stt-async-v5`**, 120,000 ms audio, completed 2026-10-20 11:20:21 UTC.
- Actual report: **Gemini `gemini-3.5-flash`**, completed 11:20:29 UTC. Saved title: **Remote Control Design Project Kickoff & Icebreaker**. Generation ID: `c231a960-41b3-4ddb-aa99-d5355604d4e5`. Saved output is retained in `evidence/`.
- Actual meeting-scoped Ask: **Gemini `gemini-2.5-flash`**, completed 11:21:10 UTC. Question: “What is the team designing, and what requirements were discussed?” The real Korean answer says the team is designing a remote control and no specific remote-control requirements were discussed.
- No action items were invented for this introductory excerpt. This demo does not claim Notion/Drive export or microphone recording validation.

## Capture, edits and first failures

The available CUA inventory succeeded, but exact-path `getApp` failed with **Computer Use server error -10005: failedToCreateImageDestination** before yielding an app binding. Bundle-ID lookup was also ambiguous between three worktrees. The coordinator explicitly approved visible Electron Playwright capture as the fallback. No desktop-input workaround was used.

The first Playwright capture selected DevTools before source renderer navigation; a second bounded correction observed the window before its URL was ready. Those captures were excluded. The actual import/processing succeeded on the next capture, but a stale “View Transcript” text locator did not match the current accessible row; the provider result was retained, and a subsequent capture reopened that same saved note without repeating transcription. The final capture closes development DevTools and explicitly selects the `file:` source renderer. All failures remain in the isolated temporary capture logs.

`capture.cjs` records the real renderer with Playwright's native video recorder and takes real screenshots at checkpoints. `render.py` uses ffmpeg to edit the recorded footage, crop recorder padding, add a surrounding title/footer and concatenate:

1. Actual import/upload footage (6 s).
2. Reopened saved report, Summary and Transcript tabs (10.3 s).
3. Held genuine Transcript screenshot (2.7 s).
4. Actual Ask interaction and answer (8.1 s).
5. Held genuine Ask screenshot (2 s).

Processing waits and the pause between capture sessions are removed; the footer says **“Actual app capture | Processing waits removed | AMI Corpus CC BY 4.0”** throughout. No report content or UI was redrawn. Source capture files and private isolated config remain under `/tmp/listener-landing-demo-6c6014`; only public evidence is included here. To reproduce, set `LISTENER_DEMO_DATA` to a new isolated directory, privately supply authorized provider credentials, download/trim the source, build, then run `node tools/landing-video/capture.cjs` and `python3 tools/landing-video/render.py`; the rendering script's raw-video IDs must be updated for the new capture.

## Verification

The real Home, saved All report, Transcript and final Ask screenshots were visually inspected. The final poster and representative final MP4 frames were inspected after encoding. ffprobe confirms the final codec, dimensions, frame rate and duration, and a full ffmpeg decode checks the MP4 for errors. Captions end at the video end, contain no audio transcript claim, and disclose removed waits and held frames. Secrets are absent from all exported evidence and frames; real credentials remain only in the private temporary runtime.
