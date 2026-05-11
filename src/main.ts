import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import {
  BrowserWindow,
  Menu,
  app,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  session,
  shell,
  systemPreferences,
} from 'electron';
import {
  type AgentChatMessage,
  type AgentRunResult,
  type AgentScope,
  AgentService,
  type ConfigProposal,
} from './agentService';
import { extensionForMimeType, isSupportedAudioExtension } from './audioFormats';
import { type AppConfig, ConfigService } from './configService';
import { DisplayDetectorService } from './displayDetectorService';
import { GeminiService } from './geminiService';
import { MeetingDetectorService } from './meetingDetectorService';
import { MenuBarManager } from './menuBarManager';
import { NotionService } from './notionService';
import {
  formatTimestamp,
  getTranscriptionsDir,
  type LiveNote,
  readTranscription,
  sanitizeForPath,
  saveTranscription,
  updateTranscriptionStatus,
} from './outputService';
import { ALL_FIELDS, type SearchField, searchTranscriptions } from './searchService';
import { concatAudioFiles } from './services/audioConcatService';
import { autoUpdaterService } from './services/autoUpdaterService';
import { FFmpegManager } from './services/ffmpegManager';
import { FileHandlerService } from './services/fileHandlerService';
import { metadataService } from './services/metadataService';
import { notificationService } from './services/notificationService';
import { fetchAllReleases, fetchReleaseNotes } from './services/releaseNotesService';
import { SYSTEM_AUDIO_FORMAT, SystemAudioService } from './services/systemAudioService';
import { SimpleAudioRecorder } from './simpleAudioRecorder';
import { SLACK_WEBHOOK_PREFIX, SlackService, isLikelySlackWebhookUrl } from './slackService';

// Enable macOS system-audio loopback capture so getDisplayMedia({audio: 'loopback'})
// can pull Zoom/Meet participant audio alongside the mic.
//   MacSckSystemAudioLoopbackCapture  -- ScreenCaptureKit path, macOS 13-14
//   MacCatapSystemAudioLoopbackCapture -- Core Audio Tap path, macOS 14.4+ (preferred on 15+)
// Enabling both lets Chromium pick whichever implementation the kernel supports.
// Must run before app.whenReady() so Chromium sees the flags at browser init.
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch(
    'enable-features',
    'MacSckSystemAudioLoopbackCapture,MacCatapSystemAudioLoopbackCapture',
  );
}

// Global flag to track if app is quitting
declare global {
  var isQuitting: boolean | undefined;
}
global.isQuitting = false;

let mainWindow: BrowserWindow | null = null;
const audioRecorder = new SimpleAudioRecorder();
const systemAudioService = new SystemAudioService();
const configService = new ConfigService();
const ffmpegManager = new FFmpegManager();
const menuBarManager = new MenuBarManager();
const fileHandlerService = new FileHandlerService();
const meetingDetector = new MeetingDetectorService();
const displayDetector = new DisplayDetectorService();
let meetingAutoStartedRecording = false;
let geminiService: GeminiService | null = null;
let notionService: NotionService | null = null;
let slackService: SlackService | null = null;
let agentService: AgentService | null = null;

function getAgentService(): AgentService | null {
  if (agentService) return agentService;
  const apiKey = configService.getGeminiApiKey();
  if (!apiKey) return null;
  agentService = new AgentService({
    apiKey,
    dataPath: app.getPath('userData'),
    configService,
  });
  return agentService;
}

// Pending agent confirmation resolvers keyed by request id. The renderer responds
// via the 'agent-confirm-response' IPC and we resolve the promise the agent is awaiting.
// If the window goes away (reload, crash, close) before the user answers, we
// auto-reject so the awaiting agent-chat call can unwind instead of hanging.
const pendingConfirms = new Map<string, (approved: boolean) => void>();
let confirmIdCounter = 0;

function rejectAllPendingConfirms(): void {
  for (const resolver of pendingConfirms.values()) {
    try {
      resolver(false);
    } catch {
      /* ignore */
    }
  }
  pendingConfirms.clear();
}
let recordingMaxTimer: NodeJS.Timeout | null = null;
let recordingReminderTimer: NodeJS.Timeout | null = null;
let recordingAutoStopAbortTimer: NodeJS.Timeout | null = null;
// The grace timer, the renderer's stop invoke, and the crash/quit finalizers can
// all call audioRecorder.stopRecording() for the same session (recorder caches the
// result and replays it). This flag ensures the "stopped" notification fires once.
let recordingNotificationFired = false;
function fireStoppedNotificationOnce() {
  if (recordingNotificationFired) return;
  recordingNotificationFired = true;
  notificationService.notifyRecordingStopped();
}
// Tracks async finalize work (crash-path stop + remux) so before-quit can await
// it. Without this, main can exit while the async chain is still running and the
// partial file ends up without a Duration header.
let pendingFinalize: Promise<void> = Promise.resolve();
function trackFinalize(work: Promise<void>): void {
  pendingFinalize = pendingFinalize.then(() => work).catch(() => {});
}

function createGeminiService(): GeminiService | null {
  const apiKey = configService.getGeminiApiKey();
  if (!apiKey) return null;
  return new GeminiService({
    apiKey,
    knownWords: configService.getKnownWords(),
    proModel: configService.getGeminiModel(),
    flashModel: configService.getGeminiFlashModel(),
  });
}

function registerGlobalShortcut() {
  try {
    const shortcut = configService.getGlobalShortcut();

    // Check if accessibility permissions are granted on macOS
    if (process.platform === 'darwin') {
      if (!systemPreferences.isTrustedAccessibilityClient(false)) {
        console.log('Accessibility permission not granted for global shortcuts');
        // Request permission
        systemPreferences.isTrustedAccessibilityClient(true);
        return;
      }
    }

    // Unregister any existing shortcut first
    globalShortcut.unregisterAll();

    const success = globalShortcut.register(shortcut, () => {
      handleGlobalShortcutTrigger();
    });

    if (success) {
      console.log(`Global shortcut ${shortcut} registered successfully`);
    } else {
      console.error(`Failed to register global shortcut ${shortcut}`);
    }
  } catch (error) {
    console.error('Error registering global shortcut:', error);
  }
}

function handleGlobalShortcutTrigger() {
  if (!mainWindow) return;

  // Apply same logic as tray click
  if (audioRecorder.isRecording()) {
    // Stop recording
    clearRecordingTimers();
    menuBarManager.stopRecording();
  } else {
    // Start recording without bringing the window to front
    menuBarManager.startQuickRecording();
  }
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x - y;
  }
  return 0;
}

