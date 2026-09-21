// Seeded corpus for the repetition/hallucination analyzer (issue #182).
// Two behaviors are locked in:
//   - Loop shapes providers actually emit on silence/noise/music are flagged:
//     exact repeated lines, near-duplicate lines (spacing/punctuation
//     variants), word-block loops, space-less character loops, and long
//     high-compression repetition.
//   - Legitimate speech repetition is NOT flagged: confirmations (네, 네),
//     stutters, emphasis, short chants, code-switching, and clean prose.
// The gate on top never deletes silently: ordered bounded context-cleared
// retries stop at the first clean rung, while exhaustion keeps the FIRST
// result marked uncertain.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SPEAKER_ID_CAP,
  analyzeAssembledTranscript,
  analyzeTranscriptQuality,
  applyTranscriptQualityGate,
  detectPromptEcho,
  normalizeForComparison,
  findScriptMixOutliers,
  normalizeSpeakerLabels,
  normalizeTranscriptQualityNotes,
  reconcileOverlappingSegments,
  scriptMix,
  splitIntoScriptWindows,
  stripNoSpeechSentinel,
  stripSpeakerLabel,
} from './transcriptQuality';

describe('normalizeForComparison', () => {
  it('treats Korean spacing and punctuation variants as identical', () => {
    assert.equal(
      normalizeForComparison('오늘 회의를 시작하겠습니다.'),
      normalizeForComparison('오늘회의를  시작하겠습니다'),
    );
  });

  it('is case-insensitive for Latin text', () => {
    assert.equal(normalizeForComparison('Feature Flag'), normalizeForComparison('feature flag'));
  });
});

describe('analyzeTranscriptQuality: clean speech stays unflagged', () => {
  it('accepts clean Korean meeting prose', () => {
    const report = analyzeTranscriptQuality(
      `참가자1: 오늘 회의에서는 2분기 마케팅 전략을 논의하겠습니다. 지난달 캠페인 성과부터 공유드리면, 신규 가입자가 전월 대비 12% 증가했습니다.

참가자2: 좋은 결과네요. 다만 유지율이 조금 떨어졌는데, 온보딩 개선이 필요해 보입니다.

참가자1: 맞습니다. 다음 스프린트에 온보딩 개선 작업을 우선순위로 올리고, 푸시 알림 실험도 병행하죠.`,
    );
    assert.equal(report.flagged, false);
    assert.deepEqual(report.reasons, []);
  });

  it('accepts clean English prose above the compression-metric length floor', () => {
    const report = analyzeTranscriptQuality(
      `Speaker 1: Let's review the quarterly roadmap. The mobile release slipped by a week, but the backend migration finished early, so overall we're on track.

Speaker 2: Good. For the next milestone, we need to decide whether to prioritize the analytics dashboard or the export feature that enterprise customers requested.`,
    );
    assert.equal(report.flagged, false);
    assert.ok(report.metrics.textCompressionRatio > 0, 'long text should compute a ratio');
  });

  it('accepts Korean/English code-switched speech', () => {
    const report = analyzeTranscriptQuality(
      `참가자1: 이번에 릴리즈한 feature flag 시스템은 rollout percentage를 서버에서 조절할 수 있습니다.

참가자2: 그러면 QA 팀에서 staging 환경 테스트만 끝나면 바로 production 배포 가능하겠네요.`,
    );
    assert.equal(report.flagged, false);
  });

  it('accepts legitimate repetition: confirmations, stutters, emphasis, short chants', () => {
    for (const text of [
      '참가자2: 네, 네. 가능합니다.',
      '참가자1: 그 그 그 프로젝트가 지금 어디까지 진행됐죠?',
      '참가자1: 정말 정말 정말 좋았습니다. 다들 고생 많으셨어요.',
      '참가자 전원: 파이팅 파이팅 파이팅',
    ]) {
      const report = analyzeTranscriptQuality(text);
      assert.equal(report.flagged, false, `should not flag: ${text}`);
    }
  });

  it('does not score a two-speaker acknowledgement exchange as a word-block loop', () => {
    // `참가자1: 네.` / `참가자2: 네.` tokenizes as the period-4 block
    // `참가자1 네 참가자2 네`, which reached the 4-repeat rule on genuine
    // speech in a Soniox whole-file eval. Two distinct speakers make it an
    // exchange, so it may neither flag nor inflate the metric.
    const exchange = Array.from({ length: 20 }, (_, i) => `참가자${(i % 2) + 1}: 네.`).join('\n\n');
    assert.equal(analyzeTranscriptQuality(exchange).metrics.maxWordBlockRepeats, 1);
  });

  it('keeps a bare alternating acknowledgement exchange clean at twenty and thirty turns', () => {
    // The Soniox whole-file false positive: with nothing else in the text the
    // whitespace-stripped concatenation `참가자1네참가자2네...` is exactly
    // periodic, so the whole-text character-period check fired on a genuine
    // meeting close. Two distinct speakers make it an exchange.
    for (const turns of [20, 30]) {
      const exchange = Array.from({ length: turns }, (_, i) => `참가자${(i % 2) + 1}: 네.`).join(
        '\n\n',
      );
      const report = analyzeTranscriptQuality(exchange);
      assert.deepEqual(report.reasons, [], `${turns} alternating turns should stay clean`);
      assert.equal(report.flagged, false);
    }
  });

  it('does not accumulate short acknowledgement lines into a duplicate run', () => {
    const report = analyzeTranscriptQuality('참가자1: 네\n\n참가자2: 네\n\n참가자1: 네');
    assert.equal(report.flagged, false);
  });

  it('accepts empty and trivial input', () => {
    assert.equal(analyzeTranscriptQuality('').flagged, false);
    assert.equal(analyzeTranscriptQuality('네.').flagged, false);
  });

  it('accepts ellipses and a five-word acknowledgement run', () => {
    assert.equal(
      analyzeTranscriptQuality('참가자1: 음...... 그건 조금 더 고민해보겠습니다.').flagged,
      false,
    );
    assert.equal(analyzeTranscriptQuality('참가자2: 네 네 네 네 네').flagged, false);
  });

  it('does not treat benign within-line repetition as a flood', () => {
    // Laughter is flagged by the existing char-period loop check; what matters
    // here is that the within-line flood detector stays far above these shapes.
    for (const text of [
      `참가자1: ${'ㅋ'.repeat(20)}`,
      '참가자1: 음...... 그건 조금 더 고민해보겠습니다.',
      '참가자2: 네 네 네 네 네 네',
      '참가자1: 다음 주 화요일까지 초안을 공유드리겠습니다.',
    ]) {
      const report = analyzeTranscriptQuality(text);
      assert.ok(
        !report.reasons.includes('intra-line-token-flood'),
        `should not report a flood: ${text}`,
      );
    }
  });

  it('reports zero intra-line runs for empty text and one for a single occurrence', () => {
    const empty = analyzeTranscriptQuality('').metrics;
    assert.equal(empty.maxIntraLineCharRun, 0);
    assert.equal(empty.maxIntraLineTokenRun, 0);

    const single = analyzeTranscriptQuality('참가자1: 네.').metrics;
    assert.equal(single.maxIntraLineCharRun, 1);
    assert.equal(single.maxIntraLineTokenRun, 1);
  });
});

