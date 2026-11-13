export type CasePolicy = {
  group: string;
  kind: 'shared' | 'fresh';
  reason: string;
};

// Fresh cases that destroy and recreate the main window; packaged runs adopt
// the replacement through the guards (adoptMainWindow).
export const RECORDING_WINDOW_CASE = /main window is destroyed/;

// The app menu's Settings item exists only on macOS; on Windows/Linux the
// same request comes from the tray, which background test mode never creates.
export const MENU_SETTINGS_CASE = /^Settings requested after the main window is destroyed/;

// Fresh case that ends its own process through app.quit().
export const RECORDING_QUIT_CASE = /^quitting during a recording/;

export function caseApplies(title: string): boolean {
  return process.platform === 'darwin' || !MENU_SETTINGS_CASE.test(title);
}

export function classifyCase(file: string, title: string): CasePolicy {
  const name = file.replace(/\\/g, '/').split('/').at(-1);
  switch (name) {
    case 'settings.spec.ts':
      return title === 'captures every Settings tab for visual review'
        ? {
            group: 'settings-shots',
            kind: 'fresh',
            reason: 'Opt-in screenshots use a fresh rendering state.',
          }
        : {
            group: 'settings',
            kind: 'shared',
            reason: 'Settings behavior uses isolated fixtures in one warm app.',
          };
    case 'meeting-list.spec.ts':
      return {
        group: 'meeting-list',
        kind: 'shared',
        reason: 'Saved meeting fixtures reset within one hidden app.',
      };
    case 'transcript-cutoff.spec.ts':
      return {
        group: 'cutoff',
        kind: 'shared',
        reason: 'Saved-note fixtures reset between warm transcript cases.',
      };
    case 'live-session.spec.ts':
      return {
        group: 'live',
        kind: 'shared',
        reason: 'Synthetic live capture and provider fixtures reset in one warm app.',
      };
    case 'transcription-reload.spec.ts':
      return {
        group: 'reload',
        kind: 'shared',
        reason: 'Jobs and reload behavior preserve one main process.',
      };
    case 'chatgpt-integration.spec.ts':
      return /^startup .* opens without AI setup prompt$/.test(title)
        ? {
            group: 'chatgpt-startup',
            kind: 'fresh',
            reason: 'Startup gating requires a fresh main process.',
          }
        : {
            group: 'chatgpt',
            kind: 'shared',
            reason: 'Offline auth and provider fixtures reset in one warm app.',
          };
    case 'recording-host.spec.ts':
      if (RECORDING_QUIT_CASE.test(title))
        return {
          group: 'recording-quit',
          kind: 'fresh',
          reason: 'The case quits the app, which ends its process.',
        };
      return RECORDING_WINDOW_CASE.test(title)
        ? {
            group: 'recording-window',
            kind: 'fresh',
            reason: 'Destroying and recreating the main window changes its identity.',
          }
        : {
            group: 'recording',
            kind: 'shared',
            reason: 'Synthetic capture-host recordings reset within one hidden app.',
          };
    case 'hidden-launch.spec.ts':
      return {
        group: 'hidden-startup',
        kind: 'fresh',
        reason: 'Hidden construction is a fresh startup contract.',
      };
    case 'smoke.spec.ts':
      return {
        group: 'package-smoke',
        kind: 'fresh',
        reason: 'Packaged startup requires its own process.',
      };
    default:
      throw new Error(`Unclassified Electron test: ${file}: ${title}`);
  }
}
