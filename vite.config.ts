import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// Dev-only stub for `window.electronAPI` so the renderer boots in `vite dev`
// without an Electron preload. Inert in production (apply: 'serve').
const electronApiDevShim = (): Plugin => {
  const shimPath = resolve(__dirname, 'renderer/dev-shim.html');
  return {
    name: 'electron-api-dev-shim',
    apply: 'serve',
    transformIndexHtml: {
      order: 'pre',
      handler() {
        return [
          {
            tag: 'script',
            attrs: { type: 'text/javascript' },
            children: extractScriptBody(readFileSync(shimPath, 'utf8')),
            injectTo: 'body-prepend',
          },
        ];
      },
    },
  };
};

const extractScriptBody = (html: string): string => {
  const match = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('dev-shim.html must contain a <script> block');
  return match[1];
};

// Renderer-only Vite config. Main process is compiled separately by tsc.
//
// - root is `renderer/` so index.html lives there and is the build entry.
// - Output to `dist/renderer/` so electron-builder's `dist/**/*` glob picks it up.
// - base `./` so file:// URLs resolve relative paths in the packaged app.
// - emit the AudioWorklet as a separate chunk via the `?worker&url` import.
export default defineConfig({
  root: resolve(__dirname, 'renderer'),
  base: './',
  plugins: [electronApiDevShim()],
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'chrome120',
    rollupOptions: {
      input: resolve(__dirname, 'renderer/index.html'),
    },
  },
  // Electron renderer reads files via file:// in production. Keep dev server
  // simple; we don't currently use HMR (yet) so a build-only flow works.
  server: {
    port: 5173,
  },
});
