// Unit tests for the pure throttle gate that backs reportError's throttleMs.
// Importing ./sentry is safe under `node --test`: the @sentry/electron/main
// require is lazy (inside doInit), so nothing Electron-specific loads here.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { throttleAllows } from './sentry';

describe('throttleAllows', () => {
  it('allows the first report for a key and records it', () => {
    const state = new Map<string, number>();
    assert.equal(throttleAllows(state, 'op', 1000, 0), true);
    assert.equal(state.get('op'), 0);
  });

  it('blocks a repeat within the window', () => {
    const state = new Map<string, number>();
    throttleAllows(state, 'op', 1000, 0);
    assert.equal(throttleAllows(state, 'op', 1000, 999), false);
  });

  it('allows again once the window has elapsed (boundary is inclusive)', () => {
    const state = new Map<string, number>();
    throttleAllows(state, 'op', 1000, 0);
    assert.equal(throttleAllows(state, 'op', 1000, 1000), true);
    assert.equal(state.get('op'), 1000, 'the allowed report advances the window');
  });

  it('tracks distinct keys independently', () => {
    const state = new Map<string, number>();
    throttleAllows(state, 'a', 1000, 0);
    assert.equal(throttleAllows(state, 'b', 1000, 10), true);
  });
});
