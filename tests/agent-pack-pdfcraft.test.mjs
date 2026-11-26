// Unit tests for the PdfCraft pack: agent/apps/pdfcraft/tools.js and skills.md.
// A fake ctx.craft records calls; every tool must send the exact engine command id and wire
// params that storytold/pdfcraft@v0.21.1 crates/automation/src/tools.rs dispatches (.cmd() table).
// The schema and skills checks reuse the real runtime validators, with the choices function
// that scripts/agent/build.mjs builds the catalog with.
// Run: node --test tests/agent-pack-pdfcraft.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack, tools, usesCommands, usesMethods, labelPdfPages } from '../agent/apps/pdfcraft/tools.js';
import { tools as desktopTools } from '../agent/desktop/tools.js';
import { ToolError, specErrors, checkArgs, callLine } from '../src/apps/ai-agent/runtime/args.mjs';
import { parseSkills, checkSkills } from '../src/apps/ai-agent/runtime/skills.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_MD = readFileSync(join(HERE, '..', 'agent', 'apps', 'pdfcraft', 'skills.md'), 'utf8');
const APP_IDS = ['pdfcraft'];
const choices = name => (name === 'apps' ? APP_IDS : []);
const byName = name => tools.find(tool => tool.name === name) ?? desktopTools.find(tool => tool.name === name);

// The live command list, shaped like the craft-web-api commands() reply.
const COMMANDS = [
  { id: 'file.properties', label: 'Document Properties', menu: 'File', params: 'doc', shortcut: '', enabled: true },
  { id: 'page.rotate', label: 'Rotate Pages', menu: 'Page', params: 'doc, degrees', shortcut: '', enabled: true },
  { id: 'page.delete', label: 'Delete Pages', menu: 'Page', params: 'doc, pages', shortcut: '', enabled: true },
  { id: 'edit.find', label: 'Find Text', menu: 'Edit', params: 'doc, query', shortcut: '', enabled: true },
  { id: 'file.save', label: 'Save', menu: 'File', params: 'doc', shortcut: '', enabled: true },
];
// A fake app API at the ctx.craft level, recording the unified calls the tools make.
const fakeCraft = () => {
  const calls = [];
  const rec = (name, make = () => ({})) => (...args) => { calls.push([name, ...args]); return Promise.resolve(make(...args)); };
  return {
    calls,
    request: rec('request', (method, params) => ({ method, params })),
    execute: rec('execute', (command, params) => ({ command, params })),
    commands: rec('commands', () => COMMANDS),
    inspect: rec('inspect', () => ({ document: 'report.pdf', pages: 3 })),
    screenshot: rec('screenshot', () => 'png-base64'),
  };
};
const runTool = (name, args, craft) => byName(name).run(args, { host: {}, craft: () => Promise.resolve(craft) });

test('the pack declares its id, title and live-check exports', () => {
  assert.deepEqual(pack, { id: 'pdfcraft', title: 'PdfCraft' });
  assert.deepEqual(usesCommands.sort(), ['edit.find', 'edit.link', 'edit.redo', 'edit.replace', 'edit.text', 'edit.undo', 'export.text', 'file.close', 'file.save', 'file.word_count', 'page.delete', 'page.duplicate', 'page.insert_blank', 'page.reverse', 'page.rotate'].sort());
  assert.deepEqual(usesMethods, ['ui.click', 'ui.inspect', 'ui.key']);
});

test('the pack exposes exactly the 22 pdfcraft tools', () => {
  assert.equal(tools.length, 22);
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'pdfcraft.command_list', 'pdfcraft.doc_close', 'pdfcraft.doc_info', 'pdfcraft.doc_inspect',
    'pdfcraft.doc_save', 'pdfcraft.edit_redo', 'pdfcraft.edit_undo', 'pdfcraft.link_add',
    'pdfcraft.open_file', 'pdfcraft.page_add_text', 'pdfcraft.page_delete', 'pdfcraft.page_duplicate',
    'pdfcraft.page_insert_blank', 'pdfcraft.page_reverse', 'pdfcraft.page_rotate', 'pdfcraft.read_text',
    'pdfcraft.run_command', 'pdfcraft.save_copy', 'pdfcraft.text_find', 'pdfcraft.text_replace',
    'pdfcraft.text_word_count', 'pdfcraft.ui_inspect',
  ]);
});

