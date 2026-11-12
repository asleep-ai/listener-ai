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

// Message shapes from production events (LISTENER-AI-Q/T/S/K), with the
// account and meeting names replaced by stand-ins.
describe('redactString - file paths', () => {
  it('drops the macOS account name and the recording file name', () => {
    assert.equal(
      redactString(
        "ENOENT: no such file or directory, stat '/Users/alice/Library/Application Support/listener-ai/recordings/Quarterly_Plan_2026-10-29T12-32-34-850Z.webm'",
      ),
      "ENOENT: no such file or directory, stat '/Users/[user]/Library/Application Support/listener-ai/recordings/[name]'",
    );
  });

  it('drops the Windows account name and a segment file name', () => {
    assert.equal(
      redactString(
        "ENOENT: no such file or directory, open 'C:\\Users\\bob\\AppData\\Roaming\\listener-ai\\recordings\\Board_Review_segment_008.webm'",
      ),
      "ENOENT: no such file or directory, open 'C:\\Users\\[user]\\AppData\\Roaming\\listener-ai\\recordings\\[name]'",
    );
  });

  it('redacts both sides of a rename and a transcription folder', () => {
    assert.equal(
      redactString(
        "ENOSPC: no space left on device, rename '/home/carol/.config/listener-ai/transcriptions/2026-01-01T00-00-00.000Z_Hiring/meta.json.tmp' -> '/home/carol/.config/listener-ai/sync-state.json'",
      ),
      "ENOSPC: no space left on device, rename '/home/[user]/.config/listener-ai/transcriptions/[name]' -> '/home/[user]/.config/listener-ai/sync-state.json'",
    );
  });

  it('drops account names that contain spaces', () => {
    assert.equal(
      redactString(
        "EACCES: permission denied, open '/Users/Example Person/Library/Application Support/listener-ai/config.json'",
      ),
      "EACCES: permission denied, open '/Users/[user]/Library/Application Support/listener-ai/config.json'",
    );
    assert.equal(
      redactString(
        "EACCES: permission denied, open 'C:\\Users\\Example Person\\AppData\\Roaming\\listener-ai\\config.json'",
      ),
      "EACCES: permission denied, open 'C:\\Users\\[user]\\AppData\\Roaming\\listener-ai\\config.json'",
    );
  });

  it('does not stop at an apostrophe inside a meeting or account name', () => {
    assert.equal(
      redactString(
        "ENOENT: no such file or directory, open '/Users/dana/Library/Application Support/listener-ai/recordings/O'Brien_Private_Board_Meeting.webm'",
      ),
      "ENOENT: no such file or directory, open '/Users/[user]/Library/Application Support/listener-ai/recordings/[name]'",
    );
    assert.equal(
      redactString(
        "ENOENT: no such file or directory, open 'C:\\Users\\Sean O'Brien\\AppData\\Roaming\\listener-ai\\recordings\\Q3 'draft' review's notes.webm'",
      ),
      "ENOENT: no such file or directory, open 'C:\\Users\\[user]\\AppData\\Roaming\\listener-ai\\recordings\\[name]'",
    );
  });

  it('redacts both quoted paths of a rename whose names contain apostrophes', () => {
    assert.equal(
      redactString(
        "ENOSPC: no space left on device, rename '/home/o'neil/listener-ai/recordings/Untitled_Meeting.webm' -> '/home/o'neil/listener-ai/recordings/Kim's 1:1.webm'",
      ),
      "ENOSPC: no space left on device, rename '/home/[user]/listener-ai/recordings/[name]' -> '/home/[user]/listener-ai/recordings/[name]'",
    );
  });

  it('redacts an unquoted path with an apostrophe to the end of the line', () => {
    assert.equal(
      redactString(
        "Failed to delete segment file: /Users/dana/x/recordings/Ann's plan_segment_001.webm",
      ),
      'Failed to delete segment file: /Users/[user]/x/recordings/[name]',
    );
  });

  it('leaves text without a home path untouched', () => {
    const text = 'Users of this app: 3 segments failed (see /tmp/listener-e2e/log.txt)';
    assert.equal(redactString(text), text);
  });

  it('keeps app-owned paths that carry no meeting content', () => {
    assert.equal(
      redactString(
        "mkdir '/Users/dana/Library/Application Support/listener-ai/.listener-meeting-locks/ab12.lock'",
      ),
      "mkdir '/Users/[user]/Library/Application Support/listener-ai/.listener-meeting-locks/ab12.lock'",
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
