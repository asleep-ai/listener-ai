import * as path from 'path';
import { DEFAULT_CODEX_MODEL, type AiProvider } from './aiProvider';
import { type CodexOAuthCredentials, requireCodexAccessToken } from './codexOAuth';
import type { ConfigService } from './configService';
import {
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type Tool,
  type ToolCall,
  complete,
  getModel,
  getTypeBox,
} from './piAiClient';
import {
  type ReadTranscriptionResult,
  getTranscriptionsDir,
  listTranscriptions,
  readTranscription,
} from './outputService';
import { ALL_FIELDS, type SearchField, searchTranscriptions } from './searchService';

export type AgentScope = { kind: 'all' } | { kind: 'single'; folderName: string };

export interface ConfigProposal {
  kind: 'setConfig';
  key: WritableConfigKey;
  value: unknown;
  currentValue?: unknown;
  description: string;
}

export type AgentConfirmHandler = (proposal: ConfigProposal) => Promise<boolean>;

export interface AgentChatMessage {
  role: 'user' | 'model';
  text: string;
  // Raw pi-ai messages belonging to this turn. Populated on model messages so
  // the next run replays the full tool-call cluster (assistant turn + tool
  // results), not just the final text. Older history entries written before
  // the pi-ai migration may carry provider-specific `turns`/`codexItems`
  // fields -- those are ignored and the message replays as plain text.
  piaiMessages?: Message[];
}

export interface AgentRunOptions {
  question: string;
  history?: AgentChatMessage[];
  scope: AgentScope;
  confirm?: AgentConfirmHandler;
  model?: string;
  maxSteps?: number;
}

export interface AppliedAction {
  type: 'setConfig';
  key: string;
  value: unknown;
  previousValue: unknown;
}

export interface AgentRunResult {
  answer: string;
  appliedActions: AppliedAction[];
  history: AgentChatMessage[];
}

export const WRITABLE_CONFIG_KEYS = [
  'autoMode',
  'meetingDetection',
  'displayDetection',
  'globalShortcut',
  'maxRecordingMinutes',
  'recordingReminderMinutes',
  'minRecordingSeconds',
  'recordSystemAudio',
] as const;

export type WritableConfigKey = (typeof WRITABLE_CONFIG_KEYS)[number];

export const READABLE_CONFIG_KEYS = [
  ...WRITABLE_CONFIG_KEYS,
  'aiProvider',
  'geminiModel',
  'geminiFlashModel',
  'codexModel',
  'codexTranscriptionModel',
] as const;

export type ReadableConfigKey = (typeof READABLE_CONFIG_KEYS)[number];

function isWritableKey(key: string): key is WritableConfigKey {
  return (WRITABLE_CONFIG_KEYS as readonly string[]).includes(key);
}

function isReadableKey(key: string): key is ReadableConfigKey {
  return (READABLE_CONFIG_KEYS as readonly string[]).includes(key);
}

/** Coerce agent-supplied value to the right type per key. */
export function coerceConfigValue(
  key: WritableConfigKey,
  raw: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  switch (key) {
    case 'autoMode':
    case 'meetingDetection':
    case 'displayDetection':
    case 'recordSystemAudio': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      if (raw === 'true') return { ok: true, value: true };
      if (raw === 'false') return { ok: true, value: false };
      return { ok: false, error: `${key} expects a boolean` };
    }
    case 'globalShortcut': {
      if (typeof raw !== 'string' || raw.trim() === '') {
        return { ok: false, error: `${key} expects a non-empty string` };
      }
      return { ok: true, value: raw.trim() };
    }
    case 'maxRecordingMinutes':
    case 'recordingReminderMinutes':
    case 'minRecordingSeconds': {
      const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
      if (!Number.isFinite(n) || n < 0) {
        return { ok: false, error: `${key} expects a non-negative integer` };
      }
      return { ok: true, value: Math.floor(n) };
    }
  }
}

