import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { GoogleGenAI } from '@google/genai';
import {
  type AiProvider,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_TRANSCRIPTION_MODEL,
} from './aiProvider';
import { mimeTypeForExtension } from './audioFormats';
import { type CodexOAuthCredentials, requireCodexAccessToken } from './codexOAuth';
import {
  OPENAI_TRANSCRIPTION_EXTENSIONS,
  generateCodexResponseText,
  transcribeCodexAudio,
} from './openaiCodexClient';
import { formatOffsetTimestamp, type LiveNote } from './outputService';
import { FFmpegManager } from './services/ffmpegManager';

const execFileAsync = promisify(execFile);

// Append a section to the summary prompt instructing Gemini to enrich each
// user-flagged moment with a subtitle + categorized bullets, returned as a
// `highlights` array on the JSON response. Returns '' when there's nothing to
// enrich -- prompt stays untouched in that case so we don't pay for empty
// instructions.
function buildHighlightsPromptBlock(notes: LiveNote[]): string {
  if (notes.length === 0) return '';
  const lines = notes.map(
    (n) =>
      `- offsetMs=${n.offsetMs}, timestamp=${formatOffsetTimestamp(n.offsetMs)}, userText=${JSON.stringify(n.text)}`,
  );
  return `In addition, the user flagged the following moments during the meeting. For each note, produce a structured analysis tied to that moment in the transcript:

${lines.join('\n')}

For every flagged moment above, write one entry in a JSON array named "highlights". Each entry must include:
- "offsetMs": the exact integer from the input
- "userText": the user's typed text, copied verbatim
- "subtitle": a short topic label in Korean (3-7 words) summarising what was being discussed at that timestamp
- "bullets": 2-5 short Korean bullet strings categorising the discussion at that point. Prefix each bullet with one of these categories when applicable, omitting categories that don't fit: "결정 사항:", "주요 인사이트:", "실행 항목:", "식별된 리스크:". If none of the categories fit, just write the bullet without a prefix.

Use the transcript as the ground truth -- if the user's typed text doesn't clearly match anything in the transcript, fall back to the meeting content nearest the given timestamp. Return the highlights array as an additional key alongside the other fields in the JSON.`;
}

function mergeHighlights(
  liveNotes: LiveNote[] | undefined,
  raw: unknown,
): HighlightEntry[] | undefined {
  if (!liveNotes || liveNotes.length === 0) return undefined;
  // Index Gemini's returned highlights by offsetMs so we can attach
  // enrichment to the matching user note. Treat anything malformed as
  // "no enrichment for that note" -- the bare offset+userText still
  // round-trips so the user's data is never lost.
  const byOffset = new Map<number, { subtitle?: string; bullets?: string[] }>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const offsetMs = Number((item as { offsetMs?: unknown }).offsetMs);
      if (!Number.isFinite(offsetMs)) continue;
      const subtitleRaw = (item as { subtitle?: unknown }).subtitle;
      const bulletsRaw = (item as { bullets?: unknown }).bullets;
      const subtitle =
        typeof subtitleRaw === 'string' && subtitleRaw.trim().length > 0
          ? subtitleRaw.trim()
          : undefined;
      const bullets = Array.isArray(bulletsRaw)
        ? bulletsRaw.map((b) => (typeof b === 'string' ? b.trim() : '')).filter((b) => b.length > 0)
        : undefined;
      byOffset.set(offsetMs, {
        subtitle,
        bullets: bullets && bullets.length > 0 ? bullets : undefined,
      });
    }
  }
  return liveNotes.map((note) => {
    const enrichment = byOffset.get(note.offsetMs);
    return {
      offsetMs: note.offsetMs,
      userText: note.text,
      subtitle: enrichment?.subtitle,
      bullets: enrichment?.bullets,
    };
  });
}