test('every tool has the required text fields, effect, needs and examples', () => {
  for (const tool of tools) {
    assert.match(tool.name, /^pdfcraft\.[a-z0-9_]+$/);
    assert.ok(tool.purpose.length > 0 && tool.purpose.length <= 80, `${tool.name} purpose is ${tool.purpose.length} chars`);
    assert.ok(tool.when.startsWith('Use when'), `${tool.name} when must start with "Use when"`);
    assert.ok(tool.when.length <= 120, `${tool.name} when is ${tool.when.length} chars`);
    assert.ok(['read', 'change', 'destructive', 'external'].includes(tool.effect), `${tool.name} bad effect`);
    const fileTools = ['pdfcraft.open_file', 'pdfcraft.save_copy'];
    assert.deepEqual(tool.needs, fileTools.includes(tool.name) ? ['host', 'app:pdfcraft', 'files'] : ['host', 'app:pdfcraft']);
    assert.equal(typeof tool.run, 'function');
    assert.ok(tool.examples.length >= 1, `${tool.name} has examples`);
    for (const example of tool.examples) {
      assert.ok(example.args && typeof example.args === 'object' && !Array.isArray(example.args));
      assert.equal(typeof example.says, 'string');
    }
  }
});

test('every parameter spec passes the runtime specErrors check', () => {
  for (const tool of tools) assert.deepEqual(specErrors(tool.params), [], `${tool.name} params`);
});

test('every example passes the runtime checkArgs the way the build runs it', () => {
  for (const tool of tools) {
    for (const [n, example] of tool.examples.entries()) {
      const out = checkArgs(tool, example.args, { choices });
      assert.ok(out.ok, `${tool.name} example ${n}: ${out.error?.message}`);
    }
  }
});

test('the effects follow the upstream destructive flags plus the close rule', () => {
  const reads = ['pdfcraft.doc_inspect', 'pdfcraft.doc_info', 'pdfcraft.text_word_count', 'pdfcraft.text_find', 'pdfcraft.command_list', 'pdfcraft.read_text', 'pdfcraft.ui_inspect'];
  for (const name of reads) assert.equal(byName(name).effect, 'read', name);
  for (const name of ['pdfcraft.page_delete', 'pdfcraft.doc_close', 'pdfcraft.doc_save']) assert.equal(byName(name).effect, 'destructive', name);
  for (const tool of tools) if (!reads.includes(tool.name) && tool.effect !== 'destructive') assert.equal(tool.effect, 'change', tool.name);
});

test('pdfcraft.doc_inspect calls the adapter inspect (ui.state on the page)', async () => {
  const craft = fakeCraft();
  assert.deepEqual(await runTool('pdfcraft.doc_inspect', {}, craft), { document: 'report.pdf', pages: 3 });
  assert.deepEqual(craft.calls, [['inspect']]);
});

test('pdfcraft.ui_inspect reads the page ui.inspect method (the a11y tree)', async () => {
  const craft = fakeCraft();
  assert.deepEqual(await runTool('pdfcraft.ui_inspect', {}, craft), { method: 'ui.inspect', params: {} });
  assert.deepEqual(craft.calls, [['request', 'ui.inspect', {}]]);
});

test('the read tools send their engine command ids (doc_info reads the page state, no params)', async () => {
  const craft = fakeCraft();
  await runTool('pdfcraft.doc_info', {}, craft);
  await runTool('pdfcraft.text_word_count', { pages: '1-2' }, craft);
  await runTool('pdfcraft.text_find', { query: 'invoice', limit: 10 }, craft);
  assert.deepEqual(craft.calls, [
    ['inspect'], // the live file.properties only opens the Properties dialog (lead live check), so doc_info reads ui.state
    ['execute', 'file.word_count', { pages: '1-2' }],
    ['execute', 'edit.find', { query: 'invoice', limit: 10 }],
  ]);
});

// b21 pdfcraft-02: the app answered edit.find with { ran } only (no match details), a
// dead end the model looped on; the tool then points at read_text. A rich reply with
// match details passes through unchanged.
test('text_find notes the thin app reply and points at read_text', async () => {
  const thin = fakeCraft();
  thin.execute = (command, params) => Promise.resolve(command === 'edit.find' ? { ran: 'edit.find' } : { command, params });
  const out = await runTool('pdfcraft.text_find', { query: 'review' }, thin);
  assert.equal(out.ran, 'edit.find');
  assert.match(out.note, /read_text/);
  const rich = fakeCraft();
  rich.execute = (command, params) => Promise.resolve({ ran: 'edit.find', pages: [1] });
  const out2 = await runTool('pdfcraft.text_find', { query: 'review' }, rich);
  assert.equal(out2.note, undefined, 'a rich reply with match details gets no note');
});

