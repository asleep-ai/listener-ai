const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { version } = require('../package.json');

// Generate update metadata files for electron-updater when building with --publish never

function getFileHash(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const hashSum = crypto.createHash('sha512');
  hashSum.update(fileBuffer);
  return hashSum.digest('base64');
}

function getFileSize(filePath) {
  const stats = fs.statSync(filePath);
  return stats.size;
}

function generateMacMetadata() {
  const releaseDir = path.join(__dirname, '..', 'release');
  
  // Find DMG files
  const files = fs.readdirSync(releaseDir);
  const dmgFiles = files.filter(f => f.endsWith('.dmg'));
  
  dmgFiles.forEach(dmgFile => {
    const filePath = path.join(releaseDir, dmgFile);
    
    const metadata = {
      version: version,
      files: [
        {
          url: dmgFile,
          sha512: getFileHash(filePath),
          size: getFileSize(filePath)
        }
      ],
      path: dmgFile,
      sha512: getFileHash(filePath),
      releaseDate: new Date().toISOString()
    };
    
    // Write latest-mac.yml
    const yamlContent = `version: ${metadata.version}
files:
  - url: ${metadata.files[0].url}
    sha512: ${metadata.files[0].sha512}
    size: ${metadata.files[0].size}
path: ${metadata.path}
sha512: ${metadata.sha512}
releaseDate: '${metadata.releaseDate}'
`;
    
    const yamlPath = path.join(releaseDir, `latest-mac.yml`);
    fs.writeFileSync(yamlPath, yamlContent);
    console.log(`Generated ${yamlPath} for ${dmgFile}`);
  });
}

function generateWindowsMetadata() {
  const releaseDir = path.join(__dirname, '..', 'release');
  
  // Find exe files
  const files = fs.readdirSync(releaseDir);
  const exeFiles = files.filter(f => f.endsWith('.exe'));
  
  exeFiles.forEach(exeFile => {
    const filePath = path.join(releaseDir, exeFile);
    
    const metadata = {
      version: version,
      files: [
        {
          url: exeFile,
          sha512: getFileHash(filePath),
          size: getFileSize(filePath)
        }
      ],
      path: exeFile,
      sha512: getFileHash(filePath),
      releaseDate: new Date().toISOString()
    };
    
    // Write latest.yml for Windows
    const yamlContent = `version: ${metadata.version}
files:
  - url: ${metadata.files[0].url}
    sha512: ${metadata.files[0].sha512}
    size: ${metadata.files[0].size}
path: ${metadata.path}
sha512: ${metadata.sha512}
releaseDate: '${metadata.releaseDate}'
`;
    
    const yamlPath = path.join(releaseDir, 'latest.yml');
    fs.writeFileSync(yamlPath, yamlContent);
    console.log(`Generated ${yamlPath} for ${exeFile}`);
  });
}

const platform = process.argv[2];
if (!platform || !['mac', 'win'].includes(platform)) {
  console.log('Usage: node generate-update-metadata.js [mac|win]');
  process.exit(1);
}

const releaseDir = path.join(__dirname, '..', 'release');
if (!fs.existsSync(releaseDir)) {
  console.error('Release directory not found. Build the app first.');
  process.exit(1);
}

platform === 'mac' ? generateMacMetadata() : generateWindowsMetadata();