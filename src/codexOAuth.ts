import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { importEsm } from './esmImport';

type OAuthCredentials = {
  access: string;
  refresh: string;
  expires: number;
};

type OAuthPrompt = {
  message: string;
};

type CodexOAuthRuntime = {
  getOAuthApiKey: (
    providerId: 'openai-codex',
    credentials: { 'openai-codex': CodexOAuthCredentials },
  ) => Promise<{ apiKey?: string; newCredentials: CodexOAuthCredentials } | undefined>;
  loginOpenAICodex: (params: {
    originator: string;
    onAuth: (info: { url: string }) => void;
    onPrompt: (prompt: OAuthPrompt) => Promise<string>;
    onProgress?: (message: string) => void;
    onManualCodeInput?: () => Promise<string>;
  }) => Promise<CodexOAuthCredentials>;
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

let runtimePromise: Promise<CodexOAuthRuntime> | undefined;

async function loadCodexOAuthRuntime(): Promise<CodexOAuthRuntime> {
  runtimePromise ??= importEsm<CodexOAuthRuntime>('@earendil-works/pi-ai/oauth');
  return await runtimePromise;
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

  const { getOAuthApiKey } = await loadCodexOAuthRuntime();
  const resolved = await getOAuthApiKey('openai-codex', { 'openai-codex': credentials });
  if (!resolved) return undefined;

  const nextCredentials = resolved.newCredentials as CodexOAuthCredentials;
  if (
    nextCredentials.access !== credentials.access ||
    nextCredentials.refresh !== credentials.refresh ||
    nextCredentials.expires !== credentials.expires
  ) {
    await params.onCredentialsChanged?.(nextCredentials);
  }

  return resolved.apiKey;
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
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}): Promise<CodexOAuthCredentials> {
  const { loginOpenAICodex } = await loadCodexOAuthRuntime();

  // pi-ai exposes cancellation only via its `onManualCodeInput` race: when that
  // promise rejects, pi-ai calls the loopback server's cancelWait() (so
  // waitForCode() resolves null), records the error, and rethrows it inside
  // the loginOpenAICodex finally block -- which then closes the loopback
  // server and frees port 1455. We translate AbortSignal into that surface.
  let abortListener: (() => void) | undefined;
  const onManualCodeInput = params.signal
    ? () =>
        new Promise<string>((_resolve, reject) => {
          const signal = params.signal!;
          if (signal.aborted) {
            reject(new CodexLoginCancelledError());
            return;
          }
          abortListener = () => reject(new CodexLoginCancelledError());
          signal.addEventListener('abort', abortListener, { once: true });
        })
    : undefined;

  try {
    const credentials = await loginOpenAICodex({
      originator: 'listener-ai',
      onAuth: (info) => {
        void params.openUrl(info.url);
      },
      onPrompt: params.onPrompt,
      onProgress: params.onProgress,
      onManualCodeInput,
    });
    return credentials as CodexOAuthCredentials;
  } finally {
    // The manualPromise is left pending in pi-ai's success path; remove the
    // listener so it doesn't outlive the AbortController.
    if (abortListener && params.signal) {
      params.signal.removeEventListener('abort', abortListener);
    }
  }
}
