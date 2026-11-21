// Unit tests for the EffectCraft pack: agent/apps/effectcraft/tools.js and skills.md.
// A fake ctx.craft records calls; every tool must send the exact control method and wire
// params that storytold/effectcraft@v0.24.1 crates/automation/src/tools.rs dispatches. The
// schema and skills checks reuse the real runtime validators, with the choices function that
// scripts/agent/build.mjs builds the catalog with.
// Run: node --test tests/agent-pack-effectcraft.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack, tools, usesCommands, usesMethods } from '../agent/apps/effectcraft/tools.js';
import { tools as desktopTools } from '../agent/desktop/tools.js';
import { ToolError, specErrors, checkArgs, callLine } from '../src/apps/ai-agent/runtime/args.mjs';
import { parseSkills, checkSkills } from '../src/apps/ai-agent/runtime/skills.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_MD = readFileSync(join(HERE, '..', 'agent', 'apps', 'effectcraft', 'skills.md'), 'utf8');
const APP_IDS = ['effectcraft'];
const choices = name => (name === 'apps' ? APP_IDS : []);
const byName = name => tools.find(tool => tool.name === name) ?? desktopTools.find(tool => tool.name === name);

// The live command list, shaped like the command.list reply: {id, label, menu, shortcut,
// params, enabled, why?}.
const COMMANDS = [
  { id: 'comp.new', label: 'New Composition', menu: ['Composition', 'New'], shortcut: null, params: '{name?, width?, height?, frameRate?, duration? (s)}', enabled: true },
  { id: 'layer.newText', label: 'New Text Layer', menu: ['Layer'], shortcut: null, params: '{name?}', enabled: true },
  { id: 'track.delete', label: 'Delete Track', menu: [], shortcut: null, params: '', enabled: true },
  { id: 'time.set', label: 'Set Time', menu: [], shortcut: null, params: '{seconds?|frame?|timecode?}', enabled: true },
  { id: 'command.describe', label: 'Describe Command', menu: [], shortcut: null, params: '{command}', enabled: true },
];
// The layer.tree reply the effect_add flow reads before and after the batch.
const TREE_BEFORE = { id: 7, properties: { children: [{ path: 'transform', children: [] }, { path: 'effects', children: [] }] } };
const TREE_AFTER = {
  id: 7,
  properties: { children: [{ path: 'transform', children: [] }, { path: 'effects', children: [{ path: 'effects/#1', name: 'Gaussian Blur', type: 'group', children: [{ path: 'effects/#1/blurriness', type: 'number', value: 12 }] }] }] },
};
// A fake app API at the ctx.craft level, recording the unified calls the tools make.
const fakeCraft = () => {
  const calls = [];
  const rec = (name, make = () => ({})) => (...args) => { calls.push([name, ...args]); return Promise.resolve(make(...args)); };
  return {
    calls,
    request: rec('request', (method, params) => ({ method, params })),
    execute: rec('execute', (command, params) => {
      if (command === 'project.summary') return { name: 'Project', path: null, dirty: true, comps: [{ id: 1, name: 'Main' }], undo: ['Apply Gaussian Blur', 'Set opacity'] };
      if (command === 'comp.info') return { id: 1, name: 'Main', width: 1920, height: 1080, layers: [{ id: 7, name: 'BG' }] };
      if (command === 'layer.tree') return calls.filter(call => call[1] === 'layer.tree').length === 1 ? TREE_BEFORE : TREE_AFTER;
      return { command, params };
    }),
    commands: rec('commands', () => COMMANDS),
    inspect: rec('inspect', () => ({ panels: ['Layers'] })),
    screenshot: rec('screenshot', () => 'png-base64'),
  };
};
const runTool = (name, args, craft) => byName(name).run(args, { host: {}, craft: () => Promise.resolve(craft) });

