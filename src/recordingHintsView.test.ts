import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import * as path from 'node:path';
import * as vm from 'node:vm';

class Element {
  children: Element[] = [];
  parentElement: Element | null = null;
  private ownText = '';
  get textContent() {
    return this.ownText + this.children.map((child) => child.textContent).join('');
  }
  set textContent(value: string) {
    this.ownText = value;
    this.children = [];
  }
  id = '';
  type = '';
  className = '';
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  classes = new Set<string>();
  classList = { add: (...values: string[]) => values.forEach((value) => this.classes.add(value)) };
  constructor(readonly tag: string) {}
  append(...nodes: Element[]) {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
  }
  insertBefore(node: Element) {
    this.append(node);
  }
  replaceChildren() {
    this.children = [];
  }
  setAttribute(key: string, value: string) {
    this.attributes[key] = value;
  }
  querySelector() {
    return null;
  }
}
function descendants(root: Element): Element[] {
  return [root, ...root.children.flatMap(descendants)];
}

describe('saved recording hints view', () => {
  let code: string;
  before(async () => {
    const { build } = require('vite');
    const output = await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        write: false,
        minify: false,
        lib: { entry: path.resolve('renderer/ui/recording-hints.ts'), formats: ['cjs'] },
      },
    });
    code = output[0].output.find((chunk: any) => chunk.type === 'chunk').code;
  });
  function fixture() {
    const tabs = new Element('nav');
    const panes = new Element('main');
    const module = { exports: {} as any };
    vm.runInNewContext(code, {
      module,
      exports: module.exports,
      document: {
        createElement: (tag: string) => new Element(tag),
        createElementNS: (_namespace: string, tag: string) => new Element(tag),
        querySelector: (selector: string) =>
          selector.endsWith('.transcription-tabs') ? tabs : panes,
        getElementById: (id: string) =>
          [...descendants(tabs), ...descendants(panes)].find((node) => node.id === id) ?? null,
      },
    });
    return { tabs, panes, render: module.exports.renderRecordingHints };
  }
  it('keeps legacy recordings readable and preserves the keyboard tab target on async refresh', () => {
    const { tabs, panes, render } = fixture();
    render();
    const button = tabs.children[0];
    assert.equal(button.type, 'button');
    assert.equal(button.textContent, 'AI 힌트');
    assert.match(
      descendants(panes)
        .map((node) => node.textContent)
        .join(' '),
      /저장된 AI 힌트가 없습니다/,
    );
    render(undefined, 'Loading saved AI hints...');
    assert.equal(tabs.children[0], button);
    assert.equal(tabs.children.length, 1);
    assert.match(
      descendants(panes)
        .map((node) => node.textContent)
        .join(' '),
      /불러오는 중/,
    );
  });
  it('orders across sessions in recording time and keeps unsafe text literal with source and prior-version warnings', () => {
    const { panes, render } = fixture();
    const hint = {
      kind: 'action',
      title: '<img onerror=boom>',
      text: 'Proposal',
      sourceState: 'retracted',
      offsetMs: 2000,
      sources: [{ offsetMs: 1000, text: 'source', uncertain: true }],
      history: [{ producedOffsetMs: 500, text: 'Earlier', sourceState: 'draft', sources: [] }],
    };
    render({
      sessions: [
        { recordingOffsetMs: 60000, hints: [hint] },
        { recordingOffsetMs: 0, hints: [{ ...hint, title: 'First', history: [] }] },
      ],
    });
    const all = descendants(panes);
    const summaries = all.filter((node) => node.tag === 'summary').map((node) => node.textContent);
    assert.equal(summaries[0], 'First자막 수정0:02');
    assert.ok(summaries.includes('<img onerror=boom>자막 수정1:02'));
    assert.ok(
      all.some(
        (node) =>
          node.tag === 'summary' &&
          node.attributes['aria-label'] === '<img onerror=boom>, 자막 수정, 1:02',
      ),
    );
    const words = all.map((node) => node.textContent).join(' ');
    assert.match(words, /1:01 · 자막이 불확실할 수 있음/);
    assert.match(words, /원문 자막이 정정/);
    assert.match(words, /이전 문구/);
    assert.match(words, /확정 전 자막/);
    assert.ok(all.some((node) => node.className === 'recording-hint-correction'));
    assert.equal(
      all.some((node) => node.tag === 'img'),
      false,
    );
  });
  it('shows persistent incomplete-history notice for recording or session truncation', () => {
    for (const history of [
      { truncated: true, sessions: [] },
      { sessions: [{ truncated: true, recordingOffsetMs: 0, hints: [] }] },
    ]) {
      const { panes, render } = fixture();
      render(history);
      const notice = descendants(panes).find((node) => node.className === 'recording-hints-notice');
      assert.ok(notice);
      assert.match(notice.textContent, /이 목록은 일부만 표시됩니다/);
      assert.equal(panes.children[0].children.includes(notice), true);
    }
  });
  it('distinguishes source grounding, external knowledge, and AI suggestions', () => {
    const { panes, render } = fixture();
    render({
      sessions: [
        {
          recordingOffsetMs: 0,
          hints: [
            {
              kind: 'term',
              text: 'Definition',
              offsetMs: 0,
              sources: [],
              sourceState: 'final',
              basis: ['transcript', 'model-knowledge', 'suggestion'],
            },
          ],
        },
      ],
    });
    const words = descendants(panes)
      .map((node) => node.textContent)
      .join(' ');
    assert.match(words, /대화 내용 기반/);
    assert.match(words, /일반 지식 기반 · 실제 대화와 맞는지 확인하세요/);
    assert.match(words, /AI 제안/);
  });
  it('keeps existing source controls connected when the same recording history is populated again', () => {
    const { panes, render } = fixture();
    const history = {
      sessions: [
        {
          recordingOffsetMs: 0,
          hints: [
            {
              kind: 'term',
              text: 'Definition',
              offsetMs: 0,
              sourceState: 'final',
              basis: ['transcript'],
              sources: [{ ref: 's1', text: 'Original', offsetMs: 0 }],
            },
          ],
        },
      ],
    };
    render(history);
    const pane = panes.children[0];
    const controls = [...pane.children];
    render(history);
    assert.equal(panes.children[0], pane);
    assert.deepEqual(pane.children, controls);
  });
});
