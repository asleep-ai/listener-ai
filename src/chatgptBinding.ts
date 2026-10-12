// One ChatGPT plan "job binding": the signed-in profile, the sign-in session
// and the model that one service instance uses for every request it makes.
//
// The binding is captured once, before the first request, through the auth
// store's `openSession`, which ties every later token and model call to that
// profile AND that sign-in grant. An account switch rebuilds services for NEW
// work only; an in-flight job keeps its binding, and a sign-out (or re-sign-in)
// of its profile makes the next token fetch fail. It never continues on
// another account or falls back to another provider or API key.

import {
  ChatGPTAuthError,
  type ChatGPTModel,
  type ChatGPTSession as ChatGPTAuthSession,
  type ChatGPTStatus,
  getChatGPTAuth,
} from './chatgptAuth';
import {
  buildChatGPTModel,
  ChatGPTInferenceError,
  type ChatGPTInferenceErrorCode,
} from './chatgptResponses';
import type { PiAiModel } from './piAiClient';

/** The slice of the ChatGPT auth API inference needs (injectable for tests). */
export interface ChatGPTAuthLike {
  getStatus(): Promise<ChatGPTStatus>;
  openSession(profileId?: string): Promise<ChatGPTAuthSession>;
}

export type ChatGPTBindingErrorCode =
  | 'not_signed_in'
  | 'plan_disabled'
  | 'signed_out_during_job'
  | 'model_unavailable'
  | 'no_models';

export class ChatGPTBindingError extends Error {
  readonly code: ChatGPTBindingErrorCode;
  readonly userMessage: string;
  constructor(code: ChatGPTBindingErrorCode, userMessage: string, options?: { cause?: unknown }) {
    super(userMessage, { cause: options?.cause });
    this.name = 'ChatGPTBindingError';
    this.code = code;
    this.userMessage = userMessage;
  }
}

export const CHATGPT_NOT_SIGNED_IN_MESSAGE =
  'Not signed in with ChatGPT. Use "Continue with ChatGPT" in Settings or run `listener chatgpt login`.';

const PLAN_DISABLED_MESSAGE =
  'ChatGPT plan usage was not granted for this sign-in. Sign in with ChatGPT again and allow plan usage, or choose Gemini in Settings.';

const SIGNED_OUT_DURING_JOB_MESSAGE =
  'The ChatGPT account this task started with is no longer signed in. The ChatGPT result was not saved; sign in with ChatGPT and try again.';

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

// Wait for a promise this binding shares across calls (the session bind, the
// model discovery) on one caller's terms: that caller's abort rejects its own
// wait with the signal's reason, while the shared work keeps running for the
// other callers and stays cached.
function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

// Auth-store failures after the binding exists. Everything that means "this
// profile/grant is gone" becomes one actionable error; transient HTTP
// failures keep the store's own message.
function mapBoundAuthError(error: unknown): unknown {
  if (isAbort(error) || !(error instanceof ChatGPTAuthError)) return error;
  switch (error.code) {
    case 'plan_disabled':
    case 'plan_grant_incomplete':
      return new ChatGPTBindingError('plan_disabled', PLAN_DISABLED_MESSAGE, { cause: error });
    case 'session_ended':
    case 'not_signed_in':
    case 'profile_not_found':
    case 'reauth_required':
    case 'invalid_grant':
      return new ChatGPTBindingError('signed_out_during_job', SIGNED_OUT_DURING_JOB_MESSAGE, {
        cause: error,
      });
    default:
      return error;
  }
}

// Responses API failures that reject the bearer itself: the user is told to
// sign in again, so the rejected session must actually end.
const REAUTH_INFERENCE_CODES = new Set<ChatGPTInferenceErrorCode>(['unauthorized', 'invalid_user']);

/** How often an in-flight call re-checks that its sign-in is still current. */
export const CHATGPT_SESSION_POLL_MS = 500;

