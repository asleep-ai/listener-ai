import * as path from 'path';
import {
  type Content,
  type FunctionCall,
  type FunctionDeclaration,
  GoogleGenAI,
  type Part,
  Type,
} from '@google/genai';
import type { ConfigService } from './configService';
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
  // Raw Gemini turns belonging to this message (model turns may carry
  // function_call parts, with the matching tool-response user turns interleaved).
  // Preserved so the next run sees the full tool-use history, not just text.
  // Only populated on model messages produced by `run`.
  turns?: Content[];
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
  'geminiModel',
  'geminiFlashModel',
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

function buildTools(scope: AgentScope, hasConfirm: boolean): FunctionDeclaration[] {
  const tools: FunctionDeclaration[] = [];

  if (scope.kind === 'all') {
    tools.push({
      name: 'search_transcriptions',
      description:
        'Full-text search across saved meeting transcriptions. Returns top-k hits with title, date, snippet, and folder name. Use this to find meetings relevant to the user question.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          query: { type: Type.STRING, description: 'Search keywords. Can be Korean or English.' },
          limit: { type: Type.INTEGER, description: 'Max hits to return (default 5).' },
          include_transcript: {
            type: Type.BOOLEAN,
            description: 'Also search the full transcript body (slower). Default false.',
          },
        },
        required: ['query'],
      },
    });

    tools.push({
      name: 'list_recent_transcriptions',
      description:
        'List the most recent saved transcriptions, newest first. Use when the user asks "what did we talk about recently" or "show me yesterday\'s meetings".',
      parameters: {
        type: Type.OBJECT,
        properties: {
          limit: { type: Type.INTEGER, description: 'Max entries (default 10).' },
        },
      },
    });

    tools.push({
      name: 'get_transcription',
      description:
        'Fetch a saved meeting record (summary, key points, action items) by folder name. Pass include_transcript=true only when you need the verbatim transcript body; omit it for summary-level questions to keep the response compact.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          folder_name: {
            type: Type.STRING,
            description:
              'The folderName returned by search_transcriptions or list_recent_transcriptions.',
          },
          include_transcript: {
            type: Type.BOOLEAN,
            description: 'Include the full transcript body. Default false.',
          },
        },
        required: ['folder_name'],
      },
    });
  }

  tools.push({
    name: 'get_config',
    description: `Read a single Listener.AI setting value. Allowed keys: ${READABLE_CONFIG_KEYS.join(', ')}. API keys and database IDs are never readable here.`,
    parameters: {
      type: Type.OBJECT,
      properties: {
        key: { type: Type.STRING, description: `One of: ${READABLE_CONFIG_KEYS.join(', ')}` },
      },
      required: ['key'],
    },
  });

  if (hasConfirm) {
    tools.push({
      name: 'set_config',
      description: `Propose a change to a Listener.AI setting. Requires user confirmation before taking effect. Allowed keys: ${WRITABLE_CONFIG_KEYS.join(', ')}. Do NOT try to set API keys, Notion database ID, or other credentials here.`,
      parameters: {
        type: Type.OBJECT,
        properties: {
          key: { type: Type.STRING, description: `One of: ${WRITABLE_CONFIG_KEYS.join(', ')}` },
          value: {
            type: Type.STRING,
            description:
              'The new value. For booleans pass "true"/"false"; for numbers pass the digits as a string; for strings pass the string.',
          },
          reason: {
            type: Type.STRING,
            description:
              'Short human-readable reason shown to the user in the confirmation prompt.',
          },
        },
        required: ['key', 'value'],
      },
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

function historyToContents(history: AgentChatMessage[]): Content[] {
  const out: Content[] = [];
  for (const m of history) {
    // Model messages replay their full turn cluster (text + function calls +
    // tool responses) so the agent can reason about prior tool use.
    if (m.role === 'model' && m.turns && m.turns.length > 0) {
      out.push(...m.turns);
      continue;
    }
    out.push({ role: m.role, parts: [{ text: m.text }] });
  }
  return out;
}

function extractFinalText(parts: Part[] | undefined): string {
  if (!parts) return '';
  return parts
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

export interface AgentServiceOptions {
  apiKey: string;
  dataPath: string;
  configService: ConfigService;
  /** Default model for agent reasoning. Falls back to configService.getGeminiFlashModel(). */
  defaultModel?: string;
}

export class AgentService {
  private ai: GoogleGenAI;
  private dataPath: string;
  private configService: ConfigService;
  private defaultModel: string;

  constructor(opts: AgentServiceOptions) {
    this.ai = new GoogleGenAI({ apiKey: opts.apiKey });
    this.dataPath = opts.dataPath;
    this.configService = opts.configService;
    this.defaultModel = opts.defaultModel ?? opts.configService.getGeminiFlashModel();
  }

  async run(opts: AgentRunOptions): Promise<AgentRunResult> {
    const model = opts.model ?? this.defaultModel;
    const maxSteps = opts.maxSteps ?? 6;
    const tools = buildTools(opts.scope, !!opts.confirm);

    // Load the single-meeting record once if needed; title + primer derive from it.
    const singleData =
      opts.scope.kind === 'single' && isValidFolderName(opts.scope.folderName)
        ? await readTranscription(
            path.join(getTranscriptionsDir(this.dataPath), opts.scope.folderName),
          )
        : null;
    const systemInstruction = systemInstructionFor(opts.scope, singleData?.title);

    const history = opts.history ? [...opts.history] : [];

    // For single-meeting scope the primer must precede all prior turns so the
    // model sees the meeting context before its own earlier responses about it.
    const contents: Content[] = [];
    if (singleData) {
      contents.push({ role: 'user', parts: [{ text: buildSinglePrimer(singleData) }] });
    }
    for (const c of historyToContents(history)) contents.push(c);

    contents.push({ role: 'user', parts: [{ text: opts.question }] });
    history.push({ role: 'user', text: opts.question });

    // Track turns added from here on so they can be attached to the model
    // message for multi-turn tool memory.
    const modelTurnsStart = contents.length;

    const applied: AppliedAction[] = [];
    let finalAnswer = '';

    for (let step = 0; step < maxSteps; step++) {
      const response = await this.ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction,
          temperature: 0.3,
          tools: tools.length > 0 ? [{ functionDeclarations: tools }] : undefined,
        },
      });

      const candidate = response.candidates?.[0];
      const parts: Part[] = candidate?.content?.parts ?? [];
      const functionCalls: FunctionCall[] = response.functionCalls ?? [];

      // Record model turn verbatim (keeps function call history correct).
      if (candidate?.content) {
        contents.push(candidate.content);
      }

      if (functionCalls.length === 0) {
        finalAnswer = extractFinalText(parts);
        break;
      }

      // Dispatch all tool calls from this turn in parallel. Read-only tools
      // (search/list/get) benefit directly; set_config awaits a user click but
      // that still happens concurrently with the reads rather than after them.
      const results = await Promise.all(
        functionCalls.map((call) => this.dispatchTool(call, opts, applied)),
      );
      const toolResponseParts: Part[] = functionCalls.map((call, i) => ({
        functionResponse: {
          id: call.id,
          name: call.name ?? '',
          response: results[i],
        },
      }));
      contents.push({ role: 'user', parts: toolResponseParts });
    }

    if (!finalAnswer) {
      finalAnswer = '(no answer produced within step limit)';
    }

    const modelTurns = contents.slice(modelTurnsStart);
    history.push({ role: 'model', text: finalAnswer, turns: modelTurns });
    return { answer: finalAnswer, appliedActions: applied, history };
  }

  private async dispatchTool(
    call: FunctionCall,
    opts: AgentRunOptions,
    applied: AppliedAction[],
  ): Promise<Record<string, unknown>> {
    const args = (call.args ?? {}) as Record<string, unknown>;
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
