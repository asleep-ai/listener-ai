import ffmpeg from 'fluent-ffmpeg';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Set ffmpeg path based on platform
let ffmpegPath = 'ffmpeg';
if (process.platform === 'darwin') {
  // Check for Apple Silicon or Intel Mac
  if (fs.existsSync('/opt/homebrew/bin/ffmpeg')) {
    ffmpegPath = '/opt/homebrew/bin/ffmpeg'; // Apple Silicon
  } else if (fs.existsSync('/usr/local/bin/ffmpeg')) {
    ffmpegPath = '/usr/local/bin/ffmpeg'; // Intel Mac
  }
}

ffmpeg.setFfmpegPath(ffmpegPath);

export interface AudioDevice {
  index: number;
  name: string;
}

export class AudioRecorder {
  private ffmpegCommand: ffmpeg.FfmpegCommand | null = null;
  private outputPath: string | null = null;

  constructor() {
    // Create recordings directory if it doesn't exist
    const recordingsDir = path.join(app.getPath('userData'), 'recordings');
    if (!fs.existsSync(recordingsDir)) {
      fs.mkdirSync(recordingsDir, { recursive: true });
    }
  }

  async startRecording(meetingTitle: string): Promise<{ success: boolean; filePath?: string; error?: string }> {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = `${meetingTitle.replace(/[^a-z0-9]/gi, '_')}_${timestamp}.wav`;
      this.outputPath = path.join(app.getPath('userData'), 'recordings', fileName);

      // Platform-specific input configuration
      const inputOptions = await this.getInputOptions();

      // Log available devices for debugging
      if (process.platform === 'darwin') {
        const devices = await this.listAudioDevices();
        console.log('Available audio devices:', devices);
        console.log('Using device:', inputOptions.device);
      }

      this.ffmpegCommand = ffmpeg()
        .input(inputOptions.device)
        .inputOptions(inputOptions.options)
        .audioCodec('pcm_s16le')
        .audioFrequency(44100)
        .audioChannels(2)
        .audioFilters('aresample=async=1000:min_hard_comp=0.100000:first_pts=0')
        .on('start', (commandLine: string) => {
          console.log('FFmpeg process started:', commandLine);
        })
        .on('error', (err: Error) => {
          console.error('FFmpeg error:', err);
        })
        .on('end', () => {
          console.log('Recording finished');
        })
        .save(this.outputPath);

      return { success: true, filePath: this.outputPath };
    } catch (error) {
      console.error('Failed to start recording:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async stopRecording(): Promise<{ success: boolean; filePath?: string; error?: string }> {
    try {
      if (this.ffmpegCommand) {
        this.ffmpegCommand.kill('SIGINT');
        this.ffmpegCommand = null;
        
        // Wait a bit for the file to be written
        await new Promise(resolve => setTimeout(resolve, 500));
        
        return { success: true, filePath: this.outputPath || undefined };
      }
      return { success: false, error: 'No recording in progress' };
    } catch (error) {
      console.error('Failed to stop recording:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async getInputOptions(): Promise<{ device: string; options: string[] }> {
    const platform = process.platform;

    if (platform === 'darwin') {
      // macOS - use AVFoundation
      // For audio-only recording, use ":audio_device_index" syntax
      const defaultIndex = await this.getDefaultMicrophoneIndex();
      return {
        device: `:${defaultIndex}`,
        options: [
          '-f', 'avfoundation',
          '-thread_queue_size', '8192',
          '-probesize', '32M',
          '-analyzeduration', '10M',
          '-fflags', '+genpts+igndts',
          '-avoid_negative_ts', 'make_zero'
        ]
      };
    } else if (platform === 'win32') {
      // Windows - use DirectShow
      return {
        device: 'audio=Microphone',
        options: ['-f', 'dshow']
      };
    } else {
      // Linux - use ALSA
      return {
        device: 'default',
        options: ['-f', 'alsa']
      };
    }
  }

  getRecordingsPath(): string {
    return path.join(app.getPath('userData'), 'recordings');
  }

  async listAudioDevices(): Promise<AudioDevice[]> {
    if (process.platform !== 'darwin') {
      // For non-macOS platforms, return a default device
      return [{ index: 0, name: 'Default Microphone' }];
    }

    try {
      const { stdout } = await execAsync(`${ffmpegPath} -f avfoundation -list_devices true -i "" 2>&1`);
      const devices: AudioDevice[] = [];
      
      // Parse the output to find audio devices
      const lines = stdout.split('\n');
      let isAudioSection = false;
      
      for (const line of lines) {
        if (line.includes('AVFoundation audio devices:')) {
          isAudioSection = true;
          continue;
        }
        
        if (isAudioSection && line.includes('[') && line.includes(']')) {
          const match = line.match(/\[(\d+)\]\s+(.+)/);
          if (match) {
            devices.push({
              index: parseInt(match[1], 10),
              name: match[2].trim()
            });
          }
        }
      }
      
      return devices;
    } catch (error) {
      console.error('Error listing audio devices:', error);
      // Return default device on error
      return [{ index: 2, name: 'MacBook Pro Microphone' }];
    }
  }

  // Method to get the default microphone index (usually the built-in mic)
  async getDefaultMicrophoneIndex(): Promise<number> {
    const devices = await this.listAudioDevices();
    
    // Try to find the built-in microphone
    const builtInMic = devices.find(d => 
      d.name.toLowerCase().includes('macbook') || 
      d.name.toLowerCase().includes('built-in') ||
      d.name.toLowerCase().includes('internal')
    );
    
    if (builtInMic) {
      return builtInMic.index;
    }
    
    // If no built-in mic found, return the first available device
    return devices.length > 0 ? devices[0].index : 0;
  }
}