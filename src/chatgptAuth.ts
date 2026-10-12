import { createHash, randomBytes, randomUUID } from 'crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'http';
import type { AddressInfo } from 'net';
import * as path from 'path';
import {
  type ChatGPTCredentialRecord,
  type ChatGPTIndex,
  type ChatGPTRegistration,
  ChatGPTCredentialStore,
  ChatGPTStoreError,
} from './chatgptCredentialStore';
import { getDataPath } from './dataPath';
import { importEsm } from './esmImport';

// Sign in with ChatGPT (SIWC), open-source plan-usage flow. Clean-room
// implementation of the public contract at
// https://developers.openai.com/siwc/token-sharing-open-source (sign-in,
// accounts and sessions, token reference, errors and recovery):
//
// - public client, app-specific dynamic registration (`dynamic_agent_client`
//   -> issued `oaiapp_...` client ID), one stable `urn:uuid:` host per install
// - system-browser loopback on http://127.0.0.1:<dynamic port>/auth/callback
// - fresh state / nonce / PKCE S256 per attempt; ID token signature, iss, aud,
//   exp, nonce and (on reauthorization) subject checks
// - plan usage gated on the granted `chatgpt.tokens.use.direct` scope
// - rotating refresh tokens serialized across processes, revoke on sign-out
//
// Tokens never leave this module except through getAccessToken(); status,
// profile and error surfaces carry no token material.

type Jose = typeof import('jose');

export const CHATGPT_ISSUER = 'https://auth.openai.com';
export const CHATGPT_API_BASE_URL = 'https://api.openai.com/v1';
export const CHATGPT_RESOURCE = 'https://api.openai.com/v1';
export const CHATGPT_PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const CHATGPT_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'resource.invoke',
  CHATGPT_PLAN_SCOPE,
] as const;
export const CHATGPT_MANAGE_USAGE_URL = 'https://chatgpt.com/settings/usage';

// Lock timing policy. A profile lock is held across network calls (token
// refresh, revocation), whose per-request retry ladder alone can take
// 3 x 30 s + backoff. Instead of sizing the waiter to that, every network call
// made while holding a lock shares one deadline, so a holder always releases
// within CHATGPT_LOCKED_NETWORK_BUDGET_MS. The waiter budget covers the holder
// plus one queued waiter ahead of it (the app and the CLI), with margin.
export const CHATGPT_LOCKED_NETWORK_BUDGET_MS = 25_000;
export const CHATGPT_LOCK_WAIT_MS = 60_000;

const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
const AGENT_NAME = 'Listener.AI';
const CALLBACK_PATH = '/auth/callback';
const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,100}$/;
const ISSUED_CLIENT_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const ID_TOKEN_ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
];
// Refresh errors after which the stored refresh token can never work again.
const TERMINAL_REFRESH_ERRORS = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);
// Connection failures where the request certainly never reached the server.
// Refresh is retried only on these and on 5xx: a timeout or reset after the
// request was sent may already have rotated the refresh token server-side,
// and replaying the old one would only earn `refresh_token_reused`.
const UNSENT_NETWORK_ERRORS = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

// `connected` means a verified ChatGPT identity is signed in on this
// profile. It does not imply a bearer grant: `planEnabled` is true only when
// the plan scope was granted AND a renewable access/refresh token pair exists.
export type ChatGPTStatus = {
  connected: boolean;
  planEnabled: boolean;
  profileId?: string;
  email?: string;
  // Set when connected: why plan usage is or is not available.
  //   enabled      plan scope granted with a renewable bearer grant
  //   not_granted  identity only; the user declined (or was not offered) plan usage
  //   incomplete   plan scope granted but no access + refresh token pair was
  //                issued; never treated as an inference entitlement
  planState?: ChatGPTPlanState;
  // Set when connected: an opaque, non-reversible tag of the current sign-in
  // grant. It changes on every sign-in, including a reauthorization of the
  // same profile, so callers that cache services per grant can tell that new
  // work must bind again. Never a token or the raw session id.
  sessionRevision?: string;
};

export type ChatGPTPlanState = 'enabled' | 'not_granted' | 'incomplete';

export type ChatGPTProfile = {
  id: string;
  email?: string;
  // Stable, distinct display label for this registration, derived only from
  // its immutable registration id (never from the email, subject or a
  // workspace name). Two registrations that share an email -- e.g. personal
  // and workspace sign-ins -- always get different labels, and a label
  // survives sign-out, reauthorization and restarts. Optional so consumers
  // tolerate payloads from older builds.
  label?: string;
  connected: boolean;
  planEnabled: boolean;
  active: boolean;
};

export type ChatGPTModel = {
  slug: string;
  display_name: string;
};

export type ChatGPTSignInOptions = {
  openBrowser: (url: string) => Promise<void> | void;
  signal?: AbortSignal;
  // Register an additional account instead of reauthorizing the active one.
  newProfile?: boolean;
  // Reauthorize (or finish registering) this profile.
  profileId?: string;
  onProgress?: (message: string) => void;
  // Explicit "Enable ChatGPT plan" action only: adds `prompt=consent` so the
  // consent screen is shown again. Never set on ordinary sign-ins. The full
  // scope set is requested on every sign-in regardless. `force_reconsent` is
  // not used until OpenAI confirms its deployment for this integration.
  requestPlanConsent?: boolean;
};

export type ChatGPTSignOutResult = {
  // True only when the OpenAI revocation endpoint confirmed (HTTP 200).
  revoked: boolean;
  // Whether a revocable grant (refresh token) existed. An identity-only
  // sign-in has nothing to revoke: signOut clears it locally and reports
  // { revoked: false, signedIn: false }.
  signedIn: boolean;
  // Sanitized reason when a revocation was attempted and not confirmed.
  revocationError?: string;
};

// A job-scoped handle: every call is bound to the profile and to the sign-in
// session that existed when it was opened. A sign-out (or a new sign-in) of
// that profile ends it instead of silently continuing on another grant.
export type ChatGPTSession = {
  readonly profileId: string;
  getAccessToken(signal?: AbortSignal): Promise<string>;
  listModels(signal?: AbortSignal): Promise<ChatGPTModel[]>;
  /**
   * Synchronous, network-free: true while the profile's stored credential
   * record still holds this session (same sign-in grant). False after a
   * sign-out (from any process), a sign-out followed by a new sign-in of the
   * same profile, or a terminal refresh error; also false when the record
   * cannot be read (fail closed). Selecting another active profile does NOT
   * end it.
   */
  isActive(): boolean;
};

export type ChatGPTAuthErrorCode =
  | 'cancelled'
  | 'timeout'
  | 'access_denied'
  | 'callback_error'
  | 'loopback_failed'
  | 'registration_incomplete'
  | 'client_mismatch'
  | 'invalid_id_token'
  | 'account_mismatch'
  | 'invalid_grant'
  | 'token_exchange_failed'
  | 'invalid_token_response'
  | 'discovery_failed'
  | 'not_signed_in'
  | 'profile_not_found'
  | 'plan_disabled'
  | 'plan_grant_incomplete'
  | 'reauth_required'
  | 'invalid_client'
  | 'session_ended'
  | 'temporarily_unavailable'
  | 'http_error'
  | 'store_error';

