// Unit tests for the FigCraft pack: agent/apps/figcraft/tools.js and skills.md.
// A fake ctx.craft records calls; every tool must send the exact control method and wire
// params that storytold/figcraft@v0.18.1 crates/mcp/src/tools.rs dispatches. The schema
// and skills checks reuse the real runtime validators, with the choices function that
// scripts/agent/build.mjs builds the catalog with.
// Run: node --test tests/agent-pack-figcraft.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack, tools, usesCommands, usesMethods } from '../agent/apps/figcraft/tools.js';
import { tools as desktopTools } from '../agent/desktop/tools.js';
import { ToolError, specErrors, checkArgs, callLine } from '../src/apps/ai-agent/runtime/args.mjs';
import { parseSkills, checkSkills } from '../src/apps/ai-agent/runtime/skills.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_MD = readFileSync(join(HERE, '..', 'agent', 'apps', 'figcraft', 'skills.md'), 'utf8');
const APP_IDS = ['figcraft'];
const choices = name => (name === 'apps' ? APP_IDS : []);
const byName = name => tools.find(tool => tool.name === name) ?? desktopTools.find(tool => tool.name === name);

// The live command list, shaped like the craft-web-api commands() reply.
const COMMANDS = [
  { id: 'node.create', label: 'Create Node', menu: 'Object', params: 'type, x, y, width, height, parent, props', shortcut: '', enabled: true },
  { id: 'align.left', label: 'Align Left', menu: 'Arrange', params: 'ids', shortcut: '', enabled: true },
  { id: 'frame.create', label: 'Create Frame', menu: 'Object', params: 'preset, x, y, name', shortcut: '', enabled: true },
  { id: 'file.export', label: 'Export', menu: 'File', params: 'ids, format, scale', shortcut: '', enabled: true },
  { id: 'edit.delete', label: 'Delete', menu: 'Edit', params: 'ids', shortcut: '', enabled: true },
  { id: 'variable.create', label: 'Create Variable', menu: 'Style', params: 'name, values', shortcut: '', enabled: true },
];
// A fake app API at the ctx.craft level, recording the unified calls the tools make.
// node.create answers with an id, as the engine does; document.inspect carries a selection.
const fakeCraft = () => {
  const calls = [];
  const rec = (name, make = () => ({})) => (...args) => { calls.push([name, ...args]); return Promise.resolve(make(...args)); };
  return {
    calls,
    request: rec('request', (method, params) => (method === 'node.get' ? { id: params.id, children: [] } : method === 'document.inspect' ? { selection: [3, 4], pages: [] } : { method, params })),
    execute: rec('execute', (command, params) => (command === 'node.create' ? { id: 7, command, params } : { command, params })),
    commands: rec('commands', () => COMMANDS),
    inspect: rec('inspect', () => ({ document: 'Design.fig' })),
    screenshot: rec('screenshot', () => 'png-base64'),
  };
};
const runTool = (name, args, craft) => byName(name).run(args, { host: {}, craft: () => Promise.resolve(craft) });

test('the pack declares its id, title and live-check exports', () => {
  assert.deepEqual(pack, { id: 'figcraft', title: 'FigCraft' });
  assert.deepEqual(usesCommands.sort(), ['command.batch', 'edit.redo', 'edit.undo', 'file.export', 'file.new', 'node.create', 'node.set', 'select.none', 'select.set', 'text.edit.begin', 'text.edit.end'].sort());
  assert.deepEqual(usesMethods, ['node.get', 'document.inspect', 'ui.key', 'ui.type', 'ui.inspect']);
});

test('the pack exposes exactly the 15 figcraft tools', () => {
  assert.equal(tools.length, 15);
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'figcraft.batch', 'figcraft.create_node', 'figcraft.export', 'figcraft.get_node',
    'figcraft.inspect_document', 'figcraft.inspect_ui', 'figcraft.key', 'figcraft.list_commands',
    'figcraft.new_document', 'figcraft.redo', 'figcraft.run_command', 'figcraft.select',
    'figcraft.set_properties', 'figcraft.type_text', 'figcraft.undo',
  ]);
});