export interface ChatGPTBindingOptions {
  /** Configured `chatgptModel`; unset means the first listed model. */
  model?: string;
  /** Bind to this profile instead of the active one (CLI, tests). */
  profileId?: string;
  auth?: ChatGPTAuthLike;
  /** Session watch interval for `run()`; defaults to CHATGPT_SESSION_POLL_MS. */
  sessionPollMs?: number;
}

export class ChatGPTBinding {
  private readonly configuredModel?: string;
  private readonly requestedProfileId?: string;
  private readonly authOverride?: ChatGPTAuthLike;
  private readonly sessionPollMs: number;
  private bound?: Promise<ChatGPTAuthSession>;
  private resolvedModel?: Promise<PiAiModel>;
  // The bearer each in-flight `run()` last fetched, keyed by the signal that
  // run hands its call, so a 401 ends the session that sent that exact token.
  private readonly runTokens = new WeakMap<AbortSignal, string | undefined>();

  constructor(options: ChatGPTBindingOptions = {}) {
    this.configuredModel = options.model?.trim() || undefined;
    this.requestedProfileId = options.profileId;
    this.authOverride = options.auth;
    this.sessionPollMs = options.sessionPollMs ?? CHATGPT_SESSION_POLL_MS;
  }

  private auth(): ChatGPTAuthLike {
    return this.authOverride ?? getChatGPTAuth();
  }

  /** The auth session this binding uses. Captured once, then fixed. */
  private session(): Promise<ChatGPTAuthSession> {
    if (!this.bound) {
      const binding = (async () => {
        const auth = this.auth();
        if (!this.requestedProfileId) {
          const status = await auth.getStatus();
          if (!status.connected || !status.profileId) {
            throw new ChatGPTBindingError('not_signed_in', CHATGPT_NOT_SIGNED_IN_MESSAGE);
          }
          if (!status.planEnabled) {
            throw new ChatGPTBindingError('plan_disabled', PLAN_DISABLED_MESSAGE);
          }
          return await auth.openSession(status.profileId);
        }
        return await auth.openSession(this.requestedProfileId);
      })().catch((error: unknown) => {
        if (
          error instanceof ChatGPTAuthError &&
          (error.code === 'plan_disabled' || error.code === 'plan_grant_incomplete')
        ) {
          throw new ChatGPTBindingError('plan_disabled', PLAN_DISABLED_MESSAGE, { cause: error });
        }
        if (error instanceof ChatGPTAuthError) {
          throw new ChatGPTBindingError('not_signed_in', CHATGPT_NOT_SIGNED_IN_MESSAGE, {
            cause: error,
          });
        }
        throw error;
      });
      // A failed bind (not signed in yet) must not stick: the next job after
      // the user signs in gets a fresh capture.
      binding.catch(() => {
        if (this.bound === binding) this.bound = undefined;
      });
      this.bound = binding;
    }
    return this.bound;
  }

