// Request/response contract for Sign in with ChatGPT (SIWC) plan-usage
// inference on the public Responses API. Pure: no auth, no network, no pi-ai
// runtime import, so piAiClient.ts and tests can use it directly.
//
// Transport is pi-ai's public `openai-responses` API (OpenAI SDK underneath,
// no hand-rolled SSE). pi-ai's request builder targets the regular API-key
// route, so the `onPayload` hook below rewrites its body onto the SIWC
// contract (developers.openai.com/siwc/token-sharing-open-source/
// preview-limitations and models-and-inference):
//   - `store: false` and `stream: true` on every request.
//   - Unsupported fields are omitted: background, conversation,
//     max_output_tokens, max_tool_calls, metadata, moderation, multi_agent,
//     prompt, prompt_cache_retention, safety_identifier, temperature,
//     top_logprobs, top_p, truncation, user. `previous_response_id` is not
//     allowed over HTTP; the full history travels in `input`.
//   - "explicit {type: "message", role: "system"} items are rejected": the
//     system prompt moves to `instructions`.
//   - "Group function/custom tools in namespaces": top-level function/custom
//     tools are wrapped in one `namespace` tool, and replayed tool calls carry
//     the matching `namespace` field.
// The body is rebuilt from an allowlist rather than a denylist, so a pi-ai
// upgrade that starts emitting a new field cannot leak it onto this route.

import type { Api, Model } from '@earendil-works/pi-ai';

/** pi-ai provider id registered on the shared Models (see piAiClient.ts). */
export const CHATGPT_PI_PROVIDER = 'chatgpt';
export const CHATGPT_RESPONSES_BASE_URL = 'https://api.openai.com/v1';
export const CHATGPT_MANAGE_USAGE_URL = 'https://chatgpt.com/settings/usage';
/** Namespace that groups every Listener function tool on this route. */
export const CHATGPT_TOOL_NAMESPACE = 'listener';
const CHATGPT_TOOL_NAMESPACE_DESCRIPTION = 'Listener.AI meeting notes and settings tools.';

// Fields kept from pi-ai's body. Anything else is dropped.
const ALLOWED_BODY_KEYS = new Set([
  'model',
  'input',
  'instructions',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'reasoning',
  'include',
  'text',
]);

export interface ChatGPTModelEntry {
  slug: string;
  display_name?: string;
}

/**
 * pi-ai model object for an account-discovered slug. The bundled catalog does
 * not know account-specific slugs, so we build the object instead of looking
 * it up (a lookup would silently fall back to some other model).
 *
 * `reasoning: false` keeps pi-ai from emitting `reasoning` / `include`: the
 * model list carries no capability flags, and the docs list no accepted
 * reasoning efforts for this route. The zero cost is a transport placeholder,
 * NOT a measured price: these calls consume the user's ChatGPT plan (or plan
 * credits), and usage records mark them `billing: 'chatgpt-plan'` instead of
 * presenting them as $0 API spend.
 */
export function buildChatGPTModel(entry: ChatGPTModelEntry): Model<Api> {
  return {
    id: entry.slug,
    name: entry.display_name || entry.slug,
    api: 'openai-responses',
    provider: CHATGPT_PI_PROVIDER,
    baseUrl: CHATGPT_RESPONSES_BASE_URL,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // Unknown per account. 0 disables pi-ai's context clamp; the request
    // never carries max_output_tokens anyway.
    contextWindow: 0,
    maxTokens: 0,
  } as Model<Api>;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .filter((text) => text.length > 0)
    .join('\n');
}

function isInstructionItem(item: unknown): item is JsonRecord {
  return (
    isRecord(item) &&
    (item.type === undefined || item.type === 'message') &&
    (item.role === 'system' || item.role === 'developer')
  );
}

function toNamespaceMember(tool: JsonRecord): JsonRecord {
  // Namespace members take the same function/custom shape minus
  // `defer_loading`, which belongs to `tool_search` (unsupported here).
  const { defer_loading: _deferLoading, ...rest } = tool;
  return rest;
}

