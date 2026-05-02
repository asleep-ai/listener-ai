import type { TranscriptionResult } from './geminiService';

export interface SlackConfig {
  webhookUrl: string;
}

export interface SlackSendOptions {
  title: string;
  date: Date;
  result: TranscriptionResult;
  notionUrl?: string;
  notionError?: string;
}

export type SlackSendResult =
  | { success: true; sentAt: string }
  | { success: false; error: string };

export const SLACK_WEBHOOK_PREFIX = 'https://hooks.slack.com/services/';

const SLACK_HOST_PATTERN = new RegExp(
  `^${SLACK_WEBHOOK_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
);
const HEADER_MAX_CHARS = 150;
const SUMMARY_PREVIEW_MAX_CHARS = 600;
const SUMMARY_PREVIEW_MAX_LINES = 3;
const KEY_POINTS_PREVIEW = 3;
const NOTION_ERROR_PREVIEW_MAX_CHARS = 200;
const FALLBACK_TEXT_MAX_CHARS = 1000;
const ERROR_BODY_PREVIEW_MAX_CHARS = 200;
const REQUEST_TIMEOUT_MS = 15_000;

export function isLikelySlackWebhookUrl(url: string): boolean {
  return SLACK_HOST_PATTERN.test(url.trim());
}

export class SlackService {
  private webhookUrl: string;

  constructor(config: SlackConfig) {
    if (!isLikelySlackWebhookUrl(config.webhookUrl)) {
      throw new Error(`Slack webhook URL must start with ${SLACK_WEBHOOK_PREFIX}`);
    }
    this.webhookUrl = config.webhookUrl.trim();
  }

  async sendMeetingSummary(options: SlackSendOptions): Promise<SlackSendResult> {
    const payload = buildMeetingSummaryPayload(options);
    return this.post(payload);
  }

  async sendTestMessage(): Promise<SlackSendResult> {
    const payload = {
      text: 'Listener.AI connection test',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: ':white_check_mark: *Listener.AI* connection test successful.',
          },
        },
      ],
    };
    return this.post(payload);
  }

  private async post(payload: unknown): Promise<SlackSendResult> {
    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const trimmed = body.slice(0, ERROR_BODY_PREVIEW_MAX_CHARS);
        return {
          success: false,
          error: `Slack responded ${response.status}${trimmed ? `: ${trimmed}` : ''}`,
        };
      }

      return { success: true, sentAt: new Date().toISOString() };
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        return { success: false, error: `Slack request timed out after ${REQUEST_TIMEOUT_MS}ms` };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }
}

export function buildMeetingSummaryPayload(options: SlackSendOptions): {
  text: string;
  blocks: unknown[];
} {
  const { title, date, result, notionUrl, notionError } = options;
  const emoji = (result.emoji || '📝').trim();
  const headerText = truncate(`${emoji} ${title}`, HEADER_MAX_CHARS);
  const dateLabel = formatDate(date);
  const summaryPreview = clampLines(
    result.summary || '',
    SUMMARY_PREVIEW_MAX_LINES,
    SUMMARY_PREVIEW_MAX_CHARS,
  );

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: headerText, emoji: true },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: dateLabel }],
    },
  ];

  if (summaryPreview) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: summaryPreview },
    });
  }

  const keyPoints = (result.keyPoints || [])
    .slice(0, KEY_POINTS_PREVIEW)
    .map((p) => `• ${escapeSlackText(p)}`)
    .join('\n');
  if (keyPoints) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Key points*\n${keyPoints}` },
    });
  }

  if (notionUrl) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View in Notion', emoji: true },
          url: notionUrl,
        },
      ],
    });
  } else if (notionError) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `:warning: Notion sync failed: ${escapeSlackText(truncate(notionError, NOTION_ERROR_PREVIEW_MAX_CHARS))}`,
        },
      ],
    });
  }

  const fallbackParts = [`${emoji} ${title}`, dateLabel];
  if (summaryPreview) fallbackParts.push(summaryPreview);
  if (notionUrl) fallbackParts.push(notionUrl);
  const text = truncate(fallbackParts.join(' — '), FALLBACK_TEXT_MAX_CHARS);

  return { text, blocks };
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function clampLines(value: string, maxLines: number, maxChars: number): string {
  const lines = value.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const slice = lines.slice(0, maxLines).join('\n');
  return truncate(slice, maxChars);
}

function formatDate(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

// Slack mrkdwn requires HTML-style entity escaping for `<`, `>`, `&` to prevent
// it from interpreting them as link syntax (`<url|label>`) or entity refs.
function escapeSlackText(value: string): string {
  return value.replace(/[<>&]/g, (ch) => {
    if (ch === '<') return '&lt;';
    if (ch === '>') return '&gt;';
    return '&amp;';
  });
}