export class ChatGPTAuthError extends Error {
  readonly code: ChatGPTAuthErrorCode;
  readonly status?: number;
  // Exact provider error code (`error` or `error.code`) when it is a plain
  // identifier; free-text bodies such as `{"detail": ...}` are never copied.
  readonly providerCode?: string;
  readonly requestId?: string;

  constructor(
    code: ChatGPTAuthErrorCode,
    message: string,
    details: { status?: number; providerCode?: string; requestId?: string } = {},
  ) {
    super(message);
    this.name = 'ChatGPTAuthError';
    this.code = code;
    if (details.status !== undefined) this.status = details.status;
    if (details.providerCode !== undefined) this.providerCode = details.providerCode;
    if (details.requestId !== undefined) this.requestId = details.requestId;
  }
}

// Sign-in endings the user chose or caused: cancelling, declining consent in
// the browser, letting the browser step time out, signing in to a different
// account than the one selected, or signing the account out (from another
// process) before the attempt committed. They are shown to the user but are
// not app failures, so error tracking skips them.
const EXPECTED_SIGN_IN_OUTCOMES = new Set<ChatGPTAuthErrorCode>([
  'cancelled',
  'access_denied',
  'timeout',
  'account_mismatch',
  'session_ended',
]);

export function isExpectedSignInOutcome(error: unknown): boolean {
  return error instanceof ChatGPTAuthError && EXPECTED_SIGN_IN_OUTCOMES.has(error.code);
}

export type ChatGPTAuthDependencies = {
  fetch?: typeof fetch;
  // OIDC issuer; discovery is `${issuer}/.well-known/openid-configuration`.
  issuer?: string;
  apiBaseUrl?: string;
  now?: () => number;
  callbackPort?: number;
  callbackTimeoutMs?: number;
  requestTimeoutMs?: number;
  // Backoff between attempts; its length is the number of retries.
  retryDelaysMs?: number[];
  // Refresh this long before access-token expiry.
  refreshSkewMs?: number;
  lockRetryMs?: number;
  lockTimeoutMs?: number;
  // Total network time allowed while holding a store lock (see the policy
  // constants above); keep it below half of lockTimeoutMs.
  lockedNetworkBudgetMs?: number;
};

type Discovery = {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  jwksUri: string;
};

type TokenResponse = {
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  tokenType?: string;
  expiresIn: number;
  scopes?: string[];
  earliestRefreshAt?: number;
};

type CallbackResult = { code: string; scope?: string; clientId?: string };

type SignInTarget =
  | { mode: 'new' }
  | { mode: 'pending'; registration: ChatGPTRegistration }
  | {
      mode: 'reauth';
      registration: ChatGPTRegistration;
      idToken?: string;
      // The sign-in session this attempt reauthorizes, if one existed. The
      // commit is refused when it ended or changed meanwhile (sign-out).
      sessionId?: string;
    };

type HttpResult = { status: number; text: string; requestId?: string };

export class ChatGPTAuth {
  private readonly deps: Required<Omit<ChatGPTAuthDependencies, 'fetch'>> & { fetch: typeof fetch };
  private readonly explicitDataDir?: string;
  private storeInstance?: ChatGPTCredentialStore;
  private discovery?: Promise<Discovery>;
  private jwks?: Promise<ReturnType<Jose['createLocalJWKSet']>>;
  private refreshes = new Map<string, Promise<ChatGPTCredentialRecord>>();
  // In-flight sign-ins that reauthorize an existing registration, keyed by
  // its id, so a sign-out of that account stops them (see signOut).
  private signIns = new Map<string, Set<AbortController>>();

  constructor(dataDir?: string, dependencies: ChatGPTAuthDependencies = {}) {
    this.explicitDataDir = dataDir;
    this.deps = {
      fetch: dependencies.fetch ?? ((...args) => fetch(...args)),
      issuer: trimSlash(dependencies.issuer ?? CHATGPT_ISSUER),
      apiBaseUrl: trimSlash(dependencies.apiBaseUrl ?? CHATGPT_API_BASE_URL),
      now: dependencies.now ?? Date.now,
      callbackPort: dependencies.callbackPort ?? 0,
      callbackTimeoutMs: dependencies.callbackTimeoutMs ?? 10 * 60_000,
      requestTimeoutMs: dependencies.requestTimeoutMs ?? 30_000,
      retryDelaysMs: dependencies.retryDelaysMs ?? [500, 2_000],
      refreshSkewMs: dependencies.refreshSkewMs ?? 5 * 60_000,
      lockRetryMs: dependencies.lockRetryMs ?? 100,
      lockTimeoutMs: dependencies.lockTimeoutMs ?? CHATGPT_LOCK_WAIT_MS,
      lockedNetworkBudgetMs: dependencies.lockedNetworkBudgetMs ?? CHATGPT_LOCKED_NETWORK_BUDGET_MS,
    };
  }

  // Resolved lazily so constructing the singleton never races data-path setup.
  private get store(): ChatGPTCredentialStore {
    this.storeInstance ??= new ChatGPTCredentialStore(
      path.join(this.explicitDataDir ?? getDataPath(), 'chatgpt'),
      { lockRetryMs: this.deps.lockRetryMs, lockTimeoutMs: this.deps.lockTimeoutMs },
    );
    return this.storeInstance;
  }

  // ---------------------------------------------------------------- status

  async getStatus(): Promise<ChatGPTStatus> {
    return this.getStatusSync();
  }

  // Synchronous, network-free projection for synchronous consumers (config
  // gates, settings payloads). Reads only the protected store; an expired
  // access token with a usable refresh token still counts as connected --
  // the next request refreshes and validates it.
  getStatusSync(): ChatGPTStatus {
    const index = this.readIndex();
    const active = index.activeProfileId ? findComplete(index, index.activeProfileId) : undefined;
    if (!active) return { connected: false, planEnabled: false };
    return this.statusFor(active);
  }

  async listProfiles(): Promise<ChatGPTProfile[]> {
    const index = this.readIndex();
    const complete = index.registrations.filter((r) => !r.pending);
    const labels = registrationLabels(complete.map((r) => r.id));
    return complete.map((registration, i) => {
      const status = this.statusFor(registration);
      const profile: ChatGPTProfile = {
        id: registration.id,
        label: labels[i],
        connected: status.connected,
        planEnabled: status.planEnabled,
        active: index.activeProfileId === registration.id,
      };
      if (registration.email) profile.email = registration.email;
      return profile;
    });
  }

  async selectProfile(id: string): Promise<ChatGPTStatus> {
    const registration = await this.guardStore(() =>
      this.store.withIndexLock(() => {
        const index = this.store.readIndex();
        const found = findComplete(index, id);
        if (!found)
          throw new ChatGPTAuthError('profile_not_found', 'That ChatGPT account is not saved.');
        index.activeProfileId = found.id;
        this.store.writeIndex(index);
        return found;
      }),
    );
    return this.statusFor(registration);
  }