/**
 * Rewrite a pi-ai `openai-responses` body onto the SIWC contract. Returns a
 * new object; the input is not mutated.
 */
export function toChatGPTResponsesPayload(params: unknown): JsonRecord {
  if (!isRecord(params)) throw new Error('ChatGPT request body must be an object.');
  const body: JsonRecord = {};
  for (const [key, value] of Object.entries(params)) {
    if (ALLOWED_BODY_KEYS.has(key) && value !== undefined) body[key] = value;
  }

  const instructions: string[] = [];
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    instructions.push(body.instructions);
  }

  const namespacedToolNames = new Set<string>();
  if (Array.isArray(body.tools)) {
    const members: JsonRecord[] = [];
    const others: unknown[] = [];
    for (const tool of body.tools) {
      if (isRecord(tool) && (tool.type === 'function' || tool.type === 'custom')) {
        members.push(toNamespaceMember(tool));
        if (typeof tool.name === 'string') namespacedToolNames.add(tool.name);
      } else {
        others.push(tool);
      }
    }
    const tools = [...others];
    if (members.length > 0) {
      tools.push({
        type: 'namespace',
        name: CHATGPT_TOOL_NAMESPACE,
        description: CHATGPT_TOOL_NAMESPACE_DESCRIPTION,
        tools: members,
      });
    }
    if (tools.length > 0) body.tools = tools;
    else delete body.tools;
  }

  const input: unknown[] = [];
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (isInstructionItem(item)) {
      const text = messageText(item.content);
      if (text.trim()) instructions.push(text);
      continue;
    }
    if (
      isRecord(item) &&
      (item.type === 'function_call' || item.type === 'custom_tool_call') &&
      typeof item.name === 'string' &&
      namespacedToolNames.has(item.name) &&
      item.namespace === undefined
    ) {
      input.push({ ...item, namespace: CHATGPT_TOOL_NAMESPACE });
      continue;
    }
    input.push(item);
  }
  body.input = input;
  // An explicit function/custom tool_choice must name the namespace too, or
  // it would point at a tool that no longer exists at the top level.
  if (
    isRecord(body.tool_choice) &&
    (body.tool_choice.type === 'function' || body.tool_choice.type === 'custom') &&
    typeof body.tool_choice.name === 'string' &&
    namespacedToolNames.has(body.tool_choice.name) &&
    body.tool_choice.namespace === undefined
  ) {
    body.tool_choice = { ...body.tool_choice, namespace: CHATGPT_TOOL_NAMESPACE };
  }
  if (instructions.length > 0) body.instructions = instructions.join('\n\n');
  else delete body.instructions;

  body.store = false;
  body.stream = true;
  return body;
}

/** Tool names may come back qualified by their namespace; strip it. */
export function stripChatGPTToolNamespace(name: string): string {
  for (const separator of ['.', '__', '/', ':']) {
    const prefix = `${CHATGPT_TOOL_NAMESPACE}${separator}`;
    if (name.startsWith(prefix)) return name.slice(prefix.length);
  }
  return name;
}

export type ChatGPTInferenceErrorCode =
  | 'usage_limit_exceeded'
  | 'usage_unavailable'
  | 'not_eligible'
  | 'unsupported_capability'
  | 'route_not_supported'
  | 'invalid_user'
  | 'user_unavailable'
  | 'unauthorized'
  | 'incomplete'
  | 'failed';

/**
 * A ChatGPT plan inference failure. Never retried on another provider, key or
 * account: OpenAI "does not silently switch the request to another billing
 * path", and neither do we.
 */
export class ChatGPTInferenceError extends Error {
  readonly code: ChatGPTInferenceErrorCode;
  readonly userMessage: string;
  /** Present when the user's next step is ChatGPT Settings -> Usage. */
  readonly manageUsageUrl?: string;
  /** HTTP status when the failure was an HTTP response. */
  readonly status?: number;

