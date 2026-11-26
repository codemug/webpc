// Unit tests for the VectorCraft pack: agent/apps/vectorcraft/tools.js and skills.md.
// A fake ctx.craft records calls; every tool must send the exact control method and wire
// params that storytold/vectorcraft@v0.24.1 crates/mcp/src/tools/{definitions.rs,dispatch.rs,
// handlers.rs} dispatch. The schema and skills checks reuse the real runtime validators, with
// the choices function that scripts/agent/build.mjs builds the catalog with.
// Run: node --test tests/agent-pack-vectorcraft.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack, tools, usesCommands, usesMethods, parseStep } from '../agent/apps/vectorcraft/tools.js';
import { tools as desktopTools } from '../agent/desktop/tools.js';
import { ToolError, specErrors, checkArgs, callLine } from '../src/apps/ai-agent/runtime/args.mjs';
import { templateKeys } from '../src/apps/ai-agent/runtime/catalog.mjs';
import { parseSkills, checkSkills } from '../src/apps/ai-agent/runtime/skills.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_MD = readFileSync(join(HERE, '..', 'agent', 'apps', 'vectorcraft', 'skills.md'), 'utf8');
const APP_IDS = ['vectorcraft'];
const choices = name => (name === 'apps' ? APP_IDS : []);
const byName = name => tools.find(tool => tool.name === name) ?? desktopTools.find(tool => tool.name === name);

// The live command list, shaped like the craft-web-api commands() reply.
const COMMANDS = [
  { id: 'shape.rectangle', label: 'Rectangle', menu: 'Object', params: 'x, y, width, height, radius', shortcut: '', enabled: true },
  { id: 'shape.ellipse', label: 'Ellipse', menu: 'Object', params: 'x, y, width, height', shortcut: '', enabled: true },
  { id: 'object.align', label: 'Align', menu: 'Arrange', params: 'horizontal, vertical', shortcut: '', enabled: true },
  { id: 'object.delete', label: 'Delete', menu: 'Object', params: '', shortcut: '', enabled: true },
  { id: 'paint.setFill', label: 'Set Fill', menu: 'Paint', params: 'color, item', shortcut: '', enabled: true },
  { id: 'edit.undo', label: 'Undo', menu: 'Edit', params: '', shortcut: '', enabled: true },
];
// A fake app API at the ctx.craft level, recording the unified calls the tools make.
const fakeCraft = () => {
  const calls = [];
  const rec = (name, make = () => ({})) => (...args) => { calls.push([name, ...args]); return Promise.resolve(make(...args)); };
  return {
    calls,
    request: rec('request', (method, params) => ({ method, params })),
    execute: rec('execute', (command, params) => {
      if (command === 'command.batch') return { results: [{ id: 42 }, { id: 43 }] };
      if (command === 'effect.list') return { catalog: [{ id: 'stylize.dropShadow', params: {} }] };
      if (command === 'text.create') return { id: 7 };
      if (command === 'text.createInPath') return { id: 8, overflow: true };
      if (command === 'paint.setFill' || command === 'paint.setStroke' || command === 'stroke.set') return { objects: 2 };
      return { command, params };
    }),
    commands: rec('commands', () => COMMANDS),
    inspect: rec('inspect', () => ({ document: 'Drawing' })),
    screenshot: rec('screenshot', () => 'png-base64'),
  };
};
const runTool = (name, args, craft) => byName(name).run(args, { host: {}, craft: () => Promise.resolve(craft) });