  // ---------------------------------------------------------------- sign-in

  async signIn(options: ChatGPTSignInOptions): Promise<ChatGPTStatus> {
    throwIfCancelled(options.signal);
    const target = this.resolveSignInTarget(options);
    // A reauthorization (including Enable ChatGPT plan) can be stopped by a
    // sign-out of the same account in this process; a brand-new registration
    // has no account to sign out yet. Other accounts' sign-ins are unaffected.
    const attempt = new AbortController();
    const key = target.mode === 'new' ? undefined : target.registration.id;
    if (key) {
      const attempts = this.signIns.get(key) ?? new Set<AbortController>();
      attempts.add(attempt);
      this.signIns.set(key, attempts);
    }
    try {
      return await this.runSignIn(options, target, anySignal([options.signal, attempt.signal])!);
    } finally {
      if (key) {
        const attempts = this.signIns.get(key);
        attempts?.delete(attempt);
        if (attempts?.size === 0) this.signIns.delete(key);
      }
    }
  }

  private async runSignIn(
    options: ChatGPTSignInOptions,
    target: SignInTarget,
    signal: AbortSignal,
  ): Promise<ChatGPTStatus> {
    const progress = (message: string) => {
      try {
        options.onProgress?.(message);
      } catch {
        // A broken progress subscriber must not break sign-in.
      }
    };

    const hostId = await this.ensureHostId(signal);
    const discovery = await this.discover(signal);

    const verifier = randomToken();
    const state = randomToken();
    const nonce = randomToken();
    const loopback = await startLoopback(this.deps.callbackPort, state);
    let callback: CallbackResult;
    let redirectUri: string;
    try {
      redirectUri = loopback.redirectUri;
      const url = new URL(discovery.authorizationEndpoint);
      const params = url.searchParams;
      if (target.mode === 'new') {
        params.set('client_id', DYNAMIC_CLIENT_ID);
        params.set('agent_name_hint', AGENT_NAME);
      } else {
        params.set('client_id', target.registration.clientId);
      }
      params.set('ext_agent_host_id', hostId);
      if (target.mode === 'reauth') {
        if (target.idToken) params.set('id_token_hint', target.idToken);
        if (target.registration.email) params.set('login_hint', target.registration.email);
      }
      params.set('response_type', 'code');
      params.set('redirect_uri', redirectUri);
      params.set('scope', CHATGPT_SCOPES.join(' '));
      params.set('resource', CHATGPT_RESOURCE);
      params.set('state', state);
      params.set('nonce', nonce);
      params.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
      params.set('code_challenge_method', 'S256');
      if (options.requestPlanConsent) params.set('prompt', 'consent');

      progress('Waiting for ChatGPT sign-in in your browser...');
      await options.openBrowser(url.toString());
      callback = await loopback.wait(signal, this.deps.callbackTimeoutMs);
    } finally {
      await loopback.close();
    }

    let registration: ChatGPTRegistration;
    if (target.mode === 'new') {
      const issued = callback.clientId;
      if (!issued || issued === DYNAMIC_CLIENT_ID || !ISSUED_CLIENT_ID.test(issued)) {
        throw new ChatGPTAuthError(
          'registration_incomplete',
          'ChatGPT did not return an app registration. Please try signing in again.',
        );
      }
      registration = await this.persistPendingRegistration(issued, signal);
    } else {
      registration = target.registration;
      if (callback.clientId !== undefined && callback.clientId !== registration.clientId) {
        throw new ChatGPTAuthError(
          'client_mismatch',
          'ChatGPT returned a different app registration. Sign-in was rejected.',
        );
      }
    }

    progress('Completing ChatGPT sign-in...');
    const tokens = await this.exchangeCode(
      discovery,
      registration.clientId,
      callback.code,
      verifier,
      redirectUri,
      signal,
    );
    // The ID token is the only mandatory part: a user who declines plan usage
    // can receive a verified identity with no access or refresh token.
    if (!tokens.idToken) {
      throw new ChatGPTAuthError(
        'invalid_token_response',
        'ChatGPT returned an incomplete sign-in response.',
      );
    }
    const claims = await this.verifyIdToken(
      discovery,
      tokens.idToken,
      registration.clientId,
      nonce,
    );

    if (target.mode === 'reauth' && claims.sub !== registration.subject) {
      // Never let one account's grant replace another's. The stray grant is
      // revoked best-effort so it does not linger as a connected app.
      if (tokens.refreshToken) {
        await this.revoke(discovery, tokens.refreshToken, registration.clientId).catch(() => {});
      }
      throw new ChatGPTAuthError(
        'account_mismatch',
        'You signed in to a different ChatGPT account than the one selected. Nothing was changed.',
      );
    }

    // Identity-only results are still saved (the user stays signed in), but
    // plan usage stays disabled until the scope is granted together with a
    // renewable bearer grant.
    const scopes = tokens.scopes ?? parseScopes(callback.scope);
    const record: ChatGPTCredentialRecord = {
      version: 1,
      profileId: registration.id,
      clientId: registration.clientId,
      subject: claims.sub,
      issuer: discovery.issuer,
      extAgentHostId: hostId,
      idToken: tokens.idToken,
      sessionId: randomUUID(),
      scopes,
      savedAt: this.deps.now(),
    };
    if (tokens.accessToken) {
      record.accessToken = tokens.accessToken;
      record.expiresAt = this.deps.now() + tokens.expiresIn * 1000;
      if (tokens.tokenType) record.tokenType = tokens.tokenType;
    }
    if (tokens.refreshToken) record.refreshToken = tokens.refreshToken;
    if (claims.email) record.email = claims.email;
    if (tokens.earliestRefreshAt !== undefined) record.earliestRefreshAt = tokens.earliestRefreshAt;

    // Cancellation is honored up to the commit point, which is the credential
    // write AND the profile activation together: both locks are held (profile
    // -> index is the lock order) before anything is written, and the two
    // writes run synchronously with no await between them, so no reader ever
    // sees the new credentials without the activation. A cancel while waiting
    // for either lock leaves the previous credentials and the active profile
    // exactly as they were.
    let completed: ChatGPTRegistration;
    try {
      throwIfCancelled(signal);
      completed = await this.guardStore(() =>
        this.store.withProfileLock(
          registration.id,
          () =>
            this.store.withIndexLock(() => {
              throwIfCancelled(signal);
              const index = this.store.readIndex();
              const current = index.registrations.find((r) => r.id === registration.id);
              if (!current || current.clientId !== registration.clientId) {
                throw new ChatGPTAuthError(
                  'store_error',
                  'The ChatGPT account changed during sign-in. Please try again.',
                );
              }
              let prior: ChatGPTCredentialRecord | undefined;
              try {
                prior = this.store.readCredentials(registration.id);
              } catch {
                prior = undefined;
              }
              // Fence: a reauthorization of session S commits only while S is
              // still the stored session. A sign-out (from any process), or
              // anything else that ended or replaced S, invalidates the
              // attempt, so it can never restore deleted credentials.
              if (
                target.mode === 'reauth' &&
                target.sessionId !== undefined &&
                prior?.sessionId !== target.sessionId
              ) {
                throw new ChatGPTAuthError(
                  'session_ended',
                  'This ChatGPT account was signed out or changed while you were signing in. Nothing was changed; sign in again.',
                );
              }
              delete current.pending;
              current.subject = claims.sub;
              current.issuer = discovery.issuer;
              if (claims.email) current.email = claims.email;
              else delete current.email;
              index.activeProfileId = current.id;
              this.store.writeCredentials(record);
              try {
                this.store.writeIndex(index);
              } catch (error) {
                // Not activated: put the previous credentials back while both
                // locks are still held.
                if (prior) this.store.writeCredentials(prior);
                else this.store.deleteCredentials(registration.id);
                throw error;
              }
              return { ...current };
            }, signal),
          signal,
        ),
      );
    } catch (error) {
      const cancelled = error instanceof ChatGPTAuthError && error.code === 'cancelled';
      if (cancelled && target.mode === 'new' && tokens.refreshToken) {
        // Best effort, not awaited: a brand-new registration has no earlier
        // grant this could affect. A reauthorization grant is left alone.
        void this.revoke(
          discovery,
          tokens.refreshToken,
          registration.clientId,
          AbortSignal.timeout(this.deps.lockedNetworkBudgetMs),
        ).catch(() => {});
      }
      throw error;
    }
    this.refreshes.delete(registration.id);
    progress('Signed in to ChatGPT.');
    return this.statusFor(completed);
  }

