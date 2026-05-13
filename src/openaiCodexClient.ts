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

function extractCodexAccountId(token: string): string {
  try {
    const [, payloadPart] = token.split('.');
    if (!payloadPart) throw new Error('Invalid token');
    const normalized = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf-8')) as Record<
      string,
      unknown
    >;
    const auth = payload[CHATGPT_AUTH_CLAIM] as { chatgpt_account_id?: unknown } | undefined;
    if (typeof auth?.chatgpt_account_id !== 'string' || auth.chatgpt_account_id.length === 0) {
      throw new Error('Missing account id');
    }
    return auth.chatgpt_account_id;
  } catch {
    throw new Error('Failed to extract Codex account id from token');
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
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = chunk
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n')
          .trim();
        if (data && data !== '[DONE]') {
          yield JSON.parse(data) as Record<string, unknown>;
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
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
    const errorBody = await response.text().catch(() => '');
    throw new Error(
      `Codex Responses failed (${response.status} ${response.statusText})${errorBody ? `: ${errorBody}` : ''}`,
    );
  }

  const outputItems: unknown[] = [];
  let completedResponse: Record<string, unknown> | undefined;
  let textFromDeltas = '';

  for await (const event of parseSse(response)) {
    const type = typeof event.type === 'string' ? event.type : '';
    if (type === 'error') {
      throw new Error(`Codex error: ${JSON.stringify(event)}`);
    }
    if (type === 'response.failed') {
      throw new Error(`Codex response failed: ${JSON.stringify(event.response ?? event)}`);
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
      const responsePayload = event.response;
      if (responsePayload && typeof responsePayload === 'object') {
        completedResponse = responsePayload as Record<string, unknown>;
      }
    }
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
    throw new Error(
      `OpenAI transcription failed (${response.status} ${response.statusText})${body ? `: ${body}` : ''}`,
    );
  }

  const payload = (await response.json()) as { text?: unknown };
  if (typeof payload.text !== 'string' || payload.text.trim().length === 0) {
    throw new Error('OpenAI transcription response missing text');
  }
  return payload.text;
}
