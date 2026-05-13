// Covers the SSE parser's tolerance for malformed events (PR #119 review M1),
// the field-whitelist error formatter (m1), and the JWT account-id extraction
// error path (M5).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CodexAccountIdError, __testing } from './openaiCodexClient';

const { extractCodexAccountId, parseSse, summarizeCodexEvent, findSseBoundary } = __testing;

// Build a fake Response carrying the given chunks (each yielded as a separate
// reader tick) -- exercises the streaming-decoder path that parseSse relies on.
function fakeSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream);
}

async function collect(response: Response): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for await (const ev of parseSse(response)) out.push(ev);
  return out;
}

describe('extractCodexAccountId', () => {
  function makeJwt(payload: Record<string, unknown>): string {
    const b64url = (obj: Record<string, unknown>): string =>
      Buffer.from(JSON.stringify(obj), 'utf-8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    return `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;
  }

  it('returns chatgpt_account_id for a well-formed JWT payload', () => {
    const token = makeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_123' },
    });
    assert.equal(extractCodexAccountId(token), 'acct_123');
  });

  it('throws CodexAccountIdError with re-login hint on missing claim', () => {
    const token = makeJwt({ 'https://api.openai.com/auth': {} });
    assert.throws(
      () => extractCodexAccountId(token),
      (err) => {
        assert.ok(err instanceof CodexAccountIdError);
        assert.match(err.message, /Codex session invalid/);
        assert.match(err.message, /listener codex login/);
        return true;
      },
    );
  });

  it('throws CodexAccountIdError for non-JWT garbage', () => {
    assert.throws(
      () => extractCodexAccountId('not-a-jwt'),
      (err) => err instanceof CodexAccountIdError,
    );
  });

  it('throws CodexAccountIdError when payload is not JSON', () => {
    const fakeBase64 = Buffer.from('not json', 'utf-8').toString('base64');
    assert.throws(
      () => extractCodexAccountId(`header.${fakeBase64}.sig`),
      (err) => err instanceof CodexAccountIdError,
    );
  });
});

describe('parseSse', () => {
  it('yields one event per \\n\\n boundary', async () => {
    const response = fakeSseResponse([
      'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
      'data: {"type":"response.completed","response":{"id":"r_1"}}\n\n',
    ]);
    const events = await collect(response);
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'response.output_text.delta');
    assert.equal(events[1].type, 'response.completed');
  });

  it('skips malformed JSON events without aborting the stream', async () => {
    const response = fakeSseResponse([
      'data: {"type":"response.output_text.delta","delta":"first"}\n\n',
      'data: {this is not json}\n\n',
      'data: {"type":"response.completed"}\n\n',
    ]);
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: string) => {
      warnings.push(String(msg));
    };
    try {
      const events = await collect(response);
      // Two valid events even though one is malformed -- the malformed one is
      // skipped, not propagated as an exception.
      assert.equal(events.length, 2);
      assert.equal(events[0].type, 'response.output_text.delta');
      assert.equal(events[1].type, 'response.completed');
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /malformed/i);
  });

  it('handles \\r\\n\\r\\n boundaries', async () => {
    const response = fakeSseResponse(['data: {"type":"a"}\r\n\r\ndata: {"type":"b"}\r\n\r\n']);
    const events = await collect(response);
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'a');
    assert.equal(events[1].type, 'b');
  });

  it('ignores [DONE] terminator', async () => {
    const response = fakeSseResponse([
      'data: {"type":"response.completed"}\n\n',
      'data: [DONE]\n\n',
    ]);
    const events = await collect(response);
    assert.equal(events.length, 1);
  });

  it('reassembles a payload split across reader chunks', async () => {
    // Split the SSE payload mid-JSON to exercise the decoder's buffering path.
    const response = fakeSseResponse([
      'data: {"type":"resp',
      'onse.completed","response":{"id":"r_1"}}\n\n',
    ]);
    const events = await collect(response);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'response.completed');
  });
});

describe('findSseBoundary', () => {
  it('returns null when no boundary present', () => {
    assert.equal(findSseBoundary('partial data: foo'), null);
  });

  it('prefers the earliest boundary regardless of separator style', () => {
    const buf = 'event A\r\n\r\nevent B\n\nevent C';
    const r = findSseBoundary(buf);
    assert.ok(r);
    assert.equal(r?.end, 'event A'.length);
    assert.equal(r?.sep, 4);
  });
});

describe('summarizeCodexEvent (m1: field whitelist)', () => {
  it('includes only whitelisted fields', () => {
    const out = summarizeCodexEvent({
      type: 'error',
      error: { code: 'rate_limited', message: 'too many requests' },
      // Fields below must NOT leak into the summary -- they could carry auth or
      // prompt content from upstream debug responses.
      authorization: 'Bearer secret-token',
      raw_prompt: 'user-private',
    });
    assert.match(out, /type=error/);
    assert.match(out, /code=rate_limited/);
    assert.match(out, /message=too many requests/);
    assert.doesNotMatch(out, /Bearer/);
    assert.doesNotMatch(out, /raw_prompt/);
    assert.doesNotMatch(out, /user-private/);
  });

  it('falls back to "no details" when no whitelisted fields present', () => {
    assert.equal(summarizeCodexEvent({ unknown: 'thing' }), 'no details');
  });

  it('summarizes a response.failed event', () => {
    const out = summarizeCodexEvent({
      type: 'response.failed',
      response: { id: 'r_x', status: 'failed', token: 'should-not-leak' },
    });
    assert.match(out, /type=response\.failed/);
    assert.match(out, /id=r_x/);
    assert.match(out, /status=failed/);
    assert.doesNotMatch(out, /should-not-leak/);
  });
});
