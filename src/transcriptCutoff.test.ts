import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  countStopsBefore,
  createTranscriptCutoff,
  exportPayloadFromNote,
  findSegmentHeaders,
  fingerprintTranscript,
  includedTranscript,
  layoutTranscript,
  cutoffStops,
  parseTranscriptCutoff,
  reportNotesAtCutoff,
  resolveTranscriptCutoff,
  snapToWordStart,
  splitNotesAtCutoff,
  splitTranscriptAtCutoff,
  titleForSavedReport,
  validateCutoffOffset,
  withIncludedTranscript,
} from './transcriptCutoff';

const TRANSCRIPT = [
  '참가자1: 오늘 회의 안건은 출시 일정입니다.',
  '',
  '  참가자2: 다음 주 화요일로 하죠.  ',
  '참가자1: 좋습니다. 회의 끝.',
  '참가자2: 점심 뭐 먹을까요?',
].join('\n');

const offsetOf = (needle: string) => {
  const i = TRANSCRIPT.indexOf(needle);
  assert.ok(i > 0, `fixture must contain ${needle}`);
  return i;
};

describe('validateCutoffOffset', () => {
  it('accepts a point with text on both sides', () => {
    assert.equal(validateCutoffOffset(TRANSCRIPT, offsetOf('참가자2: 점심')), null);
  });

  it('rejects the ends, non-integers, and whitespace-only sides', () => {
    assert.ok(validateCutoffOffset(TRANSCRIPT, 0));
    assert.ok(validateCutoffOffset(TRANSCRIPT, TRANSCRIPT.length));
    assert.ok(validateCutoffOffset(TRANSCRIPT, 3.5));
    assert.ok(validateCutoffOffset(TRANSCRIPT, Number.NaN));
    assert.ok(validateCutoffOffset('   abc', 2), 'nothing but whitespace would be included');
    assert.ok(validateCutoffOffset('abc   ', 4), 'nothing but whitespace would be excluded');
  });
});

describe('createTranscriptCutoff / resolveTranscriptCutoff', () => {
  const offset = offsetOf('참가자2: 점심');
  const now = new Date('2026-09-29T00:00:00.000Z');

  it('round-trips a cutoff against the transcript it was made for', () => {
    const cutoff = createTranscriptCutoff(TRANSCRIPT, offset, now);
    assert.deepEqual(cutoff, {
      offset,
      transcriptLength: TRANSCRIPT.length,
      transcriptHash: fingerprintTranscript(TRANSCRIPT),
      appliedAt: now.toISOString(),
    });
    assert.deepEqual(
      resolveTranscriptCutoff(TRANSCRIPT, JSON.parse(JSON.stringify(cutoff))),
      cutoff,
    );
  });

  it('throws on an invalid offset instead of storing it', () => {
    assert.throws(() => createTranscriptCutoff(TRANSCRIPT, 0), /outside the transcript/);
  });

  it('treats a missing or malformed value as the full transcript (legacy notes)', () => {
    assert.equal(resolveTranscriptCutoff(TRANSCRIPT, undefined), undefined);
    assert.equal(resolveTranscriptCutoff(TRANSCRIPT, null), undefined);
    assert.equal(resolveTranscriptCutoff(TRANSCRIPT, { offset: '12' }), undefined);
    assert.equal(parseTranscriptCutoff('nope'), undefined);
    assert.equal(includedTranscript(TRANSCRIPT, undefined), TRANSCRIPT);
  });

  it('ignores a cutoff once the transcript text changed', () => {
    const cutoff = createTranscriptCutoff(TRANSCRIPT, offset, now);
    const edited = TRANSCRIPT.replace('화요일', '수요일');
    assert.equal(edited.length, TRANSCRIPT.length);
    assert.equal(resolveTranscriptCutoff(edited, cutoff), undefined);
    assert.equal(resolveTranscriptCutoff(`${TRANSCRIPT}!`, cutoff), undefined);
    assert.equal(includedTranscript(edited, cutoff), edited);
  });
});

