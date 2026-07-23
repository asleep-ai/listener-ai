// The scrubbing layer is the privacy guarantee for a meeting recorder: no
// transcript text, API key, or OAuth token may ride out on a Sentry event.
// These tests pin the redaction of secret-shaped keys/values, the dropping of
// console breadcrumbs, and hostname removal. `reportError`/`initMainSentry` are
// not exercised here -- NODE_ENV=test makes init a no-op by design.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redactString, scrubDeep, scrubEvent, telemetryHash } from './sentryScrub';

describe('redactString', () => {
  it('redacts Bearer tokens', () => {
    assert.equal(
      redactString('Authorization: Bearer abc.def-123'),
      'Authorization: Bearer [REDACTED]',
    );
  });

  it('redacts sk- style API keys', () => {
    assert.equal(redactString('key sk-abcdefghijklmnopqrstuvwxyz012345'), 'key sk-[REDACTED]');
  });

  it('leaves ordinary text untouched', () => {
    assert.equal(
      redactString('transcription failed at segment 3'),
      'transcription failed at segment 3',
    );
  });
});

describe('scrubDeep', () => {
  it('redacts values under secret-shaped keys', () => {
    const out = scrubDeep({
      geminiApiKey: 'AIzaSecret',
      notionApiKey: 'secret_xyz',
      count: 3,
    }) as Record<string, unknown>;
    assert.equal(out.geminiApiKey, '[REDACTED]');
    assert.equal(out.notionApiKey, '[REDACTED]');
    assert.equal(out.count, 3);
  });

  it('redacts secret-shaped string values even under innocent keys', () => {
    const out = scrubDeep({ note: 'here is Bearer tok_abcdefghijklmnop' }) as Record<
      string,
      unknown
    >;
    assert.equal(out.note, 'here is Bearer [REDACTED]');
  });

  it('handles nested objects and arrays', () => {
    const out = scrubDeep({ a: { accessToken: 'x', items: [{ secret: 'y' }, 'ok'] } }) as {
      a: { accessToken: string; items: [{ secret: string }, string] };
    };
    assert.equal(out.a.accessToken, '[REDACTED]');
    assert.equal(out.a.items[0].secret, '[REDACTED]');
    assert.equal(out.a.items[1], 'ok');
  });

  it('survives circular references', () => {
    const obj: Record<string, unknown> = { name: 'loop' };
    obj.self = obj;
    const out = scrubDeep(obj) as Record<string, unknown>;
    assert.equal(out.name, 'loop');
    assert.equal(out.self, '[Circular]');
  });
});

describe('scrubEvent', () => {
  it('drops the hostname', () => {
    const event = scrubEvent({ server_name: 'marks-macbook.local', extra: {} });
    assert.equal(event.server_name, undefined);
  });

  it('redacts exception messages', () => {
    const event = scrubEvent({
      exception: { values: [{ type: 'Error', value: 'failed with Bearer tok_abcdefghijklmnop' }] },
    });
    assert.equal(event.exception?.values?.[0]?.value, 'failed with Bearer [REDACTED]');
  });

  it('filters console breadcrumbs and keeps others', () => {
    const event = scrubEvent({
      breadcrumbs: [
        { category: 'console', message: 'user said: secret meeting content' },
        { category: 'navigation', message: 'opened settings' },
      ],
    });
    assert.equal(event.breadcrumbs?.length, 1);
    assert.equal(event.breadcrumbs?.[0]?.category, 'navigation');
  });

  it('deep-scrubs extra and contexts', () => {
    const event = scrubEvent({
      extra: { apiKey: 'sk-live-123', meetingId: 'm_42' },
      contexts: { app: { app_name: 'Listener' }, creds: { refreshToken: 'r_secret' } },
    });
    assert.equal((event.extra as Record<string, unknown>).apiKey, '[REDACTED]');
    assert.equal((event.extra as Record<string, unknown>).meetingId, 'm_42');
    assert.equal(
      (event.contexts as Record<string, Record<string, unknown>>).creds.refreshToken,
      '[REDACTED]',
    );
  });
});

describe('telemetryHash', () => {
  const title = '2026-07-23T09-00-00.000Z_Q4-layoffs-planning';

  it('is deterministic for the same input', () => {
    assert.equal(telemetryHash(title), telemetryHash(title));
  });

  it('does not leak the original value (no substring of the title)', () => {
    const h = telemetryHash(title);
    assert.ok(!h.includes('layoffs'));
    assert.ok(!h.includes('Q4'));
    assert.match(h, /^[0-9a-f]{12}$/);
  });

  it('separates distinct inputs', () => {
    assert.notEqual(telemetryHash(title), telemetryHash(title + '-2'));
  });
});
