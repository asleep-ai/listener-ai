import { spawn, ChildProcess, exec, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { promisify } from 'util';
import { FFmpegManager } from './services/ffmpegManager';

// Use FFmpegManager for FFmpeg path resolution
const ffmpegManager = new FFmpegManager();

// Helper function to find FFmpeg binary (now delegates to FFmpegManager)
async function findFFmpegBinary(): Promise<string | null> {
  return await ffmpegManager.ensureFFmpeg();
}

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
      const ffmpegPath = await this.getFFmpegPath();
      if (!ffmpegPath) {
        throw new Error('FFmpeg not found');
      }
      const execAsync = promisify(exec);
      
      // FFmpeg returns exit code 1 when listing devices, but still outputs the list
      const command = `"${ffmpegPath}" -f avfoundation -list_devices true -i ""`;
      
      const { stdout, stderr } = await execAsync(`${command} 2>&1`).catch(e => {
        // FFmpeg exits with code 1 when listing devices, which is expected
        return { stdout: e.stdout || e.stderr || '', stderr: '' };
      });
      
      const output = stdout || stderr;
      
      // Parse the output to find audio input devices
      const lines = output.split('\n');
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
          // Updated regex to handle the actual output format
          const match = line.match(/\[AVFoundation indev @ [^\]]+\]\s*\[(\d+)\]\s+(.+)/);
          if (match) {
            const index = match[1];
            const name = match[2].trim();
            audioDevices.push({ index, name });
          }
        }
      }
      
      // Check if we found any audio devices
      if (audioDevices.length === 0) {
        throw new Error('No audio devices found');
      }
      
      // Try to find the built-in microphone first
      const builtInMic = audioDevices.find(d => 
        d.name.toLowerCase().includes('macbook') ||
        d.name.toLowerCase().includes('built-in') ||
        d.name.toLowerCase().includes('internal') ||
        d.name.includes('마이크') || // Korean for "microphone"
        d.name.includes('Microphone')
      );
      
      if (builtInMic) {
        audioDeviceIndex = builtInMic.index;
      } else if (audioDevices.length > 0) {
        // Skip BlackHole virtual audio device if possible
        const nonBlackHole = audioDevices.find(d => !d.name.toLowerCase().includes('blackhole'));
        audioDeviceIndex = nonBlackHole ? nonBlackHole.index : audioDevices[0].index;
      }
      
      return `:${audioDeviceIndex}`;
    } catch (error) {
      console.error('Error detecting audio device:', error);
      throw error; // Re-throw to handle in the caller
    }
  }

  async startRecording(meetingTitle: string): Promise<{ success: boolean; filePath?: string; error?: string }> {
    try {
      // Check microphone permissions on macOS
      if (process.platform === 'darwin') {
        const { systemPreferences } = require('electron');
        const microphoneAccess = systemPreferences.getMediaAccessStatus('microphone');
        
        if (microphoneAccess === 'denied') {
          return { success: false, error: 'Microphone permission denied' };
        } else if (microphoneAccess === 'not-determined') {
          // Request permission
          const granted = await systemPreferences.askForMediaAccess('microphone');
          if (!granted) {
            return { success: false, error: 'Microphone permission denied' };
          }
        }
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      // Sanitize filename while preserving Korean characters and other Unicode
      const sanitizedTitle = meetingTitle
        .replace(/[<>:"/\\|?*]/g, '_')  // Replace only truly problematic characters for filenames
        .replace(/\s+/g, '_')           // Replace spaces with underscores
        .trim();
      const fileName = `${sanitizedTitle}_${timestamp}.mp3`;
      this.outputPath = path.join(app.getPath('userData'), 'recordings', fileName);

      const ffmpegPath = await this.getFFmpegPath();
      
      // Check if FFmpeg exists
      if (!ffmpegPath) {
        return { success: false, error: 'FFmpeg not found' };
      }
      
      // Platform-specific audio input configuration
      let inputFormat: string;
      let audioDevice: string;
      
      if (process.platform === 'darwin') {
        // macOS
        inputFormat = 'avfoundation';
        audioDevice = await this.detectAudioDevice();
      } else if (process.platform === 'win32') {
        // Windows
        inputFormat = 'dshow';
        audioDevice = await this.detectWindowsAudioDevice();
      } else {
        // Linux
        inputFormat = 'alsa';
        audioDevice = 'default';
      }
      
      // Optimized ffmpeg command for MP3 output
      const args = [
        '-f', inputFormat,
        '-thread_queue_size', '16384',  // Even larger buffer for smoother processing
        '-probesize', '32M',           // Larger probe size
        '-analyzeduration', '10M',      // More time for format analysis
        '-i', audioDevice,
        '-acodec', 'libmp3lame',       // MP3 encoder
        '-b:a', '128k',                // Lower bitrate for faster encoding
        '-ar', '48000',                // Keep original sample rate
        '-ac', '1',                    // Mono (matches input)
        '-threads', '0',               // Use all available CPU threads
        '-preset', 'ultrafast',        // Fastest encoding preset
        '-af', 'volume=10.0,alimiter=limit=0.95:attack=5:release=50',  // Volume boost with limiter
        '-fflags', '+genpts+igndts',  // Better timestamp handling
        '-flags', '+low_delay',        // Reduce encoding delay
        '-y',
        this.outputPath
      ];

      console.log('Starting recording...');
      
      this.recordingProcess = spawn(ffmpegPath, args);
      
      // Track if process started successfully
      let processStarted = false;
      let startupError: string | null = null;

      this.recordingProcess.on('error', (error) => {
        console.error('Recording process error:', error);
        startupError = error.message;
        
        // Show error dialog for spawn errors (usually means FFmpeg not found)
        if (error.message.includes('ENOENT')) {
          const { dialog } = require('electron');
          dialog.showErrorBox(
            'FFmpeg Not Found',
            'FFmpeg executable could not be found or executed.\n\n' +
            'This usually means FFmpeg is not installed or not in the expected location.'
          );
        }
      });

      this.recordingProcess.stderr?.on('data', (data) => {
        const output = data.toString();
        console.log('FFmpeg output:', output);
        
        // Check for common FFmpeg errors
        if (output.includes('Permission denied')) {
          startupError = 'Microphone permission denied';
        } else if (output.includes('Device or resource busy')) {
          startupError = 'Microphone is being used by another application';
        } else if (output.includes('No such device')) {
          startupError = 'No microphone device found';
        } else if (output.includes('Unknown input format')) {
          startupError = 'Audio input format not supported';
        }
        
        // If we see FFmpeg version info, it started successfully
        if (output.includes('ffmpeg version')) {
          processStarted = true;
        }
      });

      this.recordingProcess.on('close', (code) => {
        console.log('Recording process closed with code:', code);
        if (code !== 0 && !processStarted) {
          startupError = `FFmpeg exited with code ${code}`;
        }
      });

      // Wait a bit to see if FFmpeg starts successfully
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Check if there was a startup error
      if (startupError) {
        this.recordingProcess = null;
        return { success: false, error: startupError };
      }
      
      // Check if process is still running
      if (this.recordingProcess.killed || this.recordingProcess.exitCode !== null) {
        this.recordingProcess = null;
        return { success: false, error: 'FFmpeg process terminated unexpectedly' };
      }

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

  private async detectWindowsAudioDevice(): Promise<string> {
    try {
      // Get ffmpeg path
      const ffmpegPath = await this.getFFmpegPath();
      if (!ffmpegPath) {
        throw new Error('FFmpeg not found');
      }
      
      // List DirectShow audio devices on Windows
      // Note: ffmpeg outputs device list to stderr, not stdout
      let output = '';
      try {
        // Execute ffmpeg with proper encoding for Windows
        const result = execSync(`"${ffmpegPath}" -list_devices true -f dshow -i dummy 2>&1`, {
          encoding: 'utf8',
          windowsHide: true
        });
        output = result.toString();
      } catch (e: any) {
        // ffmpeg exits with error when listing devices, but output contains the device list
        output = e.stdout || e.output?.join('') || e.toString();
      }
      
      console.log('Windows audio devices output:', output);
      
      // Parse audio devices from the output
      const lines = output.split('\n');
      let audioDevices: { name: string, alternativeName?: string }[] = [];
      let currentDevice: { name: string, alternativeName?: string } | null = null;
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        // Look for audio device lines
        // Format: [dshow @ 0x...] "Device Name" (audio)
        if (line.includes('(audio)') && line.includes('"')) {
          // Extract device name between quotes
          const nameMatch = line.match(/"([^"]+)"/);
          if (nameMatch) {
            currentDevice = { name: nameMatch[1] };
          }
        }
        
        // Look for alternative name on the next line
        // Format: [dshow @ 0x...] Alternative name "@device_cm_{...}"
        if (currentDevice && line.includes('Alternative name')) {
          const altMatch = line.match(/Alternative name\s+"([^"]+)"/);
          if (altMatch) {
            currentDevice.alternativeName = altMatch[1];
            audioDevices.push(currentDevice);
            currentDevice = null;
          } else {
            // If no alternative name found, still add the device
            audioDevices.push(currentDevice);
            currentDevice = null;
          }
        }
      }
      
      // Add the last device if it didn't have an alternative name
      if (currentDevice) {
        audioDevices.push(currentDevice);
      }
      
      console.log('Found audio devices:', audioDevices);
      
      // Check if we found any audio devices
      if (audioDevices.length === 0) {
        throw new Error('No audio devices found');
      }
      
      // Try to find a suitable microphone
      // Prefer devices with "마이크" (microphone in Korean) or "Microphone" in the name
      // Also check for corrupted Korean text patterns
      const preferredDevice = audioDevices.find(device => 
        device.name.includes('마이크') || 
        device.name.includes('留덉씠') || // Corrupted Korean for 마이크
        device.name.toLowerCase().includes('microphone') ||
        device.name.toLowerCase().includes('mic') ||
        device.name.includes('(') && device.name.includes(')') // Devices with parentheses often are mics
      );
      
      if (preferredDevice) {
        // Use alternative name if available, otherwise use the device name
        if (preferredDevice.alternativeName) {
          // Don't add quotes around alternative names - ffmpeg handles them internally
          return `audio=${preferredDevice.alternativeName}`;
        }
        // For device names with Korean or special characters, use quotes
        return `audio="${preferredDevice.name}"`;
      }
      
      // If no preferred device, use the first available audio device
      if (audioDevices.length > 0) {
        const device = audioDevices[0];
        console.log(`Using first available audio device: ${device.name}`);
        if (device.alternativeName) {
          // Don't add quotes around alternative names
          return `audio=${device.alternativeName}`;
        }
        return `audio="${device.name}"`;
      }
      
      // This should never be reached due to the check above, but just in case
      throw new Error('No suitable audio device found');
    } catch (error) {
      console.error('Error detecting Windows audio device:', error);
      // Return a generic microphone reference
      return 'audio="Microphone"';
    }
  }

  private async getFFmpegPath(): Promise<string | null> {
    const ffmpegPath = await findFFmpegBinary();
    if (!ffmpegPath) {
      console.log('WARNING: No FFmpeg found');
      return null;
    }
    return ffmpegPath;
  }

}