  private resolveSignInTarget(options: ChatGPTSignInOptions): SignInTarget {
    const index = this.readIndex();
    const pending = [...index.registrations].reverse().find((r) => r.pending);
    const reauth = (registration: ChatGPTRegistration): SignInTarget => {
      const record = this.store.readCredentials(registration.id);
      const target: SignInTarget = { mode: 'reauth', registration };
      if (record?.idToken) target.idToken = record.idToken;
      if (record?.sessionId) target.sessionId = record.sessionId;
      return target;
    };
    if (options.profileId) {
      const registration = index.registrations.find((r) => r.id === options.profileId);
      if (!registration)
        throw new ChatGPTAuthError('profile_not_found', 'That ChatGPT account is not saved.');
      return registration.pending ? { mode: 'pending', registration } : reauth(registration);
    }
    if (!options.newProfile && index.activeProfileId) {
      const active = findComplete(index, index.activeProfileId);
      if (active) return reauth(active);
    }
    // A registration whose code exchange failed is retried with the same
    // issued client ID, as the sign-in guide requires.
    return pending ? { mode: 'pending', registration: pending } : { mode: 'new' };
  }

  private async persistPendingRegistration(
    clientId: string,
    signal?: AbortSignal,
  ): Promise<ChatGPTRegistration> {
    return this.guardStore(() =>
      this.store.withIndexLock(() => {
        const index = this.store.readIndex();
        const existing = index.registrations.find((r) => r.clientId === clientId);
        if (existing) return existing;
        const registration: ChatGPTRegistration = {
          id: randomUUID(),
          clientId,
          pending: true,
          createdAt: this.deps.now(),
        };
        index.registrations.push(registration);
        this.store.writeIndex(index);
        return registration;
      }, signal),
    );
  }

  private async ensureHostId(signal?: AbortSignal): Promise<string> {
    return this.guardStore(() => {
      const existing = this.store.readHostId();
      if (existing) return existing;
      return this.store.withIndexLock(
        () => this.store.ensureHostIdLocked(() => `urn:uuid:${randomUUID()}`),
        signal,
      );
    });
  }

  // ---------------------------------------------------------------- tokens

  async getAccessToken(profileId?: string): Promise<string> {
    return this.tokenFor(profileId);
  }

  async listModels(profileId?: string): Promise<ChatGPTModel[]> {
    return this.modelsFor(profileId);
  }

  async openSession(profileId?: string): Promise<ChatGPTSession> {
    const registration = this.requireRegistration(profileId);
    const record = this.store.readCredentials(registration.id);
    if (!record || !isSignedIn(record, registration)) {
      throw new ChatGPTAuthError('not_signed_in', 'Sign in with ChatGPT first.');
    }
    const sessionId = record.sessionId!;
    const id = registration.id;
    return {
      profileId: id,
      getAccessToken: (signal) => this.tokenFor(id, sessionId, signal),
      listModels: (signal) => this.modelsFor(id, sessionId, signal),
      isActive: () => {
        try {
          const current = this.store.readCredentials(id);
          return (
            current !== undefined &&
            current.sessionId === sessionId &&
            isSignedIn(current, registration)
          );
        } catch {
          return false;
        }
      },
    };
  }

  private async tokenFor(
    profileId?: string,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const registration = this.requireRegistration(profileId);
    let record = this.store.readCredentials(registration.id);
    this.assertSession(record, registration, sessionId);
    // Scope gate before any network call.
    assertPlanGrant(record!);
    if (!this.needsRefresh(record!)) return record!.accessToken!;
    // The shared refresh is not tied to one caller's signal: cancelling one
    // job must not abort a refresh other callers are waiting on, but the
    // cancelled caller stops waiting on it.
    throwIfCancelled(signal);
    record = await untilAborted(this.refresh(registration), signal);
    this.assertSession(record, registration, sessionId);
    assertPlanGrant(record);
    return record.accessToken!;
  }

  private assertSession(
    record: ChatGPTCredentialRecord | undefined,
    registration: ChatGPTRegistration,
    sessionId?: string,
  ): void {
    if (sessionId !== undefined && record?.sessionId !== sessionId) {
      throw new ChatGPTAuthError(
        'session_ended',
        'The ChatGPT session used by this job has ended.',
      );
    }
    if (!record || !isSignedIn(record, registration)) {
      throw new ChatGPTAuthError('not_signed_in', 'Sign in with ChatGPT first.');
    }
  }

  private needsRefresh(record: ChatGPTCredentialRecord): boolean {
    const now = this.deps.now();
    const expiresAt = record.expiresAt ?? 0;
    if (expiresAt - this.deps.refreshSkewMs > now) return false;
    // Honour earliest_refresh_at while the current token is still usable.
    if (
      record.earliestRefreshAt !== undefined &&
      now < record.earliestRefreshAt &&
      expiresAt - 30_000 > now
    ) {
      return false;
    }
    return true;
  }

  // One refresh per profile per process; across processes the profile lock
  // serializes, and the record is reread under the lock so a refresh another
  // process already completed is reused instead of replaying a rotated token.
  private refresh(registration: ChatGPTRegistration): Promise<ChatGPTCredentialRecord> {
    const inFlight = this.refreshes.get(registration.id);
    if (inFlight) return inFlight;
    const promise = this.guardStore(() =>
      this.store.withProfileLock(registration.id, () => this.refreshLocked(registration)),
    ).finally(() => {
      if (this.refreshes.get(registration.id) === promise) this.refreshes.delete(registration.id);
    });
    this.refreshes.set(registration.id, promise);
    return promise;
  }