async function checkAndShowReleaseNotes() {
  if (!app.isPackaged) {
    console.log('Release notes check: skipped (not packaged, dev mode)');
    return;
  }

  const current = app.getVersion();
  const lastSeen = configService.getLastSeenVersion();
  console.log(`Release notes check: current=${current} lastSeen=${lastSeen ?? '<none>'}`);

  // First-run (fresh install): record current version silently.
  if (!lastSeen) {
    console.log('Release notes check: first-run, recording current version silently');
    configService.setLastSeenVersion(current);
    return;
  }

  // Same version or downgrade: bring lastSeen in sync but never show older notes.
  if (compareSemver(current, lastSeen) <= 0) {
    console.log('Release notes check: not newer than lastSeen, skipping modal');
    if (lastSeen !== current) configService.setLastSeenVersion(current);
    return;
  }

  // Upgrade: only mark the version as seen once we've successfully handed the
  // notes to the renderer. If the fetch fails (offline, GitHub rate limits) or
  // the window is gone, retry on the next launch so the user doesn't miss them.
  console.log(`Release notes check: upgrade detected (${lastSeen} -> ${current}), fetching notes`);
  const notes = await fetchReleaseNotes(current);
  if (!notes || !mainWindow || mainWindow.isDestroyed()) {
    console.log('Release notes check: fetch failed or window gone, will retry on next launch');
    return;
  }

  const payload = { version: current, body: notes.body, url: notes.url };
  const send = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('show-release-notes', payload);
    configService.setLastSeenVersion(current);
    console.log(`Release notes check: modal delivered for ${current}, lastSeenVersion updated`);
  };
  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once('did-finish-load', send);
  } else {
    send();
  }
}

// Watch the recordings directory for external changes (CLI runs, manual file
// ops) and push a refresh to the renderer so the list stays in sync without
// requiring a manual reload. Debounced because some operations (a merge
// concat) write through multiple events in quick succession.
let recordingsWatcher: fs.FSWatcher | null = null;
let recordingsWatcherTimer: NodeJS.Timeout | null = null;
let recordingsWatcherRetry: NodeJS.Timeout | null = null;
function startRecordingsWatcher(): void {
  if (recordingsWatcher) return;
  const dir = path.join(app.getPath('userData'), 'recordings');
  fs.mkdirSync(dir, { recursive: true });
  try {
    recordingsWatcher = fs.watch(dir, () => {
      if (recordingsWatcherTimer) clearTimeout(recordingsWatcherTimer);
      recordingsWatcherTimer = setTimeout(() => {
        recordingsWatcherTimer = null;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('recordings-changed');
        }
      }, 250);
    });
    recordingsWatcher.on('error', (err) => {
      console.warn('recordings watcher error:', err);
    });
    // fs.watch holds an inode handle. If recordings/ is deleted and recreated
    // externally, the OS fires 'close' and the watcher silently dies on the
    // dead inode. Re-arm on close so a manual rm -rf doesn't permanently break
    // live refresh.
    recordingsWatcher.on('close', () => {
      recordingsWatcher = null;
      if (global.isQuitting) return;
      if (recordingsWatcherRetry) clearTimeout(recordingsWatcherRetry);
      recordingsWatcherRetry = setTimeout(() => {
        recordingsWatcherRetry = null;
        startRecordingsWatcher();
      }, 1000);
    });
  } catch (err) {
    console.warn('Failed to start recordings watcher:', err);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 480,
    minHeight: 520,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    title: 'Listener.AI',
    icon: path.join(__dirname, '../assets/icon.png'),
  });

  // Load the Vite-built renderer entry. After tsc compilation __dirname is
  // `dist/`, so dist/renderer/index.html resolves correctly.
  const indexPath = path.join(__dirname, 'renderer', 'index.html');
  console.log('Loading index.html from:', indexPath);
  console.log('App packaged:', app.isPackaged);
  console.log('__dirname:', __dirname);

  mainWindow.loadFile(indexPath).catch((err) => {
    console.error('Failed to load index.html:', err);
    dialog.showErrorBox(
      'Loading Error',
      `Failed to load application UI: ${err.message}\n\nPath: ${indexPath}`,
    );
  });

  // Open DevTools in development or if there's an error
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }

  // Also open DevTools if page fails to load
  mainWindow.webContents.on('did-fail-load', () => {
    console.error('Page failed to load');
    mainWindow?.webContents.openDevTools();
  });

  // Handle window close events
  mainWindow.on('close', (event) => {
    // On macOS, hide the window instead of closing when Cmd+W is pressed
    // unless we're actually quitting the app
    if (process.platform === 'darwin' && !global.isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
      return false;
    }
  });

  mainWindow.on('closed', () => {
    rejectAllPendingConfirms();
    mainWindow = null;
  });

  // Reload or crash drops the renderer that would answer a confirm prompt;
  // unblock any waiting agent call so it returns cleanly instead of hanging.
  mainWindow.webContents.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) rejectAllPendingConfirms();
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    rejectAllPendingConfirms();
    // Close the recording file handle so the partial file is flushed and left on disk
    // instead of corrupted or locked open. User keeps whatever audio was streamed so far.
    if (audioRecorder.isRecording()) {
      console.warn(
        'Renderer process gone during recording; finalizing partial file:',
        details.reason,
      );
      finalizeRecordingSession();
      trackFinalize(
        (async () => {
          try {
            const r = await audioRecorder.stopRecording();
            if (r.success && r.filePath) {
              fireStoppedNotificationOnce();
              console.log(`Partial recording saved: ${r.filePath}`);
              await remuxRecordingHeader(r.filePath);
            }
          } catch (err) {
            console.error('Failed to finalize partial recording:', err);
          }
        })(),
      );
    }
  });
}

app.whenReady().then(() => {
  // Create menu with DevTools option
  const template = [
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { type: 'separator' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Developer Tools',
          accelerator: process.platform === 'darwin' ? 'Cmd+Option+I' : 'Ctrl+Shift+I',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.toggleDevTools();
            }
          },
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        {
          role: 'close',
          accelerator: 'CmdOrCtrl+W',
        },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Release Notes...',
          click: () => {
            console.log('Release notes menu: clicked, sending open-release-history');
            if (mainWindow && !mainWindow.isDestroyed()) {
              if (!mainWindow.isVisible()) mainWindow.show();
              mainWindow.webContents.send('open-release-history');
            }
          },
        },
        {
          label: autoUpdaterService.getManualUpdateLabel(),
          click: () => {
            autoUpdaterService.checkForUpdatesManually();
          },
        },
      ],
    },
  ];

  if (process.platform === 'darwin') {
    template.unshift({
      label: app.getName(),
      submenu: [
        { role: 'about' } as any,
        { type: 'separator' } as any,
        {
          label: autoUpdaterService.getManualUpdateLabel(),
          click: () => {
            autoUpdaterService.checkForUpdatesManually();
          },
        },
        { type: 'separator' } as any,
        {
          label: 'Quit Listener.AI',
          accelerator: 'Cmd+Q',
          click: () => {
            global.isQuitting = true;
            app.quit();
          },
        },
      ],
    });
  }

  const menu = Menu.buildFromTemplate(template as any);
  Menu.setApplicationMenu(menu);

  // macOS system-audio capture goes through SystemAudioService (audiotee /
  // Core Audio Tap) via dedicated IPC -- see ipcMain.handle('system-audio-start')
  // below. We only need setDisplayMediaRequestHandler for non-macOS platforms,
  // where audio: 'loopback' is genuinely supported (Windows, partial on Linux).
  if (process.platform !== 'darwin') {
    session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      const reject = () => {
        try {
          callback({});
        } catch {
          /* intentional */
        }
      };
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        if (sources.length === 0) {
          reject();
          return;
        }
        callback({ video: sources[0], audio: 'loopback' });
      } catch (err) {
        console.warn('display-media handler: getSources failed:', err);
        reject();
      }
    });
  }

  createWindow();

  // Initialize menu bar manager
  if (mainWindow) {
    menuBarManager.init(mainWindow, audioRecorder);
    // Set main window for auto-updater and notifications
    autoUpdaterService.setMainWindow(mainWindow);
    notificationService.setMainWindow(mainWindow);
  }

  startRecordingsWatcher();

  // Kick off initial + periodic update checks once the renderer can receive IPC.
  autoUpdaterService.checkForUpdates();
  autoUpdaterService.startPeriodicCheck();

  // Show release notes on first launch after an update.
  checkAndShowReleaseNotes().catch((err) => {
    console.error('Release notes check failed:', err);
  });

  // Register global shortcut
  registerGlobalShortcut();

  // Initialize meeting detector
  if (configService.getMeetingDetection()) {
    meetingDetector.start();
  }

  meetingDetector.on('meeting-started', (info: { app: string; detectedAt: Date }) => {
    notificationService.notifyMeetingDetected(info.app);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('meeting-status-changed', { active: true, app: info.app });

      // Auto-start recording if not already recording
      if (!audioRecorder.isRecording()) {
        meetingAutoStartedRecording = true;
        mainWindow.webContents.send('tray-start-recording');
      }
    }
  });

  meetingDetector.on('meeting-ended', (info: { app: string; duration: number }) => {
    notificationService.notifyMeetingEnded(info.app);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('meeting-status-changed', { active: false, app: info.app });

      // Only stop recording if we auto-started it (don't interrupt manual recordings)
      if (meetingAutoStartedRecording && audioRecorder.isRecording()) {
        meetingAutoStartedRecording = false;
        clearRecordingTimers();
        mainWindow.webContents.send('tray-stop-recording');
      }
    }
  });

  // Initialize display detector
  if (configService.getDisplayDetection()) {
    displayDetector.start();
  }

  displayDetector.on('display-connected', () => {
    if (mainWindow && !mainWindow.isDestroyed() && !audioRecorder.isRecording()) {
      notificationService.notifyDisplayDetected(() => {
        // User clicked/allowed -- start recording silently
        if (!audioRecorder.isRecording() && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('tray-start-recording');
        }
      });
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      if (mainWindow) {
        autoUpdaterService.setMainWindow(mainWindow);
        notificationService.setMainWindow(mainWindow);
      }
    }
  });
});