test('the pack declares its id, title and live-check exports', () => {
  assert.deepEqual(pack, { id: 'effectcraft', title: 'EffectCraft' });
  assert.deepEqual(usesCommands.sort(), [
    'app.capabilities', 'comp.info', 'edit.history.goto', 'edit.history.list', 'edit.redo', 'edit.undo',
    'effect.apply', 'effect.list', 'engine.batch', 'editor.state', 'file.newProject', 'file.openDemoProject',
    'file.save', 'layer.tree', 'prop.addKey', 'prop.get', 'prop.set', 'prop.setExpression',
    'project.summary', 'script.run', 'text.fonts',
  ].sort());
  assert.deepEqual(usesMethods, []);
});

test('the pack exposes exactly the 20 effectcraft tools', () => {
  assert.equal(tools.length, 20);
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'effectcraft.batch', 'effectcraft.comp', 'effectcraft.effect_add', 'effectcraft.effects_list',
    'effectcraft.fonts_list', 'effectcraft.history', 'effectcraft.inspect', 'effectcraft.keyframe_add',
    'effectcraft.layer', 'effectcraft.list_commands', 'effectcraft.project', 'effectcraft.project_open',
    'effectcraft.project_save', 'effectcraft.property_get', 'effectcraft.property_set', 'effectcraft.redo',
    'effectcraft.run_command', 'effectcraft.script_run', 'effectcraft.state', 'effectcraft.undo',
  ]);
});

