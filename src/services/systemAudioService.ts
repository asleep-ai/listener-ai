// Native macOS system-audio capture via audiotee (Core Audio Tap, macOS 14.2+).
// This path uses the narrow "System Audio Recording Only" TCC permission -- the
// user sees a prompt about audio only, never Screen Recording. audiotee ships a
// Swift binary that emits raw PCM chunks over stdout; we forward those chunks
// to the renderer via IPC so they can be pushed into the Web Audio mixer.
//
// audiotee is ESM-only. We use a Function-constructed dynamic import so the
// TypeScript CommonJS emitter does not downlevel it into require().

import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

export type SystemAudioFormat = {
  sampleRate: number;
  channelCount: number;
  bytesPerSample: number;
};

export const SYSTEM_AUDIO_FORMAT: SystemAudioFormat = {
  // Match the mic chain's AudioContext rate so we don't need resampling.
  sampleRate: 48000,
  channelCount: 1,
  // Int16 (supplied sampleRate forces 16-bit PCM per audiotee's API contract).
  bytesPerSample: 2,
};

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const importESM = new Function(
  'specifier',
  'return import(specifier)'
) as <T = unknown>(specifier: string) => Promise<T>;

type AudioTeeOptions = {
  sampleRate?: number;
  chunkDurationMs?: number;
  mute?: boolean;
  includeProcesses?: number[];
  excludeProcesses?: number[];
  binaryPath?: string;
};

type AudioTeeInstance = {
  on(event: 'data', cb: (payload: { data: Buffer }) => void): AudioTeeInstance;
  on(event: 'error', cb: (err: Error) => void): AudioTeeInstance;
  on(event: 'start' | 'stop', cb: () => void): AudioTeeInstance;
  on(event: 'log', cb: (level: 'info' | 'debug', msg: unknown) => void): AudioTeeInstance;
  start(): Promise<void>;
  stop(): Promise<void>;
};

let AudioTeeCtor: (new (opts?: AudioTeeOptions) => AudioTeeInstance) | null = null;
async function loadAudioTee(): Promise<typeof AudioTeeCtor> {
  if (AudioTeeCtor) return AudioTeeCtor;
  const mod = await importESM<{ AudioTee: new (opts?: AudioTeeOptions) => AudioTeeInstance }>('audiotee');
  AudioTeeCtor = mod.AudioTee;
  return AudioTeeCtor;
}

// In packaged Electron builds the audiotee binary lives in app.asar.unpacked
// (see package.json build.asarUnpack). audiotee's auto-resolution assumes the
// dist is sitting next to node_modules/audiotee/bin, which isn't how asarUnpack
// lays things out -- pass the explicit path so it works in both dev and packaged.
function resolveBinaryPath(): string | null {
  if (app.isPackaged) {
    return path.join(
      process.resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      'audiotee',
      'bin',
      'audiotee'
    );
  }
  // Dev: resolve relative to the worktree's node_modules (which is a symlink to
  // the main checkout in our dev setup, but either way contains audiotee/bin).
  const candidates = [
    path.join(__dirname, '..', '..', 'node_modules', 'audiotee', 'bin', 'audiotee'),
    path.join(app.getAppPath(), 'node_modules', 'audiotee', 'bin', 'audiotee'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export type SystemAudioResult =
  | { ok: true }
  | { ok: false; reason: 'unsupported-platform' | 'permission-denied' | 'error'; message?: string };

export class SystemAudioService {
  private instance: AudioTeeInstance | null = null;
  private onChunk: ((chunk: Buffer) => void) | null = null;
  private onError: ((err: Error) => void) | null = null;

  isRunning(): boolean {
    return this.instance !== null;
  }

  async start(handlers: {
    onChunk: (chunk: Buffer) => void;
    onError?: (err: Error) => void;
  }): Promise<SystemAudioResult> {
    if (process.platform !== 'darwin') {
      return { ok: false, reason: 'unsupported-platform' };
    }
    if (this.instance) {
      // Already running -- rewire handlers and report success.
      this.onChunk = handlers.onChunk;
      this.onError = handlers.onError ?? null;
      return { ok: true };
    }
    const Ctor = await loadAudioTee();
    if (!Ctor) {
      return { ok: false, reason: 'error', message: 'Failed to load audiotee module' };
    }
    const binaryPath = resolveBinaryPath();
    if (!binaryPath) {
      return { ok: false, reason: 'error', message: 'audiotee binary not found in node_modules' };
    }
    this.onChunk = handlers.onChunk;
    this.onError = handlers.onError ?? null;

    const tee = new Ctor({
      sampleRate: SYSTEM_AUDIO_FORMAT.sampleRate,
      chunkDurationMs: 100,
      binaryPath,
    });
    tee.on('data', ({ data }) => {
      this.onChunk?.(data);
    });
    tee.on('error', (err) => {
      console.warn('[system-audio] audiotee error:', err);
      this.onError?.(err);
      this.instance = null;
    });

    try {
      await tee.start();
      this.instance = tee;
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // audiotee surfaces macOS TCC denial as a spawn error or immediate exit,
      // but the same error shape covers "binary crashed" or "Core Audio Tap
      // unsupported on this kernel". Default to 'error'; only flag as
      // permission-denied when the message hints at a TCC outcome.
      const looksLikePermission = /permission|tcc|not authorized|access/i.test(msg);
      return {
        ok: false,
        reason: looksLikePermission ? 'permission-denied' : 'error',
        message: msg,
      };
    }
  }

  async stop(): Promise<void> {
    const tee = this.instance;
    this.instance = null;
    this.onChunk = null;
    this.onError = null;
    if (!tee) return;
    try {
      await tee.stop();
    } catch (err) {
      console.warn('[system-audio] stop error:', err);
    }
  }
}
