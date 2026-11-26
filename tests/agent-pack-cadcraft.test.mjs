// Unit tests for the CADCraft pack: agent/apps/cadcraft/tools.js and skills.md.
// A fake ctx.craft records calls; every tool must send the exact control method and wire
// params that storytold/cadcraft@v0.20.1 crates/mcp/src/tools.rs dispatches. The schema
// and skills checks reuse the real runtime validators, with the choices function that
// scripts/agent/build.mjs builds the catalog with.
// Run: node --test tests/agent-pack-cadcraft.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseParams, pack, tools, usesCommands, usesMethods } from '../agent/apps/cadcraft/tools.js';
import { tools as desktopTools } from '../agent/desktop/tools.js';
import { ToolError, specErrors, checkArgs, callLine } from '../src/apps/ai-agent/runtime/args.mjs';
import { parseSkills, checkSkills } from '../src/apps/ai-agent/runtime/skills.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_MD = readFileSync(join(HERE, '..', 'agent', 'apps', 'cadcraft', 'skills.md'), 'utf8');
const APP_IDS = ['cadcraft'];
const choices = name => (name === 'apps' ? APP_IDS : []);
const byName = name => tools.find(tool => tool.name === name) ?? desktopTools.find(tool => tool.name === name);

// The live command list, shaped like the craft-web-api commands() reply.
const COMMANDS = [
  { id: 'line', label: 'Line', menu: 'Draw', params: 'points', shortcut: 'L', enabled: true, aliases: ['l'] },
  { id: 'circle', label: 'Circle', menu: 'Draw', params: 'center, radius', shortcut: 'C', enabled: true, aliases: ['c'] },
  { id: 'layer.new', label: 'New Layer', menu: 'Layer', params: 'name, color, current', shortcut: '', enabled: true, aliases: [] },
  { id: 'new', label: 'New Drawing', menu: 'File', params: 'metric', shortcut: '', enabled: true, aliases: [] },
  { id: 'zoom', label: 'Zoom', menu: 'View', params: 'mode', shortcut: 'Z', enabled: true, aliases: ['z'] },
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
    inspect: rec('inspect', () => ({ entities: 0 })),
    screenshot: rec('screenshot', () => 'png-base64'),
  };
};
const runTool = (name, args, craft) => byName(name).run(args, { host: {}, craft: () => Promise.resolve(craft) });

test('the pack declares its id, title and live-check exports', () => {
  assert.deepEqual(pack, { id: 'cadcraft', title: 'CADCraft' });
  assert.deepEqual(usesCommands, ['circle', 'line', 'move', 'selectall', 'text', 'entities', 'texts', 'new', 'document.bytes']);
  assert.deepEqual(usesMethods, ['cmdline.input', 'cmdline.script', 'drawing.inspect', 'cmdline.key']);
});

test('the pack exposes exactly the 15 cadcraft tools', () => {
  assert.equal(tools.length, 15);
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'cadcraft.cancel', 'cadcraft.circle', 'cadcraft.command_line', 'cadcraft.find_text', 'cadcraft.inspect',
    'cadcraft.line', 'cadcraft.list_commands', 'cadcraft.move', 'cadcraft.new_drawing', 'cadcraft.open_file',
    'cadcraft.query_entities', 'cadcraft.run_command', 'cadcraft.save_copy', 'cadcraft.script', 'cadcraft.text',
  ]);
});

// cadcraft-06 (build 14): the model spelled the engine's [x,y] arrays inside run_command's
// params text. from=[0,0] stayed a string and the loose JSON "{handles: line, from: [0, 0]}"
// is not JSON - the engine never saw `from` and every move attempt failed. parseParams now
// reads [a,b] arrays, loose {k: v} objects, and the params= double-wrap the model adds.
test('parseParams reads [a,b] arrays, loose unquoted objects and the params= double-wrap', () => {
  assert.deepEqual(parseParams('handles=line from=[0,0] to=[5,5]'), { handles: 'line', from: [0, 0], to: [5, 5] });
  assert.deepEqual(parseParams('{handles: line, from: [0, 0], to: [5, 5], delta: [5, 5]}'),
    { handles: 'line', from: [0, 0], to: [5, 5], delta: [5, 5] });
  assert.deepEqual(parseParams('params=handles=line from=[0,0]'), { handles: 'line', from: [0, 0] }, 'the params= prefix the model nests inside the params arg unwraps');
  assert.deepEqual(parseParams('params={handles: line, from: [0, 0]}'), { handles: 'line', from: [0, 0] }, 'the loose JSON double-wrap unwraps too');
  // Existing behaviour holds: strict JSON passes through, key=value lines coerce, one bare word is an error.
  assert.deepEqual(parseParams('{"handles": "line", "from": [0, 0]}'), { handles: 'line', from: [0, 0] });
  assert.deepEqual(parseParams('metric=true\nsize=3'), { metric: true, size: 3 });
  assert.throws(() => parseParams('not a pair'), /bad params line/);
  // A command that legitimately takes a params string keeps it (no =, no braces: no unwrap).
  assert.deepEqual(parseParams('params=plain text value'), { params: 'plain text value' });
});

