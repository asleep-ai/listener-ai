export type CasePolicy = {
  group: string;
  kind: 'shared' | 'fresh';
  reason: string;
};

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
    case 'transcript-cutoff.spec.ts':
      return {
        group: 'cutoff',
        kind: 'shared',
        reason: 'Saved-note fixtures reset between warm transcript cases.',
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
