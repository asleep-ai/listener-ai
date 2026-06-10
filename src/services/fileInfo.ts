import * as fs from 'fs';
import * as path from 'path';

export type FileInfoResult =
  | {
      success: true;
      exists: true;
      name: string;
      size: number;
      isFile: boolean;
    }
  | {
      success: false;
      exists: false;
      error: string;
    };

export function getFileInfo(filePath: string): FileInfoResult {
  try {
    const stats = fs.statSync(filePath);
    return {
      success: true,
      exists: true,
      name: path.basename(filePath),
      size: stats.size,
      isFile: stats.isFile(),
    };
  } catch (error) {
    return {
      success: false,
      exists: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
