import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

// Import ffprobe path
let ffprobePath: string | null = null;

// Helper function to find ffprobe binary
function findFFprobeBinary(): string | null {
  const platform = process.platform;
  const arch = process.arch;
  const ffprobeBinary = platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  
  // First, try ffprobe-static in development
  if (!app.isPackaged) {
    try {
      const staticPath = require('ffprobe-static').path;
      if (staticPath && fs.existsSync(staticPath)) {
        console.log('Using ffprobe-static in development:', staticPath);
        return staticPath;
      }
    } catch (e) {
      console.log('ffprobe-static not available in development');
    }
  }
  
  // In production, check various locations
  const possiblePaths = [
    // Check in extraResources (most likely location)
    path.join(process.resourcesPath, ffprobeBinary),
    path.join(process.resourcesPath, 'ffprobe-static', ffprobeBinary),
    // Check in app.asar.unpacked
    path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffprobe-static', ffprobeBinary),
    path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffprobe-static', 'bin', platform, arch, ffprobeBinary),
  ];
  
  // Platform specific paths
  if (platform === 'darwin') {
    possiblePaths.push(
      path.join(app.getAppPath(), '..', '..', 'Resources', ffprobeBinary)
    );
  } else if (platform === 'win32') {
    possiblePaths.push(
      path.join(path.dirname(app.getPath('exe')), ffprobeBinary),
      path.join(path.dirname(app.getPath('exe')), 'resources', ffprobeBinary)
    );
  }
  
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      console.log('Found ffprobe at:', p);
      // Make executable on Unix
      if (platform !== 'win32') {
        try {
          fs.chmodSync(p, 0o755);
        } catch (e) {
          console.error('Failed to chmod ffprobe:', e);
        }
      }
      return p;
    }
  }
  
  // Try system ffprobe as fallback
  return 'ffprobe';
}

// Initialize ffprobe path
ffprobePath = findFFprobeBinary();

export interface TranscriptionResult {
  transcript: string;
  summary: string;
  keyPoints: string[];
  actionItems: string[];
  emoji: string;
  suggestedTitle?: string;
}

export class GeminiService {
  private genAI: GoogleGenerativeAI;
  private model: GenerativeModel;
  private segmentModel: GenerativeModel;
  private fileManager: GoogleAIFileManager;
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.fileManager = new GoogleAIFileManager(apiKey);
    // Define the schema for structured output
    const transcriptionSchema = {
      type: "object",
      properties: {
        transcript: {
          type: "string",
          description: "Full transcription with timestamps and speaker labels"
        },
        summary: {
          type: "string", 
          description: "Meeting summary in Korean"
        },
        keyPoints: {
          type: "array",
          items: { type: "string" },
          description: "Key points discussed in Korean"
        },
        actionItems: {
          type: "array",
          items: { type: "string" },
          description: "Action items in Korean"
        },
        emoji: {
          type: "string",
          description: "Single emoji representing the meeting"
        }
      },
      required: ["transcript", "summary", "keyPoints", "actionItems", "emoji"]
    };

    this.model = this.genAI.getGenerativeModel({ 
      model: "gemini-2.5-flash",  // Using Gemini 2.5 Flash model
      generationConfig: {
        temperature: 0.7,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 32768,  // Increased for very long transcriptions
        responseMimeType: "application/json"  // Force JSON response
        // responseSchema: transcriptionSchema as any  // Temporarily disabled for debugging
      }
    });
    