test('every tool has the required text fields, effect, needs and examples', () => {
  for (const tool of tools) {
    assert.match(tool.name, /^effectcraft\.[a-z0-9_]+$/);
    assert.ok(tool.purpose.length > 0 && tool.purpose.length <= 80, `${tool.name} purpose is ${tool.purpose.length} chars`);
    assert.ok(tool.when.startsWith('Use when'), `${tool.name} when must start with "Use when"`);
    // run_command lists the destructive ids in when (the model must see them).
    if (tool.name !== 'effectcraft.run_command') assert.ok(tool.when.length <= 120, `${tool.name} when is ${tool.when.length} chars`);
    assert.ok(['read', 'change', 'destructive', 'external'].includes(tool.effect), `${tool.name} bad effect`);
    assert.deepEqual(tool.needs, ['host', 'app:effectcraft']);
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

test('the effects are read for reads, destructive for project replacement, change for the rest', () => {
  for (const name of ['effectcraft.inspect', 'effectcraft.project', 'effectcraft.comp', 'effectcraft.layer', 'effectcraft.property_get', 'effectcraft.effects_list', 'effectcraft.fonts_list', 'effectcraft.state', 'effectcraft.list_commands']) {
    assert.equal(byName(name).effect, 'read', name);
  }
  assert.equal(byName('effectcraft.project_open').effect, 'destructive');
  for (const tool of tools) if (tool.effect !== 'read' && tool.effect !== 'destructive') assert.equal(tool.effect, 'change', tool.name);
});

test('effectcraft.inspect runs project.summary then comp.info, null when the comp read fails', async () => {
  const craft = fakeCraft();
  const out = await runTool('effectcraft.inspect', {}, craft);
  assert.deepEqual(craft.calls, [['execute', 'project.summary', {}], ['execute', 'comp.info', {}]]);
  assert.ok(out.project && out.activeComp);
  const failing = fakeCraft();
  failing.execute = (command) => (command === 'project.summary' ? Promise.resolve({ name: 'P' }) : Promise.reject(new Error('no comp')));
  assert.deepEqual(await runTool('effectcraft.inspect', {}, failing), { project: { name: 'P' }, activeComp: null });
});

test('project, comp, layer and property_get send their engine queries', async () => {
  const craft = fakeCraft();
  await runTool('effectcraft.project', {}, craft);
  await runTool('effectcraft.comp', { comp: 'Titles' }, craft);
  await runTool('effectcraft.layer', { layer: '1', depth: 2, time: 5 }, craft);
  await runTool('effectcraft.property_get', { layer: '1', path: 'transform/opacity', time: 1 }, craft);
  assert.deepEqual(craft.calls, [
    ['execute', 'project.summary', {}],
    ['execute', 'comp.info', { comp: 'Titles' }],
    ['execute', 'layer.tree', { layer: '1', depth: 2, time: 5 }],
    ['execute', 'prop.get', { layer: '1', path: 'transform/opacity', time: 1 }],
  ]);
});

test('property_set sends prop.set, prop.addKey at a time, prop.setExpression, then reads back', async () => {
  const craft = fakeCraft();
  await runTool('effectcraft.property_set', { layer: '1', path: 'transform/opacity', value: '50' }, craft);
  await runTool('effectcraft.property_set', { layer: '1', path: 'transform/position', value: '[10,20]', time: 2, timeBase: 'comp' }, craft);
  await runTool('effectcraft.property_set', { layer: '1', path: 'transform/opacity', expression: 'time*10' }, craft);
  assert.deepEqual(craft.calls, [
    ['execute', 'prop.set', { layer: '1', path: 'transform/opacity', value: 50 }],
    ['execute', 'prop.get', { layer: '1', path: 'transform/opacity' }],
    ['execute', 'prop.addKey', { layer: '1', path: 'transform/position', value: [10, 20], time: 2, timeBase: 'comp' }],
    ['execute', 'prop.get', { layer: '1', path: 'transform/position', time: 2 }],
    ['execute', 'prop.setExpression', { layer: '1', path: 'transform/opacity', expression: 'time*10' }],
    ['execute', 'prop.get', { layer: '1', path: 'transform/opacity' }],
  ]);
  await assert.rejects(runTool('effectcraft.property_set', { layer: '1', path: 'transform/opacity' }, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.match(error.message, /give value and\/or expression/);
    return true;
  });
});

test('keyframe_add sends one prop.addKey per key, then reads the property back', async () => {
  const craft = fakeCraft();
  await runTool('effectcraft.keyframe_add', { layer: '1', path: 'transform/opacity', keys: '[{"time":0,"value":0},{"time":1,"value":100}]' }, craft);
  assert.deepEqual(craft.calls, [
    ['execute', 'prop.addKey', { layer: '1', path: 'transform/opacity', time: 0, value: 0 }],
    ['execute', 'prop.addKey', { layer: '1', path: 'transform/opacity', time: 1, value: 100 }],
    ['execute', 'prop.get', { layer: '1', path: 'transform/opacity' }],
  ]);
  await assert.rejects(runTool('effectcraft.keyframe_add', { layer: '1', path: 'transform/opacity', keys: 'nope' }, craft), error => {
    assert.match(error.message, /keys must be a JSON array/);
    return true;
  });
  await assert.rejects(runTool('effectcraft.keyframe_add', { layer: '1', path: 'transform/opacity', keys: '[{"value":1}]' }, craft), error => {
    assert.match(error.message, /each key needs a time/);
    return true;
  });
});

test('effect_add runs one engine.batch of effect.apply plus prop.set per value, and reports the new instance', async () => {
  const craft = fakeCraft();
  const out = await runTool('effectcraft.effect_add', { layer: '1', effect: 'Gaussian Blur', values: '{"blurriness":12}' }, craft);
  assert.deepEqual(craft.calls[0], ['execute', 'layer.tree', { layer: '1' }]);
  assert.deepEqual(craft.calls[1], ['execute', 'engine.batch', {
    steps: [
      { command: 'effect.apply', params: { effect: 'Gaussian Blur', layers: ['1'] } },
      { command: 'prop.set', params: { layer: '1', path: 'effects/#1/blurriness', value: 12 } },
    ],
    label: 'Apply Gaussian Blur',
  }]);
  assert.deepEqual(craft.calls[2], ['execute', 'layer.tree', { layer: '1' }]);
  assert.deepEqual(out, { layer: 7, index: 1, path: 'effects/#1', set: ['blurriness'], name: 'Gaussian Blur', params: [{ path: 'effects/#1/blurriness', type: 'number', value: 12 }] });
  await assert.rejects(runTool('effectcraft.effect_add', { layer: '1', effect: 'Glow', values: 'nope' }, craft), error => {
    assert.match(error.message, /values must be a JSON object/);
    return true;
  });
});

test('effects_list, fonts_list, state and script_run send their engine commands', async () => {
  const craft = fakeCraft();
  await runTool('effectcraft.effects_list', { filter: 'blur' }, craft);
  await runTool('effectcraft.fonts_list', { query: 'mono' }, craft);
  const state = await runTool('effectcraft.state', {}, craft);
  await runTool('effectcraft.script_run', { code: 'x', name: 'dim' }, craft);
  assert.deepEqual(craft.calls.slice(0, 2), [['execute', 'effect.list', { filter: 'blur' }], ['execute', 'text.fonts', { query: 'mono' }]]);
  assert.deepEqual(craft.calls[4], ['execute', 'script.run', { code: 'x', name: 'dim' }]);
  assert.ok(state.state && state.app);
});

test('project_open runs demo or new then project.summary, and refuses without one', async () => {
  const craft = fakeCraft();
  await runTool('effectcraft.project_open', { demo: true }, craft);
  assert.deepEqual(craft.calls, [['execute', 'file.openDemoProject', {}], ['execute', 'project.summary', {}]]);
  await runTool('effectcraft.project_open', { new: true }, craft);
  assert.deepEqual(craft.calls.at(-2), ['execute', 'file.newProject', {}]);
  await assert.rejects(runTool('effectcraft.project_open', {}, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.match(error.message, /give demo: true or new: true/);
    return true;
  });
});

test('project_save runs file.save then reports the summary path and dirty flag', async () => {
  const craft = fakeCraft();
  const out = await runTool('effectcraft.project_save', {}, craft);
  assert.deepEqual(craft.calls, [['execute', 'file.save', {}], ['execute', 'project.summary', {}]]);
  assert.deepEqual(out, { path: null, dirty: true });
});

test('undo and redo run the steps until one fails, then report the stack', async () => {
  const craft = fakeCraft();
  const limited = {
    calls: craft.calls,
    request: craft.request,
    commands: craft.commands,
    inspect: craft.inspect,
    execute: async (command, params) => {
      craft.calls.push(['execute', command, params]);
      if (command === 'edit.undo' && craft.calls.filter(call => call[1] === 'edit.undo').length > 2) throw new Error('nothing left to undo');
      return command === 'project.summary' ? { undo: ['a'] } : {};
    },
  };
  const out = await byName('effectcraft.undo').run({ steps: 3 }, { host: {}, craft: () => Promise.resolve(limited) });
  assert.deepEqual(out, { steps: 2, undoStack: ['a'] });
  assert.equal(craft.calls.filter(call => call[1] === 'edit.undo').length, 3);
  const empty = fakeCraft();
  empty.execute = () => Promise.reject(new Error('nothing to undo'));
  await assert.rejects(byName('effectcraft.undo').run({}, { host: {}, craft: () => Promise.resolve(empty) }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'app_error');
    return true;
  });
  await runTool('effectcraft.redo', {}, craft);
  assert.deepEqual(craft.calls.at(-2), ['execute', 'edit.redo', {}]);
});

test('history lists the stack, and goto sends an index for numbers and an id otherwise', async () => {
  const craft = fakeCraft();
  await runTool('effectcraft.history', {}, craft);
  await runTool('effectcraft.history', { goto: '3' }, craft);
  await runTool('effectcraft.history', { goto: 'abc-123' }, craft);
  assert.deepEqual(craft.calls, [
    ['execute', 'edit.history.list', {}],
    ['execute', 'edit.history.goto', { index: 3 }],
    ['execute', 'edit.history.list', {}],
    ['execute', 'edit.history.goto', { id: 'abc-123' }],
    ['execute', 'edit.history.list', {}],
  ]);
});

test('batch sends one engine.batch with the parsed steps and optional label/atomic', async () => {
  const craft = fakeCraft();
  await runTool('effectcraft.batch', { steps: '[{"command":"comp.new","params":{"name":"Titles"}},{"command":"layer.newText"}]', label: 'Titles', atomic: false }, craft);
  assert.deepEqual(craft.calls, [['execute', 'engine.batch', {
    steps: [{ command: 'comp.new', params: { name: 'Titles' } }, { command: 'layer.newText' }],
    label: 'Titles',
    atomic: false,
  }]]);
  await assert.rejects(runTool('effectcraft.batch', { steps: 'nope' }, craft), error => {
    assert.match(error.message, /steps must be a JSON array/);
    return true;
  });
  await assert.rejects(runTool('effectcraft.batch', { steps: '[{"params":{}}]' }, craft), error => {
    assert.match(error.message, /non-empty JSON array of \{command, params\?\}/);
    return true;
  });
});

test('effectcraft.list_commands filters by id, label or the array menu, top 10', async () => {
  const craft = fakeCraft();
  const byMenu = await runTool('effectcraft.list_commands', { query: 'composition' }, craft);
  assert.deepEqual(byMenu.map(row => row.id), ['comp.new']);
  const all = await runTool('effectcraft.list_commands', {}, craft);
  assert.equal(all.length, 5);
  assert.ok('enabled' in all[0]);
});

test('effectcraft.run_command parses key=value lines, checks the id and coerces values', async () => {
  const craft = fakeCraft();
  await runTool('effectcraft.run_command', { command: 'time.set', params: 'seconds=5\nframe=120' }, craft);
  assert.deepEqual(craft.calls, [['commands'], ['execute', 'time.set', { seconds: 5, frame: 120 }]]);
  await assert.rejects(runTool('effectcraft.run_command', { command: 'comp.news' }, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.match(error.message, /unknown command "comp.news"; closest: comp.new/);
    assert.equal(error.fix, callLine('effectcraft.run_command', { command: 'comp.new' }));
    return true;
  });
  await assert.rejects(runTool('effectcraft.run_command', { command: 'time.set', params: 'nonsense' }, craft), error => {
    assert.match(error.message, /bad params line "nonsense"/);
    return true;
  });
});

test('effectFor marks destructive command ids for run_command and batch', () => {
  const run = byName('effectcraft.run_command');
  assert.equal(run.effectFor({ command: 'track.delete' }), 'destructive');
  assert.equal(run.effectFor({ command: 'file.close' }), 'destructive');
  assert.equal(run.effectFor({ command: 'comp.new' }), 'change');
  const batch = byName('effectcraft.batch');
  assert.equal(batch.effectFor({ steps: '[{"command":"comp.new"},{"command":"effect.remove"}]' }), 'destructive');
  assert.equal(batch.effectFor({ steps: '[{"command":"comp.new"}]' }), 'change');
});

const { skills, errors: skillErrors } = parseSkills(SKILLS_MD, 'effectcraft');

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

test('every skill opens by launching EffectCraft, then uses numbered effectcraft steps', () => {
  for (const skill of skills) {
    assert.equal(skill.steps[0].line, '1. call_tool tool=desktop.open_app app=effectcraft', `skill ${skill.slug}`);
    skill.steps.forEach((step, i) => {
      assert.equal(step.n, i + 1, `skill ${skill.slug} step numbering`);
      assert.ok(step.tool.startsWith('desktop.') || step.tool.startsWith('effectcraft.'), `skill ${skill.slug} step ${step.n}: ${step.line}`);
    });
  }
});

test('skill steps and tools lines validate against the runtime checkArgs', () => {
  const errors = checkSkills(skills, byName, { checkArgs: (tool, args) => checkArgs(tool, args, { choices }) });
  assert.deepEqual(errors, []);
});
