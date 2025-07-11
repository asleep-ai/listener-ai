# Building Listener.AI

## Prerequisites

1. Install Node.js (v18 or higher)
2. Install dependencies:
   ```bash
   npm install
   ```

## Building for Distribution

### macOS (DMG)

To build a DMG file for macOS:

```bash
npm run dist:mac
```

This will create:
- `release/Listener.AI-1.0.0-arm64.dmg` (for Apple Silicon Macs)
- `release/Listener.AI-1.0.0.dmg` (for Intel Macs)

### Windows (EXE)

To build an EXE installer for Windows:

```bash
npm run dist:win
```

This will create:
- `release/Listener.AI Setup 1.0.0.exe`

### Build for All Platforms

To build for both macOS and Windows:

```bash
npm run dist:all
```

## Important Notes

1. **FFmpeg Dependency**: Users will need FFmpeg installed on their system:
   - macOS: `brew install ffmpeg`
   - Windows: Download from https://ffmpeg.org/download.html

2. **Code Signing**: 
   - For macOS distribution, you'll need an Apple Developer certificate
   - For Windows, you'll need a code signing certificate
   - Without signing, users will see security warnings

3. **Icons**: 
   - Replace `assets/icon.png` with your actual app icon (1024x1024 PNG)
   - For better results, create platform-specific icons:
     - macOS: `icon.icns`
     - Windows: `icon.ico`

## Distribution

The built files will be in the `release/` directory:
- DMG files can be distributed directly to macOS users
- EXE files can be distributed directly to Windows users

Users can simply double-click to install the application.