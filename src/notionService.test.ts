import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TranscriptionResult } from './geminiService';
import { NotionService } from './notionService';

describe('NotionService', () => {
  it('renders structured summary sections and action item groups instead of legacy fields', async () => {
    const service = new NotionService({
      apiKey: 'test-api-key',
      databaseId: 'test-database-id',
    });
    let createInput: unknown;

    (
      service as unknown as {
        notion: { pages: { create: (input: unknown) => Promise<{ id: string }> } };
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
      transcript: '',
      summary: 'LEGACY_SUMMARY',
      summarySections: [
        { heading: 'Agenda A', bullets: ['SUMMARY_BULLET_A'] },
        { heading: 'Agenda B', bullets: ['SUMMARY_BULLET_B'] },
      ],
      keyPoints: [],
      actionItems: ['LEGACY_ACTION'],
      actionItemGroups: [
        { owner: 'Company A', items: ['GROUPED_ACTION_A'] },
        { owner: 'Owner B', items: ['GROUPED_ACTION_B'] },
      ],
      emoji: '',
    };

    await service.createMeetingNote('Test meeting', new Date('2026-08-10T00:00:00Z'), result);

    const serializedInput = JSON.stringify(createInput);
    assert.match(serializedInput, /Agenda A/);
    assert.match(serializedInput, /SUMMARY_BULLET_A/);
    assert.match(serializedInput, /Company A/);
    assert.match(serializedInput, /GROUPED_ACTION_A/);
    assert.doesNotMatch(serializedInput, /LEGACY_SUMMARY/);
    assert.doesNotMatch(serializedInput, /LEGACY_ACTION/);
  });

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

  it('appends structured content in bounded batches after creating the page', async () => {
    const service = new NotionService({
      apiKey: 'test-api-key',
      databaseId: 'test-database-id',
    });
    let initialChildren: unknown[] = [];
    const appendedBatches: unknown[][] = [];

    (
      service as unknown as {
        notion: {
          pages: { create: (input: { children: unknown[] }) => Promise<{ id: string }> };
          blocks: {
            children: {
              append: (input: { children: unknown[] }) => Promise<void>;
            };
          };
        };
      }
    ).notion = {
      pages: {
        create: async (input) => {
          initialChildren = input.children;
          return { id: '12345678-1234-1234-1234-123456789abc' };
        },
      },
      blocks: {
        children: {
          append: async (input) => {
            appendedBatches.push(input.children);
          },
        },
      },
    };

    const result: TranscriptionResult = {
      transcript: '',
      summary: '',
      summarySections: Array.from({ length: 20 }, (_, index) => ({
        heading: `Agenda ${index + 1}`,
        bullets: Array.from({ length: 5 }, (_, bullet) => `Detail ${index + 1}.${bullet + 1}`),
      })),
      keyPoints: [],
      actionItems: [],
      emoji: '📝',
    };

    await service.createMeetingNote('Large meeting', new Date('2026-08-10T00:00:00Z'), result);

    assert.equal(initialChildren.length, 100);
    assert.equal(appendedBatches.length, 1);
    assert.equal(appendedBatches[0].length, 21);
  });
});
