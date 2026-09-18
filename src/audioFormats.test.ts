import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isTranscriptionTempFile, mimeTypeForExtension } from './audioFormats';

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

  // The pre-conversion temp name carries the batch backend id, so every id in
  // BATCH_STT_BACKEND_IDS has to be recognised, not just the Codex one.
  it('matches pre-conversion temps for every batch backend id', () => {
    assert.equal(isTranscriptionTempFile('Meeting_soniox_1715923200000.webm'), true);
    assert.equal(isTranscriptionTempFile('Meeting_gemini_1715923200000.webm'), true);
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

// The multipart upload labels the audio part with this mime type. A missing
// entry silently falls back to `audio/mp3`, which makes a provider demux the
// wrong format -- so every extension a backend accepts directly needs a row.
describe('mimeTypeForExtension', () => {
  it('maps the containers the Soniox backend accepts directly', () => {
    assert.equal(mimeTypeForExtension('.mp4'), 'audio/mp4');
    assert.equal(mimeTypeForExtension('.aiff'), 'audio/aiff');
    assert.equal(mimeTypeForExtension('.amr'), 'audio/amr');
    assert.equal(mimeTypeForExtension('.asf'), 'audio/x-ms-asf');
  });

  it('keeps the existing recording-pipeline mappings', () => {
    assert.equal(mimeTypeForExtension('.webm'), 'audio/webm');
    assert.equal(mimeTypeForExtension('.m4a'), 'audio/mp4');
    assert.equal(mimeTypeForExtension('WAV'), 'audio/wav');
  });

  it('falls back to audio/mp3 for an unknown extension', () => {
    assert.equal(mimeTypeForExtension('.xyz'), 'audio/mp3');
  });
});
