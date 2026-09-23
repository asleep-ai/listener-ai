// Guards the test-process data isolation that `src/test-setup.ts` provides.
// Before it existed, geminiService.test.ts deleted NODE_ENV mid-file and every
// later test in that process appended fixture usage rows (e.g. the
// `stt-async-v6` re-route fixture) to the developer's real usage.jsonl.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { getDataPath, isTestEnvironment } from './dataPath';
import { recordUsage } from './services/usageTracker';

function assertInsideTmpdir(p: string, label: string): void {
  const rel = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(p));
  assert.ok(
    rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel),
    `${label} must live under os.tmpdir(), got ${p}`,
  );
}

function withNodeEnvDeleted<T>(fn: () => T): T {
  const prior = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prior;
  }
}

describe('test process data isolation', () => {
  it('runs every test process against a throwaway data directory', () => {
    // Fails when the suite is run without `--require ./dist/test-setup.js`.
    assert.equal(process.env.NODE_ENV, 'test');
    const isolated = process.env.LISTENER_DATA_PATH;
    assert.ok(isolated, 'LISTENER_DATA_PATH must be set by the test preload');
    assertInsideTmpdir(isolated, 'LISTENER_DATA_PATH');
    assert.equal(getDataPath(), isolated);
  });

  it('keeps getDataPath() isolated after a test deletes NODE_ENV', () => {
    const isolated = process.env.LISTENER_DATA_PATH;
    withNodeEnvDeleted(() => {
      assert.equal(isTestEnvironment(), true);
      assert.equal(getDataPath(), isolated);
    });
  });

  it('writes usage rows only inside the isolated directory, even with NODE_ENV deleted', () => {
    const isolated = process.env.LISTENER_DATA_PATH;
    assert.ok(isolated);
    const usageFile = path.join(isolated, 'usage.jsonl');
    const marker = `test-isolation-${process.pid}-${Date.now()}`;
    withNodeEnvDeleted(() => {
      // Assert before writing so a regression fails here instead of leaking
      // the marker row into the real usage log.
      assert.equal(getDataPath(), isolated);
      recordUsage({ modelId: marker, kind: 'transcription', usage: { audioSeconds: 1 } });
    });
    assertInsideTmpdir(usageFile, 'usage.jsonl');
    const rows = fs.readFileSync(usageFile, 'utf-8').trim().split('\n');
    assert.equal(JSON.parse(rows[rows.length - 1]).modelId, marker);
  });
});
