// Unit tests for the FilmCraft pack: agent/apps/filmcraft/tools.js and skills.md.
// A fake ctx.craft records calls; every tool must send the exact control method and wire
// params that storytold/filmcraft@v0.20.1 crates/automation/src/server.rs dispatches to the
// engine commands of crates/engine/src/commands.rs. The schema and skills checks reuse the
// real runtime validators, with the choices function that scripts/agent/build.mjs builds the
// catalog with.
// Run: node --test tests/agent-pack-filmcraft.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack, tools, usesCommands, usesMethods } from '../agent/apps/filmcraft/tools.js';
import { tools as desktopTools } from '../agent/desktop/tools.js';
import { ToolError, specErrors, checkArgs, callLine } from '../src/apps/ai-agent/runtime/args.mjs';
import { parseSkills, checkSkills } from '../src/apps/ai-agent/runtime/skills.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_MD = readFileSync(join(HERE, '..', 'agent', 'apps', 'filmcraft', 'skills.md'), 'utf8');
const APP_IDS = ['filmcraft'];
const choices = name => (name === 'apps' ? APP_IDS : []);
const byName = name => tools.find(tool => tool.name === name) ?? desktopTools.find(tool => tool.name === name);

// The live command list, shaped like the command.list reply: {id, label, menu (array),
// shortcut, shortcuts, defaultShortcut, params, enabled}.
const COMMANDS = [
  { id: 'timeline.razor', label: 'Razor', menu: [], shortcut: null, shortcuts: [], defaultShortcut: null, params: '{"time":ticks,"track":"V1"|id?,"clip":id?}', enabled: true },
  { id: 'playhead.set', label: 'Set Playhead', menu: [], shortcut: null, shortcuts: [], defaultShortcut: null, params: '{"time":ticks|"frame":i64|"seconds":f64|"timecode":str}', enabled: true },
  { id: 'effects.apply', label: 'Apply Effect', menu: [], shortcut: null, shortcuts: [], defaultShortcut: null, params: '{"clips":[id]?,"effect":"gaussian_blur|Gaussian Blur|…"}', enabled: true },
  { id: 'file.openDemoProject', label: 'Demo Project', menu: ['File', 'New'], shortcut: null, shortcuts: [], defaultShortcut: null, params: '{}', enabled: true },
  { id: 'project.delete', label: 'Clear', menu: ['Project'], shortcut: null, shortcuts: [], defaultShortcut: null, params: '{"items":[id]?}', enabled: true },
];
// A fake app API at the ctx.craft level, recording the unified calls the tools make.
// project.inspect carries the activeSequence item, as inspect_project does.
const fakeCraft = () => {
  const calls = [];
  const rec = (name, make = () => ({})) => (...args) => { calls.push([name, ...args]); return Promise.resolve(make(...args)); };
  return {
    calls,
    request: rec('request', (method, params) => ({ method, params })),
    execute: rec('execute', (command, params) => (command === 'project.inspect' ? { name: 'Project', activeSequence: 9, root: { children: [] } } : { command, params })),
    commands: rec('commands', () => COMMANDS),
    inspect: rec('inspect', () => ({ monitors: ['Program'] })),
    screenshot: rec('screenshot', () => 'png-base64'),
  };
};
const runTool = (name, args, craft) => byName(name).run(args, { host: {}, craft: () => Promise.resolve(craft) });

test('the pack declares its id, title and live-check exports', () => {
  assert.deepEqual(pack, { id: 'filmcraft', title: 'FilmCraft' });
  assert.deepEqual(usesCommands.sort(), [
    'effects.apply', 'effects.list', 'edit.redo', 'edit.undo', 'file.newBin', 'file.newProject',
    'file.openDemoProject', 'playhead.set', 'project.inspect', 'sequence.addEdit', 'sequence.inspect',
    'timeline.move', 'timeline.place', 'timeline.razor',
  ].sort());
  assert.deepEqual(usesMethods, []);
});

test('the pack exposes exactly the 18 filmcraft tools', () => {
  assert.equal(tools.length, 18);
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'filmcraft.add_edit', 'filmcraft.apply_effect', 'filmcraft.batch', 'filmcraft.inspect',
    'filmcraft.list_commands', 'filmcraft.move', 'filmcraft.new_bin', 'filmcraft.new_project',
    'filmcraft.open_demo', 'filmcraft.place', 'filmcraft.playhead', 'filmcraft.project_inspect',
    'filmcraft.razor', 'filmcraft.redo', 'filmcraft.run_command', 'filmcraft.sequence_inspect',
    'filmcraft.ui_inspect', 'filmcraft.undo',
  ]);
});

