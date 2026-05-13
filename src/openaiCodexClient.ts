import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_CODEX_MODEL, DEFAULT_CODEX_TRANSCRIPTION_MODEL } from './aiProvider';
import { mimeTypeForExtension } from './audioFormats';

const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const OPENAI_API_BASE_URL = 'https://api.openai.com/v1';
const CHATGPT_AUTH_CLAIM = 'https://api.openai.com/auth';

export const OPENAI_TRANSCRIPTION_EXTENSIONS = new Set([
  '.mp3',
  '.mp4',
  '.mpeg',
  '.mpga',
  '.m4a',
  '.wav',
  '.webm',
]);

export type CodexTokenProvider = () => Promise<string>;

export class CodexAccountIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexAccountIdError';
  }
}

function extractCodexAccountId(token: string): string {
  try {
    const [, payloadPart] = token.split('.');
    if (!payloadPart) throw new Error('Token missing JWT payload segment');
    const normalized = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf-8')) as Record<
      string,
      unknown
    >;
    const auth = payload[CHATGPT_AUTH_CLAIM] as { chatgpt_account_id?: unknown } | undefined;
    if (typeof auth?.chatgpt_account_id !== 'string' || auth.chatgpt_account_id.length === 0) {
      throw new Error('Token payload missing chatgpt_account_id claim');
    }
    return auth.chatgpt_account_id;
  } catch (error) {
    // Surface re-login hint without leaking the raw token. The Error name lets
    // upstream IPC handlers detect this case and prompt the user explicitly.
    const cause = error instanceof Error ? error.message : String(error);
    throw new CodexAccountIdError(
      `Codex session invalid (${cause}). Please run \`listener codex login\` to re-authenticate.`,
    );
  }
}

function buildCodexHeaders(token: string): Headers {
  const headers = new Headers();
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('chatgpt-account-id', extractCodexAccountId(token));
  headers.set('originator', 'listener-ai');
  headers.set('User-Agent', `listener-ai (${process.platform}; ${process.arch})`);
  headers.set('OpenAI-Beta', 'responses=experimental');
  headers.set('accept', 'text/event-stream');
  headers.set('content-type', 'application/json');
  return headers;
}

function extractResponseText(response: unknown): string {
  const outputText = (response as { output_text?: unknown }).output_text;
  if (typeof outputText === 'string') return outputText;

  const output = (response as { output?: unknown }).output;
  if (!Array.isArray(output)) return '';

  const chunks: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const text = (part as { text?: unknown }).text;
      if (typeof text === 'string') chunks.push(text);
    }
  }
  return chunks.join('\n').trim();
}

function inputTextMessage(text: string): Record<string, unknown> {
  return {
    role: 'user',
    content: [{ type: 'input_text', text }],
  };
}

// Find the next SSE event boundary. Servers may emit \n\n or \r\n\r\n separators
// depending on platform; handle both. Returns the index past the separator or -1.
function findSseBoundary(buffer: string): { end: number; sep: number } | null {
  let bestEnd = -1;
  let bestSep = 0;
  const lf = buffer.indexOf('\n\n');
  if (lf !== -1) {
    bestEnd = lf;
    bestSep = 2;
  }
  const crlf = buffer.indexOf('\r\n\r\n');
  if (crlf !== -1 && (bestEnd === -1 || crlf < bestEnd)) {
    bestEnd = crlf;
    bestSep = 4;
  }
  return bestEnd === -1 ? null : { end: bestEnd, sep: bestSep };
}

async function* parseSse(response: Response): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = findSseBoundary(buffer);
      while (boundary !== null) {
        const chunk = buffer.slice(0, boundary.end);
        buffer = buffer.slice(boundary.end + boundary.sep);
        const data = chunk
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n')
          .trim();
        if (data && data !== '[DONE]') {
          // Skip malformed events instead of unwinding the whole stream. SSE servers
          // can emit non-JSON keepalive frames or split a payload mid-boundary in ways
          // the heuristic above misses; the user-visible behavior should be a single
          // warn line, not an aborted transcription with partial output discarded.
          try {
            yield JSON.parse(data) as Record<string, unknown>;
          } catch (error) {
            console.warn(
              `SSE: skipping malformed event (${error instanceof Error ? error.message : String(error)}).`,
            );
          }
        }
        boundary = findSseBoundary(buffer);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// Whitelist a few well-known fields from SSE event payloads when including them
// in user-visible error messages. Avoids JSON.stringify'ing the raw event, which
// could leak upstream debug info (headers, prompt fragments) into logs/UI.
function summarizeCodexEvent(event: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof event.type === 'string') parts.push(`type=${event.type}`);
  if (event.error && typeof event.error === 'object') {
    const err = event.error as Record<string, unknown>;
    if (typeof err.code === 'string') parts.push(`code=${err.code}`);
    if (typeof err.message === 'string') parts.push(`message=${err.message}`);
  } else if (typeof (event as { message?: unknown }).message === 'string') {
    parts.push(`message=${(event as { message: string }).message}`);
  }
  const response = (event as { response?: unknown }).response;
  if (response && typeof response === 'object') {
    const r = response as Record<string, unknown>;
    if (typeof r.status === 'string') parts.push(`status=${r.status}`);
    if (typeof r.id === 'string') parts.push(`id=${r.id}`);
  }
  return parts.length > 0 ? parts.join(', ') : 'no details';
}