  private async refreshLocked(registration: ChatGPTRegistration): Promise<ChatGPTCredentialRecord> {
    const current = this.store.readCredentials(registration.id);
    if (!current || !isSignedIn(current, registration)) {
      throw new ChatGPTAuthError('not_signed_in', 'Sign in with ChatGPT first.');
    }
    assertPlanGrant(current);
    if (!this.needsRefresh(current)) return current;

    const deadline = AbortSignal.timeout(this.deps.lockedNetworkBudgetMs);
    const discovery = await this.discover(undefined, deadline);
    const response = await this.postForm(
      discovery.tokenEndpoint,
      {
        grant_type: 'refresh_token',
        client_id: registration.clientId,
        refresh_token: current.refreshToken!,
        resource: CHATGPT_RESOURCE,
      },
      { retry: 'unsent-or-5xx', deadline },
    );
    if (response.status !== 200) {
      const providerCode = providerErrorCode(response.text);
      const details = { status: response.status, providerCode, requestId: response.requestId };
      if (providerCode && TERMINAL_REFRESH_ERRORS.has(providerCode)) {
        // Keep the registration and the retained ID token (for id_token_hint)
        // but drop the unusable session so the next step is a fresh OAuth.
        const cleared = clearSession(current, this.deps.now());
        this.store.writeCredentials(cleared);
        throw new ChatGPTAuthError(
          'reauth_required',
          'Your ChatGPT session has ended. Sign in with ChatGPT again.',
          details,
        );
      }
      if (providerCode === 'invalid_client') {
        throw new ChatGPTAuthError(
          'invalid_client',
          'The ChatGPT app registration was rejected.',
          details,
        );
      }
      if (response.status >= 500 || response.status === 429) {
        throw new ChatGPTAuthError(
          'temporarily_unavailable',
          'ChatGPT sign-in is temporarily unavailable. Try again shortly.',
          details,
        );
      }
      throw new ChatGPTAuthError(
        'http_error',
        `ChatGPT token refresh failed (HTTP ${response.status}).`,
        details,
      );
    }

    const tokens = parseTokenResponse(response.text, true);
    const next: ChatGPTCredentialRecord = {
      ...current,
      accessToken: tokens.accessToken,
      // Rotation: always persist the replacement before anyone uses the new
      // access token. If a response is lost in transit after the server
      // rotated, no local bookkeeping can recover that refresh token.
      refreshToken: tokens.refreshToken ?? current.refreshToken,
      tokenType: tokens.tokenType ?? current.tokenType,
      expiresAt: this.deps.now() + tokens.expiresIn * 1000,
      scopes: tokens.scopes ?? current.scopes,
      savedAt: this.deps.now(),
    };
    if (tokens.earliestRefreshAt !== undefined) next.earliestRefreshAt = tokens.earliestRefreshAt;
    else delete next.earliestRefreshAt;
    if (tokens.idToken) {
      const verified = await this.verifyIdToken(
        discovery,
        tokens.idToken,
        registration.clientId,
        undefined,
        deadline,
      ).catch(() => undefined);
      if (verified && verified.sub === registration.subject) next.idToken = tokens.idToken;
    }
    this.store.writeCredentials(next);
    return next;
  }

