import { ipcMain, dialog } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

interface FileResult {
  success: boolean;
  filePath?: string;
  error?: string;
  canceled?: boolean;
}

export class FileHandlerService {
  private recordingsDir: string;
  private readonly maxFileSize = 500 * 1024 * 1024; // 500MB

  constructor() {
    this.recordingsDir = path.join(app.getPath('userData'), 'recordings');
    this.ensureDirectoryExists();
  }

  private ensureDirectoryExists(): void {
    if (!fs.existsSync(this.recordingsDir)) {
      fs.mkdirSync(this.recordingsDir, { recursive: true });
    }
  }

  private generateUniqueFileName(originalName: string): string {
    const fileExt = path.extname(originalName);
    const fileNameWithoutExt = path.basename(originalName, fileExt);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').split('.')[0];
    return `${fileNameWithoutExt}_${timestamp}${fileExt}`;
  }

  // Register all IPC handlers
  registerHandlers(): void {
    // Save audio file from base64 (for clipboard paste and drag-drop)
    ipcMain.handle('save-audio-file-base64', async (_, fileData: { name: string; dataBase64: string }): Promise<FileResult> => {
      try {
        this.ensureDirectoryExists();
        const newFileName = this.generateUniqueFileName(fileData.name);
        const destPath = path.join(this.recordingsDir, newFileName);

        // Convert base64 back to buffer and save
        const buffer = Buffer.from(fileData.dataBase64, 'base64');
        fs.writeFileSync(destPath, buffer);

        return { success: true, filePath: destPath };
      } catch (error) {
        console.error('Error saving audio file from base64:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    });

    // Copy audio file directly from path (efficient for file dialog)
    ipcMain.handle('copy-audio-file', async (_, fileData: { sourcePath: string; name: string }): Promise<FileResult> => {
      try {
        this.ensureDirectoryExists();

        // Validate source file exists
        if (!fs.existsSync(fileData.sourcePath)) {
          throw new Error('Source file does not exist');
        }

        // Check file size
        const stats = fs.statSync(fileData.sourcePath);
        if (stats.size > this.maxFileSize) {
          throw new Error(`File too large: ${(stats.size / 1024 / 1024).toFixed(2)}MB (max: 500MB)`);
        }

        const newFileName = this.generateUniqueFileName(fileData.name);
        const destPath = path.join(this.recordingsDir, newFileName);

        // Copy file directly (much more efficient than buffer transfer)
        fs.copyFileSync(fileData.sourcePath, destPath);

        return { success: true, filePath: destPath };
      } catch (error) {
        console.error('Error copying audio file:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    });

    // Get file info for validation
    ipcMain.handle('get-file-info', async (_, filePath: string) => {
      try {
        const stats = fs.statSync(filePath);
        const name = path.basename(filePath);
        
        return {
          success: true,
          name,
          size: stats.size,
          isFile: stats.isFile()
        };
      } catch (error) {
        console.error('Error getting file info:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    });

    // Open file dialog to select audio file
    ipcMain.handle('select-audio-file', async () => {
      try {
        const result = await dialog.showOpenDialog({
          properties: ['openFile'],
          filters: [
            { name: 'Audio Files', extensions: ['mp3', 'm4a'] },
            { name: 'All Files', extensions: ['*'] }
          ]
        });
        
        if (!result.canceled && result.filePaths.length > 0) {
          const filePath = result.filePaths[0];
          return { success: true, filePath };
        }
        
        return { success: false, canceled: true };
      } catch (error) {
        console.error('Error opening file dialog:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    });

    // Keep the old handler for backward compatibility
    ipcMain.handle('save-audio-file', async (_, fileData: { name: string; data: number[] }) => {
      try {
        this.ensureDirectoryExists();
        const newFileName = this.generateUniqueFileName(fileData.name);
        const destPath = path.join(this.recordingsDir, newFileName);

        // Convert array back to buffer and save
        const buffer = Buffer.from(fileData.data);
        fs.writeFileSync(destPath, buffer);

        return { success: true, filePath: destPath };
      } catch (error) {
        console.error('Error saving audio file:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
  }
}