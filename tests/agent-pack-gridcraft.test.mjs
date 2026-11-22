// Unit tests for the GridCraft pack: agent/apps/gridcraft/tools.js and skills.md.
// A fake ctx.craft records calls; every tool must send the exact control method and wire
// params that storytold/gridcraft@v0.19.1 crates/mcp/src/tools.rs dispatches. The schema
// and skills checks reuse the real runtime validators, with the choices function that
// scripts/agent/build.mjs builds the catalog with.
// Run: node --test tests/agent-pack-gridcraft.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack, tools } from '../agent/apps/gridcraft/tools.js';
import { tools as desktopTools } from '../agent/desktop/tools.js';
import { ToolError, specErrors, checkArgs, callLine } from '../src/apps/ai-agent/runtime/args.mjs';
import { parseSkills, checkSkills } from '../src/apps/ai-agent/runtime/skills.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_MD = readFileSync(join(HERE, '..', 'agent', 'apps', 'gridcraft', 'skills.md'), 'utf8');
const APP_IDS = ['gridcraft', 'docs', 'terminal', 'files'];
const choices = name => (name === 'apps' || name === 'windows' ? APP_IDS : []);
const byName = name => tools.find(tool => tool.name === name) ?? desktopTools.find(tool => tool.name === name);

// The live command list, shaped like the lead probe: {id, label, menu, params, shortcut, enabled}.
const COMMANDS = [
  { id: 'cell.set', label: 'Set Cell', menu: 'Home', params: 'cell, input', shortcut: 'F2', enabled: true },
  { id: 'home.bold', label: 'Bold', menu: 'Home', params: 'range', shortcut: 'Ctrl+B', enabled: true },
  { id: 'home.borders', label: 'Borders', menu: 'Home', params: 'range, preset', shortcut: '', enabled: true },
  { id: 'home.fillColor', label: 'Fill Color', menu: 'Home', params: 'range, color', shortcut: '', enabled: true },
  { id: 'data.sort', label: 'Sort', menu: 'Data', params: 'range, keys', shortcut: '', enabled: true },
  { id: 'file.new', label: 'New Workbook', menu: 'File', params: 'sample', shortcut: '', enabled: true },
  { id: 'sheet.delete', label: 'Delete Sheet', menu: 'Home', params: '', shortcut: '', enabled: true },
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
    inspect: rec('inspect', () => ({ sheets: ['Sheet1'] })),
    screenshot: rec('screenshot', () => 'png-base64'),
  };
};
const runTool = (name, args, craft) => byName(name).run(args, { host: {}, craft: () => Promise.resolve(craft) });

test('the pack declares its id and title', () => {
  assert.deepEqual(pack, { id: 'gridcraft', title: 'GridCraft' });
});

test('the pack exposes exactly the 20 gridcraft tools', () => {
  assert.equal(tools.length, 20);
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'gridcraft.create_table', 'gridcraft.evaluate_formula', 'gridcraft.filter', 'gridcraft.format_range',
    'gridcraft.get_cell', 'gridcraft.insert_chart', 'gridcraft.inspect', 'gridcraft.list_commands',
    'gridcraft.list_functions', 'gridcraft.new_workbook', 'gridcraft.open_file', 'gridcraft.read_range',
    'gridcraft.redo', 'gridcraft.run_command', 'gridcraft.save_copy', 'gridcraft.select',
    'gridcraft.set_cell', 'gridcraft.set_cells', 'gridcraft.sort_range', 'gridcraft.undo',
  ]);
});

