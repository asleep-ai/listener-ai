// Shared shape of the `get-file-info` IPC response. Lives in its own
// dependency-free module (no `fs`/`path` imports) so the renderer type
// surface (renderer/electronAPI.d.ts) can reference it without pulling
// Node typings into the renderer typecheck graph.

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
