import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import * as fs from 'fs';
import * as path from 'path';

export interface TranscriptionResult {
  transcript: string;
  summary: string;
  keyPoints: string[];
  actionItems: string[];
  emoji: string;
}

export class GeminiService {
  private genAI: GoogleGenerativeAI;
  private model: GenerativeModel;
  private fileManager: GoogleAIFileManager;
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.fileManager = new GoogleAIFileManager(apiKey);
    this.model = this.genAI.getGenerativeModel({ 
      model: "gemini-2.5-flash",  // Using Gemini 2.5 Flash model
      generationConfig: {
        temperature: 0.7,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 8192,
      }
    });
  }

  async transcribeAudio(audioFilePath: string): Promise<TranscriptionResult> {
    try {
      // Check file size
      const stats = fs.statSync(audioFilePath);
      const fileSizeInMB = stats.size / (1024 * 1024);
      console.log(`Audio file size: ${fileSizeInMB.toFixed(2)} MB`);

      let fileUri: string | null = null;
      let uploadedFileName: string | null = null;
      
      // Use Files API for files over 20MB
      if (fileSizeInMB > 20) {
        console.log('File is over 20MB, using Files API for upload...');
        
        // Determine MIME type based on file extension
        const fileExt = path.extname(audioFilePath).toLowerCase();
        const mimeType = fileExt === '.mp3' ? 'audio/mp3' : 'audio/wav';
        
        // Upload the file using Files API
        const uploadResult = await this.fileManager.uploadFile(audioFilePath, {
          mimeType: mimeType,
          displayName: path.basename(audioFilePath),
        });
        
        console.log(`File uploaded successfully. URI: ${uploadResult.file.uri}`);
        fileUri = uploadResult.file.uri;
        uploadedFileName = uploadResult.file.name;
        
        // Wait for file to be active
        let file = await this.fileManager.getFile(uploadResult.file.name);
        while (file.state === "PROCESSING") {
          console.log('Waiting for file to be processed...');
          await new Promise(resolve => setTimeout(resolve, 2000));
          file = await this.fileManager.getFile(uploadResult.file.name);
        }
        
        if (file.state === "FAILED") {
          throw new Error('File processing failed');
        }
        
        console.log('File is ready for use');
      }

      console.log('Sending audio to Gemini for transcription...');

      // Create the prompt for transcription and analysis
      const prompt = `Please analyze this audio recording and provide:

1. A complete and accurate transcription of the entire audio content with timestamps and speaker labels
   - Keep the transcript in the ORIGINAL SPOKEN LANGUAGE (do not translate)
   - Format each line as: "참가자[HH:MM:SS]: spoken text"
   - Use "참가자1", "참가자2", etc. if multiple speakers are detected
   - Include timestamps for each speaker turn or significant pause
   - Example: "참가자1[00:00:05]: Hello, let's start the meeting."

2. A concise summary of the meeting IN KOREAN (2-3 paragraphs)
3. Key points discussed IN KOREAN (as a bullet list)
4. Action items mentioned IN KOREAN (as a bullet list with assigned persons if mentioned)
5. An appropriate emoji that best represents the meeting content/mood (single emoji)

IMPORTANT: 
- Keep the transcript in the original spoken language
- Translate ONLY the summary, keyPoints, and actionItems to Korean
- Choose an emoji that reflects the meeting's main topic or mood (e.g., 📊 for data, 💡 for ideas, 🎯 for goals, 🚀 for launches, 📝 for planning, etc.)

Format your response as JSON with the following structure:
{
  "transcript": "Full transcription in ORIGINAL LANGUAGE with format: 참가자[HH:MM:SS]: text",
  "summary": "회의 요약 (한국어로 작성)",
  "keyPoints": ["주요 포인트 1 (한국어)", "주요 포인트 2 (한국어)", ...],
  "actionItems": ["액션 아이템 1 (한국어)", "액션 아이템 2 (한국어)", ...],
  "emoji": "📝"
}`;

      // Generate content based on file size
      let result;
      if (fileUri) {
        // Use file URI for large files
        const fileExt = path.extname(audioFilePath).toLowerCase();
        const mimeType = fileExt === '.mp3' ? 'audio/mp3' : 'audio/wav';
        
        result = await this.model.generateContent([
          prompt,
          {
            fileData: {
              fileUri: fileUri,
              mimeType: mimeType
            }
          }
        ]);
      } else {
        // Use inline data for small files (under 20MB)
        const audioData = fs.readFileSync(audioFilePath);
        const base64Audio = audioData.toString('base64');
        const fileExt = path.extname(audioFilePath).toLowerCase();
        const mimeType = fileExt === '.mp3' ? 'audio/mp3' : 'audio/wav';
        
        result = await this.model.generateContent([
          prompt,
          {
            inlineData: {
              mimeType: mimeType,
              data: base64Audio
            }
          }
        ]);
      }
      
      const response = await result.response;
      const text = response.text();
      console.log('Received response from Gemini');

      // Parse the JSON response
      try {
        // Extract JSON from the response (in case it's wrapped in markdown code blocks)
        let jsonText = text;
        
        // Remove markdown code blocks if present
        const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (codeBlockMatch) {
          jsonText = codeBlockMatch[1];
        }
        
        // Try to find JSON object
        const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsedResult = JSON.parse(jsonMatch[0]);
          return {
            transcript: parsedResult.transcript || '',
            summary: parsedResult.summary || '',
            keyPoints: Array.isArray(parsedResult.keyPoints) ? parsedResult.keyPoints : [],
            actionItems: Array.isArray(parsedResult.actionItems) ? parsedResult.actionItems : [],
            emoji: parsedResult.emoji || '📝'
          };
        }
        
        // If no JSON found, try to parse the entire response
        const directParse = JSON.parse(text);
        return {
          transcript: directParse.transcript || '',
          summary: directParse.summary || '',
          keyPoints: Array.isArray(directParse.keyPoints) ? directParse.keyPoints : [],
          actionItems: Array.isArray(directParse.actionItems) ? directParse.actionItems : [],
          emoji: directParse.emoji || '📝'
        };
        
      } catch (parseError) {
        console.error('Error parsing JSON response:', parseError);
        console.log('Raw response:', text);
        
        // Fallback: return the raw text as transcript
        return {
          transcript: text,
          summary: 'Unable to generate summary. The audio might be too short or unclear.',
          keyPoints: [],
          actionItems: [],
          emoji: '📝'
        };
      }

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

  // Alternative method for chunked audio processing (for very long recordings)
  async transcribeAudioChunked(audioFilePath: string, chunkSizeMinutes: number = 10): Promise<TranscriptionResult> {
    // This would be implemented if we need to handle very long recordings
    // For now, we'll use the simple method
    return this.transcribeAudio(audioFilePath);
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