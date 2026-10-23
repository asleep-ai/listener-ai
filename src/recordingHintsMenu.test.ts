import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import * as path from 'node:path';
import * as vm from 'node:vm';

class Node {
  children: Node[] = [];
  className = '';
  dataset: Record<string, string> = {};
  style = { setProperty() {} };
  listeners = new Map<string, Array<(event: any) => void>>();
  append(...nodes: Node[]) {
    this.children.push(...nodes);
  }
  appendChild(node: Node) {
    this.append(node);
  }
  setAttribute() {}
  hidePopover() {}
  addEventListener(name: string, handler: (event: any) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), handler]);
  }
  querySelectorAll(selector: string): Node[] {
    return this.children.flatMap((node) => [
      ...(node.className.split(' ').includes(selector.slice(1)) ? [node] : []),
      ...node.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  click() {
    for (const handler of this.listeners.get('click') ?? []) handler({ stopPropagation() {} });
  }
}
let code: string;
before(async () => {
  const { build } = require('vite');
  const output = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry: path.resolve('renderer/ui/recordings-list.ts'), formats: ['cjs'] },
      rollupOptions: { external: (id: string) => !path.isAbsolute(id) },
    },
  });
  code = output[0].output.find((chunk: any) => chunk.type === 'chunk').code;
});
test('recording More menu wires the actual AI hint action before row insertion', async () => {
  for (const metadata of [
    { liveHints: {} },
    { transcript: 'Saved transcript', summary: 'Saved summary', liveHints: {} },
  ]) {
    const opened: unknown[][] = [];
    const dependencies = {
      activeJobForPath: () => undefined,
      showRecordingHints: (...args: unknown[]) => opened.push(args),
    };
    const module = { exports: {} as any };
    vm.runInNewContext(code, {
      module,
      exports: module.exports,
      require: () => dependencies,
      document: { createElement: () => new Node(), createTextNode: () => new Node() },
      window: { electronAPI: { getMetadata: async () => ({ success: true, data: metadata }) } },
    });
    const row: Node = await module.exports.createRecordingItem({
      path: '/audio.webm',
      title: 'Saved',
      createdAt: 0,
      size: 24,
    });
    row.querySelector('.view-hints-btn')!.click();
    assert.equal(opened.length, 1);
    assert.equal(opened[0][0], '/audio.webm');
    assert.equal(opened[0][2], 'transcript' in metadata ? metadata : undefined);
  }
});
