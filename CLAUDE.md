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
- Renderer is TypeScript with plain DOM (no React/framework), bundled by Vite; talks to main only via IPC

### 3. AI Transcription and Summarization
- Provider is selected by `aiProvider`: `gemini` uses Google Gemini 2.5 (Flash/Pro, configurable via `geminiModel` and `geminiFlashModel`); `codex` uses Codex OAuth tokens plus OpenAI transcription/Responses endpoints (configurable via `codexTranscriptionModel` and `codexModel`)
- Gemini uploads large audio through the Gemini files API; Codex converts unsupported audio formats to WebM/Opus first; both providers segment long or over-limit recordings
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
- Conversational access to saved meetings and settings (`src/agentService.ts`), backed by the selected AI provider with a fixed tool set
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
- `@earendil-works/pi-ai/oauth` for Codex OAuth token acquisition/refresh
- native `fetch` for Codex Responses and OpenAI transcription calls
- `@notionhq/client` (optional dependency)
- `marked` for markdown rendering
- Chromium `MediaRecorder` + Web Audio for mic capture (no external binary)
- ffmpeg downloaded at runtime from `eugeneware/ffmpeg-static` GitHub releases, used only for long-audio segmentation in the transcription pipeline (NOT for recording — see FFmpeg Licensing)
- Tests: Node's built-in `node --test` runner (no Jest/Vitest)

## CLI Usage

```
listener <file> [--output <dir>]    Transcribe and summarize an audio file
listener transcript <file> [--output <path>] [--prompt <text>]
                                     Transcribe to plain text only (stdout by default;
                                     --output writes to a file, or to <dir>/<basename>.transcript.md
                                     if the path is an existing directory). --prompt replaces
                                     the default speaker-identification instruction; glossary
                                     (knownWords) and per-segment positional prefix stay automatic.
listener list [--limit <n>]         List past transcriptions
listener show <ref>                  Print summary to stdout
listener export <ref> [<path>] [--json] [--transcript]
                                     Export a transcription
listener search <query> [--limit <n>] [--transcript] [--field <name>]
                                     Search past transcriptions
listener merge <ref1> <ref2> [<ref3>...] [--title <t>]
                                     Concat source audio of two or more notes,
                                     re-transcribe end-to-end, save as a new note
listener ask <question> [--ref <ref>]
                                     Ask the AI agent about meetings or settings
listener codex login|logout|status   Manage Codex OAuth sign-in
listener config list|get|set|unset|path
                                     Manage configuration
listener --version                   Print CLI version
listener --help                      Show usage
```

- `<ref>` is either an index from `listener list` or a transcription folder name.
- `--field` accepts: `title`, `summary`, `keyPoints`, `actionItems`, `transcript`, `all`.
- `config set` / `config unset` accept the keys listed in the Configuration table below, except `audioDeviceId` (UI-only) and `lastSeenVersion` (managed by the app).
- CLI and GUI share the same `config.json` in the app data directory.

## Configuration

All values are stored in plaintext JSON at `getDataPath()/config.json`.

| Key | Purpose |
|---|---|
| `aiProvider` | `gemini` or `codex` |
| `geminiApiKey` | Gemini API key (required when `aiProvider=gemini`) |
| `geminiModel` | Gemini model for summary/agent |
| `geminiFlashModel` | Flash model for cheaper/faster calls |
| `codexModel` | Codex model for summary/agent |
| `codexTranscriptionModel` | OpenAI transcription model used with Codex OAuth |
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

Env-var fallbacks (read-only when the config key is empty): `GEMINI_API_KEY`, `LISTENER_AI_PROVIDER`, `CODEX_OAUTH_ACCESS_TOKEN`, `CODEX_OAUTH_REFRESH_TOKEN`, `CODEX_OAUTH_EXPIRES`, `OPENAI_CODEX_ACCESS_TOKEN`, `OPENAI_CODEX_REFRESH_TOKEN`, `OPENAI_CODEX_EXPIRES`, `NOTION_API_KEY`, `NOTION_DATABASE_ID`.

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

