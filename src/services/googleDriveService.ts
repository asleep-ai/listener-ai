import { randomBytes } from 'crypto';

// Minimal Drive client tailored to the listener-ai sync use case:
// search/create folders + upload/update files inside folders we own.
// drive.file scope only sees files this app created, so listing is scoped
// to our own corpus automatically.

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
  parents?: string[];
};

export type GoogleDriveClientOptions = {
  getAccessToken: () => Promise<string>;
  // Optional fetch override -- tests inject a stub here. Defaults to the
  // global fetch.
  fetchImpl?: typeof fetch;
};

export class GoogleDriveError extends Error {
  status: number;
  responseBody: string;
  constructor(status: number, body: string, message: string) {
    super(message);
    this.name = 'GoogleDriveError';
    this.status = status;
    this.responseBody = body;
  }
}

export class GoogleDriveClient {
  private readonly getAccessToken: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GoogleDriveClientOptions) {
    this.getAccessToken = opts.getAccessToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.getAccessToken();
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return await this.fetchImpl(url, { ...init, headers });
  }

  private async ensureOk(res: Response, context: string): Promise<void> {
    if (res.ok) return;
    const body = await res.text();
    throw new GoogleDriveError(
      res.status,
      body,
      `${context} failed (${res.status}): ${body.slice(0, 200)}`,
    );
  }

  // Drive search query escaping: single quotes inside string literals must be
  // doubled, and backslashes escaped. Google's Drive query language follows
  // the same convention as SQL string literals here.
  private escapeQueryString(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  async findFile(params: {
    name: string;
    parentId?: string;
    mimeType?: string;
  }): Promise<DriveFile | undefined> {
    const clauses = [`name = '${this.escapeQueryString(params.name)}'`, 'trashed = false'];
    if (params.parentId) {
      clauses.push(`'${this.escapeQueryString(params.parentId)}' in parents`);
    }
    if (params.mimeType) {
      clauses.push(`mimeType = '${this.escapeQueryString(params.mimeType)}'`);
    }
    const q = clauses.join(' and ');
    const url = new URL(`${DRIVE_API_BASE}/files`);
    url.searchParams.set('q', q);
    url.searchParams.set('fields', 'files(id,name,mimeType,modifiedTime,size,parents)');
    url.searchParams.set('pageSize', '10');
    url.searchParams.set('spaces', 'drive');

    const res = await this.authedFetch(url.toString());
    await this.ensureOk(res, `Drive search "${params.name}"`);
    const json = (await res.json()) as { files?: DriveFile[] };
    return json.files?.[0];
  }

  async listFolder(folderId: string): Promise<DriveFile[]> {
    // Drive v3 caps pageSize at 100 (higher values are silently coerced down),
    // so the only way to read a folder with >100 entries is to follow
    // nextPageToken. `fields` must explicitly name `nextPageToken` -- if it
    // only requests `files(...)`, Drive omits the token and the loop exits
    // after one page even when more pages exist.
    const q = `'${this.escapeQueryString(folderId)}' in parents and trashed = false`;
    const url = new URL(`${DRIVE_API_BASE}/files`);
    url.searchParams.set('q', q);
    url.searchParams.set(
      'fields',
      'nextPageToken,files(id,name,mimeType,modifiedTime,size,parents)',
    );
    url.searchParams.set('pageSize', '100');
    url.searchParams.set('spaces', 'drive');

    const all: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const res = await this.authedFetch(url.toString());
      await this.ensureOk(res, `Drive listFolder ${folderId}`);
      const json = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string };
      if (json.files) all.push(...json.files);
      pageToken = json.nextPageToken || undefined;
    } while (pageToken);
    return all;
  }

  async ensureFolder(name: string, parentId?: string): Promise<DriveFile> {
    const existing = await this.findFile({ name, parentId, mimeType: FOLDER_MIME });
    if (existing) return existing;
    return await this.createFolder(name, parentId);
  }

  async createFolder(name: string, parentId?: string): Promise<DriveFile> {
    const metadata: Record<string, unknown> = { name, mimeType: FOLDER_MIME };
    if (parentId) metadata.parents = [parentId];

    const url = new URL(`${DRIVE_API_BASE}/files`);
    url.searchParams.set('fields', 'id,name,mimeType,modifiedTime,size,parents');

    const res = await this.authedFetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata),
    });
    await this.ensureOk(res, `Drive createFolder "${name}"`);
    return (await res.json()) as DriveFile;
  }

  async uploadFile(params: {
    name: string;
    parentId: string;
    content: Buffer | Uint8Array | string;
    mimeType: string;
  }): Promise<DriveFile> {
    // Idempotency: replace existing file with the same name in the same
    // folder. drive.file scope means we only see files we created, so a
    // name collision is always our own previous upload.
    const existing = await this.findFile({ name: params.name, parentId: params.parentId });
    if (existing) {
      return await this.updateFileContent(existing.id, params.content, params.mimeType);
    }
    return await this.createFile(params);
  }

  private async createFile(params: {
    name: string;
    parentId: string;
    content: Buffer | Uint8Array | string;
    mimeType: string;
  }): Promise<DriveFile> {
    const metadata = {
      name: params.name,
      parents: [params.parentId],
      mimeType: params.mimeType,
    };

    const { body, contentType } = buildMultipartRelated({
      metadata,
      content: params.content,
      mimeType: params.mimeType,
    });

    const url = new URL(`${DRIVE_UPLOAD_BASE}/files`);
    url.searchParams.set('uploadType', 'multipart');
    url.searchParams.set('fields', 'id,name,mimeType,modifiedTime,size,parents');

    const res = await this.authedFetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body,
    });
    await this.ensureOk(res, `Drive createFile "${params.name}"`);
    return (await res.json()) as DriveFile;
  }

  async updateFileContent(
    fileId: string,
    content: Buffer | Uint8Array | string,
    mimeType: string,
  ): Promise<DriveFile> {
    const url = new URL(`${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(fileId)}`);
    url.searchParams.set('uploadType', 'media');
    url.searchParams.set('fields', 'id,name,mimeType,modifiedTime,size,parents');

    const res = await this.authedFetch(url.toString(), {
      method: 'PATCH',
      headers: { 'Content-Type': mimeType },
      body: typeof content === 'string' ? content : (content as BodyInit),
    });
    await this.ensureOk(res, `Drive updateFileContent ${fileId}`);
    return (await res.json()) as DriveFile;
  }

  async deleteFile(fileId: string): Promise<void> {
    const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`;
    const res = await this.authedFetch(url, { method: 'DELETE' });
    if (res.status === 204) return;
    await this.ensureOk(res, `Drive deleteFile ${fileId}`);
  }

  // Soft-delete: moves the file/folder to Drive trash. Recoverable via
  // drive.google.com/trash for ~30 days (Google's default retention). Use
  // for user-facing deletions; reserve permanent deleteFile for internal
  // cleanup (e.g. GC of tombstones).
  async trashFile(fileId: string): Promise<void> {
    const url = new URL(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`);
    url.searchParams.set('fields', 'id,trashed');
    const res = await this.authedFetch(url.toString(), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    });
    await this.ensureOk(res, `Drive trashFile ${fileId}`);
  }

  // Downloads file content as a Buffer. Drive returns the raw bytes when
  // `alt=media` is set; without it the response would be the file metadata.
  async downloadFile(fileId: string): Promise<Buffer> {
    const url = new URL(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`);
    url.searchParams.set('alt', 'media');
    const res = await this.authedFetch(url.toString());
    await this.ensureOk(res, `Drive downloadFile ${fileId}`);
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}

// Drive multipart upload requires a `multipart/related` body with two parts:
// the JSON metadata and the file content, separated by a boundary.
// We construct the body as a Buffer so binary content (audio files) isn't
// corrupted by string encoding.
function buildMultipartRelated(params: {
  metadata: Record<string, unknown>;
  content: Buffer | Uint8Array | string;
  mimeType: string;
}): { body: Buffer; contentType: string } {
  const boundary = `listener-ai-${randomBytes(8).toString('hex')}`;
  const metadataPart = Buffer.from(
    `--${boundary}\r\n` +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      `${JSON.stringify(params.metadata)}\r\n`,
    'utf-8',
  );
  const contentHeader = Buffer.from(
    `--${boundary}\r\nContent-Type: ${params.mimeType}\r\n\r\n`,
    'utf-8',
  );
  const contentBody =
    typeof params.content === 'string'
      ? Buffer.from(params.content, 'utf-8')
      : Buffer.isBuffer(params.content)
        ? params.content
        : Buffer.from(params.content);
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');

  return {
    body: Buffer.concat([metadataPart, contentHeader, contentBody, closing]),
    contentType: `multipart/related; boundary=${boundary}`,
  };
}

// Top-level app folder name in the user's Drive. drive.file scope means each
// user has their own "Listener.AI" folder under their My Drive root; we don't
// collide with anyone else.
export const LISTENER_DRIVE_FOLDER_NAME = 'Listener.AI';

// Single-shot helper that mirrors a local transcription folder into Drive:
// ensures Listener.AI/<meetingFolder>/ exists, uploads all files inside, and
// returns a summary of what landed where.
export async function uploadMeetingFolder(params: {
  client: GoogleDriveClient;
  meetingFolderName: string;
  files: Array<{
    name: string;
    content: Buffer | string;
    mimeType: string;
  }>;
  appFolderName?: string;
}): Promise<{
  appFolderId: string;
  meetingFolderId: string;
  uploaded: DriveFile[];
}> {
  const appFolder = await params.client.ensureFolder(
    params.appFolderName ?? LISTENER_DRIVE_FOLDER_NAME,
  );
  const meetingFolder = await params.client.ensureFolder(params.meetingFolderName, appFolder.id);
  const uploaded: DriveFile[] = [];
  for (const file of params.files) {
    const result = await params.client.uploadFile({
      name: file.name,
      parentId: meetingFolder.id,
      content: file.content,
      mimeType: file.mimeType,
    });
    uploaded.push(result);
  }
  return { appFolderId: appFolder.id, meetingFolderId: meetingFolder.id, uploaded };
}
