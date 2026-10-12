// Offline contract tests for the Sign in with ChatGPT inference route. These
// drive the REAL pi-ai `openai-responses` transport (OpenAI SDK underneath)
// through piAiClient.complete(), with an injected `fetch` that captures the
// outgoing request and answers with scripted SSE. No network, no token.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildChatGPTModel,
  CHATGPT_MANAGE_USAGE_URL,
  CHATGPT_TOOL_NAMESPACE,
  ChatGPTInferenceError,
  toChatGPTResponsesPayload,
  toChatGPTInferenceError,
} from './chatgptResponses';
import { type Context, complete, completeSimple, extractFinalText, getTypeBox } from './piAiClient';

// Every field the SIWC preview-limitations page lists as unsupported, plus
// `previous_response_id` (not allowed over HTTP).
const FORBIDDEN_FIELDS = [
  'background',
  'conversation',
  'max_output_tokens',
  'max_tool_calls',
  'metadata',
  'moderation',
  'multi_agent',
  'prompt',
  'prompt_cache_retention',
  'safety_identifier',
  'temperature',
  'top_logprobs',
  'top_p',
  'truncation',
  'user',
  'previous_response_id',
];

type SseEvent = Record<string, unknown> & { type: string };

function sseBody(events: SseEvent[]): string {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

interface Captured {
  url?: string;
  headers?: Headers;
  body?: Record<string, unknown>;
}

function fakeFetch(events: SseEvent[], captured: Captured, status = 200): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.url = String(input instanceof Request ? input.url : input);
    captured.headers = new Headers(init?.headers);
    captured.body = JSON.parse(String(init?.body));
    if (status !== 200) {
      return new Response(JSON.stringify(events[0] ?? {}), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(sseBody(events), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof fetch;
}

const usage = {
  input_tokens: 10,
  output_tokens: 2,
  total_tokens: 12,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens_details: { reasoning_tokens: 0 },
};

function textEvents(text: string, terminal: SseEvent | null): SseEvent[] {
  const events: SseEvent[] = [
    { type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] },
    },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    },
  ];
  if (terminal) events.push(terminal);
  return events;
}

const completed: SseEvent = {
  type: 'response.completed',
  response: { id: 'resp_1', status: 'completed', output: [], usage },
};

const model = buildChatGPTModel({ slug: 'gpt-plan-test', display_name: 'Plan Test' });

function summaryContext(): Context {
  return {
    systemPrompt: 'Follow the requested output contract.',
    messages: [{ role: 'user', content: 'Summarize this.', timestamp: Date.now() }],
  };
}

