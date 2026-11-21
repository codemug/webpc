// Unit tests for the DeckCraft pack: agent/apps/deckcraft/tools.js and skills.md.
// A fake ctx.craft records calls; every tool must send the exact control method and wire
// params that storytold/deckcraft@v0.18.1 crates/mcp/src/tools.rs dispatches. The schema
// and skills checks reuse the real runtime validators, with the choices function that
// scripts/agent/build.mjs builds the catalog with.
// Run: node --test tests/agent-pack-deckcraft.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack, tools, usesCommands, usesMethods } from '../agent/apps/deckcraft/tools.js';
import { tools as desktopTools } from '../agent/desktop/tools.js';
import { ToolError, specErrors, checkArgs, callLine } from '../src/apps/ai-agent/runtime/args.mjs';
import { parseSkills, checkSkills } from '../src/apps/ai-agent/runtime/skills.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_MD = readFileSync(join(HERE, '..', 'agent', 'apps', 'deckcraft', 'skills.md'), 'utf8');
const APP_IDS = ['deckcraft'];
const choices = name => (name === 'apps' ? APP_IDS : []);
const byName = name => tools.find(tool => tool.name === name) ?? desktopTools.find(tool => tool.name === name);

// The live command list, shaped like the craft-web-api commands() reply.
const COMMANDS = [
  { id: 'slide.new', label: 'New Slide', menu: 'Home', params: 'layout, title, body', shortcut: '', enabled: true },
  { id: 'slide.delete', label: 'Delete Slide', menu: 'Home', params: 'index', shortcut: '', enabled: true },
  { id: 'format.bold', label: 'Bold', menu: 'Format', params: 'ids', shortcut: 'Cmd+B', enabled: true },
  { id: 'file.new', label: 'New Presentation', menu: 'File', params: 'theme, blank', shortcut: '', enabled: true },
  { id: 'text.set', label: 'Set Text', menu: 'Format', params: 'id, text', shortcut: '', enabled: true },
];
// A fake app API at the ctx.craft level, recording the unified calls the tools make.
// shape.insert and insert.toolbox answer with an id, as the engine does.
const fakeCraft = () => {
  const calls = [];
  const rec = (name, make = () => ({})) => (...args) => { calls.push([name, ...args]); return Promise.resolve(make(...args)); };
  return {
    calls,
    request: rec('request', (method, params) => ({ method, params })),
    execute: rec('execute', (command, params) => (['shape.insert', 'insert.textBox'].includes(command) ? { id: 99, command, params } : { command, params })),
    commands: rec('commands', () => COMMANDS),
    inspect: rec('inspect', () => ({ slides: ['Title'] })),
    screenshot: rec('screenshot', () => 'png-base64'),
  };
};
const runTool = (name, args, craft) => byName(name).run(args, { host: {}, craft: () => Promise.resolve(craft) });

test('the pack declares its id, title and live-check exports', () => {
  assert.deepEqual(pack, { id: 'deckcraft', title: 'DeckCraft' });
  assert.deepEqual(usesCommands.sort(), ['edit.select', 'file.new', 'format.align', 'format.color', 'format.size', 'insert.chart', 'insert.table', 'insert.textBox', 'shape.fill', 'shape.insert', 'shape.line', 'slide.go', 'slide.inspect', 'slide.new', 'text.exit', 'text.set'].sort());
  assert.deepEqual(usesMethods, ['ui.tool.select', 'ui.key', 'ui.text']);
});

test('the pack exposes exactly the 17 deckcraft tools', () => {
  assert.equal(tools.length, 17);
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'deckcraft.add_shape', 'deckcraft.add_slide', 'deckcraft.add_text_box', 'deckcraft.batch',
    'deckcraft.go_to_slide', 'deckcraft.insert_chart', 'deckcraft.insert_table', 'deckcraft.inspect',
    'deckcraft.inspect_slide', 'deckcraft.key', 'deckcraft.list_commands', 'deckcraft.new_presentation',
    'deckcraft.run_command', 'deckcraft.select', 'deckcraft.select_tool', 'deckcraft.set_text',
    'deckcraft.type_text',
  ]);
});

