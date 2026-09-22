import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  camelToLabel,
  parseActionItemGroups,
  parseSummarySections,
  renderMeetingSections,
} from './meetingRecord';

// These validators guard three sinks that all read the same model-produced
// JSON: the summary parser in geminiService, meta.json reads in outputService,
// and the renderer's markdown/tab rendering. They are deliberately
// all-or-nothing -- a half-valid array would render a summary that silently
// drops content, which is worse than falling back to the flat summary text.
describe('parseSummarySections', () => {
  it('trims headings and bullets on a valid array', () => {
    assert.deepEqual(
      parseSummarySections([
        { heading: '  Agenda  ', bullets: ['  Discussed the roadmap  ', 'Picked a date'] },
        { heading: 'Risks', bullets: ['Vendor lead time'] },
      ]),
      [
        { heading: 'Agenda', bullets: ['Discussed the roadmap', 'Picked a date'] },
        { heading: 'Risks', bullets: ['Vendor lead time'] },
      ],
    );
  });

  it('ignores unknown extra keys on an entry', () => {
    assert.deepEqual(parseSummarySections([{ heading: 'Agenda', bullets: ['One'], extra: 1 }]), [
      { heading: 'Agenda', bullets: ['One'] },
    ]);
  });

  it('returns [] when the value is not a non-empty array', () => {
    assert.deepEqual(parseSummarySections(undefined), []);
    assert.deepEqual(parseSummarySections(null), []);
    assert.deepEqual(parseSummarySections('not-an-array'), []);
    assert.deepEqual(parseSummarySections({ heading: 'Agenda', bullets: ['One'] }), []);
    assert.deepEqual(parseSummarySections([]), []);
  });

  it('returns [] when an entry is not an object', () => {
    assert.deepEqual(parseSummarySections([null]), []);
    assert.deepEqual(parseSummarySections(['Agenda']), []);
    assert.deepEqual(parseSummarySections([42]), []);
  });

  it('returns [] when a heading is missing, non-string, or blank', () => {
    assert.deepEqual(parseSummarySections([{ bullets: ['One'] }]), []);
    assert.deepEqual(parseSummarySections([{ heading: 42, bullets: ['One'] }]), []);
    assert.deepEqual(parseSummarySections([{ heading: '   ', bullets: ['One'] }]), []);
  });

  it('returns [] when bullets are missing, non-array, or empty', () => {
    assert.deepEqual(parseSummarySections([{ heading: 'Agenda' }]), []);
    assert.deepEqual(parseSummarySections([{ heading: 'Agenda', bullets: 'One' }]), []);
    assert.deepEqual(parseSummarySections([{ heading: 'Agenda', bullets: [] }]), []);
  });

  it('returns [] when any bullet is not a non-blank string', () => {
    assert.deepEqual(parseSummarySections([{ heading: 'Agenda', bullets: ['One', 2] }]), []);
    assert.deepEqual(parseSummarySections([{ heading: 'Agenda', bullets: ['One', '  '] }]), []);
    assert.deepEqual(parseSummarySections([{ heading: 'Agenda', bullets: ['One', null] }]), []);
  });

  it('discards already-accumulated sections when a later entry is invalid', () => {
    assert.deepEqual(
      parseSummarySections([{ heading: 'Valid', bullets: ['Kept'] }, { heading: 42 }]),
      [],
    );
  });
});

