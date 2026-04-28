// Shared test utilities. Conventions captured here so individual test files
// stay focused on assertions, not setup boilerplate.
//
// - All temp paths live under os.tmpdir() with a prefix that matches a test --
//   never the real getDataPath().
// - findFfmpegSync runs at module load so callers can use it in
//   `describe({ skip })`, where async detection is too late.
// - Audio fixtures are synthesized via ffmpeg's lavfi source -- no binary
//   fixtures committed to the repo.

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

export const execFileAsync = promisify(execFile);

/**
 * Locate ffmpeg synchronously by checking common install paths. Returns null
 * when not found so tests can skip gracefully.
 *
 * Sync (not async) because `describe('...', { skip: !ffmpegPath, ... })`
 * evaluates options at file-load time, before any `before()` hook runs.
 */
export function findFfmpegSync(): string | null {
  const candidates = [
    '/opt/homebrew/opt/ffmpeg@7/bin/ffmpeg',
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* continue */
    }
  }
  return null;
}

/** Derive the sibling ffprobe path from an ffmpeg path. */
export function ffprobeFor(ffmpegPath: string): string {
  return ffmpegPath.replace(/ffmpeg(\.exe)?$/, (_, ext) => `ffprobe${ext ?? ''}`);
}

/**
 * Create a unique temp directory with the given suffix prefix. Caller is
 * responsible for cleanup -- pair with `rm -rf` in `after()`.
 */
export function makeTempDir(suffix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `listener-${suffix}-test-`));
}

/** Recursively delete a directory, ignoring missing-path errors. */
export function rmDir(dir: string): void {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Synthesize a 1-second (default) opus-in-webm sine-wave file via ffmpeg's
 * lavfi source. Returns the absolute path of the created file.
 */
export async function makeOpusWebm(
  ffmpegPath: string,
  workDir: string,
  name: string,
  freq: number,
  duration = 1,
): Promise<string> {
  const out = path.join(workDir, name);
  await execFileAsync(ffmpegPath, [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${freq}:duration=${duration}:sample_rate=48000`,
    '-c:a',
    'libopus',
    '-b:a',
    '64k',
    out,
  ]);
  return out;
}

/** Same idea as makeOpusWebm but produces an mp3 -- used for mixed-format tests. */
export async function makeMp3(
  ffmpegPath: string,
  workDir: string,
  name: string,
  freq: number,
  duration = 1,
): Promise<string> {
  const out = path.join(workDir, name);
  await execFileAsync(ffmpegPath, [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${freq}:duration=${duration}`,
    '-c:a',
    'libmp3lame',
    '-b:a',
    '64k',
    out,
  ]);
  return out;
}

/** Read a media file's duration in seconds via ffprobe. */
export async function getDurationSeconds(ffprobePath: string, p: string): Promise<number> {
  const { stdout } = await execFileAsync(ffprobePath, [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    p,
  ]);
  return Number.parseFloat(stdout.trim());
}
