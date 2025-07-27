# Code Signing Guide

This guide explains how to sign Listener.AI to eliminate security warnings.

## macOS Code Signing

### Prerequisites
1. Apple Developer Account ($99/year)
2. Developer ID Application certificate
3. Developer ID Installer certificate

### Setup

1. **Create certificates** in Apple Developer Portal
2. **Install certificates** in Keychain Access
3. **Create `.env` file** in project root:

```bash
# macOS signing
APPLE_ID=your-apple-id@example.com
APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx  # App-specific password
APPLE_TEAM_ID=XXXXXXXXXX  # Your Team ID
CSC_LINK=path/to/certificate.p12  # Optional: Path to certificate
CSC_KEY_PASSWORD=certificate-password  # Optional: Certificate password
```

4. **Update package.json** (already configured for signing)

5. **Build signed app**:
```bash
pnpm run dist:mac
```

The app will be automatically signed and notarized using the configured notarize.js script.

### Notarization

Notarization is automatically handled during the build process when the required environment variables are set:
- `APPLE_ID`: Your Apple ID email
- `APPLE_APP_SPECIFIC_PASSWORD`: App-specific password (not your Apple ID password)
- `APPLE_TEAM_ID`: Your Apple Developer Team ID

The notarization process:
1. Uploads the signed app to Apple's notarization service
2. Waits for Apple to scan and approve the app
3. Staples the notarization ticket to the app
4. Creates a DMG that can be opened without security warnings

Note: Notarization requires a valid Apple Developer account and can take 5-15 minutes.

## Windows Code Signing

### Prerequisites
1. Code signing certificate (from DigiCert, Sectigo, etc.)
2. Windows SDK (for signtool)

### Setup

1. **Add to `.env`**:
```bash
# Windows signing
WIN_CSC_LINK=path/to/certificate.pfx
WIN_CSC_KEY_PASSWORD=certificate-password
```

2. **Build signed app**:
```bash
pnpm run dist:win
```

## Self-Signing (Free Alternative)

### macOS Self-Signing
```bash
# Create a self-signed certificate
# 1. Open Keychain Access
# 2. Keychain Access > Certificate Assistant > Create a Certificate
# 3. Name: "Developer ID Application: Your Name"
# 4. Certificate Type: Code Signing
# 5. Let me override defaults: Yes
# 6. Continue through the wizard

# Sign the app manually
codesign --deep --force --verify --verbose --sign "Developer ID Application: Your Name" "release/mac/Listener.AI.app"
```

Note: Self-signed apps still show warnings but can be opened more easily.

## GitHub Actions (Automated Signing)

Add secrets to your GitHub repository:

### For macOS (Signing & Notarization)

- `SIGNING_CERTIFICATE` - Base64 encoded .p12 certificate
- `CERT_PASSWORD` - Certificate password
- `APPLE_ID` - Your Apple ID email
- `APPLE_ID_PASSWORD` - App-specific password from appleid.apple.com
- `APPLE_TEAM_ID` - Your 10-character Team ID from Apple Developer account

### For Windows (if needed)

- `WIN_CSC_LINK` - Base64 encoded .pfx certificate
- `WIN_CSC_KEY_PASSWORD` - Windows certificate password

The GitHub Actions workflow will automatically sign and notarize releases.