test('the pack declares its id, title and live-check exports', () => {
  assert.deepEqual(pack, { id: 'vectorcraft', title: 'VectorCraft' });
  assert.deepEqual(usesCommands.sort(), [
    'command.batch', 'document.export', 'document.exportSelection', 'document.node', 'document.serialize', 'edit.redo', 'edit.undo',
    'effect.apply', 'effect.list', 'file.new', 'graph.create', 'object.move', 'object.pathfinder.crop', 'object.pathfinder.divide',
    'object.pathfinder.exclude', 'object.pathfinder.intersect', 'object.pathfinder.merge', 'object.pathfinder.minusBack',
    'object.pathfinder.minusFront', 'object.pathfinder.outline', 'object.pathfinder.trim', 'object.pathfinder.unite',
    'object.reflect', 'object.rotate', 'object.scale', 'object.shear', 'object.textWrap.make', 'object.textWrap.release',
    'paint.setFill', 'paint.setStroke', 'path.create', 'select.set', 'shape.ellipse', 'shape.line', 'shape.polygon',
    'shape.rectangle', 'shape.star', 'stroke.set', 'text.create', 'text.createInPath',
  ].sort());
  assert.deepEqual(usesMethods, ['document.inspect', 'ui.inspect', 'ui.tool.select', 'ui.key', 'ui.text', 'ui.set']);
});

test('the pack exposes exactly the 24 vectorcraft tools', () => {
  assert.equal(tools.length, 24);
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'vectorcraft.add_text', 'vectorcraft.apply_effect', 'vectorcraft.batch', 'vectorcraft.create_graph',
    'vectorcraft.draw_path', 'vectorcraft.draw_shape', 'vectorcraft.export', 'vectorcraft.inspect',
    'vectorcraft.list_commands', 'vectorcraft.new_document', 'vectorcraft.open_file', 'vectorcraft.open_panel', 'vectorcraft.pathfinder',
    'vectorcraft.press_key', 'vectorcraft.redo', 'vectorcraft.run_command', 'vectorcraft.save_copy', 'vectorcraft.select_tool',
    'vectorcraft.set_paint', 'vectorcraft.text_wrap', 'vectorcraft.transform', 'vectorcraft.type_text',
    'vectorcraft.ui_inspect', 'vectorcraft.undo',
  ]);
});

