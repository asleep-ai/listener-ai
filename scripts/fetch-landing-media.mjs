#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(root, 'docs/assets/demos');
const baseUrl = 'https://github.com/asleep-ai/listener-ai/releases/download/landing-media-v1/';
const expectedNames = ['listener-demo.mp4', 'listener-demo.jpg', 'listener-demo.ko.vtt'];
const validateOnly = process.argv.slice(2).includes('--validate-only');
if (process.argv.slice(2).some((arg) => arg !== '--validate-only')) {
  throw new Error('Usage: node scripts/fetch-landing-media.mjs [--validate-only]');
}
const manifest = JSON.parse(await readFile(resolve(destination, 'manifest.json'), 'utf8'));
if (manifest.version !== 1 || manifest.baseUrl !== baseUrl || !Array.isArray(manifest.assets)) {
  throw new Error('Unsupported landing media manifest');
}
if (
  manifest.assets.length !== expectedNames.length ||
  new Set(manifest.assets.map((asset) => asset.name)).size !== expectedNames.length
) {
  throw new Error('Manifest must contain each of the three landing media assets exactly once');
}
for (const asset of manifest.assets) {
  if (
    !expectedNames.includes(asset.name) ||
    !Number.isSafeInteger(asset.bytes) ||
    asset.bytes <= 0 ||
    asset.bytes > 100 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(asset.sha256)
  ) {
    throw new Error('Invalid landing media asset metadata');
  }
}
if (validateOnly) {
  console.log('Landing media manifest is valid');
} else {
  await mkdir(destination, { recursive: true });
  for (const asset of manifest.assets) {
    const target = resolve(destination, asset.name);
    const verify = (data) =>
      data.length === asset.bytes &&
      createHash('sha256').update(data).digest('hex') === asset.sha256;
    let existing;
    try {
      existing = await readFile(target);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (existing && verify(existing)) {
      console.log(`Verified ${asset.name}`);
      continue;
    }
    const response = await fetch(new URL(asset.name, baseUrl), {
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Download failed for ${asset.name}: HTTP ${response.status}`);
    const chunks = [];
    let received = 0;
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > asset.bytes) throw new Error(`Size exceeded for ${asset.name}`);
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    if (!verify(data)) throw new Error(`Integrity verification failed for ${asset.name}`);
    const temporary = `${target}.${randomUUID()}.download`;
    try {
      await writeFile(temporary, data, { flag: 'wx' });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
    console.log(`Downloaded and verified ${asset.name}`);
  }
}
