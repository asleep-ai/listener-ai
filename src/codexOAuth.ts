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
  }) => Promise<CodexOAuthCredentials>;
};

export type CodexOAuthCredentials = OAuthCredentials & {
  accountId?: string;
  email?: string;
};

const importEsm = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<CodexOAuthRuntime>;

let runtimePromise: Promise<CodexOAuthRuntime> | undefined;

async function loadCodexOAuthRuntime(): Promise<CodexOAuthRuntime> {
  runtimePromise ??= importEsm('@earendil-works/pi-ai/oauth');
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
}): Promise<CodexOAuthCredentials> {
  const { loginOpenAICodex } = await loadCodexOAuthRuntime();
  const credentials = await loginOpenAICodex({
    originator: 'listener-ai',
    onAuth: (info) => {
      void params.openUrl(info.url);
    },
    onPrompt: params.onPrompt,
    onProgress: params.onProgress,
  });
  return credentials as CodexOAuthCredentials;
}
