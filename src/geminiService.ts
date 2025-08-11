import { GoogleGenAI } from '@google/genai';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { FFmpegManager } from './services/ffmpegManager';

// Use FFmpegManager for FFmpeg path resolution
const ffmpegManager = new FFmpegManager();

export interface TranscriptionResult {
  transcript: string;
  summary: string;
  keyPoints: string[];
  actionItems: string[];
  emoji: string;
  suggestedTitle?: string;
}

export class GeminiService {
  private ai: GoogleGenAI;
  private apiKey: string;

  // Get FFmpeg path for this service
  private async getFFmpegPath(): Promise<string> {
    const ffmpegPath = await ffmpegManager.ensureFFmpeg();
    if (ffmpegPath) {
      return ffmpegPath;
    }

    // FFmpeg not found - return default and let error handling in splitAudioIntoSegments show dialog
    return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  }

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.ai = new GoogleGenAI({ apiKey: apiKey });
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

      // Get audio duration using ffmpeg
      const duration = await this.getAudioDuration(audioFilePath);
      console.log(`Audio duration: ${duration} seconds`);

      // If duration is 0, log a warning but continue processing
      if (duration === 0) {
        console.warn('WARNING: Could not determine audio duration. Will process as single file without segmentation.');
      }

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
      const ffmpegPath = await this.getFFmpegPath();

      // Use ffmpeg with -f null to get file info including duration
      // This will output file info to stderr which we can parse
      const ffmpegCommand = `"${ffmpegPath}" -i "${audioFilePath}" -f null -`;
      console.log('Running ffmpeg command for duration:', ffmpegCommand);

      const { stderr } = await execAsync(ffmpegCommand).catch((e: any) => {
        // FFmpeg exits with non-zero code when output is null, but still provides info in stderr
        // This is expected behavior, so we return the error object which contains stdout/stderr
        return { stdout: e.stdout || '', stderr: e.stderr || '' };
      });