describe('analyzeTranscriptQuality: loop shapes are flagged', () => {
  it('flags three or more consecutive identical lines', () => {
    const report = analyzeTranscriptQuality(
      Array(3).fill('참가자1: 시청해주셔서 감사합니다.').join('\n\n'),
    );
    assert.equal(report.flagged, true);
    assert.ok(report.reasons.includes('consecutive-duplicate-lines'));
    assert.ok(report.metrics.maxConsecutiveDuplicateLines >= 3);
  });

  it('flags near-duplicate consecutive lines across spacing/punctuation variants', () => {
    const report = analyzeTranscriptQuality(
      [
        '참가자1: 시청해주셔서 감사합니다.',
        '참가자1: 시청해 주셔서 감사합니다',
        '참가자1: 시청해주셔서  감사합니다!',
      ].join('\n\n'),
    );
    assert.equal(report.flagged, true);
    assert.ok(report.reasons.includes('consecutive-duplicate-lines'));
  });

  it('flags a single word repeated many times', () => {
    const report = analyzeTranscriptQuality(`참가자1: ${Array(12).fill('자막').join(' ')}`);
    assert.equal(report.flagged, true);
    assert.ok(report.reasons.includes('repeated-ngram-loop'));
  });

  it('flags the same 4-gram repeated four consecutive times', () => {
    const report = analyzeTranscriptQuality(
      `참가자1: ${Array(4).fill('이 영상은 자동 생성되었습니다').join(' ')}`,
    );
    assert.equal(report.flagged, true);
    assert.ok(report.reasons.includes('repeated-ngram-loop'));
  });

  it('flags a qualifying block even when a larger non-qualifying repeat count exists', () => {
    const report = analyzeTranscriptQuality(
      '네 네 네 네 네 이 영상은 자동 생성되었습니다 이 영상은 자동 생성되었습니다 이 영상은 자동 생성되었습니다 이 영상은 자동 생성되었습니다',
    );
    assert.equal(report.flagged, true);
    assert.ok(report.reasons.includes('repeated-ngram-loop'));
  });

  it('does not flag five single-word repeats alone', () => {
    const report = analyzeTranscriptQuality('네 네 네 네 네');
    assert.equal(report.flagged, false);
  });

  it('flags the same twenty turns when they all come from one speaker', () => {
    const loop = Array.from({ length: 20 }, () => '참가자1: 네.').join('\n\n');
    const report = analyzeTranscriptQuality(loop);
    assert.equal(report.flagged, true);
    assert.ok(report.reasons.includes('repeated-ngram-loop'));
  });

  it('flags one sentence repeated under alternating speaker ids', () => {
    // A hallucinated dialogue, not an exchange: the payload is identical on
    // every turn. Only the duplicate-line check can see this shape -- the
    // six-token block exceeds WORD_BLOCK_MAX_PERIOD and the text is too short
    // for the compression metric.
    const hallucination = Array.from(
      { length: 6 },
      (_, i) => `참가자${(i % 2) + 1}: 시청해주셔서 감사합니다.`,
    ).join('\n\n');
    const report = analyzeTranscriptQuality(hallucination);
    assert.equal(report.flagged, true);
    assert.ok(report.reasons.includes('consecutive-duplicate-lines'));
    assert.ok(report.metrics.maxConsecutiveDuplicateLines >= 6);
  });

  it('flags a character loop that only the whole-text check can see', () => {
    // The period straddles the line break, so neither line is periodic on its
    // own and the two lines are not near-duplicates. Single-speaker text keeps
    // the whole-text character-period check live; only an exchange skips it.
    const report = analyzeTranscriptQuality('감사합니다감사합니다감사\n\n합니다감사합니다');
    assert.equal(report.flagged, true);
    assert.ok(report.reasons.includes('repeated-ngram-loop'));
  });

  it('flags space-less Korean character loops behind a speaker label', () => {
    const report = analyzeTranscriptQuality('참가자1: 감사합니다감사합니다감사합니다감사합니다');
    assert.equal(report.flagged, true);
    assert.ok(report.reasons.includes('repeated-ngram-loop'));
  });

  it('accepts a genuine triple emphasis behind a speaker label', () => {
    const report = analyzeTranscriptQuality('참가자1: 감사합니다감사합니다감사합니다');
    assert.equal(report.flagged, false);
  });

  it('flags a single line flooded with one repeated symbol', () => {
    const report = analyzeTranscriptQuality('+'.repeat(30000));
    assert.equal(report.flagged, true);
    assert.deepEqual(report.reasons, ['intra-line-token-flood']);
    assert.equal(report.metrics.maxIntraLineCharRun, 30000);
    // Exactly why the raw-line pass exists: normalization strips symbols, so
    // every other detector here sees an empty string.
    assert.equal(report.metrics.normalizedLength, 0);
  });

  it('flags a line repeating one token behind a speaker label', () => {
    const report = analyzeTranscriptQuality(`참가자1: ${Array(1309).fill('I').join(' ')}`);
    assert.equal(report.flagged, true);
    assert.ok(report.reasons.includes('intra-line-token-flood'));
    assert.equal(report.metrics.maxIntraLineTokenRun, 1309);
  });

  it('flags long repetitive text via the local compression metric', () => {
    const report = analyzeTranscriptQuality(Array(40).fill('구독과 좋아요 부탁드립니다').join(' '));
    assert.equal(report.flagged, true);
    assert.ok(report.reasons.includes('high-text-compression'));
    assert.ok(report.metrics.textCompressionRatio > 4);
  });
});