test('every tool has the required text fields, effect, needs and examples', () => {
  for (const tool of tools) {
    assert.match(tool.name, /^vectorcraft\.[a-z0-9_]+$/);
    assert.ok(tool.purpose.length > 0 && tool.purpose.length <= 80, `${tool.name} purpose is ${tool.purpose.length} chars`);
    assert.ok(tool.when.startsWith('Use when'), `${tool.name} when must start with "Use when"`);
    // run_command lists the destructive ids in when (the model must see them).
    if (tool.name !== 'vectorcraft.run_command') assert.ok(tool.when.length <= 120, `${tool.name} when is ${tool.when.length} chars`);
    assert.ok(['read', 'change', 'destructive', 'external'].includes(tool.effect), `${tool.name} bad effect`);
    const fileTools = ['vectorcraft.open_file', 'vectorcraft.save_copy'];
    assert.deepEqual(tool.needs, fileTools.includes(tool.name) ? ['host', 'app:vectorcraft', 'files'] : ['host', 'app:vectorcraft']);
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

// Small models copy the batch and run_command examples verbatim into the engine, so every
// example step must use param keys the engine's command list names for that command id.
test('batch and run_command examples use param keys the engine lists for the command', () => {
  const listed = new Map(COMMANDS.map(entry => [entry.id, entry.params.split(',').map(key => key.trim()).filter(Boolean)]));
  for (const tool of [byName('vectorcraft.batch'), byName('vectorcraft.run_command')]) {
    for (const [n, example] of tool.examples.entries()) {
      const lines = tool.name === 'vectorcraft.batch' ? example.args.commands : [`${example.args.command} ${example.args.params ?? ''}`];
      for (const line of lines) {
        const step = parseStep(line);
        assert.ok(step, `${tool.name} example ${n}: step ${line} must parse`);
        const keys = listed.get(step.command);
        if (!keys || keys.length === 0) continue; // no live param list for this id: nothing to check against
        const unknown = Object.keys(step.params).filter(key => !keys.includes(key));
        assert.deepEqual(unknown, [], `${tool.name} example ${n}: ${step.command} takes ${keys.join(', ')}; the example sends ${unknown.join(', ')}`);
      }
    }
  }
});

test('the effects are read for reads, destructive for pathfinder, change for the rest', () => {
  const reads = ['vectorcraft.inspect', 'vectorcraft.ui_inspect', 'vectorcraft.list_commands', 'vectorcraft.export'];
  for (const name of reads) assert.equal(byName(name).effect, 'read', name);
  assert.equal(byName('vectorcraft.pathfinder').effect, 'destructive');
  for (const tool of tools) if (!reads.includes(tool.name) && tool.name !== 'vectorcraft.pathfinder') assert.equal(tool.effect, 'change', tool.name);
});

test('inspect, ui_inspect, select_tool, press_key, type_text and open_panel send their wire calls', async () => {
  const craft = fakeCraft();
  await runTool('vectorcraft.inspect', { depth: 0, kind: 'shape' }, craft);
  await runTool('vectorcraft.ui_inspect', {}, craft);
  await runTool('vectorcraft.select_tool', { tool: 'pen' }, craft);
  await runTool('vectorcraft.press_key', { key: 'Z', cmd: true }, craft);
  await runTool('vectorcraft.type_text', { text: 'Hello' }, craft);
  await runTool('vectorcraft.open_panel', { panel: 'layers' }, craft);
  assert.deepEqual(craft.calls, [
    ['request', 'document.inspect', { depth: 0, kind: 'shape' }],
    ['request', 'ui.inspect', {}],
    ['request', 'ui.tool.select', { tool: 'pen' }],
    ['request', 'ui.key', { key: 'Z', cmd: true }],
    ['request', 'ui.text', { text: 'Hello' }],
    ['request', 'ui.set', { panel: 'layers' }],
  ]);
});

test('draw_path with d and fill sends one command.batch and returns the new id', async () => {
  const craft = fakeCraft();
  const out = await runTool('vectorcraft.draw_path', { d: 'M0 0 L100 0 L50 80 Z', fill: '#3B5BDB' }, craft);
  assert.deepEqual(craft.calls, [[
    'execute',
    'command.batch',
    { label: 'Pen', commands: [{ command: 'path.create', params: { d: 'M0 0 L100 0 L50 80 Z' } }, { command: 'paint.setFill', params: { color: '#3B5BDB', item: null } }] },
  ]]);
  assert.deepEqual(out, { id: 42 });
});

test('draw_path normalizes points to anchors and rejects neither', async () => {
  const craft = fakeCraft();
  await runTool('vectorcraft.draw_path', { points: [[0, 0], [100, 0]], closed: true }, craft);
  assert.deepEqual(craft.calls[0][2].commands[0], { command: 'path.create', params: { anchors: [{ x: 0, y: 0 }, { x: 100, y: 0 }], closed: true } });
  await assert.rejects(runTool('vectorcraft.draw_path', { closed: true }, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.match(error.message, /give points or d/);
    return true;
  });
});

test('draw_shape maps the shape to its engine command and label', async () => {
  const craft = fakeCraft();
  await runTool('vectorcraft.draw_shape', { shape: 'rectangle', x: 40, y: 40, width: 200, height: 120, radius: 12, fill: '#7048E8' }, craft);
  assert.deepEqual(craft.calls[0][2], {
    label: 'Rounded Rectangle',
    commands: [
      { command: 'shape.rectangle', params: { x: 40, y: 40, width: 200, height: 120, radius: 12 } },
      { command: 'paint.setFill', params: { color: '#7048E8', item: null } },
    ],
  });
  await runTool('vectorcraft.draw_shape', { shape: 'circle', cx: 100, cy: 100, radius: 50 }, craft);
  assert.deepEqual(craft.calls.at(-1)[2].label, 'Circle');
  assert.deepEqual(craft.calls.at(-1)[2].commands[0], { command: 'shape.ellipse', params: { cx: 100, cy: 100, radius: 50 } });
});

test('set_paint runs one paint command per given arg with ids, and reports the count', async () => {
  const craft = fakeCraft();
  const out = await runTool('vectorcraft.set_paint', { fill: '#3B5BDB', strokeWidth: 2, ids: [3, 4] }, craft);
  assert.deepEqual(craft.calls, [
    ['execute', 'paint.setFill', { color: '#3B5BDB', ids: [3, 4] }],
    ['execute', 'stroke.set', { weight: 2, ids: [3, 4] }],
  ]);
  assert.deepEqual(out, { applied: { fill: '#3B5BDB', strokeWidth: 2 }, objects: 2 });
  await assert.rejects(runTool('vectorcraft.set_paint', {}, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.match(error.message, /give at least one of/);
    return true;
  });
});

test('export picks document.export or exportSelection, and scale only for rasters', async () => {
  const craft = fakeCraft();
  await runTool('vectorcraft.export', { format: 'svg', scale: 2 }, craft);
  await runTool('vectorcraft.export', { format: 'png', scale: 2 }, craft);
  await runTool('vectorcraft.export', { selection: true }, craft);
  assert.deepEqual(craft.calls, [
    ['execute', 'document.export', { format: 'svg' }],
    ['execute', 'document.export', { format: 'png', scale: 2 }],
    ['execute', 'document.exportSelection', {}],
  ]);
});

test('add_text sends text.create, area text, or text.createInPath', async () => {
  const craft = fakeCraft();
  await runTool('vectorcraft.add_text', { text: 'Title', x: 40, y: 80, size: 24 }, craft);
  await runTool('vectorcraft.add_text', { text: 'Body', x: 40, y: 120, width: 400, height: 100, fit: 'autoHeight' }, craft);
  await runTool('vectorcraft.add_text', { text: 'On a curve', path: 5 }, craft);
  assert.deepEqual(craft.calls, [
    ['execute', 'text.create', { size: 24, x: 40, y: 80, text: 'Title' }],
    ['execute', 'text.create', { x: 40, y: 120, text: 'Body', area: { width: 400, height: 100, fit: 'autoHeight' } }],
    ['execute', 'text.createInPath', { path: 5, mode: 'onPath', text: 'On a curve' }],
  ]);
  await assert.rejects(runTool('vectorcraft.add_text', { text: 'No position' }, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.match(error.message, /x= and y= are their own arguments/);
    assert.equal(error.fix, 'call_tool tool=vectorcraft.add_text text=No position x=<x> y=<y>');
    return true;
  });
  // j3 b14 (02): the crammed pairs come back out as their own arguments in the fix line.
  await assert.rejects(runTool('vectorcraft.add_text', { text: 'Quarterly report\nx=40\ny=80\nsize=24\ncolor=#E8590C' }, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.fix, 'call_tool tool=vectorcraft.add_text text=Quarterly report x=40 y=80 size=24 color=#E8590C');
    return true;
  });
});

test('apply_effect returns the catalogue without effect=, else runs effect.apply', async () => {
  const craft = fakeCraft();
  const catalog = await runTool('vectorcraft.apply_effect', {}, craft);
  assert.deepEqual(catalog, { catalog: [{ id: 'stylize.dropShadow', params: {} }] });
  await runTool('vectorcraft.apply_effect', { effect: 'stylize.dropShadow', params: 'x=4\nblur=6', ids: [3] }, craft);
  assert.deepEqual(craft.calls.at(-1), ['execute', 'effect.apply', { effect: 'stylize.dropShadow', params: { x: 4, blur: 6 }, ids: [3] }]);
});

test('pathfinder selects the ids, then runs object.pathfinder.<operation>', async () => {
  const craft = fakeCraft();
  await runTool('vectorcraft.pathfinder', { operation: 'unite', ids: [3, 4] }, craft);
  assert.deepEqual(craft.calls, [['execute', 'select.set', { ids: [3, 4] }], ['execute', 'object.pathfinder.unite', {}]]);
});

test('transform runs the operations in order with copy on the first only', async () => {
  const craft = fakeCraft();
  const out = await runTool('vectorcraft.transform', { dx: 0, dy: 40, rotate: 90, origin: [100, 100], copy: true }, craft);
  assert.deepEqual(craft.calls, [
    ['execute', 'object.move', { origin: [100, 100], dx: 0, dy: 40, copy: true }],
    ['execute', 'object.rotate', { origin: [100, 100], angle: 90, copy: false }],
  ]);
  assert.deepEqual(out, { applied: ['move', 'rotate'] });
  await assert.rejects(runTool('vectorcraft.transform', {}, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.match(error.message, /give at least one of/);
    return true;
  });
});

test('create_graph, text_wrap, undo and redo send their engine commands', async () => {
  const craft = fakeCraft();
  await runTool('vectorcraft.create_graph', { x: 40, y: 40, width: 400, height: 300, series: ['Sales'], rows: [[12], [18]] }, craft);
  await runTool('vectorcraft.text_wrap', { offset: 12 }, craft);
  await runTool('vectorcraft.text_wrap', { release: true, ids: [3] }, craft);
  await runTool('vectorcraft.undo', {}, craft);
  await runTool('vectorcraft.redo', {}, craft);
  assert.deepEqual(craft.calls, [
    ['execute', 'graph.create', { type: 'column', x: 40, y: 40, width: 400, height: 300, series: ['Sales'], rows: [[12], [18]] }],
    ['execute', 'object.textWrap.make', { offset: 12 }],
    ['execute', 'select.set', { ids: [3] }],
    ['execute', 'object.textWrap.release', {}],
    ['execute', 'edit.undo', {}],
    ['execute', 'edit.redo', {}],
  ]);
});

test('vectorcraft.batch runs the steps in order and stops at the first error unless keepGoing', async () => {
  const craft = fakeCraft();
  const failing = {
    calls: craft.calls,
    request: craft.request,
    commands: craft.commands,
    inspect: craft.inspect,
    execute: async (command, params) => {
      craft.calls.push(['execute', command, params]);
      if (command === 'object.rotate') throw new Error('no selection');
      return { command, params };
    },
  };
  const out = await byName('vectorcraft.batch').run(
    { commands: ['shape.ellipse cx=100 cy=100 radius=50', 'object.rotate angle=90', 'edit.undo'] },
    { host: {}, craft: () => Promise.resolve(failing) },
  );
  assert.deepEqual(out.map(entry => [entry.command, entry.ok]), [['shape.ellipse', true], ['object.rotate', false]]);
  const kept = await byName('vectorcraft.batch').run(
    { commands: ['object.rotate angle=90', 'edit.undo'], keepGoing: true },
    { host: {}, craft: () => Promise.resolve(failing) },
  );
  assert.equal(kept.length, 2);
  assert.deepEqual(craft.calls.map(call => call[1]), ['shape.ellipse', 'object.rotate', 'object.rotate', 'edit.undo']);
});

test('vectorcraft.list_commands returns the top 10 matches by id, label or menu', async () => {
  const craft = fakeCraft();
  const byMenu = await runTool('vectorcraft.list_commands', { query: 'arrange' }, craft);
  assert.deepEqual(byMenu, [{ id: 'object.align', label: 'Align', menu: 'Arrange', params: 'horizontal, vertical' }]);
  const all = await runTool('vectorcraft.list_commands', {}, craft);
  assert.equal(all.length, 6);
});

test('vectorcraft.run_command parses key=value lines with JSON values and checks the id', async () => {
  const craft = fakeCraft();
  await runTool('vectorcraft.run_command', { command: 'shape.rectangle', params: 'x=0\ny=0\nwidth=100\nheight=50' }, craft);
  assert.deepEqual(craft.calls, [['commands'], ['execute', 'shape.rectangle', { x: 0, y: 0, width: 100, height: 50 }]]);
  await assert.rejects(runTool('vectorcraft.run_command', { command: 'shape.rectangl' }, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.match(error.message, /unknown command "shape.rectangl"; closest: shape.rectangle/);
    assert.equal(error.fix, callLine('vectorcraft.run_command', { command: 'shape.rectangle' }));
    return true;
  });
});

test('vectorcraft.new_document sends file.new with the name and the point sizes', async () => {
  const craft = fakeCraft();
  const out = await runTool('vectorcraft.new_document', { name: 'Poster', width: 595, height: 842 }, craft);
  assert.deepEqual(craft.calls, [['execute', 'file.new', { name: 'Poster', width: 595, height: 842 }]]);
  assert.deepEqual(out, { command: 'file.new', params: { name: 'Poster', width: 595, height: 842 } });
});

test('a no-document rejection (either engine wording, or the exact live probe message) becomes the teaching ToolError with the new_document fix', async () => {
  const failing = message => {
    const craft = fakeCraft();
    const error = () => Promise.reject(Object.assign(new Error(message), { code: 'app_error' })); // the adapter sets the code
    craft.execute = () => error();
    craft.request = () => error();
    return craft;
  };
  for (const message of [
    'no active document',
    'no document open',
    'command shape.rectangle is not available right now: no document open', // the lead's live probe message
  ]) {
    await assert.rejects(runTool('vectorcraft.undo', {}, failing(message)), error => {
      assert.ok(error instanceof ToolError);
      assert.equal(error.type, 'not_available');
      assert.equal(error.message, 'VectorCraft has no document open.');
      // sweep b17 08: the fix must offer opening the user's file, not only creating a
      // document - the new-document-only fix steered the model to a fresh document.
      assert.equal(error.fix, 'call_tool tool=vectorcraft.new_document name=<name>, or open an existing document from Files: call_tool tool=vectorcraft.open_file path=<path>');
      return true;
    });
    await assert.rejects(runTool('vectorcraft.press_key', { key: 'Delete' }, failing(message)), error => {
      assert.ok(error instanceof ToolError);
      assert.equal(error.type, 'not_available');
      return true;
    });
  }
});

test('effectFor marks destructive command ids for run_command and batch', () => {
  const run = byName('vectorcraft.run_command');
  assert.equal(run.effectFor({ command: 'object.delete' }), 'destructive');
  assert.equal(run.effectFor({ command: 'object.pathfinder.unite' }), 'destructive');
  assert.equal(run.effectFor({ command: 'file.new' }), 'change'); // multi-doc: the new document joins the list (lead live gate)
  assert.equal(run.effectFor({ command: 'shape.rectangle' }), 'change');
  const batch = byName('vectorcraft.batch');
  assert.equal(batch.effectFor({ commands: ['shape.ellipse cx=0 cy=0 radius=1', 'object.delete'] }), 'destructive');
  assert.equal(batch.effectFor({ commands: ['shape.ellipse cx=0 cy=0 radius=1'] }), 'change');
});

// A fake wrapper window for the file tools: the #file input records the change dispatch
// (openFromBytes drives it, app.mjs:38); VectorCraft is standalone, so the open rides the
// bootstrap's openFile path (bootstrap.js:52-89) rather than the host bridge.
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
      readBytes: path => { calls.read.push(path); return Promise.resolve({ path, name: 'poster.vectorcraft', bytes, size: bytes.byteLength }); },
      writeBytes: (path, b, { overwrite } = {}) => { calls.write.push({ path, size: b.byteLength, overwrite }); return Promise.resolve({ path, size: b.byteLength, created: !overwrite }); },
    },
  };
};

