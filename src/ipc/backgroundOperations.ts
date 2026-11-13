import { createHash } from 'crypto';
import * as path from 'path';
import { ipcMain } from 'electron';
import { BackgroundOperations } from '../backgroundOperations';
import type { IpcContext } from './types';

// Long user-requested operations that are not transcription jobs (Notion
// upload, Slack send, report regeneration from a transcript cutoff, freeing
// and restoring local audio) run in main and are tracked here, so a window
// that reloads, reopens or was closed meanwhile can see what is still running
// (`get-background-operations` + `background-operation-changed`), and a
// repeated request for the same target joins the running one instead of
// doing the work twice. Snapshots carry kinds, targets and states only, never
// results or error text.
export const backgroundOperations = new BackgroundOperations();

export type BackgroundOperationKind =
  | 'notion-upload'
  | 'slack-send'
  | 'transcript-cutoff'
  | 'local-audio-free'
  | 'local-audio-restore';

// Targets are absolute, resolved paths so two spellings of one note or
// recording name the same operation.
export function operationTarget(p: string): string {
  return path.resolve(p);
}

export function register(ctx: IpcContext): void {
  ipcMain.handle('get-background-operations', () => backgroundOperations.snapshot());
  backgroundOperations.onChange((change) => {
    const win = ctx.getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('background-operation-changed', change);
  });
}

// Join identity built from inputs that change what an operation does but must
// not appear in snapshots (a destination, an account): hashed, in memory only.
export function privateJoinKey(target: string, ...inputs: unknown[]): string {
  return JSON.stringify([
    target,
    createHash('sha256').update(JSON.stringify(inputs)).digest('hex'),
  ]);
}
