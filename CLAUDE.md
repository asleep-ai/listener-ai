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
- Node.js: v22.x

## Current Implementation Status
✅ 1. Audio recording with ffmpeg (auto-download support)
✅ 2. Clean UI with recording controls and title management
✅ 3. Gemini API integration for transcription with segmentation
✅ 4. Notion API integration for structured note storage
✅ 5. Error handling and progress tracking
✅ 6. System tray integration with global shortcuts
✅ 7. File drag-and-drop support for external audio files
✅ 8. Metadata persistence for recordings

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

## Future Enhancements (Optional)
- Live transcription during recording
- Advanced keyword extraction and tagging
- Full multi-language support (currently Korean-focused)
- Export to other formats (PDF, Markdown)
- Cloud backup of audio files
- Bundled FFmpeg binaries for all platforms
- Speaker diarization improvements
- Meeting analytics and insights
