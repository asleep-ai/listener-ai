import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { importEsm } from './esmImport';

import type { AuthPrompt } from '@earendil-works/pi-ai';

type OAuthCredentials = {
  access: string;
  refresh: string;
  expires: number;
};

type OAuthPrompt = {
  message: string;
  // Forwarded so interactive prompts (the CLI readline) can tear themselves
  // down when the loopback wins the race or the user cancels; otherwise the
  // pending stdin read keeps the process alive after a successful browser
  // login.
  signal?: AbortSignal;
};

class CodexLoginCancelledError extends Error {
  constructor() {
    super('Codex sign-in cancelled.');
    this.name = 'CodexLoginCancelledError';
  }
}

export type CodexOAuthCredentials = OAuthCredentials & {
  accountId?: string;
  email?: string;
};

export type CodexOAuthCredentialSourceName = 'config' | 'env' | 'codexCli';

export interface CodexOAuthCredentialSource {
  source: CodexOAuthCredentialSourceName;
  credentials: CodexOAuthCredentials;
}

type PiAiCoreModule = typeof import('@earendil-works/pi-ai');
type CodexProviderModule = typeof import('@earendil-works/pi-ai/providers/openai-codex');

let corePromise: Promise<PiAiCoreModule> | undefined;
let providerPromise: Promise<CodexProviderModule> | undefined;

async function createCodexRuntime() {
  corePromise ??= importEsm<PiAiCoreModule>('@earendil-works/pi-ai');
  providerPromise ??= importEsm<CodexProviderModule>(
    '@earendil-works/pi-ai/providers/openai-codex',
  );
  const [core, provider] = await Promise.all([corePromise, providerPromise]);
  const store = new core.InMemoryCredentialStore();
  const models = core.createModels({ credentials: store });
  models.setProvider(provider.openaiCodexProvider());
  return { models, store };
}

// One store + Models per process: pi-ai serializes token refresh through the
// store's modify() lock, so callers sharing this runtime cannot double-refresh
// a rotating refresh token (segment transcription calls getToken() through
// Promise.all). A fresh store per call would make that lock protect nothing.
let sharedRuntimePromise: ReturnType<typeof createCodexRuntime> | undefined;

function getSharedCodexRuntime(): ReturnType<typeof createCodexRuntime> {
  sharedRuntimePromise ??= createCodexRuntime();
  return sharedRuntimePromise;
}

// Drop the shared runtime so the next resolve seeds the store from the
// caller's credentials. Required when the grant itself changes (fresh login);
// without it the store would keep refreshing the previous grant's tokens.
export function resetCodexRuntime(): void {
  sharedRuntimePromise = undefined;
}

export function getCodexOAuthEnvCredentials(): CodexOAuthCredentials | undefined {
  const access =
    process.env.CODEX_OAUTH_ACCESS_TOKEN?.trim() ||
    process.env.OPENAI_CODEX_ACCESS_TOKEN?.trim() ||
    '';
  const refresh =
    process.env.CODEX_OAUTH_REFRESH_TOKEN?.trim() ||
    process.env.OPENAI_CODEX_REFRESH_TOKEN?.trim() ||
    '';
  if (!access || !refresh) return undefined;

  const expiresRaw = process.env.CODEX_OAUTH_EXPIRES || process.env.OPENAI_CODEX_EXPIRES;
  const expires = expiresRaw ? Number.parseInt(expiresRaw, 10) : Date.now() + 30 * 60_000;
  return {
    access,
    refresh,
    expires: Number.isFinite(expires) ? expires : Date.now() + 30 * 60_000,
  };
}

export function hasCodexOAuthEnvCredentials(): boolean {
  return !!getCodexOAuthEnvCredentials();
}

function decodeJwtPayload(token: string | undefined): Record<string, unknown> | undefined {
  if (!token?.includes('.')) return undefined;
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    return JSON.parse(
      Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    ) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function jwtExpiryMs(token: string | undefined): number | undefined {
  const payload = decodeJwtPayload(token);
  const exp = payload?.exp;
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined;
}

function accountIdFromJwt(token: string | undefined): string | undefined {
  const payload = decodeJwtPayload(token);
  const auth = payload?.['https://api.openai.com/auth'];
  if (!auth || typeof auth !== 'object') return undefined;
  const accountId = (auth as { chatgpt_account_id?: unknown }).chatgpt_account_id;
  return typeof accountId === 'string' && accountId.trim() ? accountId : undefined;
}

export function getCodexCliAuthPath(): string | undefined {
  const override = process.env.LISTENER_CODEX_AUTH_PATH?.trim();
  if (override) return override;
  // Unit tests must not accidentally read the developer's real Codex auth file.
  if (process.env.NODE_ENV === 'test') return undefined;
  return path.join(os.homedir(), '.codex', 'auth.json');
}

export function getCodexOAuthCliCredentials(): CodexOAuthCredentials | undefined {
  const authPath = getCodexCliAuthPath();
  if (!authPath) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  } catch {
    return undefined;
  }
  const root = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  const tokens =
    root.tokens && typeof root.tokens === 'object'
      ? (root.tokens as Record<string, unknown>)
      : root;
  const access =
    typeof tokens.access_token === 'string'
      ? tokens.access_token.trim()
      : typeof tokens.access === 'string'
        ? tokens.access.trim()
        : '';
  const refresh =
    typeof tokens.refresh_token === 'string'
      ? tokens.refresh_token.trim()
      : typeof tokens.refresh === 'string'
        ? tokens.refresh.trim()
        : '';
  if (!access || !refresh) return undefined;

  const expires =
    (typeof tokens.expires === 'number' && Number.isFinite(tokens.expires)
      ? tokens.expires
      : undefined) ??
    (typeof root.expires === 'number' && Number.isFinite(root.expires)
      ? root.expires
      : undefined) ??
    jwtExpiryMs(access) ??
    Date.now() + 30 * 60_000;
  const accountId =
    (typeof tokens.account_id === 'string' && tokens.account_id.trim()) ||
    (typeof root.account_id === 'string' && root.account_id.trim()) ||
    accountIdFromJwt(access);
  return {
    access,
    refresh,
    expires,
    ...(accountId ? { accountId } : {}),
  };
}