app.on('window-all-closed', () => {
  // Don't quit the app when all windows are closed
  // The app should continue running in the system tray
  if (process.platform === 'darwin') {
    // On macOS, keep the app running (standard behavior)
  }
  // On other platforms, the app continues running in tray
});

// Handle app quit
app.on('before-quit', async (event) => {
  meetingDetector.stop();
  displayDetector.stop();
  autoUpdaterService.stopPeriodicCheck();
  global.isQuitting = true;

  // Flush and close any open recording handle so the partial file survives the quit.
  if (audioRecorder.isRecording()) {
    event.preventDefault();
    console.warn('Quit requested during recording; finalizing partial file before exit');
    finalizeRecordingSession();
    try {
      const r = await audioRecorder.stopRecording();
      if (r.success && r.filePath) {
        console.log(`Partial recording saved on quit: ${r.filePath}`);
        await remuxRecordingHeader(r.filePath);
      }
    } catch (err) {
      console.error('Failed to finalize recording on quit:', err);
    }
    app.quit();
    return;
  }

  // Wait for any async finalize started by render-process-gone to complete so
  // the remux isn't killed mid-spawn when the app exits.
  try {
    await Promise.race([
      pendingFinalize,
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]);
  } catch {
    // swallow — we're quitting
  }
});

// Unregister all shortcuts when app quits
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (recordingsWatcher) {
    recordingsWatcher.close();
    recordingsWatcher = null;
  }
  if (recordingsWatcherTimer) {
    clearTimeout(recordingsWatcherTimer);
    recordingsWatcherTimer = null;
  }
  if (recordingsWatcherRetry) {
    clearTimeout(recordingsWatcherRetry);
    recordingsWatcherRetry = null;
  }
});