export interface TranscriptionResult {
  transcript: string;
  summary: string;
  keyPoints: string[];
  actionItems: string[];
  emoji: string;
  suggestedTitle?: string;
  customFields?: Record<string, unknown>;
  // Notes captured live by the user during the recording. Not produced by
  // Gemini -- attached by main after transcription returns.
  liveNotes?: LiveNote[];
  // Plaud-style enriched view of the user's live notes: each entry pairs the
  // user-typed text with an AI-generated subtitle + categorized bullets that
  // describe what was being discussed around that moment in the meeting.
  // Pure flag-only notes (empty text) round-trip as `userText: ""` with no
  // subtitle/bullets -- they remain bare timestamp markers.
  highlights?: HighlightEntry[];
}

export interface HighlightEntry {
  offsetMs: number;
  userText: string;
  subtitle?: string;
  bullets?: string[];
}

export interface TranscriptionOptions {
  transcriptOnly?: boolean;
  /**
   * Override the default speaker-identification instruction sent to Gemini
   * during transcription. The user-supplied glossary (knownWords) and
   * per-segment positional prefix are still applied automatically.
   */
  transcriptionPrompt?: string;
}

function transcriptOnlyResult(transcript: string): TranscriptionResult {
  return {
    transcript,
    summary: '',
    keyPoints: [],
    actionItems: [],
    emoji: '',
  };
}

