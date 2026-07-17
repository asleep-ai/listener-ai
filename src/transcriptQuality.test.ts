// Seeded corpus for the repetition/hallucination analyzer (issue #182).
// Two behaviors are locked in:
//   - Loop shapes providers actually emit on silence/noise/music are flagged:
//     exact repeated lines, near-duplicate lines (spacing/punctuation
//     variants), word-block loops, space-less character loops, and long
//     high-compression repetition.
//   - Legitimate speech repetition is NOT flagged: confirmations (네, 네),
//     stutters, emphasis, short chants, code-switching, and clean prose.
// The gate on top never deletes silently: one bounded context-cleared retry,
// and a still-flagged retry keeps the FIRST result marked uncertain.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  analyzeTranscriptQuality,
  applyTranscriptQualityGate,
  normalizeForComparison,
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

  it('flags space-less Korean character loops behind a speaker label', () => {
    const report = analyzeTranscriptQuality('참가자1: 감사합니다감사합니다감사합니다감사합니다');
    assert.equal(report.flagged, true);
    assert.ok(report.reasons.includes('repeated-ngram-loop'));
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
      retry: async () => {
        retries++;
        return cleanText;
      },
      log: () => {},
    });
    assert.equal(result.text, cleanText);
    assert.equal(result.flagged, false);
    assert.equal(result.retried, false);
    assert.equal(retries, 0);
  });

  it('replaces a flagged first result with a clean retry', async () => {
    const result = await applyTranscriptQualityGate({
      text: loopText,
      label: 'test',
      retry: async () => cleanText,
      log: () => {},
    });
    assert.equal(result.text, cleanText);
    assert.equal(result.flagged, false);
    assert.equal(result.retried, true);
  });

  it('accepts an empty retry as evidence of silence', async () => {
    const result = await applyTranscriptQualityGate({
      text: loopText,
      label: 'test',
      retry: async () => '',
      log: () => {},
    });
    assert.equal(result.text, '');
    assert.equal(result.flagged, false);
  });

  it('keeps the FIRST result marked uncertain when the retry is still flagged', async () => {
    const otherLoop = `참가자1: ${Array(12).fill('자막').join(' ')}`;
    const result = await applyTranscriptQualityGate({
      text: loopText,
      label: 'test',
      retry: async () => otherLoop,
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
      retry: async () => {
        throw new Error('rate limited');
      },
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
      retry: async () => {
        retries++;
        return loopText;
      },
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
      retry: async () => loopText,
      log: (message) => logs.push(message),
    });
    assert.ok(logs.length > 0);
    for (const line of logs) {
      assert.ok(!line.includes('감사합니다'), `log leaked transcript text: ${line}`);
    }
  });
});
