// Writes the static landing page to landing/dist/:
//   dist/index.html          prerendered page
//   dist/assets/landing.css  Astryx reset + component styles + neutral theme + site layout
// The Pages workflow copies dist/ over the Jekyll output, which already
// contains the legal pages, demo media and assets/downloads.js.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderDocument } from './render.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// Official stylesheet entry points, in Astryx's documented order. Each file
// also registers the `reset, astryx-base, astryx-theme` layer order itself.
const ASTRYX_STYLESHEETS = [
  '@astryxdesign/core/reset.css',
  '@astryxdesign/core/astryx.css',
  '@astryxdesign/theme-neutral/theme.css',
];

async function main(): Promise<void> {
  const parts: string[] = [];
  for (const specifier of ASTRYX_STYLESHEETS) {
    parts.push(`/* ${specifier} */\n${await readFile(require.resolve(specifier), 'utf8')}`);
  }
  // Site layout is unlayered and therefore applies after every Astryx layer.
  parts.push(`/* landing/src/site.css */\n${await readFile(resolve(root, 'src/site.css'), 'utf8')}`);

  const dist = resolve(root, 'dist');
  await mkdir(resolve(dist, 'assets'), { recursive: true });
  await writeFile(resolve(dist, 'assets/landing.css'), parts.join('\n'));
  await writeFile(resolve(dist, 'index.html'), renderDocument());
  console.log('Landing page written to landing/dist');
}

await main();