### Renderer (`renderer/`, separate from `src/`)
- TypeScript + plain DOM, no framework — entry at `renderer/index.html` → `renderer/main.ts`
- Bundled by Vite (`vite.config.ts`) into `dist/renderer/`, picked up by electron-builder's `dist/**/*` glob
- Type-checked separately via `tsconfig.renderer.json` (`pnpm run build:check-renderer`)
- Modals are native `<dialog>` (not `<div class="modal">` toggled via `style.display`). Open with `showModal()`, close with `close()`, guard re-entry with `.open`. Style the dim/blur overlay on `::backdrop`, not the dialog element itself. ESC behavior is the gotcha: `<dialog>` emits `cancel` on ESC, and the default action just closes the dialog — bypassing any cleanup your buttons run. Always attach a `cancel` listener that `preventDefault()`s and reuses the cancel-button path so in-flight promises, OAuth login state, and event handlers all unwind. Two pitfalls when migrating:
  1. **ESC during async setup.** If the dialog opens then `await`s a fetch before binding button handlers, ESC fires during the await, default-closes the dialog, and the handlers attached after the await leak across reopens. Check `dialog.open` after the await and bail early.
  2. **ESC racing a success state.** If completion runs `setTimeout(() => settle({ success: true }), 1000)`, ESC inside that 1s window settles the promise as `cancelled` for a request that actually succeeded. Remove the `cancel` listener before starting the success timer.

### Top-level services (`src/*.ts`)
- `simpleAudioRecorder.ts` — thin session state + final file writer. Receives the encoded Opus/WebM blob from the renderer after `MediaRecorder` finalizes and writes it to the recordings directory. No ffmpeg spawn, no OS-specific device detection — all capture happens in the renderer.
- `audioFormats.ts` — shared MIME/extension mapping (`mimeTypeForExtension`, `extensionForMimeType`, `SUPPORTED_AUDIO_EXTENSIONS`) used across main, CLI, Gemini upload, and file import paths.
- `geminiService.ts` — provider-aware audio transcription, summarization, and segmentation
- `codexOAuth.ts` — Codex OAuth sign-in and token refresh wrapper
- `openaiCodexClient.ts` — OpenAI transcription and Codex Responses client helpers
- `notionService.ts` — Notion client, block splitting, page assembly
- `configService.ts` — `config.json` read/write, env-var fallback, masking
- `outputService.ts` — transcription folder layout and frontmatter serialization
- `searchService.ts` — in-memory field-weighted search
- `agentService.ts` — tool-using AI agent with confirmation flow
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
- Run: `pnpm test` (builds with tsc, then executes compiled `.test.js` with `node --test`)
- Test files live next to source: `src/**/*.test.ts`
- Existing: `agentService`, `searchService`, `meetingDetectorService`, `simpleAudioRecorder`, `outputService`, `services/audioConcatService`, `cli` (adb-style integration)
- Shared helpers in `src/test-helpers.ts` (temp dirs, ffmpeg detection, synthetic audio fixtures)
- Test escape hatches (read-only at process start, never set in production):
  - `LISTENER_DATA_PATH` — overrides `getDataPath()` so tests run against a temp directory
  - `LISTENER_TEST_MODE` — `GeminiService.transcribeAudio` returns a canned fixture instead of calling the API

#### Patterns proven in this codebase

- **Test against real external tools when behavior depends on them.** Mocking ffmpeg would have hidden the concat demuxer's silent-corruption bug — exit 0 + 28616s output for 1s+1s mismatched-codec inputs. For deterministic, cheap-to-invoke tools (ffmpeg, ffprobe), shell out instead of mocking.
- **Test the assumption, not just the code.** When the implementation depends on "tool X errors on bad input", verify it. The original concat fallback assumed `-c copy` would throw on mismatched codecs; it doesn't.
- **Generate synthetic fixtures with the tool itself.** `ffmpeg -f lavfi -i sine=frequency=440:duration=1` produces a 1-second webm in milliseconds — see `makeOpusWebm` in `test-helpers.ts`. No fixture binaries committed.
- **No real Gemini calls in tests.** Add a `LISTENER_TEST_MODE` env-var stub before writing CLI/integration tests that exercise `GeminiService`.

#### Conventions

