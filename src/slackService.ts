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

export interface SlackSendResult {
  success: boolean;
  error?: string;
  sentAt?: string;
}

const SLACK_HOST_PATTERN = /^https:\/\/hooks\.slack\.com\/services\//;
const SUMMARY_PREVIEW_MAX_CHARS = 600;
const SUMMARY_PREVIEW_MAX_LINES = 3;
const KEY_POINTS_PREVIEW = 3;

export function isLikelySlackWebhookUrl(url: string): boolean {
  return SLACK_HOST_PATTERN.test(url.trim());
}

export class SlackService {
  private webhookUrl: string;

  constructor(config: SlackConfig) {
    if (!isLikelySlackWebhookUrl(config.webhookUrl)) {
      throw new Error(
        'Slack webhook URL must start with https://hooks.slack.com/services/',
      );
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
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const trimmed = body.slice(0, 200);
        return {
          success: false,
          error: `Slack responded ${response.status}${trimmed ? `: ${trimmed}` : ''}`,
        };
      }

      return { success: true, sentAt: new Date().toISOString() };
    } catch (error) {
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
  const headerText = truncate(`${emoji} ${title}`, 150);
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
    .map((p) => `• ${escapeMrkdwn(p)}`)
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
          text: `:warning: Notion sync failed: ${escapeMrkdwn(truncate(notionError, 200))}`,
        },
      ],
    });
  }

  const fallbackParts = [`${emoji} ${title}`, dateLabel];
  if (summaryPreview) fallbackParts.push(summaryPreview);
  if (notionUrl) fallbackParts.push(notionUrl);
  const text = truncate(fallbackParts.join(' — '), 1000);

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

function escapeMrkdwn(value: string): string {
  return value.replace(/[<>&]/g, (ch) => {
    if (ch === '<') return '&lt;';
    if (ch === '>') return '&gt;';
    return '&amp;';
  });
}