// Helper function to rename audio file with generated title
async function renameAudioFile(oldPath: string, suggestedTitle: string): Promise<string> {
  try {
    const dir = path.dirname(oldPath);
    const ext = path.extname(oldPath);
    const oldFileName = path.basename(oldPath, ext);

    // Extract timestamp from old filename (format: Untitled_Meeting_2025-07-10T01-34-07-679Z)
    const timestampMatch = oldFileName.match(/_(\d{4}-\d{2}-\d{2}T[\d-]+Z)$/);
    const timestamp = timestampMatch
      ? timestampMatch[1]
      : new Date().toISOString().replace(/[:.]/g, '-');

    // Sanitize the suggested title
    const sanitizedTitle = suggestedTitle
      .replace(/[<>:"/\\|?*]/g, '_') // Replace problematic characters
      .replace(/\s+/g, '_') // Replace spaces with underscores
      .trim();

    const newFileName = `${sanitizedTitle}_${timestamp}${ext}`;
    const newPath = path.join(dir, newFileName);

    // Rename the file
    await fs.promises.rename(oldPath, newPath);
    console.log(`Renamed file from ${oldFileName} to ${newFileName}`);

    return newPath;
  } catch (error) {
    console.error('Error renaming file:', error);
    return oldPath; // Return original path if rename fails
  }
}

function clearRecordingTimers() {
  if (recordingMaxTimer) {
    clearTimeout(recordingMaxTimer);
    recordingMaxTimer = null;
  }
  if (recordingReminderTimer) {
    clearInterval(recordingReminderTimer);
    recordingReminderTimer = null;
  }
  if (recordingAutoStopAbortTimer) {
    clearTimeout(recordingAutoStopAbortTimer);
    recordingAutoStopAbortTimer = null;
  }
}

// Shared session teardown for stop, abort, crash, and quit paths.
function finalizeRecordingSession() {
  clearRecordingTimers();
  menuBarManager.updateRecordingState(false);
  meetingAutoStartedRecording = false;
}

// IPC handlers for recording functionality
// FFmpeg handlers
ipcMain.handle('check-ffmpeg', async () => {
  const ffmpegPath = await ffmpegManager.ensureFFmpeg();
  return { available: !!ffmpegPath, path: ffmpegPath };
});

ipcMain.handle('download-ffmpeg', async () => {
  try {
    const ffmpegPath = await ffmpegManager.downloadFFmpeg((progress) => {
      if (mainWindow) {
        mainWindow.webContents.send('ffmpeg-download-progress', progress);
      }
    });
    return { success: true, path: ffmpegPath };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle('cancel-ffmpeg-download', async () => {
  ffmpegManager.cancelDownload();
  return { success: true };
});

const execFileAsync = promisify(execFile);

// Returns `code: 'ffmpeg-missing'` so the renderer can route users into the
// existing ffmpeg-download UI (triggered by transcription) rather than
// duplicating that flow here.
ipcMain.handle('export-recording-m4a', async (_, srcPath: string) => {
  try {
    if (!srcPath || typeof srcPath !== 'string') {
      return { success: false, error: 'Invalid source path' };
    }
    // Containment: the renderer is trusted today, but bound srcPath to the
    // recordings directory so a future renderer bug can't transcode arbitrary
    // local files. realpath resolves symlinks before the prefix check.
    const recordingsDir = path.join(app.getPath('userData'), 'recordings');
    let resolvedSrc: string;
    try {
      resolvedSrc = await fs.promises.realpath(srcPath);
    } catch {
      return { success: false, error: 'Source recording not found' };
    }
    const resolvedRoot = await fs.promises.realpath(recordingsDir).catch(() => recordingsDir);
    if (!resolvedSrc.startsWith(resolvedRoot + path.sep)) {
      return { success: false, error: 'Source path is outside the recordings directory' };
    }

    const ffmpegPath = await ffmpegManager.ensureFFmpeg();
    if (!ffmpegPath) {
      return {
        success: false,
        code: 'ffmpeg-missing',
        error: 'FFmpeg is required for M4A export.',
      };
    }

    const baseName = path.basename(resolvedSrc, path.extname(resolvedSrc));
    const dialogOptions = {
      title: 'Export recording as M4A',
      defaultPath: `${baseName}.m4a`,
      filters: [{ name: 'M4A Audio', extensions: ['m4a'] }],
    };
    const saveResult = mainWindow
      ? await dialog.showSaveDialog(mainWindow, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions);
    if (saveResult.canceled || !saveResult.filePath) {
      return { canceled: true };
    }
    const destPath = saveResult.filePath;
    // Write to a sibling temp file and atomically rename on success so a
    // failed encode never overwrites the user's picked path with a partial.
    const tmpPath = `${destPath}.partial`;

    try {
      // Force -f ipod (M4A muxer) because the `.partial` extension defeats
      // ffmpeg's format-by-extension detection otherwise.
      await execFileAsync(ffmpegPath, [
        '-y',
        '-loglevel',
        'error',
        '-i',
        resolvedSrc,
        '-vn',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        '-f',
        'ipod',
        tmpPath,
      ]);
      await fs.promises.rename(tmpPath, destPath);
    } catch (encodeError) {
      await fs.promises.unlink(tmpPath).catch(() => {});
      throw encodeError;
    }

    return { success: true, path: destPath };
  } catch (error) {
    console.error('Error exporting M4A:', error);
    // execFileAsync rejections carry stderr on the error object — surface it
    // so renderer-side toasts aren't reduced to "Command failed".
    const stderr = (error as { stderr?: string } | null)?.stderr;
    const baseMessage = error instanceof Error ? error.message : String(error);
    const message = stderr ? `${baseMessage.split('\n')[0]} — ${stderr.trim()}` : baseMessage;
    return { success: false, error: message };
  }
});

// Merge multiple recordings: concat audio files, then run the standard
// transcription pipeline on the merged file. Originals are left untouched.
// Resolves source folder names from per-recording metadata so the merged note's
// `mergedFrom` frontmatter (and "Sources" body section) can reference them.
//
// Single-flight: a second click while a merge is running returns
// `{ code: 'merge-busy' }` rather than racing against the in-flight one for
// the shared geminiService and the merged-output filename slot.
let mergeInFlight = false;
ipcMain.handle('merge-recordings', async (_, opts: { paths: string[]; title?: string }) => {
  if (mergeInFlight) {
    return {
      success: false,
      code: 'merge-busy',
      error: 'Another merge is already running. Wait for it to finish.',
    };
  }
  mergeInFlight = true;
  const sendProgress = (percent: number, message: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('transcription-progress', { percent, message });
    }
  };
  try {
    const inputPaths = Array.isArray(opts?.paths) ? opts.paths : [];
    if (inputPaths.length < 2) {
      return { success: false, error: 'At least 2 recordings are required to merge' };
    }

    // Ensure recordings dir exists before realpath so symlink resolution can't
    // throw on a fresh install. Containment: every input must then resolve
    // inside that directory.
    const recordingsDir = path.join(app.getPath('userData'), 'recordings');
    await fs.promises.mkdir(recordingsDir, { recursive: true });
    const resolvedRoot = await fs.promises.realpath(recordingsDir);
    const resolvedInputs: string[] = [];
    for (const p of inputPaths) {
      if (typeof p !== 'string' || !p) {
        return { success: false, error: 'Invalid input path' };
      }
      let resolved: string;
      try {
        resolved = await fs.promises.realpath(p);
      } catch {
        return { success: false, error: `Recording not found: ${path.basename(p)}` };
      }
      if (!resolved.startsWith(resolvedRoot + path.sep)) {
        return { success: false, error: 'Source path is outside the recordings directory' };
      }
      resolvedInputs.push(resolved);
    }

    if (!geminiService) {
      const apiKey = configService.getGeminiApiKey();
      if (!apiKey) {
        return { success: false, error: 'Gemini API key not configured' };
      }
      geminiService = createGeminiService()!;
    }

    const ffmpegPath = await ffmpegManager.ensureFFmpeg();
    if (!ffmpegPath) {
      return {
        success: false,
        code: 'ffmpeg-missing',
        error: 'FFmpeg is required to merge recordings.',
      };
    }

    const rawTitle = opts.title?.trim() || 'Merged Meeting';
    const safeTitle = sanitizeForPath(rawTitle) || 'Merged Meeting';
    // Always emit webm/opus -- matches MediaRecorder native output and survives
    // the stream-copy fast path when all inputs are also webm. UUID suffix
    // avoids collisions when two merges with the same title start in the same
    // second (formatTimestamp is second-granularity).
    const mergedExt = extensionForMimeType('audio/webm');
    const mergedAudioPath = path.join(
      recordingsDir,
      `${safeTitle}_${formatTimestamp()}_${randomUUID().slice(0, 8)}.${mergedExt}`,
    );

    sendProgress(5, 'Merging audio files...');

    // Run the metadata lookup concurrently with the ffmpeg concat -- they're
    // independent and concat is the long pole, so the metadata reads are free.
    // Recordings without a transcription contribute nothing to mergedFrom; we
    // also drop entries whose transcription folder no longer exists on disk
    // so the merged note's Sources section never references stale ghosts.
    const [, metas] = await Promise.all([
      concatAudioFiles({ ffmpegPath, inputPaths: resolvedInputs, outputPath: mergedAudioPath }),
      Promise.all(resolvedInputs.map((p) => metadataService.getMetadata(p))),
    ]);
    const sourceFolders = metas
      .filter((m): m is NonNullable<typeof m> => !!m?.transcriptionPath)
      .filter((m) => fs.existsSync(m.transcriptionPath!))
      .map((m) => path.basename(m.transcriptionPath!));

    sendProgress(15, 'Transcribing merged recording...');

    // Compress the transcription progress into 15-95% to leave room for the
    // concat phase at the start and the save phase at the end.
    const progressCallback = (percent: number, message: string) => {
      sendProgress(15 + Math.round(percent * 0.8), message);
    };

    const summaryPrompt = configService.getSummaryPrompt();
    const result = await geminiService.transcribeAudio(
      mergedAudioPath,
      progressCallback,
      summaryPrompt,
    );

    // User-supplied title takes precedence; only fall back to Gemini's
    // suggestion when the user didn't provide one. Gemini almost always
    // returns a suggestedTitle, so the previous order silently overrode the
    // user's --title flag / dialog input.
    const finalTitle = opts.title?.trim() || result.suggestedTitle || rawTitle;
    let transcriptionPath: string;
    try {
      transcriptionPath = saveTranscription({
        title: finalTitle,
        result,
        audioFilePath: mergedAudioPath,
        dataPath: app.getPath('userData'),
        mergedFrom: sourceFolders,
      });
    } catch (error) {
      console.error('Failed to save merged transcription files:', error);
      const message = error instanceof Error ? error.message : String(error);
      notificationService.notifyTranscriptionFailed(
        'Merge failed: could not save the transcription.',
      );
      return { success: false, error: `Failed to save merged transcription: ${message}` };
    }

    try {
      await metadataService.saveMetadata(mergedAudioPath, {
        title: finalTitle,
        suggestedTitle: result.suggestedTitle,
        transcriptionPath,
        customFields: result.customFields,
        transcribedAt: new Date().toISOString(),
      });
    } catch (error) {
      // Metadata write is best-effort -- the transcription folder is the
      // source of truth. Log and continue rather than fail the merge.
      console.error('Failed to save merged metadata:', error);
    }

    sendProgress(100, 'Merge complete');

    notificationService.notifyTranscriptionComplete(finalTitle);
    return {
      success: true,
      data: result,
      mergedAudioPath,
      transcriptionPath,
      mergedFrom: sourceFolders,
    };
  } catch (error) {
    console.error('Error merging recordings:', error);
    const stderr = (error as { stderr?: string } | null)?.stderr;
    const baseMessage = error instanceof Error ? error.message : String(error);
    const message = stderr ? `${baseMessage.split('\n')[0]} — ${stderr.trim()}` : baseMessage;
    notificationService.notifyTranscriptionFailed('Merge failed. Check the app for details.');
    return { success: false, error: message };
  } finally {
    mergeInFlight = false;
  }
});

// Audio capture runs in the renderer via MediaRecorder; chunks stream over IPC as
// they're encoded so the renderer never accumulates hours of audio in memory. Main
// opens a FileHandle on start, appends each chunk on arrival, and closes on stop.
// A renderer crash mid-session leaves a truncated-but-valid WebM/Opus file on disk.
ipcMain.handle('start-recording', async (_, payload: { title: string; mimeType: string }) => {
  try {
    const meetingTitle = payload?.title ?? 'Untitled_Meeting';
    const mimeType = payload?.mimeType ?? 'audio/webm';
    const result = await audioRecorder.startRecording(meetingTitle, mimeType);
    if (!result.success) return result;

    recordingNotificationFired = false;
    menuBarManager.updateRecordingState(true, meetingTitle);

    const maxMinutes = configService.getMaxRecordingMinutes();
    if (maxMinutes > 0) {
      recordingMaxTimer = setTimeout(
        () => {
          if (!audioRecorder.isRecording()) return;
          notificationService.notifyRecordingAutoStopped(maxMinutes);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('recording-auto-stopped', {
              reason: 'maxDuration',
              maxMinutes,
            });
          }
          // Grace window: if the renderer is hung and never calls stop-recording,
          // force-finalize so main state unblocks and the partial file is saved.
          recordingAutoStopAbortTimer = setTimeout(() => {
            recordingAutoStopAbortTimer = null;
            if (!audioRecorder.isRecording()) return;
            console.warn('Renderer did not stop after auto-stop signal; finalizing partial file');
            finalizeRecordingSession();
            audioRecorder
              .stopRecording()
              .then((r) => {
                if (r.success) fireStoppedNotificationOnce();
              })
              .catch((err) => console.error('Force-stop failed:', err));
          }, 10_000);
        },
        maxMinutes * 60 * 1000,
      );
    }

    const reminderMinutes = configService.getRecordingReminderMinutes();
    if (reminderMinutes > 0) {
      let elapsed = 0;
      recordingReminderTimer = setInterval(
        () => {
          elapsed += reminderMinutes;
          if (audioRecorder.isRecording()) {
            notificationService.notifyRecordingReminder(elapsed);
          }
        },
        reminderMinutes * 60 * 1000,
      );
    }

    return result;
  } catch (error) {
    console.error('Error starting recording:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMessage };
  }
});

// Fire-and-forget chunk append. IPC preserves order per channel, so sequential
// appendChunk calls land on disk in the order MediaRecorder emitted them.
ipcMain.on('recording-chunk', (_event, data: ArrayBuffer | Uint8Array) => {
  if (!data) return;
  try {
    audioRecorder.appendChunk(Buffer.from(data as ArrayBuffer));
  } catch (error) {
    console.error('Invalid chunk payload:', error);
  }
});

ipcMain.handle('stop-recording', async (_, opts?: { liveNotes?: unknown }) => {
  try {
    finalizeRecordingSession();
    const result = await audioRecorder.stopRecording();
    if (result.success) {
      fireStoppedNotificationOnce();
      if (result.filePath) {
        // MediaRecorder writes no Duration element to the WebM header, so players
        // like Chrome/QuickTime show "0:00" until they scan the whole file. An
        // ffmpeg `-c copy` remux adds Duration + Cues in ~1s without re-encoding.
        // Silently skip if ffmpeg isn't available — file still plays, transcription
        // pipeline is unaffected.
        await remuxRecordingHeader(result.filePath);

        // Persist live notes alongside the audio so they survive even if the
        // user transcribes later (auto-mode off). transcribe-audio falls back
        // to this when its own arg is missing.
        const liveNotes = sanitizeLiveNotes(opts?.liveNotes);
        if (liveNotes && liveNotes.length > 0) {
          try {
            await metadataService.saveMetadata(result.filePath, { liveNotes });
          } catch (err) {
            console.error('Failed to persist live notes to metadata:', err);
          }
        }
      }
    }
    return result;
  } catch (error) {
    console.error('Error stopping recording:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

async function remuxRecordingHeader(filePath: string): Promise<void> {
  try {
    const ffmpegPath = await ffmpegManager.ensureFFmpeg();
    if (!ffmpegPath) return;
    const dir = path.dirname(filePath);
    const tmpPath = path.join(dir, `.remux-${path.basename(filePath)}`);
    const { spawn } = await import('child_process');
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegPath, ['-y', '-i', filePath, '-c', 'copy', tmpPath], {
        stdio: 'ignore',
      });
      proc.on('error', reject);
      proc.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)),
      );
    });
    await fs.promises.rename(tmpPath, filePath);
  } catch (error) {
    console.warn('Header remux skipped:', error instanceof Error ? error.message : error);
  }
}

// Explicit cancel path: discard the in-progress file (used when renderer fails to
// construct MediaRecorder after main already opened the stream).
ipcMain.handle('abort-recording', async () => {
  try {
    finalizeRecordingSession();
    await audioRecorder.abortRecording();
    return { success: true };
  } catch (error) {
    console.error('Error aborting recording:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

// Configuration handlers

// Apply runtime side effects for changed config keys (shortcut re-registration,
// detector on/off, service re-creation). Called from both the GUI save-config
// IPC and the agent-chat flow when set_config mutations land.
function applyConfigSideEffects(changed: Partial<AppConfig>): void {
  if (
    changed.knownWords !== undefined ||
    changed.geminiApiKey !== undefined ||
    changed.geminiModel !== undefined ||
    changed.geminiFlashModel !== undefined
  ) {
    geminiService = createGeminiService();
    agentService = null;
  }
  if (changed.globalShortcut !== undefined) {
    registerGlobalShortcut();
  }
  if (changed.meetingDetection !== undefined) {
    meetingDetector.setEnabled(changed.meetingDetection);
  }
  if (changed.displayDetection !== undefined) {
    displayDetector.setEnabled(changed.displayDetection);
  }
  if (changed.notionApiKey !== undefined || changed.notionDatabaseId !== undefined) {
    const apiKey = configService.getNotionApiKey();
    const databaseId = configService.getNotionDatabaseId();
    if (apiKey && databaseId) {
      notionService = new NotionService({ apiKey, databaseId });
    }
  }
  if (changed.slackWebhookUrl !== undefined) {
    slackService = null; // re-init lazily on next send
  }
}

function getSlackService(): SlackService | null {
  if (slackService) return slackService;
  const url = configService.getSlackWebhookUrl();
  if (!url || !isLikelySlackWebhookUrl(url)) return null;
  slackService = new SlackService({ webhookUrl: url });
  return slackService;
}

// Defense in depth: a renderer-supplied transcriptionPath could otherwise be
// any path on disk and let an XSS-compromised renderer overwrite arbitrary
// summary.md files via updateTranscriptionStatus.
function isContainedTranscriptionPath(folderPath: string | undefined): folderPath is string {
  if (!folderPath) return false;
  const root = getTranscriptionsDir(app.getPath('userData'));
  const resolved = path.resolve(folderPath);
  return resolved === root || resolved.startsWith(root + path.sep);
}

// Validate + normalize the renderer's live-notes payload before it touches disk.
// Renderer state is untrusted (compromised content scripts, future agent flows)
// so this enforces shape + caps text length to keep summary.md/Notion sane.
const LIVE_NOTE_MAX_TEXT = 2000;
const LIVE_NOTE_MAX_COUNT = 500;
function sanitizeLiveNotes(raw: unknown): LiveNote[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: LiveNote[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const offsetMs = Number((item as { offsetMs?: unknown }).offsetMs);
    const text = (item as { text?: unknown }).text;
    if (!Number.isFinite(offsetMs)) continue;
    out.push({
      offsetMs: Math.max(0, Math.floor(offsetMs)),
      text: typeof text === 'string' ? text.slice(0, LIVE_NOTE_MAX_TEXT) : '',
    });
    if (out.length >= LIVE_NOTE_MAX_COUNT) break;
  }
  return out.length > 0 ? out : undefined;
}

// Tell the renderer the config has changed out-of-band so it can re-read and
// re-render its UI state (toggle checkboxes etc.). Used by the agent flow.
function broadcastConfigChanged(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('config-changed', configService.getAllConfig());
  }
}

ipcMain.handle('save-config', async (_, config: Partial<AppConfig>) => {
  try {
    configService.updateConfig(config);
    applyConfigSideEffects(config);

    return {
      success: true,
      configPath: app.getPath('userData'),
    };
  } catch (error) {
    console.error('Error saving config:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('get-config', async () => {
  return configService.getAllConfig();
});

ipcMain.handle('get-all-releases', async () => {
  console.log('Release list IPC: get-all-releases invoked');
  const results = await fetchAllReleases();
  console.log(`Release list IPC: fetched ${results.length} releases`);
  return results;
});

ipcMain.handle('update:get-state', async () => {
  return autoUpdaterService.getUpdateState();
});

ipcMain.handle('update:download', async () => {
  autoUpdaterService.downloadUpdate();
});

ipcMain.handle('update:install', async () => {
  autoUpdaterService.quitAndInstall();
});

// Dev-only: drive the badge state machine manually from DevTools.
ipcMain.handle('update:simulate', async (_, event: string, data?: any) => {
  autoUpdaterService.simulateUpdateEvent(event, data);
});

ipcMain.handle('check-config', async () => {
  return {
    hasConfig: configService.hasRequiredConfig(),
    missing: configService.getMissingConfigs(),
  };
});

// Global shortcut handlers
ipcMain.handle('validate-shortcut', async (_, shortcut: string) => {
  try {
    // Temporarily register the shortcut to check if it's valid
    const isValid = globalShortcut.register(shortcut, () => {});
    if (isValid) {
      globalShortcut.unregister(shortcut);
    }
    // Re-register the current shortcut
    registerGlobalShortcut();
    return { valid: isValid };
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : 'Invalid shortcut' };
  }
});

ipcMain.handle('get-meeting-status', async () => {
  const meeting = meetingDetector.getActiveMeeting();
  return {
    enabled: configService.getMeetingDetection(),
    active: meetingDetector.isActive(),
    app: meeting?.app,
  };
});

// Transcription handler
ipcMain.handle('transcribe-audio', async (_, filePath: string, liveNotesRaw?: unknown) => {
  try {
    console.log('Transcription requested for:', filePath);
    let liveNotes = sanitizeLiveNotes(liveNotesRaw);
    if (!liveNotes || liveNotes.length === 0) {
      // Fall back to whatever stop-recording persisted -- covers the
      // record-now-transcribe-later flow when auto-mode is off.
      try {
        const existing = await metadataService.getMetadata(filePath);
        const fromMetadata = sanitizeLiveNotes(existing?.liveNotes);
        if (fromMetadata && fromMetadata.length > 0) {
          liveNotes = fromMetadata;
        }
      } catch (err) {
        console.warn('Failed to read live notes from metadata:', err);
      }
    }

    // Send progress update
    if (mainWindow) {
      mainWindow.webContents.send('transcription-progress', {
        percent: 0,
        message: 'Initializing Gemini service...',
      });
    }

    // Initialize Gemini service if not already initialized
    if (!geminiService) {
      const apiKey = configService.getGeminiApiKey();
      console.log('API key configured:', !!apiKey);

      if (!apiKey) {
        return { success: false, error: 'Gemini API key not configured' };
      }
      geminiService = createGeminiService()!;
    }

    // Send progress update
    if (mainWindow) {
      mainWindow.webContents.send('transcription-progress', {
        percent: 10,
        message: 'Starting transcription...',
      });
    }

    console.log('Starting transcription...');

    // Set up progress callback
    const progressCallback = (percent: number, message: string) => {
      if (mainWindow) {
        mainWindow.webContents.send('transcription-progress', { percent, message });
      }
    };

    const summaryPrompt = configService.getSummaryPrompt();
    const result = await geminiService.transcribeAudio(
      filePath,
      progressCallback,
      summaryPrompt,
      liveNotes,
    );
    console.log('Transcription completed successfully');
    console.log('Saving metadata for:', filePath);

    // Attach renderer-captured notes so downstream consumers (Notion upload,
    // re-render in the modal) can read them off the result object.
    if (liveNotes && liveNotes.length > 0) {
      result.liveNotes = liveNotes;
    }

    // Save transcription files (summary.md + transcript.md)
    const title = result.suggestedTitle || path.basename(filePath, path.extname(filePath));
    let transcriptionPath: string | undefined;
    try {
      transcriptionPath = saveTranscription({
        title,
        result,
        audioFilePath: filePath,
        dataPath: app.getPath('userData'),
        liveNotes,
      });
      console.log('Transcription saved to:', transcriptionPath);
    } catch (error) {
      console.error('Failed to save transcription files:', error);
    }

    // Save metadata - slim if transcription files saved, inline fallback otherwise
    try {
      if (transcriptionPath) {
        await metadataService.saveMetadata(filePath, {
          title,
          suggestedTitle: result.suggestedTitle,
          transcriptionPath,
          customFields: result.customFields,
          liveNotes,
          transcribedAt: new Date().toISOString(),
        });
      } else {
        // Fallback: store inline data when file write failed
        await metadataService.saveMetadata(filePath, {
          title,
          suggestedTitle: result.suggestedTitle,
          transcript: result.transcript,
          summary: result.summary,
          keyPoints: result.keyPoints,
          actionItems: result.actionItems,
          customFields: result.customFields,
          liveNotes,
          transcribedAt: new Date().toISOString(),
        });
      }
      console.log('Metadata saved successfully');
    } catch (error) {
      console.error('Failed to save metadata:', error);
    }

    notificationService.notifyTranscriptionComplete(result.suggestedTitle || 'Meeting');

    // Check if we need to rename the file (if it was untitled)
    const fileName = path.basename(filePath);
    if (fileName.includes('Untitled_Meeting') && result.suggestedTitle) {
      const newFilePath = await renameAudioFile(filePath, result.suggestedTitle);

      // Move metadata to new file path
      const existingMetadata = await metadataService.getMetadata(filePath);
      if (existingMetadata) {
        await metadataService.deleteMetadata(filePath);
        await metadataService.saveMetadata(newFilePath, existingMetadata);
      }

      return { success: true, data: result, newFilePath, transcriptionPath };
    }

    return { success: true, data: result, transcriptionPath };
  } catch (error) {
    console.error('Error transcribing audio:', error);
    notificationService.notifyTranscriptionFailed(
      'Transcription failed. Check the app for details.',
    );
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

// Notion upload handler
ipcMain.handle(
  'upload-to-notion',
  async (
    _,
    data: {
      title: string;
      transcriptionData: any;
      audioFilePath?: string;
      transcriptionPath?: string;
    },
  ) => {
    try {
      console.log('Uploading to Notion:', data.title);

      // Initialize Notion service if not already initialized
      if (!notionService) {
        const notionApiKey = configService.getNotionApiKey();
        const notionDatabaseId = configService.getNotionDatabaseId();

        if (!notionApiKey || !notionDatabaseId) {
          return { success: false, error: 'Notion configuration not found' };
        }

        notionService = new NotionService({
          apiKey: notionApiKey,
          databaseId: notionDatabaseId,
        });
      }

      // Add "by L.AI" to the title for distinction
      const titleWithSuffix = `${data.title} by L.AI`;

      const result = await notionService.createMeetingNote(
        titleWithSuffix,
        new Date(),
        data.transcriptionData,
        data.audioFilePath,
      );

      if (result.success && result.url && isContainedTranscriptionPath(data.transcriptionPath)) {
        try {
          await updateTranscriptionStatus(data.transcriptionPath, {
            notionPageUrl: result.url,
          });
        } catch (error) {
          console.error('Failed to persist Notion URL to transcription:', error);
        }
      }

      notificationService.notifyUploadComplete(data.title);
      return result;
    } catch (error) {
      console.error('Error uploading to Notion:', error);
      notificationService.notifyUploadFailed('Upload failed. Check the app for details.');
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
);

ipcMain.handle(
  'send-to-slack',
  async (
    _,
    data: {
      title: string;
      transcriptionData: any;
      transcriptionPath?: string;
      notionUrl?: string;
      notionError?: string;
    },
  ) => {
    try {
      console.log('Sending to Slack:', data.title);

      const service = getSlackService();
      if (!service) {
        return { success: false, error: 'Slack webhook URL is not configured' };
      }

      // For a historical resend, use the original meeting time from frontmatter
      // so the Slack message shows when the meeting actually happened, not now.
      let meetingDate = new Date();
      if (isContainedTranscriptionPath(data.transcriptionPath)) {
        const stored = await readTranscription(data.transcriptionPath).catch(() => null);
        if (stored?.transcribedAt) {
          const parsed = new Date(stored.transcribedAt);
          if (!Number.isNaN(parsed.getTime())) meetingDate = parsed;
        }
      }

      const result = await service.sendMeetingSummary({
        title: data.title,
        date: meetingDate,
        result: data.transcriptionData,
        notionUrl: data.notionUrl,
        notionError: data.notionError,
      });

      if (isContainedTranscriptionPath(data.transcriptionPath)) {
        try {
          // Preserve the previous successful slackSentAt on a failed resend;
          // only the error field reflects the new failure.
          await updateTranscriptionStatus(data.transcriptionPath, {
            ...(result.success ? { slackSentAt: result.sentAt } : {}),
            slackError: result.success ? null : result.error,
          });
        } catch (error) {
          console.error('Failed to persist Slack status to transcription:', error);
        }
      }

      return result;
    } catch (error) {
      console.error('Error sending to Slack:', error);
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  },
);

ipcMain.handle('test-slack-webhook', async (_, webhookUrl?: string) => {
  try {
    const url = (webhookUrl ?? configService.getSlackWebhookUrl() ?? '').trim();
    if (!url) {
      return { success: false, error: 'Slack webhook URL is not provided' };
    }
    if (!isLikelySlackWebhookUrl(url)) {
      return {
        success: false,
        error: `URL must start with ${SLACK_WEBHOOK_PREFIX}`,
      };
    }
    const service = new SlackService({ webhookUrl: url });
    return await service.sendTestMessage();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
});

// Open external URL
ipcMain.handle('open-external', async (_, url: string) => {
  shell.openExternal(url);
});

// Metadata handlers
ipcMain.handle('get-metadata', async (_, filePath: string) => {
  try {
    const metadata = await metadataService.getMetadata(filePath);
    if (!metadata) return { success: true, data: null };

    // New format: read from transcription folder
    if (metadata.transcriptionPath) {
      const transcription = await readTranscription(metadata.transcriptionPath);
      if (transcription) {
        return {
          success: true,
          data: {
            ...metadata,
            folderName: path.basename(metadata.transcriptionPath),
            transcript: transcription.transcript,
            summary: transcription.summary,
            keyPoints: transcription.keyPoints,
            actionItems: transcription.actionItems,
            customFields: transcription.customFields ?? metadata.customFields,
            emoji: transcription.emoji,
            liveNotes: transcription.liveNotes ?? metadata.liveNotes,
            highlights: transcription.highlights,
            notionPageUrl: transcription.notionPageUrl,
            slackSentAt: transcription.slackSentAt,
            slackError: transcription.slackError,
          },
        };
      }
      console.warn('Transcription folder missing or unreadable:', metadata.transcriptionPath);
    }

    // Old format or missing folder fallback: inline data in metadata
    return { success: true, data: metadata };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('save-metadata', async (_, filePath: string, metadata: any) => {
  try {
    await metadataService.saveMetadata(filePath, metadata);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

// Open recordings folder
ipcMain.handle('open-recordings-folder', async () => {
  const recordingsPath = path.join(app.getPath('userData'), 'recordings');

  // Ensure the directory exists
  if (!fs.existsSync(recordingsPath)) {
    fs.mkdirSync(recordingsPath, { recursive: true });
  }

  // Open the folder in the system file explorer
  shell.openPath(recordingsPath);
});

// Reveal a specific recording in Finder/Explorer. This gives the user a
// one-click path to native OS share tools (right-click -> Share -> AirDrop,
// Messages, Mail, KakaoTalk, etc.) without us having to integrate each target.
ipcMain.handle('show-in-finder', (_, filePath: string) => {
  if (!filePath) return { success: false, error: 'No file path provided' };
  try {
    shell.showItemInFolder(filePath);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

// Search past transcriptions
ipcMain.handle(
  'search-transcriptions',
  async (_, opts: { query: string; fields?: SearchField[]; limit?: number }) => {
    try {
      const query = (opts?.query ?? '').trim();
      if (!query) return { success: true, hits: [] };

      // Validate fields against the known whitelist; drop anything else. Unvalidated input
      // (e.g. a stringified 'title') would be passed to `new Set(...)` and silently match nothing.
      const requested = Array.isArray(opts.fields) ? opts.fields : [];
      const filtered = requested.filter((f): f is SearchField =>
        (ALL_FIELDS as readonly string[]).includes(f),
      );
      const fields = filtered.length > 0 ? filtered : ALL_FIELDS;
      const limit =
        Number.isFinite(opts.limit) && (opts.limit as number) >= 0 ? (opts.limit as number) : 20;
      const dataPath = app.getPath('userData');
      const raw = await searchTranscriptions(dataPath, { query, fields, limit });

      const hits = raw.map((h) => ({
        folderName: h.entry.folderName,
        folderPath: h.entry.folderPath,
        transcribedAt: h.entry.transcribedAt,
        title: h.data.title,
        audioFilePath: h.data.audioFilePath ?? '',
        score: h.score,
        matchedFields: h.matchedFields,
        snippet: h.snippet,
        snippetField: h.snippetField ?? null,
        data: {
          title: h.data.title,
          suggestedTitle: h.data.suggestedTitle,
          summary: h.data.summary,
          transcript: h.data.transcript,
          keyPoints: h.data.keyPoints ?? [],
          actionItems: h.data.actionItems ?? [],
          customFields: h.data.customFields ?? {},
          emoji: h.data.emoji,
        },
      }));

      return { success: true, hits };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
);

// Get list of recordings
ipcMain.handle('get-recordings', async () => {
  try {
    const recordingsDir = path.join(app.getPath('userData'), 'recordings');

    // Ensure directory exists
    if (!fs.existsSync(recordingsDir)) {
      return { success: true, recordings: [] };
    }

    // Read all files in the recordings directory
    const files = fs.readdirSync(recordingsDir);

    // Filter for audio files and get their stats. Skip per-file races so one
    // deleted recording does not make the whole list fail.
    const recordings: Array<{
      filename: string;
      path: string;
      title: string;
      timestamp: string | undefined;
      size: number;
      createdAt: Date;
      modifiedAt: Date;
    }> = [];
    for (const file of files) {
      if (file.includes('_segment_')) continue;
      if (!isSupportedAudioExtension(path.extname(file))) continue;

      const filePath = path.join(recordingsDir, file);
      let stats: fs.Stats;
      try {
        stats = fs.statSync(filePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }

      // Extract title from filename (format: title_timestamp.ext)
      const nameWithoutExt = path.basename(file, path.extname(file));
      const parts = nameWithoutExt.split('_');
      const timestamp = parts.pop(); // Remove timestamp
      const title = parts.join('_') || 'Untitled';

      recordings.push({
        filename: file,
        path: filePath,
        title,
        timestamp,
        size: stats.size,
        createdAt: stats.birthtime,
        modifiedAt: stats.mtime,
      });
    }

    recordings.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()); // Sort by newest first

    return { success: true, recordings };
  } catch (error) {
    console.error('Error getting recordings:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

// Open system settings for microphone permissions
ipcMain.handle('open-microphone-settings', async () => {
  if (process.platform === 'darwin') {
    // Open System Preferences > Security & Privacy > Privacy > Microphone
    shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    );
  } else if (process.platform === 'win32') {
    // Open Windows Settings > Privacy > Microphone
    shell.openExternal('ms-settings:privacy-microphone');
  }
  // For Linux, there's no standard way to open microphone settings
});

// Open macOS Screen Recording settings. macOS caches screen-recording permission at
// process launch, so the app must be fully relaunched after the user toggles it on.
ipcMain.handle('open-screen-recording-settings', async () => {
  if (process.platform === 'darwin') {
    shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    );
  }
});

// Native macOS system-audio capture. PCM chunks are streamed to the renderer as
// raw ArrayBuffers via webContents.send; the renderer pushes them into an
// AudioWorklet that feeds the Web Audio mix.
ipcMain.handle('system-audio-start', async (event) => {
  const result = await systemAudioService.start({
    onChunk: (chunk) => {
      if (!event.sender.isDestroyed()) {
        // structuredClone of Buffer through IPC is expensive; send the raw
        // Uint8Array view which becomes an ArrayBuffer on the renderer side.
        event.sender.send(
          'system-audio-chunk',
          new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
        );
      }
    },
    onError: (err) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('system-audio-error', { message: err.message });
      }
    },
  });
  if (result.ok) return { success: true, format: SYSTEM_AUDIO_FORMAT };
  return { success: false, reason: result.reason, message: result.message };
});

ipcMain.handle('system-audio-stop', async () => {
  await systemAudioService.stop();
  return { success: true };
});

// Agent chat: blocks until the agent produces a final answer. During the run the
// main process may ask the renderer to confirm a config change via the
// 'agent-confirm-request' event; the renderer answers with 'agent-confirm-response'.
ipcMain.handle(
  'agent-chat',
  async (
    _event,
    opts: { question: string; history?: AgentChatMessage[]; scope: AgentScope },
  ): Promise<{ success: true; result: AgentRunResult } | { success: false; error: string }> => {
    try {
      const agent = getAgentService();
      if (!agent) {
        return { success: false, error: 'Gemini API key not configured.' };
      }
      const question = (opts?.question ?? '').trim();
      if (!question) return { success: false, error: 'Empty question.' };

      const scope: AgentScope =
        opts?.scope?.kind === 'single' && typeof opts.scope.folderName === 'string'
          ? { kind: 'single', folderName: opts.scope.folderName }
          : { kind: 'all' };

      const confirm = async (proposal: ConfigProposal): Promise<boolean> => {
        if (!mainWindow || mainWindow.isDestroyed()) return false;
        const id = `cfm_${++confirmIdCounter}`;
        const approval = new Promise<boolean>((resolve) => {
          pendingConfirms.set(id, resolve);
        });
        mainWindow.webContents.send('agent-confirm-request', { id, proposal });
        return approval;
      };

      const result = await agent.run({
        question,
        history: Array.isArray(opts?.history) ? opts.history : [],
        scope,
        confirm,
      });

      // The agent only mutates via set_config; replay each applied write into the
      // runtime side-effect pipeline so shortcut/detector state matches the disk
      // config, then push a 'config-changed' event so the renderer can re-render
      // its toggle checkboxes without waiting for a full reload.
      if (result.appliedActions.length > 0) {
        const changed: Partial<AppConfig> = {};
        for (const action of result.appliedActions) {
          if (action.type === 'setConfig') {
            (changed as Record<string, unknown>)[action.key] = action.value;
          }
        }
        applyConfigSideEffects(changed);
        broadcastConfigChanged();
      }

      return { success: true, result };
    } catch (error) {
      console.error('agent-chat failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
);

ipcMain.handle('agent-confirm-response', async (_, payload: { id: string; approved: boolean }) => {
  const resolver = pendingConfirms.get(payload.id);
  if (resolver) {
    pendingConfirms.delete(payload.id);
    resolver(!!payload.approved);
  }
  return { success: true };
});

// Renderer-triggered bail-out: if the user clicks "Stop" on a pending chat
// bubble while a set_config confirm is outstanding, reject it so the awaiting
// agent call unwinds and the input unlocks. No-op when nothing is pending.
ipcMain.handle('agent-cancel-pending', async () => {
  rejectAllPendingConfirms();
  return { success: true };
});

fileHandlerService.registerHandlers();