describe('normalizeSpeakerLabels', () => {
  const idLine = (id: number, text: string) => `참가자${id}: ${text}`;

  it('rewrites every corrupted label shape found in the store audit', () => {
    for (const [raw, expected] of [
      ['참가1: 안녕하세요.', '참가자1: 안녕하세요.'],
      ['참자2: 안녕하세요.', '참가자2: 안녕하세요.'],
      ['참참가자1: 안녕하세요.', '참가자1: 안녕하세요.'],
      ['참가자 3: 안녕하세요.', '참가자3: 안녕하세요.'],
      ['참가자4 : 안녕하세요.', '참가자4: 안녕하세요.'],
      ['참가자5：안녕하세요.', '참가자5: 안녕하세요.'],
      ['[참가자6] 안녕하세요.', '참가자6: 안녕하세요.'],
      ['[ 참가자7 ] 안녕하세요.', '참가자7: 안녕하세요.'],
      ['참가자#8: 안녕하세요.', '참가자8: 안녕하세요.'],
      ['[참가자 #9]: 안녕하세요.', '참가자9: 안녕하세요.'],
    ] as const) {
      const result = normalizeSpeakerLabels(raw);
      assert.equal(result.text, expected, `failed on: ${raw}`);
      assert.equal(result.normalizedLines, 1, `should count a rewrite for: ${raw}`);
      assert.equal(result.capped, false);
    }
  });

  it('keeps the id digits as given instead of renumbering', () => {
    const result = normalizeSpeakerLabels(
      '참가7: 먼저 말씀드리겠습니다.\n참가3: 이어서 말씀드립니다.',
    );
    assert.equal(result.text, '참가자7: 먼저 말씀드리겠습니다.\n참가자3: 이어서 말씀드립니다.');
    assert.equal(result.distinctIds, 2);
  });

  it('counts no rewrite for labels that are already canonical', () => {
    const body = [idLine(1, '오늘 회의를 시작하겠습니다.'), idLine(2, '네, 준비되었습니다.')].join(
      '\n',
    );
    const result = normalizeSpeakerLabels(body);
    assert.equal(result.text, body);
    assert.equal(result.normalizedLines, 0);
    assert.equal(result.distinctIds, 2);
    assert.equal(result.capped, false);
  });

  it('leaves English speaker labels untouched', () => {
    const body = 'Speaker 1: We approved the launch.\nParticipant 2: Acme will publish it.';
    const result = normalizeSpeakerLabels(body);
    assert.equal(result.text, body);
    assert.equal(result.normalizedLines, 0);
    assert.equal(result.distinctIds, 0);
  });

  it('leaves unlabeled lines and label-shaped prose untouched', () => {
    // No colon and no bracket means no label: rewriting this would eat the
    // first word of real speech.
    const body = '오늘 회의를 시작하겠습니다.\n참가자 3명이 참석했습니다.\n\n감사합니다.';
    const result = normalizeSpeakerLabels(body);
    assert.equal(result.text, body);
    assert.equal(result.normalizedLines, 0);
    assert.equal(result.distinctIds, 0);
  });

  it('returns an empty body unchanged with zeroed counts', () => {
    assert.deepEqual(normalizeSpeakerLabels(''), {
      text: '',
      distinctIds: 0,
      normalizedLines: 0,
      capped: false,
    });
  });

  it('normalizes a bare label line without adding trailing whitespace', () => {
    assert.equal(normalizeSpeakerLabels('[ 참가자1 ]').text, '참가자1:');
  });

  it('collapses ids past the cap onto the last valid id', () => {
    const body = Array.from({ length: 15 }, (_, i) => idLine(i + 1, '어.')).join('\n');
    const result = normalizeSpeakerLabels(body);
    assert.equal(result.capped, true);
    assert.equal(result.distinctIds, 15, 'distinctIds reports the pre-cap count');
    const ids = result.text.split('\n').map((line) => line.slice(0, line.indexOf(':')));
    assert.deepEqual(ids.slice(0, SPEAKER_ID_CAP), [
      '참가자1',
      '참가자2',
      '참가자3',
      '참가자4',
      '참가자5',
      '참가자6',
      '참가자7',
      '참가자8',
      '참가자9',
      '참가자10',
      '참가자11',
      '참가자12',
    ]);
    assert.deepEqual(ids.slice(SPEAKER_ID_CAP), ['참가자12', '참가자12', '참가자12']);
  });

  it('does not cap exactly the cap many ids', () => {
    const body = Array.from({ length: SPEAKER_ID_CAP }, (_, i) => idLine(i + 1, '어.')).join('\n');
    const result = normalizeSpeakerLabels(body);
    assert.equal(result.capped, false);
    assert.equal(result.distinctIds, SPEAKER_ID_CAP);
    assert.equal(result.text, body);
  });

  it('orders ids by first appearance, not by number', () => {
    const body = ['참가자9: 먼저.', '참가자4: 다음.', '참가자9: 다시.', '참가자7: 마지막.'].join(
      '\n',
    );
    const result = normalizeSpeakerLabels(body, { maxDistinctIds: 2 });
    assert.equal(result.capped, true);
    assert.equal(result.distinctIds, 3);
    assert.equal(result.text, '참가자9: 먼저.\n참가자4: 다음.\n참가자9: 다시.\n참가자4: 마지막.');
  });

  it('applies the cap after normalisation, so a variant id counts as itself', () => {
    const body = Array.from({ length: 13 }, (_, i) => `참가${i + 1}: 어.`).join('\n');
    const result = normalizeSpeakerLabels(body);
    assert.equal(result.distinctIds, 13);
    assert.equal(result.normalizedLines, 13);
    assert.equal(result.capped, true);
    assert.ok(result.text.endsWith('참가자12: 어.'));
  });

  it('honors an explicit maxDistinctIds override', () => {
    const body = ['참가자1: 하나.', '참가자2: 둘.', '참가자3: 셋.'].join('\n');
    assert.equal(normalizeSpeakerLabels(body, { maxDistinctIds: 3 }).capped, false);
    const capped = normalizeSpeakerLabels(body, { maxDistinctIds: 2 });
    assert.equal(capped.capped, true);
    assert.equal(capped.text, '참가자1: 하나.\n참가자2: 둘.\n참가자2: 셋.');
  });

  it('is idempotent: normalizing twice equals normalizing once', () => {
    const body = [
      '참가1: 안녕하세요.',
      '[ 참자2 ] 반갑습니다.',
      ...Array.from({ length: 13 }, (_, i) => `참가자${i + 3}：어.`),
      'Speaker 1: Unchanged.',
      '그냥 문장입니다.',
    ].join('\n');
    const once = normalizeSpeakerLabels(body);
    const twice = normalizeSpeakerLabels(once.text);
    assert.equal(twice.text, once.text);
    assert.equal(twice.normalizedLines, 0);
    assert.equal(twice.capped, false);
  });

  it('preserves CRLF line endings', () => {
    const result = normalizeSpeakerLabels('참가1: 안녕하세요.\r\n참가2: 반갑습니다.');
    assert.equal(result.text, '참가자1: 안녕하세요.\r\n참가자2: 반갑습니다.');
  });

  it('produces labels that stripSpeakerLabel accepts', () => {
    const result = normalizeSpeakerLabels('[ 참참가자11 ] 정리하겠습니다.');
    assert.equal(result.text, '참가자11: 정리하겠습니다.');
    assert.equal(stripSpeakerLabel(result.text), '정리하겠습니다.');
  });
});

describe('stripNoSpeechSentinel', () => {
  it('strips the sentinel as whole output, with stray punctuation, and unbracketed', () => {
    assert.equal(stripNoSpeechSentinel('[NO_SPEECH]'), '');
    assert.equal(stripNoSpeechSentinel('  [NO_SPEECH].  '), '');
    assert.equal(stripNoSpeechSentinel('NO_SPEECH'), '');
  });

  it('strips standalone sentinel lines but keeps surrounding speech', () => {
    assert.equal(
      stripNoSpeechSentinel('참가자1: 안녕하세요.\n[NO_SPEECH]\n참가자2: 반갑습니다.'),
      '참가자1: 안녕하세요.\n참가자2: 반갑습니다.',
    );
  });

  it('never touches lines that contain other content', () => {
    const line = '참가자1: NO_SPEECH 상태라고 말했습니다.';
    assert.equal(stripNoSpeechSentinel(line), line);
  });
});

// Prompt echo (issue #197): the provider returns the instructions it was
// given instead of a transcription. The built-in markers cover every prompt
// the pipeline assembles; `promptLines` covers a user's custom prompt and
// glossary. Legitimate speech that merely mentions a glossary term must stay
// unflagged, which is why short prompt lines never participate.
describe('detectPromptEcho', () => {
  it('flags the built-in prompt markers', () => {
    const echoes = [
      '[Audio segment 4 of 12]',
      'The following proper nouns, names, and terms may appear in the audio. Transcribe them exactly as spelled:',
      'Please transcribe this audio recording with proper speaker identification.',
      'Transcribe the speech in this audio exactly as spoken.',
      'Format requirements:',
      '- Return ONLY the transcription text, no JSON formatting',
      '- Return only the transcript text.',
    ];
    for (const echo of echoes) {
      assert.equal(detectPromptEcho(echo).echoed, true, `should flag: ${echo}`);
      assert.deepEqual(detectPromptEcho(echo).reasons, ['prompt-echo']);
    }
  });

  it('matches markers across line breaks and casing', () => {
    const wrapped =
      'please transcribe this audio\n  recording with proper\nspeaker identification.';
    assert.equal(detectPromptEcho(wrapped).echoed, true);
  });

  it('keeps clean speech that mentions a glossary term unflagged', () => {
    const promptLines = [
      'The following proper nouns, names, and terms may appear in the audio. Transcribe them exactly as spelled:',
      '- Listener.AI',
      '- 김한결',
    ];
    const transcript = '참가자1: Listener.AI 배포 일정은 김한결 님이 정리해 주세요.';
    assert.equal(detectPromptEcho(transcript, promptLines).echoed, false);
    assert.deepEqual(detectPromptEcho(transcript, promptLines).reasons, []);
  });

  it('flags a verbatim line of the custom prompt that was actually sent', () => {
    const promptLines = ['Write down every product code that is spoken aloud.'];
    const transcript = '참가자1: write down every product code   that is spoken ALOUD.';
    assert.equal(detectPromptEcho(transcript, promptLines).echoed, true);
    assert.equal(detectPromptEcho(transcript).echoed, false, 'needs the prompt to match');
  });

  it('never flags on a short prompt line', () => {
    assert.equal(detectPromptEcho('참가자1: Foo 관련 이슈입니다.', ['- Foo']).echoed, false);
    assert.equal(detectPromptEcho('참가자1: 네, 맞습니다.', ['- 네, 맞습니다.']).echoed, false);
  });

  it('returns no verdict for empty text', () => {
    assert.equal(
      detectPromptEcho('   ', ['Write down every product code that is spoken.']).echoed,
      false,
    );
  });
});