export function hasCodexOAuthCliCredentials(): boolean {
  return !!getCodexOAuthCliCredentials();
}

export async function resolveCodexAccessToken(params: {
  credentials?: CodexOAuthCredentials;
  onCredentialsChanged?: (credentials: CodexOAuthCredentials) => void | Promise<void>;
}): Promise<string | undefined> {
  const credentials = params.credentials ?? getCodexOAuthEnvCredentials();
  if (!credentials) return undefined;

  const { models, store } = await getSharedCodexRuntime();
  // Seed only an empty store. Within one process the store is always at least
  // as fresh as any caller's copy (rotation lands in the store first; callers
  // learn about it below via onCredentialsChanged), so overwriting it with
  // caller credentials could resurrect an already-rotated refresh token.
  const existing = await store.read('openai-codex');
  if (existing?.type !== 'oauth') {
    await store.modify('openai-codex', async () => ({ type: 'oauth', ...credentials }));
  }
  const resolved = await models.getAuth('openai-codex');
  if (!resolved) return undefined;

  const stored = await store.read('openai-codex');
  if (stored?.type !== 'oauth') return undefined;
  const { type: _type, ...nextCredentials } = stored;
  if (
    nextCredentials.access !== credentials.access ||
    nextCredentials.refresh !== credentials.refresh ||
    nextCredentials.expires !== credentials.expires
  ) {
    await params.onCredentialsChanged?.(nextCredentials);
  }

  return resolved.auth.apiKey;
}

export async function requireCodexAccessToken(params: {
  credentials?: CodexOAuthCredentials;
  onCredentialsChanged?: (credentials: CodexOAuthCredentials) => void | Promise<void>;
}): Promise<string> {
  const token = await resolveCodexAccessToken(params);
  if (!token) {
    throw new Error('Codex OAuth is not configured.');
  }
  return token;
}

export async function loginCodexOAuth(params: {
  openUrl: (url: string) => void | Promise<void>;
  onPrompt?: (prompt: OAuthPrompt) => Promise<string>;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}): Promise<CodexOAuthCredentials> {
  // Login runs on an ephemeral runtime so an in-flight login can't disturb the
  // shared store other callers are refreshing against.
  const { models } = await createCodexRuntime();
  const credential = await models.login('openai-codex', 'oauth', {
    signal: params.signal,
    prompt: async (prompt) => {
      // Preserve Listener's existing browser-login behavior. pi-ai 0.84 also
      // offers device-code auth, but the current UI has no selector for it.
      if (prompt.type === 'select') return 'browser';
      return await runCodexOAuthPrompt(params.onPrompt, prompt, params.signal);
    },
    notify: (event) => {
      if (event.type === 'auth_url') {
        void params.openUrl(event.url);
      } else if (event.type === 'progress' || event.type === 'info') {
        params.onProgress?.(event.message);
      } else if (event.type === 'device_code') {
        params.onProgress?.(`Enter code ${event.userCode} at ${event.verificationUri}`);
      }
    },
  });
  if (credential.type !== 'oauth') {
    throw new Error('Codex OAuth returned a non-OAuth credential.');
  }
  // A fresh grant obsoletes whatever the shared store held; drop it so the
  // next resolve re-seeds from the new credentials.
  resetCodexRuntime();
  const { type: _type, ...credentials } = credential;
  return credentials as CodexOAuthCredentials;
}

export async function runCodexOAuthPrompt(
  onPrompt: ((prompt: OAuthPrompt) => Promise<string>) | undefined,
  prompt: AuthPrompt,
  outerSignal?: AbortSignal,
): Promise<string> {
  const signals = [prompt.signal, outerSignal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  if (signals.length === 0 && onPrompt) return await onPrompt({ message: prompt.message });

  const signal =
    signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  if (!signal) {
    // No handler and nothing that could ever settle this prompt: fail loudly
    // instead of installing a permanent hang. Unreachable today (pi-ai always
    // attaches prompt.signal), kept as a tripwire for contract drift.
    throw new Error('Codex OAuth prompt has no handler and no abort signal.');
  }
  signal.throwIfAborted();
  let abortListener: (() => void) | undefined;
  try {
    return await Promise.race([
      onPrompt ? onPrompt({ message: prompt.message, signal }) : new Promise<string>(() => {}),
      new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(new CodexLoginCancelledError());
        signal.addEventListener('abort', abortListener, { once: true });
      }),
    ]);
  } finally {
    if (abortListener) signal.removeEventListener('abort', abortListener);
  }
}