describe('splitTranscriptAtCutoff', () => {
  it('keeps the text before the offset (trailing space trimmed) and excludes the rest', () => {
    const offset = offsetOf('참가자2: 점심');
    const { included, excluded } = splitTranscriptAtCutoff(TRANSCRIPT, { offset });
    assert.equal(included.endsWith('회의 끝.'), true);
    assert.equal(excluded, '참가자2: 점심 뭐 먹을까요?');
    assert.equal(included.includes('점심'), false);
  });

  it('returns everything as included without a cutoff', () => {
    assert.deepEqual(splitTranscriptAtCutoff(TRANSCRIPT, undefined), {
      included: TRANSCRIPT,
      excluded: '',
    });
  });
});

describe('snapToWordStart', () => {
  it('moves a mid-word offset back to the start of the word', () => {
    const word = offsetOf('먹을까요');
    assert.equal(snapToWordStart(TRANSCRIPT, word + 2), word);
  });

  it('moves an offset on whitespace forward to the next word', () => {
    const word = offsetOf('참가자2: 다음');
    assert.equal(snapToWordStart(TRANSCRIPT, word - 2), word);
  });

  it('clamps out-of-range offsets', () => {
    assert.equal(snapToWordStart(TRANSCRIPT, -5), 0);
    assert.equal(snapToWordStart('ab cd', 99), 3);
  });

  it('snaps inside an unspaced Japanese transcript to a real word boundary', () => {
    const transcript = '今日は会議を終えます明日の予定を話します';
    const offset = snapToWordStart(transcript, 9);
    assert.equal(offset, 8);
    assert.equal(validateCutoffOffset(transcript, offset), null);
  });
});

describe('layoutTranscript', () => {
  it('matches the modal layout: trimmed, non-empty lines with source offsets', () => {
    const { included, excluded } = layoutTranscript(TRANSCRIPT);
    assert.equal(excluded.length, 0);
    assert.deepEqual(
      included.map((p) => p.text),
      [
        '참가자1: 오늘 회의 안건은 출시 일정입니다.',
        '참가자2: 다음 주 화요일로 하죠.',
        '참가자1: 좋습니다. 회의 끝.',
        '참가자2: 점심 뭐 먹을까요?',
      ],
    );
    for (const piece of included) {
      assert.equal(TRANSCRIPT.slice(piece.start, piece.start + piece.text.length), piece.text);
    }
  });

  it('splits a line at a mid-line cutoff and keeps offsets exact on both sides', () => {
    const offset = offsetOf('회의 끝.');
    const { included, excluded } = layoutTranscript(TRANSCRIPT, offset);
    assert.equal(included.at(-1)?.text, '참가자1: 좋습니다.');
    assert.deepEqual(excluded[0], { text: '회의 끝.', start: offset });
    assert.equal(excluded[1].text, '참가자2: 점심 뭐 먹을까요?');
    // A DOM selection in a piece maps back as piece.start + local offset.
    const piece = excluded[1];
    assert.equal(TRANSCRIPT[piece.start + 5], piece.text[5]);
  });

  it('gives keyboard stops at line and sentence starts', () => {
    const stops = cutoffStops(TRANSCRIPT);
    assert.deepEqual(
      stops.map((start) => TRANSCRIPT.slice(start, start + 5)),
      ['참가자1:', '참가자2:', '참가자1:', '회의 끝.', '참가자2:'],
    );
    assert.equal(countStopsBefore(stops, stops[3]), 3);
    assert.equal(countStopsBefore(stops, offsetOf('회의 끝.') + 1), 4);
    assert.equal(countStopsBefore(stops, Number.POSITIVE_INFINITY), 5);
    for (const start of stops.slice(1)) assert.equal(validateCutoffOffset(TRANSCRIPT, start), null);
  });

  it('lets a single long line be cut by sentence', () => {
    const oneLine = 'Speaker 1: We ship Tuesday. Lunch plans? Pizza!';
    const stops = cutoffStops(oneLine);
    assert.deepEqual(
      stops.map((start) => oneLine.slice(start, start + 5)),
      ['Speak', 'Lunch', 'Pizza'],
    );
  });

  it('offers word boundaries for a one-sentence transcript', () => {
    const oneSentence = 'We agreed to ship Friday';
    const stops = cutoffStops(oneSentence);
    assert.deepEqual(stops, [0, 3, 10, 13, 18]);
    for (const start of stops.slice(1))
      assert.equal(validateCutoffOffset(oneSentence, start), null);
  });
});