test('the flat tools spell the engine params directly (cadcraft-02/04/06, wire shapes from the wasm help)', async () => {
  // move: the engine's delta form {handles?, from?: [x,y], to?: [x,y] | delta: [dx,dy]}.
  // Omitted handles move the current selection - live {moved: 0} on the empty selection
  // (cadcraft-06 on build 15) - so "move everything" selects all first.
  const move = fakeCraft();
  await byName('cadcraft.move').run({ dx: 5, dy: 5 }, { host: {}, craft: () => Promise.resolve(move) });
  assert.deepEqual(move.calls, [['execute', 'selectall', {}], ['execute', 'move', { delta: [5, 5] }]], 'omitted handles selects all, then moves');
  const moveHandles = fakeCraft();
  await byName('cadcraft.move').run({ dx: -3, dy: 1, handles: '100,200' }, { host: {}, craft: () => Promise.resolve(moveHandles) });
  assert.deepEqual(moveHandles.calls, [['execute', 'move', { delta: [-3, 1], handles: '100,200' }]], 'given handles move without a select');
  // circle {center, radius}: points parse from x,y text.
  const circle = fakeCraft();
  await byName('cadcraft.circle').run({ center: '20,0', radius: 5 }, { host: {}, craft: () => Promise.resolve(circle) });
  assert.deepEqual(circle.calls.at(-1), ['execute', 'circle', { center: [20, 0], radius: 5 }]);
  const circleSpace = fakeCraft();
  await byName('cadcraft.circle').run({ center: '12 0', radius: 3 }, { host: {}, craft: () => Promise.resolve(circleSpace) });
  assert.deepEqual(circleSpace.calls.at(-1), ['execute', 'circle', { center: [12, 0], radius: 3 }], 'a space-separated point parses too');
  const circleArray = fakeCraft();
  await byName('cadcraft.circle').run({ center: [20, 0], radius: 5 }, { host: {}, craft: () => Promise.resolve(circleArray) });
  assert.deepEqual(circleArray.calls.at(-1), ['execute', 'circle', { center: [20, 0], radius: 5 }], 'an array point passes through');
  // line {points: [[x,y],...]}: the build 15 live run refused {p1, p2} with
  // "`points` [[x,y],...] (2 or more) is required", so the flat p1/p2 params map to points.
  const line = fakeCraft();
  await byName('cadcraft.line').run({ p1: '0,0', p2: '12,0' }, { host: {}, craft: () => Promise.resolve(line) });
  assert.deepEqual(line.calls.at(-1), ['execute', 'line', { points: [[0, 0], [12, 0]] }]);
  // text {at, text, height?, rotation?}: the flat label tool (cadcraft-03 on build 15).
  const text = fakeCraft();
  await byName('cadcraft.text').run({ at: '0,0', text: 'Room 101', height: 100 }, { host: {}, craft: () => Promise.resolve(text) });
  assert.deepEqual(text.calls.at(-1), ['execute', 'text', { at: [0, 0], text: 'Room 101', height: 100 }]);
  const textDefault = fakeCraft();
  await byName('cadcraft.text').run({ at: '0,300', text: 'Corridor A' }, { host: {}, craft: () => Promise.resolve(textDefault) });
  assert.deepEqual(textDefault.calls.at(-1), ['execute', 'text', { at: [0, 300], text: 'Corridor A' }], 'omitted height and rotation stay off the wire');
  // A point that is not two numbers is a teaching error before the engine sees it.
  await assert.rejects(byName('cadcraft.circle').run({ center: '20', radius: 5 }, { host: {}, craft: () => Promise.resolve(fakeCraft()) }),
    error => error instanceof ToolError && error.type === 'invalid_argument' && /center is a point/.test(error.message));
  await assert.rejects(byName('cadcraft.text').run({ at: '0', text: 'x' }, { host: {}, craft: () => Promise.resolve(fakeCraft()) }),
    error => error instanceof ToolError && error.type === 'invalid_argument' && /at is a point/.test(error.message));
});