test('the page tools send their engine command ids', async () => {
  const craft = fakeCraft();
  await runTool('pdfcraft.page_rotate', { degrees: 90 }, craft);
  await runTool('pdfcraft.page_reverse', { pages: '1-5' }, craft);
  await runTool('pdfcraft.page_insert_blank', { at: 2 }, craft);
  await runTool('pdfcraft.page_duplicate', { pages: '1', at: 3 }, craft);
  await runTool('pdfcraft.page_delete', { pages: '3' }, craft);
  await runTool('pdfcraft.edit_undo', {}, craft);
  await runTool('pdfcraft.edit_redo', {}, craft);
  await runTool('pdfcraft.doc_close', { discard_changes: true }, craft);
  await runTool('pdfcraft.doc_save', { flatten_fill_sign: true }, craft);
  assert.deepEqual(craft.calls, [
    ['execute', 'page.rotate', { degrees: 90 }],
    ['execute', 'page.reverse', { pages: '1-5' }],
    ['inspect'],
    ['execute', 'page.insert_blank', { at: 2 }],
    ['inspect'],
    ['execute', 'page.duplicate', { pages: '1', at: 3 }],
    ['execute', 'page.delete', { pages: '3' }],
    ['execute', 'edit.undo', {}],
    ['execute', 'edit.redo', {}],
    ['execute', 'file.close', { discard_changes: true }],
    ['inspect', undefined],
    ['execute', 'file.save', { flatten_fill_sign: true }],
  ]);
});

// b14 live (pdfcraft-09, both reps): file.close answered ok, doc_info still showed the
// document active and page ops kept working. The close cannot be made real from the pack
// (prebuilt engine), so doc_close verifies the post-condition and fails honestly
// (lead ruling) instead of reporting a close that did not happen.
test('pdfcraft.doc_close fails honestly when the document is still open after file.close', async () => {
  const craft = fakeCraft();
  craft.inspect = async () => ({ documents: [{ active: true, doc: 1, name: 'report-q3.pdf', pages: 3 }] });
  await assert.rejects(runTool('pdfcraft.doc_close', { doc: 1, discard_changes: true }, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'app_error');
    assert.match(error.message, /the app answered ok but the document is still open \("report-q3\.pdf"\)/);
    assert.match(error.message, /Do not retry doc_close/);
    return true;
  });
  assert.deepEqual(craft.calls.at(-1), ['execute', 'file.close', { doc: 1, discard_changes: true }]);
});

test('pdfcraft.doc_close returns the result when the document is actually gone', async () => {
  const craft = fakeCraft();
  craft.inspect = async () => ({ documents: [] });
  const out = await runTool('pdfcraft.doc_close', { discard_changes: true }, craft);
  assert.equal(out.command, 'file.close');
  // b17 pdfcraft-08: the note says up front what a mid-task close costs.
  assert.match(out.note, /the document is now closed/);
  assert.match(out.note, /save a copy with pdfcraft.save_copy before closing/);
});

// A craft fake for the edit tools' read-after-write: each confirmed export pops the next
// text from the queue (the read before and after the edit command), so a no-op edit (the
// same text twice) and a landed edit (different text) are both testable.
const editCraft = (wrapper, texts) => {
  const calls = [];
  const queue = [...texts];
  let dialogOpen = false;
  const fireExport = text => wrapper.fire({
    origin: 'https://pc.example', source: wrapper.frame,
    data: { type: 'pdfcraft:save', name: 'report-q3.txt', bytes: new TextEncoder().encode(text ?? '') },
  });
  const api = {
    commands: () => Promise.resolve([]),
    execute: (id, params) => {
      calls.push(['execute', id, params]);
      if (id === 'export.text') dialogOpen = true;
      return Promise.resolve({ ran: id });
    },
    request: (method, params) => {
      calls.push(['request', method, params]);
      if (method === 'ui.key') { dialogOpen = false; fireExport(queue.shift()); }
      if (method === 'ui.inspect') return Promise.resolve({ children: [] });
      return Promise.resolve({ ok: true });
    },
    inspect: () => { calls.push(['inspect']); return Promise.resolve({ dialog: dialogOpen ? 'Export(Text)' : null }); },
  };
  return { calls, craft: () => Promise.resolve(api) };
};
const editCtx = (wrapper, ec) => ({ host: { appWindow: async () => wrapper }, craft: ec.craft });

