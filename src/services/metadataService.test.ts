import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { MetadataService } from './metadataService';
import type { RecordingLiveHintsV1 } from '../liveHintTypes';

const originalHints: RecordingLiveHintsV1 = { version: 1, recordingId: 'a.webm', sessions: [] };

async function withService(run: (service: MetadataService) => Promise<void>): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metadata-hints-'));
  const service = new MetadataService();
  (service as unknown as { _metadataDir: string })._metadataDir = directory;
  try {
    await run(service);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('same recording metadata updates preserve its hint history', async () =>
  withService(async (service) => {
    await service.saveMetadata('/recordings/a.webm', {
      liveHints: originalHints,
      summary: 'Legacy report',
    });
    await service.saveMetadata('/recordings/a.webm', { title: 'Renamed title' });
    const stored = await service.getMetadata('/recordings/a.webm');
    assert.deepEqual(stored?.liveHints, originalHints);
    assert.equal(stored?.summary, 'Legacy report');
  }));

for (const replacement of ['/other/a.webm', '/recordings/a.m4a']) {
  test(`sidecar ownership collision clears only hint history: ${replacement}`, async () =>
    withService(async (service) => {
      await service.saveMetadata('/recordings/a.webm', {
        liveHints: originalHints,
        summary: 'Legacy report',
        customFields: { existing: true },
      });
      await service.saveMetadata(replacement, { title: 'Another recording' });
      const stored = await service.getMetadata(replacement);
      assert.equal(stored?.filePath, replacement);
      assert.equal(stored?.liveHints, undefined);
      assert.equal(stored?.summary, 'Legacy report');
      assert.deepEqual(stored?.customFields, { existing: true });
    }));
}

test('an explicit newly owned history replaces a colliding sidecar history', async () =>
  withService(async (service) => {
    await service.saveMetadata('/recordings/a.webm', { liveHints: originalHints });
    const nextHints: RecordingLiveHintsV1 = {
      version: 1,
      recordingId: 'new-recording',
      sessions: [],
    };
    await service.saveMetadata('/other/a.webm', { liveHints: nextHints });
    assert.deepEqual((await service.getMetadata('/other/a.webm'))?.liveHints, nextHints);
  }));