// Pi-ai validates tool arguments against TypeBox schemas. We build them lazily
// because TypeBox lives inside the ESM-only pi-ai package; resolving the
// schemas in module scope would fire a synchronous require() before pi-ai is
// loaded.
async function buildTools(scope: AgentScope, hasConfirm: boolean): Promise<Tool[]> {
  const Type = await getTypeBox();
  const tools: Tool[] = [];

  if (scope.kind === 'all') {
    tools.push({
      name: 'search_transcriptions',
      description:
        'Full-text search across saved meeting transcriptions. Returns top-k hits with title, date, snippet, and folder name. Use this to find meetings relevant to the user question.',
      parameters: Type.Object({
        query: Type.String({ description: 'Search keywords. Can be Korean or English.' }),
        limit: Type.Optional(Type.Integer({ description: 'Max hits to return (default 5).' })),
        include_transcript: Type.Optional(
          Type.Boolean({
            description: 'Also search the full transcript body (slower). Default false.',
          }),
        ),
      }),
    });

    tools.push({
      name: 'list_recent_transcriptions',
      description:
        'List the most recent saved transcriptions, newest first. Use when the user asks "what did we talk about recently" or "show me yesterday\'s meetings".',
      parameters: Type.Object({
        limit: Type.Optional(Type.Integer({ description: 'Max entries (default 10).' })),
      }),
    });

    tools.push({
      name: 'get_transcription',
      description:
        'Fetch a saved meeting record (summary, key points, action items) by folder name. Pass include_transcript=true only when you need the verbatim transcript body; omit it for summary-level questions to keep the response compact.',
      parameters: Type.Object({
        folder_name: Type.String({
          description:
            'The folderName returned by search_transcriptions or list_recent_transcriptions.',
        }),
        include_transcript: Type.Optional(
          Type.Boolean({ description: 'Include the full transcript body. Default false.' }),
        ),
      }),
    });
  }

  tools.push({
    name: 'get_config',
    description: `Read a single Listener.AI setting value. Allowed keys: ${READABLE_CONFIG_KEYS.join(', ')}. API keys and database IDs are never readable here.`,
    parameters: Type.Object({
      key: Type.String({ description: `One of: ${READABLE_CONFIG_KEYS.join(', ')}` }),
    }),
  });

  if (hasConfirm) {
    tools.push({
      name: 'set_config',
      description: `Propose a change to a Listener.AI setting. Requires user confirmation before taking effect. Allowed keys: ${WRITABLE_CONFIG_KEYS.join(', ')}. Do NOT try to set API keys, Notion database ID, or other credentials here.`,
      parameters: Type.Object({
        key: Type.String({ description: `One of: ${WRITABLE_CONFIG_KEYS.join(', ')}` }),
        value: Type.String({
          description:
            'The new value. For booleans pass "true"/"false"; for numbers pass the digits as a string; for strings pass the string.',
        }),
        reason: Type.Optional(
          Type.String({
            description:
              'Short human-readable reason shown to the user in the confirmation prompt.',
          }),
        ),
      }),
    });
  }

  return tools;
}

function systemInstructionFor(scope: AgentScope, currentTranscriptionTitle?: string): string {
  const common = `You are the assistant inside Listener.AI, a Korean-first meeting recorder. Answer concisely in the user's language (default to Korean if the question is in Korean). Ground factual claims in tool results — never invent meeting content. If the user asks for something outside your tools (e.g. sending email, starting a recording), politely say you can't do that yet.`;

  if (scope.kind === 'single') {
    return `${common}\n\nYou are currently focused on a single meeting titled "${currentTranscriptionTitle ?? 'this meeting'}". The full transcription data is already provided in the conversation. Prefer answering directly from that data. Do not call search_transcriptions or list_recent_transcriptions in this mode — they are disabled. You may still read or change app settings via get_config / set_config (set_config always requires user confirmation).`;
  }

  return `${common}\n\nScope: ALL saved meetings. Use search_transcriptions to find relevant meetings (title/summary/key points are searched by default; pass include_transcript=true if keywords are likely only in the transcript body). Use list_recent_transcriptions for "recent/latest" questions. Use get_transcription to read a specific meeting when you have its folder name.`;
}