test('page_add_text turns x and y into the at point of edit.text', async () => {
  const wrapper = fakeWrapper();
  const ec = editCraft(wrapper, ['page one text', 'page one text CONFIDENTIAL']);
  await byName('pdfcraft.page_add_text').run({ page: 1, text: 'CONFIDENTIAL', x: 50, y: 50, size: 24, bold: true }, editCtx(wrapper, ec));
  const edit = ec.calls.find(c => c[0] === 'execute' && c[1] === 'edit.text');
  assert.deepEqual(edit[2], { page: 1, text: 'CONFIDENTIAL', size: 24, bold: true, at: [50, 50] });
});

test('text_replace re-reads the export around the edit and gives a teaching error on a silent no-op', async () => {
  const wrapper = fakeWrapper();
  const ec = editCraft(wrapper, ['Quarterly report Q3 2026', 'Quarterly report Q3 2026']);
  await assert.rejects(byName('pdfcraft.text_replace').run({ find: '2026', replace: '2027' }, editCtx(wrapper, ec)), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'app_error');
    assert.match(error.message, /exported text is unchanged/);
    assert.match(error.message, /does not apply find-and-replace/);
    assert.match(error.message, /instead of retrying/);
    return true;
  });
  // the export-read, the edit, the export-read, in that order
  assert.deepEqual(ec.calls.filter(c => c[0] === 'execute').map(c => c[1]), ['export.text', 'edit.replace', 'export.text']);
});

test('page_add_text gives the same teaching error when the added text does not land', async () => {
  const wrapper = fakeWrapper();
  const ec = editCraft(wrapper, ['page one text', 'page one text']);
  await assert.rejects(byName('pdfcraft.page_add_text').run({ page: 1, text: 'CONFIDENTIAL' }, editCtx(wrapper, ec)), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'app_error');
    assert.match(error.message, /does not apply added page text/);
    return true;
  });
});

test('the edit tools return the ran result when the edit lands in the export', async () => {
  const wrapper = fakeWrapper();
  const replace = editCraft(wrapper, ['Quarterly report Q3 2026', 'Quarterly report Q3 2027']);
  assert.deepEqual(await byName('pdfcraft.text_replace').run({ find: '2026', replace: '2027' }, editCtx(wrapper, replace)), { ran: 'edit.replace' });
  const wrapper2 = fakeWrapper();
  const add = editCraft(wrapper2, ['page one text', 'page one text CONFIDENTIAL']);
  assert.deepEqual(await byName('pdfcraft.page_add_text').run({ page: 1, text: 'CONFIDENTIAL' }, editCtx(wrapper2, add)), { ran: 'edit.text' });
});

test('link_add coerces the flat rect to numbers and rejects a bad rect', async () => {
  const craft = fakeCraft();
  await runTool('pdfcraft.link_add', { page: 1, rect: ['50', '50', '200', '70'], url: 'https://example.com' }, craft);
  assert.deepEqual(craft.calls, [['execute', 'edit.link', { page: 1, url: 'https://example.com', rect: [50, 50, 200, 70] }]]);
  await assert.rejects(runTool('pdfcraft.link_add', { page: 1, rect: ['50', 'x', '200', '70'] }, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.match(error.message, /rect must be 4 numbers/);
    return true;
  });
});

test('pdfcraft.command_list returns the top 10 matches by id or label', async () => {
  const craft = fakeCraft();
  const byLabel = await runTool('pdfcraft.command_list', { query: 'rotate' }, craft);
  assert.deepEqual(byLabel, [{ id: 'page.rotate', label: 'Rotate Pages', menu: 'Page', params: 'doc, degrees' }]);
  const all = await runTool('pdfcraft.command_list', {}, craft);
  assert.equal(all.length, 5);
  assert.ok(!('enabled' in all[0]));
});

test('pdfcraft.run_command parses key=value lines with coercion and checks the id', async () => {
  const craft = fakeCraft();
  await runTool('pdfcraft.run_command', { command: 'page.rotate', params: 'degrees=180' }, craft);
  assert.deepEqual(craft.calls, [['commands'], ['execute', 'page.rotate', { degrees: 180 }]]);
});

test('pdfcraft.run_command rejects an unknown id with invalid_argument and the 3 closest', async () => {
  const craft = fakeCraft();
  await assert.rejects(runTool('pdfcraft.run_command', { command: 'page.rotat' }, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.match(error.message, /unknown command "page.rotat"; closest: page.rotate/);
    assert.equal(error.fix, callLine('pdfcraft.run_command', { command: 'page.rotate' }));
    return true;
  });
});

test('effectFor marks the destructive command ids for run_command', () => {
  const run = byName('pdfcraft.run_command');
  assert.equal(run.effectFor({ command: 'file.close' }), 'destructive');
  assert.equal(run.effectFor({ command: 'file.save' }), 'destructive');
  assert.equal(run.effectFor({ command: 'page.delete' }), 'destructive');
  assert.equal(run.effectFor({ command: 'page.rotate' }), 'change');
});