test('vectorcraft.open_file reads the file, drives the wrapper input, and waits for the load', async () => {
  const wrapper = fakeWrapper();
  const ctx = fileCtx(new Uint8Array([1, 2, 3]), wrapper);
  const state = { document: 'Drawing' };
  const input = wrapper.document.getElementById('file');
  const original = input.dispatchEvent;
  input.dispatchEvent = event => { if (event?.type === 'change') Object.assign(state, { title: 'poster.vectorcraft' }); return original(event); };
  ctx.craft = () => Promise.resolve({ ...fakeCraft(), inspect: async () => state });
  const out = await byName('vectorcraft.open_file').run({ path: '/VectorCraft/poster.vectorcraft' }, ctx);
  assert.deepEqual(ctx.calls.read, ['/VectorCraft/poster.vectorcraft']);
  assert.equal(wrapper.opened.length, 1);
  assert.equal(wrapper.opened[0].name, 'poster.vectorcraft');
  assert.deepEqual(out, { name: 'poster.vectorcraft', bytes: 3, opened: '"poster.vectorcraft"', next: 'poster.vectorcraft is open. To check it, call vectorcraft.inspect. Opening it again shows a dialog and blocks the app.' });
});

test('vectorcraft.save_copy takes the bytes inline from document.serialize; the target base names the result', async () => {
  const wrapper = fakeWrapper();
  const ctx = fileCtx(new Uint8Array([1, 2, 3]), wrapper);
  const calls = [];
  const b64 = Buffer.from([9, 8]).toString('base64');
  ctx.craft = () => Promise.resolve({
    ...fakeCraft(),
    execute: (command, params) => { calls.push([command, params]); return Promise.resolve(command === 'document.serialize' ? { dataBase64: b64, warnings: [] } : { command, params }); },
  });
  const out1 = await byName('vectorcraft.save_copy').run({ path: '/VectorCraft/poster.vectorcraft' }, ctx);
  const out2 = await byName('vectorcraft.save_copy').run({ path: '/VectorCraft/poster' }, ctx); // no extension: the default format
  assert.deepEqual(calls, [['document.serialize', {}], ['document.serialize', {}]]);
  assert.deepEqual(ctx.calls.write, [
    { path: '/VectorCraft/poster.vectorcraft', size: 2, overwrite: false },
    { path: '/VectorCraft/poster', size: 2, overwrite: false },
  ]);
  assert.deepEqual(out1, { path: '/VectorCraft/poster.vectorcraft', name: 'poster.vectorcraft', size: 2, created: true });
  assert.deepEqual(out2, { path: '/VectorCraft/poster', name: 'poster.vectorcraft', size: 2, created: true });
  assert.ok(!('note' in out1)); // the inline path downloads nothing
});