test('every tool has the required text fields, effect, needs and examples', () => {
  for (const tool of tools) {
    assert.match(tool.name, /^figcraft\.[a-z0-9_]+$/);
    assert.ok(tool.purpose.length > 0 && tool.purpose.length <= 80, `${tool.name} purpose is ${tool.purpose.length} chars`);
    assert.ok(tool.when.startsWith('Use when'), `${tool.name} when must start with "Use when"`);
    // run_command and batch list the destructive ids in when (the model must see them).
    if (tool.name !== 'figcraft.run_command') assert.ok(tool.when.length <= 120, `${tool.name} when is ${tool.when.length} chars`);
    assert.ok(['read', 'change', 'destructive', 'external'].includes(tool.effect), `${tool.name} bad effect`);
    assert.deepEqual(tool.needs, ['host', 'app:figcraft']);
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

test('the effects are read for reads and change for everything else', () => {
  const reads = ['figcraft.list_commands', 'figcraft.inspect_document', 'figcraft.get_node', 'figcraft.export', 'figcraft.inspect_ui'];
  for (const name of reads) assert.equal(byName(name).effect, 'read', name);
  for (const tool of tools) if (!reads.includes(tool.name)) assert.equal(tool.effect, 'change', tool.name);
});

test('figcraft.list_commands filters by id, label, menu or params, top 10', async () => {
  const craft = fakeCraft();
  const byMenu = await runTool('figcraft.list_commands', { query: 'arrange' }, craft);
  assert.deepEqual(byMenu.map(row => row.id), ['align.left']);
  const all = await runTool('figcraft.list_commands', {}, craft);
  assert.equal(all.length, 6);
  assert.ok(!('shortcut' in all[0]) && !('enabled' in all[0]));
});

test('figcraft.run_command parses key=value lines, JSON values and coerces numbers', async () => {
  const craft = fakeCraft();
  await runTool('figcraft.run_command', { command: 'align.left', params: 'ids=[3,4]\none=true\nn=2.5' }, craft);
  assert.deepEqual(craft.calls, [['commands'], ['execute', 'align.left', { ids: [3, 4], one: true, n: 2.5 }]]);
});

test('figcraft.run_command rejects an unknown id with invalid_argument and the 3 closest', async () => {
  const craft = fakeCraft();
  await assert.rejects(runTool('figcraft.run_command', { command: 'node.creat' }, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'invalid_argument');
    assert.match(error.message, /unknown command "node.creat"; closest: node.create/);
    assert.equal(error.fix, callLine('figcraft.run_command', { command: 'node.create' }));
    return true;
  });
});

test('figcraft.run_command rejects a bad params line with invalid_argument', async () => {
  const craft = fakeCraft();
  await assert.rejects(runTool('figcraft.run_command', { command: 'align.left', params: 'nonsense' }, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.match(error.message, /bad params line "nonsense"/);
    return true;
  });
});

test('figcraft.batch sends one command.batch with the parsed steps', async () => {
  const craft = fakeCraft();
  await runTool('figcraft.batch', {
    commands: ['node.create type=text text=Hi fontSize=24', 'align.left ids=[3,4]'],
    label: 'Login screen',
    on_error: 'continue',
  }, craft);
  assert.deepEqual(craft.calls, [[
    'execute',
    'command.batch',
    { label: 'Login screen', commands: [{ command: 'node.create', params: { type: 'text', text: 'Hi', fontSize: 24 } }, { command: 'align.left', params: { ids: [3, 4] } }], onError: 'continue' },
  ]]);
});

test('figcraft.batch defaults the label and rejects an empty step list', async () => {
  const craft = fakeCraft();
  await runTool('figcraft.batch', { commands: ['edit.undo'] }, craft);
  assert.deepEqual(craft.calls[0][2], { label: 'Batch', commands: [{ command: 'edit.undo', params: {} }] });
  await assert.rejects(runTool('figcraft.batch', { commands: [] }, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.match(error.message, /commands needs at least one step/);
    return true;
  });
});

test('figcraft.create_node sends node.create with parsed props, then node.get for the id', async () => {
  const craft = fakeCraft();
  const out = await runTool('figcraft.create_node', { type: 'frame', width: 375, height: 812, name: 'Login', props: 'fill=#FFFFFF\ncornerRadius=12' }, craft);
  assert.deepEqual(craft.calls, [
    ['execute', 'node.create', { type: 'frame', width: 375, height: 812, name: 'Login', props: { fill: '#FFFFFF', cornerRadius: 12 } }],
    ['request', 'node.get', { id: 7, depth: 0 }],
  ]);
  assert.deepEqual(out, { id: 7, node: { id: 7, children: [] } });
});

test('figcraft.create_node fails with app_error when node.create returns no id', async () => {
  const craft = fakeCraft();
  craft.execute = (command, params) => (command === 'node.create' ? Promise.resolve({}) : Promise.reject(new Error('unexpected ' + command)));
  await assert.rejects(runTool('figcraft.create_node', { type: 'text', text: 'Hi' }, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'app_error');
    assert.match(error.message, /node.create returned no id/);
    return true;
  });
});

test('figcraft.new_document sends file.new with the name, and a no-document rejection on create_node teaches the fix', async () => {
  const craft = fakeCraft();
  const out = await runTool('figcraft.new_document', { name: 'App' }, craft);
  assert.deepEqual(craft.calls, [['execute', 'file.new', { name: 'App' }]]);
  assert.deepEqual(out, { command: 'file.new', params: { name: 'App' } });
  const failing = fakeCraft();
  failing.execute = () => Promise.reject(Object.assign(new Error('no open document'), { code: 'app_error' })); // the adapter sets the code
  await assert.rejects(runTool('figcraft.create_node', { type: 'text', text: 'Hi' }, failing), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    assert.equal(error.message, 'FigCraft has no document open.');
    assert.equal(error.fix, callLine('figcraft.new_document'));
    return true;
  });
});