test('a prose-shaped command_line line names the flat tools (cadcraft-02/04)', async () => {
  // The model typed sentences ("circle center 20,0 radius 5") and looped on the interactive
  // prompts; the first result must point at the flat tool.
  const craft = fakeCraft();
  const prose = await byName('cadcraft.command_line').run({ text: 'circle center 20,0 radius 5' }, { host: {}, craft: () => Promise.resolve(craft) });
  assert.equal(prose.method, 'cmdline.input', 'the line still reaches the command line');
  assert.match(prose.note, /cadcraft\.circle/);
  const sentence = await byName('cadcraft.command_line').run({ text: 'draw a circle at point (20,0) with radius 5' }, { host: {}, craft: () => Promise.resolve(craft) });
  assert.match(sentence.note, /cadcraft\.circle/);
  const textProse = await byName('cadcraft.command_line').run({ text: 'add a text label Room 101 at 0,0 with height 100' }, { host: {}, craft: () => Promise.resolve(craft) });
  assert.match(textProse.note, /cadcraft\.text/);
  // Exact command shapes (a command word plus points/keywords) get no note.
  for (const text of ['circle 20,0 5', 'CIRCLE 20 0 5', 'line 0,0 12,0', 'move 20,10 -10,-10']) {
    const exact = await byName('cadcraft.command_line').run({ text }, { host: {}, craft: () => Promise.resolve(craft) });
    assert.ok(!exact.note, `${text} must not note`);
  }
});