describe('parseActionItemGroups', () => {
  it('trims owners and items on a valid array', () => {
    assert.deepEqual(
      parseActionItemGroups([
        { owner: '  Acme  ', items: ['  Publish release notes  ', 'Book the room'] },
        { owner: 'Dana', items: ['Follow up'] },
      ]),
      [
        { owner: 'Acme', items: ['Publish release notes', 'Book the room'] },
        { owner: 'Dana', items: ['Follow up'] },
      ],
    );
  });

  it('returns [] when the value is not a non-empty array', () => {
    assert.deepEqual(parseActionItemGroups(undefined), []);
    assert.deepEqual(parseActionItemGroups(null), []);
    assert.deepEqual(parseActionItemGroups('not-an-array'), []);
    assert.deepEqual(parseActionItemGroups({ owner: 'Acme', items: ['One'] }), []);
    assert.deepEqual(parseActionItemGroups([]), []);
  });

  it('returns [] when an entry is not an object', () => {
    assert.deepEqual(parseActionItemGroups([null]), []);
    assert.deepEqual(parseActionItemGroups(['Acme']), []);
    assert.deepEqual(parseActionItemGroups([42]), []);
  });

  it('returns [] when an owner is missing, non-string, or blank', () => {
    assert.deepEqual(parseActionItemGroups([{ items: ['One'] }]), []);
    assert.deepEqual(parseActionItemGroups([{ owner: 42, items: ['One'] }]), []);
    assert.deepEqual(parseActionItemGroups([{ owner: '   ', items: ['One'] }]), []);
  });

  it('returns [] when items are missing, non-array, or empty', () => {
    assert.deepEqual(parseActionItemGroups([{ owner: 'Acme' }]), []);
    assert.deepEqual(parseActionItemGroups([{ owner: 'Acme', items: 'One' }]), []);
    assert.deepEqual(parseActionItemGroups([{ owner: 'Acme', items: [] }]), []);
  });

  it('returns [] when any item is not a non-blank string', () => {
    assert.deepEqual(parseActionItemGroups([{ owner: 'Acme', items: ['One', 2] }]), []);
    assert.deepEqual(parseActionItemGroups([{ owner: 'Acme', items: ['One', '  '] }]), []);
    assert.deepEqual(parseActionItemGroups([{ owner: 'Acme', items: ['One', null] }]), []);
  });

  it('discards already-accumulated groups when a later entry is invalid', () => {
    assert.deepEqual(
      parseActionItemGroups([{ owner: 'Valid', items: ['Kept'] }, { owner: 42 }]),
      [],
    );
  });

  // Only the summary parser drops these -- a record already on disk renders
  // whatever was persisted, so the flag stays off everywhere else.
  it('keeps unattributed placeholder owners by default', () => {
    assert.deepEqual(parseActionItemGroups([{ owner: 'Speaker 1', items: ['Follow up'] }]), [
      { owner: 'Speaker 1', items: ['Follow up'] },
    ]);
  });

  it('drops placeholder owners when dropPlaceholderOwners is set', () => {
    assert.deepEqual(
      parseActionItemGroups(
        [
          { owner: 'Speaker 1', items: ['Ignored'] },
          { owner: 'participant #2', items: ['Ignored too'] },
          { owner: '참가자 3', items: ['Also ignored'] },
          { owner: 'Acme', items: ['Publish the notes'] },
        ],
        { dropPlaceholderOwners: true },
      ),
      [{ owner: 'Acme', items: ['Publish the notes'] }],
    );
  });

  it('drops a placeholder owner recognised only after trimming', () => {
    assert.deepEqual(
      parseActionItemGroups([{ owner: '  SPEAKER2  ', items: ['Ignored'] }], {
        dropPlaceholderOwners: true,
      }),
      [],
    );
  });

  it('keeps owners that merely start like a placeholder', () => {
    assert.deepEqual(
      parseActionItemGroups(
        [
          { owner: 'Speaker A', items: ['Kept'] },
          { owner: 'Speaker 1 (PM)', items: ['Kept too'] },
        ],
        { dropPlaceholderOwners: true },
      ),
      [
        { owner: 'Speaker A', items: ['Kept'] },
        { owner: 'Speaker 1 (PM)', items: ['Kept too'] },
      ],
    );
  });

  it('returns [] when every group was a placeholder', () => {
    assert.deepEqual(
      parseActionItemGroups(
        [
          { owner: 'Speaker 1', items: ['Ignored'] },
          { owner: 'Speaker 2', items: ['Ignored too'] },
        ],
        { dropPlaceholderOwners: true },
      ),
      [],
    );
  });
});