  /**
   * Run one ChatGPT request under a session watch. Semantics, bounded by
   * `sessionPollMs`:
   *   - the bound sign-in must be current before the call starts;
   *   - while the call is in flight, the stored session is re-checked every
   *     `sessionPollMs`; once it ends (sign-out from this or any other
   *     process, including sign-out followed by a new sign-in of the same
   *     profile) the call's signal is aborted, which tears down the stream;
   *   - after the call settles the session is checked once more, so a
   *     response that completed after the sign-out is discarded too.
   * In all three cases the result is `ChatGPTBindingError('signed_out_during_job')`
   * and the caller never sees any (partial or complete) text. Switching the
   * active account does not end the session: the job finishes on the grant
   * it started with. A caller abort (`signal`) rejects with the signal's
   * reason, including while the call still waits on the shared session bind,
   * model discovery or token refresh.
   */
  async run<T>(
    signal: AbortSignal | undefined,
    call: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    signal?.throwIfAborted();
    const session = await untilAborted(this.session(), signal);
    const signedOut = (cause?: unknown) =>
      new ChatGPTBindingError('signed_out_during_job', SIGNED_OUT_DURING_JOB_MESSAGE, { cause });
    if (!session.isActive()) throw signedOut();
    // The caller may have aborted while the session was being bound; an
    // 'abort' listener added now would never fire.
    signal?.throwIfAborted();

    const controller = new AbortController();
    this.runTokens.set(controller.signal, undefined);
    let ended = false;
    const onCallerAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onCallerAbort, { once: true });
    const timer = setInterval(() => {
      if (!session.isActive()) {
        ended = true;
        controller.abort(signedOut());
      }
    }, this.sessionPollMs);
    timer.unref?.();
    try {
      const result = await call(controller.signal);
      if (ended || !session.isActive()) throw signedOut();
      return result;
    } catch (error) {
      if (error instanceof ChatGPTBindingError) throw error;
      if (error instanceof ChatGPTInferenceError && REAUTH_INFERENCE_CODES.has(error.code)) {
        // End the session that sent the rejected bearer, so status and
        // Settings stop treating it as signed in. A session that already
        // ended another way (sign-out, a newer sign-in) is left to the
        // signed-out path below. Best effort: a store failure still surfaces
        // the sign-in-again error.
        const rejected = this.runTokens.get(controller.signal);
        const endedHere = rejected
          ? await session.endRejectedSession(rejected).catch(() => false)
          : false;
        if (endedHere) throw error;
      }
      if (ended || (!signal?.aborted && !session.isActive())) throw signedOut(error);
      // The auth store reports a cancelled wait as its own `cancelled` error;
      // the caller sees its own abort instead.
      if (signal?.aborted) throw abortReason(signal);
      throw mapBoundAuthError(error);
    } finally {
      clearInterval(timer);
      signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  /**
   * Throw `signed_out_during_job` when the bound sign-in has ended. A binding
   * that never bound (no request made yet) has nothing to check.
   */
  async assertActive(): Promise<void> {
    if (!this.bound) return;
    const session = await this.bound;
    if (!session.isActive()) {
      throw new ChatGPTBindingError('signed_out_during_job', SIGNED_OUT_DURING_JOB_MESSAGE);
    }
  }

  /** The profile id this binding is pinned to. */
  async profileId(): Promise<string> {
    return (await this.session()).profileId;
  }

  /** A bearer for the bound profile and grant. Fails once it signs out. */
  async accessToken(signal?: AbortSignal): Promise<string> {
    const session = await untilAborted(this.session(), signal);
    try {
      const token = await session.getAccessToken(signal);
      if (signal && this.runTokens.has(signal)) this.runTokens.set(signal, token);
      return token;
    } catch (error) {
      throw mapBoundAuthError(error);
    }
  }

  /** The account's listed models, in server order. */
  async listModels(signal?: AbortSignal): Promise<ChatGPTModel[]> {
    const session = await untilAborted(this.session(), signal);
    try {
      return await session.listModels(signal);
    } catch (error) {
      throw mapBoundAuthError(error);
    }
  }

  /**
   * The account-discovered model, resolved once per binding. A configured
   * slug the account does not list is an error, never a substitution. The
   * discovery is shared and runs under no caller's signal; `signal` only
   * ends this caller's wait.
   */
  model(signal?: AbortSignal): Promise<PiAiModel> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (!this.resolvedModel) {
      const resolving = (async () => {
        const listed = await this.listModels();
        if (listed.length === 0) {
          throw new ChatGPTBindingError(
            'no_models',
            'This ChatGPT account lists no models available for plan usage.',
          );
        }
        if (!this.configuredModel) return buildChatGPTModel(listed[0]);
        const match = listed.find((entry) => entry.slug === this.configuredModel);
        if (!match) {
          throw new ChatGPTBindingError(
            'model_unavailable',
            `ChatGPT model "${this.configuredModel}" is not available to this account. Choose one of: ${listed
              .map((entry) => entry.slug)
              .join(', ')} (Settings, or \`listener chatgpt models\`).`,
          );
        }
        return buildChatGPTModel(match);
      })();
      resolving.catch(() => {
        if (this.resolvedModel === resolving) this.resolvedModel = undefined;
      });
      this.resolvedModel = resolving;
    }
    return untilAborted(this.resolvedModel, signal);
  }
}