describe('export payload helpers', () => {
  const cutoff = createTranscriptCutoff(TRANSCRIPT, offsetOf('참가자2: 점심'));

  it('withIncludedTranscript trims a payload to its own cutoff', () => {
    const payload = withIncludedTranscript({ transcript: TRANSCRIPT, transcriptCutoff: cutoff });
    assert.equal(payload.transcript.includes('점심'), false);
    const stale = withIncludedTranscript({
      transcript: `${TRANSCRIPT} `,
      transcriptCutoff: cutoff,
    });
    assert.equal(stale.transcript, `${TRANSCRIPT} `, 'a non-matching cutoff never trims');
  });

  it('exportPayloadFromNote replaces renderer-supplied report fields with the saved note', () => {
    const payload = exportPayloadFromNote(
      {
        transcript: TRANSCRIPT,
        summary: 'stale summary from the renderer',
        keyPoints: ['stale'],
        cost: { usd: 1, breakdown: [] },
      },
      {
        transcript: TRANSCRIPT,
        transcriptCutoff: cutoff,
        summary: 'saved summary',
        keyPoints: ['saved point'],
        emoji: '🎯',
      },
    );
    assert.equal(payload.transcript.includes('점심'), false);
    assert.equal(payload.transcript.endsWith('회의 끝.'), true);
    assert.equal(payload.summary, 'saved summary');
    assert.deepEqual(payload.keyPoints, ['saved point']);
    assert.deepEqual(payload.actionItems, []);
    assert.deepEqual(payload.cost, { usd: 1, breakdown: [] });
    assert.equal((payload as { transcriptCutoff?: unknown }).transcriptCutoff, undefined);
  });

  it('does not revive excluded custom fields from a saved recording sidecar', () => {
    const base = { transcript: TRANSCRIPT, customFields: { decisions: ['TAIL_SECRET'] } };
    const cut = exportPayloadFromNote(base, {
      transcript: TRANSCRIPT,
      transcriptCutoff: cutoff,
      summary: 'Prefix only',
    });
    assert.equal(cut.customFields, undefined);

    const legacy = exportPayloadFromNote(base, {
      transcript: TRANSCRIPT,
      summary: 'Full report',
    });
    assert.deepEqual(legacy.customFields, base.customFields);
  });
});

describe('titleForSavedReport', () => {
  it('uses a new report title when the visible title came from the prior suggestion', () => {
    assert.equal(titleForSavedReport('Old_Title', 'Old Title', 'New Title'), 'New Title');
    assert.equal(titleForSavedReport('Old Title', 'Old Title', 'New Title'), 'New Title');
  });

  it('keeps a recording title chosen by the user', () => {
    assert.equal(titleForSavedReport('My own title', 'Old Title', 'New Title'), 'My own title');
  });
});

// A long recording, transcribed in 5-minute segments joined under headers.
const SEGMENTED = [
  '[Segment 1: 00:00:00 ~ 00:05:00]',
  '',
  '참가자1: 첫 번째 안건입니다.',
  '',
  '---',
  '',
  '[Segment 2: 00:05:00 ~ 00:10:00]',
  '',
  '참가자2: 두 번째 안건입니다. 결정합시다.',
  '',
  '---',
  '',
  '[Segment 3: 00:10:00 ~ 00:15:00]',
  '',
  '참가자1: 이제 잡담이나 하죠.',
].join('\n');
const NOTES = [
  { offsetMs: 30_000, text: 'first' }, // segment 1
  { offsetMs: 299_999, text: 'edge' }, // just before segment 2
  { offsetMs: 300_000, text: 'second' }, // segment 2 start
  { offsetMs: 480_000, text: 'decision' }, // segment 2
  { offsetMs: 700_000, text: 'tail' }, // segment 3
];

