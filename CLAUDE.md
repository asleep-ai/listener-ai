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
- Audio recording: ffmpeg with bundled binaries for macOS
- AI Service: Google Gemini 2.5 Flash
- Integration: Notion API
- Language: TypeScript

## Current Implementation Status
✅ 1. Basic recording functionality with ffmpeg
✅ 2. Simple UI for start/stop and title management
✅ 3. Gemini API integration for transcription
✅ 4. Notion API integration for note storage
✅ 5. Polish UI and error handling

## Additional Implemented Features
- Auto mode for hands-free operation
- Korean language optimization
- Cross-platform builds (macOS x64/arm64, Windows, Linux)
- Secure API key storage
- macOS code signing and notarization support
- Real-time transcription progress tracking
- Fallback mechanisms for FFmpeg detection

## Future Enhancements (Optional)
- Live transcription during recording
- Advanced keyword extraction and tagging
- Full multi-language support (currently Korean-focused)
- Export to other formats (PDF, Markdown)
- Cloud backup of audio files
- Windows FFmpeg bundling