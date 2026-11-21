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
import { pack, tools, usesCommands, usesMethods } from '../agent/apps/cadcraft/tools.js';
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
  assert.deepEqual(usesCommands, ['entities', 'texts', 'new']);
  assert.deepEqual(usesMethods, ['cmdline.input', 'cmdline.script', 'drawing.inspect', 'cmdline.key']);
});

test('the pack exposes exactly the 9 cadcraft tools', () => {
  assert.equal(tools.length, 9);
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'cadcraft.cancel', 'cadcraft.command_line', 'cadcraft.find_text', 'cadcraft.inspect',
    'cadcraft.list_commands', 'cadcraft.new_drawing', 'cadcraft.query_entities',
    'cadcraft.run_command', 'cadcraft.script',
  ]);
});

test('every tool has the required text fields, effect, needs and examples', () => {
  for (const tool of tools) {
    assert.match(tool.name, /^cadcraft\.[a-z0-9_]+$/);
    assert.ok(tool.purpose.length > 0 && tool.purpose.length <= 80, `${tool.name} purpose is ${tool.purpose.length} chars`);
    assert.ok(tool.when.startsWith('Use when'), `${tool.name} when must start with "Use when"`);
    assert.ok(tool.when.length <= 120, `${tool.name} when is ${tool.when.length} chars`);
    assert.ok(['read', 'change', 'destructive', 'external'].includes(tool.effect), `${tool.name} bad effect`);
    assert.deepEqual(tool.needs, ['host', 'app:cadcraft']);
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
    ['request', 'cmdline.script', { text: 'line\n0,0' }],
    ['request', 'cmdline.key', { key: 'escape' }],
  ]);
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
  assert.deepEqual(craft.calls, [['commands'], ['execute', 'circle', { center: '[0,0]', radius: 5 }]]);
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

const { skills, errors: skillErrors } = parseSkills(SKILLS_MD, 'cadcraft');

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

test('every skill opens by launching CADCraft, then uses numbered cadcraft steps', () => {
  for (const skill of skills) {
    assert.equal(skill.steps[0].line, '1. call_tool tool=desktop.open_app app=cadcraft', `skill ${skill.slug}`);
    skill.steps.forEach((step, i) => {
      assert.equal(step.n, i + 1, `skill ${skill.slug} step numbering`);
      assert.ok(step.tool.startsWith('desktop.') || step.tool.startsWith('cadcraft.'), `skill ${skill.slug} step ${step.n}: ${step.line}`);
    });
  }
});

test('the drawing skills check the open drawing first (step 2), so a missing one names the fix', () => {
  for (const slug of ['draw-a-circle', 'draw-a-line', 'run-a-cad-script']) {
    const skill = skills.find(s => s.slug === slug);
    assert.equal(skill.steps[1].line, '2. call_tool tool=cadcraft.inspect', `skill ${slug}`);
  }
});

test('skill steps and tools lines validate against the runtime checkArgs', () => {
  const errors = checkSkills(skills, byName, { checkArgs: (tool, args) => checkArgs(tool, args, { choices }) });
  assert.deepEqual(errors, []);
});
