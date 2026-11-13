// Tests for the prerendered landing page in landing/dist/. Run `pnpm build`
// first; `pnpm test` fails if the output is missing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const downloads = require('../../docs/assets/downloads.js');

const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../dist/assets/landing.css', import.meta.url), 'utf8');

const RELEASE_PAGE = 'https://github.com/asleep-ai/listener-ai/releases/latest';

function downloadAnchors() {
  return [...html.matchAll(/<a\b([^>]*\bdata-download-platform="([^"]+)"[^>]*)>([\s\S]*?)<\/a>/g)].map(
    ([, attrs, id, inner]) => ({ attrs, id, inner }),
  );
}

describe('download links', () => {
  it('renders exactly one link per platform downloads.js resolves', () => {
    const ids = downloadAnchors().map((a) => a.id);
    assert.deepEqual(
      ids,
      downloads.PLATFORMS.map((p) => p.id),
    );
  });

  it('falls back to the latest release page, labelled as such, without JavaScript', () => {
    for (const { attrs, inner } of downloadAnchors()) {
      assert.match(attrs, new RegExp(`href="${RELEASE_PAGE.replace(/[.]/g, '\\.')}"`));
      assert.doesNotMatch(attrs, /aria-label=/, 'a fixed aria-label would go stale after enhancement');
      assert.match(inner, /<span data-download-detail="">[^<]*릴리스 페이지 열기<\/span>/);
      assert.match(inner, /<span aria-hidden="true" data-download-icon="">↗<\/span>/);
    }
  });

  it('keeps the elements downloads.js rewrites inside each link', () => {
    for (const { inner } of downloadAnchors()) {
      assert.equal(inner.match(/data-download-detail=/g)?.length, 1);
      assert.equal(inner.match(/data-download-icon=/g)?.length, 1);
    }
    assert.equal(html.match(/data-download-status=/g)?.length, 1);
    assert.match(html, /data-download-status="">각 링크는 GitHub의 최신 릴리스 페이지를 엽니다\./);
  });

  it('loads downloads.js as the only script, deferred', () => {
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    assert.deepEqual(scripts, ['<script src="assets/downloads.js" defer>']);
  });
});

describe('Astryx rendering', () => {
  it('declares the light neutral theme on the document and the Theme root', () => {
    assert.match(html, /<html lang="ko" data-theme="light" data-astryx-theme="neutral">/);
    assert.match(html, /<body>\s*<div class="[^"]+" data-astryx-theme="neutral" data-theme="light">/);
  });

  it('renders the hero with Astryx Heading and the primary CTA with Astryx Button', () => {
    const h1s = html.match(/<h1\b[^>]*>/g) ?? [];
    assert.equal(h1s.length, 1);
    assert.match(h1s[0], /class="astryx-heading [^"]*"/);
    assert.match(h1s[0], /data-type="display-1"/);
    assert.match(
      html,
      /<a class="astryx-button [^"]*" data-variant="primary" data-size="lg"[^>]*href="#download"><span[^>]*><span[^>]*>Listener\.AI 다운로드<\/span>/,
    );
  });

  it('bundles the official Astryx stylesheets before the site layout', () => {
    const order = [
      '/* @astryxdesign/core/reset.css */',
      '/* @astryxdesign/core/astryx.css */',
      '/* @astryxdesign/theme-neutral/theme.css */',
      '/* landing/src/site.css */',
    ].map((marker) => css.indexOf(marker));
    assert.ok(
      order.every((i) => i >= 0),
      'every stylesheet is bundled',
    );
    assert.deepEqual(
      [...order].sort((a, b) => a - b),
      order,
    );
    assert.match(css, /@scope \(\[data-astryx-theme="neutral"\]\)/);
    assert.match(css, /\.astryx-button|\.x1k57tk5/);
  });

  // Astryx Text defaults to display:inline even when rendered as <p>, which
  // runs consecutive paragraphs together. Paragraphs must opt into block.
  it('renders every Text paragraph as a block and keeps inline Text spans inline', () => {
    const atomicClass = (display) => {
      const match = new RegExp(`\\.(x[a-z0-9]+)(?::not\\(#\\\\#\\))+\\{display:${display}\\}`).exec(css);
      assert.ok(match, `Astryx display:${display} class is bundled`);
      return match[1];
    };
    const block = atomicClass('block');
    const inline = atomicClass('inline');
    const classesOf = (tag) =>
      [...html.matchAll(new RegExp(`<${tag} class="(astryx-text [^"]*)"`, 'g'))].map((m) => m[1].split(' '));

    const paragraphs = classesOf('p');
    assert.ok(paragraphs.length >= 20, 'page paragraphs use Astryx Text');
    for (const classes of paragraphs) {
      assert.ok(classes.includes(block) && !classes.includes(inline), classes.join(' '));
    }
    const spans = classesOf('span');
    assert.ok(spans.length > 0);
    for (const classes of spans) {
      assert.ok(classes.includes(inline) && !classes.includes(block), classes.join(' '));
    }
  });

  it('does not fetch the theme web font from a third party', () => {
    assert.doesNotMatch(css, /fonts\.googleapis\.com/);
    assert.doesNotMatch(html, /fonts\.googleapis\.com/);
  });
});

describe('site integration', () => {
  it('uses only relative URLs for site files so a project base path keeps working', () => {
    const urls = [...html.matchAll(/\b(?:href|src|poster)="([^"]*)"/g)].map((m) => m[1]);
    const local = urls.filter((u) => !/^(https:|data:|#)/.test(u));
    assert.ok(local.length > 0);
    for (const url of local) {
      assert.doesNotMatch(url, /^\//, `${url} must not be root-absolute`);
    }
    assert.ok(local.includes('privacy/') && local.includes('terms/'));
    assert.doesNotMatch(html, /\{\{|\{%/, 'no unrendered Liquid');
  });

  it('keeps the demo video, captions, text description and credits', () => {
    assert.match(html, /poster="assets\/demos\/listener-demo\.jpg"/);
    assert.match(html, /<source src="assets\/demos\/listener-demo\.mp4" type="video\/mp4"\/>/);
    assert.match(
      html,
      /<track kind="captions" src="assets\/demos\/listener-demo\.ko\.vtt" srcLang="ko" label="한국어" default=""\/>/,
    );
    assert.match(html, /<details class="demo-description" id="demo-description">/);
    assert.match(html, /AMI Meeting Corpus/);
    assert.match(html, /CC BY 4\.0/);
  });

  it('keeps the AI, billing and privacy statements', () => {
    for (const statement of [
      'ChatGPT 로그인에 음성 처리가 포함되지는 않습니다.',
      '로컬 저장이 로컬 AI 처리를 의미하지는 않습니다.',
      'ChatGPT 로그인을 사용해도 음성 전사 제공자의 API 비용은 별도로 발생할 수 있습니다.',
      '회의 참여자의 동의를 확인하고 필요한 내용만 공유하세요.',
      '녹음과 회의 기록은 로컬에 저장합니다.',
    ]) {
      assert.ok(html.includes(statement), statement);
    }
  });

  it('keeps every FAQ answer in native disclosure elements', () => {
    const faq = html.slice(html.indexOf('<div class="questions-list">'), html.indexOf('id="download"'));
    assert.equal(faq.match(/<details>/g)?.length, 4);
    assert.equal(faq.match(/<summary>[^<]+<\/summary>/g)?.length, 4);
  });
});