    // Initialize segment model without JSON response mode for plain text transcription
    this.segmentModel = this.genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {
        temperature: 0.7,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 32768  // Increased for comprehensive 5-minute segments
      }
    });
  }

  async transcribeAudio(audioFilePath: string, progressCallback?: (percent: number, message: string) => void): Promise<TranscriptionResult> {
    try {
      // Check file size
      const stats = fs.statSync(audioFilePath);
      const fileSizeInMB = stats.size / (1024 * 1024);
      console.log(`Audio file size: ${fileSizeInMB.toFixed(2)} MB`);
      
      if (progressCallback) {
        progressCallback(15, `Processing ${fileSizeInMB.toFixed(1)} MB audio file...`);
      }
      
      // Get audio duration using ffprobe
      const duration = await this.getAudioDuration(audioFilePath);
      console.log(`Audio duration: ${duration} seconds`);
      
      // Always use the two-step approach for consistency
      console.log('Using two-step transcription approach...');
      return await this.transcribeWithTwoSteps(audioFilePath, duration, progressCallback);
    } catch (error) {
      console.error('Error transcribing audio:', error);
      
      // Provide more specific error messages
      if (error instanceof Error) {
        if (error.message.includes('API key')) {
          throw new Error('Invalid API key. Please check your Gemini API key configuration.');
        } else if (error.message.includes('quota')) {
          throw new Error('API quota exceeded. Please try again later.');
        } else if (error.message.includes('model')) {
          throw new Error('Model not available. Please check your API access.');
        }
      }
      
      throw new Error(`Failed to transcribe audio: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Get audio duration using ffprobe
  private async getAudioDuration(audioFilePath: string): Promise<number> {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    
    try {
      const ffprobeCommand = `"${ffprobePath}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioFilePath}"`;
      console.log('Running ffprobe command:', ffprobeCommand);
      
      const { stdout } = await execAsync(ffprobeCommand);
      return parseFloat(stdout.trim());
    } catch (error) {
      console.error('Error getting audio duration:', error);
      throw error;
    }
  }

  // Split audio file into segments
  private async splitAudioIntoSegments(audioFilePath: string, segmentDuration: number = 300): Promise<string[]> {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    
    const outputDir = path.dirname(audioFilePath);
    const baseName = path.basename(audioFilePath, path.extname(audioFilePath));
    const ext = path.extname(audioFilePath);
    
    const segmentPath = path.join(outputDir, `${baseName}_segment_%03d${ext}`);
    
    try {
      // Split audio into segments
      await execAsync(
        `ffmpeg -i "${audioFilePath}" -f segment -segment_time ${segmentDuration} -c copy "${segmentPath}"`
      );
      
      // Find all created segment files
      const segmentFiles = fs.readdirSync(outputDir)
        .filter(file => file.startsWith(`${baseName}_segment_`) && file.endsWith(ext))
        .map(file => path.join(outputDir, file))
        .sort();
      
      console.log(`Split audio into ${segmentFiles.length} segments`);
      return segmentFiles;
    } catch (error) {
      console.error('Error splitting audio:', error);
      throw error;
    }
  }

  // Helper function to format time
  private formatTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  
  // Get duration for segment calculation
  private getSegmentDuration(audioFilePath: string): number {
    return 300; // 5 minutes in seconds
  }

  // Two-step transcription approach for all audio files
  private async transcribeWithTwoSteps(audioFilePath: string, duration: number, progressCallback?: (percent: number, message: string) => void): Promise<TranscriptionResult> {
    try {
      let fullTranscript = '';
      
      // Step 1: Get transcript
      if (duration > 300) {
        // Use segmented approach for long audio
        console.log('Audio is longer than 5 minutes, using segmented transcription...');
        fullTranscript = await this.getSegmentedTranscript(audioFilePath, duration, progressCallback);
      } else {
        // Get transcript for short audio
        console.log('Transcribing short audio...');
        fullTranscript = await this.getShortAudioTranscript(audioFilePath, progressCallback);
      }
      
      // Step 2: Generate summary, key points, action items from transcript
      if (progressCallback) {
        progressCallback(85, 'Generating summary and key points...');
      }
      
      const summaryPrompt = `Based on this meeting transcript, provide:

1. A concise meeting title in Korean (10-20 characters that captures the main topic)
2. A concise summary in Korean (2-3 paragraphs)
3. Key points discussed in Korean (as a bullet list)
4. Action items mentioned in Korean (as a bullet list)
5. An appropriate emoji that represents the meeting

Return as JSON:
{
  "suggestedTitle": "concise title in Korean",
  "summary": "summary in Korean",
  "keyPoints": ["point 1", "point 2"],
  "actionItems": ["action 1", "action 2"],
  "emoji": "📝"
}`;

      const summaryResult = await this.model.generateContent([summaryPrompt, fullTranscript]);
      const summaryResponse = await summaryResult.response;
      const summaryText = summaryResponse.text();
      
      let summaryData = {
        suggestedTitle: '',
        summary: '',
        keyPoints: [] as string[],
        actionItems: [] as string[],
        emoji: '📝'
      };
      
      try {
        summaryData = JSON.parse(summaryText);
      } catch (e) {
        console.error('Error parsing summary JSON:', e);
        // Try to extract manually
        const summaryMatch = summaryText.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
        if (summaryMatch) {
          summaryData.summary = summaryMatch[1].replace(/\\n/g, '\n');
        }
      }
      
      if (progressCallback) {
        progressCallback(95, 'Finalizing results...');
      }
      
      return {
        transcript: fullTranscript,
        summary: summaryData.summary,
        keyPoints: summaryData.keyPoints,
        actionItems: summaryData.actionItems,
        emoji: summaryData.emoji,
        suggestedTitle: summaryData.suggestedTitle
      };
      
    } catch (error) {
      console.error('Error in two-step transcription:', error);
      throw error;
    }
  }

  // Get transcript for short audio files
  private async getShortAudioTranscript(audioFilePath: string, progressCallback?: (percent: number, message: string) => void): Promise<string> {
    try {
      const stats = fs.statSync(audioFilePath);
      const fileSizeInMB = stats.size / (1024 * 1024);
      
      if (progressCallback) {
        progressCallback(20, 'Processing audio file...');
      }
      
      // Use Files API for files over 20MB
      let fileUri: string | null = null;
      if (fileSizeInMB > 20) {
        console.log('File is over 20MB, using Files API for upload...');
        
        if (progressCallback) {
          progressCallback(25, 'Uploading large file to Gemini...');
        }
        
        const fileExt = path.extname(audioFilePath).toLowerCase();
        const mimeType = fileExt === '.mp3' ? 'audio/mp3' : 'audio/wav';
        
        const uploadResult = await this.fileManager.uploadFile(audioFilePath, {
          mimeType: mimeType,
          displayName: path.basename(audioFilePath),
        });
        
        fileUri = uploadResult.file.uri;
        
        // Wait for file to be active
        let file = await this.fileManager.getFile(uploadResult.file.name);
        let retries = 0;
        while (file.state === "PROCESSING" && retries < 30) {
          console.log(`Waiting for file to be processed... (attempt ${retries + 1}/30)`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          file = await this.fileManager.getFile(uploadResult.file.name);
          retries++;
        }
        
        if (file.state !== "ACTIVE") {
          throw new Error(`File is not active. State: ${file.state}`);
        }
      }
      
      if (progressCallback) {
        progressCallback(50, 'Transcribing audio...');
      }
      
      const transcriptPrompt = `Please transcribe this audio recording with proper speaker identification.

Format requirements:
1. IDENTIFY different speakers and label them as 참가자1, 참가자2, etc.
2. Each speaker's turn MUST start on a NEW LINE
3. Format: 참가자X: [what they said]
4. Add a blank line between different speakers

Example format:
참가자1: 안녕하세요, 오늘 회의를 시작하겠습니다.

참가자2: 네, 준비됐습니다.

참가자1: 첫 번째 안건은...

IMPORTANT:
- You MUST identify and differentiate between speakers
- Each speaker turn MUST start on a new line
- Add blank line between different speakers
- DO NOT include timestamps
- Keep the transcription in the original spoken language
- Return ONLY the transcription text, no JSON formatting`;

      let result;
      if (fileUri) {
        const fileExt = path.extname(audioFilePath).toLowerCase();
        const mimeType = fileExt === '.mp3' ? 'audio/mp3' : 'audio/wav';
        
        result = await this.segmentModel.generateContent([
          {
            fileData: {
              fileUri: fileUri,
              mimeType: mimeType
            }
          },
          transcriptPrompt
        ]);
      } else {
        const audioData = fs.readFileSync(audioFilePath);
        const base64Audio = audioData.toString('base64');
        const fileExt = path.extname(audioFilePath).toLowerCase();
        const mimeType = fileExt === '.mp3' ? 'audio/mp3' : 'audio/wav';
        
        result = await this.segmentModel.generateContent([
          {
            inlineData: {
              mimeType: mimeType,
              data: base64Audio
            }
          },
          transcriptPrompt
        ]);
      }
      
      const response = await result.response;
      return response.text();
      
    } catch (error) {
      console.error('Error transcribing short audio:', error);
      throw error;
    }
  }

  // Get segmented transcript (renamed from transcribeAudioSegmented)
  private async getSegmentedTranscript(audioFilePath: string, duration: number, progressCallback?: (percent: number, message: string) => void): Promise<string> {
    try {
      // Split audio into 5-minute segments
      const segmentFiles = await this.splitAudioIntoSegments(audioFilePath, 300);
      
      if (progressCallback) {
        progressCallback(20, `Processing ${segmentFiles.length} segments...`);
      }
      
      // Create promises for all segment transcriptions
      const transcriptionPromises = segmentFiles.map(async (segmentFile, i) => {
        const segmentStartTime = i * 300; // 5 minutes in seconds
        
        // Create segment-specific prompt
        const segmentPrompt = `Please transcribe audio segment ${i + 1} of ${segmentFiles.length} with proper speaker identification.

Format requirements:
1. IDENTIFY different speakers and label them as 참가자1, 참가자2, etc.
2. Each speaker's turn MUST start on a NEW LINE
3. Format: 참가자X: [what they said]
4. Add a blank line between different speakers

Example format:
참가자1: 안녕하세요, 오늘 회의를 시작하겠습니다.

참가자2: 네, 준비됐습니다.

참가자1: 첫 번째 안건은...

IMPORTANT:
- You MUST identify and differentiate between speakers
- Each speaker turn MUST start on a new line
- Add blank line between different speakers
- DO NOT include timestamps
- Keep the transcription in the original spoken language
- Return ONLY the transcription text, no JSON formatting`;

        try {
          console.log(`Starting transcription for segment ${i + 1}/${segmentFiles.length}...`);
          
          const audioData = fs.readFileSync(segmentFile);
          const base64Audio = audioData.toString('base64');
          const fileExt = path.extname(segmentFile).toLowerCase();
          const mimeType = fileExt === '.mp3' ? 'audio/mp3' : 'audio/wav';
          
          const result = await this.segmentModel.generateContent([
            {
              inlineData: {
                mimeType: mimeType,
                data: base64Audio
              }
            },
            segmentPrompt
          ]);
          
          const response = await result.response;
          const transcript = response.text();
          
          console.log(`Completed transcription for segment ${i + 1}/${segmentFiles.length}`);
          
          // Add segment time range header
          const segmentEndTime = Math.min(segmentStartTime + 300, duration);
          const segmentHeader = `[Segment ${i + 1}: ${this.formatTime(segmentStartTime)} ~ ${this.formatTime(segmentEndTime)}]\n\n`;
          
          return {
            index: i,
            content: segmentHeader + transcript
          };
          
        } catch (segmentError) {
          console.error(`Error transcribing segment ${i + 1}:`, segmentError);
          return {
            index: i,
            content: `[Segment ${i + 1} transcription failed]`
          };
        }
      });
      
      // Track progress of concurrent transcriptions
      let completedCount = 0;
      const progressTrackedPromises = transcriptionPromises.map(promise => 
        promise.then(result => {
          completedCount++;
          if (progressCallback) {
            const progress = 20 + (completedCount / segmentFiles.length) * 60; // 20-80% range
            progressCallback(progress, `Transcribed ${completedCount} of ${segmentFiles.length} segments...`);
          }
          return result;
        })
      );
      
      // Wait for all transcriptions to complete
      const segmentResults = await Promise.all(progressTrackedPromises);
      
      // Sort by index to maintain order
      segmentResults.sort((a, b) => a.index - b.index);
      
      // Update progress
      if (progressCallback) {
        progressCallback(80, 'All segments transcribed, merging results...');
      }
      
      // Extract transcripts in order
      const segmentTranscripts = segmentResults.map(result => result.content);
      
      // Clean up segment files
      await Promise.all(segmentFiles.map(async (segmentFile) => {
        try {
          fs.unlinkSync(segmentFile);
        } catch (e) {
          console.error(`Failed to delete segment file: ${segmentFile}`, e);
        }
      }));
      
      // Merge all transcripts with clear segment breaks
      return segmentTranscripts.join('\n\n---\n\n');
      
    } catch (error) {
      console.error('Error in segmented transcription:', error);
      throw error;
    }
  }

  // Test the API connection
  async testConnection(): Promise<boolean> {
    try {
      const result = await this.model.generateContent('Hello, please respond with "Connection successful"');
      const response = await result.response;
      const text = response.text();
      return text.toLowerCase().includes('connection successful');
    } catch (error) {
      console.error('API connection test failed:', error);
      return false;
    }
  }
}