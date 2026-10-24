// Unit tests for ChatGPTBinding.run(): the session watch that stops an
// in-flight ChatGPT request when its sign-in ends. Real-transport and
// cross-process variants live in chatgptAuth.test.ts.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type ChatGPTAuthLike, ChatGPTBinding, ChatGPTBindingError } from './chatgptBinding';

function fakeAuth(state: { active: boolean; reads?: number }): ChatGPTAuthLike {
  return {
    getStatus: async () => ({ connected: true, planEnabled: true, profileId: 'p1' }),
    openSession: async () => ({
      profileId: 'p1',
      getAccessToken: async () => 'tok',
      listModels: async () => [{ slug: 'm', display_name: 'M' }],
      isActive: () => {
        state.reads = (state.reads ?? 0) + 1;
        return state.active;
      },
      endRejectedSession: async () => false,
    }),
  };
}

// Behavioral leak check for the (unref'd) session watch: once a run has
// settled, the session must not be polled again across several intervals.
async function assertWatchStopped(state: { reads?: number }, pollMs: number): Promise<void> {
  const settled = state.reads ?? 0;
  await new Promise((resolve) => setTimeout(resolve, pollMs * 6));
  assert.equal(state.reads ?? 0, settled, 'the session watch kept polling after the run settled');
}

function isSignedOut(error: unknown): boolean {
  return error instanceof ChatGPTBindingError && error.code === 'signed_out_during_job';
}

describe('ChatGPTBinding.run session watch', () => {
  it('returns the result while the session stays active and leaves no timer behind', async () => {
    const state = { active: true, reads: 0 };
    const binding = new ChatGPTBinding({ auth: fakeAuth(state), sessionPollMs: 5 });
    const result = await binding.run(undefined, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 'ok';
    });
    assert.equal(result, 'ok');
    assert.ok(state.reads > 2, 'the call ran under the session watch');
    await assertWatchStopped(state, 5);
  });

  it('refuses to start a call when the session already ended', async () => {
    const state = { active: true };
    const binding = new ChatGPTBinding({ auth: fakeAuth(state), sessionPollMs: 5 });
    await binding.run(undefined, async () => 'bind');
    state.active = false;
    let called = false;
    await assert.rejects(
      binding.run(undefined, async () => {
        called = true;
        return 'x';
      }),
      isSignedOut,
    );
    assert.equal(called, false);
  });

  it('aborts the in-flight call within the poll interval and clears its timer', async () => {
    const state = { active: true, reads: 0 };
    const binding = new ChatGPTBinding({ auth: fakeAuth(state), sessionPollMs: 5 });
    let sawAbort = false;
    const pending = binding.run(
      undefined,
      (signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            sawAbort = true;
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    setTimeout(() => {
      state.active = false;
    }, 10);
    await assert.rejects(pending, isSignedOut);
    assert.equal(sawAbort, true);
    await assertWatchStopped(state, 5);
  });

  it('passes a caller abort through unchanged', async () => {
    const binding = new ChatGPTBinding({ auth: fakeAuth({ active: true }), sessionPollMs: 5 });
    const controller = new AbortController();
    const pending = binding.run(
      controller.signal,
      (signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    controller.abort(new DOMException('user cancelled', 'AbortError'));
    await assert.rejects(pending, (error: unknown) => (error as Error).name === 'AbortError');
  });

  it('assertActive passes before binding and fails after the sign-out', async () => {
    const state = { active: true };
    const binding = new ChatGPTBinding({ auth: fakeAuth(state) });
    await binding.assertActive();
    await binding.run(undefined, async () => 'bind');
    await binding.assertActive();
    state.active = false;
    await assert.rejects(binding.assertActive(), isSignedOut);
  });
});

describe('ChatGPTBinding task model override', () => {
  it('evicts an unavailable override without changing the configured model or bound account', async () => {
    let available = false;
    let opened = 0;
    const auth: ChatGPTAuthLike = {
      getStatus: async () => ({ connected: true, planEnabled: true, profileId: 'p1' }),
      openSession: async (profileId) => {
        opened++;
        assert.equal(profileId, 'p1');
        return {
          profileId: 'p1',
          getAccessToken: async () => 'tok',
          listModels: async () => [
            { slug: 'configured', display_name: 'Configured' },
            ...(available ? [{ slug: 'gpt-6-luna', display_name: 'Luna' }] : []),
          ],
          isActive: () => true,
          endRejectedSession: async () => false,
        };
      },
    };
    const binding = new ChatGPTBinding({ model: 'configured', auth });
    const configured = await binding.model();
    await assert.rejects(binding.model(undefined, 'gpt-6-luna'), /not available/);
    available = true;
    assert.equal((await binding.model(undefined, 'gpt-6-luna')).id, 'gpt-6-luna');
    assert.equal(await binding.model(), configured, 'configured task cache is preserved');
    assert.equal(opened, 1, 'model discovery stays on the pinned account');
  });
});