async function createCodexResponseFetch(params: {
  getToken: CodexTokenProvider;
  model?: string;
  instructions?: string;
  input: unknown[];
  tools?: unknown[];
}): Promise<unknown> {
  const token = await params.getToken();
  const body = {
    model: params.model?.trim() || DEFAULT_CODEX_MODEL,
    store: false,
    stream: true,
    instructions: params.instructions || 'You are a helpful assistant.',
    input: params.input,
    text: { verbosity: 'low' },
    include: ['reasoning.encrypted_content'],
    tool_choice: 'auto',
    parallel_tool_calls: true,
    ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
  };

  const response = await fetch(CODEX_RESPONSES_URL, {
    method: 'POST',
    headers: buildCodexHeaders(token),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    // Don't echo the raw error body verbatim -- it can include upstream debug info.
    // Truncate to keep logs/UI bounded and avoid leaking large payloads.
    const errorBody = await response.text().catch(() => '');
    const trimmed = errorBody.length > 500 ? `${errorBody.slice(0, 500)}...` : errorBody;
    throw new Error(
      `Codex Responses failed (${response.status} ${response.statusText})${trimmed ? `: ${trimmed}` : ''}`,
    );
  }

  const outputItems: unknown[] = [];
  let completedResponse: Record<string, unknown> | undefined;
  let textFromDeltas = '';
  // Distinguishes a clean stream-end from a mid-stream connection drop. Without
  // this, EOF without a terminal event silently resolves to partial output.
  let sawTerminalEvent = false;

  for await (const event of parseSse(response)) {
    const type = typeof event.type === 'string' ? event.type : '';
    if (type === 'error') {
      throw new Error(`Codex error: ${summarizeCodexEvent(event)}`);
    }
    if (type === 'response.failed') {
      throw new Error(`Codex response failed: ${summarizeCodexEvent(event)}`);
    }
    if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
      textFromDeltas += event.delta;
    }
    if (type === 'response.output_item.done' && event.item) {
      outputItems.push(event.item);
    }
    if (
      type === 'response.completed' ||
      type === 'response.done' ||
      type === 'response.incomplete'
    ) {
      sawTerminalEvent = true;
      const responsePayload = event.response;
      if (responsePayload && typeof responsePayload === 'object') {
        completedResponse = responsePayload as Record<string, unknown>;
      }
    }
  }

  if (!sawTerminalEvent) {
    throw new Error(
      'Codex Responses stream ended without a terminal event (likely a network drop). ' +
        'Retry the request.',
    );
  }

  const completedOutput = completedResponse?.output;
  const output = Array.isArray(completedOutput) ? completedOutput : outputItems;
  const outputText = extractResponseText({ output }) || textFromDeltas.trim();
  return { ...completedResponse, output, output_text: outputText };
}

export async function generateCodexResponseText(params: {
  getToken: CodexTokenProvider;
  model?: string;
  instructions?: string;
  inputText: string;
}): Promise<string> {
  const response = await createCodexResponseFetch({
    getToken: params.getToken,
    model: params.model,
    instructions: params.instructions,
    input: [inputTextMessage(params.inputText)],
  });
  return extractResponseText(response);
}

export async function createCodexResponse(params: {
  getToken: CodexTokenProvider;
  model?: string;
  instructions?: string;
  input: unknown[];
  tools?: unknown[];
}): Promise<unknown> {
  return await createCodexResponseFetch(params);
}

export function extractCodexResponseText(response: unknown): string {
  return extractResponseText(response);
}

// Internal helpers exported for tests. Not part of the public API.
export const __testing = {
  extractCodexAccountId,
  parseSse,
  summarizeCodexEvent,
  findSseBoundary,
};

export async function transcribeCodexAudio(params: {
  getToken: CodexTokenProvider;
  audioFilePath: string;
  model?: string;
  prompt?: string;
}): Promise<string> {
  const audioData = fs.readFileSync(params.audioFilePath);
  const ext = path.extname(params.audioFilePath);
  const form = new FormData();
  form.append('model', params.model?.trim() || DEFAULT_CODEX_TRANSCRIPTION_MODEL);
  if (params.prompt?.trim()) {
    form.append('prompt', params.prompt.trim());
  }
  form.append(
    'file',
    new Blob([audioData], { type: mimeTypeForExtension(ext) }),
    path.basename(params.audioFilePath),
  );

  const response = await fetch(`${OPENAI_API_BASE_URL}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await params.getToken()}`,
    },
    body: form,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const trimmed = body.length > 500 ? `${body.slice(0, 500)}...` : body;
    throw new Error(
      `OpenAI transcription failed (${response.status} ${response.statusText})${trimmed ? `: ${trimmed}` : ''}`,
    );
  }

  const payload = (await response.json()) as { text?: unknown };
  if (typeof payload.text !== 'string' || payload.text.trim().length === 0) {
    throw new Error('OpenAI transcription response missing text');
  }
  return payload.text;
}
