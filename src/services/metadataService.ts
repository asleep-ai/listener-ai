import { promises as fs } from 'fs';
import * as path from 'path';
import { app } from 'electron';

interface RecordingMetadata {
  filePath: string;
  title: string;
  timestamp: string;
  transcript?: string;
  summary?: string;
  keyPoints?: string[];
  actionItems?: string[];
  suggestedTitle?: string;
  transcribedAt?: string;
}

export class MetadataService {
  private metadataDir: string;

  constructor() {
    this.metadataDir = path.join(app.getPath('userData'), 'metadata');
    console.log('Metadata directory:', this.metadataDir);
    // Create directory synchronously in constructor
    try {
      require('fs').mkdirSync(this.metadataDir, { recursive: true });
      console.log('Metadata directory created/verified:', this.metadataDir);
    } catch (error) {
      console.error('Failed to create metadata directory:', error);
    }
  }

  private getMetadataPath(audioFilePath: string): string {
    const baseName = path.basename(audioFilePath, path.extname(audioFilePath));
    return path.join(this.metadataDir, `${baseName}.json`);
  }

  async saveMetadata(audioFilePath: string, metadata: Partial<RecordingMetadata>): Promise<void> {
    try {
      const metadataPath = this.getMetadataPath(audioFilePath);
      console.log('Saving metadata to:', metadataPath);
      
      const existingMetadata = await this.getMetadata(audioFilePath);
      
      const updatedMetadata: RecordingMetadata = {
        ...existingMetadata,
        ...metadata,
        filePath: audioFilePath,
        title: metadata.title || existingMetadata?.title || path.basename(audioFilePath, path.extname(audioFilePath)),
        timestamp: existingMetadata?.timestamp || new Date().toISOString()
      };

      await fs.writeFile(metadataPath, JSON.stringify(updatedMetadata, null, 2), 'utf8');
      console.log('Metadata written successfully to:', metadataPath);
    } catch (error) {
      console.error('Failed to save metadata:', error);
      throw error;
    }
  }

  async getMetadata(audioFilePath: string): Promise<RecordingMetadata | null> {
    try {
      const metadataPath = this.getMetadataPath(audioFilePath);
      const content = await fs.readFile(metadataPath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      // File doesn't exist or is invalid
      return null;
    }
  }

  async deleteMetadata(audioFilePath: string): Promise<void> {
    try {
      const metadataPath = this.getMetadataPath(audioFilePath);
      await fs.unlink(metadataPath);
    } catch (error) {
      // Ignore if file doesn't exist
      console.log('Metadata file not found:', audioFilePath);
    }
  }

  async getAllMetadata(): Promise<RecordingMetadata[]> {
    try {
      const files = await fs.readdir(this.metadataDir);
      const metadataFiles = files.filter(f => f.endsWith('.json'));
      
      const metadata: RecordingMetadata[] = [];
      for (const file of metadataFiles) {
        try {
          const content = await fs.readFile(path.join(this.metadataDir, file), 'utf8');
          metadata.push(JSON.parse(content));
        } catch (error) {
          console.error(`Failed to read metadata file ${file}:`, error);
        }
      }
      
      return metadata;
    } catch (error) {
      console.error('Failed to get all metadata:', error);
      return [];
    }
  }
}

export const metadataService = new MetadataService();