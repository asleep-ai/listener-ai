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
  analyzeAssembledTranscript,
  analyzeTranscriptQuality,
  applyTranscriptQualityGate,
  normalizeForComparison,
  normalizeTranscriptQualityNotes,
  reconcileOverlappingSegments,
  stripNoSpeechSentinel,
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

  it('does not accumulate short acknowledgement lines into a duplicate run', () => {
    const report = analyzeTranscriptQuality('참가자1: 네\n\n참가자2: 네\n\n참가자1: 네');
    assert.equal(report.flagged, false);
  });

  it('accepts empty and trivial input', () => {
    assert.equal(analyzeTranscriptQuality('').flagged, false);
    assert.equal(analyzeTranscriptQuality('네.').flagged, false);
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

  it('flags space-less Korean character loops behind a speaker label', () => {
    const report = analyzeTranscriptQuality('참가자1: 감사합니다감사합니다감사합니다감사합니다');
    assert.equal(report.flagged, true);
    assert.ok(report.reasons.includes('repeated-ngram-loop'));
  });

  it('accepts a genuine triple emphasis behind a speaker label', () => {
    const report = analyzeTranscriptQuality('참가자1: 감사합니다감사합니다감사합니다');
    assert.equal(report.flagged, false);
  });

  it('flags long repetitive text via the local compression metric', () => {
    const report = analyzeTranscriptQuality(Array(40).fill('구독과 좋아요 부탁드립니다').join(' '));
    assert.equal(report.flagged, true);
    assert.ok(report.reasons.includes('high-text-compression'));
    assert.ok(report.metrics.textCompressionRatio > 4);
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
    const result = await applyTranscriptQualityGate({
      text: loopText,
      label: 'test',
      retries: [
        async () => {
          throw new Error('rate limited');
        },
      ],
      log: () => {},
    });
    assert.equal(result.text, loopText);
    assert.equal(result.flagged, true);
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

  it('uses a clean first rung without invoking the second rung', async () => {
    const calls = [0, 0];
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
      log: () => {},
    });

    assert.equal(result.text, cleanText);
    assert.deepEqual(calls, [1, 0]);
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

  it('treats an empty retries array like no retries', async () => {
    const result = await applyTranscriptQualityGate({
      text: loopText,
      label: 'test',
      retries: [],
      log: () => {},
    });

    assert.equal(result.text, loopText);
    assert.equal(result.flagged, true);
    assert.equal(result.retried, false);
    assert.equal(result.retriesAttempted, 0);
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