test('a disabled-right-now rejection (the no-document gate) becomes the teaching ToolError', async () => {
  const noDoc = () => Promise.reject(Object.assign(new Error('file.word_count is disabled right now'), { code: 'app_error' })); // the adapter sets the code
  const craft = fakeCraft();
  craft.execute = () => noDoc();
  await assert.rejects(runTool('pdfcraft.text_word_count', { pages: '1-2' }, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    assert.equal(error.message, 'PDFCraft has no document open.');
    // The fix is a copyable open_file call (b14 pdfcraft-08: prose advice and the file
    // never opened before the round cap); the path placeholder is house style for fixes.
    assert.equal(error.fix, 'call_tool tool=pdfcraft.open_file path=<path>');
    return true;
  });
  const runner = fakeCraft(); // the generic run_command path teaches the same way
  runner.execute = () => Promise.reject(Object.assign(new Error('page.rotate is disabled right now'), { code: 'app_error' }));
  await assert.rejects(runTool('pdfcraft.run_command', { command: 'page.rotate' }, runner), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    assert.equal(error.fix, 'call_tool tool=pdfcraft.open_file path=<path>');
    return true;
  });
});

// A fake wrapper window for the file tools: the #file input records the change dispatch
// (openFromBytes drives it, app.mjs:38), message listeners are stored so a test can fire
// the <id>:save event the wrapper would hear from the editor frame.
const fakeWrapper = () => {
  const opened = [];
  const fileInput = { files: null, dispatchEvent: event => { if (event?.type === 'change') opened.push(fileInput.files?.[0] ?? null); } };
  class DataTransfer {
    constructor() { this._files = []; this.items = { add: file => this._files.push(file) }; }
    get files() { return this._files; }
  }
  class File {
    constructor(parts, name) { this.parts = parts; this.name = name; }
  }
  class Event {
    constructor(type) { this.type = type; }
  }
  const editor = { contentWindow: {} };
  const listeners = new Set();
  return {
    opened,
    DataTransfer, File, Event,
    document: { getElementById: id => (id === 'file' ? fileInput : id === 'editor' ? editor : null) },
    location: { origin: 'https://pc.example' },
    addEventListener: (type, fn) => { if (type === 'message') listeners.add(fn); },
    removeEventListener: (type, fn) => { if (type === 'message') listeners.delete(fn); },
    frame: editor.contentWindow,
    fire: event => { for (const fn of [...listeners]) fn(event); },
  };
};
const fileCtx = (bytes, wrapper) => {
  const calls = { read: [], write: [] };
  return {
    calls,
    host: { appWindow: async () => wrapper },
    craft: () => Promise.resolve(fakeCraft()),
    files: {
      readBytes: path => { calls.read.push(path); return Promise.resolve({ path, name: 'contract.pdf', bytes, size: bytes.byteLength }); },
      writeBytes: (path, b, { overwrite } = {}) => { calls.write.push({ path, size: b.byteLength, overwrite }); return Promise.resolve({ path, size: b.byteLength, created: !overwrite }); },
    },
  };
};
// A craft factory whose file.save fires the wrapper save, recording the call. commands()
// answers without file.saveBytes, so the save goes the capture path.
const saveFiringCraft = wrapper => {
  const calls = [];
  const api = {
    commands: () => Promise.resolve([]),
    execute: (id, params) => {
      calls.push([id, params]);
      if (id === 'file.save') {
        wrapper.fire({ origin: 'https://pc.example', source: wrapper.frame, data: { type: 'pdfcraft:save', name: 'contract.pdf', bytes: new Uint8Array([3]) } });
      }
      return Promise.resolve({ command: id, params });
    },
  };
  return { calls, craft: () => Promise.resolve(api) };
};

test('pdfcraft.open_file reads the file, waits for the PDF to load, and returns the opened summary', async () => {
  const wrapper = fakeWrapper();
  const ctx = fileCtx(new Uint8Array([1, 2]), wrapper);
  const state = { tabs: [] };
  const input = wrapper.document.getElementById('file');
  const original = input.dispatchEvent;
  input.dispatchEvent = event => { if (event?.type === 'change') state.tabs = ['contract.pdf']; return original(event); };
  ctx.craft = () => Promise.resolve({ ...fakeCraft(), inspect: async () => ({ ...state }) });
  const out = await byName('pdfcraft.open_file').run({ path: '/PDFCraft/contract.pdf' }, ctx);
  assert.deepEqual(ctx.calls.read, ['/PDFCraft/contract.pdf']);
  assert.equal(wrapper.opened.length, 1);
  assert.equal(wrapper.opened[0].name, 'contract.pdf');
  assert.deepEqual(out, { name: 'contract.pdf', bytes: 2, opened: '1 tab', next: 'contract.pdf is open. To check it, call pdfcraft.inspect. Opening it again shows a dialog and blocks the app.' });
});