test('vectorcraft.save_copy picks the export format from the target extension', async () => {
  const wrapper = fakeWrapper();
  const ctx = fileCtx(new Uint8Array([1, 2, 3]), wrapper);
  const calls = [];
  const b64 = Buffer.from([9, 8]).toString('base64');
  ctx.craft = () => Promise.resolve({
    ...fakeCraft(),
    execute: (command, params) => { calls.push([command, params]); return Promise.resolve(command === 'document.serialize' ? { dataBase64: b64, text: '<svg/>' } : { command, params }); },
  });
  const out = await byName('vectorcraft.save_copy').run({ path: '/VectorCraft/poster.svg' }, ctx);
  assert.deepEqual(calls, [['document.serialize', { format: 'svg' }]]); // the extension picks the format
  assert.deepEqual(ctx.calls.write, [{ path: '/VectorCraft/poster.svg', size: 2, overwrite: false }]);
  assert.deepEqual(out, { path: '/VectorCraft/poster.svg', name: 'poster.svg', size: 2, created: true });
});

test('vectorcraft.save_copy refuses an extension the app cannot serialize, with the .vectorcraft fix', async () => {
  const ctx = fileCtx(new Uint8Array([1]), fakeWrapper());
  const calls = [];
  ctx.craft = () => Promise.resolve({ ...fakeCraft(), execute: (command, params) => { calls.push([command, params]); return Promise.resolve({ dataBase64: Buffer.from([9]).toString('base64') }); } });
  await assert.rejects(byName('vectorcraft.save_copy').run({ path: '/VectorCraft/poster.drawcraft' }, ctx), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'invalid_argument');
    assert.match(error.message, /VectorCraft saves \.vectorcraft and its export formats .* it cannot write \.drawcraft\./);
    assert.equal(error.fix, callLine('vectorcraft.save_copy', { path: '/VectorCraft/poster.vectorcraft' }));
    return true;
  });
  assert.equal(calls.length, 0); // the extension check runs before the serialize call
  assert.equal(ctx.calls.write.length, 0);
});

