// Unit tests for the Markdown tree (src/apps/ai-agent/markdown.js): markdownTree is pure and
// DOM-free, so the whole allowlist and every refusal (no a/img/script from hostile text) is
// checkable in Node. renderMarkdown walks the same tree; the browser spec covers the DOM walk.
// Run: node --test tests/ai-agent-markdown.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownTree } from '../src/apps/ai-agent/markdown.js';

const tags = (nodes, out = []) => {
  for (const node of nodes ?? []) {
    if (node.tag) out.push(node.tag);
    tags(node.children, out);
  }
  return out;
};

test('bold then plain text: **Packet Viewer** (Developer)', () => {
  assert.deepEqual(markdownTree('**Packet Viewer** (Developer)'), [{ tag: 'p', children: [
    { tag: 'strong', children: [{ text: 'Packet Viewer' }] },
    { text: ' (Developer)' },
  ] }]);
});

test('a - list and a 1. list (ol keeps start only when it is not 1)', () => {
  assert.deepEqual(markdownTree('- a\n- b'), [{ tag: 'ul', children: [
    { tag: 'li', children: [{ tag: 'p', children: [{ text: 'a' }] }] },
    { tag: 'li', children: [{ tag: 'p', children: [{ text: 'b' }] }] },
  ] }]);
  assert.deepEqual(markdownTree('1. one\n2. two'), [{ tag: 'ol', children: [
    { tag: 'li', children: [{ tag: 'p', children: [{ text: 'one' }] }] },
    { tag: 'li', children: [{ tag: 'p', children: [{ text: 'two' }] }] },
  ] }]);
  const started = markdownTree('2. one')[0];
  assert.equal(started.tag, 'ol');
  assert.deepEqual(started.attrs, { start: '2' });
});

test('task list items get a checked or open box prefix', () => {
  assert.deepEqual(markdownTree('- [x] done\n- [ ] open'), [{ tag: 'ul', children: [
    { tag: 'li', children: [{ text: '☑ ' }, { tag: 'p', children: [{ text: 'done' }] }] },
    { tag: 'li', children: [{ text: '☐ ' }, { tag: 'p', children: [{ text: 'open' }] }] },
  ] }]);
});

test('a fenced js block is pre > code with class language-js, a bad lang gets no class', () => {
  assert.deepEqual(markdownTree('```js\nlet x = 1;\n```'), [{ tag: 'pre', children: [
    { tag: 'code', attrs: { class: 'language-js' }, children: [{ text: 'let x = 1;' }] },
  ] }]);
  assert.equal(markdownTree('```bad;lang x\nlet x;\n```')[0].children[0].attrs, undefined);
});

test('a gfm table becomes thead with th and tbody with td', () => {
  assert.deepEqual(markdownTree('| a | b |\n|---|---|\n| 1 | 2 |'), [{ tag: 'table', children: [
    { tag: 'thead', children: [{ tag: 'tr', children: [
      { tag: 'th', children: [{ text: 'a' }] },
      { tag: 'th', children: [{ text: 'b' }] },
    ] }] },
    { tag: 'tbody', children: [{ tag: 'tr', children: [
      { tag: 'td', children: [{ text: '1' }] },
      { tag: 'td', children: [{ text: '2' }] },
    ] }] },
  ] }]);
});

test('links: javascript: data: and mailto give no a for javascript/data; https gets rel and target', () => {
  assert.deepEqual(markdownTree('[x](javascript:alert(1))'), [{ tag: 'p', children: [{ text: 'x' }] }]);
  assert.deepEqual(markdownTree('[x](data:text/html,1)'), [{ tag: 'p', children: [{ text: 'x' }] }]);
  assert.deepEqual(markdownTree('[x](https://example.com)'), [{ tag: 'p', children: [{ tag: 'a', attrs: {
    href: 'https://example.com/', target: '_blank', rel: 'noopener noreferrer',
  }, children: [{ text: 'x' }] }] }]);
  assert.deepEqual(markdownTree('[x](mailto:a@b.c)'), [{ tag: 'p', children: [{ tag: 'a', attrs: {
    href: 'mailto:a@b.c', target: '_blank', rel: 'noopener noreferrer',
  }, children: [{ text: 'x' }] }] }]);
});

test('images never become img: http(s) get the [image: alt] text as a link, others as plain text', () => {
  const web = markdownTree('![alt](https://t.example/p.png)');
  assert.deepEqual(web, [{ tag: 'p', children: [{ tag: 'a', attrs: {
    href: 'https://t.example/p.png', target: '_blank', rel: 'noopener noreferrer',
  }, children: [{ text: '[image: alt]' }] }] }]);
  const file = markdownTree('![alt](file:///x.png)');
  assert.deepEqual(file, [{ tag: 'p', children: [{ text: '[image: alt]' }] }]);
  assert.ok(!tags(web).includes('img'), 'no img for the web image');
});

test('html tags come out as text nodes, never as elements', () => {
  assert.deepEqual(markdownTree('<img src=x onerror=alert(1)>'), [{ text: '<img src=x onerror=alert(1)>' }]);
  const inline = markdownTree('say <script>hi</script> now');
  assert.deepEqual(inline, [{ tag: 'p', children: [
    { text: 'say ' }, { text: '<script>' }, { text: 'hi' }, { text: '</script>' }, { text: ' now' },
  ] }]);
  const found = new Set(tags(inline));
  for (const forbidden of ['img', 'script', 'a']) assert.ok(!found.has(forbidden), `no ${forbidden} element`);
});

test('headings map to h3, h4, h5 (the panel is narrow)', () => {
  assert.deepEqual(markdownTree('# one\n## two\n### three\n#### four\n###### six').map(n => n.tag),
    ['h3', 'h3', 'h4', 'h5', 'h5']);
});

test('a cut-off answer and an unclosed fence parse without throwing', () => {
  assert.doesNotThrow(() => markdownTree('- **About'));
  assert.doesNotThrow(() => markdownTree('```\nlet a ='));
  assert.deepEqual(markdownTree('- **About'), [{ tag: 'ul', children: [
    { tag: 'li', children: [{ tag: 'p', children: [{ text: '**About' }] }] },
  ] }]);
});

test('pathologically deep nesting (5000 blockquotes) returns without throwing', () => {
  assert.doesNotThrow(() => markdownTree('> '.repeat(5000) + 'deep'));
});

test('reference links, definitions and footnotes keep their text only', () => {
  assert.deepEqual(markdownTree('[ref][x]\n\n[x]: https://example.com'), [{ tag: 'p', children: [{ text: 'ref' }] }]);
});