test('pdfcraft.save_copy starts the no-path file.save and writes the captured bytes', async () => {
  const wrapper = fakeWrapper();
  const ctx = fileCtx(new Uint8Array([1]), wrapper);
  const save = saveFiringCraft(wrapper);
  ctx.craft = save.craft;
  const out = await byName('pdfcraft.save_copy').run({ path: '/PDFCraft/contract.pdf' }, ctx);
  assert.deepEqual(save.calls, [['file.save', {}]]);
  assert.deepEqual(ctx.calls.write, [{ path: '/PDFCraft/contract.pdf', size: 1, overwrite: false }]);
  assert.deepEqual(out, { path: '/PDFCraft/contract.pdf', name: 'contract.pdf', size: 1, created: true, note: 'the app also downloaded the file in the browser' });
});

test('pdfcraft.save_copy is destructive only when overwrite is set', () => {
  const tool = byName('pdfcraft.save_copy');
  assert.equal(tool.effect, 'change');
  assert.equal(tool.effectFor({ overwrite: true }), 'destructive');
  assert.equal(tool.effectFor({}), 'change');
});

test('pdfcraft.save_copy with no document open surfaces the open-a-PDF teaching error', async () => {
  const wrapper = fakeWrapper();
  const ctx = fileCtx(new Uint8Array([1]), wrapper);
  ctx.craft = () => Promise.resolve({
    commands: () => Promise.resolve([]),
    execute: () => Promise.reject(Object.assign(new Error('file.save is disabled right now'), { code: 'app_error' })),
  });
  await assert.rejects(byName('pdfcraft.save_copy').run({ path: '/PDFCraft/contract.pdf' }, ctx), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    assert.equal(error.message, 'PDFCraft has no document open.');
    assert.equal(error.fix, 'call_tool tool=pdfcraft.open_file path=<path>');
    return true;
  });
});

// A craft fake for read_text: export.text opens the dialog, Enter may or may not close it
// (enterCloses), a ui.click fires the wrapper save (the confirmed export downloads), and
// inspect answers ui.state with the dialog field. The tree feeds the click fallback.
const readTextCraft = (wrapper, { enterCloses = true, tree = null, empty = false } = {}) => {
  const calls = [];
  let dialogOpen = false;
  const fireSave = () => wrapper.fire({
    origin: 'https://pc.example', source: wrapper.frame,
    data: { type: 'pdfcraft:save', name: 'report-q3.txt', bytes: empty ? new Uint8Array(0) : new Uint8Array([72, 105]) },
  });
  const api = {
    commands: () => Promise.resolve([]),
    execute: (id, params) => {
      calls.push(['execute', id, params]);
      if (id === 'export.text') dialogOpen = true;
      return Promise.resolve({ ran: id });
    },
    request: (method, params) => {
      calls.push(['request', method, params]);
      if (method === 'ui.key' && enterCloses) { dialogOpen = false; fireSave(); }
      if (method === 'ui.click') { dialogOpen = false; fireSave(); }
      if (method === 'ui.inspect') return Promise.resolve(tree ?? { children: [] });
      return Promise.resolve({ ok: true });
    },
    inspect: () => { calls.push(['inspect']); return Promise.resolve({ dialog: dialogOpen ? 'Export(Text)' : null }); },
  };
  return { calls, craft: () => Promise.resolve(api) };
};

test('pdfcraft.read_text confirms the export dialog with Enter and returns the captured text', async () => {
  const wrapper = fakeWrapper();
  const rt = readTextCraft(wrapper, { enterCloses: true });
  const out = await byName('pdfcraft.read_text').run({}, { host: { appWindow: async () => wrapper }, craft: rt.craft });
  assert.deepEqual(out, { name: 'report-q3.txt', text: 'Hi' });
  assert.deepEqual(rt.calls.filter(c => c[0] === 'execute'), [['execute', 'export.text', {}]]);
  assert.ok(rt.calls.some(c => c[0] === 'request' && c[1] === 'ui.key' && c[2].key === 'Enter'), 'Enter is sent');
  assert.ok(!rt.calls.some(c => c[0] === 'request' && c[1] === 'ui.click'), 'no click when Enter closed the dialog');
});

