import * as fs from 'fs';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import * as path from 'path';
import { getFileInfo } from './fileInfo';
import { makeTempDir, rmDir } from '../test-helpers';

let workDir: string;

before(() => {
  workDir = makeTempDir('file-info');
});

after(() => {
  rmDir(workDir);
});

describe('getFileInfo', () => {
  it('returns the renderer contract for an existing file', () => {
    const filePath = path.join(workDir, 'meeting.m4a');
    fs.writeFileSync(filePath, 'audio');

    const info = getFileInfo(filePath);

    assert.equal(info.success, true);
    assert.equal(info.exists, true);
    assert.equal(info.name, 'meeting.m4a');
    assert.equal(info.size, 5);
    assert.equal(info.isFile, true);
  });

  it('returns exists=false for a missing file', () => {
    const info = getFileInfo(path.join(workDir, 'missing.mp3'));

    assert.equal(info.success, false);
    assert.equal(info.exists, false);
    assert.match(info.error, /ENOENT|no such file/i);
  });

  it('returns isFile=false for a directory', () => {
    const dirPath = path.join(workDir, 'a-directory');
    fs.mkdirSync(dirPath);

    const info = getFileInfo(dirPath);

    assert.equal(info.success, true);
    assert.equal(info.exists, true);
    assert.equal(info.isFile, false);
  });
});
