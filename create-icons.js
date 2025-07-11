const fs = require('fs');
const path = require('path');

// Create a simple SVG icon
const svg = `<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <rect width="1024" height="1024" fill="#3498db"/>
  <circle cx="512" cy="400" r="200" fill="white"/>
  <rect x="462" y="400" width="100" height="300" fill="white"/>
  <circle cx="512" cy="700" r="50" fill="white"/>
  <text x="512" y="850" font-family="Arial, sans-serif" font-size="120" font-weight="bold" text-anchor="middle" fill="white">L.AI</text>
</svg>`;

// Save SVG
fs.writeFileSync(path.join(__dirname, 'assets', 'icon.svg'), svg);

console.log('Icon placeholder created. For production, you should:');
console.log('1. Create a 1024x1024 PNG icon and save it as assets/icon.png');
console.log('2. Convert it to ICNS format for macOS: iconutil -c icns assets/icon.iconset');
console.log('3. Convert it to ICO format for Windows using an online converter');
console.log('');
console.log('Or use electron-icon-builder:');
console.log('npm install -g electron-icon-builder');
console.log('electron-icon-builder --input=assets/icon.png --output=assets/');