describe('ChatGPT route: outgoing request contract', () => {
  it('posts to the public /v1/responses with the bearer and a SIWC-clean body', async () => {
    const captured: Captured = {};
    const response = await completeSimple(model, summaryContext(), {
      apiKey: 'siwc-access-token',
      // Everything the summary path passes; all of it must be dropped.
      temperature: 0.2,
      maxTokens: 32768,
      reasoning: 'high',
      fetch: fakeFetch(textEvents('done', completed), captured),
    } as never);

    assert.equal(extractFinalText(response), 'done');
    assert.equal(captured.url, 'https://api.openai.com/v1/responses');
    assert.equal(captured.headers?.get('authorization'), 'Bearer siwc-access-token');
    assert.ok(!String(captured.url).includes('chatgpt.com'), 'never the backend-api route');
    const body = captured.body!;
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.equal(body.model, 'gpt-plan-test');
    for (const field of FORBIDDEN_FIELDS) {
      assert.ok(!(field in body), `forbidden field ${field} must not be sent`);
    }
    assert.ok(!('prompt_cache_key' in body));
    assert.ok(!('prompt_cache_options' in body));
    assert.equal(body.instructions, 'Follow the requested output contract.');
    const input = body.input as Array<Record<string, unknown>>;
    assert.ok(
      input.every((item) => item.role !== 'system' && item.role !== 'developer'),
      'no system/developer message items',
    );
    assert.deepEqual(
      input.map((item) => item.role),
      ['user'],
    );
  });

  it('wraps tools in the listener namespace and namespaces replayed tool calls', async () => {
    const Type = await getTypeBox();
    const captured: Captured = {};
    const context: Context = {
      systemPrompt: 'You are the Listener agent.',
      tools: [
        {
          name: 'search_transcriptions',
          description: 'Search meetings',
          parameters: Type.Object({ query: Type.String() }),
        },
      ],
      messages: [
        { role: 'user', content: 'find budget', timestamp: Date.now() },
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'call_abc|fc_123',
              name: 'search_transcriptions',
              arguments: { query: 'budget' },
            },
          ],
          api: 'openai-responses',
          provider: 'chatgpt',
          model: 'gpt-plan-test',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'toolUse',
          timestamp: Date.now(),
        },
        {
          role: 'toolResult',
          toolCallId: 'call_abc|fc_123',
          toolName: 'search_transcriptions',
          content: [{ type: 'text', text: '[]' }],
          isError: false,
          timestamp: Date.now(),
        },
      ],
    };
    await complete(model, context, {
      apiKey: 'tok',
      temperature: 0.3,
      fetch: fakeFetch(textEvents('none found', completed), captured),
    } as never);

    const body = captured.body!;
    const tools = body.tools as Array<Record<string, unknown>>;
    assert.equal(tools.length, 1);
    assert.equal(tools[0].type, 'namespace');
    assert.equal(tools[0].name, CHATGPT_TOOL_NAMESPACE);
    const members = tools[0].tools as Array<Record<string, unknown>>;
    assert.deepEqual(
      members.map((tool) => [tool.type, tool.name]),
      [['function', 'search_transcriptions']],
    );
    const input = body.input as Array<Record<string, unknown>>;
    const call = input.find((item) => item.type === 'function_call');
    const output = input.find((item) => item.type === 'function_call_output');
    assert.equal(call?.namespace, CHATGPT_TOOL_NAMESPACE);
    assert.equal(call?.call_id, 'call_abc');
    assert.equal(output?.call_id, 'call_abc', 'tool output must match the call id');
    assert.equal(body.instructions, 'You are the Listener agent.');
  });

  function functionCallEvents(addedName: string, doneName: string): SseEvent[] {
    return [
      { type: 'response.created', response: { id: 'resp_2', status: 'in_progress', output: [] } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'fc_9',
          call_id: 'call_9',
          name: addedName,
          namespace: CHATGPT_TOOL_NAMESPACE,
          arguments: '',
        },
      },
      {
        type: 'response.function_call_arguments.done',
        output_index: 0,
        item_id: 'fc_9',
        arguments: '{"key":"autoMode"}',
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'fc_9',
          call_id: 'call_9',
          name: doneName,
          namespace: CHATGPT_TOOL_NAMESPACE,
          arguments: '{"key":"autoMode"}',
          status: 'completed',
        },
      },
      {
        type: 'response.completed',
        response: { id: 'resp_2', status: 'completed', output: [], usage },
      },
    ];
  }

  for (const [label, name] of [
    ['name and namespace as separate fields', 'get_config'],
    ['a namespace-qualified name', `${CHATGPT_TOOL_NAMESPACE}.get_config`],
  ] as const) {
    it(`parses a function call carrying ${label} into the plain tool name`, async () => {
      const response = await complete(model, summaryContext(), {
        apiKey: 'tok',
        fetch: fakeFetch(functionCallEvents(name, name), {}),
      } as never);
      const calls = response.content.filter((block) => block.type === 'toolCall');
      assert.equal(calls.length, 1, 'the call must not be dropped');
      const call = calls[0] as { name: string; id: string; arguments: Record<string, unknown> };
      assert.equal(call.name, 'get_config');
      assert.equal(call.id, 'call_9|fc_9');
      assert.deepEqual(call.arguments, { key: 'autoMode' });
      assert.equal(response.stopReason, 'toolUse');
    });
  }
});