describe('applyTranscriptQualityGate', () => {
  const loopText = Array(5).fill('참가자1: 시청해주셔서 감사합니다.').join('\n\n');
  const cleanText = '참가자1: 오늘 회의를 시작하겠습니다.';

  it('accepts clean text without invoking the retry', async () => {
    let retries = 0;
    const result = await applyTranscriptQualityGate({
      text: cleanText,
      label: 'test',
      retries: [
        async () => {
          retries++;
          return cleanText;
        },
      ],
      log: () => {},
    });
    assert.equal(result.text, cleanText);
    assert.equal(result.flagged, false);
    assert.equal(result.retried, false);
    assert.equal(result.retriesAttempted, 0);
    assert.equal(retries, 0);
  });

  it('uses a judge flag to trigger retries when the analyzer passes', async () => {
    let judgeCalls = 0;
    let retryCalls = 0;
    const result = await applyTranscriptQualityGate({
      text: cleanText,
      label: 'test',
      judge: async () => ({
        flagged: judgeCalls++ === 0,
        reason: 'repeated phrase block',
      }),
      retries: [
        async () => {
          retryCalls++;
          return '참가자1: 재시도에서 정상 발화가 복구되었습니다.';
        },
      ],
      log: () => {},
    });

    assert.equal(result.text, '참가자1: 재시도에서 정상 발화가 복구되었습니다.');
    assert.equal(result.retried, true);
    assert.equal(retryCalls, 1);
    assert.equal(judgeCalls, 2);
  });

  it('uses a clean judge verdict without retrying analyzer-flagged text', async () => {
    let retryCalls = 0;
    const result = await applyTranscriptQualityGate({
      text: loopText,
      label: 'test',
      judge: async () => ({ flagged: false, reason: 'natural repetition' }),
      retries: [
        async () => {
          retryCalls++;
          return cleanText;
        },
      ],
      log: () => {},
    });

    assert.equal(result.text, loopText);
    assert.equal(result.flagged, false);
    assert.equal(result.retried, false);
    assert.equal(retryCalls, 0);
  });

  it('falls back to the analyzer and logs when the judge fails', async () => {
    const logs: string[] = [];
    const result = await applyTranscriptQualityGate({
      text: loopText,
      label: 'segment 1/2',
      judge: async () => {
        throw new Error('judge unavailable');
      },
      log: (message) => logs.push(message),
    });

    assert.equal(result.flagged, true);
    assert.ok(
      logs.includes(
        '[transcript-quality] segment 1/2: judge failed (judge unavailable); falling back to analyzer',
      ),
    );
    assert.ok(logs.some((line) => line.includes('flagged by analyzer')));
  });

  it('caps judge failure messages and redacts transcript text', async () => {
    const logs: string[] = [];
    await applyTranscriptQualityGate({
      text: cleanText,
      label: 'test',
      judge: async () => {
        throw new Error(`provider rejected ${cleanText} ${'x'.repeat(250)}`);
      },
      log: (message) => logs.push(message),
    });

    assert.equal(logs.length, 1);
    assert.doesNotMatch(logs[0], /오늘 회의를/);
    const errorMessage = logs[0].match(/judge failed \((.*)\); falling back/)?.[1];
    assert.ok(errorMessage);
    assert.equal(errorMessage.length, 200);
  });

  it('rethrows a judge AbortError immediately', async () => {
    const abortError = new DOMException('Aborted', 'AbortError');
    let retryCalls = 0;

    await assert.rejects(
      applyTranscriptQualityGate({
        text: cleanText,
        label: 'test',
        judge: async () => {
          throw abortError;
        },
        retries: [
          async () => {
            retryCalls++;
            return cleanText;
          },
        ],
        log: () => {},
      }),
      (error) => error === abortError,
    );
    assert.equal(retryCalls, 0);
  });

  it('uses the judge verdict when accepting a retry result', async () => {
    const retryLoop = `참가자1: ${Array(12).fill('자막').join(' ')}`;
    let judgeCalls = 0;
    const result = await applyTranscriptQualityGate({
      text: cleanText,
      label: 'test',
      judge: async () => ({ flagged: judgeCalls++ === 0, reason: 'loop verdict' }),
      retries: [async () => retryLoop],
      log: () => {},
    });

    assert.equal(result.text, retryLoop);
    assert.equal(result.flagged, false);
    assert.equal(result.retried, true);
    assert.equal(judgeCalls, 2);
  });

  it('treats empty text as clean without invoking the judge', async () => {
    let judgeCalls = 0;
    const result = await applyTranscriptQualityGate({
      text: '  \n\t ',
      label: 'test',
      judge: async () => {
        judgeCalls++;
        return { flagged: true, reason: 'must not run' };
      },
      log: () => {},
    });

    assert.equal(result.flagged, false);
    assert.equal(result.text, '  \n\t ');
    assert.equal(judgeCalls, 0);
  });

  it('replaces a flagged first result with a clean retry', async () => {
    const result = await applyTranscriptQualityGate({
      text: loopText,
      label: 'test',
      retries: [async () => cleanText],
      log: () => {},
    });
    assert.equal(result.text, cleanText);
    assert.equal(result.flagged, false);
    assert.equal(result.retried, true);
  });

  it('accepts an empty retry as evidence of silence', async () => {
    let judgeCalls = 0;
    const result = await applyTranscriptQualityGate({
      text: loopText,
      label: 'test',
      judge: async () => {
        judgeCalls++;
        return { flagged: true, reason: 'repeated line loop' };
      },
      retries: [async () => ''],
      log: () => {},
    });
    assert.equal(result.text, '');
    assert.equal(result.flagged, false);
    assert.equal(judgeCalls, 1, 'only the non-empty first result should be judged');
  });

  it('keeps the FIRST result marked uncertain when the retry is still flagged', async () => {
    const otherLoop = `참가자1: ${Array(12).fill('자막').join(' ')}`;
    const result = await applyTranscriptQualityGate({
      text: loopText,
      label: 'test',
      retries: [async () => otherLoop],
      log: () => {},
    });
    assert.equal(result.text, loopText);
    assert.equal(result.flagged, true);
    assert.ok(result.reasons.length > 0);
  });

  it('keeps the first result when the retry throws', async () => {
    let cleanupCalls = 0;
    const result = await applyTranscriptQualityGate({
      text: loopText,
      label: 'test',
      retries: [
        async () => {
          throw new Error('rate limited');
        },
      ],
      cleanup: async () => {
        cleanupCalls++;
        return cleanText;
      },
      log: () => {},
    });
    assert.equal(result.text, loopText);
    assert.equal(result.flagged, true);
    assert.equal(cleanupCalls, 0);
  });

  it('invokes the retry at most once', async () => {
    let retries = 0;
    await applyTranscriptQualityGate({
      text: loopText,
      label: 'test',
      retries: [
        async () => {
          retries++;
          return loopText;
        },
      ],
      log: () => {},
    });
    assert.equal(retries, 1);
  });

  it('keeps flagged text as-is when no retry is available', async () => {
    const result = await applyTranscriptQualityGate({
      text: loopText,
      label: 'test',
      log: () => {},
    });
    assert.equal(result.text, loopText);
    assert.equal(result.flagged, true);
    assert.equal(result.retried, false);
  });

  it('never leaks transcript text into log lines', async () => {
    const logs: string[] = [];
    await applyTranscriptQualityGate({
      text: loopText,
      label: 'segment 1/2',
      retries: [async () => loopText],
      log: (message) => logs.push(message),
    });
    assert.ok(logs.length > 0);
    for (const line of logs) {
      assert.ok(!line.includes('감사합니다'), `log leaked transcript text: ${line}`);
    }
  });

  it('uses a clean first rung without invoking the second rung or cleanup', async () => {
    const calls = [0, 0];
    let cleanupCalls = 0;
    const result = await applyTranscriptQualityGate({
      text: loopText,
      label: 'test',
      retries: [
        async () => {
          calls[0]++;
          return cleanText;
        },
        async () => {
          calls[1]++;
          return '참가자2: 호출되면 안 됩니다.';
        },
      ],
      cleanup: async () => {
        cleanupCalls++;
        return cleanText;
      },
      log: () => {},
    });

    assert.equal(result.text, cleanText);
    assert.deepEqual(calls, [1, 0]);
    assert.equal(cleanupCalls, 0);
    assert.equal(result.retriesAttempted, 1);
  });

  it('uses a clean second rung after the first rung is still flagged', async () => {
    const result = await applyTranscriptQualityGate({
      text: loopText,
      label: 'test',
      retries: [async () => loopText, async () => cleanText],
      log: () => {},
    });

    assert.equal(result.text, cleanText);
    assert.equal(result.flagged, false);
    assert.equal(result.retriesAttempted, 2);
  });

  it('keeps the first result when both rungs are flagged', async () => {
    const otherLoop = `참가자1: ${Array(12).fill('자막').join(' ')}`;
    const result = await applyTranscriptQualityGate({
      text: loopText,
      label: 'test',
      retries: [async () => otherLoop, async () => otherLoop],
      log: () => {},
    });

    assert.equal(result.text, loopText);
    assert.equal(result.flagged, true);
    assert.equal(result.retriesAttempted, 2);
  });

  it('accepts a shorter judged-clean cleanup after retry exhaustion', async () => {
    const cleanedText = '참가자1: 실제 발화입니다.';
    const cleanedInputs: string[] = [];
    const logs: string[] = [];
    const result = await applyTranscriptQualityGate({
      text: loopText,
      label: 'segment 1/2',
      judge: async (text) => ({
        flagged: text !== cleanedText,
        reason: text === cleanedText ? 'natural speech' : 'repeated line loop',
      }),
      retries: [async () => loopText],
      cleanup: async (text) => {
        cleanedInputs.push(text);
        return cleanedText;
      },
      log: (message) => logs.push(message),
    });

    assert.deepEqual(cleanedInputs, [loopText]);
    assert.equal(result.text, cleanedText);
    assert.equal(result.flagged, false);
    assert.deepEqual(result.reasons, []);
    assert.equal(result.retried, true);
    assert.equal(result.retriesAttempted, 1);
    assert.equal(result.cleaned, true);
    assert.ok(logs.some((line) => line.includes('cleanup accepted (removed ')));
  });

  it('rejects cleanup output that grows', async () => {
    let judgeCalls = 0;
    const logs: string[] = [];
    const result = await applyTranscriptQualityGate({
      text: loopText,
      label: 'test',
      judge: async () => {
        judgeCalls++;
        return { flagged: true, reason: 'repeated line loop' };
      },
      retries: [async () => loopText],
      cleanup: async () => `${loopText}\n참가자2: 추가된 내용입니다.`,
      log: (message) => logs.push(message),
    });

    assert.equal(result.text, loopText);
    assert.equal(result.flagged, true);
    assert.equal(result.cleaned, undefined);
    assert.equal(judgeCalls, 2, 'grown cleanup must be rejected before another judge call');
    assert.ok(
      logs.includes('[transcript-quality] test: cleanup rejected (grew); keeping first result'),
    );
  });

  it('rejects cleanup output that is still flagged', async () => {
    const shorterLoop = Array(8).fill('자막').join(' ');
    const logs: string[] = [];
    const result = await applyTranscriptQualityGate({
      text: loopText,
      label: 'test',
      judge: async () => ({ flagged: true, reason: 'repeated phrase block' }),
      retries: [async () => loopText],
      cleanup: async () => shorterLoop,
      log: (message) => logs.push(message),
    });

    assert.ok(shorterLoop.length <= loopText.length);
    assert.equal(result.text, loopText);
    assert.equal(result.flagged, true);
    assert.equal(result.cleaned, undefined);
    assert.ok(
      logs.includes(
        '[transcript-quality] test: cleanup rejected (still flagged); keeping first result',
      ),
    );
  });

  it('accepts empty cleanup as clean silence', async () => {
    let judgeCalls = 0;
    const result = await applyTranscriptQualityGate({
      text: loopText,
      label: 'test',
      judge: async () => {
        judgeCalls++;
        return { flagged: true, reason: 'repeated line loop' };
      },
      retries: [async () => loopText],
      cleanup: async () => '',
      log: () => {},
    });

    assert.equal(result.text, '');
    assert.equal(result.flagged, false);
    assert.equal(result.cleaned, true);
    assert.equal(judgeCalls, 2, 'empty cleanup must not invoke the judge');
  });

  it('keeps the first result and caps a redacted cleanup failure', async () => {
    const longTranscript = `참가자1: ${Array(100).fill('기밀발화').join(' ')}`;
    const logs: string[] = [];
    const result = await applyTranscriptQualityGate({
      text: longTranscript,
      label: 'test',
      retries: [async () => longTranscript],
      cleanup: async () => {
        throw new Error(`cleanup provider echoed ${longTranscript} ${'x'.repeat(300)}`);
      },
      log: (message) => logs.push(message),
    });

    assert.equal(result.text, longTranscript);
    assert.equal(result.flagged, true);
    assert.equal(result.cleaned, undefined);
    const cleanupLog = logs.find((line) => line.includes('cleanup failed'));
    assert.ok(cleanupLog);
    assert.doesNotMatch(cleanupLog, /기밀발화/);
    const errorMessage = cleanupLog.match(/cleanup failed \((.*)\); keeping first result/)?.[1];
    assert.ok(errorMessage);
    assert.ok(errorMessage.length <= 200);
  });

  it('rethrows a cleanup AbortError', async () => {
    const abortError = new DOMException('Aborted', 'AbortError');

    await assert.rejects(
      applyTranscriptQualityGate({
        text: loopText,
        label: 'test',
        retries: [async () => loopText],
        cleanup: async () => {
          throw abortError;
        },
        log: () => {},
      }),
      (error) => error === abortError,
    );
  });

  it('skips a throwing first rung and uses a clean second rung', async () => {
    const result = await applyTranscriptQualityGate({
      text: loopText,
      label: 'test',
      retries: [
        async () => {
          throw new Error('rate limited');
        },
        async () => cleanText,
      ],
      log: () => {},
    });

    assert.equal(result.text, cleanText);
    assert.equal(result.flagged, false);
    assert.equal(result.retriesAttempted, 2);
  });

  it('rethrows an abort without invoking the next rung', async () => {
    const abortError = new DOMException('Aborted', 'AbortError');
    let secondCalls = 0;

    await assert.rejects(
      applyTranscriptQualityGate({
        text: loopText,
        label: 'test',
        retries: [
          async () => {
            throw abortError;
          },
          async () => {
            secondCalls++;
            return cleanText;
          },
        ],
        log: () => {},
      }),
      (error) => error === abortError,
    );
    assert.equal(secondCalls, 0);
  });

  it('invokes both rungs at most once each', async () => {
    const calls = [0, 0];
    await applyTranscriptQualityGate({
      text: loopText,
      label: 'test',
      retries: [
        async () => {
          calls[0]++;
          return loopText;
        },
        async () => {
          calls[1]++;
          return loopText;
        },
      ],
      log: () => {},
    });

    assert.deepEqual(calls, [1, 1]);
  });

  it('treats an empty retries array like no retries and does not invoke cleanup', async () => {
    let cleanupCalls = 0;
    const result = await applyTranscriptQualityGate({
      text: loopText,
      label: 'test',
      retries: [],
      cleanup: async () => {
        cleanupCalls++;
        return cleanText;
      },
      log: () => {},
    });

    assert.equal(result.text, loopText);
    assert.equal(result.flagged, true);
    assert.equal(result.retried, false);
    assert.equal(result.retriesAttempted, 0);
    assert.equal(cleanupCalls, 0);
  });

  it('lets the analyzer flag a symbol flood and accepts the clean retry', async () => {
    const floodText = `참가자1: ${'+'.repeat(1200)}`;
    const logs: string[] = [];
    const result = await applyTranscriptQualityGate({
      text: floodText,
      label: 'segment 2/4',
      retries: [async () => cleanText],
      log: (message) => logs.push(message),
    });

    assert.equal(result.text, cleanText);
    assert.equal(result.flagged, false);
    assert.equal(result.retried, true);
    assert.equal(result.retriesAttempted, 1);
    assert.ok(logs.some((line) => line.includes('flagged by analyzer')));
    assert.ok(logs.some((line) => line.includes('intra-line-token-flood')));
    assert.ok(logs.some((line) => line.includes('intraLineCharRun=1200')));
    assert.ok(
      logs.every((line) => !line.includes('++')),
      'logs must never carry transcript text',
    );
  });

  // Prompt echo is the one defect the gate deletes instead of marking
  // uncertain: instruction text in a transcript is always wrong, and it would
  // otherwise reach the summary, Notion, the export and Drive sync.
  const echoedPrompt = 'Please transcribe this audio recording with proper speaker identification.';

  it('drops persistently echoed text and skips both judge and cleanup', async () => {
    let judgeCalls = 0;
    let cleanupCalls = 0;
    const logs: string[] = [];
    const result = await applyTranscriptQualityGate({
      text: echoedPrompt,
      label: 'segment 3/8',
      promptLines: [echoedPrompt, 'Format requirements:'],
      judge: async () => {
        judgeCalls++;
        return { flagged: false };
      },
      retries: [async () => echoedPrompt, async () => `[Audio segment 3 of 8]\n\n${echoedPrompt}`],
      cleanup: async () => {
        cleanupCalls++;
        return cleanText;
      },
      log: (message) => logs.push(message),
    });

    assert.equal(result.text, '');
    assert.equal(result.flagged, true);
    assert.deepEqual(result.reasons, ['prompt-echo']);
    assert.equal(result.dropped, 'prompt-echo');
    assert.equal(result.retried, true);
    assert.equal(result.retriesAttempted, 2);
    assert.equal(judgeCalls, 0, 'the judge only knows loop shapes');
    assert.equal(cleanupCalls, 0, 'cleaning instruction text cannot recover speech');
    assert.ok(logs.some((line) => line.includes('prompt echo persisted')));
    assert.ok(logs.some((line) => line.includes('flagged by echo (prompt-echo;')));
    assert.ok(
      logs.every(
        (line) => !line.includes('transcribe this audio') && !line.includes('Audio segment'),
      ),
      'logs must never carry prompt or transcript text',
    );
  });

  it('drops echoed text when no retry is available', async () => {
    let cleanupCalls = 0;
    const result = await applyTranscriptQualityGate({
      text: `[Audio segment 1 of 4]\n\n${echoedPrompt}`,
      label: 'short audio (gemini)',
      cleanup: async () => {
        cleanupCalls++;
        return cleanText;
      },
      log: () => {},
    });

    assert.equal(result.text, '');
    assert.equal(result.dropped, 'prompt-echo');
    assert.equal(result.retried, false);
    assert.equal(result.retriesAttempted, 0);
    assert.equal(cleanupCalls, 0);
  });

  it('accepts a clean retry after an echoed first result', async () => {
    const result = await applyTranscriptQualityGate({
      text: echoedPrompt,
      label: 'segment 1/2',
      promptLines: [echoedPrompt],
      retries: [async () => cleanText, async () => loopText],
      log: () => {},
    });

    assert.equal(result.text, cleanText);
    assert.equal(result.flagged, false);
    assert.deepEqual(result.reasons, []);
    assert.equal(result.retried, true);
    assert.equal(result.retriesAttempted, 1);
    assert.equal(result.dropped, undefined);
  });

  it('never returns a retry result that echoes the prompt', async () => {
    const result = await applyTranscriptQualityGate({
      text: loopText,
      label: 'segment 2/2',
      promptLines: [echoedPrompt],
      retries: [async () => echoedPrompt],
      log: () => {},
    });

    assert.equal(result.text, loopText, 'the flagged first result is kept, not the echo');
    assert.equal(result.flagged, true);
    assert.equal(result.dropped, undefined);
  });
});

