// Covers the diarized_json response reshape that gpt-4o-transcribe-diarize
// returns. Behavior we lock in:
//   - Re-label OpenAI speaker ids onto our 참가자N convention
//   - Merge consecutive segments from the same speaker onto one line
//   - Empty-string segments are skipped
//   - No segments / no usable text throws (so the renderer sees an error,
//     not a blank transcript that gets quietly saved)

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatDiarizedSegments, isDiarizeModel } from './codexTranscription';

describe('isDiarizeModel', () => {
  it('matches the diarize model id', () => {
    assert.equal(isDiarizeModel('gpt-4o-transcribe-diarize'), true);
    assert.equal(isDiarizeModel('  gpt-4o-transcribe-diarize  '), true);
  });

  it('does not match the non-diarize transcription models', () => {
    assert.equal(isDiarizeModel('gpt-4o-transcribe'), false);
    assert.equal(isDiarizeModel('gpt-4o-mini-transcribe'), false);
    assert.equal(isDiarizeModel('whisper-1'), false);
  });
});

describe('formatDiarizedSegments', () => {
  it('maps Speaker 0/1 to 참가자1/2 in first-seen order', () => {
    const out = formatDiarizedSegments([
      { speaker: 'Speaker 0', text: '안녕하세요' },
      { speaker: 'Speaker 1', text: '네 반갑습니다' },
      { speaker: 'Speaker 0', text: '회의 시작하겠습니다' },
    ]);
    assert.equal(
      out,
      '참가자1: 안녕하세요\n\n참가자2: 네 반갑습니다\n\n참가자1: 회의 시작하겠습니다',
    );
  });

  it('merges consecutive segments from the same speaker onto one line', () => {
    const out = formatDiarizedSegments([
      { speaker: 'Speaker 0', text: '첫 문장입니다' },
      { speaker: 'Speaker 0', text: '두 번째 문장입니다' },
      { speaker: 'Speaker 1', text: '제가 답변드릴게요' },
    ]);
    const lines = out.split('\n\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[0], '참가자1: 첫 문장입니다 두 번째 문장입니다');
    assert.equal(lines[1], '참가자2: 제가 답변드릴게요');
  });

  it('honors user-supplied speaker names if OpenAI returns them', () => {
    // When `known_speaker_names[]` is set, OpenAI labels segments with the
    // user-supplied names instead of "Speaker 0/1". Treat each unique label
    // as a new participant in first-seen order, same as the Speaker N path.
    const out = formatDiarizedSegments([
      { speaker: '한결', text: '안녕하세요' },
      { speaker: '주연', text: '안녕하세요' },
    ]);
    assert.equal(out, '참가자1: 안녕하세요\n\n참가자2: 안녕하세요');
  });

  it('drops segments with empty/whitespace-only text', () => {
    const out = formatDiarizedSegments([
      { speaker: 'Speaker 0', text: '' },
      { speaker: 'Speaker 0', text: '   ' },
      { speaker: 'Speaker 1', text: '실제 내용' },
    ]);
    assert.equal(out, '참가자1: 실제 내용');
  });

  it('treats missing speaker as a single "unknown" bucket', () => {
    const out = formatDiarizedSegments([{ text: '첫 번째' }, { text: '두 번째' }]);
    // Same bucket, so segments merge.
    assert.equal(out, '참가자1: 첫 번째 두 번째');
  });

  it('throws when no segments are returned (renderer must see an error)', () => {
    assert.throws(() => formatDiarizedSegments([]), /no segments/);
    assert.throws(() => formatDiarizedSegments(undefined), /no segments/);
  });

  it('throws when segments are present but all empty', () => {
    assert.throws(
      () =>
        formatDiarizedSegments([
          { speaker: 'Speaker 0', text: '' },
          { speaker: 'Speaker 1', text: '   ' },
        ]),
      /no usable text/,
    );
  });
});