describe('camelToLabel', () => {
  it('splits camelCase and capitalises the first word', () => {
    assert.equal(camelToLabel('keyDecisions'), 'Key Decisions');
    assert.equal(camelToLabel('summary'), 'Summary');
    assert.equal(camelToLabel('openQuestionsForLegal'), 'Open Questions For Legal');
  });

  it('leaves an already-capitalised key alone', () => {
    assert.equal(camelToLabel('Decisions'), 'Decisions');
  });

  it('returns an empty string for an empty key', () => {
    assert.equal(camelToLabel(''), '');
  });
});

describe('renderMeetingSections', () => {
  const input = {
    summary: 'A short greeting.',
    summarySections: [
      { heading: 'Agenda', bullets: ['Discussed the roadmap', 'Picked a date'] },
      { heading: 'Risks', bullets: ['Vendor lead time'] },
    ],
    keyPoints: ['Greeting exchanged'],
    actionItems: ['Schedule follow-up'],
    actionItemGroups: [{ owner: 'Acme', items: ['Publish release notes'] }],
  };

  it('emits every block with headings by default', () => {
    assert.equal(
      renderMeetingSections(input).join('\n'),
      [
        '## Summary\n',
        '### Agenda',
        '- Discussed the roadmap',
        '- Picked a date',
        '',
        '### Risks',
        '- Vendor lead time',
        '',
        '## Key Points\n',
        '- Greeting exchanged',
        '',
        '## Action Items\n',
        '### Acme',
        '- Publish release notes',
        '',
      ].join('\n'),
    );
  });

  it('falls back to the flat summary and action items when structured fields are absent', () => {
    assert.equal(
      renderMeetingSections({
        summary: 'A short greeting.',
        keyPoints: ['Greeting exchanged'],
        actionItems: ['Schedule follow-up'],
      }).join('\n'),
      [
        '## Summary\n',
        'A short greeting.',
        '',
        '## Key Points\n',
        '- Greeting exchanged',
        '',
        '## Action Items\n',
        '- Schedule follow-up',
        '',
      ].join('\n'),
    );
  });

  // The flat-summary branch pushes the text and a blank line separately; the
  // joined result has to stay byte-identical to the single `${summary}\n` push
  // that summary.md was written with before the emitter was shared.
  it('keeps one blank line after a flat summary, mid-document and at the end', () => {
    assert.equal(
      renderMeetingSections({ summary: 'Only a summary.' }).join('\n'),
      '## Summary\n\nOnly a summary.\n',
    );
    assert.equal(
      renderMeetingSections({ summary: 'Then more.', keyPoints: ['A point'] }).join('\n'),
      '## Summary\n\nThen more.\n\n## Key Points\n\n- A point\n',
    );
  });

  it('prefers structured sections over the flat summary', () => {
    const lines = renderMeetingSections(input, 'summary');
    assert.ok(!lines.includes('A short greeting.'));
    assert.deepEqual(lines, [
      '### Agenda',
      '- Discussed the roadmap',
      '- Picked a date',
      '',
      '### Risks',
      '- Vendor lead time',
      '',
    ]);
  });

  it('prefers grouped action items over the flat list', () => {
    assert.deepEqual(renderMeetingSections(input, 'actions'), [
      '### Acme',
      '- Publish release notes',
      '',
    ]);
  });

  // The per-field tabs render their own header, so a filtered call must not
  // repeat the `## ` heading.
  it('emits a single block without its heading when a section is named', () => {
    assert.deepEqual(renderMeetingSections(input, 'keypoints'), ['- Greeting exchanged', '']);
    assert.deepEqual(renderMeetingSections({ summary: 'A short greeting.' }, 'summary'), [
      'A short greeting.',
      '',
    ]);
  });

  it('emits nothing for a section it does not own', () => {
    assert.deepEqual(renderMeetingSections(input, 'livenotes'), []);
    assert.deepEqual(renderMeetingSections(input, 'transcript'), []);
    assert.deepEqual(renderMeetingSections(input, 'cf-decisions'), []);
  });

  it('skips blocks whose fields are absent or empty', () => {
    assert.deepEqual(renderMeetingSections({}), []);
    assert.deepEqual(
      renderMeetingSections({
        summary: '',
        summarySections: [],
        keyPoints: [],
        actionItems: [],
        actionItemGroups: [],
      }),
      [],
    );
  });
});
