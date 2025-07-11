const fs = require('fs');
const path = require('path');

// Create a simple text-based icon using SVG

const svg = `<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <!-- Background with rounded corners - Using the specific blue color -->
  <rect width="1024" height="1024" rx="150" fill="#2563EB"/>
  
  <!-- L.AI Text - Properly centered with fancy font -->
  <text x="512" y="512" font-family="Futura, Helvetica Neue, sans-serif" font-size="320" font-weight="800" text-anchor="middle" dominant-baseline="middle" fill="white" letter-spacing="20">L.AI</text>
</svg>`;

// Save SVG
fs.writeFileSync(path.join(__dirname, 'assets', 'icon.svg'), svg);

console.log('SVG icon created at assets/icon.svg');
console.log('');
console.log('Converting to PNG using rsvg-convert...');

const { execSync } = require('child_process');

try {
  // Try to use rsvg-convert if available
  execSync('which rsvg-convert', { stdio: 'ignore' });
  execSync('rsvg-convert -w 1024 -h 1024 assets/icon.svg -o assets/icon.png');
  console.log('✓ PNG icon created successfully!');
} catch (e) {
  console.log('rsvg-convert not found. Trying alternative methods...');
  
  try {
    // Try using sips (macOS built-in)
    execSync('sips -s format png assets/icon.svg --out assets/icon.png', { stdio: 'ignore' });
    console.log('✓ PNG icon created using sips!');
  } catch (e2) {
    console.log('');
    console.log('Please convert manually:');
    console.log('1. Open assets/icon.svg in a browser');
    console.log('2. Take a screenshot or use an online SVG to PNG converter');
    console.log('3. Save as assets/icon.png');
  }
}