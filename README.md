# Listener.AI

A lightweight desktop application for recording and transcribing meetings with AI-powered notes.

## Features

- **Easy Recording**: One-click audio recording using your system microphone
- **AI Transcription**: Automatic transcription and meeting notes using Google Gemini AI
- **Notion Integration**: Seamlessly save your meeting notes to Notion
- **Simple Interface**: Clean, minimal UI focused on productivity

## Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/listener-ai.git
cd listener-ai

# Install dependencies
npm install

# Run the application
npm start
```

## Prerequisites

- ffmpeg installed on your system
- Google Gemini API key
- Notion API key and database ID

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

### Prerequisites

Ensure ffmpeg is installed:
- macOS: `brew install ffmpeg`
- Windows: Download from [ffmpeg.org](https://ffmpeg.org)
- Linux: `sudo apt-get install ffmpeg`

## Usage

1. Launch the application
2. Click "Start Recording" to begin capturing audio
3. Enter or edit the meeting title
4. Click "Stop Recording" when finished
5. The app will automatically:
   - Transcribe the audio using Gemini AI
   - Generate meeting notes and summary
   - Upload to your Notion workspace

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build
```

## License

MIT License - see LICENSE file for details

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.