const DEFAULT_TRANSCRIPT_PROMPT = `Please transcribe this audio recording with proper speaker identification.

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

export interface GeminiServiceOptions {
  provider?: AiProvider;
  apiKey?: string;
  codexOAuth?: CodexOAuthCredentials;
  onCodexOAuthUpdate?: (credentials: CodexOAuthCredentials) => void | Promise<void>;
  dataPath?: string;
  knownWords?: string[];
  proModel: string;
  flashModel: string;
  codexModel?: string;
  codexTranscriptionModel?: string;
}

export class GeminiService {
  private ai?: GoogleGenAI;
  private provider: AiProvider;
  private ffmpegManager: FFmpegManager;
  private knownWords: string[];
  private proModel: string;
  private flashModel: string;
  private codexOAuth?: CodexOAuthCredentials;
  private onCodexOAuthUpdate?: (credentials: CodexOAuthCredentials) => void | Promise<void>;
  private codexModel: string;
  private codexTranscriptionModel: string;

  // Get FFmpeg path for this service
  private async getFFmpegPath(): Promise<string> {
    const ffmpegPath = await this.ffmpegManager.ensureFFmpeg();
    if (ffmpegPath) {
      return ffmpegPath;
    }

    // FFmpeg not found - return default and let error handling in splitAudioIntoSegments show dialog
    return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  }

  constructor(options: GeminiServiceOptions) {
    this.provider = options.provider ?? 'gemini';
    if (this.provider === 'gemini') {
      if (!options.apiKey) {
        throw new Error('Gemini API key is required for the Gemini provider.');
      }
      this.ai = new GoogleGenAI({ apiKey: options.apiKey });
    }
    this.ffmpegManager = new FFmpegManager(options.dataPath);
    this.knownWords = options.knownWords || [];
    this.proModel = options.proModel;
    this.flashModel = options.flashModel;
    this.codexOAuth = options.codexOAuth;
    this.onCodexOAuthUpdate = options.onCodexOAuthUpdate;
    this.codexModel = options.codexModel || DEFAULT_CODEX_MODEL;
    this.codexTranscriptionModel =
      options.codexTranscriptionModel || DEFAULT_CODEX_TRANSCRIPTION_MODEL;
  }

  private gemini(): GoogleGenAI {
    if (!this.ai) {
      throw new Error('Gemini client is not configured for the selected AI provider.');
    }
    return this.ai;
  }

  private async getCodexToken(): Promise<string> {
    return await requireCodexAccessToken({
      credentials: this.codexOAuth,
      onCredentialsChanged: async (credentials) => {
        this.codexOAuth = credentials;
        await this.onCodexOAuthUpdate?.(credentials);
      },
    });
  }

  private async prepareAudioForProvider(audioFilePath: string): Promise<{
    audioFilePath: string;
    cleanup?: () => void;
  }> {
    if (this.provider !== 'codex') return { audioFilePath };

    const ext = path.extname(audioFilePath).toLowerCase();
    if (OPENAI_TRANSCRIPTION_EXTENSIONS.has(ext)) return { audioFilePath };

    const outputPath = path.join(
      path.dirname(audioFilePath),
      `${path.basename(audioFilePath, ext)}_codex_${Date.now()}.webm`,
    );
    const ffmpegPath = await this.getFFmpegPath();
    await execFileAsync(ffmpegPath, [
      '-i',
      audioFilePath,
      '-vn',
      '-c:a',
      'libopus',
      '-b:a',
      '48k',
      outputPath,
    ]);
    return {
      audioFilePath: outputPath,
      cleanup: () => {
        try {
          fs.unlinkSync(outputPath);
        } catch {
          /* ignore */
        }
      },
    };
  }

  private buildGlossaryBlock(): string {
    if (this.knownWords.length === 0) return '';
    const wordList = this.knownWords.map((w) => `- ${w}`).join('\n');
    return `The following proper nouns, names, and terms may appear in the audio. Transcribe them exactly as spelled:\n${wordList}\n\n`;
  }

  async transcribeAudio(
    audioFilePath: string,
    progressCallback?: (percent: number, message: string) => void,
    summaryPrompt?: string,
    liveNotes?: LiveNote[],
    options: TranscriptionOptions = {},
  ): Promise<TranscriptionResult> {
    // Integration-test escape hatch: avoid the real Gemini call so tests can
    // exercise the surrounding pipeline (CLI parsing, IPC, ffmpeg, save) for
    // free and offline. Gated on NODE_ENV=test so a stray LISTENER_TEST_MODE
    // in a packaged user's shell rc can't silently stub their transcripts.
    if (process.env.LISTENER_TEST_MODE && process.env.NODE_ENV === 'test') {
      if (progressCallback) progressCallback(100, 'Stubbed transcription');
      if (options.transcriptOnly) {
        return transcriptOnlyResult('Stubbed transcript.');
      }
      return {
        transcript: 'Stubbed transcript.',
        summary: 'Stubbed summary.',
        keyPoints: ['stub point'],
        actionItems: ['stub action'],
        emoji: '🧪',
        suggestedTitle: 'Stubbed Title',
      };
    }

    const prepared = await this.prepareAudioForProvider(audioFilePath);
    try {
      // Check file size
      const stats = fs.statSync(prepared.audioFilePath);
      const fileSizeInMB = stats.size / (1024 * 1024);
      console.error(`Audio file size: ${fileSizeInMB.toFixed(2)} MB`);

      if (progressCallback) {
        progressCallback(15, `Processing ${fileSizeInMB.toFixed(1)} MB audio file...`);
      }

      // Get audio duration using ffmpeg
      const duration = await this.getAudioDuration(prepared.audioFilePath);
      console.error(`Audio duration: ${duration} seconds`);

      // If duration is 0, log a warning but continue processing
      if (duration === 0) {
        console.warn(
          'WARNING: Could not determine audio duration. Will process as single file without segmentation.',
        );
      }

      // Always use the two-step approach for consistency
      console.error('Using two-step transcription approach...');
      return await this.transcribeWithTwoSteps(
        prepared.audioFilePath,
        duration,
        progressCallback,
        summaryPrompt,
        liveNotes,
        options,
      );
    } catch (error) {
      console.error('Error transcribing audio:', error);

      // Provide more specific error messages
      if (error instanceof Error) {
        if (error.message.includes('API key')) {
          throw new Error(
            this.provider === 'codex'
              ? 'Invalid Codex OAuth token. Please sign in again.'
              : 'Invalid API key. Please check your Gemini API key configuration.',
          );
        } else if (error.message.includes('quota')) {
          throw new Error('API quota exceeded. Please try again later.');
        } else if (error.message.includes('model')) {
          throw new Error('Model not available. Please check your API access.');
        }
      }

      throw new Error(
        `Failed to transcribe audio: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      prepared.cleanup?.();
    }
  }

  // Get audio duration using ffmpeg
  private async getAudioDuration(audioFilePath: string): Promise<number> {
    try {
      const ffmpegPath = await this.getFFmpegPath();

      // Use ffmpeg with -f null to get file info including duration
      // This will output file info to stderr which we can parse
      console.error('Running ffmpeg for duration:', ffmpegPath, audioFilePath);

      const { stderr } = await execFileAsync(ffmpegPath, [
        '-i',
        audioFilePath,
        '-f',
        'null',
        '-',
      ]).catch((error: unknown) => {
        const execError = error as { stdout?: string; stderr?: string };
        // FFmpeg exits with non-zero code when output is null, but still provides info in stderr
        // This is expected behavior, so we return the error object which contains stdout/stderr
        return { stdout: execError.stdout || '', stderr: execError.stderr || '' };
      });

      // Extract duration from stderr (where ffmpeg outputs file info)
      const durationMatch = stderr?.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})/);
      if (durationMatch) {
        const hours = Number.parseInt(durationMatch[1]);
        const minutes = Number.parseInt(durationMatch[2]);
        const seconds = Number.parseFloat(durationMatch[3]);
        const totalSeconds = hours * 3600 + minutes * 60 + seconds;
        console.error(`FFmpeg extracted duration: ${totalSeconds} seconds`);
        return totalSeconds;
      }

      // Alternative regex pattern for different duration formats
      const altDurationMatch = stderr?.match(/Duration: (\d+):(\d+):(\d+)/);
      if (altDurationMatch) {
        const hours = Number.parseInt(altDurationMatch[1]);
        const minutes = Number.parseInt(altDurationMatch[2]);
        const seconds = Number.parseInt(altDurationMatch[3]);
        const totalSeconds = hours * 3600 + minutes * 60 + seconds;
        console.error(`FFmpeg extracted duration (alt format): ${totalSeconds} seconds`);
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
  private async splitAudioIntoSegments(
    audioFilePath: string,
    segmentDuration = 300,
  ): Promise<string[]> {
    const outputDir = path.dirname(audioFilePath);
    const baseName = path.basename(audioFilePath, path.extname(audioFilePath));
    const ext = path.extname(audioFilePath);

    const segmentPath = path.join(outputDir, `${baseName}_segment_%03d${ext}`);

    // Get the bundled FFmpeg path
    const ffmpegPath = await this.getFFmpegPath();

    try {
      // Split audio into segments
      await execFileAsync(ffmpegPath, [
        '-i',
        audioFilePath,
        '-f',
        'segment',
        '-segment_time',
        String(segmentDuration),
        '-c',
        'copy',
        segmentPath,
      ]);

      // Find all created segment files
      const segmentFiles = fs
        .readdirSync(outputDir)
        .filter((file) => file.startsWith(`${baseName}_segment_`) && file.endsWith(ext))
        .map((file) => path.join(outputDir, file))
        .sort();

      console.error(`Split audio into ${segmentFiles.length} segments`);
      return segmentFiles;
    } catch (error: any) {
      console.error('Error splitting audio:', error);

      // Check if it's a Windows FFmpeg not found error
      if (
        process.platform === 'win32' &&
        (error.message?.includes('is not recognized') ||
          error.message?.includes('ffmpeg.exe') ||
          error.code === 'ENOENT')
      ) {
        let dialog: any;
        let shell: any;
        try {
          ({ dialog, shell } = require('electron'));
        } catch {
          throw new Error('FFmpeg not found. Please install FFmpeg.');
        }

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
            '5. Restart Listener.AI',
        );

        // Offer to open download page
        const result = dialog.showMessageBoxSync(null, {
          type: 'question',
          buttons: ['Open Download Page', 'Cancel'],
          defaultId: 0,
          message: 'Open FFmpeg download page?',
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
  private async transcribeWithTwoSteps(
    audioFilePath: string,
    duration: number,
    progressCallback?: (percent: number, message: string) => void,
    customSummaryPrompt?: string,
    liveNotes?: LiveNote[],
    options: TranscriptionOptions = {},
  ): Promise<TranscriptionResult> {
    try {
      let fullTranscript = '';
      const stats = fs.statSync(audioFilePath);
      const fileSizeInMB = stats.size / (1024 * 1024);
      const shouldSegment = duration > 300 || (this.provider === 'codex' && fileSizeInMB > 24);
      const segmentDuration =
        this.provider === 'codex' && duration > 0 && fileSizeInMB > 20
          ? Math.max(30, Math.min(300, Math.floor((20 / fileSizeInMB) * duration)))
          : 300;

      // Step 1: Get transcript
      if (shouldSegment) {
        // Use segmented approach for long audio
        console.error('Using segmented transcription...');
        fullTranscript = await this.getSegmentedTranscript(
          audioFilePath,
          duration,
          progressCallback,
          options.transcriptionPrompt,
          segmentDuration,
        );
      } else {
        // Get transcript for short audio
        console.error('Transcribing short audio...');
        fullTranscript = await this.getShortAudioTranscript(
          audioFilePath,
          progressCallback,
          options.transcriptionPrompt,
        );
      }

      if (options.transcriptOnly) {
        if (progressCallback) {
          progressCallback(100, 'Transcript ready');
        }
        return transcriptOnlyResult(fullTranscript);
      }

      // Step 2: Generate summary, key points, action items from transcript
      if (progressCallback) {
        progressCallback(85, 'Generating summary and key points...');
      }

      const basePrompt =
        customSummaryPrompt ||
        `Based on this meeting transcript, provide:

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

      const enrichableNotes = (liveNotes ?? []).filter((n) => (n.text ?? '').trim().length > 0);
      const highlightsBlock = buildHighlightsPromptBlock(enrichableNotes);
      const summaryPrompt = highlightsBlock ? `${basePrompt}\n\n${highlightsBlock}` : basePrompt;

      const summaryText =
        this.provider === 'codex'
          ? await generateCodexResponseText({
              getToken: () => this.getCodexToken(),
              model: this.codexModel,
              inputText: `${summaryPrompt}\n\nTranscript:\n${fullTranscript}`,
            })
          : (
              await this.gemini().models.generateContent({
                model: this.proModel,
                contents: [
                  { role: 'user', parts: [{ text: summaryPrompt }, { text: fullTranscript }] },
                ],
                config: {
                  temperature: 0.2,
                  maxOutputTokens: 32768,
                  responseMimeType: 'application/json',
                },
              })
            ).text || '';

      let summaryData = {
        suggestedTitle: '',
        summary: '',
        keyPoints: [] as string[],
        actionItems: [] as string[],
        emoji: '📝',
      };

      const KNOWN_KEYS = new Set([
        'suggestedTitle',
        'summary',
        'keyPoints',
        'actionItems',
        'emoji',
        'highlights',
      ]);
      const customFields: Record<string, unknown> = {};
      let rawHighlights: unknown;

      try {
        const parsed = JSON.parse(summaryText);
        summaryData = parsed;
        rawHighlights = (parsed as { highlights?: unknown }).highlights;

        // Extract custom fields (any keys not in the known set)
        for (const [key, value] of Object.entries(parsed)) {
          if (!KNOWN_KEYS.has(key)) {
            customFields[key] = value;
          }
        }
      } catch (e) {
        console.error('Error parsing summary JSON:', e);
        // Try to extract manually
        const summaryMatch = summaryText.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
        if (summaryMatch) {
          summaryData.summary = summaryMatch[1].replace(/\\n/g, '\n');
        }
      }

      const highlights = mergeHighlights(liveNotes, rawHighlights);

      if (progressCallback) {
        progressCallback(95, 'Finalizing results...');
      }

      return {
        transcript: fullTranscript,
        summary: summaryData.summary,
        keyPoints: summaryData.keyPoints,
        actionItems: summaryData.actionItems,
        emoji: summaryData.emoji,
        suggestedTitle: summaryData.suggestedTitle,
        customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
        highlights,
      };
    } catch (error) {
      console.error('Error in two-step transcription:', error);
      throw error;
    }
  }

  // Get transcript for short audio files
  private async getShortAudioTranscript(
    audioFilePath: string,
    progressCallback?: (percent: number, message: string) => void,
    customPrompt?: string,
  ): Promise<string> {
    try {
      const stats = fs.statSync(audioFilePath);
      const fileSizeInMB = stats.size / (1024 * 1024);

      if (progressCallback) {
        progressCallback(20, 'Processing audio file...');
      }

      const transcriptPrompt = `${this.buildGlossaryBlock()}${customPrompt ?? DEFAULT_TRANSCRIPT_PROMPT}`;
      if (this.provider === 'codex') {
        return await transcribeCodexAudio({
          getToken: () => this.getCodexToken(),
          audioFilePath,
          model: this.codexTranscriptionModel,
          prompt: transcriptPrompt,
        });
      }

      const ai = this.gemini();

      // Use Files API for files over 20MB
      let fileUri: string | null = null;
      if (fileSizeInMB > 20) {
        console.error('File is over 20MB, using Files API for upload...');

        if (progressCallback) {
          progressCallback(25, 'Uploading large file to Gemini...');
        }

        const mimeType = mimeTypeForExtension(path.extname(audioFilePath));

        const fileData = fs.readFileSync(audioFilePath);
        const uploadResult = await ai.files.upload({
          file: new Blob([fileData], { type: mimeType }),
        });

        fileUri = uploadResult.uri || '';

        // Wait for file to be active
        let file = await ai.files.get({ name: uploadResult.name || '' });
        let retries = 0;
        while (file.state === 'PROCESSING' && retries < 30) {
          console.error(`Waiting for file to be processed... (attempt ${retries + 1}/30)`);
          await new Promise((resolve) => setTimeout(resolve, 2000));
          file = await ai.files.get({ name: uploadResult.name || '' });
          retries++;
        }

        if (file.state !== 'ACTIVE') {
          throw new Error(`File is not active. State: ${file.state}`);
        }
      }

      if (progressCallback) {
        progressCallback(50, 'Transcribing audio...');
      }

      let result: Awaited<ReturnType<typeof ai.models.generateContent>>;
      if (fileUri) {
        const mimeType = mimeTypeForExtension(path.extname(audioFilePath));

        result = await ai.models.generateContent({
          model: this.flashModel,
          contents: [
            {
              role: 'user',
              parts: [
                {
                  fileData: {
                    fileUri: fileUri,
                    mimeType: mimeType,
                  },
                },
                { text: transcriptPrompt },
              ],
            },
          ],
          config: {
            temperature: 0.2,
            maxOutputTokens: 32768,
          },
        });
      } else {
        const audioData = fs.readFileSync(audioFilePath);
        const base64Audio = audioData.toString('base64');
        const mimeType = mimeTypeForExtension(path.extname(audioFilePath));

        result = await ai.models.generateContent({
          model: this.flashModel,
          contents: [
            {
              role: 'user',
              parts: [
                {
                  inlineData: {
                    mimeType: mimeType,
                    data: base64Audio,
                  },
                },
                { text: transcriptPrompt },
              ],
            },
          ],
          config: {
            temperature: 0.2,
            maxOutputTokens: 32768,
          },
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
  private createSegmentHeader(
    segmentIndex: number,
    segmentStartTime: number,
    segmentEndTime: number,
  ): string {
    return `[Segment ${segmentIndex + 1}: ${this.formatTime(segmentStartTime)} ~ ${this.formatTime(segmentEndTime)}]\n\n`;
  }

  // Create prompt for segment transcription
  private createSegmentPrompt(
    segmentIndex: number,
    totalSegments: number,
    customPrompt?: string,
  ): string {
    const positional = `[Audio segment ${segmentIndex + 1} of ${totalSegments}]\n\n`;
    const body = customPrompt ?? DEFAULT_TRANSCRIPT_PROMPT;
    return `${this.buildGlossaryBlock()}${positional}${body}`;
  }

  // Transcribe a single segment with retry logic
  private async transcribeSingleSegment(
    segmentFile: string,
    segmentIndex: number,
    totalSegments: number,
    segmentStartTime: number,
    segmentEndTime: number,
    customPrompt?: string,
  ): Promise<{ index: number; content: string }> {
    const maxRetries = 3;
    let lastError: any = null;
    const segmentPrompt = this.createSegmentPrompt(segmentIndex, totalSegments, customPrompt);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.error(
          `Starting transcription for segment ${segmentIndex + 1}/${totalSegments} (attempt ${attempt}/${maxRetries})...`,
        );

        if (this.provider === 'codex') {
          const transcript = await transcribeCodexAudio({
            getToken: () => this.getCodexToken(),
            audioFilePath: segmentFile,
            model: this.codexTranscriptionModel,
            prompt: segmentPrompt,
          });
          console.error(`Completed transcription for segment ${segmentIndex + 1}/${totalSegments}`);
          return {
            index: segmentIndex,
            content:
              this.createSegmentHeader(segmentIndex, segmentStartTime, segmentEndTime) + transcript,
          };
        }

        const audioData = fs.readFileSync(segmentFile);
        const base64Audio = audioData.toString('base64');
        const mimeType = mimeTypeForExtension(path.extname(segmentFile));

        const result = await this.gemini().models.generateContent({
          model: this.flashModel,
          contents: [
            {
              role: 'user',
              parts: [
                {
                  inlineData: {
                    mimeType: mimeType,
                    data: base64Audio,
                  },
                },
                { text: segmentPrompt },
              ],
            },
          ],
          config: {
            temperature: 0.2,
            maxOutputTokens: 32768,
          },
        });

        const transcript = result.text || '';

        console.error(`Completed transcription for segment ${segmentIndex + 1}/${totalSegments}`);

        // Add segment time range header
        const segmentHeader = this.createSegmentHeader(
          segmentIndex,
          segmentStartTime,
          segmentEndTime,
        );

        return {
          index: segmentIndex,
          content: segmentHeader + transcript,
        };
      } catch (segmentError) {
        lastError = segmentError;
        console.error(
          `Error transcribing segment ${segmentIndex + 1} (attempt ${attempt}/${maxRetries}):`,
          segmentError,
        );

        if (attempt < maxRetries) {
          // Wait before retry with exponential backoff
          const retryDelay = Math.min(1000 * 2 ** (attempt - 1), 10000); // Max 10 seconds
          console.error(`Retrying segment ${segmentIndex + 1} in ${retryDelay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
        }
      }
    }

    // All retries failed
    console.error(
      `Failed to transcribe segment ${segmentIndex + 1} after ${maxRetries} attempts:`,
      lastError,
    );
    return {
      index: segmentIndex,
      content: `[Segment ${segmentIndex + 1} transcription failed after ${maxRetries} attempts]`,
    };
  }

  // Get segmented transcript (renamed from transcribeAudioSegmented)
  private async getSegmentedTranscript(
    audioFilePath: string,
    duration: number,
    progressCallback?: (percent: number, message: string) => void,
    customPrompt?: string,
    segmentDuration = 300,
  ): Promise<string> {
    try {
      // Split audio into 5-minute segments
      const segmentFiles = await this.splitAudioIntoSegments(audioFilePath, segmentDuration);

      if (progressCallback) {
        progressCallback(20, `Processing ${segmentFiles.length} segments...`);
      }

      // Create promises for all segment transcriptions
      const transcriptionPromises = segmentFiles.map(async (segmentFile, i) => {
        const segmentStartTime = i * segmentDuration;
        const segmentEndTime = Math.min(segmentStartTime + segmentDuration, duration);

        return this.transcribeSingleSegment(
          segmentFile,
          i,
          segmentFiles.length,
          segmentStartTime,
          segmentEndTime,
          customPrompt,
        );
      });

      // Track progress of concurrent transcriptions
      let completedCount = 0;
      const progressTrackedPromises = transcriptionPromises.map((promise) =>
        promise.then((result) => {
          completedCount++;
          if (progressCallback) {
            const progress = 20 + (completedCount / segmentFiles.length) * 60; // 20-80% range
            progressCallback(
              progress,
              `Transcribed ${completedCount} of ${segmentFiles.length} segments...`,
            );
          }
          return result;
        }),
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
      const segmentTranscripts = segmentResults.map((result) => result.content);

      // Clean up segment files
      await Promise.all(
        segmentFiles.map(async (segmentFile) => {
          try {
            fs.unlinkSync(segmentFile);
          } catch (e) {
            console.error(`Failed to delete segment file: ${segmentFile}`, e);
          }
        }),
      );

      // Merge all transcripts with clear segment breaks
      return segmentTranscripts.join('\n\n---\n\n');
    } catch (error) {
      console.error('Error in segmented transcription:', error);
      throw error;
    }
  }
}
