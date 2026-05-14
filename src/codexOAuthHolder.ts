// Encapsulates Codex OAuth credential state for services that need a fresh
// access token per request. Replaces the parallel `this.codexOAuth +
// this.onCodexOAuthUpdate + getToken()` fields that lived inside
// AgentService and GeminiService -- keeping them in sync was error-prone and
// the rotation invariant (caller persists when source is config, skips when
// source is env) is easy to get wrong if scattered.

import { type CodexOAuthCredentials, requireCodexAccessToken } from './codexOAuth';

export interface CodexOAuthHolderOptions {
  credentials?: CodexOAuthCredentials;
  onUpdate?: (credentials: CodexOAuthCredentials) => void | Promise<void>;
}

export class CodexOAuthHolder {
  private credentials: CodexOAuthCredentials | undefined;
  private readonly onUpdate?: (credentials: CodexOAuthCredentials) => void | Promise<void>;

  constructor(options: CodexOAuthHolderOptions) {
    this.credentials = options.credentials;
    this.onUpdate = options.onUpdate;
  }

  async getToken(): Promise<string> {
    return await requireCodexAccessToken({
      credentials: this.credentials,
      onCredentialsChanged: async (next) => {
        this.credentials = next;
        await this.onUpdate?.(next);
      },
    });
  }
}
