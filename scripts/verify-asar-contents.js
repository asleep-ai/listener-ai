#!/usr/bin/env node
// Verify that every static asset referenced at runtime by renderer.js or
// index.html is actually present in the packaged app.asar. Run this after
// `electron-builder --linux dir` (any platform's package step works -- the
// asar contents are platform-agnostic).
//
// Catches the class of bug where a renderer-side file (e.g. an AudioWorklet
// module loaded via `addModule('./foo.js')`) is referenced at runtime but
// silently omitted from the packaged build.

const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');

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
  asar
    .listPackage(asarPath)
    .map((s) => s.replace(/^[\\/]+/, '').replace(/\\/g, '/').trim())
    .filter(Boolean)
);

// Strip JS line/block comments and HTML comments so commented-out code does
// not produce false positives. Conservative: only strips `//` comments that
// start at line beginning (after whitespace) so URLs like `https://...` in
// string literals are not corrupted.
function stripJsComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}
function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

function isExternalRef(ref) {
  return /^[a-z]+:/i.test(ref) || ref.startsWith('//');
}

const errors = [];

// Renderer-side: paths are relative to the loading document, which sits at
// the asar root (index.html, renderer.js are emitted at /).
const rendererChecks = [
  ['renderer.js', /audioWorklet\.addModule\(\s*['"`]([^'"`]+)['"`]/g, 'AudioWorklet.addModule', 'js'],
  ['renderer.js', /(?:fetch|new\s+Worker)\(\s*['"`]([^'"`]+)['"`]/g, 'fetch / Worker', 'js'],
  ['index.html', /<script[^>]+src=['"]([^'"]+)['"]/g, '<script src>', 'html'],
  ['index.html', /<link[^>]+href=['"]([^'"]+)['"]/g, '<link href>', 'html'],
];
for (const [file, regex, label, kind] of rendererChecks) {
  if (!fs.existsSync(file)) continue;
  const raw = fs.readFileSync(file, 'utf8');
  const text = kind === 'html' ? stripHtmlComments(raw) : stripJsComments(raw);
  for (const match of text.matchAll(regex)) {
    const ref = match[1];
    if (isExternalRef(ref)) continue;
    const normalized = path.posix.normalize(ref.replace(/^\.\//, ''));
    if (normalized.startsWith('..')) {
      errors.push(`  - ${label} in ${file} references "${ref}" -- escapes asar root`);
      continue;
    }
    if (!asarFiles.has(normalized)) {
      errors.push(`  - ${label} in ${file} references "${ref}" -- not in asar`);
    }
  }
}

// Main-process side: path.join(__dirname, '...lit'[, '...lit']*) with one or
// more string-literal args. After tsc, __dirname is the file's location under
// dist/, so we resolve relative to that. Skips calls with any non-literal arg.
const MAIN_JOIN_RE =
  /path\.join\(\s*__dirname\s*((?:,\s*['"`][^'"`]+['"`]\s*)+)\)/g;
const LITERAL_RE = /['"`]([^'"`]+)['"`]/g;

const mainChecks = [
  ['src/main.ts', 'dist'],
  ['src/preload.ts', 'dist'],
];
for (const [tsFile, compiledDir] of mainChecks) {
  if (!fs.existsSync(tsFile)) continue;
  const text = stripJsComments(fs.readFileSync(tsFile, 'utf8'));
  for (const match of text.matchAll(MAIN_JOIN_RE)) {
    const literals = [...match[1].matchAll(LITERAL_RE)].map((m) => m[1]);
    const refDisplay = literals.map((l) => JSON.stringify(l)).join(', ');
    const resolved = path.posix.normalize(path.posix.join(compiledDir, ...literals));
    // assets/icon.png and similar live at packaged-app root (outside asar)
    // when the path joins out of dist/. The verify script's job is only to
    // confirm asar contents, so we skip references that resolve outside.
    if (resolved.startsWith('..')) continue;
    if (!asarFiles.has(resolved)) {
      errors.push(`  - path.join(__dirname, ${refDisplay}) in ${tsFile} -> "${resolved}" -- not in asar`);
    }
  }
}

if (errors.length) {
  console.error(`Asar at ${asarPath} is missing referenced static assets:`);
  for (const e of errors) console.error(e);
  process.exit(1);
}

console.log(`OK: all referenced static assets are in ${asarPath}`);
