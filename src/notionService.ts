import { Client } from '@notionhq/client';
import { TranscriptionResult } from './geminiService';
import * as fs from 'fs';
import * as path from 'path';
import { BlockObjectRequest } from '@notionhq/client/build/src/api-endpoints';

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
    audioFilePath?: string
  ) {
    try {
      console.log('Creating Notion page for meeting:', title);

      // Prepare the properties for the new page
      const properties: any = {
        // Title property - using the database's title property (제목 or the default title)
        'title': {
          title: [
            {
              text: {
                content: title
              }
            }
          ]
        },
        // Date property
        'Date': {
          date: {
            start: date.toISOString().split('T')[0] // YYYY-MM-DD format
          }
        }
      };

      // Create rich text blocks for the page content
      const children: BlockObjectRequest[] = [];

      // Add Summary section
      if (transcriptionResult.summary) {
        children.push(
          {
            type: 'heading_2',
            heading_2: {
              rich_text: [{
                type: 'text',
                text: { content: '📝 Summary' }
              }]
            }
          } as BlockObjectRequest,
          {
            type: 'paragraph',
            paragraph: {
              rich_text: [{
                type: 'text',
                text: { content: transcriptionResult.summary }
              }]
            }
          } as BlockObjectRequest
        );
      }

      // Add Key Points section
      if (transcriptionResult.keyPoints && transcriptionResult.keyPoints.length > 0) {
        children.push(
          {
            type: 'heading_2',
            heading_2: {
              rich_text: [{
                type: 'text',
                text: { content: '🎯 Key Points' }
              }]
            }
          } as BlockObjectRequest
        );

        // Add each key point as a bulleted list item
        transcriptionResult.keyPoints.forEach(point => {
          children.push({
            type: 'bulleted_list_item',
            bulleted_list_item: {
              rich_text: [{
                type: 'text',
                text: { content: point }
              }]
            }
          } as BlockObjectRequest);
        });
      }

      // Add Action Items section
      if (transcriptionResult.actionItems && transcriptionResult.actionItems.length > 0) {
        children.push(
          {
            type: 'heading_2',
            heading_2: {
              rich_text: [{
                type: 'text',
                text: { content: '✅ Action Items' }
              }]
            }
          } as BlockObjectRequest
        );

        // Add each action item as a to-do
        transcriptionResult.actionItems.forEach(item => {
          children.push({
            type: 'to_do',
            to_do: {
              rich_text: [{
                type: 'text',
                text: { content: item }
              }],
              checked: false
            }
          } as BlockObjectRequest);
        });
      }

      // Add Transcript section
      if (transcriptionResult.transcript) {
        children.push(
          {
            type: 'heading_2',
            heading_2: {
              rich_text: [{
                type: 'text',
                text: { content: '📄 Full Transcript' }
              }]
            }
          } as BlockObjectRequest,
          {
            type: 'toggle',
            toggle: {
              rich_text: [{
                type: 'text',
                text: { content: 'Click to expand transcript' }
              }],
              children: this.splitTranscriptIntoBlocks(transcriptionResult.transcript)
            }
          } as BlockObjectRequest
        );
      }

      // Create the page with emoji
      const response = await this.notion.pages.create({
        parent: {
          database_id: this.databaseId
        },
        icon: {
          type: 'emoji',
          emoji: transcriptionResult.emoji as any
        },
        properties: properties,
        children: children
      });

      console.log('Notion page created successfully:', response.id);
      
      // Construct the URL manually since it's not in the response
      const pageUrl = `https://www.notion.so/${response.id.replace(/-/g, '')}`;
      
      return {
        success: true,
        pageId: response.id,
        url: pageUrl
      };

    } catch (error) {
      console.error('Error creating Notion page:', error);
      throw new Error(`Failed to create Notion page: ${error instanceof Error ? error.message : String(error)}`);
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
    return [{
      type: 'paragraph',
      paragraph: {
        rich_text: chunks.map(chunk => ({
          type: 'text',
          text: { content: chunk }
        }))
      }
    } as BlockObjectRequest];
  }

}