/** Reject folder names that could escape the transcriptions directory. A valid
 *  entry produced by `saveTranscription` never contains path separators, so we
 *  can keep the guard simple without duplicating the sanitizer. */
export function isValidFolderName(name: string): boolean {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  if (name.startsWith('.')) return false;
  return true;
}

function buildSinglePrimer(data: ReadTranscriptionResult): string {
  const lines: string[] = [];
  lines.push(
    `[Context: meeting "${data.title}"${data.transcribedAt ? ` recorded ${data.transcribedAt.slice(0, 10)}` : ''}]`,
  );
  if (data.summary) lines.push(`Summary: ${data.summary}`);
  if (data.keyPoints?.length) {
    lines.push('Key points:');
    for (const p of data.keyPoints) lines.push(`- ${p}`);
  }
  if (data.actionItems?.length) {
    lines.push('Action items:');
    for (const a of data.actionItems) lines.push(`- ${a}`);
  }
  if (data.transcript) {
    lines.push('Transcript:');
    lines.push(data.transcript);
  }
  return lines.join('\n');
}

// Replay prior conversation as pi-ai Messages. Model turns are replayed in
// full (assistant content + tool results) when `piaiMessages` is present so
// the model can reason about its earlier tool use. Without those, we degrade
// gracefully to plain text -- this is the path old-format history entries
// (pre-migration) take, and the path the renderer takes on a fresh session.
function historyToMessages(history: AgentChatMessage[]): Message[] {
  const out: Message[] = [];
  for (const m of history) {
    if (m.role === 'model' && m.piaiMessages && m.piaiMessages.length > 0) {
      out.push(...m.piaiMessages);
      continue;
    }
    if (m.role === 'model') {
      out.push({
        role: 'assistant',
        content: [{ type: 'text', text: m.text }],
        api: 'openai-codex-responses',
        provider: 'openai-codex',
        model: '',
      } as AssistantMessage);
      continue;
    }
    out.push({ role: 'user', content: m.text, timestamp: Date.now() });
  }
  return out;
}

