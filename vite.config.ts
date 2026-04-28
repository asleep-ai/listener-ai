import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Renderer-only Vite config. Main process is compiled separately by tsc.
//
// - root is `renderer/` so index.html lives there and is the build entry.
// - Output to `dist/renderer/` so electron-builder's `dist/**/*` glob picks it up.
// - base `./` so file:// URLs resolve relative paths in the packaged app.
// - emit the AudioWorklet as a separate chunk via the `?worker&url` import.
export default defineConfig({
  root: resolve(__dirname, 'renderer'),
  base: './',
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
