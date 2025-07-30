interface ElectronAPI {
  getAudioDevices: () => Promise<Array<{ id: string; label: string }>>;
  selectAudioDevice: (deviceId: string) => void;
  startRecording: (deviceId: string, title: string) => void;
  stopRecording: () => Promise<string>;
  getRecordingTime: () => Promise<number>;
  transcribeAudio: (filePath: string) => Promise<{
    status: string;
    data?: {
      transcript: string;
      summary: string;
      keyPoints: string[];
      actionItems: string[];
      title: string;
    };
    error?: string;
  }>;
  deleteRecording: (filePath: string) => Promise<void>;
  openFile: (filePath: string) => void;
  uploadToNotion: (data: any) => Promise<{ status: string; data?: any; error?: string }>;
  loadSettings: () => Promise<any>;
  saveSettings: (settings: any) => Promise<void>;
  onLog: (callback: (log: string) => void) => void;
  onDevicesChanged: (callback: (devices: Array<{ id: string; label: string }>) => void) => void;
  onFFmpegNotFound: (callback: () => void) => void;
  downloadFFmpeg: () => void;
  onFFmpegProgress: (callback: (progress: number) => void) => void;
}

interface Window {
  electronAPI: ElectronAPI;
}