test('every tool has the required text fields, effect, needs and examples', () => {
  for (const tool of tools) {
    assert.match(tool.name, /^gridcraft\.[a-z0-9_]+$/);
    assert.ok(tool.purpose.length > 0 && tool.purpose.length <= 80, `${tool.name} purpose is ${tool.purpose.length} chars`);
    assert.ok(tool.when.startsWith('Use when'), `${tool.name} when must start with "Use when"`);
    assert.ok(tool.when.length <= 120, `${tool.name} when is ${tool.when.length} chars`);
    assert.ok(['read', 'change', 'destructive', 'external'].includes(tool.effect), `${tool.name} bad effect`);
    const fileTools = ['gridcraft.open_file', 'gridcraft.save_copy'];
    assert.deepEqual(tool.needs, fileTools.includes(tool.name) ? ['host', 'app:gridcraft', 'files'] : ['host', 'app:gridcraft']);
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

test('the effects are read for reads, change for edits, and new_workbook is change', () => {
  const reads = ['gridcraft.inspect', 'gridcraft.read_range', 'gridcraft.get_cell', 'gridcraft.evaluate_formula', 'gridcraft.list_functions', 'gridcraft.list_commands'];
  for (const name of reads) assert.equal(byName(name).effect, 'read', name);
  for (const tool of tools) if (!reads.includes(tool.name)) assert.equal(tool.effect, 'change', tool.name);
});

test('gridcraft.inspect calls the adapter inspect', async () => {
  const craft = fakeCraft();
  assert.deepEqual(await runTool('gridcraft.inspect', {}, craft), { sheets: ['Sheet1'] });
  assert.deepEqual(craft.calls, [['inspect']]);
});

test('gridcraft.read_range sends sheet.read with only the given wire fields', async () => {
  const craft = fakeCraft();
  await runTool('gridcraft.read_range', { range: 'A1:D4', sheet: 'Sheet2' }, craft);
  await runTool('gridcraft.read_range', {}, craft);
  assert.deepEqual(craft.calls, [['request', 'sheet.read', { range: 'A1:D4', sheet: 'Sheet2' }], ['request', 'sheet.read', {}]]);
});

test('gridcraft.set_cells maps start onto the wire field range of range.setValues', async () => {
  const craft = fakeCraft();
  await runTool('gridcraft.set_cells', { start: 'A1', values: [['Item', 'Cost'], ['Rent', 1200]] }, craft);
  assert.deepEqual(craft.calls, [['execute', 'range.setValues', { range: 'A1', values: [['Item', 'Cost'], ['Rent', 1200]] }]]);
});

test('gridcraft.set_cell and gridcraft.get_cell send cell.set and cell.get', async () => {
  const craft = fakeCraft();
  await runTool('gridcraft.set_cell', { cell: 'B7', input: '=SUM(A1:A6)' }, craft);
  await runTool('gridcraft.get_cell', { cell: 'B7' }, craft);
  assert.deepEqual(craft.calls, [
    ['execute', 'cell.set', { cell: 'B7', input: '=SUM(A1:A6)' }],
    ['execute', 'cell.get', { cell: 'B7' }],
  ]);
});

test('gridcraft.evaluate_formula adds the leading = and wraps the result', async () => {
  const craft = fakeCraft();
  const out = await runTool('gridcraft.evaluate_formula', { formula: 'SUM(B2:B10)', cell: 'C1' }, craft);
  assert.deepEqual(craft.calls, [['execute', 'formulas.evaluate', { formula: '=SUM(B2:B10)', cell: 'C1' }]]);
  assert.deepEqual(out, { formula: '=SUM(B2:B10)', result: { command: 'formulas.evaluate', params: { formula: '=SUM(B2:B10)', cell: 'C1' } } });
  await runTool('gridcraft.evaluate_formula', { formula: '=A1+A2' }, craft);
  assert.deepEqual(craft.calls.at(-1), ['execute', 'formulas.evaluate', { formula: '=A1+A2' }]);
});

test('gridcraft.select sends selection.set with range and active', async () => {
  const craft = fakeCraft();
  await runTool('gridcraft.select', { range: 'A1:B2', active: 'B2' }, craft);
  assert.deepEqual(craft.calls, [['execute', 'selection.set', { range: 'A1:B2', active: 'B2' }]]);
});

test('gridcraft.format_range flattens to one home.* command per style, tools.rs order', async () => {
  const craft = fakeCraft();
  const out = await runTool('gridcraft.format_range', { range: 'A1:C1', bold: true, fill: '#FF0000', align: 'right' }, craft);
  assert.deepEqual(craft.calls, [
    ['execute', 'home.bold', { range: 'A1:C1', on: true }],
    ['execute', 'home.fillColor', { range: 'A1:C1', color: '#FF0000' }],
    ['execute', 'home.alignRight', { range: 'A1:C1' }],
  ]);
  assert.deepEqual(out, { range: 'A1:C1', applied: ['home.bold', 'home.fillColor', 'home.alignRight'] });
  await assert.rejects(runTool('gridcraft.format_range', { range: 'A1:C1' }, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'invalid_argument');
    assert.match(error.message, /at least one of/);
    return true;
  });
});

test('gridcraft.insert_chart and gridcraft.create_table send insert.chart and insert.table', async () => {
  const craft = fakeCraft();
  await runTool('gridcraft.insert_chart', { range: 'A1:C6', type: 'column', subtype: 'stacked', title: 'Sales', at: 'E1' }, craft);
  await runTool('gridcraft.insert_chart', { range: 'A1:C6', type: 'pie' }, craft);
  await runTool('gridcraft.create_table', { range: 'A1:D20', style: 'TableStyleLight9', header: true, name: 'T1' }, craft);
  assert.deepEqual(craft.calls[0], ['execute', 'insert.chart', { range: 'A1:C6', type: 'column', subtype: 'stacked', title: 'Sales', at: 'E1' }]);
  assert.deepEqual(craft.calls[1], ['execute', 'insert.chart', { range: 'A1:C6', type: 'pie' }]);
  assert.deepEqual(craft.calls[2], ['execute', 'insert.table', { range: 'A1:D20', style: 'TableStyleLight9', header: true, name: 'T1' }]);
});

test('gridcraft.sort_range normalizes keys the way tools.rs does, then data.sort', async () => {
  const craft = fakeCraft();
  await runTool('gridcraft.sort_range', { keys: ['B', 'A desc'], range: 'A1:D20', header: true }, craft);
  assert.deepEqual(craft.calls, [['execute', 'data.sort', { keys: [{ column: 'B', order: 'asc' }, { column: 'A', order: 'desc' }], range: 'A1:D20', header: true }]]);
});

test('gridcraft.filter sends selection.set for range, then data.filterBy with nested custom and top', async () => {
  const craft = fakeCraft();
  await runTool('gridcraft.filter', { column: 'C', range: 'A1:D10', values: ['North', 'South'], custom_op: '>', custom_value: '100', top_count: 3, top_bottom: true, blanks: true }, craft);
  assert.deepEqual(craft.calls, [
    ['execute', 'selection.set', { range: 'A1:D10' }],
    ['execute', 'data.filterBy', { column: 'C', values: ['North', 'South'], custom: { op: '>', value: '100' }, top: { count: 3, bottom: true }, blanks: true }],
  ]);
  await runTool('gridcraft.filter', { column: 'C', clear: true }, craft);
  assert.deepEqual(craft.calls.at(-1), ['execute', 'data.filterBy', { column: 'C', clear: true }]);
});

test('gridcraft.new_workbook, undo and redo send file.new, edit.undo and edit.redo', async () => {
  const craft = fakeCraft();
  await runTool('gridcraft.new_workbook', { sample: 'budget' }, craft);
  await runTool('gridcraft.new_workbook', {}, craft);
  await runTool('gridcraft.undo', { steps: 2 }, craft);
  await runTool('gridcraft.undo', {}, craft);
  await runTool('gridcraft.redo', {}, craft);
  assert.deepEqual(craft.calls, [
    ['execute', 'file.new', { sample: 'budget' }],
    ['execute', 'file.new', {}],
    ['execute', 'edit.undo', { steps: 2 }],
    ['execute', 'edit.undo', {}],
    ['execute', 'edit.redo', {}],
  ]);
});

test('gridcraft.list_functions sends formulas.functions with search and category', async () => {
  const craft = fakeCraft();
  await runTool('gridcraft.list_functions', { search: 'vlookup', category: 'Lookup & Reference' }, craft);
  assert.deepEqual(craft.calls, [['execute', 'formulas.functions', { search: 'vlookup', category: 'Lookup & Reference' }]]);
});

test('gridcraft.list_commands returns the top 10 matches by id, label or menu, trimmed to {id, label, params}', async () => {
  const craft = fakeCraft();
  const byLabel = await runTool('gridcraft.list_commands', { query: 'BOLD' }, craft);
  assert.deepEqual(byLabel, [{ id: 'home.bold', label: 'Bold', params: 'range' }]);
  const byMenu = await runTool('gridcraft.list_commands', { query: 'data' }, craft);
  assert.deepEqual(byMenu.map(row => row.id), ['data.sort']);
  const all = await runTool('gridcraft.list_commands', {}, craft);
  assert.equal(all.length, 7); // fewer than 10 commands in the fake list
  assert.ok(!('shortcut' in all[0]) && !('enabled' in all[0]) && !('menu' in all[0]));
});

test('gridcraft.run_command parses key=value lines with number and boolean coercion', async () => {
  const craft = fakeCraft();
  await runTool('gridcraft.run_command', { command: 'home.bold', params: 'range=A1:C1\non=true\nsteps=2' }, craft);
  assert.deepEqual(craft.calls, [['commands'], ['execute', 'home.bold', { range: 'A1:C1', on: true, steps: 2 }]]);
});

test('gridcraft.run_command rejects an unknown id with invalid_argument and the 3 closest', async () => {
  const craft = fakeCraft();
  await assert.rejects(runTool('gridcraft.run_command', { command: 'cell.setq', params: '' }, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'invalid_argument');
    assert.match(error.message, /unknown command "cell.setq"; closest: cell.set/);
    assert.equal(error.fix, callLine('gridcraft.run_command', { command: 'cell.set' }));
    return true;
  });
});

test('gridcraft.run_command rejects a bad params line with invalid_argument', async () => {
  const craft = fakeCraft();
  await assert.rejects(runTool('gridcraft.run_command', { command: 'cell.set', params: 'nonsense' }, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'invalid_argument');
    assert.match(error.message, /bad params line "nonsense"/);
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
// A ctx with the file tools' needs met: host.appWindow resolves to the fake wrapper and
// files records readBytes/writeBytes calls.
const fileCtx = (bytes, wrapper) => {
  const calls = { read: [], write: [] };
  return {
    calls,
    host: { appWindow: async () => wrapper },
    craft: () => Promise.resolve(fakeCraft()),
    files: {
      readBytes: path => { calls.read.push(path); return Promise.resolve({ path, name: 'budget.xlsx', bytes, size: bytes.byteLength }); },
      writeBytes: (path, b, { overwrite } = {}) => { calls.write.push({ path, size: b.byteLength, overwrite }); return Promise.resolve({ path, size: b.byteLength, created: !overwrite }); },
    },
  };
};

// A craft API whose live command list has file.saveBytes: execute returns the app's
// inline save result (the gridcraft shape: name, bytes a number, base64).
const saveBytesCraft = () => {
  const calls = [];
  const bytes = new Uint8Array([9, 8]);
  const b64 = Buffer.from(bytes).toString('base64');
  return {
    calls,
    craft: () => Promise.resolve({
      commands: async () => [{ id: 'file.saveBytes' }],
      execute: (command, params) => {
        calls.push([command, params]);
        if (command === 'file.saveBytes') return { name: 'budget.xlsx', bytes: bytes.byteLength, base64: b64 };
        return { command, params };
      },
      inspect: async () => ({ sheets: ['Sheet1'] }),
    }),
  };
};

test('gridcraft.open_file reads the file, waits for the load, and returns the opened summary', async () => {
  const wrapper = fakeWrapper();
  const ctx = fileCtx(new Uint8Array([1, 2, 3]), wrapper);
  const state = { sheets: [] };
  const input = wrapper.document.getElementById('file');
  const original = input.dispatchEvent;
  input.dispatchEvent = event => { if (event?.type === 'change') state.sheets = ['data']; return original(event); };
  ctx.craft = () => Promise.resolve({ ...fakeCraft(), inspect: async () => ({ ...state }) });
  const out = await byName('gridcraft.open_file').run({ path: '/GridCraft/budget.xlsx' }, ctx);
  assert.deepEqual(ctx.calls.read, ['/GridCraft/budget.xlsx']);
  assert.equal(wrapper.opened.length, 1);
  assert.equal(wrapper.opened[0].name, 'budget.xlsx');
  assert.deepEqual([...wrapper.opened[0].parts[0]], [1, 2, 3]);
  assert.deepEqual(out, { name: 'budget.xlsx', bytes: 3, opened: '1 sheet' });
});

test('gridcraft.open_file turns a store not_found into a teaching ToolError', async () => {
  const wrapper = fakeWrapper();
  const ctx = fileCtx(new Uint8Array([1]), wrapper);
  ctx.files.readBytes = () => Promise.reject(Object.assign(new Error('/missing.xlsx is not a file.'), { code: 'not_found' }));
  await assert.rejects(byName('gridcraft.open_file').run({ path: '/missing.xlsx' }, ctx), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_found');
    assert.equal(error.message, '/missing.xlsx is not in Files. To open GridCraft itself, use desktop.open_app; to open a file, find it first with files.find.');
    assert.equal(error.fix, 'call_tool tool=desktop.open_app app=gridcraft');
    return true;
  });
  assert.equal(wrapper.opened.length, 0);
});

test('gridcraft.save_copy takes the bytes from file.saveBytes (no path, no download) and writes them', async () => {
  const wrapper = fakeWrapper();
  const ctx = fileCtx(new Uint8Array([1, 2, 3]), wrapper);
  const save = saveBytesCraft();
  ctx.craft = save.craft;
  const out = await byName('gridcraft.save_copy').run({ path: '/GridCraft/budget.xlsx' }, ctx);
  assert.deepEqual(save.calls, [['file.saveBytes', {}]]);
  assert.deepEqual(ctx.calls.write, [{ path: '/GridCraft/budget.xlsx', size: 2, overwrite: false }]);
  assert.deepEqual(out, { path: '/GridCraft/budget.xlsx', name: 'budget.xlsx', size: 2, created: true });
  assert.ok(!('note' in out)); // the saveBytes path downloads nothing
});

test('gridcraft.save_copy passes overwrite through to writeBytes and is destructive only when set', async () => {
  const ctx = fileCtx(new Uint8Array([1]), fakeWrapper());
  const save = saveBytesCraft();
  ctx.craft = save.craft;
  await byName('gridcraft.save_copy').run({ path: '/GridCraft/budget.xlsx', overwrite: true }, ctx);
  assert.deepEqual(ctx.calls.write, [{ path: '/GridCraft/budget.xlsx', size: 2, overwrite: true }]);
  const tool = byName('gridcraft.save_copy');
  assert.equal(tool.effect, 'change');
  assert.equal(tool.effectFor({ overwrite: true }), 'destructive');
  assert.equal(tool.effectFor({ overwrite: false }), 'change');
  assert.equal(tool.effectFor({}), 'change');
});

test('gridcraft.save_copy with an existing path suggests overwrite=true as the fix', async () => {
  const ctx = fileCtx(new Uint8Array([1]), fakeWrapper());
  const save = saveBytesCraft();
  ctx.craft = save.craft;
  ctx.files.writeBytes = () => Promise.reject(Object.assign(new Error('/GridCraft/budget.xlsx already exists.'), { code: 'exists' }));
  await assert.rejects(byName('gridcraft.save_copy').run({ path: '/GridCraft/budget.xlsx' }, ctx), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'exists');
    assert.equal(error.fix, callLine('gridcraft.save_copy', { path: '/GridCraft/budget.xlsx', overwrite: true }));
    return true;
  });
});

test('gridcraft.save_copy refuses a foreign target extension with the .xlsx fix', async () => {
  const ctx = fileCtx(new Uint8Array([1]), fakeWrapper());
  const save = saveBytesCraft();
  ctx.craft = save.craft;
  await assert.rejects(byName('gridcraft.save_copy').run({ path: '/GridCraft/budget.csv' }, ctx), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'invalid_argument');
    assert.match(error.message, /GridCraft saves \.xlsx files; it cannot write \.csv here\./);
    assert.equal(error.fix, callLine('gridcraft.save_copy', { path: '/GridCraft/budget.xlsx' }));
    return true;
  });
  assert.equal(ctx.calls.write.length, 0); // nothing is written under a foreign extension
});

