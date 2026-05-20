#!/usr/bin/env node
// Generates dist/buildConstants.js from build-time env vars. Run as part of the
// build pipeline (see package.json `build` and `prepublishOnly`). The file is
// gitignored and must NOT be committed; it embeds OAuth client credentials into
// the shipped artifact (sanctioned for Desktop OAuth clients per
// https://developers.google.com/identity/protocols/oauth2/native-app).
//
// When env vars are missing, the script still writes the file with empty values
// so consumers (Electron build, npm publish, tests) get a stable file shape and
// the runtime falls through to the actionable env-var error.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const clientId = (process.env.LISTENER_GOOGLE_OAUTH_CLIENT_ID || '').trim();
const clientSecret = (process.env.LISTENER_GOOGLE_OAUTH_CLIENT_SECRET || '').trim();

const distDir = path.join(__dirname, '..', 'dist');
fs.mkdirSync(distDir, { recursive: true });

const outPath = path.join(distDir, 'buildConstants.js');
const content = `// AUTO-GENERATED at build time. Do not edit. Do not commit.
'use strict';
module.exports = {
  googleOAuthClientId: ${JSON.stringify(clientId)},
  googleOAuthClientSecret: ${JSON.stringify(clientSecret)},
};
`;

fs.writeFileSync(outPath, content, { mode: 0o644 });

if (!clientId || !clientSecret) {
  console.warn(
    '[build-constants] LISTENER_GOOGLE_OAUTH_CLIENT_ID/SECRET not set; wrote empty placeholders. Google Drive sign-in will fail in this build until env vars are provided.',
  );
} else {
  console.log('[build-constants] dist/buildConstants.js generated.');
}
