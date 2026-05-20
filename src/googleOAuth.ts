import { randomBytes } from 'crypto';
import { type Server, createServer } from 'http';
import { URL } from 'url';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';

// Matches the shape used by codexOAuth.ts so callers can treat both providers
// the same in higher layers (config persistence, masking, env fallback).
type OAuthCredentials = {
  access: string;
  refresh: string;
  expires: number;
};

type OAuthPrompt = {
  message: string;
};

export type GoogleOAuthCredentials = OAuthCredentials & {
  // Captured from the OpenID Connect userinfo endpoint when scope includes
  // `email`. Used by the settings UI to show "Signed in as ...". Optional --
  // sync should still work if the userinfo call failed.
  email?: string;
};

class GoogleLoginCancelledError extends Error {
  constructor() {
    super('Google sign-in cancelled.');
    this.name = 'GoogleLoginCancelledError';
  }
}

// drive.file gives access ONLY to files this app creates. Avoid the broader
// `drive` scope -- it is a restricted scope and triggers Google's heavier
// verification / security assessment process.
// openid+email+profile are pulled in so the settings UI can display the signed-
// in account; treating drive.file as an identity scope would be incorrect.
const SCOPES = ['https://www.googleapis.com/auth/drive.file', 'openid', 'email', 'profile'];

const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

// OAuth client credentials come from env vars so production builds can inject
// them at build time without committing the values to the repo. Register a
// Desktop application OAuth client at
// https://console.cloud.google.com/apis/credentials and set both env vars
// before running login. Desktop clients still require the client_secret on
// token exchange even though it is embedded in the binary -- see
// https://developers.google.com/identity/protocols/oauth2/native-app.
function getClientCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.LISTENER_GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.LISTENER_GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error(
      'Google OAuth client not configured. Set LISTENER_GOOGLE_OAUTH_CLIENT_ID and ' +
        'LISTENER_GOOGLE_OAUTH_CLIENT_SECRET (register a Desktop application OAuth ' +
        'client at https://console.cloud.google.com/apis/credentials).',
    );
  }
  return { clientId, clientSecret };
}

export function hasGoogleOAuthClientConfigured(): boolean {
  try {
    getClientCredentials();
    return true;
  } catch {
    return false;
  }
}

export function getGoogleOAuthEnvCredentials(): GoogleOAuthCredentials | undefined {
  const access = process.env.GOOGLE_OAUTH_ACCESS_TOKEN?.trim() || '';
  const refresh = process.env.GOOGLE_OAUTH_REFRESH_TOKEN?.trim() || '';
  if (!access || !refresh) return undefined;

  const expiresRaw = process.env.GOOGLE_OAUTH_EXPIRES;
  const expires = expiresRaw ? Number.parseInt(expiresRaw, 10) : Date.now() + 30 * 60_000;
  return {
    access,
    refresh,
    expires: Number.isFinite(expires) ? expires : Date.now() + 30 * 60_000,
  };
}

export function hasGoogleOAuthEnvCredentials(): boolean {
  return !!getGoogleOAuthEnvCredentials();
}