test('every tool has the required text fields, effect, needs and examples', () => {
  for (const tool of tools) {
    assert.match(tool.name, /^cadcraft\.[a-z0-9_]+$/);
    assert.ok(tool.purpose.length > 0 && tool.purpose.length <= 80, `${tool.name} purpose is ${tool.purpose.length} chars`);
    assert.ok(tool.when.startsWith('Use when'), `${tool.name} when must start with "Use when"`);
    assert.ok(tool.when.length <= 120, `${tool.name} when is ${tool.when.length} chars`);
    assert.ok(['read', 'change', 'destructive', 'external'].includes(tool.effect), `${tool.name} bad effect`);
    const fileTools = ['cadcraft.open_file', 'cadcraft.save_copy'];
    assert.deepEqual(tool.needs, fileTools.includes(tool.name) ? ['host', 'app:cadcraft', 'files'] : ['host', 'app:cadcraft']);
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

test('the effects are read for reads, change for edits, destructive for new_drawing', () => {
  const reads = ['cadcraft.inspect', 'cadcraft.query_entities', 'cadcraft.find_text', 'cadcraft.list_commands'];
  for (const name of reads) assert.equal(byName(name).effect, 'read', name);
  assert.equal(byName('cadcraft.new_drawing').effect, 'destructive');
  for (const tool of tools) if (!reads.includes(tool.name) && tool.name !== 'cadcraft.new_drawing') assert.equal(tool.effect, 'change', tool.name);
});

test('command_line, script and cancel send the cmdline control methods', async () => {
  const craft = fakeCraft();
  await runTool('cadcraft.command_line', { text: 'circle 0,0 5' }, craft);
  await runTool('cadcraft.script', { text: 'line\n0,0' }, craft);
  await runTool('cadcraft.cancel', {}, craft);
  assert.deepEqual(craft.calls, [
    ['request', 'cmdline.input', { text: 'circle 0,0 5' }],
    // T6: the pack appends the terminating blank line, so the still-open LINE commits.
    ['request', 'cmdline.script', { text: 'line\n0,0\n' }],
    ['request', 'cmdline.key', { key: 'escape' }],
  ]);
});

test('T6 finish: a script already ending on a blank line is unchanged; empty or omitted command_line text is a bare Enter', async () => {
  const craft = fakeCraft();
  await runTool('cadcraft.script', { text: 'line\n0,0\n10,0\n' }, craft);
  await runTool('cadcraft.script', { text: 'line\\n0,0\\n10,0' }, craft);
  await runTool('cadcraft.command_line', { text: '' }, craft);
  await runTool('cadcraft.command_line', {}, craft);
  assert.deepEqual(craft.calls, [
    ['request', 'cmdline.script', { text: 'line\n0,0\n10,0\n' }],
    ['request', 'cmdline.script', { text: 'line\n0,0\n10,0\n' }],
    ['request', 'cmdline.input', { text: ' ' }],
    ['request', 'cmdline.input', { text: ' ' }],
  ]);
  // Through the real argument check: omitted text takes the Enter default.
  const out = checkArgs(byName('cadcraft.command_line'), {}, { choices });
  assert.deepEqual(out, { ok: true, args: { text: ' ' } });
});

test('cadcraft.inspect sends drawing.inspect with only the given fields', async () => {
  const craft = fakeCraft();
  await runTool('cadcraft.inspect', { entities: true, limit: 50 }, craft);
  await runTool('cadcraft.inspect', {}, craft);
  assert.deepEqual(craft.calls, [['request', 'drawing.inspect', { entities: true, limit: 50 }], ['request', 'drawing.inspect', {}]]);
});

test('query_entities rebuilds the window box from the flat params', async () => {
  const craft = fakeCraft();
  await runTool('cadcraft.query_entities', { type: 'Circle', window_x0: 0, window_y0: 0, window_x1: 10, window_y1: 10, crossing: false, limit: 5 }, craft);
  await runTool('cadcraft.query_entities', { layer: 'Walls' }, craft);
  assert.deepEqual(craft.calls, [
    ['execute', 'entities', { type: 'Circle', crossing: false, limit: 5, window: [[0, 0], [10, 10]] }],
    ['execute', 'entities', { layer: 'Walls' }],
  ]);
});

test('find_text rebuilds the window box and keeps the filters', async () => {
  const craft = fakeCraft();
  await runTool('cadcraft.find_text', { contains: 'Room', window_x0: -5, window_y0: -5, window_x1: 5, window_y1: 5, offset: 10 }, craft);
  assert.deepEqual(craft.calls, [['execute', 'texts', { contains: 'Room', offset: 10, window: [[-5, -5], [5, 5]] }]]);
});

test('cadcraft.new_drawing sends the engine command new', async () => {
  const craft = fakeCraft();
  await runTool('cadcraft.new_drawing', { metric: true }, craft);
  await runTool('cadcraft.new_drawing', {}, craft);
  assert.deepEqual(craft.calls, [['execute', 'new', { metric: true }], ['execute', 'new', {}]]);
});

test('cadcraft.list_commands filters by id, label or alias, top 10', async () => {
  const craft = fakeCraft();
  const byAlias = await runTool('cadcraft.list_commands', { query: 'c' }, craft);
  assert.deepEqual(byAlias.map(row => row.id), ['circle']);
  const byId = await runTool('cadcraft.list_commands', { query: 'layer' }, craft);
  assert.deepEqual(byId.map(row => row.id), ['layer.new']);
  const all = await runTool('cadcraft.list_commands', {}, craft);
  assert.equal(all.length, 5);
  assert.ok(!('aliases' in all[0]));
});

test('cadcraft.run_command parses key=value lines with coercion and checks the id', async () => {
  const craft = fakeCraft();
  await runTool('cadcraft.run_command', { command: 'circle', params: 'center=[0,0]\nradius=5' }, craft);
  assert.deepEqual(craft.calls, [['commands'], ['execute', 'circle', { center: [0, 0], radius: 5 }]]);
});

test('cadcraft.run_command rejects an unknown id with invalid_argument and the 3 closest', async () => {
  const craft = fakeCraft();
  await assert.rejects(runTool('cadcraft.run_command', { command: 'cirle' }, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.match(error.message, /unknown command "cirle"; closest: circle/);
    assert.equal(error.fix, callLine('cadcraft.run_command', { command: 'circle' }));
    return true;
  });
});

test('effectFor marks the new command destructive and the rest change', () => {
  const run = byName('cadcraft.run_command');
  assert.equal(run.effectFor({ command: 'new' }), 'destructive');
  assert.equal(run.effectFor({ command: 'zoom' }), 'change');
});

test('a no-drawing error (in-band or rejection) becomes the teaching ToolError with the new_drawing fix', async () => {
  const fix = callLine('cadcraft.new_drawing');
  const inBand = fakeCraft();
  inBand.request = (method, params) => (method === 'cmdline.input'
    ? Promise.resolve({ accept: null, output: [], error: 'command circle is not available right now: no drawing open' })
    : Promise.resolve({ method, params }));
  await assert.rejects(runTool('cadcraft.command_line', { text: 'circle 0,0 5' }, inBand), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    assert.equal(error.message, 'CadCraft has no drawing open.');
    assert.equal(error.fix, fix);
    return true;
  });
  const rejected = fakeCraft();
  rejected.execute = () => Promise.reject(Object.assign(new Error('no drawing open'), { code: 'app_error' })); // the adapter sets the code
  await assert.rejects(runTool('cadcraft.query_entities', { type: 'Circle' }, rejected), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    assert.equal(error.fix, fix);
    return true;
  });
});

test('an in-band error that is not about the drawing becomes an app_error with the app message', async () => {
  const craft = fakeCraft();
  craft.request = method => (method === 'cmdline.input' ? Promise.resolve({ output: [], error: 'bad point' }) : Promise.resolve({ method }));
  await assert.rejects(runTool('cadcraft.command_line', { text: 'circle 0,0 5' }, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'app_error');
    assert.equal(error.message, 'bad point');
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
      readBytes: path => { calls.read.push(path); return Promise.resolve({ path, name: 'plan.dxf', bytes, size: bytes.byteLength }); },
      writeBytes: (path, b, { overwrite } = {}) => { calls.write.push({ path, size: b.byteLength, overwrite }); return Promise.resolve({ path, size: b.byteLength, created: !overwrite }); },
    },
  };
};
test('cadcraft.open_file reads the file, waits for the drawing to load, and returns the opened summary', async () => {
  const wrapper = fakeWrapper();
  const ctx = fileCtx(new Uint8Array([1, 2]), wrapper);
  const state = { opened: false };
  const input = wrapper.document.getElementById('file');
  const original = input.dispatchEvent;
  input.dispatchEvent = event => { if (event?.type === 'change') state.opened = true; return original(event); };
  ctx.craft = () => Promise.resolve({
    inspect: () => (state.opened ? Promise.resolve({ entities: 3 }) : Promise.reject(Object.assign(new Error('no drawing open'), { code: 'app_error' }))),
  });
  const out = await byName('cadcraft.open_file').run({ path: '/CadCraft/plan.dxf' }, ctx);
  assert.deepEqual(ctx.calls.read, ['/CadCraft/plan.dxf']);
  assert.equal(wrapper.opened.length, 1);
  assert.equal(wrapper.opened[0].name, 'plan.dxf');
  assert.deepEqual(out, { name: 'plan.dxf', bytes: 2, opened: 'the app state changed', next: 'plan.dxf is open. To check it, call cadcraft.inspect. Opening it again shows a dialog and blocks the app.' }); // threw before, loads after
});

test('cadcraft.save_copy takes the bytes inline from document.bytes and writes them', async () => {
  const wrapper = fakeWrapper();
  const ctx = fileCtx(new Uint8Array([1]), wrapper);
  const calls = [];
  const b64 = Buffer.from([5, 4, 3, 2, 1]).toString('base64');
  ctx.craft = () => Promise.resolve({
    commands: () => Promise.resolve([]),
    inspect: () => Promise.resolve({ title: 'Drawing1' }),
    execute: (command, params) => { calls.push([command, params]); return Promise.resolve(command === 'document.bytes' ? { bytes: 5, data: b64 } : { command, params }); },
  });
  const out = await byName('cadcraft.save_copy').run({ path: '/CadCraft/plan.dxf' }, ctx);
  assert.deepEqual(calls, [['document.bytes', {}]]); // the live inline route (lead live check)
  assert.deepEqual(ctx.calls.write, [{ path: '/CadCraft/plan.dxf', size: 5, overwrite: false }]);
  assert.deepEqual(out, { path: '/CadCraft/plan.dxf', name: 'Drawing1.dxf', size: 5, created: true });
  assert.ok(!('note' in out)); // the inline path downloads nothing
});

test('cadcraft.save_copy refuses a .dwg target with the .dxf fix before any command runs', async () => {
  const ctx = fileCtx(new Uint8Array([1]), fakeWrapper());
  const calls = [];
  ctx.craft = () => Promise.resolve({
    commands: () => Promise.resolve([]),
    inspect: () => Promise.resolve({ title: 'Drawing1' }),
    execute: (command, params) => { calls.push([command, params]); return Promise.resolve({}); },
  });
  await assert.rejects(byName('cadcraft.save_copy').run({ path: '/CadCraft/plan.dwg' }, ctx), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'invalid_argument');
    assert.match(error.message, /CadCraft saves \.dxf files; it cannot write \.dwg here\./);
    assert.equal(error.fix, callLine('cadcraft.save_copy', { path: '/CadCraft/plan.dxf' }));
    return true;
  });
  assert.equal(calls.length, 0); // the pre-save guard refuses first (the web build cannot write DWG anyway)
});

