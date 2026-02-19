# Listener.AI - LLM Context

## Project Overview
Listener.AI is a lightweight desktop application for recording audio and transcribing meetings using local microphones and AI services.

## Core Features

### 1. Audio Recording
- Use system microphone via ffmpeg for high-quality audio capture (MP3 format)
- Start/stop recording functionality with real-time duration display
- Local audio file storage with proper file management
- Platform-specific audio device detection:
  - macOS: AVFoundation integration
  - Windows: DirectShow with Korean language support
  - Linux: ALSA support
- Audio quality optimizations (volume boost, limiter)

### 2. User Interface
- Minimal Electron-based desktop UI with:
  - Start/Stop recording button
  - Text input field for meeting title (editable during/after recording)
  - Status indicator showing recording state
  - List of recent recordings with titles
  - Auto mode toggle for automatic transcription and upload
  - Progress tracking during transcription
  - Configuration dialog for API key management

### 3. AI Transcription & Processing
- Integration with Google Gemini 2.5 Flash API
- Audio file upload to Gemini API endpoint
- Automatic segmentation for recordings longer than 5 minutes
- Korean language focus with support for:
  - Full meeting transcript with speaker identification
  - Korean meeting summary
  - Key points extraction
  - Action items identification
  - Auto-generated meeting titles from content

### 4. Notion Integration
- Automatically upload transcription results to Notion
- Create structured meeting notes in Notion database
- Handle Notion's block size limits by splitting long transcripts
- Include:
  - Meeting title (with "by L.AI" suffix)
  - Date/time
  - Korean summary
  - Key points
  - Action items
  - Full transcript
  - Emoji icons for visual organization

## Technical Stack
- Desktop framework: Electron (v37.2.0)
- Audio recording: ffmpeg (auto-downloaded on first use)
- AI Service: Google Gemini 2.5 Flash
- Integration: Notion API
- Language: TypeScript
- Package Manager: pnpm
- Node.js: v24.x

## Current Implementation Status
✅ 1. Audio recording with ffmpeg (auto-download support)
✅ 2. Clean UI with recording controls and title management
✅ 3. Gemini API integration for transcription with segmentation
✅ 4. Notion API integration for structured note storage
✅ 5. Error handling and progress tracking
✅ 6. System tray integration with global shortcuts
✅ 7. File drag-and-drop support for external audio files
✅ 8. Metadata persistence for recordings
✅ 9. CLI for headless transcription and config management

## CLI Usage

```
listener <file> [--output <dir>]    Transcribe and summarize an audio file
listener config list                Show all config values (API keys masked)
listener config get <key>           Get a specific value
listener config set <key> <value>   Set a value
listener config path                Print config file path
```

Config keys: `geminiApiKey`, `notionApiKey`, `notionDatabaseId`, `autoMode`, `globalShortcut`

CLI and GUI share the same config file (`config.json` in the app data directory).

## Additional Implemented Features
- Auto mode for hands-free operation
- Korean language optimization
- Cross-platform builds (macOS x64/arm64, Windows, Linux)
- Secure API key storage in system config directory
- macOS code signing and notarization support
- Real-time transcription progress tracking
- Automatic FFmpeg download with progress indicator
- System tray/menu bar integration
- Global keyboard shortcuts (configurable)
- Audio file segmentation for long recordings (>5 minutes)
- Automatic title generation from meeting content
- File import via drag-and-drop or file dialog
- Metadata storage for transcription results

## Architecture Overview

### CLI (`src/cli.ts`)
- Headless transcription: `listener <file>`
- Config management: `listener config list|get|set|path`

### Main Process (`src/main.ts`)
- Window management and IPC handlers
- Menu bar/system tray integration
- Global shortcut registration
- File operations coordination

### Services
- `simpleAudioRecorder.ts`: FFmpeg-based audio recording
- `geminiService.ts`: Google Gemini API integration with chunking
- `notionService.ts`: Notion API integration with block splitting
- `configService.ts`: Secure configuration management
- `ffmpegManager.ts`: FFmpeg download and management
- `fileHandlerService.ts`: File import/export operations
- `metadataService.ts`: Recording metadata persistence
- `menuBarManager.ts`: System tray and menu management

### Renderer Process
- `renderer.js`: UI logic and IPC communication
- `index.html`: Main application UI
- `styles.css`: Application styling

### Release & Auto-Update
- macOS x64 and arm64 must be built together in single job (`--mac --x64 --arm64`)
- Reason: electron-builder generates `latest-mac.yml` with both architectures listed
- If built separately, each job overwrites the yml and one architecture gets wrong binary
- electron-updater uses filename patterns (x64/arm64) to serve correct binary to each user
- Auto-update is disabled when `app.isPackaged === false` (dev mode)
- To test auto-update, must use packaged build (not `pnpm start`)
- Browser fallback: when auto-update fails, show dialog with link to GitHub releases
- macOS auto-update requires ZIP files (not DMG) - electron-updater downloads ZIP for in-place updates
- Blockmaps (*.blockmap) enable differential updates - users download only changed blocks
- GitHub workflow must upload both ZIP and blockmap files alongside DMG for auto-update to work

## FFmpeg Licensing
- FFmpeg binaries are downloaded at runtime from `eugeneware/ffmpeg-static` GitHub releases (not bundled)
- The `ffmpeg-static` npm package/repo is **GPL-3.0** licensed
- FFmpeg itself is LGPL 2.1+ for default builds; our use case (MP3 via libmp3lame) stays within LGPL
- Do NOT add `ffmpeg-static` as an npm dependency -- it would impose GPL-3.0 on the project
- For CLI npm distribution: prefer requiring user-installed ffmpeg, or keep the current runtime download approach
- Runtime download (current): legally better than bundling, but still downloads from a GPL-3.0-wrapped repo
- SHA256 checksums in `ffmpegManager.ts` are empty (`// TODO`) -- should be filled for integrity verification

## npm Distribution
- Package name: `listener-ai`
- Only the CLI portion is published to npm (Electron app uses GitHub Releases)
- Electron-only runtime deps (`electron-updater`, `@notionhq/client`) are in `optionalDependencies` -- honest semantics for a package serving both Electron and CLI users. `build.files` includes `node_modules/**/*`, so they're still bundled in Electron builds.

## Future Enhancements (Optional)
- Live transcription during recording
- Advanced keyword extraction and tagging
- Full multi-language support (currently Korean-focused)
- Export to other formats (PDF, Markdown)
- Cloud backup of audio files
- Bundled FFmpeg binaries for all platforms
- Speaker diarization improvements
- Meeting analytics and insights
