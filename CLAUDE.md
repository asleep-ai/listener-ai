# Listener.AI - LLM Context

## Project Overview
Listener.AI is an Electron desktop application for recording meetings and producing AI-generated transcripts, summaries, key points, and action items. It also ships a `listener` CLI that shares the same config and transcription store for headless use.

## Core Features

### 1. Audio Recording
- Chromium `MediaRecorder` in the renderer captures the mic via `navigator.mediaDevices.getUserMedia()`. No ffmpeg in the capture path.
- Why: ffmpeg's `-f avfoundation` input (`AVCaptureAudioDataOutput`) produced periodic digital ticks on macOS. Chromium's audio path goes through Core Audio HAL directly and is clean.
- `getUserMedia` is called with `echoCancellation: false`, `noiseSuppression: false`, `autoGainControl: false` so macOS Voice Isolation (`AUVoiceIO`) can't touch the signal.
- Web Audio processing chain before `MediaRecorder`: highpass 80Hz → DynamicsCompressor (threshold -30dB, ratio 8, 3ms attack) → Gain ×4 (+12dB) → brick-wall limiter at -1 dBFS. Tuned for meeting/conference use: lifts distant speakers, tames close-range transients, prevents clipping.
- Output: `audio/webm;codecs=opus` at 64 kbps mono (Chromium's native MediaRecorder codec). Falls back to other supported types via `MediaRecorder.isTypeSupported`.
- Duration cap (`maxRecordingMinutes`), reminder cadence (`recordingReminderMinutes`), and minimum-length floor (`minRecordingSeconds`, discards accidental taps).
- **System audio capture (macOS, opt-in via `recordSystemAudio`)**: `getDisplayMedia({video:true, audio:true})` pulls a loopback track covering Zoom/Meet participants, browser tabs, and other app audio. On macOS the renderer is routed through the native ScreenCaptureKit picker via `setDisplayMediaRequestHandler(..., { useSystemPicker: true })` -- `audio: 'loopback'` via a custom handler returns a stream without audio tracks on Electron 37 (Windows-only per Electron's own types). The user selects a display + "Record audio" in the native picker; the renderer discards the video track and mixes the audio into the Web Audio chain alongside the mic (mic keeps the voice-lift chain, system audio passes through a -2dB gain, shared limiter catches combined peaks). Windows/Linux keep the no-picker `audio: 'loopback'` path. Chromium feature flags `MacSckSystemAudioLoopbackCapture` / `MacCatapSystemAudioLoopbackCapture` are left enabled at module load for forward-compat. Requires macOS Screen Recording permission; falls back to mic-only when permission is denied. Future migration path: a native Core Audio Tap module (`mac-audio-capture` / AudioTee) to request only the narrower "System Audio Recording Only" permission (macOS 14.4+).
- Known limitation: chunks accumulate in renderer memory until `stop`. A renderer crash mid-session loses the recording. Streaming chunks to main during capture is a planned future enhancement.

### 2. User Interface
- Resizable macOS-style window layout (redesigned from the earlier fixed compact mode)
- Recording controls: start/stop, live duration, editable meeting title
- Recent recordings list with per-item actions and a search box
- Settings modal for API keys, models, auto mode, detection toggles, global shortcut, custom summary prompt, and known words
- AI agent chat panel in the main window (see §6)
- Progress indicators for transcription, Notion upload, and ffmpeg download
- Renderer is vanilla JS (no React/framework); talks to main only via IPC

### 3. AI Transcription and Summarization
- Google Gemini 2.5 (Flash/Pro, configurable via `geminiModel` and `geminiFlashModel`)
- Uploads audio through the Gemini files API; segments recordings longer than ~5 minutes
- Korean-focused output: full transcript with speaker identification, summary, key points, action items, auto-generated title, and emoji icon
- User-supplied `summaryPrompt` and `knownWords` (proper-noun hints) are injected into the prompt

### 4. Notion Integration (BYOK)
- User supplies `notionApiKey` + `notionDatabaseId`; the app writes structured pages into their own database
- Long transcripts are split to respect Notion's block-size limits
- Page contains: title (with "by L.AI" suffix), date, summary, key points, action items, transcript, emoji icon

### 5. Local Search
- Full-text search over stored transcriptions (`src/searchService.ts`)
- No persistent index: each query rescans `transcriptions/` and re-reads frontmatter + body
- Field weighting: title 10, summary 5, keyPoints/actionItems 3, transcript 1
- Snippet extraction (~80 chars around first match)
- Exposed via GUI search box and `listener search` CLI

### 6. AI Agent Chat
- Conversational access to saved meetings and settings (`src/agentService.ts`), backed by Gemini with a fixed tool set
- Tools: `search_transcriptions`, `list_recent_transcriptions`, `get_transcription`, `get_config`, `set_config`
- `set_config` write whitelist (non-secret keys only): `autoMode`, `meetingDetection`, `displayDetection`, `globalShortcut`, `maxRecordingMinutes`, `recordingReminderMinutes`, `minRecordingSeconds`, `geminiModel`, `geminiFlashModel`. API keys and Notion database ID can neither be read nor written by the agent.
- Every `set_config` call requires explicit user confirmation through an IPC approval flow
- Folder-name arguments are validated (NUL / path-separator rejection) to block traversal
- Chat history lives only in renderer memory — lost on reload, not synced across devices or restarts
- Available as GUI chat panel and `listener ask <question>` CLI

### 7. Automatic Recording Triggers
- **Meeting detection** (`src/meetingDetectorService.ts`, macOS): polls `pmset -g assertions` every 5s for `PreventUserIdleSleep` assertions owned by video-call processes, which distinguishes "app open" from "in a call". Confirms start after 2 consecutive detections, end after 3 non-detections.
- **Display detection** (`src/displayDetectorService.ts`): listens to Electron `screen` `display-added`/`display-removed` events and prompts the user when an external display connects (projector-setup trigger).
- Controlled by `meetingDetection` and `displayDetection` config flags.

## Technical Stack
- Electron 37.x
- TypeScript 5.8, Node.js 24.x
- pnpm (no workspaces)
- `@google/genai` for Gemini
- `@notionhq/client` (optional dependency)
- `marked` for markdown rendering
- Chromium `MediaRecorder` + Web Audio for mic capture (no external binary)
- ffmpeg downloaded at runtime from `eugeneware/ffmpeg-static` GitHub releases, used only for long-audio segmentation in the transcription pipeline (NOT for recording — see FFmpeg Licensing)
- Tests: Node's built-in `node --test` runner (no Jest/Vitest)

## CLI Usage

```
listener <file> [--output <dir>]    Transcribe and summarize an audio file
listener list [--limit <n>]         List past transcriptions
listener show <ref>                  Print summary to stdout
listener export <ref> [<path>] [--json] [--transcript]
                                     Export a transcription
listener search <query> [--limit <n>] [--transcript] [--field <name>]
                                     Search past transcriptions
listener ask <question> [--ref <ref>]
                                     Ask the AI agent about meetings or settings
listener config list|get|set|path    Manage configuration
```

- `<ref>` is either an index from `listener list` or a transcription folder name.
- `--field` accepts: `title`, `summary`, `keyPoints`, `actionItems`, `transcript`, `all`.
- CLI and GUI share the same `config.json` in the app data directory.

## Configuration

All values are stored in plaintext JSON at `getDataPath()/config.json`.

| Key | Purpose |
|---|---|
| `geminiApiKey` | Gemini API key (required for transcription) |
| `geminiModel` | Gemini model for summary/agent |
| `geminiFlashModel` | Flash model for cheaper/faster calls |
| `notionApiKey`, `notionDatabaseId` | Optional Notion integration (BYOK) |
| `autoMode` | Auto-transcribe and upload to Notion after recording |
| `meetingDetection`, `displayDetection` | Auto-trigger sources |
| `globalShortcut` | Start/stop hotkey |
| `knownWords` | Proper nouns / jargon injected into Gemini prompt |
| `summaryPrompt` | User-customized summary-stage prompt |
| `maxRecordingMinutes` | Hard stop for long recordings |
| `recordingReminderMinutes` | Reminder cadence |
| `minRecordingSeconds` | Discards accidental short recordings |
| `recordSystemAudio` | Mix system audio loopback (Zoom/Meet) into the recording (macOS only) |
| `lastSeenVersion` | Drives "what's new" release-notes modal |

Env-var fallbacks (read-only when the config key is empty): `GEMINI_API_KEY`, `NOTION_API_KEY`, `NOTION_DATABASE_ID`.

## Transcription Storage

- Root: `getDataPath()/transcriptions/`
- One folder per meeting: `<sanitized-title>_<timestamp>/`
  - `summary.md` — YAML frontmatter (`title`, `suggestedTitle`, `summary`, `keyPoints`, `actionItems`, `customFields`, `audioFilePath`, `transcribedAt`, `emoji`) plus markdown body
  - `transcript.md` — full transcript
  - Optional original audio file
- `src/outputService.ts` is the only read/write surface: `saveTranscription`, `listTranscriptions`, `readTranscription`, `parseFrontmatter`, `getTranscriptionsDir`.

## Architecture Overview

### Entry points
- `src/main.ts` — Electron main process, window lifecycle, and ~25 IPC handlers covering recording, config, agent chat, Notion, search, metadata, ffmpeg, and auto-update
- `src/preload.ts` — `contextBridge` exposing `window.electronAPI` to the renderer
- `src/cli.ts` — CLI entry, shares services with main

### Renderer (at repo root, not under `src/`)
- `index.html`, `renderer.js`, `styles.css` — vanilla JS, no framework
- Included in the packaged build via `build.files`

### Top-level services (`src/*.ts`)
- `simpleAudioRecorder.ts` — thin session state + final file writer. Receives the encoded Opus/WebM blob from the renderer after `MediaRecorder` finalizes and writes it to the recordings directory. No ffmpeg spawn, no OS-specific device detection — all capture happens in the renderer.
- `audioFormats.ts` — shared MIME/extension mapping (`mimeTypeForExtension`, `extensionForMimeType`, `SUPPORTED_AUDIO_EXTENSIONS`) used across main, CLI, Gemini upload, and file import paths.
- `geminiService.ts` — file upload, transcription, summarization, segmentation
- `notionService.ts` — Notion client, block splitting, page assembly
- `configService.ts` — `config.json` read/write, env-var fallback, masking
- `outputService.ts` — transcription folder layout and frontmatter serialization
- `searchService.ts` — in-memory field-weighted search
- `agentService.ts` — tool-using Gemini agent with confirmation flow
- `meetingDetectorService.ts` — pmset-based in-call detection (macOS)
- `displayDetectorService.ts` — Electron `screen` event wrapper
- `menuBarManager.ts` — system tray / dock menu
- `dataPath.ts` — platform-specific app data directory resolver

### Subsystem services (`src/services/*.ts`)
- `ffmpegManager.ts` — ffmpeg detection, download, checksum verification scaffolding
- `fileHandlerService.ts` — drag-and-drop import and file dialogs
- `metadataService.ts` — pre-transcription recording metadata
- `notificationService.ts` — system notification helpers
- `autoUpdaterService.ts` — electron-updater wrapper
- `releaseNotesService.ts` — "what's new" modal driver (reads `lastSeenVersion`)

### Tests
- Test files: `agentService.test.ts`, `searchService.test.ts`, `meetingDetectorService.test.ts`
- Run: `pnpm test` (builds with tsc, then executes compiled `.test.js` with `node --test`)

## Background Recording Policy
Recording starts silently — never bring the window to foreground (no `show()`/`focus()`) and never fire a "Recording Started" notification. This applies to all recording triggers: global shortcut, tray click, meeting detection, and display detection. Display detection in particular is designed to be discreet — the user allows recording via the notification without the app becoming visible. Only explicit user actions (dock click, tray menu "Open", notification click for non-recording events) should show the window.

## Release and Auto-Update
- macOS x64 and arm64 must be built together in a single job (`--mac --x64 --arm64`).
- Reason: electron-builder generates one `latest-mac.yml` listing both architectures. Separate jobs overwrite each other's yml and one arch ends up pointing at the wrong binary.
- electron-updater uses filename patterns (x64/arm64) to serve the correct binary to each user.
- Auto-update is disabled when `app.isPackaged === false` (dev mode). Test with a packaged build, not `pnpm start`.
- Browser fallback: when auto-update fails, show a dialog with a link to GitHub releases.
- macOS auto-update requires ZIP artifacts (not DMG); electron-updater downloads the ZIP for in-place replacement.
- Blockmap files (`*.blockmap`) enable differential updates — users download only the changed blocks.
- The GitHub workflow must publish ZIP + blockmap alongside DMG for auto-update to work.

## FFmpeg Licensing
- ffmpeg binaries are downloaded at runtime from `eugeneware/ffmpeg-static` GitHub releases, not bundled.
- `ffmpeg-static` (the npm package/repo) is GPL-3.0-licensed.
- ffmpeg itself is LGPL 2.1+ for default builds; the MP3-via-libmp3lame use case stays within LGPL.
- Do NOT add `ffmpeg-static` as an npm dependency — it would impose GPL-3.0 on the project.
- For CLI npm distribution: prefer requiring user-installed ffmpeg, or keep the runtime-download approach.
- SHA256 checksums in `ffmpegManager.ts` are currently empty (`// TODO`) — fill them in for integrity verification.

## npm Distribution
- Package name: `listener-ai`. Only the CLI portion is published to npm (Electron app ships via GitHub Releases).
- Electron-only runtime deps (`electron-updater`, `@notionhq/client`) live in `optionalDependencies` — honest semantics for a package serving both Electron and CLI users. `build.files` includes `node_modules/**/*`, so they are still bundled in Electron builds.
- `package.json.files` whitelists the exact compiled JS shipped to npm: `dist/cli.js`, `dataPath.js`, `configService.js`, `geminiService.js`, `outputService.js`, `searchService.js`, `agentService.js`, `services/ffmpegManager.js`.

## Future Enhancements (Optional)
- Cloud sync of transcriptions, settings, and agent chat history across devices
- Email delivery of summaries / weekly digests
- Live transcription during recording
- Speaker diarization improvements
- Export to PDF
- Full multi-language support beyond Korean
- Bundled ffmpeg for all platforms (subject to licensing)
