# Listener.AI

A lightweight desktop application for recording and transcribing meetings with AI-powered notes.

## Features

- **Easy Recording**: One-click audio recording using your system microphone
- **AI Transcription**: Automatic transcription with speaker identification using Google Gemini AI
- **Smart Summaries**: AI-generated meeting summaries, key points, and action items in Korean
- **Auto Mode**: Automatically transcribe and upload to Notion after recording stops
- **Auto Title Generation**: Automatically generates meeting titles from content when not provided
- **Notion Integration**: Seamlessly save your meeting notes to Notion with emoji support
- **Progress Tracking**: Real-time progress updates during transcription
- **Korean Language Support**: Full support for Korean file names and content
- **Simple Interface**: Clean, minimal UI focused on productivity

## Installation

```bash
# Clone the repository
git clone https://github.com/asleep-ai/listener-ai.git
cd listener-ai

# Install dependencies
pnpm install

# Run the application
pnpm start
```

## Prerequisites

- Google Gemini API key
- Notion API key and database ID
- Node.js 22.x or higher (for development)
- pnpm package manager (for development)

**Note**: FFmpeg will be automatically downloaded on first use, or you can install it system-wide.

## Configuration

### API Keys Setup

The application stores API keys securely in your system's application data folder:
- **macOS**: `~/Library/Application Support/listener-ai/config.json`
- **Windows**: `%APPDATA%/listener-ai/config.json`
- **Linux**: `~/.config/listener-ai/config.json`

#### Option 1: Configure through the app (Recommended)
1. Start the app with `npm start`
2. You'll be prompted to enter your API keys on first launch
3. Enter your keys in the configuration modal

#### Option 2: Use environment variables
Copy `.env.example` to `.env` and fill in your keys:

```bash
cp .env.example .env
```

Then edit `.env`:
```env
GEMINI_API_KEY=your_gemini_api_key
NOTION_API_KEY=your_notion_api_key
NOTION_DATABASE_ID=your_notion_database_id
```

### Getting API Keys

#### Google Gemini API
1. Visit [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Click "Create API Key"
3. Copy the generated key

#### Notion Integration
1. Go to [Notion Integrations](https://www.notion.so/my-integrations)
2. Create a new integration named "Listener.AI"
3. Grant permissions: Read, Insert, Update content
4. Copy the "Internal Integration Token"
5. Share your database with the integration:
   - Open your Notion database
   - Click "..." → "Connections" → Add your integration
6. Get database ID from URL: `notion.so/workspace/DATABASE_ID`

### FFmpeg Setup

The app will automatically download FFmpeg on first use. Alternatively, you can install it system-wide:

#### macOS
```bash
brew install ffmpeg
```

#### Windows
1. The app will prompt to download FFmpeg automatically on first use
2. Or download manually from [ffmpeg.org](https://ffmpeg.org/download.html)
3. Extract to `C:\ffmpeg` and add to PATH

#### Linux
```bash
sudo apt-get install ffmpeg  # Debian/Ubuntu
sudo dnf install ffmpeg       # Fedora
sudo pacman -S ffmpeg         # Arch
```

## Usage

1. Launch the application
2. (Optional) Enter a meeting title, or leave blank for auto-generated title
3. Click "Start Recording" to begin capturing audio
4. Click "Stop Recording" when finished
5. Choose your workflow:
   - **Manual Mode**: Click "Transcribe" button on any recording
   - **Auto Mode**: Enable the toggle for automatic transcription and Notion upload

The app will automatically:
- Transcribe the audio with speaker identification
- Generate a Korean title if none was provided
- Create meeting summary, key points, and action items in Korean
- Upload to your Notion workspace with appropriate emoji

## Development

```bash
# Install dependencies
pnpm install

# Run in development mode
pnpm run dev

# Build TypeScript
pnpm run build

# Build distributables
pnpm run dist:mac      # macOS
pnpm run dist:win      # Windows
pnpm run dist:all      # All platforms
```

## Building from Source

### macOS
```bash
pnpm run dist:mac-x64    # Intel Macs
pnpm run dist:mac-arm64  # Apple Silicon
```

### Windows
```bash
pnpm run dist:win
```

### Linux
```bash
pnpm run dist  # Builds AppImage
```

## Project Structure

```
listener-ai/
├── src/                   # TypeScript source files
│   ├── main.ts           # Main process entry
│   ├── preload.ts        # Preload script
│   ├── services/         # Service modules
│   └── ...
├── dist/                  # Compiled JavaScript
├── release/              # Built distributables
├── assets/               # Icons and resources
├── index.html            # Main UI
├── renderer.js           # Renderer process
└── styles.css            # Application styles
```

## License

MIT License - see LICENSE file for details

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.