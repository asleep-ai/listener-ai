import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TranscriptionResult } from './geminiService';
import { NotionService } from './notionService';

describe('NotionService', () => {
  it('keeps the full transcript but excludes internal transcript quality metadata', async () => {
    const service = new NotionService({
      apiKey: 'test-api-key',
      databaseId: 'test-database-id',
    });
    let createInput: unknown;

    (
      service as unknown as {
        notion: {
          pages: {
            create: (input: unknown) => Promise<{ id: string }>;
          };
        };
      }
    ).notion = {
      pages: {
        create: async (input) => {
          createInput = input;
          return { id: '12345678-1234-1234-1234-123456789abc' };
        },
      },
    };

    const result: TranscriptionResult = {
      transcript: 'TRANSCRIPT_SENTINEL',
      summary: 'SUMMARY_SENTINEL',
      keyPoints: ['KEY_POINT_SENTINEL'],
      actionItems: ['ACTION_ITEM_SENTINEL'],
      emoji: '📝',
      customFields: {
        decisions: ['DECISION_SENTINEL'],
        transcriptQuality: {
          cleaned: true,
          uncertainSegments: [2],
          modelNotes: ['QUALITY_SENTINEL'],
        },
      },
    };

    await service.createMeetingNote('Test meeting', new Date('2026-08-10T00:00:00Z'), result);

    const serializedInput = JSON.stringify(createInput);
    assert.match(serializedInput, /SUMMARY_SENTINEL/);
    assert.match(serializedInput, /DECISION_SENTINEL/);
    assert.match(serializedInput, /Full Transcript/);
    assert.match(serializedInput, /TRANSCRIPT_SENTINEL/);
    assert.doesNotMatch(serializedInput, /Transcript Quality/);
    assert.doesNotMatch(serializedInput, /QUALITY_SENTINEL/);
  });
});