- Per-test temp dirs via `makeTempDir(suffix)` from `test-helpers.ts` (wraps `fs.mkdtempSync` under `os.tmpdir()`). Pair with `rmDir(...)` in `after()`. Never write to the real `getDataPath()`.
- For `describe({ skip })` based on external-tool availability, detect synchronously at module load (`findFfmpegSync()`); `before()` runs too late because `describe` evaluates options at file-load time.
- Skip gracefully when external tools are missing: `describe('...', { skip: !ffmpegPath ? 'ffmpeg not installed' : undefined }, ...)`. Tests should pass on a machine without ffmpeg, run for real where it's installed.

#### Test pyramid for new features

1. **Service-layer unit tests** with `node --test` — primary; covers logic and external-tool assumptions
2. **CLI as adb-style integration test** — see `cli.test.ts`. Drive the compiled CLI as a subprocess with `LISTENER_DATA_PATH` (sandboxed temp) + `LISTENER_TEST_MODE` (Gemini stub). Catches what unit tests can't: argument parsing, IPC/handler wiring, full pipeline flow (resolve refs → readTranscription → concat → transcribe → save). Free, offline, deterministic.
3. **Interactive verification** — see below. For UX/visual changes or paid-API happy paths, where automation is heavy.
4. **Playwright Electron** — heaviest; reserve for GUI-only behaviors that can't be reached via CLI.

#### Interactive verification (between unit tests and Playwright)

For UX changes (button visibility, dialog UX, list refresh) or external paid APIs (Gemini), use the live-monitor pattern instead of full Playwright:

1. Launch worktree build in the background (`pnpm start` via `run_in_background`).
2. Tail stdout — main-process `console.log` lands here (transcription progress, ffmpeg invocations, errors).
3. Snapshot baseline: file counts in `recordings/` and `transcriptions/` before the user acts.
4. User drives the GUI; the model reports each observable: file counts, new folder names, log lines, summary.md frontmatter.
5. Verify the result by reading produced files, not by clicking.

This pattern caught two issues during issue #95 verification: a hard-to-see Merge button (CSS override) and an empty `mergedFrom` edge case dependent on input metadata. Service-layer tests would have missed both.

## Startup, Config, and OAuth Gotchas

- **Electron `app.setPath()` ordering.** `main.ts` calls `app.setPath('userData', getDataPath())` near the top. Any module-level singleton instantiated by an `import` earlier in the file (or transitively) that calls `app.getPath('userData')` in its constructor resolves the path BEFORE the override is applied, producing a split-brain where one subsystem writes to `Listener.AI/...` while the rest write to `listener-ai/...`. For any service that needs `userData` at construction time, defer with a lazy getter that resolves on first method call.
- **Codex OAuth credential source distinction.** `ConfigService.getCodexOAuth()` returns either stored (config.json) or env-supplied (`CODEX_OAUTH_*` / `OPENAI_CODEX_*`) credentials. Anywhere a refresh-callback persists rotated tokens to disk, gate it on `hasStoredCodexOAuth()` first -- if the credentials came from env vars, persisting them silently leaks ephemeral env tokens into the on-disk store.
- **Concurrent `config.json` writes.** Electron app and CLI both instantiate `ConfigService` against the same `config.json` and can refresh OAuth tokens in parallel. `saveConfig()` re-reads disk and applies only this process's `dirtyKeys` so writers don't clobber each other's unrelated keys. Setters that mutate config must go through `setKey()`, never `this.config.X = ...` directly, or the change won't be marked dirty and gets lost on the next save.

## AI Provider Stack

