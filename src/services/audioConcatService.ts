import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface ConcatOptions {
  ffmpegPath: string;
  inputPaths: string[];
  outputPath: string;
}

/**
 * Concatenate audio files via ffmpeg.
 *
 * When every input shares the same extension we attempt the concat *demuxer*
 * with `-c copy` -- instant, no quality loss, and the typical Listener case
 * (two parts of an interrupted MediaRecorder session). Otherwise we fall
 * straight through to the concat *filter*, which decodes each input and
 * re-encodes the output -- slower but format-agnostic.
 *
 * The reason we don't always start with the demuxer: with mismatched codecs
 * the demuxer returns exit 0 and writes a file with corrupted timestamps
 * (observed: 1s + 1s inputs produced a 28616s output). Silent corruption is
 * worse than always-correct + slightly slower.
 */
export async function concatAudioFiles(opts: ConcatOptions): Promise<void> {
  if (opts.inputPaths.length < 2) {
    throw new Error('concatAudioFiles requires at least 2 input files');
  }

  for (const p of opts.inputPaths) {
    if (!fs.existsSync(p)) {
      throw new Error(`Input file not found: ${p}`);
    }
  }

  const firstExt = path.extname(opts.inputPaths[0]).toLowerCase();
  const allSameExt = opts.inputPaths.every((p) => path.extname(p).toLowerCase() === firstExt);

  if (allSameExt) {
    const manifestPath = path.join(
      os.tmpdir(),
      `listener-concat-${process.pid}-${randomUUID()}.txt`,
    );
    // Single quotes inside paths must be escaped as `'\''` for the concat
    // demuxer's manifest format.
    const manifest = `${opts.inputPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n')}\n`;
    await fs.promises.writeFile(manifestPath, manifest, 'utf-8');

    try {
      await execFileAsync(opts.ffmpegPath, [
        '-y',
        '-loglevel',
        'error',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        manifestPath,
        '-c',
        'copy',
        opts.outputPath,
      ]);
      return;
    } catch {
      await fs.promises.unlink(opts.outputPath).catch(() => {});
      // Fall through to the filter path below.
    } finally {
      await fs.promises.unlink(manifestPath).catch(() => {});
    }
  }

  // Concat filter: works for any combination of inputs.
  const filterArgs: string[] = ['-y', '-loglevel', 'error'];
  for (const p of opts.inputPaths) {
    filterArgs.push('-i', p);
  }
  const filterExpr = `${opts.inputPaths.map((_, i) => `[${i}:a]`).join('')}concat=n=${opts.inputPaths.length}:v=0:a=1[out]`;
  filterArgs.push(
    '-filter_complex',
    filterExpr,
    '-map',
    '[out]',
    '-c:a',
    'libopus',
    '-b:a',
    '64k',
    opts.outputPath,
  );

  try {
    await execFileAsync(opts.ffmpegPath, filterArgs);
  } catch (err) {
    const stderr = (err as { stderr?: string })?.stderr ?? '';
    const base = err instanceof Error ? err.message : String(err);
    throw new Error(stderr ? `${base.split('\n')[0]} — ${stderr.trim()}` : base);
  }
}
