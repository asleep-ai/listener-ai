import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  describeLiveIndicator,
  type LiveIndicatorEndReason,
  type LiveIndicatorPhase,
  type LiveIndicatorState,
} from './liveSessionView';

const phases: LiveIndicatorPhase[] = ['idle', 'connecting', 'active', 'finalizing', 'ended'];
const reasons: (LiveIndicatorEndReason | null)[] = [null, 'user', 'renderer-lost', 'failed'];

function allStates(): LiveIndicatorState[] {
  const states: LiveIndicatorState[] = [];
  for (const phase of phases)
    for (const endedReason of reasons)
      for (const recording of [true, false])
        for (const captionCount of [0, 3])
          for (const error of [null, 'Socket closed'])
            states.push({ phase, endedReason, recording, captionCount, error });
  return states;
}

describe('describeLiveIndicator', () => {
  it('gives every visible non-idle state a text label, never colour alone', () => {
    for (const state of allStates()) {
      const view = describeLiveIndicator(state);
      assert.ok(view.buttonLabel.trim(), JSON.stringify(state));
      if (view.visible && view.tone !== 'none') {
        assert.ok(view.statusText.trim(), `no status text for ${JSON.stringify(state)}`);
      }
    }
  });

  it('keeps the launcher name stable while the session changes phase', () => {
    const names = new Set(
      (['connecting', 'active', 'finalizing'] as const).flatMap((phase) =>
        [null, 'Socket closed'].map(
          (error) =>
            describeLiveIndicator({ recording: true, phase, error, captionCount: 2 }).buttonLabel,
        ),
      ),
    );
    assert.deepEqual([...names], ['Open live captions']);
  });

  it('keeps the caption count out of the announced status line', () => {
    const one = describeLiveIndicator({ recording: true, phase: 'active', captionCount: 1 });
    const many = describeLiveIndicator({ recording: true, phase: 'active', captionCount: 40 });
    assert.equal(one.statusText, many.statusText);
    assert.equal(one.statusText, 'Live captions on');
    assert.equal(one.detailText, '1 caption');
    assert.equal(many.detailText, '40 captions');
  });

  it('says recording continues when captions fail while minimized', () => {
    const view = describeLiveIndicator({
      recording: true,
      phase: 'active',
      error: 'Gemini Live disconnected',
      captionCount: 4,
    });
    assert.equal(view.tone, 'error');
    assert.equal(view.opensDialog, true);
    assert.match(view.statusText, /Gemini Live disconnected/);
    assert.match(view.statusText, /Recording continues\./);
  });

  it('shows connecting and finalizing phases with their own tone', () => {
    const connecting = describeLiveIndicator({
      recording: true,
      phase: 'connecting',
      captionCount: 0,
    });
    assert.equal(connecting.tone, 'connecting');
    assert.equal(connecting.statusText, 'Connecting live captions...');
    const finalizing = describeLiveIndicator({
      recording: false,
      phase: 'finalizing',
      captionCount: 2,
    });
    assert.equal(finalizing.visible, true);
    assert.equal(finalizing.tone, 'finalizing');
    assert.equal(finalizing.statusText, 'Finishing live captions...');
  });

  it('offers a read-only reopen for a session ended by a reload, even without recording', () => {
    const view = describeLiveIndicator({
      recording: false,
      phase: 'ended',
      endedReason: 'renderer-lost',
      captionCount: 5,
    });
    assert.equal(view.visible, true);
    assert.equal(view.opensDialog, true);
    assert.equal(view.readOnly, true);
    assert.equal(view.statusText, 'Live captions ended when the window reloaded');
    assert.equal(view.detailText, '5 captions kept');
  });

  it('hides an empty reload recovery', () => {
    const view = describeLiveIndicator({
      recording: false,
      phase: 'ended',
      endedReason: 'renderer-lost',
      captionCount: 0,
    });
    assert.equal(view.visible, false);
  });

  it('keeps a user-stopped transcript reachable while recording continues', () => {
    const recording = describeLiveIndicator({
      recording: true,
      phase: 'ended',
      endedReason: 'user',
      captionCount: 2,
    });
    assert.equal(recording.visible, true);
    assert.equal(recording.opensDialog, true);
    assert.equal(recording.statusText, 'Live captions stopped');
    // Once the recording stops, the launcher goes away with it.
    const stopped = describeLiveIndicator({
      recording: false,
      phase: 'ended',
      endedReason: 'user',
      captionCount: 2,
    });
    assert.equal(stopped.visible, false);
  });

  it('says captions stopped after a user stop with no captions', () => {
    const view = describeLiveIndicator({
      recording: true,
      phase: 'ended',
      endedReason: 'user',
      captionCount: 0,
    });
    assert.equal(view.visible, true);
    assert.equal(view.statusText, 'Live captions stopped');
    assert.equal(view.tone, 'ended');
    // Nothing to reopen, so the launcher starts a new session.
    assert.equal(view.opensDialog, false);
    assert.equal(view.buttonLabel, 'Live captions');
    assert.equal(view.detailText, '');
    assert.equal(view.readOnly, false);
    const notRecording = describeLiveIndicator({
      recording: false,
      phase: 'ended',
      endedReason: 'user',
      captionCount: 0,
    });
    assert.equal(notRecording.visible, false);
  });

  it('lets a failed start be retried from the launcher', () => {
    const view = describeLiveIndicator({
      recording: true,
      phase: 'ended',
      endedReason: 'failed',
      error: 'No Gemini key',
      captionCount: 0,
    });
    assert.equal(view.visible, true);
    assert.equal(view.opensDialog, false);
    assert.equal(view.buttonLabel, 'Live captions');
    assert.equal(view.tone, 'error');
    assert.match(view.statusText, /No Gemini key/);
  });

  it('hides the control when idle without a recording', () => {
    const view = describeLiveIndicator({ recording: false, phase: 'idle', captionCount: 0 });
    assert.equal(view.visible, false);
    assert.equal(view.tone, 'none');
    assert.equal(view.statusText, '');
  });

  it('starts a session from the idle launcher during a recording', () => {
    const view = describeLiveIndicator({ recording: true, phase: 'idle', captionCount: 0 });
    assert.equal(view.visible, true);
    assert.equal(view.opensDialog, false);
    assert.equal(view.buttonLabel, 'Live captions');
  });
});