test('figcraft.set_properties coerces ids to numbers and parses props', async () => {
  const craft = fakeCraft();
  await runTool('figcraft.set_properties', { ids: ['3', '4'], props: 'fill=#3B5BDB\nopacity=0.9' }, craft);
  assert.deepEqual(craft.calls, [['execute', 'node.set', { props: { fill: '#3B5BDB', opacity: 0.9 }, ids: [3, 4] }]]);
  await runTool('figcraft.set_properties', { props: 'x=10' }, craft);
  assert.deepEqual(craft.calls.at(-1), ['execute', 'node.set', { props: { x: 10 } }]);
});

test('figcraft.inspect_document and get_node send document.inspect and node.get', async () => {
  const craft = fakeCraft();
  await runTool('figcraft.inspect_document', {}, craft);
  await runTool('figcraft.inspect_document', { depth: 2, all_pages: true }, craft);
  await runTool('figcraft.get_node', { id: 4, depth: 1, offset: 10 }, craft);
  assert.deepEqual(craft.calls, [
    ['request', 'document.inspect', { depth: 4, allPages: false }],
    ['request', 'document.inspect', { depth: 2, allPages: true }],
    ['request', 'node.get', { id: 4, depth: 1 }],
  ]);
});

test('figcraft.select sets the selection then reads it back, or deselects when empty', async () => {
  const craft = fakeCraft();
  const out = await runTool('figcraft.select', { ids: [3, 4] }, craft);
  assert.deepEqual(craft.calls, [
    ['execute', 'select.set', { ids: [3, 4] }],
    ['request', 'document.inspect', { depth: 0 }],
  ]);
  assert.deepEqual(out, { selection: [3, 4] });
  await runTool('figcraft.select', { ids: [] }, craft);
  assert.deepEqual(craft.calls.at(-2), ['execute', 'select.none', {}]);
});

test('figcraft.export coerces ids and passes format, scale and size', async () => {
  const craft = fakeCraft();
  await runTool('figcraft.export', { ids: ['1'], format: 'svg', scale: 2 }, craft);
  await runTool('figcraft.export', { format: 'png' }, craft);
  assert.deepEqual(craft.calls, [
    ['execute', 'file.export', { format: 'svg', scale: 2, ids: [1] }],
    ['execute', 'file.export', { format: 'png' }],
  ]);
});

test('figcraft.undo, redo and key send edit.undo, edit.redo and ui.key', async () => {
  const craft = fakeCraft();
  await runTool('figcraft.undo', {}, craft);
  await runTool('figcraft.redo', {}, craft);
  await runTool('figcraft.key', { key: 'G', cmd: true }, craft);
  assert.deepEqual(craft.calls, [
    ['execute', 'edit.undo', {}],
    ['execute', 'edit.redo', {}],
    ['request', 'ui.key', { key: 'G', cmd: true }],
  ]);
});

test('figcraft.type_text with an id enters edit mode, types, always leaves it and reads the node', async () => {
  const craft = fakeCraft();
  const out = await runTool('figcraft.type_text', { id: '4', text: 'New title' }, craft);
  assert.deepEqual(craft.calls, [
    ['execute', 'text.edit.begin', { id: 4 }],
    ['request', 'ui.type', { text: 'New title' }],
    ['execute', 'text.edit.end', {}],
    ['request', 'node.get', { id: 4, depth: 0 }],
  ]);
  assert.deepEqual(out, { ok: true, node: { id: 4, children: [] }, typed: { method: 'ui.type', params: { text: 'New title' } } });
});

