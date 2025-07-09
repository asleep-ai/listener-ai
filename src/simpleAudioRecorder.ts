import { spawn, ChildProcess, exec } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { promisify } from 'util';

export class SimpleAudioRecorder {
  private recordingProcess: ChildProcess | null = null;
  private outputPath: string | null = null;

  constructor() {
    // Create recordings directory if it doesn't exist
    const recordingsDir = path.join(app.getPath('userData'), 'recordings');
    if (!fs.existsSync(recordingsDir)) {
      fs.mkdirSync(recordingsDir, { recursive: true });
    }
  }

  private async detectAudioDevice(): Promise<string> {
    try {
      const ffmpegPath = this.getFFmpegPath();
      const execAsync = promisify(exec);
      
      // FFmpeg returns exit code 1 when listing devices, but still outputs the list
      const { stdout } = await execAsync(`${ffmpegPath} -f avfoundation -list_devices true -i "" 2>&1`).catch(e => e);
      
      // Parse the output to find audio input devices
      const lines = stdout.split('\n');
      let audioDeviceIndex = '2'; // Default to MacBook Pro Microphone
      let audioDevices: Array<{index: string, name: string}> = [];
      
      let inAudioSection = false;
      for (const line of lines) {
        // Check if we're in the audio devices section
        if (line.includes('AVFoundation audio devices:')) {
          inAudioSection = true;
          continue;
        }
        
        // Parse audio devices (format: [AVFoundation indev @ 0x...] [0] Device Name)
        if (inAudioSection && line.includes('[AVFoundation indev @')) {
          const match = line.match(/\[AVFoundation indev @ [^\]]+\]\s+\[(\d+)\]\s+(.+)/);
          if (match) {
            const index = match[1];
            const name = match[2].trim();
            audioDevices.push({ index, name });
            console.log(`Found audio device: [${index}] ${name}`);
          }
        }
      }
      
      // Try to find the built-in microphone first
      const builtInMic = audioDevices.find(d => 
        d.name.toLowerCase().includes('macbook') ||
        d.name.toLowerCase().includes('built-in') ||
        d.name.toLowerCase().includes('internal')
      );
      
      if (builtInMic) {
        audioDeviceIndex = builtInMic.index;
        console.log(`Using MacBook Pro Microphone at index: ${audioDeviceIndex}`);
      } else if (audioDevices.length > 0) {
        // Skip BlackHole virtual audio device if possible
        const nonBlackHole = audioDevices.find(d => !d.name.toLowerCase().includes('blackhole'));
        audioDeviceIndex = nonBlackHole ? nonBlackHole.index : audioDevices[0].index;
        console.log(`Using audio device at index: ${audioDeviceIndex}`);
      }
      
      return `:${audioDeviceIndex}`;
    } catch (error) {
      console.error('Error detecting audio device, using MacBook Pro Microphone as default');
      return ':2'; // Default to MacBook Pro Microphone based on the output
    }
  }

  async startRecording(meetingTitle: string): Promise<{ success: boolean; filePath?: string; error?: string }> {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = `${meetingTitle.replace(/[^a-z0-9]/gi, '_')}_${timestamp}.wav`;
      this.outputPath = path.join(app.getPath('userData'), 'recordings', fileName);

      const ffmpegPath = this.getFFmpegPath();
      const audioDevice = await this.detectAudioDevice();
      
      // Optimized ffmpeg command to prevent ticking sounds
      const args = [
        '-f', 'avfoundation',
        '-thread_queue_size', '4096',  // Increase thread queue size to prevent buffer underruns
        '-i', audioDevice,
        '-acodec', 'pcm_s16le',       // Uncompressed WAV
        '-ar', '44100',               // Standard sample rate (44.1kHz)
        '-ac', '2',                   // Stereo for better quality
        '-af', 'aresample=async=1:min_hard_comp=0.100000:first_pts=0',  // Audio resampling to fix timing issues
        '-y',
        this.outputPath
      ];

      console.log('Starting recording with command:', ffmpegPath, args.join(' '));
      
      this.recordingProcess = spawn(ffmpegPath, args);

      this.recordingProcess.on('error', (error) => {
        console.error('Recording process error:', error);
      });

      this.recordingProcess.stderr?.on('data', (data) => {
        console.log('FFmpeg output:', data.toString());
      });

      this.recordingProcess.on('close', (code) => {
        console.log('Recording process closed with code:', code);
      });

      // Give it a moment to start
      await new Promise(resolve => setTimeout(resolve, 100));

      return { success: true, filePath: this.outputPath };
    } catch (error) {
      console.error('Failed to start recording:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async stopRecording(): Promise<{ success: boolean; filePath?: string; error?: string }> {
    try {
      if (this.recordingProcess) {
        // Send 'q' to gracefully stop ffmpeg
        this.recordingProcess.stdin?.write('q');
        
        // Wait for process to finish
        await new Promise<void>((resolve) => {
          this.recordingProcess?.on('close', () => {
            resolve();
          });
          
          // Fallback: force kill after 2 seconds
          setTimeout(() => {
            this.recordingProcess?.kill('SIGTERM');
            resolve();
          }, 2000);
        });
        
        this.recordingProcess = null;
        
        // Check if file exists
        if (this.outputPath && fs.existsSync(this.outputPath)) {
          const stats = fs.statSync(this.outputPath);
          console.log(`Recording saved: ${this.outputPath} (${stats.size} bytes)`);
          return { success: true, filePath: this.outputPath };
        } else {
          return { success: false, error: 'Recording file not found' };
        }
      }
      return { success: false, error: 'No recording in progress' };
    } catch (error) {
      console.error('Failed to stop recording:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private getFFmpegPath(): string {
    if (process.platform === 'darwin') {
      if (fs.existsSync('/opt/homebrew/bin/ffmpeg')) {
        return '/opt/homebrew/bin/ffmpeg';
      } else if (fs.existsSync('/usr/local/bin/ffmpeg')) {
        return '/usr/local/bin/ffmpeg';
      }
    }
    return 'ffmpeg';
  }

  getRecordingsPath(): string {
    return path.join(app.getPath('userData'), 'recordings');
  }

  // Alternative recording method using CoreAudio (macOS only) for cleaner audio
  async startRecordingCoreAudio(meetingTitle: string): Promise<{ success: boolean; filePath?: string; error?: string }> {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = `${meetingTitle.replace(/[^a-z0-9]/gi, '_')}_${timestamp}.wav`;
      this.outputPath = path.join(app.getPath('userData'), 'recordings', fileName);

      const ffmpegPath = this.getFFmpegPath();
      const audioDevice = await this.detectAudioDevice();
      
      // Use CoreAudio with optimized settings for macOS
      const args = [
        '-f', 'avfoundation',
        '-thread_queue_size', '8192',  // Very large queue to prevent drops
        '-probesize', '32M',          // Larger probe size
        '-analyzeduration', '10M',     // Longer analysis duration
        '-i', audioDevice,
        '-acodec', 'pcm_s24le',       // 24-bit for better quality
        '-ar', '48000',               // 48kHz sample rate
        '-ac', '2',                   // Stereo
        '-af', 'aresample=async=1000:min_hard_comp=0.100000:first_pts=0,highpass=f=80,lowpass=f=15000',
        '-fflags', '+genpts+igndts',
        '-avoid_negative_ts', 'make_zero',
        '-y',
        this.outputPath
      ];

      console.log('Starting CoreAudio recording with command:', ffmpegPath, args.join(' '));
      
      this.recordingProcess = spawn(ffmpegPath, args, {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.recordingProcess.on('error', (error) => {
        console.error('Recording process error:', error);
      });

      this.recordingProcess.stderr?.on('data', (data) => {
        const output = data.toString();
        // Only log errors, not progress updates
        if (output.includes('error') || output.includes('Error')) {
          console.error('FFmpeg error:', output);
        }
      });

      this.recordingProcess.on('close', (code) => {
        console.log('Recording process closed with code:', code);
      });

      await new Promise(resolve => setTimeout(resolve, 200));

      return { success: true, filePath: this.outputPath };
    } catch (error) {
      console.error('Failed to start CoreAudio recording:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}