  private async modelsFor(
    profileId?: string,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<ChatGPTModel[]> {
    const token = await this.tokenFor(profileId, sessionId, signal);
    const response = await this.request(
      `${this.deps.apiBaseUrl}/models`,
      { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
      { signal, retry: 'any-or-5xx' },
    );
    if (response.status !== 200) throw httpError('Listing ChatGPT models', response);
    let body: unknown;
    try {
      body = JSON.parse(response.text);
    } catch {
      body = undefined;
    }
    const models = isRecord(body) && Array.isArray(body.models) ? body.models : undefined;
    if (!models) {
      throw new ChatGPTAuthError('http_error', 'ChatGPT returned an unexpected model list.', {
        status: response.status,
        requestId: response.requestId,
      });
    }
    const result: ChatGPTModel[] = [];
    for (const model of models) {
      if (!isRecord(model) || typeof model.slug !== 'string' || !model.slug) continue;
      if (model.visibility !== 'list') continue;
      result.push({
        slug: model.slug,
        display_name:
          typeof model.display_name === 'string' && model.display_name
            ? model.display_name
            : model.slug,
      });
    }
    return result;
  }

  // ---------------------------------------------------------------- sign-out

  async signOut(profileId?: string): Promise<ChatGPTSignOutResult> {
    const index = this.readIndex();
    const id = profileId ?? index.activeProfileId;
    const registration = id ? findComplete(index, id) : undefined;
    if (!registration) {
      if (profileId)
        throw new ChatGPTAuthError('profile_not_found', 'That ChatGPT account is not saved.');
      return { revoked: false, signedIn: false };
    }
    // Order matters:
    //   1. Stop this account's in-flight sign-ins in this process (an Enable
    //      ChatGPT plan or reauthorization still waiting on the browser or the
    //      code exchange), so a late commit cannot undo the sign-out. One from
    //      another process is refused by the commit fence in signIn instead.
    //   2. End the sign-in locally, under the profile lock and before any
    //      network wait: the record is deleted, so every session bound to it
    //      stops being active and no new job can start, even when revocation
    //      hangs or fails.
    //   3. Revoke after the lock is released. The refresh token survives only
    //      in this function's memory for that bounded attempt and is never
    //      usable as a credential; revocation writes nothing, so it cannot
    //      clobber a sign-in that lands meanwhile.
    for (const attempt of this.signIns.get(registration.id) ?? []) attempt.abort();
    const refreshToken = await this.guardStore(() =>
      this.store.withProfileLock(registration.id, () => {
        let record: ChatGPTCredentialRecord | undefined;
        try {
          record = this.store.readCredentials(registration.id);
        } catch {
          record = undefined;
        }
        // Tokens (including the retained ID token) are cleared whether or not
        // revocation is confirmed; the registration and host ID are kept so
        // the next sign-in reuses the same client.
        this.store.deleteCredentials(registration.id);
        this.refreshes.delete(registration.id);
        return record && record.clientId === registration.clientId
          ? record.refreshToken
          : undefined;
      }),
    );
    const result: ChatGPTSignOutResult = { revoked: false, signedIn: Boolean(refreshToken) };
    if (refreshToken) {
      try {
        const deadline = AbortSignal.timeout(this.deps.lockedNetworkBudgetMs);
        const discovery = await this.discover(undefined, deadline);
        await this.revoke(discovery, refreshToken, registration.clientId, deadline);
        result.revoked = true;
      } catch (error) {
        result.revocationError =
          error instanceof ChatGPTAuthError
            ? (error.providerCode ?? error.code)
            : 'revocation_failed';
      }
    }
    return result;
  }

  private async revoke(
    discovery: Discovery,
    refreshToken: string,
    clientId: string,
    deadline?: AbortSignal,
  ): Promise<void> {
    if (!discovery.revocationEndpoint) {
      throw new ChatGPTAuthError(
        'discovery_failed',
        'ChatGPT does not advertise a revocation endpoint.',
      );
    }
    const response = await this.postForm(
      discovery.revocationEndpoint,
      { token: refreshToken, token_type_hint: 'refresh_token', client_id: clientId },
      // Revocation is idempotent, so any network failure may be retried.
      { retry: 'any-or-5xx', deadline },
    );
    if (response.status !== 200) throw httpError('Revoking the ChatGPT session', response);
  }

  // ---------------------------------------------------------------- OIDC

  // The load is shared by every concurrent caller, so it runs under no
  // caller's signal or deadline: a sign-in the user cancels must not fail a
  // refresh waiting on the same discovery. Each caller still stops waiting on
  // its own cancel (`cancelled`) or lock budget (`temporarily_unavailable`);
  // the load itself is bounded by the per-request timeout and retry ladder.
  private discover(signal?: AbortSignal, deadline?: AbortSignal): Promise<Discovery> {
    this.discovery ??= this.loadDiscovery().catch((error) => {
      this.discovery = undefined;
      throw error;
    });
    return untilAborted(this.discovery, signal, deadline);
  }

  private async loadDiscovery(): Promise<Discovery> {
    const response = await this.request(
      `${this.deps.issuer}/.well-known/openid-configuration`,
      { method: 'GET', headers: { Accept: 'application/json' } },
      { retry: 'any-or-5xx' },
    );
    if (response.status !== 200) {
      throw new ChatGPTAuthError(
        'discovery_failed',
        'Could not reach the ChatGPT sign-in service.',
        {
          status: response.status,
          requestId: response.requestId,
        },
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(response.text);
    } catch {
      body = undefined;
    }
    if (!isRecord(body) || trimSlash(String(body.issuer ?? '')) !== this.deps.issuer) {
      throw new ChatGPTAuthError(
        'discovery_failed',
        'The ChatGPT sign-in service returned unexpected metadata.',
      );
    }
    const endpoint = (key: string, required: boolean): string | undefined => {
      const value = body[key];
      if (typeof value === 'string' && isAllowedEndpoint(value)) return value;
      if (required) {
        throw new ChatGPTAuthError(
          'discovery_failed',
          'The ChatGPT sign-in service returned unexpected metadata.',
        );
      }
      return undefined;
    };
    return {
      issuer: this.deps.issuer,
      authorizationEndpoint: endpoint('authorization_endpoint', true)!,
      tokenEndpoint: endpoint('token_endpoint', true)!,
      revocationEndpoint: endpoint('revocation_endpoint', false),
      jwksUri: endpoint('jwks_uri', true)!,
    };
  }

  private async loadJwks(discovery: Discovery, deadline?: AbortSignal) {
    const jose = await importEsm<Jose>('jose');
    const response = await this.request(
      discovery.jwksUri,
      { method: 'GET', headers: { Accept: 'application/json' } },
      { retry: 'any-or-5xx', deadline },
    );
    if (response.status !== 200) {
      throw new ChatGPTAuthError('discovery_failed', 'Could not load ChatGPT signing keys.', {
        status: response.status,
      });
    }
    try {
      return jose.createLocalJWKSet(JSON.parse(response.text));
    } catch {
      throw new ChatGPTAuthError('discovery_failed', 'ChatGPT signing keys are malformed.');
    }
  }

  private async verifyIdToken(
    discovery: Discovery,
    idToken: string,
    clientId: string,
    nonce?: string,
    deadline?: AbortSignal,
  ): Promise<{ sub: string; email?: string }> {
    const jose = await importEsm<Jose>('jose');
    const verifyWith = async (forceReload: boolean) => {
      if (forceReload || !this.jwks) {
        this.jwks = this.loadJwks(discovery, deadline).catch((error) => {
          this.jwks = undefined;
          throw error;
        });
      }
      return jose.jwtVerify(idToken, await this.jwks, {
        issuer: discovery.issuer,
        audience: clientId,
        algorithms: ID_TOKEN_ALGORITHMS,
        requiredClaims: nonce === undefined ? ['exp', 'sub'] : ['exp', 'sub', 'nonce'],
        currentDate: new Date(this.deps.now()),
        clockTolerance: 60,
      });
    };
    let payload: Record<string, unknown>;
    try {
      try {
        ({ payload } = await verifyWith(false));
      } catch (error) {
        // Key rotation: refetch the JWKS once when no published key matched.
        if ((error as { code?: string }).code !== 'ERR_JWKS_NO_MATCHING_KEY') throw error;
        ({ payload } = await verifyWith(true));
      }
    } catch (error) {
      if (error instanceof ChatGPTAuthError) throw error;
      throw new ChatGPTAuthError(
        'invalid_id_token',
        'ChatGPT returned an identity token that failed validation.',
      );
    }
    const invalid = () =>
      new ChatGPTAuthError(
        'invalid_id_token',
        'ChatGPT returned an identity token that failed validation.',
      );
    if (typeof payload.sub !== 'string' || !payload.sub) throw invalid();
    if (nonce !== undefined && payload.nonce !== nonce) throw invalid();
    if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)
      throw invalid();
    const result: { sub: string; email?: string } = { sub: payload.sub };
    if (typeof payload.email === 'string' && payload.email) result.email = payload.email;
    return result;
  }

  private async exchangeCode(
    discovery: Discovery,
    clientId: string,
    code: string,
    verifier: string,
    redirectUri: string,
    signal?: AbortSignal,
  ): Promise<TokenResponse> {
    // Authorization codes are single-use: never retried.
    const response = await this.postForm(
      discovery.tokenEndpoint,
      {
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: CHATGPT_RESOURCE,
      },
      { signal, retry: 'never' },
    );
    if (response.status !== 200) {
      const providerCode = providerErrorCode(response.text);
      const details = { status: response.status, providerCode, requestId: response.requestId };
      if (providerCode === 'invalid_grant') {
        throw new ChatGPTAuthError(
          'invalid_grant',
          'The ChatGPT sign-in code was not accepted. Please sign in again.',
          details,
        );
      }
      throw new ChatGPTAuthError(
        'token_exchange_failed',
        `ChatGPT sign-in failed (HTTP ${response.status}).`,
        details,
      );
    }
    return parseTokenResponse(response.text);
  }

  // ---------------------------------------------------------------- HTTP

  private postForm(
    url: string,
    form: Record<string, string>,
    options: RequestOptions,
  ): Promise<HttpResult> {
    return this.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams(form).toString(),
      },
      options,
    );
  }