describe('analyzeAssembledTranscript', () => {
  const header = (n: number, from: string, to: string) => `[Segment ${n}: ${from} ~ ${to}]`;

  it('accepts a clean assembled multi-segment transcript', () => {
    const assembled = [
      `${header(1, '00:00:00', '00:05:00')}\n\n참가자1: 오늘 회의에서는 2분기 마케팅 전략을 논의하겠습니다.`,
      `${header(2, '00:05:00', '00:10:00')}\n\n참가자2: 온보딩 개선이 필요해 보입니다.`,
    ].join('\n\n---\n\n');
    assert.equal(analyzeAssembledTranscript(assembled).flagged, false);
  });

  it('does not false-flag adjacent headers left by empty (silent) segments', () => {
    const assembled = [
      `${header(1, '00:00:00', '00:05:00')}`,
      `${header(2, '00:05:00', '00:10:00')}`,
      `${header(3, '00:10:00', '00:15:00')}`,
      `${header(4, '00:15:00', '00:20:00')}\n\n참가자1: 이제 시작하겠습니다.`,
    ].join('\n\n---\n\n');
    assert.equal(analyzeAssembledTranscript(assembled).flagged, false);
  });

  it('flags a hallucination loop spanning a segment boundary', () => {
    const loopLine = '참가자1: 시청해주셔서 감사합니다.';
    const assembled = [
      `${header(1, '00:00:00', '00:05:00')}\n\n참가자1: 마지막 안건입니다.\n\n${loopLine}\n\n${loopLine}`,
      `${header(2, '00:05:00', '00:10:00')}\n\n${loopLine}\n\n참가자2: 다음 주에 뵙겠습니다.`,
    ].join('\n\n---\n\n');
    const report = analyzeAssembledTranscript(assembled);
    assert.equal(report.flagged, true);
    assert.ok(report.reasons.includes('consecutive-duplicate-lines'));
  });

  it('keeps a two-speaker acknowledgement exchange at a meeting close unflagged', () => {
    const exchange = Array.from({ length: 20 }, (_, i) => `참가자${(i % 2) + 1}: 네.`).join('\n\n');
    const assembled = [
      header(5, '00:20:00', '00:25:00'),
      '참가자1: 오늘 논의한 내용은 여기까지입니다. 다음 회의는 다음 주 화요일 오후 두 시에 진행하겠습니다.',
      exchange,
      '참가자2: 네, 다들 고생 많으셨습니다.',
    ].join('\n\n');
    const report = analyzeAssembledTranscript(assembled);
    assert.equal(report.flagged, false);
    assert.deepEqual(report.reasons, []);
  });

  it('keeps a bare alternating exchange clean at twenty and thirty turns', () => {
    for (const turns of [20, 30]) {
      const exchange = Array.from({ length: turns }, (_, i) => `참가자${(i % 2) + 1}: 네.`).join(
        '\n\n',
      );
      const report = analyzeAssembledTranscript(
        `${header(5, '00:20:00', '00:25:00')}\n\n${exchange}`,
      );
      assert.equal(report.flagged, false, `${turns} alternating turns should stay clean`);
      assert.deepEqual(report.reasons, []);
    }
  });

  it('still flags the same twenty turns when they all come from one speaker', () => {
    const loop = Array.from({ length: 20 }, () => '참가자1: 네.').join('\n\n');
    const report = analyzeAssembledTranscript(`${header(5, '00:20:00', '00:25:00')}\n\n${loop}`);
    assert.equal(report.flagged, true);
    assert.ok(report.reasons.includes('repeated-ngram-loop'));
    assert.ok(report.metrics.maxWordBlockRepeats >= 6);
  });

  it('flags a symbol flood inside one segment body', () => {
    const assembled = [
      `${header(1, '00:00:00', '00:05:00')}\n\n참가자1: 오늘 회의를 시작하겠습니다.`,
      `${header(2, '00:05:00', '00:10:00')}\n\n참가자1: ${'+'.repeat(500)}`,
    ].join('\n\n---\n\n');
    const report = analyzeAssembledTranscript(assembled);
    assert.equal(report.flagged, true);
    assert.ok(report.reasons.includes('intra-line-token-flood'));
    assert.equal(report.metrics.maxIntraLineCharRun, 500);
  });
});