const { skills, errors: skillErrors } = parseSkills(SKILLS_MD, 'vectorcraft');

test('skills.md parses with the runtime parser without errors and has 11 skills', () => {
  assert.deepEqual(skillErrors, []);
  assert.equal(skills.length, 11);
  for (const skill of skills) {
    assert.ok(skill.slug && skill.summary, `skill ${skill.slug} slug/summary`);
    assert.ok(skill.summary.length <= 160, `skill ${skill.slug} summary is ${skill.summary.length} chars`);
    assert.ok(skill.keywords.length >= 5, `skill ${skill.slug} keywords: ${skill.keywords.join(', ')}`);
    assert.ok(skill.tools.length >= 1, `skill ${skill.slug} tools`);
    assert.ok(skill.when && skill.steps.length >= 1 && skill.check, `skill ${skill.slug} body sections`);
  }
});

test('every skill opens by launching VectorCraft, then uses numbered vectorcraft steps', () => {
  for (const skill of skills) {
    assert.equal(skill.steps[0].line, '1. call_tool tool=desktop.open_app app=vectorcraft', `skill ${skill.slug}`);
    skill.steps.forEach((step, i) => {
      assert.equal(step.n, i + 1, `skill ${skill.slug} step numbering`);
      assert.ok(step.tool.startsWith('desktop.') || step.tool.startsWith('vectorcraft.'), `skill ${skill.slug} step ${step.n}: ${step.line}`);
    });
  }
});

