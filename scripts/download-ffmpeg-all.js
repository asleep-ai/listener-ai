const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const zlib = require('zlib');

const FFMPEG_RELEASE = 'b6.0';
const DOWNLOAD_BASE_URL = `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_RELEASE}`;

const downloads = [
  {
    platform: 'darwin',
    arch: 'x64',
    files: [
      { name: 'ffmpeg-darwin-x64.gz', output: 'ffmpeg-darwin-x64' },
      { name: 'ffprobe-darwin-x64.gz', output: 'ffprobe-darwin-x64' }
    ]
  },
  {
    platform: 'darwin',
    arch: 'arm64',
    files: [
      { name: 'ffmpeg-darwin-arm64.gz', output: 'ffmpeg-darwin-arm64' },
      { name: 'ffprobe-darwin-arm64.gz', output: 'ffprobe-darwin-arm64' }
    ]
  }
];

async function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    
    const makeRequest = (requestUrl) => {
      https.get(requestUrl, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          // Handle redirect
          file.close();
          fs.unlinkSync(destPath);
          makeRequest(response.headers.location);
          return;
        }
        
        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download: ${response.statusCode}`));
          return;
        }
        
        response.pipe(file);
        file.on('finish', () => {
          file.close(resolve);
        });
      }).on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    };
    
    makeRequest(url);
  });
}

async function gunzipFile(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const gunzip = zlib.createGunzip();
    const input = fs.createReadStream(inputPath);
    const output = fs.createWriteStream(outputPath);
    
    input.pipe(gunzip).pipe(output);
    
    output.on('finish', () => {
      fs.chmodSync(outputPath, 0o755);
      resolve();
    });
    
    gunzip.on('error', reject);
  });
}

async function downloadFFmpegBinaries() {
  const binDir = path.join(__dirname, '..', 'ffmpeg-binaries');
  
  // Create directory structure
  for (const config of downloads) {
    const platformDir = path.join(binDir, config.platform, config.arch);
    if (!fs.existsSync(platformDir)) {
      fs.mkdirSync(platformDir, { recursive: true });
    }
    
    console.log(`Downloading FFmpeg binaries for ${config.platform}-${config.arch}...`);
    
    for (const file of config.files) {
      const url = `${DOWNLOAD_BASE_URL}/${file.name}`;
      const gzPath = path.join(platformDir, file.name);
      const outputPath = path.join(platformDir, file.output);
      
      try {
        console.log(`  Downloading ${file.name}...`);
        await downloadFile(url, gzPath);
        
        console.log(`  Extracting ${file.output}...`);
        await gunzipFile(gzPath, outputPath);
        
        // Clean up gz file
        fs.unlinkSync(gzPath);
        
        console.log(`  ✓ ${file.output} ready`);
      } catch (error) {
        console.error(`  ✗ Failed to download ${file.name}:`, error.message);
      }
    }
  }
  
  console.log('\nAll downloads complete!');
  console.log('Binary locations:');
  console.log('  Intel Mac: ffmpeg-binaries/darwin/x64/');
  console.log('  Apple Silicon: ffmpeg-binaries/darwin/arm64/');
}

// Run if called directly
if (require.main === module) {
  downloadFFmpegBinaries().catch(console.error);
}