describe('ChatGPT route: success only on response.completed', () => {
  it('throws a usage-limit error with Manage usage on a mid-stream response.failed', async () => {
    const failed: SseEvent = {
      type: 'response.failed',
      response: {
        id: 'resp_1',
        status: 'failed',
        error: {
          code: 'subscription_sharing_usage_limit_exceeded',
          message: 'Usage limit reached',
        },
        output: [],
      },
    };
    await assert.rejects(
      complete(model, summaryContext(), {
        apiKey: 'tok',
        fetch: fakeFetch(textEvents('partial summary text', failed), {}),
      } as never),
      (error: unknown) => {
        assert.ok(error instanceof ChatGPTInferenceError);
        assert.equal(error.code, 'usage_limit_exceeded');
        assert.equal(error.manageUsageUrl, CHATGPT_MANAGE_USAGE_URL);
        return true;
      },
    );
  });

  it('throws on response.incomplete instead of returning truncated text', async () => {
    const incomplete: SseEvent = {
      type: 'response.incomplete',
      response: {
        id: 'resp_1',
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [],
        usage,
      },
    };
    await assert.rejects(
      complete(model, summaryContext(), {
        apiKey: 'tok',
        fetch: fakeFetch(textEvents('truncated', incomplete), {}),
      } as never),
      (error: unknown) => error instanceof ChatGPTInferenceError && error.code === 'incomplete',
    );
  });

  it('throws when the stream ends without a terminal event', async () => {
    await assert.rejects(
      complete(model, summaryContext(), {
        apiKey: 'tok',
        fetch: fakeFetch(textEvents('cut off', null), {}),
      } as never),
      (error: unknown) => error instanceof ChatGPTInferenceError,
    );
  });

  it('maps an HTTP 403 not-eligible error and does not retry it', async () => {
    let calls = 0;
    const captured: Captured = {};
    const inner = fakeFetch(
      [{ type: 'x', error: { code: 'subscription_sharing_user_not_eligible', message: 'no' } }],
      captured,
      403,
    );
    const counting = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      return inner(input, init);
    }) as typeof fetch;
    await assert.rejects(
      complete(model, summaryContext(), { apiKey: 'tok', fetch: counting } as never),
      (error: unknown) =>
        error instanceof ChatGPTInferenceError &&
        error.code === 'not_eligible' &&
        error.status === 403,
    );
    assert.equal(calls, 1, 'no automatic retry on the ChatGPT route');
  });

  it('never sends API-platform organization or project headers from the environment', async () => {
    const keys = ['OPENAI_ORG_ID', 'OPENAI_PROJECT_ID', 'OPENAI_API_KEY'] as const;
    const previous = keys.map((key) => process.env[key]);
    process.env.OPENAI_ORG_ID = 'org-env-should-not-be-sent';
    process.env.OPENAI_PROJECT_ID = 'proj-env-should-not-be-sent';
    process.env.OPENAI_API_KEY = 'sk-should-never-be-used';
    try {
      const captured: Captured = {};
      const response = await complete(model, summaryContext(), {
        apiKey: 'siwc-access-token',
        // A caller header cannot put them back either.
        headers: { 'X-Caller': 'kept', 'OpenAI-Organization': 'org-caller' },
        fetch: fakeFetch(textEvents('done', completed), captured),
      } as never);
      assert.equal(extractFinalText(response), 'done');
      assert.equal(captured.headers?.has('openai-organization'), false);
      assert.equal(captured.headers?.has('openai-project'), false);
      assert.equal(captured.headers?.get('x-caller'), 'kept');
      assert.equal(captured.headers?.get('authorization'), 'Bearer siwc-access-token');
      const sent = JSON.stringify([...captured.headers!.entries()]);
      assert.ok(!sent.includes('org-env') && !sent.includes('proj-env') && !sent.includes('sk-'));
    } finally {
      keys.forEach((key, i) => {
        if (previous[i] === undefined) delete process.env[key];
        else process.env[key] = previous[i];
      });
    }
  });

  it('refuses to run without a ChatGPT token (no env API key fallback)', async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-should-never-be-used';
    let calls = 0;
    try {
      await assert.rejects(
        complete(model, summaryContext(), {
          fetch: (async () => {
            calls++;
            return new Response('');
          }) as typeof fetch,
        } as never),
      );
      assert.equal(calls, 0);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });
});

describe('toChatGPTResponsesPayload', () => {
  it('drops unknown and forbidden keys and merges developer text into instructions', () => {
    const body = toChatGPTResponsesPayload({
      model: 'm',
      instructions: 'base',
      input: [
        { role: 'developer', content: 'dev rule' },
        { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'sys rule' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      ],
      temperature: 1,
      max_output_tokens: 10,
      previous_response_id: 'resp_x',
      service_tier: 'priority',
      some_future_field: true,
      store: true,
      stream: false,
    });
    assert.equal(body.instructions, 'base\n\ndev rule\n\nsys rule');
    assert.deepEqual(Object.keys(body).sort(), [
      'input',
      'instructions',
      'model',
      'store',
      'stream',
    ]);
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.equal((body.input as unknown[]).length, 1);
  });
});

describe('toChatGPTResponsesPayload tool_choice', () => {
  it('namespaces an explicit tool_choice that names a namespaced tool', () => {
    const body = toChatGPTResponsesPayload({
      model: 'm',
      input: [],
      tools: [{ type: 'function', name: 'get_config', parameters: {} }],
      tool_choice: { type: 'function', name: 'get_config' },
    });
    assert.deepEqual(body.tool_choice, {
      type: 'function',
      name: 'get_config',
      namespace: CHATGPT_TOOL_NAMESPACE,
    });
  });

  it('keeps string tool_choice values and non-function tools untouched', () => {
    const body = toChatGPTResponsesPayload({
      model: 'm',
      input: [],
      tools: [{ type: 'web_search' }],
      tool_choice: 'auto',
    });
    assert.equal(body.tool_choice, 'auto');
    assert.deepEqual(body.tools, [{ type: 'web_search' }], 'never silently dropped');
  });
});

describe('toChatGPTInferenceError', () => {
  it('maps the structured subscription_sharing codes', () => {
    assert.equal(
      toChatGPTInferenceError('503: subscription_sharing_usage_unavailable').code,
      'usage_unavailable',
    );
    assert.equal(toChatGPTInferenceError('chatpass_v2_blocked').code, 'not_eligible');
    assert.equal(
      toChatGPTInferenceError('subscription_sharing_unsupported_capability').code,
      'unsupported_capability',
    );
    assert.equal(toChatGPTInferenceError('OpenAI API error (401): nope').code, 'unauthorized');
    assert.equal(toChatGPTInferenceError('boom').code, 'failed');
  });
});
