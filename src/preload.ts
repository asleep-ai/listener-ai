import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  startRecording: (meetingTitle: string) => ipcRenderer.invoke('start-recording', meetingTitle),
  stopRecording: () => ipcRenderer.invoke('stop-recording'),
  onRecordingStatus: (callback: (status: string) => void) => {
    ipcRenderer.on('recording-status', (_, status) => callback(status));
  },
  checkConfig: () => ipcRenderer.invoke('check-config'),
  saveConfig: (config: { geminiApiKey?: string; notionApiKey?: string; notionDatabaseId?: string }) => 
    ipcRenderer.invoke('save-config', config),
  getConfig: () => ipcRenderer.invoke('get-config'),
  transcribeAudio: (filePath: string) => ipcRenderer.invoke('transcribe-audio', filePath),
  uploadToNotion: (data: { title: string; transcriptionData: any; audioFilePath?: string }) => 
    ipcRenderer.invoke('upload-to-notion', data),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  getRecordings: () => ipcRenderer.invoke('get-recordings')
});