function extractFinalText(message: AssistantMessage): string {
  return message.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function extractToolCalls(message: AssistantMessage): ToolCall[] {
  return message.content.filter((b): b is ToolCall => b.type === 'toolCall');
}

export interface AgentServiceOptions {
  provider?: AiProvider;
  apiKey?: string;
  codexOAuth?: CodexOAuthCredentials;
  onCodexOAuthUpdate?: (credentials: CodexOAuthCredentials) => void | Promise<void>;
  dataPath: string;
  configService: ConfigService;
  /** Default model for agent reasoning. Falls back to configService.getGeminiFlashModel(). */
  defaultModel?: string;
  codexModel?: string;
}

export class AgentService {
  private provider: AiProvider;
  private geminiApiKey?: string;
  private dataPath: string;
  private configService: ConfigService;
  private defaultModel: string;
  private codexOAuth?: CodexOAuthCredentials;
  private onCodexOAuthUpdate?: (credentials: CodexOAuthCredentials) => void | Promise<void>;

  constructor(opts: AgentServiceOptions) {
    this.provider = opts.provider ?? 'gemini';
    if (this.provider === 'gemini') {
      if (!opts.apiKey) {
        throw new Error('Gemini API key is required for the Gemini provider.');
      }
      this.geminiApiKey = opts.apiKey;
    }
    this.dataPath = opts.dataPath;
    this.configService = opts.configService;
    this.defaultModel =
      opts.defaultModel ??
      (this.provider === 'codex'
        ? opts.codexModel || DEFAULT_CODEX_MODEL
        : opts.configService.getGeminiFlashModel());
    this.codexOAuth = opts.codexOAuth;
    this.onCodexOAuthUpdate = opts.onCodexOAuthUpdate;
  }

  // Resolve a per-request API key. For Codex we go through pi-ai's OAuth
  // refresher (cached credentials in memory, persisted callback for config-
  // sourced creds only -- env-only creds intentionally stay ephemeral). For
  // Gemini we just hand back the static key.
  private async resolveApiKey(): Promise<string> {
    if (this.provider === 'codex') {
      return await requireCodexAccessToken({
        credentials: this.codexOAuth,
        onCredentialsChanged: async (credentials) => {
          this.codexOAuth = credentials;
          await this.onCodexOAuthUpdate?.(credentials);
        },
      });
    }
    if (!this.geminiApiKey) {
      throw new Error('Gemini API key is not configured.');
    }
    return this.geminiApiKey;
  }

  private async resolveModel(modelId: string): Promise<Model<never>> {
    const piProvider = this.provider === 'codex' ? 'openai-codex' : 'google';
    return await getModel(piProvider, modelId);
  }

  async run(opts: AgentRunOptions): Promise<AgentRunResult> {
    const modelId = opts.model ?? this.defaultModel;
    const maxSteps = opts.maxSteps ?? 6;
    const tools = await buildTools(opts.scope, !!opts.confirm);

    // Load the single-meeting record once so the system prompt can name the
    // meeting and the primer message can carry its body.
    const singleData =
      opts.scope.kind === 'single' && isValidFolderName(opts.scope.folderName)
        ? await readTranscription(
            path.join(getTranscriptionsDir(this.dataPath), opts.scope.folderName),
          )
        : null;

    const history = opts.history ? [...opts.history] : [];
    const context: Context = {
      systemPrompt: systemInstructionFor(opts.scope, singleData?.title),
      messages: [],
      tools: tools.length > 0 ? tools : undefined,
    };

    // Single-meeting primer goes first so the model sees the meeting body
    // before any of its own prior turns about it.
    if (singleData) {
      context.messages.push({
        role: 'user',
        content: buildSinglePrimer(singleData),
        timestamp: Date.now(),
      });
    }
    for (const m of historyToMessages(history)) context.messages.push(m);
    context.messages.push({ role: 'user', content: opts.question, timestamp: Date.now() });
    history.push({ role: 'user', text: opts.question });

    // Pi-ai's `Model` discriminator is invariant in TApi so we keep it loose
    // here; we never read api-specific fields off the model in this service.
    const model = await this.resolveModel(modelId);
    const turnsStart = context.messages.length;
    const applied: AppliedAction[] = [];
    let finalAnswer = '';

    for (let step = 0; step < maxSteps; step++) {
      const apiKey = await this.resolveApiKey();
      const response = await complete(model, context, { apiKey, temperature: 0.3 });
      context.messages.push(response);

      const toolCalls = extractToolCalls(response);
      if (toolCalls.length === 0) {
        finalAnswer = extractFinalText(response);
        break;
      }

      // Read-only tools (search/list/get) run in parallel; set_config awaits a
      // user click but that still happens concurrently with the reads rather
      // than serializing the round-trip.
      const results = await Promise.all(
        toolCalls.map((call) => this.dispatchTool(call, opts, applied)),
      );
      for (let i = 0; i < toolCalls.length; i++) {
        context.messages.push({
          role: 'toolResult',
          toolCallId: toolCalls[i].id,
          toolName: toolCalls[i].name,
          content: [{ type: 'text', text: JSON.stringify(results[i]) }],
          isError: false,
          timestamp: Date.now(),
        });
      }
    }

    if (!finalAnswer) {
      finalAnswer = '(no answer produced within step limit)';
    }

    const piaiMessages = context.messages.slice(turnsStart);
    history.push({ role: 'model', text: finalAnswer, piaiMessages });
    return { answer: finalAnswer, appliedActions: applied, history };
  }

  private async dispatchTool(
    call: ToolCall,
    opts: AgentRunOptions,
    applied: AppliedAction[],
  ): Promise<Record<string, unknown>> {
    const args = call.arguments ?? {};
    try {
      switch (call.name) {
        case 'search_transcriptions': {
          const query = typeof args.query === 'string' ? args.query : '';
          if (!query.trim()) return { error: 'query is required' };
          const limit = typeof args.limit === 'number' ? args.limit : 5;
          const includeTranscript = args.include_transcript === true;
          const fields: SearchField[] = includeTranscript
            ? [...ALL_FIELDS]
            : ['title', 'summary', 'keyPoints', 'actionItems'];
          const hits = await searchTranscriptions(this.dataPath, { query, fields, limit });
          return {
            hits: hits.map((h) => ({
              folder_name: h.entry.folderName,
              title: h.data.title,
              transcribed_at: h.entry.transcribedAt,
              matched_fields: h.matchedFields,
              snippet: h.snippet,
              summary: h.data.summary,
            })),
          };
        }
        case 'list_recent_transcriptions': {
          const limit = typeof args.limit === 'number' ? args.limit : 10;
          const entries = await listTranscriptions(this.dataPath, limit);
          return {
            entries: entries.map((e) => ({
              folder_name: e.folderName,
              title: e.title,
              transcribed_at: e.transcribedAt,
            })),
          };
        }
        case 'get_transcription': {
          const folderName = typeof args.folder_name === 'string' ? args.folder_name : '';
          if (!isValidFolderName(folderName))
            return {
              error:
                'folder_name must be a bare folder name returned by search/list (no slashes, no ..)',
            };
          const folderPath = path.join(getTranscriptionsDir(this.dataPath), folderName);
          const data = await readTranscription(folderPath);
          if (!data) return { error: `transcription not found: ${folderName}` };
          const result: Record<string, unknown> = {
            title: data.title,
            transcribed_at: data.transcribedAt,
            summary: data.summary,
            key_points: data.keyPoints ?? [],
            action_items: data.actionItems ?? [],
          };
          if (args.include_transcript === true) result.transcript = data.transcript;
          return result;
        }
        case 'get_config': {
          const key = typeof args.key === 'string' ? args.key : '';
          if (!isReadableKey(key)) return { error: `unknown or non-readable key: ${key}` };
          const value = (this.configService.getAllConfig() as Record<string, unknown>)[key];
          return { key, value: value ?? null };
        }
        case 'set_config': {
          if (!opts.confirm) return { error: 'set_config not available in this session' };
          const key = typeof args.key === 'string' ? args.key : '';
          if (!isWritableKey(key)) return { error: `key is not settable via agent: ${key}` };
          const coerced = coerceConfigValue(key, args.value);
          if (!coerced.ok) return { error: coerced.error };
          const previousValue = (this.configService.getAllConfig() as Record<string, unknown>)[key];
          const description = describeProposal(
            key,
            coerced.value,
            previousValue,
            typeof args.reason === 'string' ? args.reason : undefined,
          );
          const approved = await opts.confirm({
            kind: 'setConfig',
            key,
            value: coerced.value,
            currentValue: previousValue,
            description,
          });
          if (!approved) {
            return { approved: false, note: 'User declined the change.' };
          }
          this.configService.updateConfig({ [key]: coerced.value });
          applied.push({ type: 'setConfig', key, value: coerced.value, previousValue });
          return { approved: true, key, value: coerced.value };
        }
        default:
          return { error: `unknown tool: ${call.name}` };
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
}

export function describeProposal(
  key: WritableConfigKey,
  value: unknown,
  current: unknown,
  reason?: string,
): string {
  const currentStr =
    current === undefined || current === null || current === ''
      ? '(unset)'
      : JSON.stringify(current);
  const valueStr = JSON.stringify(value);
  const base = `Change ${key}: ${currentStr} -> ${valueStr}`;
  return reason ? `${base} (${reason})` : base;
}