describe('segment headers as timing evidence', () => {
  it('findSegmentHeaders reads the number and start time of each header', () => {
    assert.deepEqual(
      findSegmentHeaders(SEGMENTED).map((h) => [h.segment, h.startSeconds]),
      [
        [1, 0],
        [2, 300],
        [3, 600],
      ],
    );
    assert.equal(findSegmentHeaders(SEGMENTED)[1].start, SEGMENTED.indexOf('[Segment 2'));
    assert.deepEqual(findSegmentHeaders(TRANSCRIPT), []);
    assert.deepEqual(
      findSegmentHeaders('참가자1: [Segment 1: 00:00:00 ~ 00:05:00] 라고 읽었다'),
      [],
    );
  });

  it('splitNotesAtCutoff keeps only notes flagged before the cut segment', () => {
    const cut = SEGMENTED.indexOf('결정합시다');
    const split = splitNotesAtCutoff(SEGMENTED, cut, NOTES);
    assert.equal(split.cutoffSegment?.segment, 2);
    assert.deepEqual(
      split.included.map((n) => n.text),
      ['first', 'edge'],
      'a note inside the cut segment cannot be placed before the cutoff',
    );
    assert.deepEqual(
      split.excluded.map((n) => n.text),
      ['second', 'decision', 'tail'],
    );
  });

  it('splitNotesAtCutoff treats a cutoff on a header as the start of that segment', () => {
    const split = splitNotesAtCutoff(SEGMENTED, SEGMENTED.indexOf('[Segment 3'), NOTES);
    assert.equal(split.cutoffSegment?.segment, 3);
    assert.deepEqual(
      split.excluded.map((n) => n.text),
      ['tail'],
    );
  });

  it('splitNotesAtCutoff excludes every note when the transcript has no headers', () => {
    const split = splitNotesAtCutoff(TRANSCRIPT, offsetOf('참가자2: 점심'), NOTES);
    assert.equal(split.cutoffSegment, undefined);
    assert.deepEqual(split.included, []);
    assert.equal(split.excluded.length, NOTES.length);
  });

  it('splitNotesAtCutoff keeps everything without a cutoff', () => {
    assert.deepEqual(splitNotesAtCutoff(TRANSCRIPT, null, NOTES).included, NOTES);
    assert.deepEqual(splitNotesAtCutoff(TRANSCRIPT, undefined, NOTES).excluded, []);
  });
});

describe('reportNotesAtCutoff', () => {
  const highlights = NOTES.map((n) => ({ offsetMs: n.offsetMs, userText: n.text, subtitle: 's' }));

  it('filters notes and highlights alike and counts what was left out', () => {
    const cutoff = createTranscriptCutoff(SEGMENTED, SEGMENTED.indexOf('결정합시다'));
    const report = reportNotesAtCutoff({
      transcript: SEGMENTED,
      transcriptCutoff: cutoff,
      liveNotes: NOTES,
      highlights,
    });
    assert.deepEqual(
      report.liveNotes?.map((n) => n.text),
      ['first', 'edge'],
    );
    assert.deepEqual(
      report.highlights?.map((h) => h.userText),
      ['first', 'edge'],
    );
    assert.equal(report.excludedCount, 3);
    assert.equal(report.noTimingEvidence, false);
  });

  it('reports missing timing evidence and leaves absent inputs absent', () => {
    const cutoff = createTranscriptCutoff(TRANSCRIPT, offsetOf('참가자2: 점심'));
    const report = reportNotesAtCutoff({
      transcript: TRANSCRIPT,
      transcriptCutoff: cutoff,
      highlights,
    });
    assert.equal(report.liveNotes, undefined);
    assert.deepEqual(report.highlights, []);
    assert.equal(report.excludedCount, NOTES.length);
    assert.equal(report.noTimingEvidence, true);
  });

  it('keeps everything when the cutoff is absent or stale', () => {
    const stale = createTranscriptCutoff(`${TRANSCRIPT} `, offsetOf('참가자2: 점심'));
    for (const transcriptCutoff of [undefined, stale]) {
      const report = reportNotesAtCutoff({
        transcript: TRANSCRIPT,
        transcriptCutoff,
        liveNotes: NOTES,
      });
      assert.deepEqual(report.liveNotes, NOTES);
      assert.equal(report.excludedCount, 0);
    }
  });
});

