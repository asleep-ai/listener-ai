#!/usr/bin/env node
// Verify that every static asset referenced at runtime by renderer.js or
// index.html is actually present in the packaged app.asar. Run this after
// `electron-builder --linux dir` (any platform's package step works -- the
// asar contents are platform-agnostic).
//
// Catches the class of bug where a renderer-side file (e.g. an AudioWorklet
// module loaded via `addModule('./foo.js')`) is referenced at runtime but
// silently omitted from the packaged build.

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function findAsar(root) {
  if (!fs.existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === 'app.asar') return full;
    }
  }
  return null;
}

const asarPath = findAsar('release');
if (!asarPath) {
  console.error('No app.asar found under release/. Run `electron-builder --linux dir` first.');
  process.exit(1);
}

const asarFiles = new Set(
  execSync(`npx --yes @electron/asar list "${asarPath}"`, { encoding: 'utf8' })
    .split('\n')
    .map((s) => s.replace(/^\//, '').trim())
    .filter(Boolean)
);

const errors = [];

// Renderer-side: paths are relative to the loading document, which sits at the
// asar root (index.html, renderer.js are emitted at /).
const rendererChecks = [
  ['renderer.js', /audioWorklet\.addModule\(\s*['"`]([^'"`]+)['"`]/g, 'AudioWorklet.addModule'],
  ['renderer.js', /(?:fetch|new\s+Worker)\(\s*['"`](\.\/[^'"`]+)['"`]/g, 'fetch / Worker'],
  ['index.html', /<script[^>]+src=['"]([^'"]+)['"]/g, '<script src>'],
  ['index.html', /<link[^>]+href=['"]([^'"]+)['"]/g, '<link href>'],
];
for (const [file, regex, label] of rendererChecks) {
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(regex)) {
    const ref = match[1];
    if (/^[a-z]+:/i.test(ref) || ref.startsWith('//')) continue;
    const normalized = ref.replace(/^\.\//, '');
    if (!asarFiles.has(normalized)) {
      errors.push(`  - ${label} in ${file} references "${ref}" -- not in asar`);
    }
  }
}

// Main-process side: path.join(__dirname, '...') with a literal second arg.
// __dirname after tsc compilation is the file's location under dist/, so we
// resolve relative to that. Skips dynamic args (variables, expressions).
const mainChecks = [
  ['src/main.ts', 'dist'],
  ['src/preload.ts', 'dist'],
];
for (const [tsFile, compiledDir] of mainChecks) {
  if (!fs.existsSync(tsFile)) continue;
  const text = fs.readFileSync(tsFile, 'utf8');
  const re = /path\.join\(\s*__dirname\s*,\s*['"`]([^'"`]+)['"`]\s*\)/g;
  for (const match of text.matchAll(re)) {
    const ref = match[1];
    const resolved = path.posix.normalize(path.posix.join(compiledDir, ref));
    if (resolved.startsWith('..')) continue; // escapes asar root, not our concern
    if (!asarFiles.has(resolved)) {
      errors.push(`  - path.join(__dirname, "${ref}") in ${tsFile} -> "${resolved}" -- not in asar`);
    }
  }
}

if (errors.length) {
  console.error(`Asar at ${asarPath} is missing referenced static assets:`);
  for (const e of errors) console.error(e);
  process.exit(1);
}

console.log(`OK: all referenced static assets are in ${asarPath}`);
