import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isDiskFullError,
  isExpectedTranscriptionFailure,
  isNetworkUnreachableError,
  isProviderBillingError,
  isProviderOverloadedError,
} from './errorClassification';

function errno(code: string, message = code): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

describe('isDiskFullError', () => {
  it('matches ENOSPC and EDQUOT, directly and through a cause', () => {
    assert.equal(isDiskFullError(errno('ENOSPC')), true);
    assert.equal(isDiskFullError(errno('EDQUOT')), true);
    assert.equal(isDiskFullError(new Error('wrapped', { cause: errno('ENOSPC') })), true);
  });

  it('does not match other file system errors', () => {
    assert.equal(isDiskFullError(errno('EACCES')), false);
    assert.equal(isDiskFullError(errno('ENOENT')), false);
    assert.equal(isDiskFullError(new Error('no space mentioned only in text: ENOSPC')), false);
    assert.equal(isDiskFullError(undefined), false);
  });
});

describe('isNetworkUnreachableError', () => {
  it('matches the undici fetch-failed shape and its errno causes', () => {
    assert.equal(isNetworkUnreachableError(new TypeError('fetch failed')), true);
    assert.equal(
      isNetworkUnreachableError(new TypeError('fetch failed', { cause: errno('ENOTFOUND') })),
      true,
    );
    assert.equal(isNetworkUnreachableError(errno('UND_ERR_CONNECT_TIMEOUT')), true);
  });

  it('matches the Happy Eyeballs AggregateError of connect failures', () => {
    const aggregate = new AggregateError([errno('EHOSTUNREACH'), errno('ETIMEDOUT')]);
    assert.equal(isNetworkUnreachableError(new TypeError('x', { cause: aggregate })), true);
  });

  it('keeps an unknown concrete cause reportable even under "fetch failed" (LISTENER-AI-R)', () => {
    // Production shape: TypeError fetch failed <- Error write ERANGE.
    const erange = Object.assign(new Error('write ERANGE'), {
      code: 'ERANGE',
      errno: -34,
      syscall: 'write',
    });
    assert.equal(
      isNetworkUnreachableError(new TypeError('fetch failed', { cause: erange })),
      false,
    );
    // Same with only `syscall` (no code) on the cause.
    const bare = Object.assign(new Error('write ERANGE'), { syscall: 'write' });
    assert.equal(isNetworkUnreachableError(new TypeError('fetch failed', { cause: bare })), false);
    // One unknown member of an aggregate is enough to keep it reportable.
    const mixed = new AggregateError([errno('ETIMEDOUT'), errno('ERANGE')]);
    assert.equal(isNetworkUnreachableError(new TypeError('fetch failed', { cause: mixed })), false);
    assert.equal(
      isExpectedTranscriptionFailure(new TypeError('fetch failed', { cause: erange })),
      false,
    );
  });

  it('keeps the flattened pi-ai "fetch failed" with no cause as network', () => {
    assert.equal(
      isNetworkUnreachableError(new Error('Pi-ai google/gemini-3.5-flash failed: fetch failed')),
      true,
    );
  });

  it('does not match text that merely mentions a network', () => {
    assert.equal(isNetworkUnreachableError(new Error('network diagram missing')), false);
    assert.equal(isNetworkUnreachableError(new Error('fetch failed to parse body later')), false);
  });
});

describe('provider account and load classifiers', () => {
  it('matches 503 / UNAVAILABLE / high demand as overloaded', () => {
    assert.equal(isProviderOverloadedError(Object.assign(new Error('x'), { status: 503 })), true);
    assert.equal(isProviderOverloadedError(new Error('{"code": 503}')), true);
    assert.equal(isProviderOverloadedError(new Error('"status": "UNAVAILABLE"')), true);
    assert.equal(
      isProviderOverloadedError(new Error('This model is currently experiencing high demand.')),
      true,
    );
    assert.equal(isProviderOverloadedError(new Error('model not found')), false);
  });

  it('matches 402 and depleted prepayment credits as billing', () => {
    assert.equal(isProviderBillingError(Object.assign(new Error('x'), { status: 402 })), true);
    assert.equal(isProviderBillingError(new Error('Your prepayment credits are depleted.')), true);
    assert.equal(isProviderBillingError(new Error('{"code":4020}')), false);
  });
});

describe('cause graph traversal', () => {
  it('terminates on a self-referential cause', () => {
    const e = new Error('loop') as Error & { cause?: unknown };
    e.cause = e;
    assert.equal(isDiskFullError(e), false);
    assert.equal(isExpectedTranscriptionFailure(e), false);
  });

  it('terminates on a cyclic AggregateError graph', () => {
    const a = new AggregateError([], 'a');
    const b = new AggregateError([a], 'b');
    a.errors.push(b, a);
    (a as { cause?: unknown }).cause = b;
    assert.equal(isNetworkUnreachableError(a), false);
    assert.equal(isDiskFullError(b), false);
  });

  it('terminates on a very wide AggregateError and still finds an early match', () => {
    const wide = new AggregateError(
      [errno('ENOSPC'), ...Array.from({ length: 10_000 }, () => new Error('noise'))],
      'wide',
    );
    assert.equal(isDiskFullError(wide), true);
    const wideMiss = new AggregateError(
      Array.from({ length: 10_000 }, () => new Error('noise')),
      'wide',
    );
    assert.equal(isDiskFullError(wideMiss), false);
  });
});