test('content skills create or check the document in step 2, so a missing one is fixed before edits', () => {
  const bySlug = Object.fromEntries(skills.map(skill => [skill.slug, skill]));
  for (const slug of ['draw-a-rectangle', 'draw-a-path']) {
    assert.ok(bySlug[slug].steps[1].line.startsWith('2. call_tool tool=vectorcraft.new_document'), `skill ${slug} step 2: ${bySlug[slug].steps[1].line}`);
  }
  for (const slug of ['paint-the-selection', 'add-drawing-text', 'move-or-resize-objects', 'combine-shapes', 'apply-an-effect', 'run-any-drawing-command']) {
    assert.equal(bySlug[slug].steps[1].line, '2. call_tool tool=vectorcraft.inspect', `skill ${slug}`);
  }
});

test('skill steps and tools lines validate against the runtime checkArgs', () => {
  const errors = checkSkills(skills, byName, { checkArgs: (tool, args) => checkArgs(tool, args, { choices }) });
  assert.deepEqual(errors, []);
});

test('add-drawing-text is one add_text step: a second call creates a shadowing object (sweep b17 02)', () => {
  const skill = skills.find(s => s.slug === 'add-drawing-text');
  const addTextSteps = skill.steps.filter(step => step.tool === 'vectorcraft.add_text');
  assert.equal(addTextSteps.length, 1, 'one add_text call per text layer');
  assert.match(skill.gotchas, /second call/i, 'the gotcha names the shadowing second object');
  assert.match(skill.gotchas, /area type with a frame/, 'the area variant stays, gated on the user asking');
});

test('new_document offers the artboard size slots in its call template (sweep b17 01)', () => {
  const tool = byName('vectorcraft.new_document');
  const keys = templateKeys(tool);
  assert.deepEqual(keys, ['name', 'width', 'height'], 'the template shows all three slots, not name alone');
});