test('pdfcraft.read_text confirms the open dialog through the channel label lookup when Enter leaves it open', async () => {
  const wrapper = fakeWrapper();
  const tree = { root: { children: [{ role: 'button', label: 'Export', rect: [10, 20, 80, 30] }] } };
  const rt = readTextCraft(wrapper, { enterCloses: false, tree });
  const out = await byName('pdfcraft.read_text').run({}, { host: { appWindow: async () => wrapper }, craft: rt.craft });
  assert.deepEqual(out, { name: 'report-q3.txt', text: 'Hi' });
  const click = rt.calls.find(c => c[0] === 'request' && c[1] === 'ui.click');
  assert.ok(click, 'the Export button is clicked');
  assert.deepEqual(click[2], { label: 'Export' }, 'the channel resolves the label through AccessKit');
});

test('pdfcraft.read_text clicks by widget id when the a11y tree carries ids', async () => {
  const wrapper = fakeWrapper();
  const tree = { widgets: [{ id: 'w-123', label: 'Export', rect: [10, 20, 80, 30] }] };
  const rt = readTextCraft(wrapper, { enterCloses: false, tree });
  await byName('pdfcraft.read_text').run({}, { host: { appWindow: async () => wrapper }, craft: rt.craft });
  const click = rt.calls.find(c => c[0] === 'request' && c[1] === 'ui.click');
  assert.deepEqual(click[2], { id: 'w-123' }, 'the exact widget id wins over the label lookup');
});

test('pdfcraft.read_text with a dialog the tree has no button in fails with the labels it did see', async () => {
  const wrapper = fakeWrapper();
  const rt = readTextCraft(wrapper, { enterCloses: false, tree: { children: [{ role: 'label', label: 'Pages', rect: [0, 0, 10, 10] }] } });
  const orig = await rt.craft();
  // Make every ui.click fail, as the channel does when no widget matches:
  const wrapped = { ...orig, request: (method, params) => (method === 'ui.click' ? Promise.reject(new Error(`no widget named ${params.label}`)) : orig.request(method, params)) };
  await assert.rejects(byName('pdfcraft.read_text').run({}, { host: { appWindow: async () => wrapper }, craft: () => Promise.resolve(wrapped) }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'app_error');
    assert.match(error.message, /has no clickable button in its tree \(labels: Pages/);
    return true;
  });
});

test('pdfcraft.read_text on a text-free PDF gives the no-text teaching error', async () => {
  const wrapper = fakeWrapper();
  const rt = readTextCraft(wrapper, { enterCloses: true, empty: true });
  await assert.rejects(byName('pdfcraft.read_text').run({}, { host: { appWindow: async () => wrapper }, craft: rt.craft }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    assert.match(error.message, /no text to export/);
    return true;
  });
});

test('pdfcraft.read_text with no document open surfaces the open-a-PDF teaching error', async () => {
  const wrapper = fakeWrapper();
  const ctx = {
    host: { appWindow: async () => wrapper },
    craft: () => Promise.resolve({
      commands: () => Promise.resolve([]),
      execute: () => Promise.reject(Object.assign(new Error('export.text is disabled right now'), { code: 'app_error' })),
      request: () => Promise.reject(new Error('no request without a document')),
      inspect: () => Promise.resolve({ dialog: null }),
    }),
  };
  await assert.rejects(byName('pdfcraft.read_text').run({}, ctx), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    assert.equal(error.message, 'PDFCraft has no document open.');
    assert.equal(error.fix, 'call_tool tool=pdfcraft.open_file path=<path>');
    return true;
  });
});

const { skills, errors: skillErrors } = parseSkills(SKILLS_MD, 'pdfcraft');

test('skills.md parses with the runtime parser without errors and has 12 skills', () => {
  assert.deepEqual(skillErrors, []);
  assert.equal(skills.length, 12);
  for (const skill of skills) {
    assert.ok(skill.slug && skill.summary, `skill ${skill.slug} slug/summary`);
    assert.ok(skill.summary.length <= 160, `skill ${skill.slug} summary is ${skill.summary.length} chars`);
    assert.ok(skill.keywords.length >= 5, `skill ${skill.slug} keywords: ${skill.keywords.join(', ')}`);
    assert.ok(skill.tools.length >= 1, `skill ${skill.slug} tools`);
    assert.ok(skill.when && skill.steps.length >= 1 && skill.check, `skill ${skill.slug} body sections`);
  }
});

