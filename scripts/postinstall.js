const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Only run in production builds
if (process.env.NODE_ENV === 'production' || process.argv.includes('--production')) {
  console.log('Setting executable permissions for FFmpeg binaries...');
  
  const platform = process.platform;
  const arch = process.arch;
  
  if (platform === 'darwin' || platform === 'linux') {
    try {
      // Find FFmpeg and ffprobe binaries
      const ffmpegPath = path.join(__dirname, '..', 'node_modules', 'ffmpeg-static', 'ffmpeg');
      const ffprobePath = path.join(__dirname, '..', 'node_modules', 'ffprobe-static', 'bin', platform, arch, 'ffprobe');
      
      // Make them executable
      if (fs.existsSync(ffmpegPath)) {
        fs.chmodSync(ffmpegPath, 0o755);
        console.log('Made ffmpeg executable:', ffmpegPath);
      }
      
      if (fs.existsSync(ffprobePath)) {
        fs.chmodSync(ffprobePath, 0o755);
        console.log('Made ffprobe executable:', ffprobePath);
      }
    } catch (error) {
      console.error('Error setting permissions:', error);
    }
  }
}