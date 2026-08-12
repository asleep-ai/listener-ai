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

async function createCodexModels(credentials?: CodexOAuthCredentials) {
  corePromise ??= importEsm<PiAiCoreModule>('@earendil-works/pi-ai');
  providerPromise ??= importEsm<CodexProviderModule>(
    '@earendil-works/pi-ai/providers/openai-codex',
  );
  const [core, provider] = await Promise.all([corePromise, providerPromise]);
  const store = new core.InMemoryCredentialStore();
  if (credentials) {
    await store.modify('openai-codex', async () => ({ type: 'oauth', ...credentials }));
  }
  const models = core.createModels({ credentials: store });
  models.setProvider(provider.openaiCodexProvider());
  return { models, store };
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

  const { models, store } = await createCodexModels(credentials);
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
  const { models } = await createCodexModels();
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
  if (!signal) return await new Promise<string>(() => {});
  signal.throwIfAborted();
  let abortListener: (() => void) | undefined;
  try {
    return await Promise.race([
      onPrompt ? onPrompt({ message: prompt.message }) : new Promise<string>(() => {}),
      new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(new CodexLoginCancelledError());
        signal.addEventListener('abort', abortListener, { once: true });
      }),
    ]);
  } finally {
    if (abortListener) signal.removeEventListener('abort', abortListener);
  }
}