test('every skill opens by launching PdfCraft, then uses numbered pdfcraft steps', () => {
  for (const skill of skills) {
    assert.equal(skill.steps[0].line, '1. call_tool tool=desktop.open_app app=pdfcraft', `skill ${skill.slug}`);
    skill.steps.forEach((step, i) => {
      assert.equal(step.n, i + 1, `skill ${skill.slug} step numbering`);
      assert.ok(step.tool.startsWith('desktop.') || step.tool.startsWith('pdfcraft.'), `skill ${skill.slug} step ${step.n}: ${step.line}`);
    });
  }
});

test('the edit skills check the open document in step 2 (doc_info), so a missing file is named before edits', () => {
  const bySlug = Object.fromEntries(skills.map(skill => [skill.slug, skill]));
  for (const slug of ['rotate-pages', 'delete-or-duplicate-pages', 'write-text-on-a-page', 'add-a-page-link', 'save-or-close-the-document', 'run-any-menu-command']) {
    assert.equal(bySlug[slug].steps[1].line, '2. call_tool tool=pdfcraft.doc_info', `skill ${slug}`);
  }
  assert.equal(bySlug['replace-text'].steps[1].line, '2. call_tool tool=pdfcraft.text_find query=2025', 'replace-text keeps its find check');
});

test('skill steps and tools lines validate against the runtime checkArgs', () => {
  const errors = checkSkills(skills, byName, { checkArgs: (tool, args) => checkArgs(tool, args, { choices }) });
  assert.deepEqual(errors, []);
});

// b17 sweep (pdfcraft-01/05/08/09): page-labeled reads, the past-the-end insert guard,
// the held-document no-doc error and the verified close note.

test('labelPdfPages cuts the fixture at the page content streams and labels the pages', () => {
  const raw = readFileSync(join(HERE, '..', 'tests', 'agent-eval', 'fixtures', 'report-q3.pdf'), 'utf8');
  assert.equal(labelPdfPages(raw), [
    '=== page 1 of 2 ===',
    'Quarterly report Q3 2026',
    'Revenue grew 14 percent over Q2.',
    'The North region led with 41 orders.',
    '=== page 2 of 2 ===',
    'Appendix',
    'Returns fell to 2.1 percent.',
    'Next review: 15 January 2027.',
  ].join('\n'));
});

test('labelPdfPages falls back to null for a non-PDF, a compressed stream and a truncated source', () => {
  assert.equal(labelPdfPages('plain text, no header'), null);
  const flate = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length 10 /Filter /FlateDecode >>\nstream\n0123456789\nendstream\nendobj';
  assert.equal(labelPdfPages(flate), null);
  assert.equal(labelPdfPages('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\ntruncated'), null);
});

test('page_insert_blank refuses a past-the-end position with the page count, and reports the new count', async () => {
  const craft = fakeCraft();
  let pages = 2;
  craft.inspect = async () => ({ documents: [{ active: true, doc: 1, name: 'report-q3.pdf', pages }] });
  // b17 pdfcraft-05: lfm3 read "at the end" as at=17 on a 2-page document.
  await assert.rejects(runTool('pdfcraft.page_insert_blank', { at: 17 }, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'invalid_argument');
    assert.match(error.message, /position 17 is past the end: the document has 2 pages/);
    assert.match(error.message, /at is 1\.\.3 \(3 appends the page at the end\)/);
    return true;
  });
  assert.equal(craft.calls.length, 0, 'the guard fires before any engine command');
  craft.execute = (command, params) => { craft.calls.push(['execute', command, params]); pages += 1; return Promise.resolve({ ran: command }); };
  const out = await runTool('pdfcraft.page_insert_blank', { at: 3 }, craft);
  assert.deepEqual(out, { ran: 'page.insert_blank', pages: 3 }, 'the end position runs and the result carries the new count');
  assert.deepEqual(craft.calls.at(-1), ['execute', 'page.insert_blank', { at: 3 }]);
});

test('a no-document refusal names the held documents so the model can pass doc=N', async () => {
  const craft = fakeCraft();
  craft.execute = () => Promise.reject(Object.assign(new Error('page.duplicate is disabled right now'), { code: 'app_error' }));
  craft.inspect = async () => ({ documents: [{ active: false, doc: 2, name: 'report-q3.pdf' }] });
  await assert.rejects(runTool('pdfcraft.page_duplicate', { pages: '1' }, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    assert.match(error.message, /no active document, but document 2 \(report-q3\.pdf\) is still in the app/);
    assert.match(error.message, /pass doc=2/);
    assert.equal(error.fix, 'call_tool tool=pdfcraft.open_file path=<path>');
    return true;
  });
});