// Synthetic fixtures only: generic sentences written for the test, no real
// names, no text copied from the audited recordings.
const KOREAN_LINES = [
  '오늘 회의에서는 다음 분기 일정을 함께 검토하겠습니다.',
  '예산 배분은 지난번 논의대로 유지하는 편이 좋겠습니다.',
  '담당자는 각 팀에서 한 명씩 지정해 주시기 바랍니다.',
  '일정 지연이 발생하면 즉시 공유해 주시면 감사하겠습니다.',
  '다음 주까지 초안을 정리해서 다시 안내드리겠습니다.',
  '추가로 논의할 안건이 있으면 말씀해 주시기 바랍니다.',
];

const PORTUGUESE_LINES = [
  'Hoje vamos conversar sobre o futuro da tecnologia e o impacto dela no trabalho.',
  'Antes disso, quero agradecer a todos que acompanham o programa toda semana.',
  'A convidada vai explicar como comecou a trabalhar com inteligencia artificial.',
  'Depois vamos responder as perguntas enviadas pelos ouvintes durante a semana.',
];

const ENGLISH_LINES = [
  'Let us review the quarterly roadmap and confirm the delivery dates for each team.',
  'The migration finished early, so we have room for the analytics work this month.',
  'Please send your updates before Friday so the report can go out on time.',
];

