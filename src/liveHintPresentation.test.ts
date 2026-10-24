import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupHints,
  hintAnchor,
  hintTitle,
  orderHints,
  searchHints,
  retainHints,
  type HintPresentation,
} from './liveHintPresentation';

const cue = (id: string, extra: Partial<HintPresentation> = {}): HintPresentation => ({
  id,
  text: 'Original body',
  sources: [],
  ...extra,
});
test('legacy title preserves full body and evidence time never uses generation time', () => {
  const legacy = cue('old', { text: '긴 원문'.repeat(80), offsetMs: 9999 });
  assert.equal(hintTitle(legacy), legacy.text);
  assert.equal(hintAnchor(legacy), undefined);
  assert.equal(hintAnchor(cue('new', { anchorOffsetMs: 20, sources: [{ offsetMs: 90 }] })), 20);
  assert.equal(
    hintAnchor(cue('old', { sources: [{ offsetMs: 10 }, { offsetMs: 30 }, { offsetMs: NaN }] })),
    30,
  );
});
test('search normalizes Korean composition and Latin case across title body detail and topic', () => {
  const hints = [
    cue('a', { title: '수면 PSG', detail: '상세 정보', topicLabel: '모델 평가' }),
    cue('b'),
  ];
  for (const query of ['수면'.normalize('NFD'), 'psg', 'original', '상세', '평가'])
    assert.equal(searchHints(hints, query)[0].id, 'a');
  assert.deepEqual(searchHints(hints, '없는 결과'), []);
  assert.equal(searchHints(hints, ' ').length, 2);
  assert.equal(hints[0].title, '수면 PSG');
});
test('chronological ordering is stable with generation/id ties and source-less legacy entries last', () => {
  const hints = [
    cue('z'),
    cue('b', { anchorOffsetMs: 20, offsetMs: 30 }),
    cue('a', { anchorOffsetMs: 20, offsetMs: 30 }),
    cue('first', { sources: [{ offsetMs: 10 }] }),
  ];
  assert.deepEqual(
    orderHints(hints).map((hint) => hint.id),
    ['first', 'a', 'b', 'z'],
  );
  assert.equal(hints[0].id, 'z');
});
test('stable topic IDs group equal labels separately and retain chronological group and row order', () => {
  const hints = [
    cue('late', { topicId: 'one', topicLabel: '주제', anchorOffsetMs: 30 }),
    cue('other', { topicId: 'two', topicLabel: '주제', anchorOffsetMs: 20 }),
    cue('early', { topicId: 'one', topicLabel: '주제', anchorOffsetMs: 10 }),
    cue('legacy'),
  ];
  const groups = groupHints(hints);
  assert.deepEqual(
    groups.map((group) => group.id),
    ['one', 'two', ''],
  );
  assert.deepEqual(
    groups[0].hints.map((hint) => hint.id),
    ['early', 'late'],
  );
  assert.equal(groups[2].label, '미분류');
});

test('search includes earlier wording without mutating current content', () => {
  const hint = cue('updated', {
    title: 'New title',
    text: 'Current body',
    history: [
      {
        revision: 1,
        title: '이전 제목',
        text: 'Earlier PSG decision',
        detail: '옛 상세',
        producedOffsetMs: 100,
      },
    ],
  });
  for (const query of ['이전'.normalize('NFD'), 'psg', '옛 상세'])
    assert.deepEqual(searchHints([hint], query), [hint]);
  assert.equal(hint.text, 'Current body');
});

test('retain complete 200-cue engine window and older pinned cues', () => {
  const hints = Array.from({ length: 205 }, (_, index) => cue(String(index)));
  const retained = retainHints(hints, new Set(['203']));
  assert.equal(retained.length, 201);
  assert.equal(retained[199].id, '199');
  assert.equal(retained[200].id, '203');
  assert.equal(searchHints(retained, 'Original').length, 201);
});
