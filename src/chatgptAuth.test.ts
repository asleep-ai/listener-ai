import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as path from 'path';
import { importEsm } from './esmImport';
import { makeTempDir, rmDir } from './test-helpers';
import {
  ChatGPTAuth,
  ChatGPTAuthError,
  type ChatGPTAuthDependencies,
  CHATGPT_LOCK_WAIT_MS,
  CHATGPT_LOCKED_NETWORK_BUDGET_MS,
  CHATGPT_SCOPES,
  isExpectedSignInOutcome,
  redactAuthorizeUrl,
} from './chatgptAuth';
import { ChatGPTBinding, ChatGPTBindingError } from './chatgptBinding';
import { ChatGPTCredentialStore } from './chatgptCredentialStore';
import { buildChatGPTModel, ChatGPTInferenceError } from './chatgptResponses';
import { complete, extractFinalText } from './piAiClient';

type Jose = typeof import('jose');

const FULL_SCOPE = CHATGPT_SCOPES.join(' ');
const IDENTITY_SCOPE = 'openid profile email offline_access resource.invoke';

type Account = { sub: string; email: string };
type AuthorizeOptions = {
  scope?: string;
  // undefined: issue/echo normally; null: omit client_id from the callback;
  // string: put this value in the callback instead.
  callbackClientId?: string | null;
  error?: string;
  state?: string;
};

type RecordedRequest = { method: string; path: string; form?: URLSearchParams; auth?: string };

// A local stand-in for auth.openai.com + api.openai.com. It implements just the
// documented SIWC contract surface: discovery, JWKS, authorization_code and
// refresh_token grants with rotation, revocation, and GET /v1/models.
class FakeOpenAI {
  jose!: Jose;
  base = '';
  requests: RecordedRequest[] = [];
  private server!: http.Server;
  private key!: CryptoKey;
  private kid = 'test-key';
  private jwks: unknown;
  private issued = 0;
  private codes = new Map<
    string,
    {
      clientId: string;
      nonce: string;
      redirectUri: string;
      challenge: string;
      account: Account;
      scope: string;
    }
  >();
  private refreshTokens = new Map<
    string,
    { clientId: string; account: Account; scope: string; used: boolean }
  >();
  accessTokens = new Map<string, { clientId: string; account: Account }>();
  // Knobs for individual tests.
  refreshDelayMs = 0;
  refreshFailure?: { status: number; body: unknown };
  revokeStatuses: number[] = [];
  exchangeFailure?: { status: number; body: unknown };
  idTokenClaims?: (claims: Record<string, unknown>) => Record<string, unknown>;
  signWithKey?: CryptoKey;
  expiresIn = 3600;
  modelsStatus?: { status: number; body: unknown };
  // Token-response fields the authorization_code grant leaves out.
  exchangeOmit: string[] = [];

  async start(): Promise<void> {
    this.jose = await importEsm<Jose>('jose');
    const pair = await this.jose.generateKeyPair('RS256', { extractable: true });
    this.key = pair.privateKey;
    const jwk = await this.jose.exportJWK(pair.publicKey);
    this.jwks = { keys: [{ ...jwk, kid: this.kid, alg: 'RS256', use: 'sig' }] };
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  reset(): void {
    this.requests = [];
    this.refreshDelayMs = 0;
    this.refreshFailure = undefined;
    this.revokeStatuses = [];
    this.exchangeFailure = undefined;
    this.idTokenClaims = undefined;
    this.signWithKey = undefined;
    this.expiresIn = 3600;
    this.modelsStatus = undefined;
    this.issued = 0;
    this.exchangeOmit = [];
  }

  deps(extra: Partial<ChatGPTAuthDependencies> = {}): ChatGPTAuthDependencies {
    return {
      issuer: this.base,
      apiBaseUrl: `${this.base}/v1`,
      retryDelaysMs: [5, 5],
      lockRetryMs: 20,
      ...extra,
    };
  }

  grants(type: string): RecordedRequest[] {
    return this.requests.filter(
      (r) => r.path === '/api/accounts/oauth/token' && r.form?.get('grant_type') === type,
    );
  }

  // Simulates the user approving in the browser and returns the loopback URL.
  authorize(url: URL, account: Account, options: AuthorizeOptions = {}): string {
    const params = url.searchParams;
    const requested = params.get('client_id')!;
    const redirectUri = params.get('redirect_uri')!;
    const callback = new URL(redirectUri);
    callback.searchParams.set('state', options.state ?? params.get('state')!);
    if (options.error) {
      callback.searchParams.set('error', options.error);
      return callback.toString();
    }
    const clientId =
      requested === 'dynamic_agent_client' ? `oaiapp_test${++this.issued}` : requested;
    const scope = options.scope ?? FULL_SCOPE;
    const code = `code_${randomBytes(8).toString('hex')}`;
    this.codes.set(code, {
      clientId,
      nonce: params.get('nonce')!,
      redirectUri,
      challenge: params.get('code_challenge')!,
      account,
      scope,
    });
    callback.searchParams.set('code', code);
    callback.searchParams.set('scope', scope);
    if (options.callbackClientId === undefined) {
      if (requested === 'dynamic_agent_client') callback.searchParams.set('client_id', clientId);
    } else if (options.callbackClientId !== null) {
      callback.searchParams.set('client_id', options.callbackClientId);
    }
    return callback.toString();
  }

  private async signIdToken(clientId: string, account: Account, nonce?: string): Promise<string> {
    let claims: Record<string, unknown> = {
      iss: this.base,
      aud: clientId,
      sub: account.sub,
      email: account.email,
      ...(nonce ? { nonce } : {}),
    };
    if (this.idTokenClaims) claims = this.idTokenClaims(claims);
    const jwt = new this.jose.SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: this.kid })
      .setIssuedAt();
    if (claims.exp === undefined) jwt.setExpirationTime('1h');
    return jwt.sign(this.signWithKey ?? this.key);
  }

  private async issueTokens(clientId: string, account: Account, scope: string, nonce?: string) {
    const access = `at_${randomBytes(12).toString('hex')}`;
    const refresh = `rt_${randomBytes(12).toString('hex')}`;
    this.accessTokens.set(access, { clientId, account });
    this.refreshTokens.set(refresh, { clientId, account, scope, used: false });
    return {
      access_token: access,
      refresh_token: refresh,
      id_token: await this.signIdToken(clientId, account, nonce),
      token_type: 'Bearer',
      expires_in: this.expiresIn,
      scope,
    };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.base);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const recorded: RecordedRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      auth: req.headers.authorization,
    };
    if (req.headers['content-type']?.includes('application/x-www-form-urlencoded')) {
      recorded.form = new URLSearchParams(body);
    }
    this.requests.push(recorded);
    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': 'req_test_1' });
      res.end(payload === undefined ? '' : JSON.stringify(payload));
    };

    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: this.base,
        authorization_endpoint: `${this.base}/api/accounts/authorize`,
        token_endpoint: `${this.base}/api/accounts/oauth/token`,
        revocation_endpoint: `${this.base}/api/accounts/oauth/revoke`,
        jwks_uri: `${this.base}/.well-known/jwks.json`,
      });
    }
    if (url.pathname === '/.well-known/jwks.json') return json(200, this.jwks);
    if (url.pathname === '/api/accounts/oauth/token') {
      const form = recorded.form!;
      if (form.get('grant_type') === 'authorization_code') {
        if (this.exchangeFailure)
          return json(this.exchangeFailure.status, this.exchangeFailure.body);
        const entry = this.codes.get(form.get('code') ?? '');
        this.codes.delete(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        if (
          !entry ||
          entry.clientId !== form.get('client_id') ||
          entry.redirectUri !== form.get('redirect_uri') ||
          entry.challenge !== challenge ||
          form.get('resource') !== 'https://api.openai.com/v1'
        ) {
          return json(400, { error: 'invalid_grant' });
        }
        const issued: Record<string, unknown> = await this.issueTokens(
          entry.clientId,
          entry.account,
          entry.scope,
          entry.nonce,
        );
        for (const key of this.exchangeOmit) delete issued[key];
        return json(200, issued);
      }
      if (form.get('grant_type') === 'refresh_token') {
        if (this.refreshDelayMs) await new Promise((r) => setTimeout(r, this.refreshDelayMs));
        if (this.refreshFailure) return json(this.refreshFailure.status, this.refreshFailure.body);
        const entry = this.refreshTokens.get(form.get('refresh_token') ?? '');
        if (!entry || entry.clientId !== form.get('client_id'))
          return json(400, { error: 'invalid_grant' });
        if (entry.used) return json(400, { error: 'refresh_token_reused' });
        entry.used = true;
        return json(200, await this.issueTokens(entry.clientId, entry.account, entry.scope));
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (url.pathname === '/api/accounts/oauth/revoke') {
      const status = this.revokeStatuses.shift() ?? 200;
      if (status === 200) this.refreshTokens.delete(recorded.form?.get('token') ?? '');
      res.writeHead(status);
      return void res.end();
    }
    if (url.pathname === '/v1/models') {
      if (this.modelsStatus) return json(this.modelsStatus.status, this.modelsStatus.body);
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const owner = this.accessTokens.get(token);
      if (!owner) return json(401, { detail: `bad token ${token}` });
      return json(200, {
        models: [
          {
            slug: `gpt-${owner.account.sub}`,
            display_name: `For ${owner.account.sub}`,
            visibility: 'list',
          },
          { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hide' },
          { slug: 'gpt-shared', display_name: 'Shared', visibility: 'list' },
        ],
      });
    }
    json(404, { error: 'not_found' });
  }
}

const ALICE: Account = { sub: 'user-alice', email: 'alice@example.com' };
const BOB: Account = { sub: 'user-bob', email: 'bob@example.com' };

async function browser(fake: FakeOpenAI, account: Account, options: AuthorizeOptions = {}) {
  const seen: URL[] = [];
  const openBrowser = async (raw: string) => {
    const url = new URL(raw);
    seen.push(url);
    const response = await fetch(fake.authorize(url, account, options));
    await response.text();
  };
  return { openBrowser, seen };
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function storeFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

function credentialFile(dataDir: string, profileId: string): string {
  return path.join(dataDir, 'chatgpt', 'credentials', `${profileId}.json`);
}

function expireAccessToken(dataDir: string, profileId: string): void {
  const file = credentialFile(dataDir, profileId);
  const record = readJson(file);
  record.expiresAt = Date.now() - 1000;
  delete record.earliestRefreshAt;
  fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
}

// Holds every request to `hookPath` until `release()`; `reached` resolves when
// the first one arrives. The request itself is sent only after release.
function gatedFetch(hookPath: string) {
  let release!: () => void;
  let markReached!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const reached = new Promise<void>((resolve) => (markReached = resolve));
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(String(input)).pathname === hookPath) {
      markReached();
      await gate;
    }
    return fetch(input, init);
  }) as typeof fetch;
  return { fetchImpl, release, reached };
}