const CHINESE_LINES = [
  '今天我们来谈谈人工智能技术的发展和未来的方向。',
  '首先请大家注意这个问题的重要性以及解决的方法。',
  '接下来我们会介绍几个具体的例子来说明这个观点。',
];

function turns(lines: string[], count: number): string {
  return Array.from(
    { length: count },
    (_, i) => `참가자${(i % 2) + 1}: ${lines[i % lines.length]}`,
  ).join('\n\n');
}

describe('scriptMix', () => {
  it('reports a pure Hangul block as entirely Hangul', () => {
    const mix = scriptMix(turns(KOREAN_LINES, 3));
    assert.equal(mix.hangul, 1);
    assert.equal(mix.latin, 0);
    assert.equal(mix.other, 0);
    assert.ok(mix.letters > 0);
  });

  it('reports a pure Latin block as entirely Latin', () => {
    const mix = scriptMix(turns(ENGLISH_LINES, 3));
    assert.equal(mix.latin, 1);
    assert.equal(mix.hangul, 0);
  });

  it('counts Han characters as other', () => {
    const mix = scriptMix(turns(CHINESE_LINES, 3));
    assert.equal(mix.other, 1);
    assert.equal(mix.hangul, 0);
    assert.equal(mix.latin, 0);
  });

  it('splits a mixed block across shares that sum to one', () => {
    const mix = scriptMix('참가자1: 이번 sprint 에서는 feature flag rollout 을 조정합니다.');
    assert.ok(mix.hangul > 0 && mix.latin > 0);
    assert.ok(Math.abs(mix.hangul + mix.latin + mix.other - 1) < 1e-9);
  });

  it('ignores digits, punctuation and whitespace', () => {
    assert.equal(scriptMix('1234 !@#$ ... 56').letters, 0);
  });

  it('returns zeroed shares for empty text', () => {
    assert.deepEqual(scriptMix(''), { hangul: 0, latin: 0, other: 0, letters: 0 });
  });

  it('strips the speaker label so it cannot bias a short block', () => {
    const mix = scriptMix('참가자1: hello world');
    assert.equal(mix.latin, 1);
    assert.equal(mix.hangul, 0);
  });
});

describe('findScriptMixOutliers', () => {
  it('flags a Portuguese block dropped into a Korean recording', () => {
    const blocks = [
      turns(KOREAN_LINES, 6),
      turns(KOREAN_LINES, 6),
      turns(PORTUGUESE_LINES, 4),
      turns(KOREAN_LINES, 6),
    ];
    const result = findScriptMixOutliers(blocks);
    assert.deepEqual(result.outliers, [2]);
    assert.ok(result.overall.hangul >= 0.6);
  });

  it('flags a Chinese block dropped into a Korean recording', () => {
    const blocks = [turns(KOREAN_LINES, 6), turns(CHINESE_LINES, 6), turns(KOREAN_LINES, 6)];
    assert.deepEqual(findScriptMixOutliers(blocks).outliers, [1]);
  });

  it('flags a Korean block dropped into an English recording (symmetric)', () => {
    const blocks = [turns(ENGLISH_LINES, 6), turns(KOREAN_LINES, 6), turns(ENGLISH_LINES, 6)];
    assert.deepEqual(findScriptMixOutliers(blocks).outliers, [1]);
  });

  it('does not flag a Korean block carrying heavy English jargon', () => {
    const jargon = Array.from(
      { length: 4 },
      () =>
        '참가자1: 이번 sprint 에서 feature flag rollout percentage 를 staging 환경에서 QA 하고 production 배포를 준비합니다.',
    ).join('\n\n');
    const mix = scriptMix(jargon);
    assert.ok(mix.latin > 0.3, 'fixture must actually be jargon-heavy');
    assert.ok(mix.letters >= 120, 'fixture must clear the length floor');
    const blocks = [turns(KOREAN_LINES, 6), jargon, turns(KOREAN_LINES, 6)];
    assert.deepEqual(findScriptMixOutliers(blocks).outliers, []);
  });

  it('does not flag anything when the recording has no dominant script', () => {
    // Korean turns carry ~22 letters each against ~64 for English, so a
    // genuinely balanced bilingual recording needs roughly 3x as many.
    const blocks = [turns(KOREAN_LINES, 9), turns(ENGLISH_LINES, 3)];
    const result = findScriptMixOutliers(blocks);
    assert.ok(result.overall.hangul < 0.6 && result.overall.latin < 0.6);
    assert.deepEqual(result.outliers, []);
  });

  it('does not flag a foreign block below the length floor', () => {
    const short = `참가자1: ${PORTUGUESE_LINES[0]}`;
    assert.ok(scriptMix(short).letters < 120, 'fixture must stay under the floor');
    const blocks = [turns(KOREAN_LINES, 6), short, turns(KOREAN_LINES, 6)];
    assert.deepEqual(findScriptMixOutliers(blocks).outliers, []);
  });

  it('returns no outliers for empty input', () => {
    assert.deepEqual(findScriptMixOutliers([]), {
      outliers: [],
      overall: { hangul: 0, latin: 0, other: 0, letters: 0 },
    });
  });
});