test('every tool has the required text fields, effect, needs and examples', () => {
  for (const tool of tools) {
    assert.match(tool.name, /^filmcraft\.[a-z0-9_]+$/);
    assert.ok(tool.purpose.length > 0 && tool.purpose.length <= 80, `${tool.name} purpose is ${tool.purpose.length} chars`);
    assert.ok(tool.when.startsWith('Use when'), `${tool.name} when must start with "Use when"`);
    // run_command lists the destructive ids in when (the model must see them).
    if (tool.name !== 'filmcraft.run_command') assert.ok(tool.when.length <= 120, `${tool.name} when is ${tool.when.length} chars`);
    assert.ok(['read', 'change', 'destructive', 'external'].includes(tool.effect), `${tool.name} bad effect`);
    assert.deepEqual(tool.needs, ['host', 'app:filmcraft']);
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

test('the effects are read for the four reads, destructive for project replacement, change for the rest', () => {
  for (const name of ['filmcraft.inspect', 'filmcraft.project_inspect', 'filmcraft.sequence_inspect', 'filmcraft.ui_inspect', 'filmcraft.list_commands']) {
    assert.equal(byName(name).effect, 'read', name);
  }
  for (const name of ['filmcraft.new_project', 'filmcraft.open_demo']) assert.equal(byName(name).effect, 'destructive', name);
  for (const tool of tools) {
    if (!['read', 'destructive'].includes(tool.effect)) assert.equal(tool.effect, 'change', tool.name);
  }
});

test('filmcraft.inspect runs project.inspect then sequence.inspect of the active item', async () => {
  const craft = fakeCraft();
  const out = await runTool('filmcraft.inspect', {}, craft);
  assert.deepEqual(craft.calls, [['execute', 'project.inspect', {}], ['execute', 'sequence.inspect', { item: 9 }]]);
  assert.deepEqual(out, { project: { name: 'Project', activeSequence: 9, root: { children: [] } }, sequence: { command: 'sequence.inspect', params: { item: 9 } } });
});

test('filmcraft.inspect reports sequence null when there is no active sequence or the read fails', async () => {
  const none = fakeCraft();
  none.execute = (command, params) => (command === 'project.inspect' ? Promise.resolve({ name: 'P', activeSequence: null }) : Promise.resolve({ command }));
  assert.deepEqual(await runTool('filmcraft.inspect', {}, none), { project: { name: 'P', activeSequence: null }, sequence: null });
  const failing = fakeCraft();
  failing.execute = (command, params) => (command === 'project.inspect' ? Promise.resolve({ activeSequence: 9 }) : Promise.reject(new Error('no sequence')));
  assert.deepEqual(await runTool('filmcraft.inspect', {}, failing), { project: { activeSequence: 9 }, sequence: null });
});

test('project_inspect, sequence_inspect and ui_inspect send their wire calls', async () => {
  const craft = fakeCraft();
  await runTool('filmcraft.project_inspect', {}, craft);
  await runTool('filmcraft.sequence_inspect', { item: 3 }, craft);
  await runTool('filmcraft.ui_inspect', {}, craft);
  assert.deepEqual(craft.calls, [['execute', 'project.inspect', {}], ['execute', 'sequence.inspect', { item: 3 }], ['inspect', {}]]);
});

test('playhead sends one of seconds, frame or timecode, and rejects without one', async () => {
  const craft = fakeCraft();
  await runTool('filmcraft.playhead', { seconds: 3.5 }, craft);
  await runTool('filmcraft.playhead', { frame: 90 }, craft);
  await runTool('filmcraft.playhead', { timecode: '00:01:00:00' }, craft);
  assert.deepEqual(craft.calls, [
    ['execute', 'playhead.set', { seconds: 3.5 }],
    ['execute', 'playhead.set', { frame: 90 }],
    ['execute', 'playhead.set', { timecode: '00:01:00:00' }],
  ]);
  await assert.rejects(runTool('filmcraft.playhead', {}, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.match(error.message, /give one of seconds, frame or timecode/);
    return true;
  });
});

test('razor sends the time (when given) plus track or clip, at the playhead when timeless', async () => {
  const craft = fakeCraft();
  await runTool('filmcraft.razor', {}, craft);
  await runTool('filmcraft.razor', { seconds: 4, track: 'V1' }, craft);
  await runTool('filmcraft.razor', { timecode: '01:00:00;00', clip: 5 }, craft);
  assert.deepEqual(craft.calls, [
    ['execute', 'timeline.razor', {}],
    ['execute', 'timeline.razor', { seconds: 4, track: 'V1' }],
    ['execute', 'timeline.razor', { timecode: '01:00:00;00', clip: 5 }],
  ]);
});

test('add_edit sends sequence.addEdit with the time or nothing for the playhead', async () => {
  const craft = fakeCraft();
  await runTool('filmcraft.add_edit', {}, craft);
  await runTool('filmcraft.add_edit', { seconds: 2 }, craft);
  assert.deepEqual(craft.calls, [['execute', 'sequence.addEdit', {}], ['execute', 'sequence.addEdit', { seconds: 2 }]]);
});

test('place sends item, time, tracks and the nested sourceIn/duration as seconds objects', async () => {
  const craft = fakeCraft();
  await runTool('filmcraft.place', { item: 3, track: 'V1', seconds: 5 }, craft);
  await runTool('filmcraft.place', { item: 3, track: 'new', source_in: 1.5, duration: 4, audio: false }, craft);
  assert.deepEqual(craft.calls, [
    ['execute', 'timeline.place', { item: 3, seconds: 5, track: 'V1' }],
    ['execute', 'timeline.place', { item: 3, track: 'new', audio: false, sourceIn: { seconds: 1.5 }, duration: { seconds: 4 } }],
  ]);
});

test('move sends the moves with nested time objects, and rejects a move without clip or track', async () => {
  const craft = fakeCraft();
  await runTool('filmcraft.move', { moves: '[{"clip":5,"track":"V2","seconds":10}]', copy: true }, craft);
  assert.deepEqual(craft.calls, [['execute', 'timeline.move', { moves: [{ clip: 5, track: 'V2', time: { seconds: 10 } }], copy: true }]]);
  await assert.rejects(runTool('filmcraft.move', { moves: '[{"track":"V1"}]' }, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.match(error.message, /each move needs a clip and a track/);
    return true;
  });
  await assert.rejects(runTool('filmcraft.move', { moves: 'not json' }, craft), error => {
    assert.match(error.message, /moves must be a JSON array/);
    return true;
  });
  await assert.rejects(runTool('filmcraft.move', { moves: '[]' }, craft), error => {
    assert.match(error.message, /moves needs at least one/);
    return true;
  });
});

test('apply_effect lists the catalogue without effect=, else runs effects.apply', async () => {
  const craft = fakeCraft();
  const catalog = await runTool('filmcraft.apply_effect', { kind: 'Video' }, craft);
  assert.deepEqual(craft.calls[0], ['execute', 'effects.list', { kind: 'Video' }]);
  assert.ok(catalog);
  await runTool('filmcraft.apply_effect', { effect: 'Gaussian Blur', clips: [5] }, craft);
  assert.deepEqual(craft.calls.at(-1), ['execute', 'effects.apply', { effect: 'Gaussian Blur', clips: [5] }]);
});

test('new_bin, new_project, open_demo, undo and redo send their engine commands', async () => {
  const craft = fakeCraft();
  await runTool('filmcraft.new_bin', { name: 'Interviews' }, craft);
  await runTool('filmcraft.new_project', { name: 'Reel' }, craft);
  await runTool('filmcraft.open_demo', {}, craft);
  await runTool('filmcraft.undo', {}, craft);
  await runTool('filmcraft.redo', {}, craft);
  assert.deepEqual(craft.calls, [
    ['execute', 'file.newBin', { name: 'Interviews' }],
    ['execute', 'file.newProject', { name: 'Reel' }],
    ['execute', 'file.openDemoProject', {}],
    ['execute', 'edit.undo', {}],
    ['execute', 'edit.redo', {}],
  ]);
  await assert.rejects(runTool('filmcraft.new_project', {}, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.match(error.message, /a new project needs a name/);
    return true;
  });
});

test('filmcraft.batch runs the steps in order and stops at the first error unless stop_on_error is false', async () => {
  const craft = fakeCraft();
  const failing = {
    calls: craft.calls,
    request: craft.request,
    commands: craft.commands,
    inspect: craft.inspect,
    execute: async (command, params) => {
      craft.calls.push(['execute', command, params]);
      if (command === 'timeline.razor') throw new Error('no sequence');
      return { command, params };
    },
  };
  const out = await byName('filmcraft.batch').run(
    { commands: ['playhead.set seconds=3.5', 'timeline.razor track=V1', 'edit.undo'] },
    { host: {}, craft: () => Promise.resolve(failing) },
  );
  assert.deepEqual(out, {
    completed: 1,
    failed: 1,
    results: [{ ok: true, result: { command: 'playhead.set', params: { seconds: 3.5 } } }, { ok: false, error: 'no sequence' }],
  });
  const kept = await byName('filmcraft.batch').run(
    { commands: ['timeline.razor track=V1', 'edit.undo'], stop_on_error: false },
    { host: {}, craft: () => Promise.resolve(failing) },
  );
  assert.deepEqual(kept, { completed: 1, failed: 1, results: [{ ok: false, error: 'no sequence' }, { ok: true, result: { command: 'edit.undo', params: {} } }] });
});

test('filmcraft.list_commands filters by id, label or the array menu, top 10', async () => {
  const craft = fakeCraft();
  const byMenu = await runTool('filmcraft.list_commands', { query: 'file' }, craft);
  assert.deepEqual(byMenu.map(row => row.id), ['file.openDemoProject']);
  const byLabel = await runTool('filmcraft.list_commands', { query: 'razor' }, craft);
  assert.deepEqual(byLabel.map(row => row.id), ['timeline.razor']);
  const all = await runTool('filmcraft.list_commands', {}, craft);
  assert.equal(all.length, 5);
  assert.ok('enabled' in all[0] && !('defaultShortcut' in all[0]));
});

test('filmcraft.run_command parses key=value lines, checks the id and coerces values', async () => {
  const craft = fakeCraft();
  await runTool('filmcraft.run_command', { command: 'playhead.set', params: 'seconds=2.5\nframe=30' }, craft);
  assert.deepEqual(craft.calls, [['commands'], ['execute', 'playhead.set', { seconds: 2.5, frame: 30 }]]);
  await assert.rejects(runTool('filmcraft.run_command', { command: 'playhead.sets' }, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.match(error.message, /unknown command "playhead.sets"; closest: playhead.set/);
    assert.equal(error.fix, callLine('filmcraft.run_command', { command: 'playhead.set' }));
    return true;
  });
  await assert.rejects(runTool('filmcraft.run_command', { command: 'timeline.razor', params: 'nonsense' }, craft), error => {
    assert.match(error.message, /bad params line "nonsense"/);
    return true;
  });
});

test('effectFor marks destructive command ids for run_command and batch', () => {
  const run = byName('filmcraft.run_command');
  assert.equal(run.effectFor({ command: 'project.delete' }), 'destructive');
  assert.equal(run.effectFor({ command: 'markers.clearIn' }), 'destructive');
  assert.equal(run.effectFor({ command: 'timeline.razor' }), 'change');
  const batch = byName('filmcraft.batch');
  assert.equal(batch.effectFor({ commands: ['playhead.set seconds=1', 'sequence.lift'] }), 'destructive');
  assert.equal(batch.effectFor({ commands: ['playhead.set seconds=1'] }), 'change');
});

const { skills, errors: skillErrors } = parseSkills(SKILLS_MD, 'filmcraft');

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

test('every skill opens by launching FilmCraft, then uses numbered filmcraft steps', () => {
  for (const skill of skills) {
    assert.equal(skill.steps[0].line, '1. call_tool tool=desktop.open_app app=filmcraft', `skill ${skill.slug}`);
    skill.steps.forEach((step, i) => {
      assert.equal(step.n, i + 1, `skill ${skill.slug} step numbering`);
      assert.ok(step.tool.startsWith('desktop.') || step.tool.startsWith('filmcraft.'), `skill ${skill.slug} step ${step.n}: ${step.line}`);
    });
  }
});

test('skill steps and tools lines validate against the runtime checkArgs', () => {
  const errors = checkSkills(skills, byName, { checkArgs: (tool, args) => checkArgs(tool, args, { choices }) });
  assert.deepEqual(errors, []);
});