async function assertAuthError(promise: Promise<unknown>, code: string): Promise<ChatGPTAuthError> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof ChatGPTAuthError))
      assert.fail(`expected ChatGPTAuthError, got ${String(error)}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return error;
  }
  assert.fail(`expected ChatGPTAuthError(${code})`);
}

// Revocation after a failed sign-in is best effort and not awaited, so wait
// for the expected count (or briefly, when none is expected).
async function settledRevokes(fake: FakeOpenAI, expected: number) {
  const revokes = () => fake.requests.filter((r) => r.path === '/api/accounts/oauth/revoke');
  for (let i = 0; i < 50 && revokes().length < Math.max(expected, 1); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return revokes();
}

describe('ChatGPTAuth (Sign in with ChatGPT)', () => {
  const fake = new FakeOpenAI();
  let dataDir: string;

  before(async () => {
    await fake.start();
  });
  after(async () => {
    await fake.stop();
  });
  beforeEach(() => {
    fake.reset();
    dataDir = makeTempDir('chatgpt-auth');
  });
  afterEach(() => {
    rmDir(dataDir);
  });

  describe('first registration', () => {
    it('sends the documented authorize request and stores an active, plan-enabled profile', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      const { openBrowser, seen } = await browser(fake, ALICE);
      const progress: string[] = [];
      const status = await auth.signIn({ openBrowser, onProgress: (m) => progress.push(m) });

      assert.equal(status.connected, true);
      assert.equal(status.planEnabled, true);
      assert.equal(status.email, ALICE.email);
      assert.ok(status.profileId);

      const url = seen[0];
      assert.equal(url.origin + url.pathname, `${fake.base}/api/accounts/authorize`);
      const p = url.searchParams;
      assert.equal(p.get('client_id'), 'dynamic_agent_client');
      assert.equal(p.get('agent_name_hint'), 'Listener.AI');
      assert.match(
        p.get('ext_agent_host_id')!,
        /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      assert.equal(p.get('response_type'), 'code');
      assert.equal(p.get('scope'), FULL_SCOPE);
      assert.equal(p.get('resource'), 'https://api.openai.com/v1');
      assert.equal(p.get('code_challenge_method'), 'S256');
      assert.match(p.get('redirect_uri')!, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
      assert.ok((p.get('state') ?? '').length >= 32);
      assert.ok((p.get('nonce') ?? '').length >= 32);
      assert.equal(p.get('id_token_hint'), null);

      // The exchange used the issued client ID, the same redirect URI and the
      // verifier matching the challenge.
      const [exchange] = fake.grants('authorization_code');
      assert.equal(exchange.form!.get('client_id'), 'oaiapp_test1');
      assert.equal(exchange.form!.get('redirect_uri'), p.get('redirect_uri'));
      assert.equal(
        createHash('sha256').update(exchange.form!.get('code_verifier')!).digest('base64url'),
        p.get('code_challenge'),
      );
      assert.equal(exchange.form!.get('client_secret'), null);

      // Separate 0600 credential record; the index never holds tokens.
      const root = path.join(dataDir, 'chatgpt');
      const cred = readJson(credentialFile(dataDir, status.profileId!));
      assert.equal(cred.clientId, 'oaiapp_test1');
      assert.equal(cred.subject, ALICE.sub);
      assert.equal(cred.extAgentHostId, p.get('ext_agent_host_id'));
      for (const file of storeFiles(root).filter((f) => f.endsWith('.json'))) {
        if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600, file);
      }
      const index = fs.readFileSync(path.join(root, 'profiles.json'), 'utf8');
      assert.ok(!index.includes(cred.accessToken) && !index.includes(cred.refreshToken));
      assert.equal(
        readJson(path.join(root, 'host.json')).extAgentHostId,
        p.get('ext_agent_host_id'),
      );
      assert.ok(progress.length > 0);
    });

    it('uses fresh state, nonce and PKCE values per attempt and a stable host id', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      const first = await browser(fake, ALICE);
      await auth.signIn({ openBrowser: first.openBrowser });
      const second = await browser(fake, BOB);
      await auth.signIn({ openBrowser: second.openBrowser, newProfile: true });
      const a = first.seen[0].searchParams;
      const b = second.seen[0].searchParams;
      for (const key of ['state', 'nonce', 'code_challenge'])
        assert.notEqual(a.get(key), b.get(key), key);
      assert.equal(a.get('ext_agent_host_id'), b.get('ext_agent_host_id'));
      // Another instance (e.g. the CLI) sees the same host id.
      const other = new ChatGPTAuth(dataDir, fake.deps());
      const third = await browser(fake, ALICE);
      await other.signIn({ openBrowser: third.openBrowser, newProfile: true });
      assert.equal(third.seen[0].searchParams.get('ext_agent_host_id'), a.get('ext_agent_host_id'));
    });

    it('rejects a callback without the issued client id and makes nothing active', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      const { openBrowser } = await browser(fake, ALICE, { callbackClientId: null });
      await assertAuthError(auth.signIn({ openBrowser }), 'registration_incomplete');
      assert.equal(fake.grants('authorization_code').length, 0);
      assert.deepEqual(await auth.getStatus(), { connected: false, planEnabled: false });
      assert.deepEqual(await auth.listProfiles(), []);
    });

    it('persists the issued client id as a pending registration before the exchange and reuses it', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      fake.exchangeFailure = { status: 400, body: { error: 'invalid_grant' } };
      const first = await browser(fake, ALICE);
      await assertAuthError(auth.signIn({ openBrowser: first.openBrowser }), 'invalid_grant');
      const index = readJson(path.join(dataDir, 'chatgpt', 'profiles.json'));
      assert.equal(index.activeProfileId, undefined);
      assert.equal(index.registrations.length, 1);
      assert.equal(index.registrations[0].clientId, 'oaiapp_test1');
      assert.equal(index.registrations[0].pending, true);
      assert.deepEqual(await auth.listProfiles(), []);

      fake.exchangeFailure = undefined;
      const second = await browser(fake, ALICE);
      const status = await auth.signIn({ openBrowser: second.openBrowser, newProfile: true });
      const p = second.seen[0].searchParams;
      assert.equal(p.get('client_id'), 'oaiapp_test1');
      assert.equal(p.get('agent_name_hint'), null);
      assert.equal(status.connected, true);
      assert.equal(status.profileId, index.registrations[0].id);
    });
    // Two processes (app and CLI) retry the same pending registration. The
    // first to commit wins; the later commit must neither replace its account
    // nor revoke its grant.
    for (const loser of [BOB, ALICE]) {
      it(`keeps the first completion of a pending registration when a concurrent ${loser === BOB ? 'different-account' : 'same-account'} sign-in commits later`, async () => {
        fake.exchangeFailure = { status: 400, body: { error: 'invalid_grant' } };
        await assertAuthError(
          new ChatGPTAuth(dataDir, fake.deps()).signIn({
            openBrowser: (await browser(fake, ALICE)).openBrowser,
          }),
          'invalid_grant',
        );
        fake.exchangeFailure = undefined;
        const pendingId = readJson(path.join(dataDir, 'chatgpt', 'profiles.json')).registrations[0]
          .id;

        // The later process reaches its code exchange first and is held there.
        const gated = gatedFetch('/api/accounts/oauth/token');
        const late = new ChatGPTAuth(dataDir, fake.deps({ fetch: gated.fetchImpl }));
        const lateBrowser = await browser(fake, loser);
        const losing = late.signIn({ openBrowser: lateBrowser.openBrowser });
        await gated.reached;

        const first = new ChatGPTAuth(dataDir, fake.deps());
        const winner = await first.signIn({
          openBrowser: (await browser(fake, ALICE)).openBrowser,
        });
        assert.equal(winner.profileId, pendingId);
        const winnerRecord = fs.readFileSync(credentialFile(dataDir, pendingId), 'utf8');
        const winnerIndex = fs.readFileSync(path.join(dataDir, 'chatgpt', 'profiles.json'), 'utf8');

        gated.release();
        const error = await assertAuthError(losing, 'session_ended');
        assert.equal(isExpectedSignInOutcome(error), true);
        assert.equal(lateBrowser.seen[0].searchParams.get('client_id'), 'oaiapp_test1');

        assert.equal(fs.readFileSync(credentialFile(dataDir, pendingId), 'utf8'), winnerRecord);
        assert.equal(
          fs.readFileSync(path.join(dataDir, 'chatgpt', 'profiles.json'), 'utf8'),
          winnerIndex,
        );
        const status = await first.getStatus();
        assert.equal(status.email, ALICE.email);
        assert.equal(status.connected, true);

        // A different account's stray grant is revoked; a same-account one is
        // left alone so the revocation cannot reach the winner's grant.
        const winnerRefresh = JSON.parse(winnerRecord).refreshToken;
        const revokes = await settledRevokes(fake, loser === BOB ? 1 : 0);
        assert.equal(revokes.length, loser === BOB ? 1 : 0);
        assert.ok(revokes.every((r) => r.form!.get('token') !== winnerRefresh));

        // The winner's grant still refreshes.
        expireAccessToken(dataDir, pendingId);
        const models = await first.listModels();
        assert.ok(models.some((m) => m.slug === `gpt-${ALICE.sub}`));
        assert.equal(fake.grants('refresh_token').length, 1);
      });
    }

    it('discards a pending registration whose client is rejected at the code exchange and registers anew', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      fake.exchangeFailure = { status: 401, body: { error: 'invalid_client' } };
      const first = await browser(fake, ALICE);
      const error = await assertAuthError(
        auth.signIn({ openBrowser: first.openBrowser }),
        'token_exchange_failed',
      );
      assert.equal(error.providerCode, 'invalid_client');
      const index = readJson(path.join(dataDir, 'chatgpt', 'profiles.json'));
      assert.deepEqual(index.registrations, []);

      fake.exchangeFailure = undefined;
      const second = await browser(fake, ALICE);
      const status = await auth.signIn({ openBrowser: second.openBrowser });
      const p = second.seen[0].searchParams;
      assert.equal(p.get('client_id'), 'dynamic_agent_client');
      assert.equal(p.get('agent_name_hint'), 'Listener.AI');
      assert.equal(status.connected, true);
      const after = readJson(path.join(dataDir, 'chatgpt', 'profiles.json'));
      assert.deepEqual(
        after.registrations.map((r: { clientId: string }) => r.clientId),
        ['oaiapp_test2'],
      );
    });

    it('discards a reused pending registration that the authorize step rejects, so Add account registers anew', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      const alice = await auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser });
      // A transient exchange failure leaves the issued client pending for reuse.
      fake.exchangeFailure = { status: 400, body: { error: 'invalid_grant' } };
      await assertAuthError(
        auth.signIn({ openBrowser: (await browser(fake, BOB)).openBrowser, newProfile: true }),
        'invalid_grant',
      );
      fake.exchangeFailure = undefined;
      const rejected = await browser(fake, BOB, { error: 'invalid_client' });
      const error = await assertAuthError(
        auth.signIn({ openBrowser: rejected.openBrowser, newProfile: true }),
        'callback_error',
      );
      assert.equal(rejected.seen[0].searchParams.get('client_id'), 'oaiapp_test2');
      assert.equal(error.providerCode, 'invalid_client');
      const index = readJson(path.join(dataDir, 'chatgpt', 'profiles.json'));
      assert.deepEqual(
        index.registrations.map((r: { clientId: string }) => r.clientId),
        ['oaiapp_test1'],
      );

      const retry = await browser(fake, BOB);
      const bob = await auth.signIn({ openBrowser: retry.openBrowser, newProfile: true });
      assert.equal(retry.seen[0].searchParams.get('client_id'), 'dynamic_agent_client');
      assert.equal(bob.email, BOB.email);
      assert.notEqual(bob.profileId, alice.profileId);
      assert.equal((await auth.listProfiles()).length, 2);
    });

    it('keeps a completed registration when its reauthorization exchange reports invalid_client', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      const alice = await auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser });
      fake.exchangeFailure = { status: 401, body: { error: 'invalid_client' } };
      await assertAuthError(
        auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser }),
        'token_exchange_failed',
      );
      const status = await auth.getStatus();
      assert.equal(status.connected, true);
      assert.equal(status.profileId, alice.profileId);
      assert.equal((await auth.listProfiles()).length, 1);
    });
  });

  describe('callback validation', () => {
    it('ignores a callback with a wrong state and completes on the matching one', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      let forgedStatus = 0;
      const openBrowser = async (raw: string) => {
        const url = new URL(raw);
        const forged = await fetch(fake.authorize(url, BOB, { state: 'attacker-state' }));
        forgedStatus = forged.status;
        await forged.text();
        const real = await fetch(fake.authorize(url, ALICE));
        await real.text();
      };
      const status = await auth.signIn({ openBrowser });
      assert.equal(forgedStatus, 400);
      assert.equal(status.email, ALICE.email);
      // Only the code from the matching callback was exchanged.
      assert.equal(fake.grants('authorization_code').length, 1);
    });

    it('stops on access_denied without exchanging a code', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      const { openBrowser } = await browser(fake, ALICE, { error: 'access_denied' });
      const error = await assertAuthError(auth.signIn({ openBrowser }), 'access_denied');
      assert.equal(fake.grants('authorization_code').length, 0);
      // Declining consent is the user's choice, not an app failure to report.
      assert.equal(isExpectedSignInOutcome(error), true);
    });

    it('rejects an ID token whose nonce does not match', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      fake.idTokenClaims = (c) => ({ ...c, nonce: 'other-nonce' });
      const { openBrowser } = await browser(fake, ALICE);
      await assertAuthError(auth.signIn({ openBrowser }), 'invalid_id_token');
      assert.deepEqual(await auth.listProfiles(), []);
      assert.ok(
        !fs.existsSync(path.join(dataDir, 'chatgpt', 'credentials')) ||
          fs.readdirSync(path.join(dataDir, 'chatgpt', 'credentials')).length === 0,
      );
      // Nothing was saved, so the brand-new grant is revoked best effort.
      const revokes = await settledRevokes(fake, 1);
      assert.equal(revokes.length, 1);
      assert.equal(revokes[0].form!.get('client_id'), 'oaiapp_test1');
    });

    it('never revokes a reauthorization grant whose ID token fails verification', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      const alice = await auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser });
      const before = fs.readFileSync(credentialFile(dataDir, alice.profileId!), 'utf8');
      fake.idTokenClaims = (c) => ({ ...c, nonce: 'other-nonce' });
      await assertAuthError(
        auth.signIn({
          openBrowser: (await browser(fake, ALICE)).openBrowser,
          profileId: alice.profileId,
        }),
        'invalid_id_token',
      );
      assert.equal(fs.readFileSync(credentialFile(dataDir, alice.profileId!), 'utf8'), before);
      assert.equal((await settledRevokes(fake, 0)).length, 0);
      assert.ok(await auth.getAccessToken(), 'the earlier grant still works');
    });

    for (const [name, mutate] of [
      ['audience', (c: Record<string, unknown>) => ({ ...c, aud: 'oaiapp_someone_else' })],
      ['issuer', (c: Record<string, unknown>) => ({ ...c, iss: 'https://evil.example' })],
      [
        'expiry',
        (c: Record<string, unknown>) => ({ ...c, exp: Math.floor(Date.now() / 1000) - 3600 }),
      ],
      ['subject', (c: Record<string, unknown>) => ({ ...c, sub: undefined })],
    ] as const) {
      it(`rejects an ID token with a bad ${name}`, async () => {
        const auth = new ChatGPTAuth(dataDir, fake.deps());
        fake.idTokenClaims = mutate;
        const { openBrowser } = await browser(fake, ALICE);
        await assertAuthError(auth.signIn({ openBrowser }), 'invalid_id_token');
        assert.equal((await auth.getStatus()).connected, false);
      });
    }

    it('rejects an ID token signed by a key outside the JWKS', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      fake.signWithKey = (await fake.jose.generateKeyPair('RS256')).privateKey;
      const { openBrowser } = await browser(fake, ALICE);
      const error = await assertAuthError(auth.signIn({ openBrowser }), 'invalid_id_token');
      // A validation failure is a real failure and stays reportable.
      assert.equal(isExpectedSignInOutcome(error), false);
    });

    it('cancels promptly while the signing keys are still loading, and a later sign-in still completes', async () => {
      // A fresh instance with no cached JWKS: the keys request stalls.
      const gated = gatedFetch('/.well-known/jwks.json');
      const auth = new ChatGPTAuth(dataDir, fake.deps({ fetch: gated.fetchImpl }));
      const controller = new AbortController();
      const signIn = auth.signIn({
        signal: controller.signal,
        openBrowser: (await browser(fake, ALICE)).openBrowser,
      });
      await gated.reached;
      controller.abort();
      const outcome = await Promise.race([
        assertAuthError(signIn, 'cancelled').then(() => 'cancelled'),
        new Promise((resolve) => setTimeout(() => resolve('still waiting'), 1000)),
      ]);
      gated.release();
      assert.equal(outcome, 'cancelled');
      await signIn.catch(() => {});
      assert.equal((await auth.getStatus()).connected, false);

      // The shared key load was not failed by the cancel.
      const status = await auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser });
      assert.equal(status.connected, true);
      assert.equal(fake.requests.filter((r) => r.path === '/.well-known/jwks.json').length, 1);
    });

    it('cancels while waiting for the browser and closes the loopback server', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      const controller = new AbortController();
      let redirect = '';
      const pending = auth.signIn({
        signal: controller.signal,
        openBrowser: (raw) => {
          redirect = new URL(raw).searchParams.get('redirect_uri')!;
          setTimeout(() => controller.abort(), 10);
        },
      });
      assert.equal(isExpectedSignInOutcome(await assertAuthError(pending, 'cancelled')), true);
      await assert.rejects(fetch(`${redirect}?state=x&code=y`));
      assert.equal(fake.grants('authorization_code').length, 0);
    });

    it('fails when the callback never arrives before the timeout', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps({ callbackTimeoutMs: 50 }));
      let redirect = '';
      const error = await assertAuthError(
        auth.signIn({
          openBrowser: (raw) => void (redirect = new URL(raw).searchParams.get('redirect_uri')!),
        }),
        'timeout',
      );
      assert.equal(isExpectedSignInOutcome(error), true);
      await assert.rejects(fetch(`${redirect}?state=x&code=y`));
    });

    it('closes the loopback server when opening the browser fails', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      let redirect = '';
      await assert.rejects(
        auth.signIn({
          openBrowser: (raw) => {
            redirect = new URL(raw).searchParams.get('redirect_uri')!;
            throw new Error('no browser');
          },
        }),
        /no browser/,
      );
      await assert.rejects(fetch(`${redirect}?state=x&code=y`));
    });
  });

  describe('reauthorization and switching', () => {
    it('reuses the issued client id, omits agent_name_hint and sends the retained id_token_hint', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      const first = await browser(fake, ALICE);
      const status = await auth.signIn({ openBrowser: first.openBrowser });
      const before = readJson(credentialFile(dataDir, status.profileId!));

      const again = await browser(fake, ALICE);
      const reauth = await auth.signIn({
        openBrowser: again.openBrowser,
        profileId: status.profileId,
      });
      const p = again.seen[0].searchParams;
      assert.equal(p.get('client_id'), 'oaiapp_test1');
      assert.equal(p.get('agent_name_hint'), null);
      assert.equal(p.get('id_token_hint'), before.idToken);
      assert.equal(p.get('login_hint'), ALICE.email);
      assert.equal(reauth.profileId, status.profileId);
      const after = readJson(credentialFile(dataDir, status.profileId!));
      assert.notEqual(after.refreshToken, before.refreshToken);
      assert.equal((await auth.listProfiles()).length, 1);
    });

    for (const [stage, hookPath] of [
      ['the token response', '/api/accounts/oauth/token'],
      ['ID-token key validation', '/.well-known/jwks.json'],
    ] as const) {
      // A fresh instance has no cached JWKS, so both hooks fire on the
      // cancelled attempt. The abort lands after the request was answered.
      const cancellingDeps = (controller: AbortController) =>
        fake.deps({
          fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
            const response = await fetch(input, init);
            if (new URL(String(input)).pathname !== hookPath) return response;
            const body = await response.text();
            controller.abort();
            return new Response(body, { status: response.status, headers: response.headers });
          }) as typeof fetch,
        });

      it(`commits nothing when a new account sign-in is cancelled during ${stage}`, async () => {
        const auth = new ChatGPTAuth(dataDir, fake.deps());
        const alice = await auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser });
        const aliceBefore = fs.readFileSync(credentialFile(dataDir, alice.profileId!), 'utf8');
        const controller = new AbortController();
        const cancelling = new ChatGPTAuth(dataDir, cancellingDeps(controller));
        await assertAuthError(
          cancelling.signIn({
            openBrowser: (await browser(fake, BOB)).openBrowser,
            newProfile: true,
            signal: controller.signal,
          }),
          'cancelled',
        );
        const status = await auth.getStatus();
        assert.equal(status.profileId, alice.profileId, 'the active profile is unchanged');
        assert.equal(status.connected, true);
        assert.equal(
          fs.readFileSync(credentialFile(dataDir, alice.profileId!), 'utf8'),
          aliceBefore,
        );
        const files = storeFiles(path.join(dataDir, 'chatgpt', 'credentials'));
        assert.deepEqual(
          files,
          [credentialFile(dataDir, alice.profileId!)],
          'no new credential record',
        );
        assert.equal((await auth.listProfiles()).filter((p) => p.connected).length, 1);
        // The brand-new grant is revoked best effort.
        for (
          let i = 0;
          i < 50 && !fake.requests.some((r) => r.path === '/api/accounts/oauth/revoke');
          i++
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(
          fake.requests.filter((r) => r.path === '/api/accounts/oauth/revoke').length,
          1,
        );
      });

      it(`keeps the previous credentials when a reauthorization is cancelled during ${stage}`, async () => {
        const auth = new ChatGPTAuth(dataDir, fake.deps());
        const alice = await auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser });
        const before = fs.readFileSync(credentialFile(dataDir, alice.profileId!), 'utf8');
        const revision = auth.getStatusSync().sessionRevision;
        const controller = new AbortController();
        const cancelling = new ChatGPTAuth(dataDir, cancellingDeps(controller));
        await assertAuthError(
          cancelling.signIn({
            openBrowser: (await browser(fake, ALICE)).openBrowser,
            profileId: alice.profileId,
            signal: controller.signal,
          }),
          'cancelled',
        );
        assert.equal(fs.readFileSync(credentialFile(dataDir, alice.profileId!), 'utf8'), before);
        assert.equal(auth.getStatusSync().sessionRevision, revision);
        assert.ok(await auth.getAccessToken(), 'the earlier grant still works');
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(
          fake.requests.filter((r) => r.path === '/api/accounts/oauth/revoke').length,
          0,
          'a reauthorization grant is never revoked on cancel',
        );
      });
    }

    it('rejects a reauthorization callback carrying a different client id', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      const first = await browser(fake, ALICE);
      const status = await auth.signIn({ openBrowser: first.openBrowser });
      const again = await browser(fake, ALICE, { callbackClientId: 'oaiapp_other' });
      await assertAuthError(
        auth.signIn({ openBrowser: again.openBrowser, profileId: status.profileId }),
        'client_mismatch',
      );
      assert.equal(fake.grants('authorization_code').length, 1);
    });

    it('rejects a reauthorization that returns a different account and keeps the old credentials', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      const first = await browser(fake, ALICE);
      const status = await auth.signIn({ openBrowser: first.openBrowser });
      const before = fs.readFileSync(credentialFile(dataDir, status.profileId!), 'utf8');
      const again = await browser(fake, BOB);
      const mismatch = await assertAuthError(
        auth.signIn({ openBrowser: again.openBrowser, profileId: status.profileId }),
        'account_mismatch',
      );
      assert.equal(isExpectedSignInOutcome(mismatch), true);
      assert.equal(fs.readFileSync(credentialFile(dataDir, status.profileId!), 'utf8'), before);
      // The stray grant for the wrong account is revoked best-effort.
      assert.equal(fake.requests.filter((r) => r.path === '/api/accounts/oauth/revoke').length, 1);
      assert.equal((await auth.getStatus()).email, ALICE.email);
    });

    it('keeps accounts isolated and switches the active profile only after validation', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      const a = await auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser });
      const b = await auth.signIn({
        openBrowser: (await browser(fake, BOB)).openBrowser,
        newProfile: true,
      });
      assert.notEqual(a.profileId, b.profileId);
      assert.equal((await auth.getStatus()).profileId, b.profileId);

      // A failed sign-in for a third account does not change the active one.
      fake.idTokenClaims = (c) => ({ ...c, nonce: 'wrong' });
      await assertAuthError(
        auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser, newProfile: true }),
        'invalid_id_token',
      );
      fake.idTokenClaims = undefined;
      assert.equal((await auth.getStatus()).profileId, b.profileId);

      const modelsB = await auth.listModels();
      assert.deepEqual(
        modelsB.map((m) => m.slug),
        ['gpt-user-bob', 'gpt-shared'],
      );
      const selected = await auth.selectProfile(a.profileId!);
      assert.equal(selected.email, ALICE.email);
      const modelsA = await auth.listModels();
      assert.deepEqual(modelsA, [
        { slug: 'gpt-user-alice', display_name: 'For user-alice' },
        { slug: 'gpt-shared', display_name: 'Shared' },
      ]);
      // Pinned lookup does not depend on the active profile.
      assert.equal((await auth.listModels(b.profileId))[0].slug, 'gpt-user-bob');

      const profiles = await auth.listProfiles();
      assert.deepEqual(
        profiles.map((p) => [p.id, p.email, p.connected, p.planEnabled]),
        [
          [a.profileId, ALICE.email, true, true],
          [b.profileId, BOB.email, true, true],
        ],
      );
      const credA = readJson(credentialFile(dataDir, a.profileId!));
      const credB = readJson(credentialFile(dataDir, b.profileId!));
      assert.notEqual(credA.clientId, credB.clientId);
      await assertAuthError(auth.selectProfile('missing-profile'), 'profile_not_found');
    });
    it('keeps the old grant active while a reauthorization waits for the index lock, and untouched when it is cancelled', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      const alice = await auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser });
      const oldSession = await auth.openSession(alice.profileId);
      const oldBinding = new ChatGPTBinding({ auth });
      assert.equal(await oldBinding.run(undefined, async () => 'bound'), 'bound');
      const recordBefore = fs.readFileSync(credentialFile(dataDir, alice.profileId!), 'utf8');
      const indexFile = path.join(dataDir, 'chatgpt', 'profiles.json');
      const indexBefore = fs.readFileSync(indexFile, 'utf8');

      // Another holder (e.g. the CLI) keeps the index lock.
      const holder = new ChatGPTCredentialStore(path.join(dataDir, 'chatgpt'));
      let releaseIndex!: () => void;
      let markHeld!: () => void;
      const held = new Promise<void>((resolve) => (markHeld = resolve));
      const holding = holder.withIndexLock(async () => {
        markHeld();
        await new Promise<void>((resolve) => (releaseIndex = resolve));
      });
      await held;

      const controller = new AbortController();
      const reauth = auth.signIn({
        openBrowser: (await browser(fake, ALICE)).openBrowser,
        profileId: alice.profileId,
        signal: controller.signal,
      });
      reauth.catch(() => {});
      // Wait until the code exchange is done and several lock retries have
      // passed, checking the old grant stays active the whole time.
      const deadline = Date.now() + 5_000;
      while (fake.grants('authorization_code').length === 0 && Date.now() < deadline) {
        assert.equal(oldSession.isActive(), true);
        await new Promise((r) => setTimeout(r, 5));
      }
      for (let i = 0; i < 30; i++) {
        assert.equal(oldSession.isActive(), true, 'old grant active while the commit waits');
        await new Promise((r) => setTimeout(r, 10));
      }
      await oldBinding.assertActive();

      controller.abort();
      await assertAuthError(reauth, 'cancelled');
      assert.equal(oldSession.isActive(), true);
      await oldBinding.assertActive();
      assert.equal(
        fs.readFileSync(credentialFile(dataDir, alice.profileId!), 'utf8'),
        recordBefore,
      );
      assert.equal(fs.readFileSync(indexFile, 'utf8'), indexBefore);
      releaseIndex();
      await holding;

      // A completed reauthorization ends the old grant and the new one works.
      const done = await auth.signIn({
        openBrowser: (await browser(fake, ALICE)).openBrowser,
        profileId: alice.profileId,
      });
      assert.equal(oldSession.isActive(), false);
      await assert.rejects(oldBinding.assertActive(), ChatGPTBindingError);
      assert.notEqual(done.sessionRevision, alice.sessionRevision);
      const fresh = await auth.openSession(alice.profileId);
      assert.equal(fresh.isActive(), true);
      assert.ok(await fresh.getAccessToken());
    });

    it('gives same-email registrations distinct labels that survive sign-out, reauthorization and restart', async () => {
      const WORKSPACE: Account = { sub: 'user-alice-workspace', email: ALICE.email };
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      const personal = await auth.signIn({
        openBrowser: (await browser(fake, ALICE)).openBrowser,
      });
      const workspace = await auth.signIn({
        openBrowser: (await browser(fake, WORKSPACE)).openBrowser,
        newProfile: true,
      });
      const labelsOf = async (a: ChatGPTAuth) =>
        Object.fromEntries((await a.listProfiles()).map((p) => [p.id, p.label]));
      const initial = await labelsOf(auth);
      const personalLabel = initial[personal.profileId!];
      const workspaceLabel = initial[workspace.profileId!];
      assert.ok(personalLabel && workspaceLabel);
      assert.notEqual(personalLabel, workspaceLabel);
      for (const label of [personalLabel, workspaceLabel]) {
        assert.ok(!label.includes(ALICE.email), 'label is not derived from the email');
        assert.ok(!label.includes('user-alice'), 'label is not derived from the subject');
      }
      assert.deepEqual(
        (await auth.listProfiles()).map((p) => p.email),
        [ALICE.email, ALICE.email],
      );

      await auth.signOut(workspace.profileId);
      assert.deepEqual(await labelsOf(auth), initial);
      await auth.signIn({
        openBrowser: (await browser(fake, WORKSPACE)).openBrowser,
        profileId: workspace.profileId,
      });
      await auth.signIn({
        openBrowser: (await browser(fake, ALICE)).openBrowser,
        profileId: personal.profileId,
      });
      assert.deepEqual(await labelsOf(auth), initial);
      // A new process over the same store.
      assert.deepEqual(await labelsOf(new ChatGPTAuth(dataDir, fake.deps())), initial);
    });
  });

  describe('scope gate', () => {
    it('keeps an identity-only sign-in but disables plan usage without calling inference', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      const { openBrowser } = await browser(fake, ALICE, { scope: IDENTITY_SCOPE });
      const status = await auth.signIn({ openBrowser });
      assert.equal(status.connected, true);
      assert.equal(status.planEnabled, false);
      await assertAuthError(auth.getAccessToken(), 'plan_disabled');
      await assertAuthError(auth.listModels(), 'plan_disabled');
      assert.equal(fake.requests.filter((r) => r.path === '/v1/models').length, 0);
      assert.equal(status.planState, 'not_granted');
    });

    const inferenceRequests = () =>
      fake.requests.filter(
        (r) =>
          r.path.startsWith('/v1/') ||
          (r.path === '/api/accounts/oauth/token' && r.form?.get('grant_type') === 'refresh_token'),
      ).length;

    it('keeps a verified identity from an ID-token-only response after plan consent was declined', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      fake.exchangeOmit = ['access_token', 'refresh_token', 'expires_in', 'token_type'];
      const { openBrowser } = await browser(fake, ALICE, { scope: IDENTITY_SCOPE });
      const status = await auth.signIn({ openBrowser });
      assert.deepEqual(status, {
        connected: true,
        planEnabled: false,
        profileId: status.profileId,
        email: ALICE.email,
        planState: 'not_granted',
        sessionRevision: status.sessionRevision,
      });
      assert.match(status.sessionRevision ?? '', /^[0-9a-f]{16}$/);
      assert.deepEqual(auth.getStatusSync(), status);
      const record = readJson(credentialFile(dataDir, status.profileId!));
      assert.equal(record.subject, ALICE.sub);
      assert.ok(record.idToken);
      assert.equal(record.accessToken, undefined);
      assert.equal(record.refreshToken, undefined);
      assert.deepEqual(
        (await auth.listProfiles()).map((p) => [p.connected, p.planEnabled, p.active]),
        [[true, false, true]],
      );

      await assertAuthError(auth.getAccessToken(), 'plan_disabled');
      await assertAuthError(auth.listModels(), 'plan_disabled');
      const session = await auth.openSession();
      await assertAuthError(session.getAccessToken(), 'plan_disabled');
      assert.equal(inferenceRequests(), 0);

      // Nothing to revoke: sign-out clears locally and ends the pinned session.
      assert.deepEqual(await auth.signOut(), { revoked: false, signedIn: false, removed: true });
      assert.equal(fake.requests.filter((r) => r.path === '/api/accounts/oauth/revoke').length, 0);
      assert.equal((await auth.getStatus()).connected, false);
      await assertAuthError(session.getAccessToken(), 'session_ended');
      await assertAuthError(auth.getAccessToken(), 'not_signed_in');
    });

    it('never treats a plan scope without a renewable token pair as an entitlement', async () => {
      for (const omit of [['refresh_token'], ['access_token', 'refresh_token']]) {
        fake.reset();
        const dir = makeTempDir('chatgpt-auth-incomplete');
        try {
          const auth = new ChatGPTAuth(dir, fake.deps());
          fake.exchangeOmit = omit;
          const status = await auth.signIn({
            openBrowser: (await browser(fake, ALICE)).openBrowser,
          });
          assert.equal(status.connected, true, omit.join());
          assert.equal(status.planEnabled, false, omit.join());
          assert.equal(status.planState, 'incomplete', omit.join());
          assert.equal(status.email, ALICE.email);
          await assertAuthError(auth.getAccessToken(), 'plan_grant_incomplete');
          await assertAuthError(auth.listModels(), 'plan_grant_incomplete');
          assert.equal(inferenceRequests(), 0, omit.join());
          // An access token without a refresh token is not revocable here.
          assert.deepEqual(await auth.signOut(), {
            revoked: false,
            signedIn: false,
            removed: true,
          });
        } finally {
          rmDir(dir);
        }
      }
    });

    it('still rejects a token response without an ID token', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      fake.exchangeOmit = ['id_token'];
      const { openBrowser } = await browser(fake, ALICE);
      await assertAuthError(auth.signIn({ openBrowser }), 'invalid_token_response');
      assert.deepEqual(await auth.listProfiles(), []);
      // The refresh token it did carry is revoked so the grant does not linger.
      const revokes = await settledRevokes(fake, 1);
      assert.equal(revokes.length, 1);
      assert.equal(revokes[0].form!.get('token_type_hint'), 'refresh_token');
      assert.equal(revokes[0].form!.get('client_id'), 'oaiapp_test1');
    });

    it('revokes the grant of a pending-registration retry that fails before saving', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      fake.exchangeOmit = ['id_token'];
      await assertAuthError(
        auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser }),
        'invalid_token_response',
      );
      assert.equal((await settledRevokes(fake, 1)).length, 1);
      const index = readJson(path.join(dataDir, 'chatgpt', 'profiles.json'));
      assert.equal(index.registrations[0].pending, true);

      // The retry reuses the pending client; each failed attempt revokes its own grant.
      await assertAuthError(
        auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser }),
        'invalid_token_response',
      );
      assert.equal((await settledRevokes(fake, 2)).length, 2);
      fake.exchangeOmit = [];
      fake.idTokenClaims = (c) => ({ ...c, nonce: 'other-nonce' });
      await assertAuthError(
        auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser }),
        'invalid_id_token',
      );
      const revokes = await settledRevokes(fake, 3);
      assert.equal(revokes.length, 3);
      assert.ok(revokes.every((r) => r.form!.get('client_id') === 'oaiapp_test1'));
      assert.equal(fake.grants('authorization_code').length, 3);
      assert.ok(
        fake.grants('authorization_code').every((g) => g.form!.get('client_id') === 'oaiapp_test1'),
      );
      assert.deepEqual(await auth.listProfiles(), []);
    });

    it('keeps the earlier grant when a reauthorization response has no ID token', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      const alice = await auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser });
      const before = fs.readFileSync(credentialFile(dataDir, alice.profileId!), 'utf8');
      fake.exchangeOmit = ['id_token'];
      await assertAuthError(
        auth.signIn({
          openBrowser: (await browser(fake, ALICE)).openBrowser,
          profileId: alice.profileId,
        }),
        'invalid_token_response',
      );
      assert.equal(fs.readFileSync(credentialFile(dataDir, alice.profileId!), 'utf8'), before);
      assert.equal((await settledRevokes(fake, 0)).length, 0);
      assert.ok(await auth.getAccessToken(), 'the earlier grant still works');
    });

    it('enables plan usage through an explicit consent request on the same registration', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      fake.exchangeOmit = ['access_token', 'refresh_token'];
      const declined = await browser(fake, ALICE, { scope: IDENTITY_SCOPE });
      const first = await auth.signIn({ openBrowser: declined.openBrowser });
      assert.equal(first.planEnabled, false);
      assert.equal(declined.seen[0].searchParams.get('prompt'), null);

      fake.exchangeOmit = [];
      const consent = await browser(fake, ALICE);
      const enabled = await auth.signIn({
        openBrowser: consent.openBrowser,
        requestPlanConsent: true,
      });
      const p = consent.seen[0].searchParams;
      assert.equal(p.get('prompt'), 'consent');
      assert.equal(p.get('scope'), FULL_SCOPE);
      assert.equal(p.get('client_id'), 'oaiapp_test1');
      assert.equal(p.get('agent_name_hint'), null);
      assert.equal(p.get('force_reconsent'), null);
      assert.ok(p.get('id_token_hint'));
      assert.equal(enabled.profileId, first.profileId);
      assert.equal(enabled.planEnabled, true);
      assert.equal(enabled.planState, 'enabled');
      assert.ok(await auth.getAccessToken());
    });

    it('never sends prompt or force_reconsent on ordinary sign-ins', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      const first = await browser(fake, ALICE);
      const status = await auth.signIn({ openBrowser: first.openBrowser });
      const again = await browser(fake, ALICE);
      await auth.signIn({ openBrowser: again.openBrowser, profileId: status.profileId });
      const other = await browser(fake, BOB);
      await auth.signIn({
        openBrowser: other.openBrowser,
        newProfile: true,
        requestPlanConsent: false,
      });
      for (const url of [first.seen[0], again.seen[0], other.seen[0]]) {
        assert.equal(url.searchParams.get('prompt'), null);
        assert.equal(url.searchParams.get('force_reconsent'), null);
        assert.equal(url.searchParams.get('scope'), FULL_SCOPE);
      }
    });
  });

  describe('refresh', () => {
    it('refreshes an expired token with the issued client id and resource, and persists the rotation', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      const status = await auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser });
      const before = readJson(credentialFile(dataDir, status.profileId!));
      assert.equal(await auth.getAccessToken(), before.accessToken);
      assert.equal(fake.grants('refresh_token').length, 0);

      expireAccessToken(dataDir, status.profileId!);
      const token = await auth.getAccessToken();
      const [refresh] = fake.grants('refresh_token');
      assert.equal(refresh.form!.get('client_id'), 'oaiapp_test1');
      assert.equal(refresh.form!.get('refresh_token'), before.refreshToken);
      assert.equal(refresh.form!.get('resource'), 'https://api.openai.com/v1');
      assert.equal(refresh.form!.get('scope'), null);
      const after = readJson(credentialFile(dataDir, status.profileId!));
      assert.equal(after.accessToken, token);
      assert.notEqual(after.refreshToken, before.refreshToken);
      assert.ok(after.expiresAt > Date.now());
      assert.equal(after.sessionId, before.sessionId);
      assert.deepEqual(auth.getStatusSync(), await auth.getStatus());
    });

    it('serializes concurrent refreshes across instances so a rotating token is used once', async () => {
      const first = new ChatGPTAuth(dataDir, fake.deps());
      const status = await first.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser });
      expireAccessToken(dataDir, status.profileId!);
      fake.refreshDelayMs = 150;
      const instances = [
        first,
        new ChatGPTAuth(dataDir, fake.deps()),
        new ChatGPTAuth(dataDir, fake.deps()),
      ];
      const tokens = await Promise.all([
        ...instances.map((a) => a.getAccessToken()),
        first.getAccessToken(),
      ]);
      assert.equal(fake.grants('refresh_token').length, 1);
      assert.equal(new Set(tokens).size, 1);
    });

    it('serializes refreshes across separate processes', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      const status = await auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser });
      expireAccessToken(dataDir, status.profileId!);
      fake.refreshDelayMs = 200;
      const modulePath = path.join(__dirname, 'chatgptAuth.js');
      const script = `
        const { ChatGPTAuth } = require(${JSON.stringify(modulePath)});
        const auth = new ChatGPTAuth(process.argv[1], JSON.parse(process.argv[2]));
        auth.getAccessToken().then(
          (t) => process.stdout.write(JSON.stringify({ ok: require('crypto').createHash('sha256').update(t).digest('hex') })),
          (e) => process.stdout.write(JSON.stringify({ error: e.code || String(e) })),
        );
      `;
      const run = () =>
        new Promise<{ ok?: string; error?: string }>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ['-e', script, dataDir, JSON.stringify(fake.deps())],
            {
              env: { ...process.env },
              stdio: ['ignore', 'pipe', 'inherit'],
            },
          );
          let out = '';
          child.stdout.on('data', (d) => (out += d));
          child.on('error', reject);
          child.on('close', () => {
            try {
              resolve(JSON.parse(out));
            } catch (error) {
              reject(error);
            }
          });
        });
      const results = await Promise.all([run(), run(), run()]);
      for (const r of results) assert.ok(r.ok, `child failed: ${r.error}`);
      assert.equal(new Set(results.map((r) => r.ok)).size, 1);
      assert.equal(fake.grants('refresh_token').length, 1);
    });

    it('a cancelled sign-in does not fail a refresh waiting on the same first discovery', async () => {
      const status = await new ChatGPTAuth(dataDir, fake.deps()).signIn({
        openBrowser: (await browser(fake, ALICE)).openBrowser,
      });
      expireAccessToken(dataDir, status.profileId!);
      // A fresh instance (a new app process): its first discovery is shared.
      const gated = gatedFetch('/.well-known/openid-configuration');
      const auth = new ChatGPTAuth(dataDir, fake.deps({ fetch: gated.fetchImpl }));
      const controller = new AbortController();
      const signIn = auth.signIn({
        newProfile: true,
        signal: controller.signal,
        openBrowser: (await browser(fake, BOB)).openBrowser,
      });
      await gated.reached;
      const token = auth.getAccessToken();
      // Let the summary job's refresh take the profile lock and join the
      // in-flight discovery before the user cancels Add account.
      await new Promise((resolve) => setTimeout(resolve, 150));
      controller.abort();
      // The gated discovery request is sent only now, after the cancel.
      gated.release();
      await assertAuthError(signIn, 'cancelled');
      const refreshed = await token;
      assert.equal(refreshed, readJson(credentialFile(dataDir, status.profileId!)).accessToken);
      assert.equal(fake.grants('refresh_token').length, 1);
    });

    it('a cancelled job stops waiting on a shared refresh that another job still completes', async () => {
      const status = await new ChatGPTAuth(dataDir, fake.deps()).signIn({
        openBrowser: (await browser(fake, ALICE)).openBrowser,
      });
      expireAccessToken(dataDir, status.profileId!);
      const gated = gatedFetch('/api/accounts/oauth/token');
      const auth = new ChatGPTAuth(dataDir, fake.deps({ fetch: gated.fetchImpl }));
      const session = await auth.openSession(status.profileId!);
      const controller = new AbortController();
      const cancelled = session.getAccessToken(controller.signal);
      let otherSettled = false;
      const other = session.getAccessToken().finally(() => {
        otherSettled = true;
      });
      await gated.reached;
      controller.abort();
      // Settles while the shared refresh is still held at the token endpoint.
      const timedOut = new Promise<'pending'>((resolve) => setTimeout(resolve, 500, 'pending'));
      const outcome = await Promise.race([
        cancelled.then(
          () => 'resolved',
          () => 'rejected',
        ),
        timedOut,
      ]);
      gated.release();
      assert.equal(outcome, 'rejected', 'the cancelled caller kept waiting on the refresh');
      await assertAuthError(cancelled, 'cancelled');
      assert.equal(otherSettled, false);
      assert.equal(await other, readJson(credentialFile(dataDir, status.profileId!)).accessToken);
      assert.equal(fake.grants('refresh_token').length, 1);
    });

    describe('lock timing policy', () => {
      // A fetch that never answers `hangPath` until the request is aborted.
      function hangingFetch(hangPath: string) {
        const aborted: boolean[] = [];
        let entered!: () => void;
        const enteredPromise = new Promise<void>((resolve) => (entered = resolve));
        const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
          if (new URL(String(input)).pathname !== hangPath) return fetch(input, init);
          entered();
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              aborted.push(true);
              reject(init.signal!.reason);
            });
          });
        }) as typeof fetch;
        return { fetchImpl, enteredPromise, aborted };
      }
      // Worst case of the per-request retry ladder in these tests: 3 x 10 s + 2 x 10 s.
      const slowLadder = { requestTimeoutMs: 10_000, retryDelaysMs: [10_000, 10_000] };

      it('keeps the default locked network budget well inside the lock wait', () => {
        assert.ok(CHATGPT_LOCKED_NETWORK_BUDGET_MS * 2 < CHATGPT_LOCK_WAIT_MS);
      });

      it('releases the profile lock within the budget when a refresh hangs, so a waiter proceeds', async () => {
        const app = new ChatGPTAuth(dataDir, fake.deps());
        const status = await app.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser });
        expireAccessToken(dataDir, status.profileId!);
        const hang = hangingFetch('/api/accounts/oauth/token');
        const holder = new ChatGPTAuth(
          dataDir,
          fake.deps({ ...slowLadder, fetch: hang.fetchImpl, lockedNetworkBudgetMs: 300 }),
        );
        const started = Date.now();
        const held = holder.getAccessToken();
        held.catch(() => {});
        await hang.enteredPromise;
        // The waiter gives up long before the holder's retry ladder would end.
        const waiter = new ChatGPTAuth(dataDir, fake.deps({ lockTimeoutMs: 2_000 }));
        const token = await waiter.getAccessToken();
        assert.ok(token);
        await assertAuthError(held, 'temporarily_unavailable');
        assert.ok(Date.now() - started < 2_000, 'holder released within its budget');
        assert.equal(hang.aborted.length, 1, 'the hung request was torn down, not retried');
        assert.equal(fake.grants('refresh_token').length, 1, 'only the waiter reached the server');
      });

      it('bounds a sign-out whose revocation hangs and still clears the tokens', async () => {
        const hang = hangingFetch('/api/accounts/oauth/revoke');
        const auth = new ChatGPTAuth(
          dataDir,
          fake.deps({ ...slowLadder, fetch: hang.fetchImpl, lockedNetworkBudgetMs: 300 }),
        );
        const status = await auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser });
        const started = Date.now();
        const result = await auth.signOut();
        assert.ok(Date.now() - started < 2_000);
        assert.deepEqual(result, {
          revoked: false,
          signedIn: true,
          removed: true,
          revocationError: 'temporarily_unavailable',
        });
        assert.equal(fs.existsSync(credentialFile(dataDir, status.profileId!)), false);
      });

      it('still reports a caller cancellation as cancelled', async () => {
        const hang = hangingFetch('/v1/models');
        const auth = new ChatGPTAuth(
          dataDir,
          fake.deps({ ...slowLadder, fetch: hang.fetchImpl, lockedNetworkBudgetMs: 300 }),
        );
        await auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser });
        const session = await auth.openSession();
        const controller = new AbortController();
        const listing = session.listModels(controller.signal);
        await hang.enteredPromise;
        controller.abort();
        await assertAuthError(listing, 'cancelled');
      });
    });

    for (const code of ['invalid_grant', 'refresh_token_reused', 'refresh_token_expired']) {
      it(`clears tokens but keeps the registration on ${code}`, async () => {
        const auth = new ChatGPTAuth(dataDir, fake.deps());
        const status = await auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser });
        expireAccessToken(dataDir, status.profileId!);
        // An expired access token with a usable refresh token still counts as connected.
        assert.equal(auth.getStatusSync().connected, true);
        fake.refreshFailure = { status: 400, body: { error: code } };
        await assertAuthError(auth.getAccessToken(), 'reauth_required');
        const now = await auth.getStatus();
        assert.equal(now.connected, false);
        assert.equal(now.profileId, status.profileId);
        const record = readJson(credentialFile(dataDir, status.profileId!));
        assert.equal(record.accessToken, undefined);
        assert.equal(record.refreshToken, undefined);
        // Reauthorization goes back through OAuth with the saved client id.
        fake.refreshFailure = undefined;
        const again = await browser(fake, ALICE);
        await auth.signIn({ openBrowser: again.openBrowser });
        assert.equal(again.seen[0].searchParams.get('client_id'), 'oaiapp_test1');
        assert.equal((await auth.getStatus()).connected, true);
      });
    }

    it('keeps credentials on temporary failures after bounded retries', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      const status = await auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser });
      expireAccessToken(dataDir, status.profileId!);
      const before = fs.readFileSync(credentialFile(dataDir, status.profileId!), 'utf8');
      fake.refreshFailure = { status: 503, body: { error: 'temporarily_unavailable' } };
      await assertAuthError(auth.getAccessToken(), 'temporarily_unavailable');
      assert.equal(fake.grants('refresh_token').length, 3);
      assert.equal(fs.readFileSync(credentialFile(dataDir, status.profileId!), 'utf8'), before);
    });

    it('reports invalid_client without clearing credentials', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      const status = await auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser });
      expireAccessToken(dataDir, status.profileId!);
      fake.refreshFailure = { status: 401, body: { error: 'invalid_client' } };
      await assertAuthError(auth.getAccessToken(), 'invalid_client');
      assert.ok(readJson(credentialFile(dataDir, status.profileId!)).refreshToken);
    });
  });

  describe('sign-out', () => {
    // An identity-only account starts "Enable ChatGPT plan"; the user signs
    // out while the code exchange is in flight. The late exchange must not
    // bring the deleted sign-in back (with plan usage, no less).
    async function enablePlanWithPendingExchange() {
      fake.exchangeOmit = ['access_token', 'refresh_token'];
      const identity = await new ChatGPTAuth(dataDir, fake.deps()).signIn({
        openBrowser: (await browser(fake, ALICE, { scope: IDENTITY_SCOPE })).openBrowser,
      });
      assert.equal(identity.planState, 'not_granted');
      fake.exchangeOmit = [];
      const gated = gatedFetch('/api/accounts/oauth/token');
      const auth = new ChatGPTAuth(dataDir, fake.deps({ fetch: gated.fetchImpl }));
      const enabling = auth.signIn({
        openBrowser: (await browser(fake, ALICE)).openBrowser,
        profileId: identity.profileId,
        requestPlanConsent: true,
      });
      await gated.reached;
      return { auth, enabling, gated, profileId: identity.profileId! };
    }

    async function assertStaysSignedOut(auth: ChatGPTAuth, profileId: string) {
      assert.equal(fs.existsSync(credentialFile(dataDir, profileId)), false);
      assert.equal((await auth.getStatus()).connected, false);
      assert.equal((await auth.getStatus()).planEnabled, false);
      await assertAuthError(auth.getAccessToken(), 'not_signed_in');
    }

    it('cancels a pending sign-in of the same account so it cannot undo the sign-out', async () => {
      const { auth, enabling, gated, profileId } = await enablePlanWithPendingExchange();
      const result = await auth.signOut(profileId);
      assert.equal(result.signedIn, false);
      gated.release();
      await assertAuthError(enabling, 'cancelled');
      await assertStaysSignedOut(auth, profileId);
    });

    it('refuses to commit a sign-in whose account was signed out by another process', async () => {
      const { auth, enabling, gated, profileId } = await enablePlanWithPendingExchange();
      // The CLI (another ChatGPTAuth, so no in-process cancel) signs out.
      await new ChatGPTAuth(dataDir, fake.deps()).signOut(profileId);
      gated.release();
      assert.equal(isExpectedSignInOutcome(await assertAuthError(enabling, 'session_ended')), true);
      await assertStaysSignedOut(auth, profileId);
    });

    it('leaves a pending sign-in of a different account running', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      const alice = await auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser });
      const gated = gatedFetch('/api/accounts/oauth/token');
      const adding = new ChatGPTAuth(dataDir, fake.deps({ fetch: gated.fetchImpl }));
      const bob = adding.signIn({
        openBrowser: (await browser(fake, BOB)).openBrowser,
        newProfile: true,
      });
      await gated.reached;
      await adding.signOut(alice.profileId);
      gated.release();
      const added = await bob;
      assert.equal(added.connected, true);
      assert.equal(added.email, BOB.email);
      assert.equal(
        (await adding.listProfiles()).find((p) => p.id === alice.profileId)?.connected,
        false,
      );
    });

    it('revokes the refresh token, clears tokens and keeps the registration and host id', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      const first = await browser(fake, ALICE);
      const status = await auth.signIn({ openBrowser: first.openBrowser });
      const cred = readJson(credentialFile(dataDir, status.profileId!));
      const result = await auth.signOut();
      assert.equal(result.revoked, true);
      const [revoke] = fake.requests.filter((r) => r.path === '/api/accounts/oauth/revoke');
      assert.equal(revoke.form!.get('token'), cred.refreshToken);
      assert.equal(revoke.form!.get('token_type_hint'), 'refresh_token');
      assert.equal(revoke.form!.get('client_id'), 'oaiapp_test1');
      assert.equal(fs.existsSync(credentialFile(dataDir, status.profileId!)), false);
      assert.deepEqual(await auth.getStatus(), {
        connected: false,
        planEnabled: false,
        profileId: status.profileId,
        email: ALICE.email,
      });
      await assertAuthError(auth.getAccessToken(), 'not_signed_in');

      const again = await browser(fake, ALICE);
      await auth.signIn({ openBrowser: again.openBrowser });
      const p = again.seen[0].searchParams;
      assert.equal(p.get('client_id'), 'oaiapp_test1');
      assert.equal(p.get('id_token_hint'), null);
      assert.equal(p.get('ext_agent_host_id'), first.seen[0].searchParams.get('ext_agent_host_id'));
    });

    it('retries revocation on 5xx and reports an unconfirmed revocation after clearing tokens', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      const status = await auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser });
      fake.revokeStatuses = [500, 502, 503];
      const result = await auth.signOut(status.profileId);
      assert.equal(result.revoked, false);
      assert.equal(result.signedIn, true);
      assert.equal(fake.requests.filter((r) => r.path === '/api/accounts/oauth/revoke').length, 3);
      assert.equal(fs.existsSync(credentialFile(dataDir, status.profileId!)), false);
      assert.equal((await auth.getStatus()).connected, false);
    });

    it('succeeds after a transient revocation failure', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      await auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser });
      fake.revokeStatuses = [503];
      assert.equal((await auth.signOut()).revoked, true);
    });

    it('ends a pinned session when its profile signs out, even after signing in again', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      const a = await auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser });
      const b = await auth.signIn({
        openBrowser: (await browser(fake, BOB)).openBrowser,
        newProfile: true,
      });
      const session = await auth.openSession(a.profileId);
      assert.ok(await session.getAccessToken());
      await auth.signOut(a.profileId);
      await assertAuthError(session.getAccessToken(), 'session_ended');
      await auth.signIn({
        openBrowser: (await browser(fake, ALICE)).openBrowser,
        profileId: a.profileId,
      });
      await assertAuthError(session.listModels(), 'session_ended');
      // Signing out one profile leaves the other signed in.
      assert.ok(await auth.getAccessToken(b.profileId));
    });

    it('ends the session locally before awaiting revocation', async () => {
      const gated = gatedFetch('/api/accounts/oauth/revoke');
      const auth = new ChatGPTAuth(dataDir, fake.deps({ fetch: gated.fetchImpl }));
      const alice = await auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser });
      const session = await auth.openSession(alice.profileId);
      const binding = new ChatGPTBinding({ auth });
      assert.equal(await binding.run(undefined, async () => 'bound'), 'bound');

      const signingOut = auth.signOut(alice.profileId);
      await gated.reached;
      // Revocation is still in flight: the sign-in has already ended.
      assert.equal(session.isActive(), false);
      await assertAuthError(session.getAccessToken(), 'session_ended');
      await assert.rejects(binding.assertActive(), ChatGPTBindingError);
      await assert.rejects(
        binding.run(undefined, async () => 'completed during sign-out'),
        ChatGPTBindingError,
      );
      await assertAuthError(auth.openSession(alice.profileId), 'not_signed_in');
      assert.equal(auth.getStatusSync().connected, false);
      assert.equal(fs.existsSync(credentialFile(dataDir, alice.profileId!)), false);

      gated.release();
      assert.deepEqual(await signingOut, { revoked: true, signedIn: true, removed: true });
    });

    it('keeps the local sign-out and reports it unconfirmed when a delayed revocation fails', async () => {
      const gated = gatedFetch('/api/accounts/oauth/revoke');
      const auth = new ChatGPTAuth(dataDir, fake.deps({ fetch: gated.fetchImpl }));
      const alice = await auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser });
      const session = await auth.openSession(alice.profileId);
      fake.revokeStatuses = [500, 502, 503];
      const signingOut = auth.signOut(alice.profileId);
      await gated.reached;
      assert.equal(session.isActive(), false);
      gated.release();
      const result = await signingOut;
      assert.equal(result.revoked, false);
      assert.equal(result.signedIn, true);
      assert.ok(result.revocationError);
      assert.equal(session.isActive(), false);
      assert.equal(fs.existsSync(credentialFile(dataDir, alice.profileId!)), false);
      assert.equal(auth.getStatusSync().connected, false);
    });

    it('does not clobber a sign-in that lands while revocation is pending', async () => {
      const gated = gatedFetch('/api/accounts/oauth/revoke');
      const auth = new ChatGPTAuth(dataDir, fake.deps({ fetch: gated.fetchImpl }));
      const alice = await auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser });
      const signingOut = auth.signOut(alice.profileId);
      await gated.reached;
      const again = await auth.signIn({
        openBrowser: (await browser(fake, ALICE)).openBrowser,
        profileId: alice.profileId,
      });
      const fresh = await auth.openSession(alice.profileId);
      gated.release();
      assert.equal((await signingOut).revoked, true);
      assert.equal(fresh.isActive(), true);
      assert.equal(auth.getStatusSync().sessionRevision, again.sessionRevision);
      assert.ok(await fresh.getAccessToken());
    });

    it('reports nothing to revoke when no session exists', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      assert.deepEqual(await auth.signOut(), { revoked: false, signedIn: false, removed: false });
    });
  });

  describe('models and errors', () => {
    it('returns sanitized errors without response bodies or tokens', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      const status = await auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser });
      const cred = readJson(credentialFile(dataDir, status.profileId!));
      fake.modelsStatus = {
        status: 429,
        body: {
          error: {
            code: 'subscription_sharing_usage_limit_exceeded',
            message: `token ${cred.accessToken}`,
          },
        },
      };
      const error = await assertAuthError(auth.listModels(), 'http_error');
      assert.equal(error.status, 429);
      assert.equal(error.providerCode, 'subscription_sharing_usage_limit_exceeded');
      assert.equal(error.requestId, 'req_test_1');
      assert.ok(!error.message.includes(cred.accessToken));
      assert.ok(!JSON.stringify(error).includes(cred.accessToken));
      // A non-401 failure keeps the sign-in.
      assert.equal(auth.getStatusSync().connected, true);
      assert.equal(auth.getStatusSync().planEnabled, true);

      fake.modelsStatus = { status: 401, body: { detail: `bad token ${cred.accessToken}` } };
      const detail = await assertAuthError(auth.listModels(), 'reauth_required');
      assert.equal(detail.providerCode, undefined);
      assert.ok(!detail.message.includes(cred.accessToken));
      assert.ok(!JSON.stringify(detail).includes(cred.accessToken));
    });

    it('ends only the rejected session when the API answers 401', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      const bob = await auth.signIn({ openBrowser: (await browser(fake, BOB)).openBrowser });
      const alice = await auth.signIn({
        openBrowser: (await browser(fake, ALICE)).openBrowser,
        newProfile: true,
      });
      assert.equal(auth.getStatusSync().profileId, alice.profileId);
      const session = await auth.openSession(alice.profileId);
      const before = readJson(credentialFile(dataDir, alice.profileId!));

      fake.modelsStatus = { status: 401, body: { error: { code: 'invalid_token' } } };
      await assertAuthError(session.listModels(), 'reauth_required');

      // The status no longer reports a connected, plan-enabled sign-in, so
      // Settings offers Continue with ChatGPT; jobs bound to it stop.
      const status = auth.getStatusSync();
      assert.equal(status.profileId, alice.profileId);
      assert.equal(status.connected, false);
      assert.equal(status.planEnabled, false);
      assert.equal(session.isActive(), false);
      await assertAuthError(session.getAccessToken(), 'session_ended');
      await assertAuthError(auth.openSession(alice.profileId), 'not_signed_in');
      // The registration and retained ID token survive for the next sign-in.
      const after = readJson(credentialFile(dataDir, alice.profileId!));
      assert.equal(after.accessToken, undefined);
      assert.equal(after.refreshToken, undefined);
      assert.equal(after.sessionId, undefined);
      assert.equal(after.idToken, before.idToken);
      assert.equal(after.clientId, before.clientId);
      assert.ok((await auth.listProfiles()).some((p) => p.id === alice.profileId));
      // Another profile is untouched.
      fake.modelsStatus = undefined;
      assert.ok(await auth.getAccessToken(bob.profileId));
      assert.ok((await auth.listProfiles()).find((p) => p.id === bob.profileId)?.connected);

      // Reauthorizing the same profile works again.
      await auth.signIn({
        openBrowser: (await browser(fake, ALICE)).openBrowser,
        profileId: alice.profileId,
      });
      assert.equal(auth.getStatusSync().connected, true);
    });

    it('does not end a newer session or a refreshed token after a 401 for an old token', async () => {
      const auth = new ChatGPTAuth(dataDir, fake.deps());
      const alice = await auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser });
      const old = await auth.openSession(alice.profileId);
      const oldToken = await old.getAccessToken();

      // A token that is no longer the stored one (rotated by a refresh, or a
      // stale copy) never clears the current session.
      assert.equal(await old.endRejectedSession('not-the-stored-token'), false);
      assert.equal(old.isActive(), true);

      // Reauthorize: the old session's late 401 must not end the new grant.
      await auth.signIn({
        openBrowser: (await browser(fake, ALICE)).openBrowser,
        profileId: alice.profileId,
      });
      const fresh = await auth.openSession(alice.profileId);
      assert.equal(await old.endRejectedSession(oldToken), false);
      assert.equal(fresh.isActive(), true);
      assert.equal(auth.getStatusSync().connected, true);
      assert.ok(await fresh.getAccessToken());
    });

    it('never surfaces tokens through status, profiles, progress or console output', async () => {
      const logged: string[] = [];
      const originals = {
        log: console.log,
        warn: console.warn,
        error: console.error,
        info: console.info,
      };
      for (const key of Object.keys(originals) as (keyof typeof originals)[]) {
        console[key] = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
      }
      try {
        const auth = new ChatGPTAuth(dataDir, fake.deps());
        const progress: string[] = [];
        const status = await auth.signIn({
          openBrowser: (await browser(fake, ALICE)).openBrowser,
          onProgress: (m) => progress.push(m),
        });
        expireAccessToken(dataDir, status.profileId!);
        await auth.getAccessToken();
        await auth.listModels();
        fake.revokeStatuses = [500, 500, 500];
        const signOut = await auth.signOut();
        const cred = fake.grants('refresh_token')[0].form!.get('refresh_token')!;
        const surfaces = JSON.stringify([
          status,
          await auth.getStatus(),
          await auth.listProfiles(),
          progress,
          logged,
          signOut,
        ]);
        for (const token of [cred, ...fake.accessTokens.keys()])
          assert.ok(!surfaces.includes(token));
        assert.ok(!/eyJ[A-Za-z0-9_-]+\./.test(surfaces), 'no JWT in public surfaces');
      } finally {
        Object.assign(console, originals);
      }
    });

    it('redacts id_token_hint from authorize URLs meant for display', () => {
      const raw =
        'https://auth.example/api/accounts/authorize?client_id=oaiapp_1&id_token_hint=eyJabc.def.ghi&state=s';
      const redacted = redactAuthorizeUrl(raw);
      assert.ok(!redacted.includes('eyJabc'));
      assert.ok(redacted.includes('client_id=oaiapp_1'));
    });
  });
});

// A sign-out must stop a ChatGPT request that is ALREADY streaming, not just
// the next token fetch: the binding watches its session (isActive) while the
// call is in flight. These drive the real pi-ai Responses transport with a
// held-open SSE stream and the real auth store.
describe('ChatGPTBinding session watch during an in-flight Responses stream', () => {
  const fake = new FakeOpenAI();
  let dataDir: string;
  const POLL_MS = 20;

  before(async () => {
    await fake.start();
  });
  after(async () => {
    await fake.stop();
  });
  beforeEach(() => {
    fake.reset();
    dataDir = makeTempDir('chatgpt-binding-watch');
  });
  afterEach(() => {
    rmDir(dataDir);
  });

  const sse = (event: Record<string, unknown>) =>
    new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

  // Streams the first part of an answer, then holds the stream open until the
  // request is aborted (or `finish()` completes it).
  function heldStream() {
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => (started = resolve));
    let finish: () => void = () => {};
    const state = { aborted: false, finished: false };
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            sse({
              type: 'response.created',
              response: { id: 'r1', status: 'in_progress', output: [] },
            }),
          );
          controller.enqueue(
            sse({
              type: 'response.output_item.added',
              output_index: 0,
              item: { type: 'message', id: 'm1', role: 'assistant', content: [] },
            }),
          );
          controller.enqueue(
            sse({
              type: 'response.output_text.delta',
              output_index: 0,
              content_index: 0,
              delta: 'partial summary',
            }),
          );
          signal?.addEventListener('abort', () => {
            state.aborted = true;
            controller.error(signal.reason ?? new Error('aborted'));
          });
          finish = () => {
            state.finished = true;
            controller.enqueue(
              sse({
                type: 'response.output_item.done',
                output_index: 0,
                item: {
                  type: 'message',
                  id: 'm1',
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: 'full summary', annotations: [] }],
                },
              }),
            );
            controller.enqueue(
              sse({
                type: 'response.completed',
                response: { id: 'r1', status: 'completed', output: [] },
              }),
            );
            controller.close();
          };
          started();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    return { fetchImpl, startedPromise, state, finish: () => finish() };
  }

  function summarize(binding: ChatGPTBinding, fetchImpl: typeof fetch): Promise<string> {
    const model = buildChatGPTModel({ slug: 'gpt-shared', display_name: 'Shared' });
    return binding.run(undefined, async (signal) => {
      const response = await complete(
        model,
        {
          systemPrompt: 'Summarize.',
          messages: [{ role: 'user', content: 'transcript', timestamp: Date.now() }],
        },
        { apiKey: await binding.accessToken(signal), signal, fetch: fetchImpl } as never,
      );
      return extractFinalText(response);
    });
  }

  async function assertSignedOutDuringJob(promise: Promise<unknown>): Promise<void> {
    await assert.rejects(promise, (error: unknown) => {
      assert.ok(error instanceof ChatGPTBindingError, String(error));
      assert.equal(error.code, 'signed_out_during_job');
      return true;
    });
  }

  it('aborts the stream on sign-out followed by a re-sign-in of the same profile', async () => {
    const auth = new ChatGPTAuth(dataDir, fake.deps());
    const alice = await auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser });
    const binding = new ChatGPTBinding({ auth, sessionPollMs: POLL_MS });
    const stream = heldStream();
    const job = summarize(binding, stream.fetchImpl);
    job.catch(() => {});
    await stream.startedPromise;

    const signedOutAt = Date.now();
    await auth.signOut(alice.profileId);
    // Same account, same registration, back before the watcher even fires:
    // it is a NEW grant, so the job must still not continue on it.
    await auth.signIn({
      openBrowser: (await browser(fake, ALICE)).openBrowser,
      profileId: alice.profileId,
    });
    await assertSignedOutDuringJob(job);
    assert.equal(stream.state.aborted, true, 'the in-flight request was torn down');
    assert.equal(stream.state.finished, false);
    assert.ok(Date.now() - signedOutAt < 2_000, 'stopped within the bounded watch interval');
  });

  it('ends the old job on a same-profile reauthorization and lets a new binding run on the new grant', async () => {
    const app = new ChatGPTAuth(dataDir, fake.deps());
    const alice = await app.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser });
    const before = app.getStatusSync();
    assert.match(before.sessionRevision ?? '', /^[0-9a-f]{16}$/);
    const oldBinding = new ChatGPTBinding({ auth: app, sessionPollMs: POLL_MS });
    const stream = heldStream();
    const job = summarize(oldBinding, stream.fetchImpl);
    job.catch(() => {});
    await stream.startedPromise;

    // Reauthorize the same profile without signing out, through a separate
    // auth instance over the same store (the CLI while the app runs).
    const cli = new ChatGPTAuth(dataDir, fake.deps());
    const reauth = await cli.signIn({
      openBrowser: (await browser(fake, ALICE)).openBrowser,
      profileId: alice.profileId,
    });
    assert.equal(reauth.profileId, alice.profileId);
    await assertSignedOutDuringJob(job);
    assert.equal(stream.state.aborted, true);

    // The app's network-free status read sees a new grant revision for the
    // SAME profile, which is what makes it rebuild its services for new work.
    const after = app.getStatusSync();
    assert.equal(after.profileId, before.profileId);
    assert.equal(after.connected && after.planEnabled, true);
    assert.notEqual(after.sessionRevision, before.sessionRevision);
    assert.ok(
      !JSON.stringify(after).includes(
        readJson(credentialFile(dataDir, alice.profileId!)).sessionId,
      ),
    );

    // The old binding never rebinds to the new grant...
    await assert.rejects(oldBinding.assertActive(), ChatGPTBindingError);
    await assertSignedOutDuringJob(summarize(oldBinding, heldStream().fetchImpl));
    // ...while a fresh binding (a rebuilt service) completes on it.
    const fresh = new ChatGPTBinding({ auth: app, sessionPollMs: POLL_MS });
    const next = heldStream();
    const nextJob = summarize(fresh, next.fetchImpl);
    await next.startedPromise;
    next.finish();
    assert.equal(await nextJob, 'full summary');
    assert.equal(await fresh.profileId(), alice.profileId);
  });

  it('aborts the stream when another process (the CLI) signs out', async () => {
    const auth = new ChatGPTAuth(dataDir, fake.deps());
    const alice = await auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser });
    const binding = new ChatGPTBinding({ auth, sessionPollMs: POLL_MS });
    const stream = heldStream();
    const job = summarize(binding, stream.fetchImpl);
    job.catch(() => {});
    await stream.startedPromise;

    const modulePath = path.join(__dirname, 'chatgptAuth.js');
    const script = `
      const { ChatGPTAuth } = require(${JSON.stringify(modulePath)});
      new ChatGPTAuth(process.argv[1], JSON.parse(process.argv[2]))
        .signOut(process.argv[3])
        .then((r) => process.stdout.write(JSON.stringify(r)), (e) => process.stdout.write(JSON.stringify({ error: e.code || String(e) })));
    `;
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['-e', script, dataDir, JSON.stringify(fake.deps()), alice.profileId!],
        { env: { ...process.env }, stdio: ['ignore', 'pipe', 'inherit'] },
      );
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.on('error', reject);
      child.on('close', () => {
        try {
          resolve(JSON.parse(out));
        } catch (error) {
          reject(error);
        }
      });
    });
    assert.equal(result.revoked, true, `child sign-out failed: ${JSON.stringify(result)}`);

    await assertSignedOutDuringJob(job);
    assert.equal(stream.state.aborted, true);
  });

  it('discards an answer that completed right after the sign-out', async () => {
    const auth = new ChatGPTAuth(dataDir, fake.deps());
    const alice = await auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser });
    // A watch interval far longer than the test: only the post-call check can
    // catch this.
    const binding = new ChatGPTBinding({ auth, sessionPollMs: 60_000 });
    const stream = heldStream();
    const job = summarize(binding, stream.fetchImpl);
    job.catch(() => {});
    await stream.startedPromise;
    await auth.signOut(alice.profileId);
    stream.finish();
    await assertSignedOutDuringJob(job);
    assert.equal(stream.state.finished, true);
  });

  function rejecting(status: number, body: unknown, beforeReply?: () => Promise<void>) {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      await beforeReply?.();
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    return { fetchImpl, calls: () => calls };
  }

  it('ends the bound session when the Responses API answers 401', async () => {
    const auth = new ChatGPTAuth(dataDir, fake.deps());
    const bob = await auth.signIn({ openBrowser: (await browser(fake, BOB)).openBrowser });
    const alice = await auth.signIn({
      openBrowser: (await browser(fake, ALICE)).openBrowser,
      newProfile: true,
    });
    const binding = new ChatGPTBinding({ auth, sessionPollMs: POLL_MS });
    const rejected = rejecting(401, { error: { message: 'invalid token', code: 'invalid_token' } });

    await assert.rejects(summarize(binding, rejected.fetchImpl), (error: unknown) => {
      assert.ok(error instanceof ChatGPTInferenceError, String(error));
      assert.equal(error.code, 'unauthorized');
      assert.match(error.userMessage, /Sign in with ChatGPT again/);
      return true;
    });
    assert.equal(rejected.calls(), 1);
    // No longer connected: Settings shows Continue with ChatGPT and no job
    // reuses the rejected token.
    const status = auth.getStatusSync();
    assert.equal(status.profileId, alice.profileId);
    assert.equal(status.connected, false);
    assert.equal(status.planEnabled, false);
    await assertSignedOutDuringJob(summarize(binding, rejected.fetchImpl));
    await assert.rejects(
      summarize(new ChatGPTBinding({ auth }), rejected.fetchImpl),
      (error: unknown) => error instanceof ChatGPTBindingError && error.code === 'not_signed_in',
    );
    assert.equal(rejected.calls(), 1, 'the rejected token was never sent again');
    // The other saved account keeps its sign-in.
    assert.ok((await auth.listProfiles()).find((p) => p.id === bob.profileId)?.connected);
    assert.ok(await auth.getAccessToken(bob.profileId));
  });

  it('keeps the session on a non-401 Responses failure', async () => {
    const auth = new ChatGPTAuth(dataDir, fake.deps());
    await auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser });
    const binding = new ChatGPTBinding({ auth, sessionPollMs: POLL_MS });
    const limited = rejecting(429, {
      error: { message: 'limit', code: 'subscription_sharing_usage_limit_exceeded' },
    });
    await assert.rejects(summarize(binding, limited.fetchImpl), (error: unknown) => {
      assert.ok(error instanceof ChatGPTInferenceError, String(error));
      assert.equal(error.code, 'usage_limit_exceeded');
      return true;
    });
    const status = auth.getStatusSync();
    assert.equal(status.connected && status.planEnabled, true);
    const stream = heldStream();
    const job = summarize(binding, stream.fetchImpl);
    await stream.startedPromise;
    stream.finish();
    assert.equal(await job, 'full summary');
  });

  it('keeps the session when a non-401 response mentions 401 or invalid_user', async () => {
    const auth = new ChatGPTAuth(dataDir, fake.deps());
    await auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser });
    const binding = new ChatGPTBinding({ auth, sessionPollMs: POLL_MS });
    const cases: Array<{ status: number; body: unknown; code: string }> = [
      // The text classifier reads a standalone 401 as unauthorized.
      { status: 500, body: { error: { message: 'upstream returned 401' } }, code: 'unauthorized' },
      {
        status: 403,
        body: { error: { message: 'no', code: 'subscription_sharing_invalid_user' } },
        code: 'invalid_user',
      },
    ];
    for (const { status, body, code } of cases) {
      await assert.rejects(
        summarize(binding, rejecting(status, body).fetchImpl),
        (error: unknown) => {
          assert.ok(error instanceof ChatGPTInferenceError, String(error));
          assert.equal(error.code, code);
          assert.equal(error.status, status);
          return true;
        },
      );
      const after = auth.getStatusSync();
      assert.equal(after.connected && after.planEnabled, true, `HTTP ${status} kept the sign-in`);
    }
    const stream = heldStream();
    const job = summarize(binding, stream.fetchImpl);
    await stream.startedPromise;
    stream.finish();
    assert.equal(await job, 'full summary');
  });

  it('does not end a newer sign-in when the old session gets a late 401', async () => {
    const app = new ChatGPTAuth(dataDir, fake.deps());
    const alice = await app.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser });
    // Only the post-call check runs, so the late 401 reaches the binding.
    const binding = new ChatGPTBinding({ auth: app, sessionPollMs: 60_000 });
    const cli = new ChatGPTAuth(dataDir, fake.deps());
    const rejected = rejecting(401, { error: { message: 'invalid token' } }, async () => {
      await cli.signIn({
        openBrowser: (await browser(fake, ALICE)).openBrowser,
        profileId: alice.profileId,
      });
    });
    await assertSignedOutDuringJob(summarize(binding, rejected.fetchImpl));
    const status = app.getStatusSync();
    assert.equal(status.connected && status.planEnabled, true);
    const fresh = await app.openSession(alice.profileId);
    assert.equal(fresh.isActive(), true);
    assert.ok(await fresh.getAccessToken());
  });

  it('lets the job finish on its own grant when the active account is switched', async () => {
    const auth = new ChatGPTAuth(dataDir, fake.deps());
    const alice = await auth.signIn({ openBrowser: (await browser(fake, ALICE)).openBrowser });
    const binding = new ChatGPTBinding({ auth, sessionPollMs: POLL_MS });
    const stream = heldStream();
    const job = summarize(binding, stream.fetchImpl);
    await stream.startedPromise;

    const bob = await auth.signIn({
      openBrowser: (await browser(fake, BOB)).openBrowser,
      newProfile: true,
    });
    await auth.selectProfile(bob.profileId!);
    assert.equal((await auth.getStatus()).profileId, bob.profileId);
    // Several watch intervals pass with the switch in place.
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 5));
    stream.finish();
    assert.equal(await job, 'full summary');
    assert.equal(stream.state.aborted, false);
    assert.equal(await binding.profileId(), alice.profileId);
  });
});