  private async request(
    url: string,
    init: RequestInit,
    options: RequestOptions,
  ): Promise<HttpResult> {
    const delays = options.retry === 'never' ? [] : this.deps.retryDelaysMs;
    const { deadline } = options;
    for (let attempt = 0; ; attempt++) {
      throwIfCancelled(options.signal);
      if (deadline?.aborted) throw notInTime();
      const timeout = AbortSignal.timeout(this.deps.requestTimeoutMs);
      const signal = anySignal([timeout, options.signal, deadline]);
      let result: HttpResult | undefined;
      let failure: unknown;
      try {
        const response = await this.deps.fetch(url, { ...init, signal, redirect: 'error' });
        result = {
          status: response.status,
          text: await response.text(),
          requestId: safeCode(response.headers.get('x-request-id') ?? undefined),
        };
      } catch (error) {
        failure = error;
      }
      const retryable = result
        ? result.status >= 500
        : options.retry === 'any-or-5xx' ||
          UNSENT_NETWORK_ERRORS.has(networkErrorCode(failure) ?? '');
      if (attempt < delays.length && retryable && !options.signal?.aborted && !deadline?.aborted) {
        // A deadline during the backoff ends the ladder on the next pass.
        await sleep(delays[attempt], anySignal([options.signal, deadline])).catch(() =>
          throwIfCancelled(options.signal),
        );
        continue;
      }
      if (result) return result;
      throwIfCancelled(options.signal);
      if (timeout.aborted || deadline?.aborted) throw notInTime();
      throw new ChatGPTAuthError('temporarily_unavailable', 'Could not reach the ChatGPT service.');
    }
  }

  // ---------------------------------------------------------------- helpers

  private readIndex(): ChatGPTIndex {
    try {
      return this.store.readIndex();
    } catch (error) {
      throw toStoreError(error);
    }
  }

  private requireRegistration(profileId?: string): ChatGPTRegistration {
    const index = this.readIndex();
    const id = profileId ?? index.activeProfileId;
    const registration = id ? findComplete(index, id) : undefined;
    if (!registration) {
      if (profileId)
        throw new ChatGPTAuthError('profile_not_found', 'That ChatGPT account is not saved.');
      throw new ChatGPTAuthError('not_signed_in', 'Sign in with ChatGPT first.');
    }
    return registration;
  }

  private statusFor(registration: ChatGPTRegistration): ChatGPTStatus {
    const record = this.store.readCredentials(registration.id);
    const connected = Boolean(record && isSignedIn(record, registration));
    const planState = connected ? planStateOf(record!) : undefined;
    const status: ChatGPTStatus = {
      connected,
      planEnabled: planState === 'enabled',
      profileId: registration.id,
    };
    if (registration.email) status.email = registration.email;
    if (planState) status.planState = planState;
    if (connected) status.sessionRevision = sessionRevisionOf(record!.sessionId!);
    return status;
  }

  private async guardStore<T>(action: () => Promise<T> | T): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw toStoreError(error);
    }
  }
}

type RetryPolicy = 'never' | 'unsent-or-5xx' | 'any-or-5xx';

type RequestOptions = {
  // Caller cancellation: surfaces as `cancelled`.
  signal?: AbortSignal;
  retry: RetryPolicy;
  // Shared budget for every attempt and backoff of the calls made while one
  // store lock is held: surfaces as `temporarily_unavailable`.
  deadline?: AbortSignal;
};

function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return present.length <= 1 ? present[0] : AbortSignal.any(present);
}

function notInTime(): ChatGPTAuthError {
  return new ChatGPTAuthError(
    'temporarily_unavailable',
    'The ChatGPT service did not respond in time.',
  );
}

// Wait for a shared promise on this caller's terms: a caller cancel surfaces
// as `cancelled` and a lock deadline as `temporarily_unavailable`, while the
// promise itself keeps running for its other waiters.
function untilAborted<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  deadline?: AbortSignal,
): Promise<T> {
  if (!signal && !deadline) return promise;
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      deadline?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(
        signal?.aborted
          ? new ChatGPTAuthError('cancelled', 'ChatGPT sign-in was cancelled.')
          : notInTime(),
      );
    };
    if (signal?.aborted || deadline?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    deadline?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

let singleton: ChatGPTAuth | undefined;

export function getChatGPTAuth(): ChatGPTAuth {
  singleton ??= new ChatGPTAuth();
  return singleton;
}

// For display or logs only: an authorize URL may carry `id_token_hint`.
export function redactAuthorizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.searchParams.has('id_token_hint')) url.searchParams.set('id_token_hint', '[REDACTED]');
    return url.toString();
  } catch {
    return '[invalid URL]';
  }
}

// ------------------------------------------------------------------ loopback

type Loopback = {
  redirectUri: string;
  wait(signal: AbortSignal | undefined, timeoutMs: number): Promise<CallbackResult>;
  close(): Promise<void>;
};

const PAGE_STYLE =
  'font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5';

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body style="${PAGE_STYLE}"><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
}

async function startLoopback(port: number, expectedState: string): Promise<Loopback> {
  let settle: { resolve: (r: CallbackResult) => void; reject: (e: Error) => void } | undefined;
  let settled: { result?: CallbackResult; error?: Error } | undefined;
  const finish = (outcome: { result?: CallbackResult; error?: Error }) => {
    if (settled) return;
    settled = outcome;
    if (settle) {
      if (outcome.error) settle.reject(outcome.error);
      else settle.resolve(outcome.result!);
    }
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const respond = (status: number, title: string, body: string) => {
      res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(page(title, body));
    };
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
      respond(404, 'Not found', 'This address is only used to finish signing in to Listener.AI.');
      return;
    }
    // State is validated before anything else; a mismatched callback (stale
    // tab or forged request) is answered but does not end the attempt.
    if (settled || url.searchParams.get('state') !== expectedState) {
      respond(400, 'Sign-in link expired', 'Return to Listener.AI and start signing in again.');
      return;
    }
    const error = url.searchParams.get('error');
    if (error) {
      const denied = error === 'access_denied';
      respond(
        200,
        denied ? 'Sign-in cancelled' : 'Sign-in failed',
        'You can close this window and return to Listener.AI.',
      );
      finish({
        error: denied
          ? new ChatGPTAuthError('access_denied', 'ChatGPT sign-in was declined.')
          : new ChatGPTAuthError('callback_error', 'ChatGPT sign-in failed.', {
              providerCode: safeCode(error),
            }),
      });
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      respond(400, 'Sign-in failed', 'You can close this window and return to Listener.AI.');
      finish({
        error: new ChatGPTAuthError(
          'callback_error',
          'ChatGPT sign-in returned no authorization code.',
        ),
      });
      return;
    }
    respond(200, 'Signed in', 'You can close this window and return to Listener.AI.');
    const result: CallbackResult = { code };
    const scope = url.searchParams.get('scope');
    if (scope !== null) result.scope = scope;
    const clientId = url.searchParams.get('client_id');
    if (clientId !== null) result.clientId = clientId;
    finish({ result });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      reject(
        new ChatGPTAuthError(
          'loopback_failed',
          `Could not start the sign-in listener (${networkErrorCode(error) ?? 'error'}).`,
        ),
      );
    };
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  server.on('error', () =>
    finish({
      error: new ChatGPTAuthError('loopback_failed', 'The sign-in listener stopped unexpectedly.'),
    }),
  );
  server.on('close', () =>
    finish({
      error: new ChatGPTAuthError(
        'loopback_failed',
        'The sign-in listener closed before sign-in finished.',
      ),
    }),
  );
  const { port: actualPort } = server.address() as AddressInfo;

  let closed: Promise<void> | undefined;
  return {
    redirectUri: `http://127.0.0.1:${actualPort}${CALLBACK_PATH}`,
    wait(signal, timeoutMs) {
      return new Promise<CallbackResult>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        };
        const onAbort = () =>
          finish({ error: new ChatGPTAuthError('cancelled', 'ChatGPT sign-in was cancelled.') });
        const timer = setTimeout(
          () => finish({ error: new ChatGPTAuthError('timeout', 'ChatGPT sign-in timed out.') }),
          timeoutMs,
        );
        settle = {
          resolve: (r) => {
            cleanup();
            resolve(r);
          },
          reject: (e) => {
            cleanup();
            reject(e);
          },
        };
        if (settled) {
          if (settled.error) settle.reject(settled.error);
          else settle.resolve(settled.result!);
          return;
        }
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
    close() {
      closed ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closed;
    },
  };
}