- **pi-ai (`@earendil-works/pi-ai`) is the chat/agent backbone.** Both providers (Gemini and Codex) go through pi-ai's unified `getModel` + `complete` API. No more hand-rolled SSE clients, no more provider branching inside `geminiService.ts` / `agentService.ts` -- pi-ai owns transport, streaming, tool-call formatting, and (for Codex) the internal `chatgpt.com/backend-api/codex/responses` endpoint. Tool schemas use TypeBox (`Type.Object({...})`); pi-ai validates them at the provider boundary.
- **OAuth is also pi-ai's job.** `src/codexOAuth.ts` is a thin facade over `@earendil-works/pi-ai/oauth` -- PKCE, loopback bind, state verification, and refresh-token rotation all live upstream. Do NOT reimplement these primitives in-house.
- **The wrapper at `src/piAiClient.ts` exists only to bridge ESM-only pi-ai into our CJS build.** It uses `new Function('return import(...)')` to bypass tsc's CJS-emit rewriting of `import()`. Don't reach around it with a static `import` -- that'll compile to `require()` and crash at runtime with ERR_REQUIRE_ESM. Same pattern in `src/codexOAuth.ts` for the OAuth subpath.
- **Transcription stays bespoke.** pi-ai is chat/tool-call-only; it has no audio surface. Codex transcription goes through `src/codexTranscription.ts` (minimal multipart POST to `/v1/audio/transcriptions` with an OAuth bearer). Gemini transcription stays on `@google/genai`'s files API (kept as a direct dep so 20MB+ uploads work). The provider branch left in `geminiService.ts` is narrower now: audio routing only.
- **Why this direction.** Hand-rolling against undocumented endpoints (ChatGPT Codex Responses, OAuth flow) is a moving target. Concentrating the protocol layer in pi-ai means upstream contract changes hit one pinnable dep; we audit/upgrade it as a unit instead of reverse-engineering each break ourselves. The `chatgpt.com/backend-api/codex/responses` endpoint is still OpenAI-internal -- when it breaks, file against pi-ai/upstream and surface a graceful renderer error suggesting Gemini fallback.
- **Upgrade checklist for `@earendil-works/pi-ai`.** Before bumping the version: (1) OAuth loopback bind stays on 127.0.0.1, (2) PKCE + state are enforced on the callback, (3) the API surface (`getModel`, `complete`, `Type`, `loginOpenAICodex`, `getOAuthApiKey`) is unchanged or the wrappers in `piAiClient.ts` / `codexOAuth.ts` are updated to match, (4) refresh-token rotation behavior is documented in the changelog (we cache the rotated creds via `onCredentialsChanged`).
- **Cancelling an in-flight Codex sign-in.** pi-ai's `loginOpenAICodex` doesn't take an AbortSignal; cancellation goes through the `onManualCodeInput` callback's rejection. When that promise rejects, pi-ai calls `server.cancelWait()` (so `waitForCode()` resolves null), records the error, and re-throws from the finally block, which closes the loopback server. `src/codexOAuth.ts` translates AbortSignal into that surface -- don't bypass it. The loopback is bound to fixed port 1455 with no fallback, and `server.close()` releases the socket on the next libuv tick but isn't awaited by pi-ai. `src/main.ts` keeps the pending-login slot occupied for an extra ~250ms cushion (`PORT_RELEASE_CUSHION_MS`) so a re-bind from the next attempt doesn't race the kernel. Treat the cushion as heuristic, not a guarantee.
- **Testing via faux provider.** `pi.registerFauxProvider({ api: 'google-generative-ai', provider: 'google' })` overwrites the live API registry entry so `complete()` dispatches to scripted responses. `agentService.piai.test.ts` uses this to drive the full tool-call loop offline. Use `registration.unregister()` in `afterEach` to avoid leaking state between tests.

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
- `THIRD_PARTY_NOTICES.md` is shipped in npm and Electron artifacts for direct third-party notices.
- Electron-only runtime deps (`electron-updater`, `@notionhq/client`) live in `optionalDependencies` — honest semantics for a package serving both Electron and CLI users. `build.files` includes `node_modules/**/*`, so they are still bundled in Electron builds.
- `package.json.files` whitelists the exact compiled JS shipped to npm plus `THIRD_PARTY_NOTICES.md`: `dist/cli.js`, `aiProvider.js`, `codexOAuth.js`, `dataPath.js`, `configService.js`, `geminiService.js`, `openaiCodexClient.js`, `outputService.js`, `searchService.js`, `agentService.js`, `audioFormats.js`, `services/ffmpegManager.js`, `services/audioConcatService.js`. When adding a new module imported by any of these, append it to the whitelist or `npm install -g listener-ai` will fail with `Cannot find module`.

## Future Enhancements (Optional)
- Cloud sync of transcriptions, settings, and agent chat history across devices
- Email delivery of summaries / weekly digests
- Live transcription during recording
- Speaker diarization improvements
- Export to PDF
- Full multi-language support beyond Korean
- Bundled ffmpeg for all platforms (subject to licensing)
