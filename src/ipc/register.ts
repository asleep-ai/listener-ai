import * as meetingsManagementIpc from './meetingsManagement';
import * as transcriptionIpc from './transcription';
import type { IpcContext } from './types';

// Single wiring point for every src/ipc/<domain>.ts module that has been
// split out of main.ts. main.ts builds one IpcContext, calls this once, and
// each domain registers its own ipcMain handlers against the shared context.
//
// New domain modules added in follow-up PRs append themselves here -- main.ts
// stays touched only when the context surface changes.
export function registerAllIpc(ctx: IpcContext): void {
  meetingsManagementIpc.register(ctx);
  transcriptionIpc.register(ctx);
}