// ------------------------------------------------------------------ utilities

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeCode(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_CODE.test(value) ? value : undefined;
}

function parseScopes(value: unknown): string[] {
  return typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : [];
}

function isAllowedEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    // Plain HTTP is accepted only for a loopback issuer (local test servers).
    return url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

function findComplete(index: ChatGPTIndex, id: string): ChatGPTRegistration | undefined {
  return index.registrations.find(
    (r) => r.id === id && !r.pending && typeof r.subject === 'string',
  );
}

// A record counts only when it still belongs to this exact registration:
// one registration's tokens are never paired with another's client ID. A
// signed-in record holds a live sign-in session (cleared by sign-out and by a
// terminal refresh error) and a verified ID token; bearer tokens are optional.
function isSignedIn(record: ChatGPTCredentialRecord, registration: ChatGPTRegistration): boolean {
  return (
    record.profileId === registration.id &&
    record.clientId === registration.clientId &&
    record.subject === registration.subject &&
    typeof record.sessionId === 'string' &&
    typeof record.idToken === 'string'
  );
}

// "Account <id prefix>": the shortest prefix (at least 8 characters) of the
// registration id that is unique among the listed ids. Registration ids are
// random UUIDs, so in practice this is always the first 8 characters.
function registrationLabels(ids: string[]): string[] {
  return ids.map((id) => {
    let length = Math.min(8, id.length);
    while (
      length < id.length &&
      ids.some((other) => other !== id && other.startsWith(id.slice(0, length)))
    ) {
      length++;
    }
    return `Account ${id.slice(0, length)}`;
  });
}

function sessionRevisionOf(sessionId: string): string {
  return createHash('sha256').update(`chatgpt-session:${sessionId}`).digest('hex').slice(0, 16);
}

function planStateOf(record: ChatGPTCredentialRecord): ChatGPTPlanState {
  if (!record.scopes.includes(CHATGPT_PLAN_SCOPE)) return 'not_granted';
  const renewable =
    typeof record.accessToken === 'string' &&
    typeof record.refreshToken === 'string' &&
    typeof record.expiresAt === 'number';
  return renewable ? 'enabled' : 'incomplete';
}

function assertPlanGrant(record: ChatGPTCredentialRecord): void {
  const state = planStateOf(record);
  if (state === 'not_granted') {
    throw new ChatGPTAuthError(
      'plan_disabled',
      'ChatGPT plan usage was not granted for this account. Sign in again and allow plan usage.',
    );
  }
  if (state === 'incomplete') {
    throw new ChatGPTAuthError(
      'plan_grant_incomplete',
      'ChatGPT granted plan usage without a renewable session. Enable ChatGPT plan again to continue.',
    );
  }
}

function clearSession(record: ChatGPTCredentialRecord, now: number): ChatGPTCredentialRecord {
  const cleared: ChatGPTCredentialRecord = { ...record, savedAt: now };
  delete cleared.sessionId;
  delete cleared.accessToken;
  delete cleared.refreshToken;
  delete cleared.tokenType;
  delete cleared.expiresAt;
  delete cleared.earliestRefreshAt;
  return cleared;
}

// Code exchange may legitimately return only an ID token (plan declined);
// a refresh response must always carry a new access token.
function parseTokenResponse(text: string, requireAccessToken = false): TokenResponse {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const invalid = () =>
    new ChatGPTAuthError(
      'invalid_token_response',
      'ChatGPT returned an unreadable token response.',
    );
  if (!isRecord(body)) throw invalid();
  const hasAccessToken = typeof body.access_token === 'string' && body.access_token.length > 0;
  if (requireAccessToken && !hasAccessToken) throw invalid();
  const expiresIn =
    typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600;
  const result: TokenResponse = { expiresIn };
  if (hasAccessToken) result.accessToken = body.access_token as string;
  if (typeof body.refresh_token === 'string' && body.refresh_token)
    result.refreshToken = body.refresh_token;
  if (typeof body.id_token === 'string' && body.id_token) result.idToken = body.id_token;
  if (typeof body.token_type === 'string') result.tokenType = body.token_type;
  if (typeof body.scope === 'string') result.scopes = parseScopes(body.scope);
  const earliest = parseInstant(body.earliest_refresh_at);
  if (earliest !== undefined) result.earliestRefreshAt = earliest;
  return result;
}

// `earliest_refresh_at` has no documented unit; accept epoch seconds,
// epoch milliseconds or an ISO timestamp, and ignore anything else.
function parseInstant(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function providerErrorCode(text: string): string | undefined {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(body)) return undefined;
  if (typeof body.error === 'string') return safeCode(body.error);
  if (isRecord(body.error)) return safeCode(body.error.code);
  return undefined;
}

function httpError(action: string, response: HttpResult): ChatGPTAuthError {
  return new ChatGPTAuthError('http_error', `${action} failed (HTTP ${response.status}).`, {
    status: response.status,
    providerCode: providerErrorCode(response.text),
    requestId: response.requestId,
  });
}

function networkErrorCode(error: unknown): string | undefined {
  const candidate = (error as { cause?: { code?: unknown }; code?: unknown } | undefined) ?? {};
  const code = candidate.cause?.code ?? candidate.code;
  return typeof code === 'string' ? safeCode(code) : undefined;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ChatGPTAuthError('cancelled', 'ChatGPT sign-in was cancelled.');
}

function toStoreError(error: unknown): unknown {
  if (error instanceof ChatGPTStoreError) {
    return new ChatGPTAuthError('store_error', `ChatGPT account storage problem: ${error.message}`);
  }
  if ((error as { name?: string })?.name === 'AbortError') {
    return new ChatGPTAuthError('cancelled', 'ChatGPT sign-in was cancelled.');
  }
  return error;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