test('every tool has the required text fields, effect, needs and examples', () => {
  for (const tool of tools) {
    assert.match(tool.name, /^deckcraft\.[a-z0-9_]+$/);
    assert.ok(tool.purpose.length > 0 && tool.purpose.length <= 80, `${tool.name} purpose is ${tool.purpose.length} chars`);
    assert.ok(tool.when.startsWith('Use when'), `${tool.name} when must start with "Use when"`);
    assert.ok(tool.when.length <= 120, `${tool.name} when is ${tool.when.length} chars`);
    assert.ok(['read', 'change', 'destructive', 'external'].includes(tool.effect), `${tool.name} bad effect`);
    assert.deepEqual(tool.needs, ['host', 'app:deckcraft']);
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

test('the effects are read for reads, change for edits, destructive for new_presentation', () => {
  const reads = ['deckcraft.inspect', 'deckcraft.inspect_slide', 'deckcraft.list_commands'];
  for (const name of reads) assert.equal(byName(name).effect, 'read', name);
  assert.equal(byName('deckcraft.new_presentation').effect, 'destructive');
  for (const tool of tools) if (!reads.includes(tool.name) && tool.name !== 'deckcraft.new_presentation') assert.equal(tool.effect, 'change', tool.name);
});

test('deckcraft.inspect and inspect_slide call the document and slide inspect', async () => {
  const craft = fakeCraft();
  assert.deepEqual(await runTool('deckcraft.inspect', {}, craft), { slides: ['Title'] });
  await runTool('deckcraft.inspect_slide', { index: 1 }, craft);
  assert.deepEqual(craft.calls, [['inspect'], ['execute', 'slide.inspect', { index: 1 }]]);
});

test('deckcraft.new_presentation, add_slide and go_to_slide send file.new, slide.new and slide.go', async () => {
  const craft = fakeCraft();
  await runTool('deckcraft.new_presentation', { theme: 'Harbor' }, craft);
  await runTool('deckcraft.add_slide', { layout: 'titleAndContent', title: 'Q1' }, craft);
  await runTool('deckcraft.go_to_slide', { index: 2 }, craft);
  assert.deepEqual(craft.calls, [
    ['execute', 'file.new', { theme: 'Harbor' }],
    ['execute', 'slide.new', { layout: 'titleAndContent', title: 'Q1' }],
    ['execute', 'slide.go', { index: 2 }],
  ]);
});

test('deckcraft.add_shape sends shape.insert then optional shape.fill and shape.line', async () => {
  const craft = fakeCraft();
  await runTool('deckcraft.add_shape', { preset: 'rect', x: 1, y: 2, w: 3, h: 4, text: 'Hi', fill: '#123456', line: '#FF0000' }, craft);
  assert.deepEqual(craft.calls, [
    ['execute', 'shape.insert', { preset: 'rect', rect: [1, 2, 3, 4], text: 'Hi' }],
    ['execute', 'shape.fill', { id: 99, color: '#123456' }],
    ['execute', 'shape.line', { id: 99, color: '#FF0000' }],
  ]);
  await runTool('deckcraft.add_shape', { preset: 'line', x: 0, y: 0, w: 10, h: 0, line: 'none' }, craft);
  assert.deepEqual(craft.calls.at(-1), ['execute', 'shape.line', { id: 99, none: true }]);
});

test('deckcraft.add_text_box sends insert.textBox, text.exit, edit.select and the format calls', async () => {
  const craft = fakeCraft();
  await runTool('deckcraft.add_text_box', { x: 40, y: 260, w: 500, text: 'Key numbers', size: 24, align: 'left' }, craft);
  assert.deepEqual(craft.calls, [
    ['execute', 'insert.textBox', { rect: [40, 260, 500, 30], text: 'Key numbers' }],
    ['execute', 'text.exit', {}],
    ['execute', 'edit.select', { ids: [99] }],
    ['execute', 'format.size', { size: 24 }],
    ['execute', 'format.align', { align: 'left' }],
  ]);
});

test('deckcraft.set_text, select, select_tool, key and type_text send their wire calls', async () => {
  const craft = fakeCraft();
  await runTool('deckcraft.set_text', { id: 7, text: 'Updated' }, craft);
  await runTool('deckcraft.select', { ids: ['3', '4'] }, craft);
  await runTool('deckcraft.select_tool', { tool: 'shape', preset: 'ellipse' }, craft);
  await runTool('deckcraft.key', { key: 'B', cmd: true }, craft);
  await runTool('deckcraft.type_text', { text: 'Hello' }, craft);
  assert.deepEqual(craft.calls, [
    ['execute', 'text.set', { id: 7, text: 'Updated' }],
    ['execute', 'edit.select', { ids: [3, 4] }],
    ['request', 'ui.tool.select', { tool: 'shape', preset: 'ellipse' }],
    ['request', 'ui.key', { key: 'B', cmd: true }],
    ['request', 'ui.text', { text: 'Hello' }],
  ]);
});

test('deckcraft.select rejects a non-numeric id', async () => {
  const craft = fakeCraft();
  await assert.rejects(runTool('deckcraft.select', { ids: ['abc'] }, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.match(error.message, /ids must be numbers/);
    return true;
  });
});

test('deckcraft.insert_table sends the box only when all four values are given', async () => {
  const craft = fakeCraft();
  await runTool('deckcraft.insert_table', { rows: 3, cols: 2, data: [['a', 'b']], x: 1, y: 2, w: 3, h: 4 }, craft);
  await runTool('deckcraft.insert_table', { rows: 2, cols: 2 }, craft);
  assert.deepEqual(craft.calls[0], ['execute', 'insert.table', { rows: 3, cols: 2, data: [['a', 'b']], rect: [1, 2, 3, 4] }]);
  assert.deepEqual(craft.calls[1], ['execute', 'insert.table', { rows: 2, cols: 2 }]);
});

test('deckcraft.insert_chart maps series rows to {name, values}', async () => {
  const craft = fakeCraft();
  await runTool('deckcraft.insert_chart', { type: 'column', title: 'Sales', categories: ['Q1', 'Q2'], series: [['Sales', 12, 18]] }, craft);
  assert.deepEqual(craft.calls, [['execute', 'insert.chart', { type: 'column', title: 'Sales', categories: ['Q1', 'Q2'], series: [{ name: 'Sales', values: [12, 18] }] }]]);
});

test('deckcraft.batch runs the steps in order and stops at the first error unless keepGoing', async () => {
  const craft = fakeCraft();
  const failing = {
    calls: craft.calls,
    request: craft.request,
    commands: craft.commands,
    inspect: craft.inspect,
    execute: async (command, params) => {
      craft.calls.push(['execute', command, params]);
      if (command === 'slide.go') throw new Error('no slide 9');
      return { command, params };
    },
  };
  const out = await byName('deckcraft.batch').run(
    { commands: ['slide.new layout=title title=Q1', 'slide.go index=9', 'text.set id=1 text=x'] },
    { host: {}, craft: () => Promise.resolve(failing) },
  );
  assert.deepEqual(out.map(entry => [entry.command, entry.ok]), [['slide.new', true], ['slide.go', false]]);
  assert.equal(out[1].error, 'no slide 9');
  const kept = await byName('deckcraft.batch').run(
    { commands: ['slide.go index=9', 'text.set id=1 text=x'], keepGoing: true },
    { host: {}, craft: () => Promise.resolve(failing) },
  );
  assert.equal(kept.length, 2);
  assert.deepEqual(craft.calls.map(call => call[1]), ['slide.new', 'slide.go', 'slide.go', 'text.set']);
});

test('deckcraft.list_commands returns the top 10 matches by id or label', async () => {
  const craft = fakeCraft();
  const byLabel = await runTool('deckcraft.list_commands', { query: 'BOLD' }, craft);
  assert.deepEqual(byLabel, [{ id: 'format.bold', label: 'Bold', menu: 'Format', params: 'ids' }]);
  const all = await runTool('deckcraft.list_commands', {}, craft);
  assert.equal(all.length, 5);
  assert.ok(!('shortcut' in all[0]) && !('enabled' in all[0]));
});

test('deckcraft.run_command parses key=value lines with number and boolean coercion', async () => {
  const craft = fakeCraft();
  await runTool('deckcraft.run_command', { command: 'text.set', params: 'id=7\ntext=Hi' }, craft);
  assert.deepEqual(craft.calls, [['commands'], ['execute', 'text.set', { id: 7, text: 'Hi' }]]);
});

test('deckcraft.run_command rejects an unknown id with invalid_argument and the 3 closest', async () => {
  const craft = fakeCraft();
  await assert.rejects(runTool('deckcraft.run_command', { command: 'slide.newq' }, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'invalid_argument');
    assert.match(error.message, /unknown command "slide.newq"; closest: slide.new/);
    assert.equal(error.fix, callLine('deckcraft.run_command', { command: 'slide.new' }));
    return true;
  });
});

test('deckcraft.run_command rejects a bad params line with invalid_argument', async () => {
  const craft = fakeCraft();
  await assert.rejects(runTool('deckcraft.run_command', { command: 'slide.new', params: 'nonsense' }, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.match(error.message, /bad params line "nonsense"/);
    return true;
  });
});

test('effectFor marks destructive commands for run_command and batch', () => {
  const run = byName('deckcraft.run_command');
  assert.equal(run.effectFor({ command: 'file.new' }), 'destructive');
  assert.equal(run.effectFor({ command: 'slide.delete' }), 'destructive');
  assert.equal(run.effectFor({ command: 'slide.new' }), 'change');
  const batch = byName('deckcraft.batch');
  assert.equal(batch.effectFor({ commands: ['slide.new layout=title', 'slide.delete index=1'] }), 'destructive');
  assert.equal(batch.effectFor({ commands: ['slide.new layout=title'] }), 'change');
});

const { skills, errors: skillErrors } = parseSkills(SKILLS_MD, 'deckcraft');

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

test('every skill opens by launching DeckCraft, then uses numbered deckcraft steps', () => {
  for (const skill of skills) {
    assert.equal(skill.steps[0].line, '1. call_tool tool=desktop.open_app app=deckcraft', `skill ${skill.slug}`);
    skill.steps.forEach((step, i) => {
      assert.equal(step.n, i + 1, `skill ${skill.slug} step numbering`);
      assert.ok(step.tool.startsWith('desktop.') || step.tool.startsWith('deckcraft.'), `skill ${skill.slug} step ${step.n}: ${step.line}`);
    });
  }
});

test('skill steps and tools lines validate against the runtime checkArgs', () => {
  const errors = checkSkills(skills, byName, { checkArgs: (tool, args) => checkArgs(tool, args, { choices }) });
  assert.deepEqual(errors, []);
});
