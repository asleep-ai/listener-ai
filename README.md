# Listener.AI

AI-powered audio transcription with meeting summaries, key points, and action items.

Available as a **CLI tool** (via npm) and a **desktop app** (via [GitHub Releases](https://github.com/asleep-ai/listener-ai/releases)).

## CLI

### Install

```bash
npm install -g listener-ai
```

Or use directly:

```bash
npx listener-ai <audio-file>
```

### Prerequisites

- **FFmpeg** installed on your system (`brew install ffmpeg` / `apt install ffmpeg`)
- **Google Gemini API key** from [Google AI Studio](https://makersuite.google.com/app/apikey)

### Setup

```bash
listener config set geminiApiKey <your-key>
```

Optional Notion integration:

```bash
listener config set notionApiKey <your-key>
listener config set notionDatabaseId <your-id>
```

### Usage

```bash
listener recording.mp3                # Transcribe to default output dir
listener recording.m4a --output ./    # Transcribe to current directory
listener config list                  # Show all config values
listener config path                  # Print config file path
```

Supported formats: mp3, m4a, wav, ogg, flac, aac, wma, opus, webm

Output is a folder containing `transcript.md` and `summary.md` with speaker identification, Korean summary, key points, and action items.

## Desktop App

Download from [GitHub Releases](https://github.com/asleep-ai/listener-ai/releases):
- **macOS**: Intel (x64) and Apple Silicon (arm64) DMG
- **Windows**: x64 installer

The desktop app includes one-click recording, auto-transcription, Notion upload, and automatic FFmpeg download.

## Configuration

Config is stored in your system application data folder:
- **macOS**: `~/Library/Application Support/Listener.AI/config.json`
- **Windows**: `%APPDATA%/Listener.AI/config.json`
- **Linux**: `~/.config/Listener.AI/config.json`

CLI and desktop app share the same config file.

### Getting API Keys

#### Google Gemini API
1. Visit [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Click "Create API Key"
3. Copy the generated key

#### Notion Integration (optional)
1. Go to [Notion Integrations](https://www.notion.so/my-integrations)
2. Create a new integration named "Listener.AI"
3. Grant permissions: Read, Insert, Update content
4. Copy the "Internal Integration Token"
5. Share your database with the integration
6. Get database ID from URL: `notion.so/workspace/DATABASE_ID`

## Development

```bash
pnpm install
pnpm run dev          # Run Electron app
pnpm run cli          # Run CLI locally
pnpm run dist:mac     # Build macOS
pnpm run dist:win     # Build Windows
```

## License

MIT
