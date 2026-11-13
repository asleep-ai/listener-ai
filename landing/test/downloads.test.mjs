// Tests for docs/assets/downloads.js, the landing page's latest-release
// download links. The rendered markup it enhances is covered by page.test.mjs.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const downloads = require('../../docs/assets/downloads.js');

const REPO = 'https://github.com/asleep-ai/listener-ai';
const FALLBACK = `${REPO}/releases/latest`;

function asset(tag, name, overrides = {}) {
  return {
    name,
    state: 'uploaded',
    size: 1000,
    content_type: 'raw',
    browser_download_url: `${REPO}/releases/download/${tag}/${name}`,
    ...overrides,
  };
}

// Mirrors the shape of the real v2.19.0 release, including the auto-update
// metadata, zips and blockmaps that must never be offered as installers.
function release(version, { assets, ...overrides } = {}) {
  const tag = `v${version}`;
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    html_url: `${REPO}/releases/tag/${tag}`,
    assets: assets ?? [
      asset(tag, 'builder-debug.yml'),
      asset(tag, 'latest-mac.yml'),
      asset(tag, 'latest.yml'),
      asset(tag, `Listener.AI-${version}-arm64.dmg`, { size: 133137879 }),
      asset(tag, `Listener.AI-${version}-arm64.dmg.blockmap`),
      asset(tag, `Listener.AI-${version}-arm64.zip`),
      asset(tag, `Listener.AI-${version}-x64.dmg`, { size: 140029570 }),
      asset(tag, `Listener.AI-${version}-x64.zip`),
      asset(tag, `Listener.AI-Setup-${version}.exe`, { size: 118917942 }),
      asset(tag, `Listener.AI-Setup-${version}.exe.blockmap`),
    ],
    ...overrides,
  };
}

function directLinks(version) {
  const base = `${REPO}/releases/download/v${version}`;
  return {
    'mac-arm64': `${base}/Listener.AI-${version}-arm64.dmg`,
    'mac-x64': `${base}/Listener.AI-${version}-x64.dmg`,
    'win-x64': `${base}/Listener.AI-Setup-${version}.exe`,
  };
}

