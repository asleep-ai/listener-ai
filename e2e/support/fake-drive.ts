import type { ElectronApplication } from 'playwright';

// TEST-ONLY in-memory Google Drive for the hidden Electron E2Es. It swaps the
// methods of the main process's own GoogleDriveClient (same module instance,
// reached through createRequire on <app path>/dist/main.js, which is the ASAR
// entry point in packaged runs; their cwd is the isolated data root, not the
// checkout) for an in-memory store with
// Drive-style md5 checksums, so sync, local audio removal and restore run
// end to end without network or credentials. Product code is unchanged.
// Always pair with uninstallFakeDrive in a finally: the main process is
// reused across cases.

export async function installFakeDrive(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule('node:module');
    const path = process.getBuiltinModule('node:path');
    const crypto = process.getBuiltinModule('node:crypto');
    const req = createRequire(path.join(app.getAppPath(), 'dist', 'main.js'));
    const { GoogleDriveClient, GoogleDriveError } = req('./services/googleDriveService.js');
    const g = globalThis as any;
    if (g.__e2eFakeDrive) throw new Error('fake Drive already installed');
    const files = new Map<string, any>();
    let seq = 0;
    const meta = (f: any) => {
      const { content: _c, ...m } = f;
      return m;
    };
    const proto = GoogleDriveClient.prototype;
    const names = [
      'ensureFolder',
      'listFolder',
      'uploadFile',
      'getFile',
      'downloadFile',
      'trashFile',
      'deleteFile',
      'findFile',
    ];
    const originals: Record<string, unknown> = {};
    for (const n of names) originals[n] = proto[n];
    const state = { files, originals, trashed: [] as string[], uploads: [] as string[] };
    g.__e2eFakeDrive = state;
    proto.ensureFolder = async (name: string, parentId?: string) => {
      for (const f of files.values()) {
        if (
          f.name === name &&
          f.mimeType === 'application/vnd.google-apps.folder' &&
          (f.parents[0] ?? null) === (parentId ?? null) &&
          !f.trashed
        )
          return meta(f);
      }
      const f = {
        id: `folder-${++seq}`,
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: parentId ? [parentId] : [],
      };
      files.set(f.id, f);
      return meta(f);
    };
    proto.findFile = async ({ name, parentId }: { name: string; parentId?: string }) =>
      [...files.values()]
        .map(meta)
        .find(
          (f: any) => f.name === name && (!parentId || f.parents.includes(parentId)) && !f.trashed,
        );
    proto.listFolder = async (id: string) =>
      [...files.values()].filter((f) => f.parents.includes(id) && !f.trashed).map(meta);
    proto.uploadFile = async ({ name, parentId, content, mimeType }: any) => {
      state.uploads.push(name);
      const buf = Buffer.from(content);
      let f = [...files.values()].find(
        (x) => x.name === name && x.parents.includes(parentId) && !x.trashed,
      );
      if (!f) {
        f = { id: `file-${++seq}`, name, mimeType, parents: [parentId] };
        files.set(f.id, f);
      }
      f.content = buf;
      f.size = String(buf.length);
      f.md5Checksum = crypto.createHash('md5').update(buf).digest('hex');
      f.modifiedTime = new Date(Date.now() + seq).toISOString();
      return meta(f);
    };
    proto.getFile = async (id: string) => {
      const f = files.get(id);
      if (!f) throw new GoogleDriveError(404, '{}', 'not found');
      return meta(f);
    };
    proto.downloadFile = async (id: string) => {
      const f = files.get(id);
      if (!f) throw new GoogleDriveError(404, '{}', 'not found');
      return Buffer.from(f.content ?? Buffer.alloc(0));
    };
    proto.trashFile = async (id: string) => {
      state.trashed.push(id);
      const f = files.get(id);
      if (f) f.trashed = true;
    };
    proto.deleteFile = async (id: string) => {
      files.delete(id);
    };
  });
}

export async function fakeDriveState(
  app: ElectronApplication,
): Promise<{ names: string[]; trashed: string[]; uploads: string[] }> {
  return app.evaluate(() => {
    const s = (globalThis as any).__e2eFakeDrive;
    return {
      names: [...s.files.values()].filter((f: any) => !f.trashed).map((f: any) => f.name),
      trashed: [...s.trashed],
      uploads: [...s.uploads],
    };
  });
}

export async function uninstallFakeDrive(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app }) => {
    const g = globalThis as any;
    const s = g.__e2eFakeDrive;
    if (!s) return;
    const { createRequire } = process.getBuiltinModule('node:module');
    const path = process.getBuiltinModule('node:path');
    const req = createRequire(path.join(app.getAppPath(), 'dist', 'main.js'));
    const proto = req('./services/googleDriveService.js').GoogleDriveClient.prototype;
    for (const [n, fn] of Object.entries(s.originals)) proto[n] = fn;
    delete g.__e2eFakeDrive;
  });
}
