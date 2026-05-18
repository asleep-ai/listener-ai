import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isTranscriptionTempFile } from './audioFormats';

// The recordings watcher and `get-recordings` both rely on this helper to
// suppress transient transcription artifacts. A loose match would let user
// recordings get suppressed; too tight a match would let a temp file fire a
// list refresh that wipes the inline progress row.
describe('isTranscriptionTempFile', () => {
  it('matches ffmpeg segment files (`_segment_NNN.<ext>`)', () => {
    assert.equal(isTranscriptionTempFile('Meeting_segment_000.webm'), true);
    assert.equal(isTranscriptionTempFile('Meeting_segment_123.mp3'), true);
    assert.equal(isTranscriptionTempFile('Talk_segment_999.m4a'), true);
  });

  it('matches codex pre-conversion temps (`_codex_<timestamp>.webm`)', () => {
    assert.equal(isTranscriptionTempFile('Meeting_codex_1715923200000.webm'), true);
    assert.equal(isTranscriptionTempFile('Talk_codex_1.webm'), true);
  });

  it('does not match user recordings that share the prefix', () => {
    assert.equal(isTranscriptionTempFile('Meeting_segment_notes.webm'), false);
    assert.equal(isTranscriptionTempFile('Meeting_segment_1.webm'), false);
    assert.equal(isTranscriptionTempFile('Codex_demo.webm'), false);
    assert.equal(isTranscriptionTempFile('Meeting.webm'), false);
  });

  it('requires a single extension after the suffix (no nested dots)', () => {
    assert.equal(isTranscriptionTempFile('Meeting_segment_001.txt.webm'), false);
    assert.equal(isTranscriptionTempFile('Meeting_codex_123.tar.gz'), false);
  });
});