describe('exportPayloadFromNote and flagged notes', () => {
  it('leaves notes and highlights from the excluded tail out of the payload', () => {
    const cutoff = createTranscriptCutoff(SEGMENTED, SEGMENTED.indexOf('결정합시다'));
    const payload = exportPayloadFromNote(
      { transcript: SEGMENTED, liveNotes: NOTES },
      {
        transcript: SEGMENTED,
        transcriptCutoff: cutoff,
        liveNotes: NOTES,
        highlights: NOTES.map((n) => ({ offsetMs: n.offsetMs, userText: n.text })),
      },
    ) as { liveNotes?: Array<{ text: string }>; highlights?: Array<{ userText: string }> };
    assert.deepEqual(
      payload.liveNotes?.map((n) => n.text),
      ['first', 'edge'],
    );
    assert.deepEqual(
      payload.highlights?.map((h) => h.userText),
      ['first', 'edge'],
    );
  });

  it('withholds a legacy highlights file the note cannot place under an active cutoff', () => {
    // Older notes may hold highlights.json with no notes.json. The cutoff
    // leaves that file in place (see applyTranscriptCutoff), so the export
    // must filter it by the highlights' own timestamps.
    const legacy = NOTES.map((n) => ({ offsetMs: n.offsetMs, userText: n.text, subtitle: 's' }));
    const noEvidence = exportPayloadFromNote(
      { transcript: TRANSCRIPT },
      {
        transcript: TRANSCRIPT,
        transcriptCutoff: createTranscriptCutoff(TRANSCRIPT, offsetOf('참가자2: 점심')),
        highlights: legacy,
      },
    ) as { liveNotes?: unknown; highlights?: unknown[] };
    assert.equal(noEvidence.liveNotes, undefined);
    assert.deepEqual(noEvidence.highlights, []);

    const withEvidence = exportPayloadFromNote(
      { transcript: SEGMENTED },
      {
        transcript: SEGMENTED,
        transcriptCutoff: createTranscriptCutoff(SEGMENTED, SEGMENTED.indexOf('결정합시다')),
        highlights: legacy,
      },
    ) as { highlights?: Array<{ userText: string }> };
    assert.deepEqual(
      withEvidence.highlights?.map((h) => h.userText),
      ['first', 'edge'],
    );

    const restored = exportPayloadFromNote(
      { transcript: TRANSCRIPT },
      { transcript: TRANSCRIPT, highlights: legacy },
    ) as { highlights?: unknown[] };
    assert.equal(
      restored.highlights?.length,
      legacy.length,
      'no cutoff: the file is published whole',
    );
  });

  it('falls back to sidecar notes and custom fields the note does not store, still filtered', () => {
    const cutoff = createTranscriptCutoff(TRANSCRIPT, offsetOf('참가자2: 점심'));
    const full = exportPayloadFromNote(
      { transcript: TRANSCRIPT, liveNotes: NOTES, customFields: { decisions: ['a'] } },
      { transcript: TRANSCRIPT },
    ) as { liveNotes?: unknown; customFields?: unknown };
    assert.deepEqual(full.liveNotes, NOTES, 'legacy sidecar notes survive without a cutoff');
    assert.deepEqual(full.customFields, { decisions: ['a'] });

    const cut = exportPayloadFromNote(
      { transcript: TRANSCRIPT, liveNotes: NOTES, customFields: { decisions: ['a'] } },
      { transcript: TRANSCRIPT, transcriptCutoff: cutoff, customFields: { decisions: ['b'] } },
    ) as { liveNotes?: unknown; customFields?: unknown };
    assert.deepEqual(cut.liveNotes, [], 'no timing evidence: no sidecar note may be published');
    assert.deepEqual(
      cut.customFields,
      { decisions: ['b'] },
      'the note wins when it stores the field',
    );
  });
});
