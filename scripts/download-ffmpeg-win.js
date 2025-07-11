const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const FFMPEG_WIN_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
const DOWNLOAD_DIR = path.join(__dirname, '..', 'ffmpeg-win');

async function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, (response) => {
      response.pipe(file);
      file.on('finish', () => {
        file.close(resolve);
      });
    }).on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

async function downloadFFmpegWin() {
  console.log('Downloading FFmpeg for Windows...');
  
  // Create download directory
  if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  }
  
  const zipPath = path.join(DOWNLOAD_DIR, 'ffmpeg-win.zip');
  
  try {
    // Download the zip file
    await downloadFile(FFMPEG_WIN_URL, zipPath);
    console.log('Download complete. Extracting...');
    
    // Extract using unzip command
    execSync(`unzip -o "${zipPath}" -d "${DOWNLOAD_DIR}"`, { stdio: 'inherit' });
    
    // Find the extracted folder
    const dirs = fs.readdirSync(DOWNLOAD_DIR).filter(f => 
      f.startsWith('ffmpeg-') && fs.statSync(path.join(DOWNLOAD_DIR, f)).isDirectory()
    );
    
    if (dirs.length > 0) {
      const ffmpegDir = path.join(DOWNLOAD_DIR, dirs[0]);
      const ffmpegExe = path.join(ffmpegDir, 'bin', 'ffmpeg.exe');
      
      if (fs.existsSync(ffmpegExe)) {
        // Copy to expected location
        const targetDir = path.join(__dirname, '..', 'ffmpeg-binaries', 'win32');
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }
        
        fs.copyFileSync(ffmpegExe, path.join(targetDir, 'ffmpeg.exe'));
        console.log('FFmpeg for Windows downloaded successfully!');
        
        // Clean up
        fs.unlinkSync(zipPath);
        execSync(`rm -rf "${ffmpegDir}"`);
      }
    }
  } catch (error) {
    console.error('Error downloading FFmpeg:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  downloadFFmpegWin();
}