// Covers Drive query construction, find/create/update idempotency, multipart
// upload body shape, error propagation, and the uploadMeetingFolder helper.
// All network calls go through an injected fetch stub -- no real Drive calls.

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  GoogleDriveClient,
  GoogleDriveError,
  LISTENER_DRIVE_FOLDER_NAME,
  uploadMeetingFolder,
} from './googleDriveService';

type FetchCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Buffer;
};

class FetchStub {
  calls: FetchCall[] = [];
  private queue: Array<{ status: number; body: unknown }> = [];

  enqueue(status: number, body: unknown): this {
    this.queue.push({ status, body });
    return this;
  }

  asFetch(): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const headers: Record<string, string> = {};
      const h = new Headers(init?.headers);
      h.forEach((v, k) => {
        headers[k] = v;
      });
      const bodyRaw = init?.body;
      const body =
        bodyRaw instanceof Buffer
          ? bodyRaw
          : typeof bodyRaw === 'string'
            ? bodyRaw
            : bodyRaw instanceof Uint8Array
              ? Buffer.from(bodyRaw)
              : undefined;
      this.calls.push({ url, method: init?.method ?? 'GET', headers, body });

      const next = this.queue.shift();
      if (!next) {
        throw new Error(`FetchStub queue empty for request to ${url}`);
      }
      // 204 No Content (and similar) must have a null body per Fetch spec.
      const isBodyless = next.status === 204 || next.status === 205 || next.status === 304;
      const responseBody = isBodyless
        ? null
        : typeof next.body === 'string'
          ? next.body
          : JSON.stringify(next.body);
      return new Response(responseBody, {
        status: next.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
  }
}

let fetchStub: FetchStub;
let client: GoogleDriveClient;

beforeEach(() => {
  fetchStub = new FetchStub();
  client = new GoogleDriveClient({
    getAccessToken: async () => 'test-access-token',
    fetchImpl: fetchStub.asFetch(),
  });
});

describe('GoogleDriveClient.findFile', () => {
  it('builds a query with name, parents, mimeType and trashed=false', async () => {
    fetchStub.enqueue(200, { files: [{ id: 'f1', name: 'foo', mimeType: 'text/plain' }] });

    const result = await client.findFile({
      name: 'foo',
      parentId: 'parent-id',
      mimeType: 'text/plain',
    });

    assert.equal(result?.id, 'f1');
    const call = fetchStub.calls[0];
    const url = new URL(call.url);
    const q = url.searchParams.get('q');
    assert.match(q!, /name = 'foo'/);
    assert.match(q!, /trashed = false/);
    assert.match(q!, /'parent-id' in parents/);
    assert.match(q!, /mimeType = 'text\/plain'/);
    assert.equal(call.headers['authorization'], 'Bearer test-access-token');
  });

  it('escapes single quotes in name to avoid query injection', async () => {
    fetchStub.enqueue(200, { files: [] });

    await client.findFile({ name: "it's mine" });

    const q = new URL(fetchStub.calls[0].url).searchParams.get('q')!;
    assert.match(q, /name = 'it\\'s mine'/);
  });

  it('returns undefined when no files match', async () => {
    fetchStub.enqueue(200, { files: [] });
    const result = await client.findFile({ name: 'missing' });
    assert.equal(result, undefined);
  });
});

describe('GoogleDriveClient.listFolder', () => {
  it('concatenates results across pages following nextPageToken', async () => {
    fetchStub
      .enqueue(200, {
        nextPageToken: 'page-2',
        files: [
          { id: 'a', name: 'a.md', mimeType: 'text/markdown' },
          { id: 'b', name: 'b.md', mimeType: 'text/markdown' },
        ],
      })
      .enqueue(200, {
        nextPageToken: 'page-3',
        files: [{ id: 'c', name: 'c.md', mimeType: 'text/markdown' }],
      })
      .enqueue(200, {
        files: [{ id: 'd', name: 'd.md', mimeType: 'text/markdown' }],
      });

    const result = await client.listFolder('folder-id');

    assert.equal(
      fetchStub.calls.length,
      3,
      'should issue one request per page until token exhausted',
    );
    assert.deepEqual(
      result.map((f) => f.id),
      ['a', 'b', 'c', 'd'],
    );
    assert.equal(new URL(fetchStub.calls[0].url).searchParams.get('pageToken'), null);
    assert.equal(new URL(fetchStub.calls[1].url).searchParams.get('pageToken'), 'page-2');
    assert.equal(new URL(fetchStub.calls[2].url).searchParams.get('pageToken'), 'page-3');
  });

  it('requests nextPageToken in the fields parameter (otherwise Drive omits it)', async () => {
    fetchStub.enqueue(200, { files: [] });

    await client.listFolder('folder-id');

    const fields = new URL(fetchStub.calls[0].url).searchParams.get('fields');
    assert.ok(
      fields?.includes('nextPageToken'),
      `expected fields to include nextPageToken, got: ${fields}`,
    );
  });

  it('returns a single page result without issuing a second request', async () => {
    fetchStub.enqueue(200, {
      files: [
        { id: 'x', name: 'x.md', mimeType: 'text/markdown' },
        { id: 'y', name: 'y.md', mimeType: 'text/markdown' },
      ],
    });

    const result = await client.listFolder('folder-id');

    assert.equal(fetchStub.calls.length, 1);
    assert.equal(result.length, 2);
  });

  it('returns an empty array for an empty folder', async () => {
    fetchStub.enqueue(200, { files: [] });

    const result = await client.listFolder('empty-folder');

    assert.equal(fetchStub.calls.length, 1);
    assert.deepEqual(result, []);
  });

  it('treats empty-string nextPageToken as terminated (does not loop on it)', async () => {
    fetchStub.enqueue(200, {
      nextPageToken: '',
      files: [{ id: 'only', name: 'only.md', mimeType: 'text/markdown' }],
    });

    const result = await client.listFolder('folder-id');

    assert.equal(
      fetchStub.calls.length,
      1,
      'empty-string token must not trigger another page request',
    );
    assert.deepEqual(
      result.map((f) => f.id),
      ['only'],
    );
  });

  it('propagates an error from a non-first page and does not return partial results', async () => {
    fetchStub
      .enqueue(200, {
        nextPageToken: 'page-2',
        files: [{ id: 'a', name: 'a.md', mimeType: 'text/markdown' }],
      })
      .enqueue(500, { error: { message: 'internal' } });

    await assert.rejects(
      () => client.listFolder('folder-id'),
      (err: unknown) => {
        assert.ok(err instanceof GoogleDriveError);
        assert.equal((err as GoogleDriveError).status, 500);
        return true;
      },
    );
    assert.equal(fetchStub.calls.length, 2);
  });
});

describe('GoogleDriveClient.ensureFolder', () => {
  it('returns the existing folder when found', async () => {
    fetchStub.enqueue(200, {
      files: [
        { id: 'existing', name: 'Listener.AI', mimeType: 'application/vnd.google-apps.folder' },
      ],
    });

    const result = await client.ensureFolder('Listener.AI');

    assert.equal(result.id, 'existing');
    assert.equal(fetchStub.calls.length, 1, 'no create call when folder exists');
  });

  it('creates a new folder when not found', async () => {
    fetchStub
      .enqueue(200, { files: [] })
      .enqueue(200, { id: 'created', name: 'New', mimeType: 'application/vnd.google-apps.folder' });

    const result = await client.ensureFolder('New', 'parent-id');

    assert.equal(result.id, 'created');
    assert.equal(fetchStub.calls.length, 2);
    const createCall = fetchStub.calls[1];
    assert.equal(createCall.method, 'POST');
    const body = JSON.parse(createCall.body as string) as { name: string; parents: string[] };
    assert.equal(body.name, 'New');
    assert.deepEqual(body.parents, ['parent-id']);
  });
});

describe('GoogleDriveClient.uploadFile', () => {
  it('creates a new file with multipart body when no existing file', async () => {
    fetchStub.enqueue(200, { files: [] }).enqueue(200, {
      id: 'new-file',
      name: 'summary.md',
      mimeType: 'text/markdown',
      parents: ['folder-id'],
    });

    const result = await client.uploadFile({
      name: 'summary.md',
      parentId: 'folder-id',
      content: '# Hello',
      mimeType: 'text/markdown',
    });

    assert.equal(result.id, 'new-file');
    const uploadCall = fetchStub.calls[1];
    assert.equal(uploadCall.method, 'POST');
    assert.match(uploadCall.url, /uploadType=multipart/);
    assert.match(uploadCall.headers['content-type'], /^multipart\/related; boundary=listener-ai-/);

    const bodyStr = (uploadCall.body as Buffer).toString('utf-8');
    assert.match(bodyStr, /application\/json/);
    assert.match(bodyStr, /"name":"summary.md"/);
    assert.match(bodyStr, /"parents":\["folder-id"\]/);
    assert.match(bodyStr, /text\/markdown/);
    assert.match(bodyStr, /# Hello/);
  });

  it('updates the existing file content (idempotent) when name collision in same folder', async () => {
    fetchStub
      .enqueue(200, {
        files: [{ id: 'existing-id', name: 'summary.md', mimeType: 'text/markdown' }],
      })
      .enqueue(200, { id: 'existing-id', name: 'summary.md', mimeType: 'text/markdown' });

    const result = await client.uploadFile({
      name: 'summary.md',
      parentId: 'folder-id',
      content: 'updated body',
      mimeType: 'text/markdown',
    });

    assert.equal(result.id, 'existing-id');
    const updateCall = fetchStub.calls[1];
    assert.equal(updateCall.method, 'PATCH');
    assert.match(updateCall.url, /files\/existing-id\?uploadType=media/);
    assert.equal(updateCall.headers['content-type'], 'text/markdown');
    assert.equal((updateCall.body as Buffer).toString('utf-8'), 'updated body');
  });

  it('preserves binary content for non-text uploads', async () => {
    const audioBytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0xff]);
    fetchStub.enqueue(200, { files: [] }).enqueue(200, {
      id: 'audio-id',
      name: 'recording.webm',
      mimeType: 'audio/webm',
    });

    await client.uploadFile({
      name: 'recording.webm',
      parentId: 'folder-id',
      content: audioBytes,
      mimeType: 'audio/webm',
    });

    const uploadBody = fetchStub.calls[1].body as Buffer;
    // The exact audio bytes should appear verbatim in the multipart body.
    const offset = uploadBody.indexOf(audioBytes);
    assert.ok(offset >= 0, 'binary content should be preserved byte-for-byte in multipart body');
  });
});

describe('GoogleDriveClient.deleteFile', () => {
  it('issues DELETE and treats 204 as success', async () => {
    fetchStub.enqueue(204, '');

    await client.deleteFile('file-id');

    const call = fetchStub.calls[0];
    assert.equal(call.method, 'DELETE');
    assert.match(call.url, /files\/file-id$/);
  });
});

describe('GoogleDriveClient error handling', () => {
  it('throws GoogleDriveError with status and body on non-OK response', async () => {
    fetchStub.enqueue(403, { error: { message: 'Insufficient Permission' } });

    await assert.rejects(
      () => client.findFile({ name: 'x' }),
      (err: unknown) => {
        assert.ok(err instanceof GoogleDriveError);
        assert.equal((err as GoogleDriveError).status, 403);
        assert.match((err as GoogleDriveError).responseBody, /Insufficient Permission/);
        return true;
      },
    );
  });

  it('refreshes the bearer on every call (delegates to getAccessToken)', async () => {
    let tokenCalls = 0;
    const refreshingClient = new GoogleDriveClient({
      getAccessToken: async () => {
        tokenCalls += 1;
        return `token-${tokenCalls}`;
      },
      fetchImpl: fetchStub.asFetch(),
    });
    fetchStub.enqueue(200, { files: [] }).enqueue(200, { files: [] });

    await refreshingClient.findFile({ name: 'a' });
    await refreshingClient.findFile({ name: 'b' });

    assert.equal(tokenCalls, 2);
    assert.equal(fetchStub.calls[0].headers['authorization'], 'Bearer token-1');
    assert.equal(fetchStub.calls[1].headers['authorization'], 'Bearer token-2');
  });
});

describe('uploadMeetingFolder', () => {
  it('ensures app folder, ensures meeting subfolder, uploads each file', async () => {
    fetchStub
      // ensureFolder("Listener.AI"): findFile -> not found
      .enqueue(200, { files: [] })
      // ensureFolder("Listener.AI"): createFolder
      .enqueue(200, {
        id: 'app-folder',
        name: LISTENER_DRIVE_FOLDER_NAME,
        mimeType: 'application/vnd.google-apps.folder',
      })
      // ensureFolder("meeting-2026"): findFile -> not found
      .enqueue(200, { files: [] })
      // ensureFolder("meeting-2026"): createFolder
      .enqueue(200, {
        id: 'meeting-folder',
        name: 'meeting-2026',
        mimeType: 'application/vnd.google-apps.folder',
      })
      // uploadFile(summary.md): findFile -> not found
      .enqueue(200, { files: [] })
      // uploadFile(summary.md): createFile
      .enqueue(200, { id: 'summary-id', name: 'summary.md', mimeType: 'text/markdown' })
      // uploadFile(transcript.md): findFile -> not found
      .enqueue(200, { files: [] })
      // uploadFile(transcript.md): createFile
      .enqueue(200, { id: 'transcript-id', name: 'transcript.md', mimeType: 'text/markdown' });

    const result = await uploadMeetingFolder({
      client,
      meetingFolderName: 'meeting-2026',
      files: [
        { name: 'summary.md', content: 'summary', mimeType: 'text/markdown' },
        { name: 'transcript.md', content: 'transcript', mimeType: 'text/markdown' },
      ],
    });

    assert.equal(result.appFolderId, 'app-folder');
    assert.equal(result.meetingFolderId, 'meeting-folder');
    assert.equal(result.uploaded.length, 2);
    assert.deepEqual(
      result.uploaded.map((f) => f.id),
      ['summary-id', 'transcript-id'],
    );

    // Verify each meeting-subfolder ensure call used the app folder as parent.
    const meetingFindCall = fetchStub.calls[2];
    assert.match(meetingFindCall.url, /'app-folder'\+in\+parents|%27app-folder%27\+in\+parents/);
  });

  it('reuses existing Listener.AI folder across runs', async () => {
    fetchStub
      // ensureFolder("Listener.AI"): findFile -> found
      .enqueue(200, {
        files: [
          {
            id: 'app-existing',
            name: LISTENER_DRIVE_FOLDER_NAME,
            mimeType: 'application/vnd.google-apps.folder',
          },
        ],
      })
      // ensureFolder("meeting-x"): findFile -> found
      .enqueue(200, {
        files: [
          {
            id: 'meeting-existing',
            name: 'meeting-x',
            mimeType: 'application/vnd.google-apps.folder',
          },
        ],
      })
      // uploadFile -> existing
      .enqueue(200, {
        files: [{ id: 'summary-existing', name: 'summary.md', mimeType: 'text/markdown' }],
      })
      .enqueue(200, { id: 'summary-existing', name: 'summary.md', mimeType: 'text/markdown' });

    const result = await uploadMeetingFolder({
      client,
      meetingFolderName: 'meeting-x',
      files: [{ name: 'summary.md', content: 'body', mimeType: 'text/markdown' }],
    });

    assert.equal(result.appFolderId, 'app-existing');
    assert.equal(result.meetingFolderId, 'meeting-existing');
    assert.equal(result.uploaded[0].id, 'summary-existing');
    // Total calls: 2 finds for folders + 1 find + 1 PATCH for file = 4
    assert.equal(fetchStub.calls.length, 4);
    assert.equal(fetchStub.calls[3].method, 'PATCH');
  });
});
