// The batch backend seam is what keeps a third STT engine from re-opening the
// eight provider branches in geminiService.ts. These tests pin the two pure
// decisions the pipeline reads off a backend: when a recording gets split and
// how wide the quality-retry ladder is.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type BatchSttBackend,
  DEFAULT_MAX_SEGMENT_SECONDS,
  planSegmentation,
  QUALITY_RETRY_TEMPERATURES,
  retryTemperaturesFor,
} from './batchSttBackend';

type SegmentationShape = Pick<BatchSttBackend, 'maxBytes' | 'maxSegmentSeconds'>;

// Mirrors the Gemini backend: token-billed, no per-request byte cap.
const unlimitedSize: SegmentationShape = { maxSegmentSeconds: DEFAULT_MAX_SEGMENT_SECONDS };

// Mirrors the Codex backend: 24 MB per request.
const sizeCapped: SegmentationShape = {
  maxSegmentSeconds: DEFAULT_MAX_SEGMENT_SECONDS,
  maxBytes: 24 * 1024 * 1024,
};

// Mirrors a whole-meeting backend (Soniox's 300-minute file cap), which only
// segments recordings longer than five hours.
const wholeMeeting: SegmentationShape = { maxSegmentSeconds: 18_000 };

describe('planSegmentation', () => {
  it('leaves a short, small recording whole', () => {
    const plan = planSegmentation(unlimitedSize, 240, 3);
    assert.equal(plan.shouldSegment, false);
    assert.equal(plan.segmentDuration, 300);
  });

  it('segments once the duration passes the backend maximum', () => {
    const plan = planSegmentation(unlimitedSize, 301, 3);
    assert.equal(plan.shouldSegment, true);
    assert.equal(plan.segmentDuration, 300);
  });

  it('segments a size-capped backend over its byte cap and shrinks the segment', () => {
    // 48 MB of 600s audio: a 20MB target buys 250s per segment.
    const plan = planSegmentation(sizeCapped, 600, 48);
    assert.equal(plan.shouldSegment, true);
    assert.equal(plan.segmentDuration, 250);
  });

  it('clamps a shrunk segment to the 30s floor', () => {
    // 900 MB of 600s audio would compute 13s per segment.
    const plan = planSegmentation(sizeCapped, 600, 900);
    assert.equal(plan.shouldSegment, true);
    assert.equal(plan.segmentDuration, 30);
  });

  it('never shrinks past the backend maximum for a long but small file', () => {
    const plan = planSegmentation(sizeCapped, 3600, 21);
    assert.equal(plan.shouldSegment, true);
    assert.equal(plan.segmentDuration, 300);
  });

  it('keeps the full segment length for a size-capped backend under the target', () => {
    const plan = planSegmentation(sizeCapped, 600, 12);
    assert.equal(plan.shouldSegment, true);
    assert.equal(plan.segmentDuration, 300);
  });

  it('ignores file size for a backend with no byte cap', () => {
    const plan = planSegmentation(unlimitedSize, 240, 500);
    assert.equal(plan.shouldSegment, false);
    assert.equal(plan.segmentDuration, 300);
  });

  it('falls back to the full segment length when the duration is unknown', () => {
    // ffprobe failure (duration 0) leaves nothing to scale the size budget
    // against, and the caller drops to the legacy no-overlap muxer.
    const plan = planSegmentation(sizeCapped, 0, 48);
    assert.equal(plan.shouldSegment, true);
    assert.equal(plan.segmentDuration, 300);
  });

  it('keeps a two-hour meeting whole for a backend that accepts five hours', () => {
    const plan = planSegmentation(wholeMeeting, 7200, 56);
    assert.equal(plan.shouldSegment, false);
    assert.equal(plan.segmentDuration, 18_000);
  });
});

describe('retryTemperaturesFor', () => {
  it('uses the full ladder when the backend honors temperature', () => {
    assert.deepEqual(retryTemperaturesFor({ supportsTemperature: true }), [
      ...QUALITY_RETRY_TEMPERATURES,
    ]);
  });

  it('collapses to one provider-nondeterministic re-roll without a temperature knob', () => {
    assert.deepEqual(retryTemperaturesFor({ supportsTemperature: false }), [undefined]);
  });

  it('returns a fresh array so a caller cannot mutate the shared ladder', () => {
    const first = retryTemperaturesFor({ supportsTemperature: true });
    first.push(1);
    assert.deepEqual(retryTemperaturesFor({ supportsTemperature: true }), [
      ...QUALITY_RETRY_TEMPERATURES,
    ]);
  });
});