  constructor(
    code: ChatGPTInferenceErrorCode,
    userMessage: string,
    options?: { cause?: unknown; rawMessage?: string; manageUsage?: boolean; status?: number },
  ) {
    super(options?.rawMessage ? `${userMessage} (${options.rawMessage})` : userMessage, {
      cause: options?.cause,
    });
    this.name = 'ChatGPTInferenceError';
    this.code = code;
    this.userMessage = userMessage;
    if (options?.manageUsage) this.manageUsageUrl = CHATGPT_MANAGE_USAGE_URL;
    if (options?.status !== undefined) this.status = options.status;
  }
}

const SIGN_IN_AGAIN =
  'Your ChatGPT sign-in is no longer valid. Sign in with ChatGPT again (Settings, or `listener chatgpt login`).';

/** Map a pi-ai error message from the ChatGPT route onto an actionable error. */
// pi-ai formats HTTP failures as `OpenAI API error (403): <body>` or
// `403: <body>`. The body is the provider's error JSON (never the request).
function httpStatusOf(rawMessage: string): number | undefined {
  const match = rawMessage.match(/\((\d{3})\):|^(\d{3}):/);
  const value = match ? Number(match[1] ?? match[2]) : NaN;
  return Number.isFinite(value) ? value : undefined;
}

export function toChatGPTInferenceError(rawMessage: string): ChatGPTInferenceError {
  const error = classifyChatGPTError(rawMessage);
  const status = httpStatusOf(rawMessage);
  if (status === undefined) return error;
  return new ChatGPTInferenceError(error.code, error.userMessage, {
    rawMessage: rawMessage.slice(0, 500),
    manageUsage: error.manageUsageUrl !== undefined,
    status,
  });
}

function classifyChatGPTError(rawMessage: string): ChatGPTInferenceError {
  const raw = rawMessage.slice(0, 500);
  const has = (code: string) => rawMessage.includes(code);
  if (has('subscription_sharing_usage_limit_exceeded')) {
    return new ChatGPTInferenceError(
      'usage_limit_exceeded',
      'You reached your ChatGPT plan usage limit. Open Manage usage to check when it resets.',
      { rawMessage: raw, manageUsage: true },
    );
  }
  if (has('subscription_sharing_usage_unavailable')) {
    return new ChatGPTInferenceError(
      'usage_unavailable',
      'ChatGPT plan usage is temporarily unavailable. Try again later or open Manage usage.',
      { rawMessage: raw, manageUsage: true },
    );
  }
  if (has('subscription_sharing_user_not_eligible') || has('chatpass_v2_')) {
    return new ChatGPTInferenceError(
      'not_eligible',
      'This ChatGPT account cannot use its plan in Listener.AI (ChatGPT Plus or Pro is required).',
      { rawMessage: raw, manageUsage: true },
    );
  }
  if (has('subscription_sharing_unsupported_capability')) {
    return new ChatGPTInferenceError(
      'unsupported_capability',
      'The selected ChatGPT model does not support this request. Choose another ChatGPT model in Settings.',
      { rawMessage: raw },
    );
  }
  if (has('subscription_sharing_route_not_supported')) {
    return new ChatGPTInferenceError(
      'route_not_supported',
      'This request is not supported with a ChatGPT plan.',
      { rawMessage: raw },
    );
  }
  if (has('subscription_sharing_invalid_user')) {
    return new ChatGPTInferenceError('invalid_user', SIGN_IN_AGAIN, { rawMessage: raw });
  }
  if (has('subscription_sharing_user_unavailable')) {
    return new ChatGPTInferenceError(
      'user_unavailable',
      'Your ChatGPT account is temporarily unavailable. Try again later.',
      { rawMessage: raw },
    );
  }
  if (/\b401\b/.test(rawMessage)) {
    return new ChatGPTInferenceError('unauthorized', SIGN_IN_AGAIN, { rawMessage: raw });
  }
  if (/\b429\b/.test(rawMessage)) {
    return new ChatGPTInferenceError(
      'usage_limit_exceeded',
      'ChatGPT rate or usage limit reached. Try again later or open Manage usage.',
      { rawMessage: raw, manageUsage: true },
    );
  }
  return new ChatGPTInferenceError('failed', 'The ChatGPT request failed.', { rawMessage: raw });
}
