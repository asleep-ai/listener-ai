import { Client } from '@notionhq/client';
import type { BlockObjectRequest } from '@notionhq/client/build/src/api-endpoints';
import type { TranscriptionResult } from './geminiService';
import { camelToLabel, formatOffsetTimestamp } from './outputService';

export interface NotionConfig {
  apiKey: string;
  databaseId: string;
}

export class NotionService {
  private notion: Client;
  private databaseId: string;

  constructor(config: NotionConfig) {
    this.notion = new Client({
      auth: config.apiKey,
    });
    this.databaseId = config.databaseId;
  }

  async createMeetingNote(
    title: string,
    date: Date,
    transcriptionResult: TranscriptionResult,
    _audioFilePath?: string,
  ) {
    try {
      console.log('Creating Notion page for meeting:', title);

      // Prepare the properties for the new page
      const properties: any = {
        // Title property - using the database's title property (제목 or the default title)
        title: {
          title: [
            {
              text: {
                content: title,
              },
            },
          ],
        },
        // Date property
        Date: {
          date: {
            start: date.toISOString().split('T')[0], // YYYY-MM-DD format
          },
        },
      };

      // Create rich text blocks for the page content
      const children: BlockObjectRequest[] = [];

      // Add Summary section
      if (transcriptionResult.summary) {
        children.push(
          {
            type: 'heading_2',
            heading_2: {
              rich_text: [
                {
                  type: 'text',
                  text: { content: '📝 Summary' },
                },
              ],
            },
          } as BlockObjectRequest,
          {
            type: 'paragraph',
            paragraph: {
              rich_text: [
                {
                  type: 'text',
                  text: { content: transcriptionResult.summary },
                },
              ],
            },
          } as BlockObjectRequest,
        );
      }

      // Add Key Points section
      if (transcriptionResult.keyPoints && transcriptionResult.keyPoints.length > 0) {
        children.push({
          type: 'heading_2',
          heading_2: {
            rich_text: [
              {
                type: 'text',
                text: { content: '🎯 Key Points' },
              },
            ],
          },
        } as BlockObjectRequest);

        // Add each key point as a bulleted list item
        transcriptionResult.keyPoints.forEach((point) => {
          children.push({
            type: 'bulleted_list_item',
            bulleted_list_item: {
              rich_text: [
                {
                  type: 'text',
                  text: { content: point },
                },
              ],
            },
          } as BlockObjectRequest);
        });
      }

      // Add Action Items section
      if (transcriptionResult.actionItems && transcriptionResult.actionItems.length > 0) {
        children.push({
          type: 'heading_2',
          heading_2: {
            rich_text: [
              {
                type: 'text',
                text: { content: '✅ Action Items' },
              },
            ],
          },
        } as BlockObjectRequest);

        // Add each action item as a to-do
        transcriptionResult.actionItems.forEach((item) => {
          children.push({
            type: 'to_do',
            to_do: {
              rich_text: [
                {
                  type: 'text',
                  text: { content: item },
                },
              ],
              checked: false,
            },
          } as BlockObjectRequest);
        });
      }

      // Highlights section -- prefer the AI-enriched view (per-moment title +
      // subtitle + categorized bullets, Plaud-style) when Gemini populated it,
      // and fall back to the bare bullet list when only the raw liveNotes are
      // available (e.g. pure flags with no typed text).
      const enrichedHighlights = transcriptionResult.highlights?.length
        ? transcriptionResult.highlights
        : null;
      const fallbackNotes = transcriptionResult.liveNotes?.length
        ? transcriptionResult.liveNotes
        : null;
      if (enrichedHighlights || fallbackNotes) {
        children.push({
          type: 'heading_2',
          heading_2: {
            rich_text: [{ type: 'text', text: { content: '🗒️ Highlights' } }],
          },
        } as BlockObjectRequest);
        if (enrichedHighlights) {
          for (const h of enrichedHighlights) {
            const ts = formatOffsetTimestamp(h.offsetMs);
            const title = (h.userText ?? '').trim();
            const headingContent = (title ? `[${ts}] ${title}` : `[${ts}] 🏴`).slice(0, 1900);
            children.push({
              type: 'heading_3',
              heading_3: {
                rich_text: [{ type: 'text', text: { content: headingContent } }],
              },
            } as BlockObjectRequest);
            if (h.subtitle?.trim()) {
              children.push({
                type: 'paragraph',
                paragraph: {
                  rich_text: [
                    {
                      type: 'text',
                      text: { content: h.subtitle.trim().slice(0, 1900) },
                      annotations: { italic: true },
                    },
                  ],
                },
              } as BlockObjectRequest);
            }
            if (h.bullets?.length) {
              for (const bullet of h.bullets) {
                children.push({
                  type: 'bulleted_list_item',
                  bulleted_list_item: {
                    rich_text: [{ type: 'text', text: { content: bullet.slice(0, 1900) } }],
                  },
                } as BlockObjectRequest);
              }
            }
          }
        } else if (fallbackNotes) {
          for (const note of fallbackNotes) {
            const ts = formatOffsetTimestamp(note.offsetMs);
            const text = (note.text ?? '').trim();
            const content = text ? `[${ts}] ${text}`.slice(0, 1900) : `[${ts}] 🏴`;
            children.push({
              type: 'bulleted_list_item',
              bulleted_list_item: {
                rich_text: [{ type: 'text', text: { content } }],
              },
            } as BlockObjectRequest);
          }
        }
      }

      // Add custom fields
      if (transcriptionResult.customFields) {
        for (const [key, value] of Object.entries(transcriptionResult.customFields)) {
          const label = camelToLabel(key);

          if (Array.isArray(value)) {
            children.push({
              type: 'heading_2',
              heading_2: {
                rich_text: [{ type: 'text', text: { content: label } }],
              },
            } as BlockObjectRequest);
            for (const item of value) {
              const text = String(item).slice(0, 1900);
              children.push({
                type: 'bulleted_list_item',
                bulleted_list_item: {
                  rich_text: [{ type: 'text', text: { content: text } }],
                },
              } as BlockObjectRequest);
            }
          } else {
            const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
            if (!text || !text.trim()) continue;

            children.push({
              type: 'heading_2',
              heading_2: {
                rich_text: [{ type: 'text', text: { content: label } }],
              },
            } as BlockObjectRequest);

            // Split long values into chunks for Notion's 2000-char rich_text limit
            const maxLen = 1900;
            const chunks: { type: 'text'; text: { content: string } }[] = [];
            for (let i = 0; i < text.length; i += maxLen) {
              chunks.push({ type: 'text', text: { content: text.slice(i, i + maxLen) } });
            }
            children.push({
              type: 'paragraph',
              paragraph: { rich_text: chunks },
            } as BlockObjectRequest);
          }
        }
      }

      // Add Transcript section
      if (transcriptionResult.transcript) {
        children.push(
          {
            type: 'heading_2',
            heading_2: {
              rich_text: [
                {
                  type: 'text',
                  text: { content: '📄 Full Transcript' },
                },
              ],
            },
          } as BlockObjectRequest,
          {
            type: 'toggle',
            toggle: {
              rich_text: [
                {
                  type: 'text',
                  text: { content: 'Click to expand transcript' },
                },
              ],
              children: this.splitTranscriptIntoBlocks(transcriptionResult.transcript),
            },
          } as BlockObjectRequest,
        );
      }

      // Create the page with emoji
      const response = await this.notion.pages.create({
        parent: {
          database_id: this.databaseId,
        },
        icon: {
          type: 'emoji',
          emoji: (transcriptionResult.emoji || '📝') as any,
        },
        properties: properties,
        children: children,
      });

      console.log('Notion page created successfully:', response.id);

      // Construct the URL manually since it's not in the response
      const pageUrl = `https://www.notion.so/${response.id.replace(/-/g, '')}`;

      return {
        success: true,
        pageId: response.id,
        url: pageUrl,
      };
    } catch (error) {
      console.error('Error creating Notion page:', error);
      throw new Error(
        `Failed to create Notion page: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Split long transcript into multiple blocks (Notion has a 2000 character limit per block)
  private splitTranscriptIntoBlocks(transcript: string): BlockObjectRequest[] {
    const maxLength = 1900; // Leave some buffer for safety

    // Split transcript into chunks of maxLength
    const chunks: string[] = [];
    for (let i = 0; i < transcript.length; i += maxLength) {
      chunks.push(transcript.slice(i, i + maxLength));
    }

    // Create a single paragraph block with multiple rich_text objects
    // This allows selecting all text at once
    return [
      {
        type: 'paragraph',
        paragraph: {
          rich_text: chunks.map((chunk) => ({
            type: 'text',
            text: { content: chunk },
          })),
        },
      } as BlockObjectRequest,
    ];
  }
}