test('gridcraft.save_copy without file.saveBytes falls back to the no-path capture and notes the download', async () => {
  const wrapper = fakeWrapper();
  const ctx = fileCtx(new Uint8Array([1]), wrapper);
  const calls = [];
  ctx.craft = () => Promise.resolve({
    commands: async () => [{ id: 'file.save' }],
    execute: (command, params) => {
      calls.push([command, params]);
      wrapper.fire({ origin: 'https://pc.example', source: wrapper.frame, data: { type: 'gridcraft:save', name: 'budget.xlsx', bytes: new Uint8Array([4, 3, 2, 1]) } });
      return { command, params };
    },
  });
  const out = await byName('gridcraft.save_copy').run({ path: '/GridCraft/budget.xlsx' }, ctx);
  assert.deepEqual(calls, [['file.save', {}]]); // the no-path trigger
  assert.deepEqual(ctx.calls.write, [{ path: '/GridCraft/budget.xlsx', size: 4, overwrite: false }]);
  assert.deepEqual(out, { path: '/GridCraft/budget.xlsx', name: 'budget.xlsx', size: 4, created: true, note: 'the app also downloaded the file in the browser' });
});


const { skills, errors: skillErrors } = parseSkills(SKILLS_MD, 'gridcraft');

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

test('every skill opens by launching GridCraft, then uses numbered gridcraft steps', () => {
  for (const skill of skills) {
    assert.equal(skill.steps[0].line, '1. call_tool tool=desktop.open_app app=gridcraft', `skill ${skill.slug}`);
    skill.steps.forEach((step, i) => {
      assert.equal(step.n, i + 1, `skill ${skill.slug} step numbering`);
      assert.ok(step.tool.startsWith('desktop.') || step.tool.startsWith('gridcraft.'), `skill ${skill.slug} step ${step.n}: ${step.line}`);
    });
  }
});

test('skill steps and tools lines validate against the runtime checkArgs', () => {
  const errors = checkSkills(skills, byName, { checkArgs: (tool, args) => checkArgs(tool, args, { choices }) });
  assert.deepEqual(errors, []);
});