test('cadcraft.save_copy is destructive only when overwrite is set', () => {
  const tool = byName('cadcraft.save_copy');
  assert.equal(tool.effect, 'change');
  assert.equal(tool.effectFor({ overwrite: true }), 'destructive');
  assert.equal(tool.effectFor({}), 'change');
});

test('cadcraft.save_copy with no drawing open surfaces the new_drawing teaching error', async () => {
  const wrapper = fakeWrapper();
  const ctx = fileCtx(new Uint8Array([1]), wrapper);
  ctx.craft = () => Promise.resolve({
    commands: () => Promise.resolve([]),
    inspect: () => Promise.resolve({ title: 'Drawing1' }),
    execute: () => Promise.reject(Object.assign(new Error('no drawing open'), { code: 'app_error' })),
  });
  await assert.rejects(byName('cadcraft.save_copy').run({ path: '/CadCraft/plan.dxf' }, ctx), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    assert.equal(error.message, 'CadCraft has no drawing open.');
    assert.equal(error.fix, callLine('cadcraft.new_drawing'));
    return true;
  });
});

const { skills, errors: skillErrors } = parseSkills(SKILLS_MD, 'cadcraft');

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

test('every skill opens by launching CADCraft, then uses numbered cadcraft steps', () => {
  for (const skill of skills) {
    assert.equal(skill.steps[0].line, '1. call_tool tool=desktop.open_app app=cadcraft', `skill ${skill.slug}`);
    skill.steps.forEach((step, i) => {
      assert.equal(step.n, i + 1, `skill ${skill.slug} step numbering`);
      assert.ok(step.tool.startsWith('desktop.') || step.tool.startsWith('cadcraft.'), `skill ${skill.slug} step ${step.n}: ${step.line}`);
    });
  }
});