function generateState(): string {
  return randomBytes(16)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

// Returns the current access token, refreshing via the refresh_token if within
// 60s of expiry. On rotation, calls onCredentialsChanged with the updated
// credentials so callers can persist them. Mirrors the codexOAuth pattern --
// callers that received credentials from env (not disk) must NOT persist
// rotated tokens, or env-supplied creds leak into config.json.
export async function resolveGoogleAccessToken(params: {
  credentials?: GoogleOAuthCredentials;
  onCredentialsChanged?: (credentials: GoogleOAuthCredentials) => void | Promise<void>;
}): Promise<string | undefined> {
  const credentials = params.credentials ?? getGoogleOAuthEnvCredentials();
  if (!credentials) return undefined;

  if (credentials.expires - Date.now() > 60_000) {
    return credentials.access;
  }

  const { clientId, clientSecret } = getClientCredentials();
  const client = new OAuth2Client({ clientId, clientSecret });
  client.setCredentials({ refresh_token: credentials.refresh });
  const response = await client.refreshAccessToken();

  const next: GoogleOAuthCredentials = {
    ...credentials,
    access: response.credentials.access_token || credentials.access,
    refresh: response.credentials.refresh_token || credentials.refresh,
    expires: response.credentials.expiry_date || Date.now() + 60 * 60_000,
  };
  if (
    next.access !== credentials.access ||
    next.refresh !== credentials.refresh ||
    next.expires !== credentials.expires
  ) {
    await params.onCredentialsChanged?.(next);
  }
  return next.access;
}

export async function requireGoogleAccessToken(params: {
  credentials?: GoogleOAuthCredentials;
  onCredentialsChanged?: (credentials: GoogleOAuthCredentials) => void | Promise<void>;
}): Promise<string> {
  const token = await resolveGoogleAccessToken(params);
  if (!token) {
    throw new Error('Google OAuth is not configured.');
  }
  return token;
}

type CallbackResult =
  | { kind: 'code'; code: string }
  | { kind: 'error'; error: string; description?: string };

type LoopbackHandle = {
  port: number;
  result: Promise<CallbackResult>;
  close: () => void;
};

function startLoopbackServer(expectedState: string): Promise<LoopbackHandle> {
  return new Promise((resolve, reject) => {
    let settle!: (r: CallbackResult) => void;
    const result = new Promise<CallbackResult>((res) => {
      settle = res;
    });

    const server: Server = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.statusCode = 404;
        res.end('Not Found');
        return;
      }
      // Validate state before anything else -- a request without the matching
      // state is either a stale tab or a forgery, and the auth code in such a
      // request must not be honored.
      const state = url.searchParams.get('state');
      if (state !== expectedState) {
        res.statusCode = 400;
        res.end('State mismatch. Sign-in aborted.');
        settle({ kind: 'error', error: 'state_mismatch' });
        return;
      }
      const error = url.searchParams.get('error');
      if (error) {
        const description = url.searchParams.get('error_description') || undefined;
        res.statusCode = 400;
        res.end(`Google returned an error: ${error}. You can close this tab.`);
        settle({ kind: 'error', error, description });
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) {
        res.statusCode = 400;
        res.end('Missing authorization code.');
        settle({ kind: 'error', error: 'missing_code' });
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(
        '<!DOCTYPE html><html><body style="font-family:system-ui;padding:2em;text-align:center;">' +
          '<h2>Signed in to Listener.AI</h2>' +
          '<p>You can close this tab and return to the app.</p>' +
          '</body></html>',
      );
      settle({ kind: 'code', code });
    });

    server.once('error', reject);
    // Port 0 = let the OS pick a free port. Google's Desktop OAuth client type
    // accepts http://127.0.0.1:<any-port>/<path> redirects without
    // pre-registration, so we don't need a fixed port.
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      if (!port) {
        server.close();
        reject(new Error('Failed to bind loopback server.'));
        return;
      }
      resolve({
        port,
        result,
        close: () => {
          try {
            server.close();
          } catch {
            /* server may already be closed; nothing to do */
          }
        },
      });
    });
  });
}

async function fetchUserEmail(accessToken: string): Promise<string | undefined> {
  try {
    const res = await fetch(USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { email?: string };
    return json.email;
  } catch {
    return undefined;
  }
}

export async function loginGoogleOAuth(params: {
  openUrl: (url: string) => void | Promise<void>;
  onPrompt?: (prompt: OAuthPrompt) => Promise<string>;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}): Promise<GoogleOAuthCredentials> {
  // Throws before binding a port if the OAuth client isn't configured, so the
  // caller sees the actionable error rather than a "loopback closed" message
  // halfway through.
  const { clientId, clientSecret } = getClientCredentials();
  const state = generateState();
  const handle = await startLoopbackServer(state);
  const redirectUri = `http://127.0.0.1:${handle.port}/callback`;

  const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
  const codes = await client.generateCodeVerifierAsync();

  // AbortSignal wiring: rejecting this promise races the callback promise and
  // triggers the finally block to close the loopback server.
  let abortListener: (() => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    if (!params.signal) return;
    if (params.signal.aborted) {
      reject(new GoogleLoginCancelledError());
      return;
    }
    abortListener = () => reject(new GoogleLoginCancelledError());
    params.signal.addEventListener('abort', abortListener, { once: true });
  });

  try {
    const authUrl = client.generateAuthUrl({
      scope: SCOPES,
      code_challenge: codes.codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
      state,
      // access_type=offline + prompt=consent guarantees Google issues a fresh
      // refresh_token, even if the user previously granted consent. Without
      // these, repeat sign-ins return only an access_token and login silently
      // becomes useless after the first session.
      access_type: 'offline',
      prompt: 'consent',
    });

    params.onProgress?.('Waiting for browser sign-in...');
    await params.openUrl(authUrl);

    const callback = await Promise.race([handle.result, abortPromise]);
    if (callback.kind === 'error') {
      const suffix = callback.description ? ` (${callback.description})` : '';
      throw new Error(`Google sign-in failed: ${callback.error}${suffix}`);
    }

    params.onProgress?.('Exchanging authorization code for tokens...');
    const tokenResponse = await client.getToken({
      code: callback.code,
      codeVerifier: codes.codeVerifier,
    });
    const tokens = tokenResponse.tokens;
    if (!tokens.access_token || !tokens.refresh_token) {
      throw new Error(
        'Google did not return both access and refresh tokens. ' +
          'If you have previously signed in, revoke access at ' +
          'https://myaccount.google.com/permissions and retry.',
      );
    }

    params.onProgress?.('Fetching account info...');
    const email = await fetchUserEmail(tokens.access_token);

    return {
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      expires: tokens.expiry_date || Date.now() + 60 * 60_000,
      email,
    };
  } finally {
    if (abortListener && params.signal) {
      params.signal.removeEventListener('abort', abortListener);
    }
    handle.close();
  }
}
