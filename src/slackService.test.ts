import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { TranscriptionResult } from './geminiService';
import {
  buildMeetingSummaryPayload,
  isLikelySlackWebhookUrl,
  SlackService,
} from './slackService';

const sampleResult: TranscriptionResult = {
  transcript: 'A long transcript that should not be sent to Slack.',
  summary:
    'Line one of the meeting summary in Korean.\nLine two with another point.\nLine three closing.',
  keyPoints: ['First decision', 'Second decision', 'Third decision', 'Fourth (should be dropped)'],
  actionItems: ['Action 1', 'Action 2'],
  emoji: '📝',
  suggestedTitle: 'Roadmap Review',
};

describe('isLikelySlackWebhookUrl', () => {
  it('accepts valid hooks.slack.com URLs', () => {
    assert.equal(
      isLikelySlackWebhookUrl('https://hooks.slack.com/services/T0/B0/abc'),
      true,
    );
  });

  it('rejects unrelated hosts and schemes', () => {
    assert.equal(isLikelySlackWebhookUrl('http://hooks.slack.com/services/abc'), false);
    assert.equal(isLikelySlackWebhookUrl('https://example.com/hook'), false);
    assert.equal(isLikelySlackWebhookUrl(''), false);
  });
});

describe('buildMeetingSummaryPayload', () => {
  it('includes header with emoji and date context', () => {
    const date = new Date('2026-04-30T09:30:00Z');
    const payload = buildMeetingSummaryPayload({
      title: 'Roadmap Review',
      date,
      result: sampleResult,
    });

    const blocks = payload.blocks as Array<{ type: string; text?: { text?: string } }>;
    assert.equal(blocks[0]?.type, 'header');
    assert.match(String(blocks[0]?.text?.text ?? ''), /Roadmap Review/);
    assert.equal(blocks[1]?.type, 'context');
    assert.match(payload.text, /Roadmap Review/);
  });

  it('clamps the summary preview to three lines', () => {
    const payload = buildMeetingSummaryPayload({
      title: 'Roadmap Review',
      date: new Date(),
      result: sampleResult,
    });
    const sectionBlock = (payload.blocks as Array<{ type: string; text?: { text?: string } }>)
      .find((b) => b.type === 'section');
    const text = sectionBlock?.text?.text ?? '';
    assert.equal(text.split('\n').length, 3);
  });

  it('truncates key points to the first three entries', () => {
    const payload = buildMeetingSummaryPayload({
      title: 'Roadmap Review',
      date: new Date(),
      result: sampleResult,
    });
    const keyPointsBlock = (payload.blocks as Array<{ type: string; text?: { text?: string } }>)
      .find((b) => String(b.text?.text ?? '').startsWith('*Key points*'));
    assert.ok(keyPointsBlock, 'key points block should exist');
    const lines = String(keyPointsBlock?.text?.text ?? '').split('\n');
    // Expect: header line + 3 bullets
    assert.equal(lines.length, 4);
    assert.ok(!lines.join('\n').includes('Fourth'));
  });

  it('emits a Notion button when notionUrl is provided', () => {
    const payload = buildMeetingSummaryPayload({
      title: 'Roadmap Review',
      date: new Date(),
      result: sampleResult,
      notionUrl: 'https://www.notion.so/page-id',
    });
    const blocks = payload.blocks as Array<{
      type: string;
      elements?: Array<{ type: string; url?: string }>;
    }>;
    const actions = blocks.find((b) => b.type === 'actions');
    assert.ok(actions, 'actions block should be present');
    assert.equal(actions?.elements?.[0]?.url, 'https://www.notion.so/page-id');
  });

  it('emits a Notion-failure context block when notionError is provided without URL', () => {
    const payload = buildMeetingSummaryPayload({
      title: 'Roadmap Review',
      date: new Date(),
      result: sampleResult,
      notionError: 'invalid_grant',
    });
    const blocks = payload.blocks as Array<{
      type: string;
      elements?: Array<{ text?: string }>;
    }>;
    const contextBlocks = blocks.filter((b) => b.type === 'context');
    const failureContext = contextBlocks.find((b) =>
      String(b.elements?.[0]?.text ?? '').includes('Notion sync failed'),
    );
    assert.ok(failureContext, 'failure context block should be present');
  });
});

describe('SlackService', () => {
  const originalFetch = globalThis.fetch;
  let lastRequest: { url: string; init?: RequestInit } | null = null;

  beforeEach(() => {
    lastRequest = null;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('rejects construction with a non-Slack URL', () => {
    assert.throws(
      () => new SlackService({ webhookUrl: 'https://example.com/hook' }),
      /must start with/,
    );
  });

  it('returns sentAt on a 200 response', async () => {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      lastRequest = { url, init };
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const service = new SlackService({
      webhookUrl: 'https://hooks.slack.com/services/T0/B0/abc',
    });
    const result = await service.sendMeetingSummary({
      title: 'Roadmap',
      date: new Date(),
      result: sampleResult,
      notionUrl: 'https://www.notion.so/x',
    });

    assert.equal(result.success, true);
    assert.ok(result.sentAt, 'sentAt should be set on success');
    assert.equal(lastRequest?.url, 'https://hooks.slack.com/services/T0/B0/abc');
    assert.equal(lastRequest?.init?.method, 'POST');
  });

  it('returns success: false with status code on a non-OK response', async () => {
    globalThis.fetch = (async () =>
      new Response('invalid_payload', { status: 400 })) as typeof fetch;

    const service = new SlackService({
      webhookUrl: 'https://hooks.slack.com/services/T0/B0/abc',
    });
    const result = await service.sendMeetingSummary({
      title: 'Roadmap',
      date: new Date(),
      result: sampleResult,
    });

    assert.equal(result.success, false);
    assert.match(String(result.error ?? ''), /400/);
    assert.match(String(result.error ?? ''), /invalid_payload/);
  });

  it('captures fetch errors', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;

    const service = new SlackService({
      webhookUrl: 'https://hooks.slack.com/services/T0/B0/abc',
    });
    const result = await service.sendTestMessage();

    assert.equal(result.success, false);
    assert.equal(result.error, 'network down');
  });
});