      // Extract duration from stderr (where ffmpeg outputs file info)
      const durationMatch = stderr?.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})/);
      if (durationMatch) {
        const hours = parseInt(durationMatch[1]);
        const minutes = parseInt(durationMatch[2]);
        const seconds = parseFloat(durationMatch[3]);
        const totalSeconds = hours * 3600 + minutes * 60 + seconds;
        console.log(`FFmpeg extracted duration: ${totalSeconds} seconds`);
        return totalSeconds;
      }

      // Alternative regex pattern for different duration formats
      const altDurationMatch = stderr?.match(/Duration: (\d+):(\d+):(\d+)/);
      if (altDurationMatch) {
        const hours = parseInt(altDurationMatch[1]);
        const minutes = parseInt(altDurationMatch[2]);
        const seconds = parseInt(altDurationMatch[3]);
        const totalSeconds = hours * 3600 + minutes * 60 + seconds;
        console.log(`FFmpeg extracted duration (alt format): ${totalSeconds} seconds`);
        return totalSeconds;
      }

      // Default to 0 if we can't determine duration
      console.warn('Could not determine audio duration from stderr:', stderr);
      return 0;
    } catch (error) {
      console.error('Error getting audio duration:', error);
      // Return 0 as fallback to continue processing
      return 0;
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

    // Get the bundled FFmpeg path
    const ffmpegPath = await this.getFFmpegPath();

    try {
      // Split audio into segments
      await execAsync(
        `"${ffmpegPath}" -i "${audioFilePath}" -f segment -segment_time ${segmentDuration} -c copy "${segmentPath}"`
      );

      // Find all created segment files
      const segmentFiles = fs.readdirSync(outputDir)
        .filter(file => file.startsWith(`${baseName}_segment_`) && file.endsWith(ext))
        .map(file => path.join(outputDir, file))
        .sort();

      console.log(`Split audio into ${segmentFiles.length} segments`);
      return segmentFiles;
    } catch (error: any) {
      console.error('Error splitting audio:', error);

      // Check if it's a Windows FFmpeg not found error
      if (process.platform === 'win32' &&
        (error.message?.includes('is not recognized') ||
          error.message?.includes('ffmpeg.exe') ||
          error.code === 'ENOENT')) {
        const { dialog, shell } = require('electron');

        dialog.showErrorBox(
          'FFmpeg Not Found',
          'FFmpeg is required for audio transcription but was not found.\n\n' +
          'To install FFmpeg on Windows:\n\n' +
          'Option 1 (Recommended):\n' +
          '1. Open PowerShell as Administrator\n' +
          '2. Run: winget install ffmpeg\n' +
          '3. Restart Listener.AI\n\n' +
          'Option 2 (Manual):\n' +
          '1. Download from: https://www.gyan.dev/ffmpeg/builds/\n' +
          '2. Download "release essentials" build\n' +
          '3. Extract to C:\\ffmpeg\n' +
          '4. The ffmpeg.exe should be at C:\\ffmpeg\\bin\\ffmpeg.exe\n' +
          '5. Restart Listener.AI'
        );

        // Offer to open download page
        const result = dialog.showMessageBoxSync(null, {
          type: 'question',
          buttons: ['Open Download Page', 'Cancel'],
          defaultId: 0,
          message: 'Open FFmpeg download page?'
        });

        if (result === 0) {
          shell.openExternal('https://www.gyan.dev/ffmpeg/builds/');
        }

        throw new Error('FFmpeg not found. Please install FFmpeg and restart Listener.AI.');
      }

      throw error;
    }
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

      const summaryResult = await this.ai.models.generateContent({
        model: "gemini-2.5-pro",
        contents: [
          { role: "user", parts: [{ text: summaryPrompt }, { text: fullTranscript }] }
        ],
        config: {
          temperature: 0.2,
          maxOutputTokens: 32768,
          responseMimeType: "application/json"
        }
      });
      const summaryText = summaryResult.text || '';

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
        let mimeType = 'audio/mp3';
        if (fileExt === '.wav') {
          mimeType = 'audio/wav';
        } else if (fileExt === '.m4a') {
          mimeType = 'audio/mp4';
        }

        const fileData = fs.readFileSync(audioFilePath);
        const uploadResult = await this.ai.files.upload({
          file: new Blob([fileData], { type: mimeType })
        });

        fileUri = uploadResult.uri || '';

        // Wait for file to be active
        let file = await this.ai.files.get({ name: uploadResult.name || '' });
        let retries = 0;
        while (file.state === "PROCESSING" && retries < 30) {
          console.log(`Waiting for file to be processed... (attempt ${retries + 1}/30)`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          file = await this.ai.files.get({ name: uploadResult.name || '' });
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
        let mimeType = 'audio/mp3';
        if (fileExt === '.wav') {
          mimeType = 'audio/wav';
        } else if (fileExt === '.m4a') {
          mimeType = 'audio/mp4';
        }

        result = await this.ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: [
            {
              role: "user",
              parts: [
                {
                  fileData: {
                    fileUri: fileUri,
                    mimeType: mimeType
                  }
                },
                { text: transcriptPrompt }
              ]
            }
          ],
          config: {
            temperature: 0.2,
            maxOutputTokens: 32768
          }
        });
      } else {
        const audioData = fs.readFileSync(audioFilePath);
        const base64Audio = audioData.toString('base64');
        const fileExt = path.extname(audioFilePath).toLowerCase();
        let mimeType = 'audio/mp3';
        if (fileExt === '.wav') {
          mimeType = 'audio/wav';
        } else if (fileExt === '.m4a') {
          mimeType = 'audio/mp4';
        }

        result = await this.ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: [
            {
              role: "user",
              parts: [
                {
                  inlineData: {
                    mimeType: mimeType,
                    data: base64Audio
                  }
                },
                { text: transcriptPrompt }
              ]
            }
          ],
          config: {
            temperature: 0.2,
            maxOutputTokens: 32768
          }
        });
      }

      return result.text || '';

    } catch (error) {
      console.error('Error transcribing short audio:', error);
      throw error;
    }
  }

  // Format time in HH:MM:SS format
  private formatTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  // Create segment header with time range
  private createSegmentHeader(segmentIndex: number, segmentStartTime: number, segmentEndTime: number): string {
    return `[Segment ${segmentIndex + 1}: ${this.formatTime(segmentStartTime)} ~ ${this.formatTime(segmentEndTime)}]\n\n`;
  }

  // Create prompt for segment transcription
  private createSegmentPrompt(segmentIndex: number, totalSegments: number): string {
    return `Please transcribe audio segment ${segmentIndex + 1} of ${totalSegments} with proper speaker identification.

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
  }

  // Transcribe a single segment with retry logic
  private async transcribeSingleSegment(
    segmentFile: string,
    segmentIndex: number,
    totalSegments: number,
    segmentStartTime: number,
    segmentEndTime: number
  ): Promise<{ index: number; content: string }> {
    const maxRetries = 3;
    let lastError: any = null;
    const segmentPrompt = this.createSegmentPrompt(segmentIndex, totalSegments);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`Starting transcription for segment ${segmentIndex + 1}/${totalSegments} (attempt ${attempt}/${maxRetries})...`);

        const audioData = fs.readFileSync(segmentFile);
        const base64Audio = audioData.toString('base64');
        const fileExt = path.extname(segmentFile).toLowerCase();
        const mimeType = fileExt === '.mp3' ? 'audio/mp3' : 'audio/wav';

        const result = await this.ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: [
            {
              role: "user",
              parts: [
                {
                  inlineData: {
                    mimeType: mimeType,
                    data: base64Audio
                  }
                },
                { text: segmentPrompt }
              ]
            }
          ],
          config: {
            temperature: 0.2,
            maxOutputTokens: 32768
          }
        });

        const transcript = result.text || '';

        console.log(`Completed transcription for segment ${segmentIndex + 1}/${totalSegments}`);

        // Add segment time range header
        const segmentHeader = this.createSegmentHeader(segmentIndex, segmentStartTime, segmentEndTime);

        return {
          index: segmentIndex,
          content: segmentHeader + transcript
        };

      } catch (segmentError) {
        lastError = segmentError;
        console.error(`Error transcribing segment ${segmentIndex + 1} (attempt ${attempt}/${maxRetries}):`, segmentError);

        if (attempt < maxRetries) {
          // Wait before retry with exponential backoff
          const retryDelay = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // Max 10 seconds
          console.log(`Retrying segment ${segmentIndex + 1} in ${retryDelay}ms...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
    }

    // All retries failed
    console.error(`Failed to transcribe segment ${segmentIndex + 1} after ${maxRetries} attempts:`, lastError);
    return {
      index: segmentIndex,
      content: `[Segment ${segmentIndex + 1} transcription failed after ${maxRetries} attempts]`
    };
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
        const segmentEndTime = Math.min(segmentStartTime + 300, duration);

        return this.transcribeSingleSegment(
          segmentFile,
          i,
          segmentFiles.length,
          segmentStartTime,
          segmentEndTime
        );
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

}
