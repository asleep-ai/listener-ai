import { spawn, ChildProcess, exec, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { promisify } from 'util';

// Try to import bundled ffmpeg, fallback to system ffmpeg
let ffmpegPath: string | null = null;
try {
  ffmpegPath = require('ffmpeg-static');
  console.log('Using bundled FFmpeg from:', ffmpegPath);
} catch (e) {
  console.log('Bundled FFmpeg not found, will try system FFmpeg');
  
  // In production, ffmpeg-static might be in app.asar.unpacked
  if (app.isPackaged) {
    const possiblePaths = [
      path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg'),
      path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
    ];
    
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        ffmpegPath = p;
        console.log('Found bundled FFmpeg in production at:', ffmpegPath);
        break;
      }
    }
  }
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
      // Sanitize filename while preserving Korean characters and other Unicode
      const sanitizedTitle = meetingTitle
        .replace(/[<>:"/\\|?*]/g, '_')  // Replace only truly problematic characters for filenames
        .replace(/\s+/g, '_')           // Replace spaces with underscores
        .trim();
      const fileName = `${sanitizedTitle}_${timestamp}.mp3`;
      this.outputPath = path.join(app.getPath('userData'), 'recordings', fileName);

      const ffmpegPath = this.getFFmpegPath();
      
      // Check if FFmpeg exists
      if (!fs.existsSync(ffmpegPath) && ffmpegPath !== 'ffmpeg' && ffmpegPath !== 'ffmpeg.exe') {
        throw new Error('FFmpeg not found. The bundled FFmpeg may have failed to load. Please try reinstalling the application.');
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

  private async detectWindowsAudioDevice(): Promise<string> {
    try {
      // Get ffmpeg path
      const ffmpegPath = this.getFFmpegPath();
      
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
        if (device.alternativeName) {
          // Don't add quotes around alternative names
          return `audio=${device.alternativeName}`;
        }
        return `audio="${device.name}"`;
      }
      
      // Fallback: try to use the default audio capture device without quotes
      return 'audio=@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{C15FA2FB-82F9-4D2A-9364-6512775A41AD}';
    } catch (error) {
      console.error('Error detecting Windows audio device:', error);
      // Return a generic microphone reference
      return 'audio="Microphone"';
    }
  }

  private getFFmpegPath(): string {
    // First, try to use bundled FFmpeg
    if (ffmpegPath && fs.existsSync(ffmpegPath)) {
      return ffmpegPath;
    }
    
    // Fallback to system FFmpeg
    if (process.platform === 'darwin') {
      if (fs.existsSync('/opt/homebrew/bin/ffmpeg')) {
        return '/opt/homebrew/bin/ffmpeg';
      } else if (fs.existsSync('/usr/local/bin/ffmpeg')) {
        return '/usr/local/bin/ffmpeg';
      }
    } else if (process.platform === 'win32') {
      // Common Windows ffmpeg locations
      const possiblePaths = [
        'C:\\ffmpeg\\bin\\ffmpeg.exe',
        'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
        'C:\\Program Files (x86)\\ffmpeg\\bin\\ffmpeg.exe'
      ];
      
      for (const systemPath of possiblePaths) {
        if (fs.existsSync(systemPath)) {
          return systemPath;
        }
      }
      
      // Check if ffmpeg is in PATH
      try {
        execSync('where ffmpeg', { encoding: 'utf8' });
        return 'ffmpeg.exe';
      } catch (e) {
        // ffmpeg not in PATH
      }
    }
    
    // Last resort - try bundled FFmpeg again (might be in production build)
    if (ffmpegPath) {
      return ffmpegPath;
    }
    
    // Final fallback
    return 'ffmpeg';
  }

  getRecordingsPath(): string {
    return path.join(app.getPath('userData'), 'recordings');
  }

  // Alternative recording method (platform-specific optimizations)
  async startRecordingCoreAudio(meetingTitle: string): Promise<{ success: boolean; filePath?: string; error?: string }> {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      // Sanitize filename while preserving Korean characters and other Unicode
      const sanitizedTitle = meetingTitle
        .replace(/[<>:"/\\|?*]/g, '_')  // Replace only truly problematic characters for filenames
        .replace(/\s+/g, '_')           // Replace spaces with underscores
        .trim();
      const fileName = `${sanitizedTitle}_${timestamp}.mp3`;
      this.outputPath = path.join(app.getPath('userData'), 'recordings', fileName);

      const ffmpegPath = this.getFFmpegPath();
      
      // Check if FFmpeg exists
      if (!fs.existsSync(ffmpegPath) && ffmpegPath !== 'ffmpeg' && ffmpegPath !== 'ffmpeg.exe') {
        throw new Error('FFmpeg not found. The bundled FFmpeg may have failed to load. Please try reinstalling the application.');
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
      
      // Use optimized settings for each platform
      const args = [
        '-f', inputFormat,
        '-thread_queue_size', '8192',  // Very large queue to prevent drops
        '-probesize', '32M',          // Larger probe size
        '-analyzeduration', '10M',     // Longer analysis duration
        '-i', audioDevice,
        '-acodec', 'libmp3lame',      // MP3 encoder
        '-b:a', '192k',               // Higher bitrate for better quality
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