describe('splitIntoScriptWindows', () => {
  it('groups consecutive turns and never splits one', () => {
    const lines = Array.from({ length: 6 }, (_, i) => `참가자1: ${KOREAN_LINES[i]}`);
    const windows = splitIntoScriptWindows(lines.join('\n\n'), 50);
    assert.ok(windows.length > 1, 'a small budget must produce several windows');
    assert.deepEqual(
      windows.flatMap((window) => window.split('\n\n')),
      lines,
      'every turn survives whole and in order',
    );
  });

  it('keeps a turn larger than the budget whole in its own window', () => {
    const long = `참가자1: ${KOREAN_LINES.join(' ')}`;
    const windows = splitIntoScriptWindows(`${long}\n\n참가자2: ${KOREAN_LINES[0]}`, 20);
    assert.equal(windows[0], long);
  });

  it('returns no windows for empty text', () => {
    assert.deepEqual(splitIntoScriptWindows(''), []);
  });

  it('isolates a foreign run in the middle of a whole-file transcript', () => {
    const transcript = [
      turns(KOREAN_LINES, 30),
      turns(PORTUGUESE_LINES, 8),
      turns(KOREAN_LINES, 30),
    ].join('\n\n');
    const windows = splitIntoScriptWindows(transcript, 250);
    const { outliers } = findScriptMixOutliers(windows);
    assert.ok(outliers.length > 0, 'the Portuguese run must surface as its own window');
    for (const index of outliers) {
      assert.equal(scriptMix(windows[index]).latin, 1);
    }
  });
});

describe('normalizeTranscriptQualityNotes', () => {
  it('keeps trimmed string notes and drops empties', () => {
    assert.deepEqual(
      normalizeTranscriptQualityNotes(['  구간 A가 반복됩니다.  ', '', '   ', '구간 B 의심.']),
      ['구간 A가 반복됩니다.', '구간 B 의심.'],
    );
  });

  it('returns empty for non-array shapes', () => {
    assert.deepEqual(normalizeTranscriptQualityNotes(undefined), []);
    assert.deepEqual(normalizeTranscriptQualityNotes('문장 하나'), []);
    assert.deepEqual(normalizeTranscriptQualityNotes({ note: 'x' }), []);
  });

  it('stringifies object items instead of dropping them', () => {
    const [note] = normalizeTranscriptQualityNotes([{ section: '결말부', issue: '반복' }]);
    assert.ok(note.includes('결말부'));
    assert.ok(note.includes('반복'));
  });

  it('bounds count and per-note length so meta.json cannot bloat', () => {
    const notes = normalizeTranscriptQualityNotes(Array(50).fill('가'.repeat(1000)));
    assert.equal(notes.length, 10);
    for (const note of notes) {
      assert.ok(note.length <= 303);
    }
  });
});

// Overlap-backed boundary reconciliation: segments are cut with head
// overlap, so duplicated text at a boundary is evidence, not coincidence.
// Removal is anchored at the boundary and bounded to a small window; every
// ambiguous case must remove nothing.
describe('reconcileOverlappingSegments', () => {
  it('drops the duplicated boundary line despite spacing/punctuation variants', () => {
    const prev =
      '참가자1: 마지막 안건을 정리하겠습니다.\n\n참가자2: 다음 주 일정은 공유드린 대로 진행하겠습니다.';
    const next =
      '참가자2: 다음주 일정은 공유드린 대로 진행하겠습니다!\n\n참가자1: 좋습니다. 회의를 마치겠습니다.';
    const { bodies, removedPerBoundary } = reconcileOverlappingSegments([prev, next]);

    assert.equal(bodies[0], prev, 'earlier segment is never modified');
    assert.equal(bodies[1], '참가자1: 좋습니다. 회의를 마치겠습니다.');
    assert.ok(removedPerBoundary[0] > 0);
    const joined = bodies.join('\n\n');
    assert.equal(joined.match(/일정은 공유드린 대로/g)?.length, 1, 'phrase appears exactly once');
  });

  it('drops a multi-line overlap run', () => {
    const shared = '참가자1: 예산안은 다음 분기에 다시 검토하기로 했습니다.';
    const shared2 = '참가자2: 네, 그때까지 자료를 준비해 두겠습니다.';
    const prev = `참가자1: 이제 마무리하겠습니다.\n\n${shared}\n\n${shared2}`;
    const next = `${shared}\n\n${shared2}\n\n참가자1: 이상으로 회의를 마칩니다.`;
    const { bodies, removedPerBoundary } = reconcileOverlappingSegments([prev, next]);

    assert.equal(bodies[1], '참가자1: 이상으로 회의를 마칩니다.');
    assert.ok(removedPerBoundary[0] > 0);
  });

  it('keeps a duplicated boundary line that carries new continuation text', () => {
    const shared =
      '참가자2: 다음 주 일정은 공유드린 대로 진행하고 담당자별 준비 자료와 검토 결과도 회의 전날까지 모두 전달하겠습니다.';
    const continuation = ' 그리고 다음 안건은 예산 조정입니다';
    const prev = `참가자1: 마지막 안건을 정리하겠습니다.\n\n${shared}`;
    const next = `${shared}${continuation}\n\n참가자1: 자료를 확인하겠습니다.`;
    const { bodies, removedPerBoundary } = reconcileOverlappingSegments([prev, next]);

    assert.deepEqual(bodies, [prev, next]);
    assert.deepEqual(removedPerBoundary, [0]);
    assert.equal(bodies.join('\n\n').match(/다음 주 일정은 공유드린 대로 진행하고/g)?.length, 2);
  });

  it('keeps a later boundary line with post-overlap continuation', () => {
    const prev =
      '참가자1: 그래서 다음 주까지 초안을 공유드리고 피드백을 반영해서 최종본을 만들겠습니다';
    const next = `${prev} 다음 안건입니다`;
    const { bodies, removedPerBoundary } = reconcileOverlappingSegments([prev, next]);

    assert.equal(bodies[1].split(/\r?\n/)[0], next);
    assert.equal(removedPerBoundary[0], 0);
  });

  it('removes nothing between unrelated segments', () => {
    const prev = '참가자1: 첫 번째 안건은 여기까지입니다.';
    const next = '참가자2: 두 번째 안건을 시작하겠습니다.';
    const { bodies, removedPerBoundary } = reconcileOverlappingSegments([prev, next]);

    assert.deepEqual(bodies, [prev, next]);
    assert.deepEqual(removedPerBoundary, [0]);
  });

  it('never touches repeated content away from the boundary (anchored matching)', () => {
    // The same sentence appears deep inside both segments, but the lines
    // actually adjacent to the boundary differ -- anchored matching can
    // therefore never reach the repeated line, and it must survive twice.
    const repeated = '참가자2: 회의록은 노션에 정리해 두겠습니다.';
    const prev = [
      repeated,
      '참가자1: 이어서 예산 항목을 검토하겠습니다.',
      '참가자3: 자료는 미리 공유드린 문서를 참고해 주세요.',
    ].join('\n\n');
    const next = [
      '참가자1: 다음으로 채용 계획입니다.',
      '참가자3: 두 팀 모두 한 명씩 충원 예정입니다.',
      repeated,
    ].join('\n\n');
    const { bodies, removedPerBoundary } = reconcileOverlappingSegments([prev, next]);

    assert.deepEqual(bodies, [prev, next]);
    assert.deepEqual(removedPerBoundary, [0]);
    assert.equal(bodies.join('\n\n').match(/노션에 정리해/g)?.length, 2);
  });

  it('is a no-op around empty (silent) segment bodies', () => {
    const text = '참가자1: 안건을 공유드립니다.';
    const { bodies, removedPerBoundary } = reconcileOverlappingSegments(['', text, '']);

    assert.deepEqual(bodies, ['', text, '']);
    assert.deepEqual(removedPerBoundary, [0, 0]);
  });

  it('drops a half-line tail when the overlap cut a turn mid-sentence', () => {
    const prev = '참가자1: 오늘 논의된 내용은 다음 회의에서 다시 확인하고 공유하겠습니다.';
    const next = '다시 확인하고 공유하겠습니다.\n\n참가자2: 알겠습니다.';
    const { bodies } = reconcileOverlappingSegments([prev, next]);

    assert.equal(bodies[1], '참가자2: 알겠습니다.');
  });
});