test('figcraft.type_text still ends edit mode when typing fails', async () => {
  const craft = fakeCraft();
  craft.request = async (method, params) => {
    craft.calls.push(['request', method, params]);
    if (method === 'ui.type') throw new Error('no text editor');
    return method === 'node.get' ? { id: params.id, children: [] } : { method, params };
  };
  await assert.rejects(runTool('figcraft.type_text', { id: 4, text: 'Hi' }, craft), error => {
    assert.equal(error.message, 'no text editor');
    return true;
  });
  assert.deepEqual(craft.calls, [
    ['execute', 'text.edit.begin', { id: 4 }],
    ['request', 'ui.type', { text: 'Hi' }],
    ['execute', 'text.edit.end', {}],
  ]);
});

test('figcraft.type_text without an id types at the caret', async () => {
  const craft = fakeCraft();
  await runTool('figcraft.type_text', { text: 'Hello' }, craft);
  assert.deepEqual(craft.calls, [['request', 'ui.type', { text: 'Hello' }]]);
});

test('figcraft.inspect_ui sends ui.inspect', async () => {
  const craft = fakeCraft();
  await runTool('figcraft.inspect_ui', {}, craft);
  assert.deepEqual(craft.calls, [['request', 'ui.inspect', {}]]);
});

test('effectFor marks destructive command ids for run_command and batch', () => {
  const run = byName('figcraft.run_command');
  assert.equal(run.effectFor({ command: 'edit.delete' }), 'destructive');
  assert.equal(run.effectFor({ command: 'file.close' }), 'destructive');
  assert.equal(run.effectFor({ command: 'file.new' }), 'change'); // multi-doc: the new document joins the list (lead live gate)
  assert.equal(run.effectFor({ command: 'align.left' }), 'change');
  const batch = byName('figcraft.batch');
  assert.equal(batch.effectFor({ commands: ['node.create type=frame', 'edit.delete ids=[3]'] }), 'destructive');
  assert.equal(batch.effectFor({ commands: ['node.create type=frame'] }), 'change');
});

const { skills, errors: skillErrors } = parseSkills(SKILLS_MD, 'figcraft');

test('skills.md parses with the runtime parser without errors and has 8 skills', () => {
  assert.deepEqual(skillErrors, []);
  assert.equal(skills.length, 8);
  for (const skill of skills) {
    assert.ok(skill.slug && skill.summary, `skill ${skill.slug} slug/summary`);
    assert.ok(skill.summary.length <= 160, `skill ${skill.slug} summary is ${skill.summary.length} chars`);
    assert.ok(skill.keywords.length >= 5, `skill ${skill.slug} keywords: ${skill.keywords.join(', ')}`);
    assert.ok(skill.tools.length >= 1, `skill ${skill.slug} tools`);
    assert.ok(skill.when && skill.steps.length >= 1 && skill.check, `skill ${skill.slug} body sections`);
  }
});

test('every skill opens by launching FigCraft, then uses numbered figcraft steps', () => {
  for (const skill of skills) {
    assert.equal(skill.steps[0].line, '1. call_tool tool=desktop.open_app app=figcraft', `skill ${skill.slug}`);
    skill.steps.forEach((step, i) => {
      assert.equal(step.n, i + 1, `skill ${skill.slug} step numbering`);
      assert.ok(step.tool.startsWith('desktop.') || step.tool.startsWith('figcraft.'), `skill ${skill.slug} step ${step.n}: ${step.line}`);
    });
  }
});

test('content skills create or check the document in step 2, so a missing one is fixed before edits', () => {
  const bySlug = Object.fromEntries(skills.map(skill => [skill.slug, skill]));
  for (const slug of ['design-a-mobile-screen', 'start-a-design-system', 'design-a-landing-page', 'wire-a-prototype-flow']) {
    assert.equal(bySlug[slug].steps[1].line, '2. call_tool tool=figcraft.new_document', `skill ${slug}`);
  }
  for (const slug of ['fix-open-comments', 'create-a-shape-layer', 'style-the-selection']) {
    assert.equal(bySlug[slug].steps[1].line, '2. call_tool tool=figcraft.inspect_document', `skill ${slug}`);
  }
  assert.equal(bySlug['export-the-design'].steps[1].line, '2. call_tool tool=figcraft.select ids=1', 'export keeps the select step');
});

test('skill steps and tools lines validate against the runtime checkArgs', () => {
  const errors = checkSkills(skills, byName, { checkArgs: (tool, args) => checkArgs(tool, args, { choices }) });
  assert.deepEqual(errors, []);
});
