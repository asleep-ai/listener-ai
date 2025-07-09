import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import * as fs from 'fs';
import * as path from 'path';

export interface TranscriptionResult {
  transcript: string;
  summary: string;
  keyPoints: string[];
  actionItems: string[];
}

export class GeminiService {
  private genAI: GoogleGenerativeAI;
  private model: GenerativeModel;

  constructor(apiKey: string) {
    this.genAI = new GoogleGenerativeAI(apiKey);
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

      // Check if file is too large (limit to 10MB for inline data)
      if (fileSizeInMB > 10) {
        throw new Error('Audio file is too large. Please record shorter sessions (under 10 minutes).');
      }

      // Read the audio file
      const audioData = fs.readFileSync(audioFilePath);
      const base64Audio = audioData.toString('base64');

      console.log('Sending audio to Gemini for transcription...');

      // Create the prompt for transcription and analysis
      const prompt = `Please analyze this audio recording and provide:

1. A complete and accurate transcription of the entire audio content with timestamps and speaker labels
   - Format each line as: "참가자[HH:MM:SS]: spoken text"
   - Use "참가자1", "참가자2", etc. if multiple speakers are detected
   - Include timestamps for each speaker turn or significant pause
   - Example: "참가자1[00:00:05]: 안녕하세요, 오늘 회의를 시작하겠습니다."

2. A concise summary of the meeting (2-3 paragraphs)
3. Key points discussed (as a bullet list)
4. Action items mentioned (as a bullet list with assigned persons if mentioned)

Format your response as JSON with the following structure:
{
  "transcript": "Full transcription with format: 참가자[HH:MM:SS]: text",
  "summary": "Brief summary of the meeting",
  "keyPoints": ["Key point 1", "Key point 2", ...],
  "actionItems": ["Action item 1", "Action item 2", ...]
}`;

      // Generate content with inline audio data
      const result = await this.model.generateContent([
        prompt,
        {
          inlineData: {
            mimeType: 'audio/wav',
            data: base64Audio
          }
        }
      ]);
      
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
            actionItems: Array.isArray(parsedResult.actionItems) ? parsedResult.actionItems : []
          };
        }
        
        // If no JSON found, try to parse the entire response
        const directParse = JSON.parse(text);
        return {
          transcript: directParse.transcript || '',
          summary: directParse.summary || '',
          keyPoints: Array.isArray(directParse.keyPoints) ? directParse.keyPoints : [],
          actionItems: Array.isArray(directParse.actionItems) ? directParse.actionItems : []
        };
        
      } catch (parseError) {
        console.error('Error parsing JSON response:', parseError);
        console.log('Raw response:', text);
        
        // Fallback: return the raw text as transcript
        return {
          transcript: text,
          summary: 'Unable to generate summary. The audio might be too short or unclear.',
          keyPoints: [],
          actionItems: []
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