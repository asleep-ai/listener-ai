# Listener.AI - LLM Context

## Project Overview
Listener.AI is a lightweight desktop application for recording audio and transcribing meetings using local microphones and AI services.

## Core Features

### 1. Audio Recording
- Use system microphone via ffmpeg for high-quality audio capture
- Start/stop recording functionality
- Local audio file storage with proper file management

### 2. User Interface
- Minimal desktop UI with:
  - Start/Stop recording button
  - Text input field for meeting title (editable during/after recording)
  - Status indicator showing recording state
  - List of recent recordings with titles

### 3. AI Transcription & Processing
- Integration with Google Gemini 2.5 Flash API
- Audio file upload to Gemini API endpoint: https://ai.google.dev/gemini-api/docs/audio
- Generate:
  - Full meeting transcript
  - Meeting notes/summary
  - Key points and action items

### 4. Notion Integration
- Automatically upload transcription results to Notion
- Create structured meeting notes in Notion database
- Include:
  - Meeting title
  - Date/time
  - Full transcript
  - AI-generated summary
  - Action items

## Technical Stack
- Desktop framework: Electron/Tauri (to be decided)
- Audio recording: ffmpeg
- AI Service: Google Gemini 2.5 Flash
- Integration: Notion API
- Language: TypeScript/JavaScript

## Development Priorities
1. Basic recording functionality with ffmpeg
2. Simple UI for start/stop and title management
3. Gemini API integration for transcription
4. Notion API integration for note storage
5. Polish UI and error handling

## Future Enhancements (Optional)
- Live transcription during recording
- Keyword extraction and tagging
- Multi-language support
- Speaker diarization
- Export to other formats (PDF, Markdown)
- Cloud backup of audio files