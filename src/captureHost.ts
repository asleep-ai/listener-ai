// Owned hidden capture renderer for recordings.
//
// The recording graph (getUserMedia -> Web Audio -> MediaRecorder) runs in a
// lazily created BrowserWindow that is never shown or focused, so the visible
// window can reload, hide or be destroyed without touching capture or live
// captions, which ride on the same processed audio. It loads
// dist/renderer/capture.html with the same preload as the main window and is
// destroyed again once a recording finalizes.

import { BrowserWindow, type WebContents } from 'electron';
import * as path from 'path';
import type { CaptureHostPort } from './recordingController';
import type { CaptureHostCommand } from './recordingState';

export interface CaptureHostOptions {
  preloadPath: string;
  pagePath: string;
  backgroundTestMode: boolean;
  /** The renderer died or its window went away while it existed. */
  onLost(detail: string): void;
  /** Called when the host is disposed or lost; stops macOS system-audio capture. */
  onReleased(): void;
  /** How long the page may take to load and run its script (tests shorten it). */
  readyTimeoutMs?: number;
}

// Loading a local page and running its script takes well under a second; a
// host that is not ready by then will not become ready.
export const CAPTURE_HOST_READY_TIMEOUT_MS = 20_000;

export class CaptureHostWindow implements CaptureHostPort {
  private window: BrowserWindow | null = null;
  private ready: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private readonly opts: CaptureHostOptions;

  constructor(opts: CaptureHostOptions) {
    this.opts = opts;
  }

  /** True when `contents` belongs to the current host. */
  owns(contents: WebContents): boolean {
    return !!this.window && !this.window.isDestroyed() && this.window.webContents === contents;
  }

  /** The host page finished loading its script and listens for commands. */
  markReady(contents: WebContents): void {
    if (this.owns(contents)) this.resolveReady?.();
  }

  private ensure(): Promise<void> {
    if (this.window && !this.window.isDestroyed() && this.ready) return this.ready;
    const window = new BrowserWindow({
      show: false,
      focusable: false,
      skipTaskbar: true,
      width: 320,
      height: 240,
      title: 'Listener.AI Capture',
      webPreferences: {
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
        additionalArguments: this.opts.backgroundTestMode
          ? ['--listener-background-test', '--listener-capture-host']
          : ['--listener-capture-host'],
        nodeIntegration: false,
        contextIsolation: true,
        preload: this.opts.preloadPath,
      },
    });
    this.window = window;
    this.ready = new Promise<void>((resolve, reject) => {
      // A page that loads but never runs its script (no did-fail-load) would
      // otherwise leave a start "starting" forever. Only readiness is bounded:
      // permission prompts come after the start command and are not timed.
      const timer = setTimeout(
        () => reject(new Error('Capture host did not become ready')),
        this.opts.readyTimeoutMs ?? CAPTURE_HOST_READY_TIMEOUT_MS,
      );
      this.resolveReady = () => {
        clearTimeout(timer);
        resolve();
      };
      window.webContents.once('did-fail-load', (_e, code, description) => {
        clearTimeout(timer);
        reject(new Error(`Capture host failed to load (${code}): ${description}`));
      });
      window.once('closed', () => {
        clearTimeout(timer);
        reject(new Error('Capture host closed before it was ready'));
      });
    });
    this.ready.catch(() => {});
    // The host never navigates or opens windows.
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('render-process-gone', (_event, details) => {
      this.lose(window, `Capture renderer stopped (${details.reason}).`);
    });
    window.on('closed', () => {
      this.lose(window, 'Capture window closed.');
    });
    window.loadFile(this.opts.pagePath).catch((err) => {
      console.error('Failed to load capture host:', err);
    });
    return this.ready;
  }

  private lose(window: BrowserWindow, detail: string): void {
    if (this.window !== window) return;
    this.release();
    if (!window.isDestroyed()) window.destroy();
    this.opts.onLost(detail);
  }

  private release(): void {
    this.window = null;
    this.ready = null;
    this.resolveReady = null;
    this.opts.onReleased();
  }

  /**
   * Hook between load and the first start command. Production has nothing to
   * do here; synthetic-capture tests wrap it to install fake media sources.
   */
  async prepare(): Promise<void> {}

  async start(command: {
    sessionId: number;
    deviceId: string;
    recordSystemAudio: boolean;
  }): Promise<void> {
    await this.ensure();
    await this.prepare();
    this.send({ type: 'start', ...command });
  }

  stop(sessionId: number): void {
    this.send({ type: 'stop', sessionId });
  }

  switchMic(sessionId: number, deviceId: string): void {
    this.send({ type: 'switch-mic', sessionId, deviceId });
  }

  /** Live-caption commands for the running recording (src/liveCaptureRouter.ts). */
  sendLive(
    command: Extract<CaptureHostCommand, { type: 'live-start' | 'live-stop' | 'live-translate' }>,
  ): void {
    this.send(command);
  }

  private send(command: CaptureHostCommand): void {
    const window = this.window;
    if (!window || window.isDestroyed()) throw new Error('Capture host is not running');
    window.webContents.send('capture-command', command);
  }

  /** Test and diagnostics access to the live window, if any. */
  current(): BrowserWindow | null {
    return this.window && !this.window.isDestroyed() ? this.window : null;
  }

  dispose(): void {
    const window = this.window;
    if (!window) return;
    // Bookkeeping first, so the 'closed' event of a deliberate dispose is not
    // reported as a loss.
    this.release();
    if (!window.isDestroyed()) window.destroy();
  }
}

export function defaultCapturePagePath(distDir: string): string {
  return path.join(distDir, 'renderer', 'capture.html');
}
