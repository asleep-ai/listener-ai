# FFmpeg Binary Management

## Overview

Listener.AI requires FFmpeg for audio recording functionality. To keep the repository size manageable, FFmpeg binaries are not stored in git but are downloaded during the build process.

## How It Works

### Development
- During development, the app uses the `ffmpeg-static` npm package
- No manual FFmpeg installation required for developers

### Production Builds

#### macOS
- FFmpeg binaries are automatically downloaded during the build process
- The `prebuild:mac` script runs `scripts/download-ffmpeg-all.js` before building
- Downloaded binaries are placed in `ffmpeg-binaries/darwin/{x64,arm64}/`
- The build process bundles these binaries into the app's Resources folder
- Users get a fully self-contained app with no additional installation required

#### Windows
- Currently, Windows users must install FFmpeg separately
- The app includes `WINDOWS_FFMPEG.txt` with installation instructions
- The app will detect and use system-installed FFmpeg from common locations

### Build Commands

- `npm run dist:mac` - Builds for macOS (downloads FFmpeg automatically)
- `npm run dist:win` - Builds for Windows (no FFmpeg bundled)
- `npm run dist:all` - Builds for all platforms

### Directory Structure

```
ffmpeg-binaries/          # Git-ignored, created during build
├── darwin/
│   ├── x64/
│   │   ├── ffmpeg-darwin-x64
│   │   └── ffprobe-darwin-x64
│   └── arm64/
│       ├── ffmpeg-darwin-arm64
│       └── ffprobe-darwin-arm64
```

### GitHub Actions

The release workflow (`release.yml`) automatically handles FFmpeg downloads when building releases.

## Troubleshooting

If FFmpeg binaries are missing during build:
1. Run `node scripts/download-ffmpeg-all.js` manually
2. Check internet connection (downloads from GitHub)
3. Verify the download script has proper permissions

## Future Improvements

- Add Windows FFmpeg bundling support
- Implement fallback download mirrors
- Add checksum verification for downloaded binaries