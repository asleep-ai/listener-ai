// In-memory Drive for tests: keeps byte content and Drive-style md5
// checksums so upload/verification/restore paths run for real. Test-only;
// not part of the npm files whitelist.

import { createHash } from 'node:crypto';
import { type DriveFile, GoogleDriveError, type GoogleDriveClient } from './googleDriveService';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const md5 = (b: Buffer) => createHash('md5').update(b).digest('hex');

type Entry = DriveFile & { content?: Buffer };

export class FakeDrive {
  private seq = 0;
  files = new Map<string, Entry>();
  uploads: Array<{ name: string; parentId: string }> = [];
  trashCalls: string[] = [];
  deleteCalls: string[] = [];
  getFileHook?: (id: string) => void | Promise<void>;
  uploadHook?: (name: string) => void;
  // Simulates Drive returning a checksum that does not match what was sent.
  corruptUploadChecksum = false;
  corruptDownload = false;
  // Simulates a different Google account: nothing created earlier is visible.
  hidden = false;

  asClient(): GoogleDriveClient {
    return this as unknown as GoogleDriveClient;
  }

  private id(prefix: string) {
    return `${prefix}-${++this.seq}`;
  }

  private visible(id: string): Entry {
    const f = this.files.get(id);
    if (!f || this.hidden) throw new GoogleDriveError(404, '{}', `not found ${id}`);
    return f;
  }

  async ensureFolder(name: string, parentId?: string): Promise<DriveFile> {
    for (const f of this.files.values()) {
      if (
        f.name === name &&
        f.mimeType === FOLDER_MIME &&
        f.parents?.[0] === parentId &&
        !f.trashed
      )
        return f;
    }
    const folder: Entry = {
      id: this.id('folder'),
      name,
      mimeType: FOLDER_MIME,
      parents: parentId ? [parentId] : [],
    };
    this.files.set(folder.id, folder);
    return folder;
  }

  async listFolder(folderId: string): Promise<DriveFile[]> {
    return [...this.files.values()]
      .filter((f) => f.parents?.includes(folderId) && !f.trashed)
      .map(({ content: _c, ...meta }) => meta);
  }

  async uploadFile(params: {
    name: string;
    parentId: string;
    content: Buffer | Uint8Array | string;
    mimeType: string;
  }): Promise<DriveFile> {
    this.uploads.push({ name: params.name, parentId: params.parentId });
    this.uploadHook?.(params.name);
    const content = Buffer.from(params.content as Buffer);
    let file = [...this.files.values()].find(
      (f) => f.name === params.name && f.parents?.[0] === params.parentId && !f.trashed,
    );
    if (!file) {
      file = {
        id: this.id('file'),
        name: params.name,
        mimeType: params.mimeType,
        parents: [params.parentId],
      };
      this.files.set(file.id, file);
    }
    file.content = content;
    file.size = String(content.length);
    file.md5Checksum = this.corruptUploadChecksum ? 'deadbeef' : md5(content);
    file.modifiedTime = new Date(Date.now() + this.seq).toISOString();
    const { content: _c, ...meta } = file;
    return meta;
  }

  async getFile(id: string): Promise<DriveFile> {
    await this.getFileHook?.(id);
    const { content: _c, ...meta } = this.visible(id);
    return meta;
  }

  async downloadFile(id: string, options: { signal?: AbortSignal } = {}): Promise<Buffer> {
    options.signal?.throwIfAborted();
    const f = this.visible(id);
    const content = Buffer.from(f.content ?? Buffer.alloc(0));
    if (this.corruptDownload) content[0] ^= 0xff;
    return content;
  }

  async trashFile(id: string): Promise<void> {
    this.trashCalls.push(id);
    const f = this.files.get(id);
    if (f) f.trashed = true;
  }

  async deleteFile(id: string): Promise<void> {
    this.deleteCalls.push(id);
    this.files.delete(id);
  }

  byName(name: string): Entry[] {
    return [...this.files.values()].filter((f) => f.name === name && !f.trashed);
  }
}