test('the drawing skills name the open-drawing check, so a missing one names the fix', () => {
  // draw-a-circle/line step 2 is now the flat tool (its no-drawing error, from teachApp,
  // names cadcraft.new_drawing); run-a-cad-script still inspects first.
  const script = skills.find(s => s.slug === 'run-a-cad-script');
  assert.equal(script.steps[1].line, '2. call_tool tool=cadcraft.inspect', 'run-a-cad-script');
  const circle = skills.find(s => s.slug === 'draw-a-circle');
  assert.equal(circle.steps[1].line, '2. call_tool tool=cadcraft.circle center=30,15 radius=8', 'draw-a-circle');
  const line = skills.find(s => s.slug === 'draw-a-line');
  assert.equal(line.steps[1].line, '2. call_tool tool=cadcraft.line p1=30,15 p2=40,15', 'draw-a-line');
  const text = skills.find(s => s.slug === 'add-a-text-label');
  assert.equal(text.steps[1].line, '2. call_tool tool=cadcraft.text at=30,15 text=Lab 7 height=60', 'add-a-text-label');
});

test('skill steps and tools lines validate against the runtime checkArgs', () => {
  const errors = checkSkills(skills, byName, { checkArgs: (tool, args) => checkArgs(tool, args, { choices }) });
  assert.deepEqual(errors, []);
});