// Minimal DOM double covering what applyRelease touches.
class FakeNode {
  constructor(attrs = {}, text = '') {
    this.attrs = { ...attrs };
    this.textContent = text;
    this.children = [];
    this.appended = [];
  }
  getAttribute(name) {
    return this.attrs[name] ?? null;
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value);
  }
  appendChild(node) {
    this.appended.push(node);
    return node;
  }
  querySelector(selector) {
    for (const child of this.children) {
      if (matches(child, selector)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
  get renderedText() {
    return this.textContent + this.appended.map((n) => n.textContent).join('');
  }
}

function matches(node, selector) {
  const m = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(selector);
  if (!m) throw new Error(`Unsupported selector ${selector}`);
  return m[2] === undefined ? m[1] in node.attrs : node.attrs[m[1]] === m[2];
}

function fakeDocument() {
  const doc = new FakeNode();
  doc.links = {};
  for (const id of ['mac-arm64', 'mac-x64', 'win-x64']) {
    const link = new FakeNode({ 'data-download-platform': id, href: FALLBACK });
    link.children.push(
      new FakeNode({ 'data-download-detail': '' }, '릴리스 페이지 열기'),
      new FakeNode({ 'data-download-icon': '' }, '↗'),
    );
    doc.children.push(link);
    doc.links[id] = link;
  }
  doc.status = new FakeNode({ 'data-download-status': '' }, '각 링크는 GitHub의 최신 릴리스 페이지를 엽니다.');
  doc.children.push(doc.status);
  doc.createElement = () => new FakeNode();
  doc.createTextNode = (text) => new FakeNode({}, text);
  return doc;
}

function jsonResponse(body, init = {}) {
  return { ok: init.ok ?? true, status: init.status ?? 200, json: async () => body };
}

function assertFallback(doc) {
  for (const link of Object.values(doc.links)) {
    assert.equal(link.getAttribute('href'), FALLBACK);
    assert.equal(link.querySelector('[data-download-detail]').textContent, '릴리스 페이지 열기');
    assert.equal(link.querySelector('[data-download-icon]').textContent, '↗');
  }
  assert.equal(doc.status.renderedText, '각 링크는 GitHub의 최신 릴리스 페이지를 엽니다.');
}

describe('resolveRelease', () => {
  it('maps the actual v2.19.0 release shape to the three installers only', () => {
    const resolved = downloads.resolveRelease(release('2.19.0'));
    assert.deepEqual(resolved, {
      tag: 'v2.19.0',
      version: '2.19.0',
      releaseUrl: `${REPO}/releases/tag/v2.19.0`,
      downloads: directLinks('2.19.0'),
    });
  });

  it('follows a future version without code changes', () => {
    const resolved = downloads.resolveRelease(release('3.0.12'));
    assert.equal(resolved.tag, 'v3.0.12');
    assert.deepEqual(resolved.downloads, directLinks('3.0.12'));
  });

  for (const [label, overrides] of [
    ['draft', { draft: true }],
    ['prerelease', { prerelease: true }],
    ['missing draft flag', { draft: undefined }],
    ['media release tag', { tag_name: 'landing-media-v1', html_url: `${REPO}/releases/tag/landing-media-v1` }],
    ['pre-release suffix', { tag_name: 'v2.20.0-beta.1', html_url: `${REPO}/releases/tag/v2.20.0-beta.1` }],
    ['other repository page', { html_url: 'https://github.com/someone/listener-ai/releases/tag/v2.19.0' }],
    ['non-array assets', { assets: {} }],
  ]) {
    it(`rejects a ${label}`, () => {
      assert.equal(downloads.resolveRelease(release('2.19.0', overrides)), null);
    });
  }

  it('rejects non-object payloads', () => {
    for (const payload of [null, undefined, 'v2.19.0', [], 42]) {
      assert.equal(downloads.resolveRelease(payload), null);
    }
  });

  it('drops only the installers that are missing, duplicated or malformed', () => {
    const tag = 'v2.19.0';
    const arm = 'Listener.AI-2.19.0-arm64.dmg';
    const x64 = 'Listener.AI-2.19.0-x64.dmg';
    const exe = 'Listener.AI-Setup-2.19.0.exe';
    const cases = [
      [
        [asset(tag, x64), asset(tag, exe)],
        ['mac-x64', 'win-x64'],
      ],
      [
        [asset(tag, arm), asset(tag, arm), asset(tag, x64), asset(tag, exe)],
        ['mac-x64', 'win-x64'],
      ],
      [
        [asset(tag, arm, { state: 'starter' }), asset(tag, x64), asset(tag, exe)],
        ['mac-x64', 'win-x64'],
      ],
      [
        [asset(tag, arm, { size: 0 }), asset(tag, x64), asset(tag, exe)],
        ['mac-x64', 'win-x64'],
      ],
      [
        [asset(tag, arm, { size: '1000' }), asset(tag, x64), asset(tag, exe)],
        ['mac-x64', 'win-x64'],
      ],
      [
        [
          asset(tag, arm, { browser_download_url: `https://evil.example/releases/download/${tag}/${arm}` }),
          asset(tag, x64, { browser_download_url: `${REPO}/releases/download/v2.18.0/${x64}` }),
          asset(tag, exe, {
            browser_download_url: `https://github.com/someone/listener-ai/releases/download/${tag}/${exe}`,
          }),
        ],
        [],
      ],
      [[asset(tag, 'Listener.AI-2.18.0-arm64.dmg'), asset(tag, 'listener.ai-2.19.0-x64.dmg'), null], []],
    ];
    for (const [assets, expected] of cases) {
      const resolved = downloads.resolveRelease(release('2.19.0', { assets }));
      assert.deepEqual(Object.keys(resolved.downloads).sort(), expected);
    }
  });
});

describe('fetchLatestRelease', () => {
  it('requests the public latest-release endpoint without credentials', async () => {
    let call;
    const resolved = await downloads.fetchLatestRelease(async (url, init) => {
      call = { url, init };
      return jsonResponse(release('2.19.0'));
    });
    assert.equal(call.url, 'https://api.github.com/repos/asleep-ai/listener-ai/releases/latest');
    assert.equal(call.init.credentials, 'omit');
    assert.ok(call.init.signal, 'request must be abortable');
    assert.equal(resolved.tag, 'v2.19.0');
  });

  it('returns null for HTTP errors, rate limits, bad JSON and network failures', async () => {
    const failures = [
      async () => jsonResponse({ message: 'Not Found' }, { ok: false, status: 404 }),
      async () => jsonResponse({ message: 'API rate limit exceeded' }, { ok: false, status: 403 }),
      async () => ({ ok: true, json: async () => JSON.parse('<html>') }),
      async () => {
        throw new TypeError('Failed to fetch');
      },
      () => {
        throw new TypeError('fetch threw synchronously');
      },
    ];
    for (const fetchImpl of failures) {
      assert.equal(await downloads.fetchLatestRelease(fetchImpl), null);
    }
  });

  it('gives up and aborts after the timeout', async () => {
    let aborted = false;
    const started = Date.now();
    const result = await downloads.fetchLatestRelease(
      (_url, init) =>
        new Promise(() => {
          init.signal.addEventListener('abort', () => {
            aborted = true;
          });
        }),
      { timeoutMs: 30 },
    );
    assert.equal(result, null);
    assert.ok(aborted, 'the hung request must be aborted');
    assert.ok(Date.now() - started < 1000);
    assert.ok(downloads.TIMEOUT_MS <= 10000, 'production timeout must stay bounded');
  });
});

describe('enhance', () => {
  it('points every link at its installer and states the actual version', async () => {
    const doc = fakeDocument();
    const applied = await downloads.enhance(doc, async () => jsonResponse(release('2.19.0')));
    assert.equal(applied, 3);
    for (const [id, url] of Object.entries(directLinks('2.19.0'))) {
      const link = doc.links[id];
      assert.equal(link.getAttribute('href'), url);
      assert.match(link.querySelector('[data-download-detail]').textContent, /^v2\.19\.0 · .*내려받기$/);
      assert.equal(link.querySelector('[data-download-icon]').textContent, '↓');
    }
    assert.match(doc.status.renderedText, /최신 버전 v2\.19\.0 설치 파일을 GitHub에서 바로 내려받습니다/);
    assert.equal(doc.status.appended[0].getAttribute('href'), `${REPO}/releases/tag/v2.19.0`);
  });

  it('keeps the release-page fallback for a platform whose installer is missing', async () => {
    const doc = fakeDocument();
    const full = release('2.19.0');
    const assets = full.assets.filter((a) => !a.name.endsWith('.exe'));
    await downloads.enhance(doc, async () => jsonResponse({ ...full, assets }));
    assert.equal(doc.links['mac-arm64'].getAttribute('href'), directLinks('2.19.0')['mac-arm64']);
    assert.equal(doc.links['win-x64'].getAttribute('href'), FALLBACK);
    assert.equal(doc.links['win-x64'].querySelector('[data-download-detail]').textContent, '릴리스 페이지 열기');
    assert.match(doc.status.renderedText, /일부 설치 파일은 아직 준비되지 않아 릴리스 페이지가 열립니다/);
  });

  it('leaves the static fallback untouched when nothing validates', async () => {
    const outcomes = [
      async () => jsonResponse({}, { ok: false, status: 403 }),
      async () => jsonResponse(release('2.19.0', { prerelease: true })),
      async () => jsonResponse(release('2.19.0', { assets: [] })),
      async () => {
        throw new TypeError('Failed to fetch');
      },
    ];
    for (const fetchImpl of outcomes) {
      const doc = fakeDocument();
      assert.equal(await downloads.enhance(doc, fetchImpl), 0);
      assertFallback(doc);
    }
  });

  it('does not call the API on pages without download links', async () => {
    let called = false;
    const doc = new FakeNode();
    await downloads.enhance(doc, async () => {
      called = true;
    });
    assert.equal(called, false);
  });
});
