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
    'file.newSequence', 'file.openDemoProject', 'file.save', 'playhead.set', 'project.inspect', 'sequence.addEdit', 'sequence.inspect',
    'timeline.move', 'timeline.place', 'timeline.razor',
  ].sort());
  assert.deepEqual(usesMethods, []);
});

test('the pack exposes exactly the 20 filmcraft tools', () => {
  assert.equal(tools.length, 21);
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'filmcraft.add_edit', 'filmcraft.apply_effect', 'filmcraft.batch', 'filmcraft.inspect',
    'filmcraft.list_commands', 'filmcraft.move', 'filmcraft.new_bin', 'filmcraft.new_project',
    'filmcraft.new_sequence', 'filmcraft.open_demo', 'filmcraft.open_file', 'filmcraft.place', 'filmcraft.playhead',
    'filmcraft.project_inspect',
    'filmcraft.razor', 'filmcraft.redo', 'filmcraft.run_command', 'filmcraft.save_copy', 'filmcraft.sequence_inspect',
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
    const fileTools = ['filmcraft.open_file', 'filmcraft.save_copy'];
    assert.deepEqual(tool.needs, fileTools.includes(tool.name) ? ['host', 'app:filmcraft', 'files'] : ['host', 'app:filmcraft']);
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
  for (const name of ['filmcraft.new_project', 'filmcraft.open_demo', 'filmcraft.open_file']) assert.equal(byName(name).effect, 'destructive', name);
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

test('place resolves a numeric-string id straight, and a name or Files path from the project tree', async () => {
  // The model hands over the id as a string (the runtime coerces the number it sends), the bare
  // file name, or the full Files path (measured on build 14): all must land on the same item id.
  const tree = { name: 'Lookbook', activeSequence: null, root: { id: 0, name: 'Lookbook', children: [
    { children: [], id: 1, name: 'bin' },
    { children: [], duration: 1270080000000, item: 2, name: 'beach-sunset.jpg', type: 'Still Image' },
  ] } };
  const craft = { calls: [], execute: (command, params) => { craft.calls.push([command, params]); return Promise.resolve(command === 'project.inspect' ? tree : { ok: true }); } };
  await runTool('filmcraft.place', { item: '3', track: 'V1', seconds: 5 }, craft);
  await runTool('filmcraft.place', { item: 'beach-sunset.jpg', track: 'V1' }, craft);
  await runTool('filmcraft.place', { item: '/FilmCraft/beach-sunset.jpg', track: 'V1' }, craft);
  assert.deepEqual(craft.calls, [
    // The numeric id needs no project read.
    ['timeline.place', { item: 3, seconds: 5, track: 'V1' }],
    ['project.inspect', {}],
    ['timeline.place', { item: 2, track: 'V1' }],
    ['project.inspect', {}],
    ['timeline.place', { item: 2, track: 'V1' }],
  ]);
});

test('place lists the project items when the name is not in the tree', async () => {
  const tree = { name: 'Lookbook', root: { id: 0, name: 'Lookbook', children: [
    { children: [], id: 1, name: 'bin' },
    { children: [], item: 2, name: 'beach-sunset.jpg', type: 'Still Image' },
  ] } };
  const craft = { execute: command => Promise.resolve(command === 'project.inspect' ? tree : { ok: true }) };
  await assert.rejects(runTool('filmcraft.place', { item: 'missing.jpg', track: 'V1' }, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'invalid_argument');
    assert.match(error.message, /beach-sunset\.jpg \(id 2\)/);
    return true;
  });
});

test('place splits a crammed call blob out of item= and spells the fixed call', async () => {
  // Build 16 sweep (03): the model wrapped the whole call in one argument and the runtime
  // handed the blob to the required item=; "item <blob> is not in the project" looped 20+ rounds.
  const craft = fakeCraft();
  await assert.rejects(
    runTool('filmcraft.place', { item: '{ item: "beach-sunset.jpg", track: "V1", seconds: 0 }' }, craft),
    error => {
      assert.ok(error instanceof ToolError);
      assert.equal(error.type, 'invalid_argument');
      assert.match(error.message, /not the whole call/);
      assert.equal(error.fix, 'call_tool tool=filmcraft.place item=beach-sunset.jpg track=V1 seconds=0');
      return true;
    },
  );
});

test('place and razor teach the V1/A1 track names when the engine rejects a display name', async () => {
  // Build 16 sweep (04/06/07): sequence_inspect shows the display names "Video 1"/"Audio 1"
  // while timeline.place resolves V1..Vn/A1..An, and the "no track X" error listed none of them.
  const craft = {
    execute: (command) => (command === 'sequence.inspect'
      ? Promise.resolve({ video: [{}, {}, {}], audio: [{}, {}] })
      : Promise.reject(new Error('Error: invalid parameters for `timeline.place`: no track Video 1 in this sequence (`track`)'))),
  };
  await assert.rejects(runTool('filmcraft.place', { item: '1', track: 'Video 1' }, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'app_error');
    assert.match(error.message, /track names are V1, V2, V3, A1, A2/);
    assert.match(error.message, /display names/);
    assert.equal(error.fix, 'call_tool tool=filmcraft.place item=<id> track=V1 seconds=<n>');
    return true;
  });
  await assert.rejects(runTool('filmcraft.razor', { track: '1', seconds: 3 }, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.match(error.message, /track names are V1, V2, V3, A1, A2/);
    assert.equal(error.fix, 'call_tool tool=filmcraft.razor track=V1 seconds=<n>');
    return true;
  });
});

test('sequence-dependent commands teach the new_sequence call when no sequence is open', async () => {
  // Build 14: a fresh new_project has no sequence, and the bare engine error sent the model to
  // hammer sequence_inspect for 15 rounds. The same error must now name the creating call.
  for (const [name, args, engineMessage] of [
    ['filmcraft.place', { item: '3', track: 'V1' }, 'no sequence is open'],
    ['filmcraft.sequence_inspect', {}, 'no active sequence'],
  ]) {
    const failing = { execute: () => Promise.reject(new Error(`Error: ${engineMessage}`)) };
    await assert.rejects(runTool(name, args, failing), error => {
      assert.ok(error instanceof ToolError);
      assert.equal(error.type, 'app_error');
      assert.equal(error.fix, 'call_tool tool=filmcraft.new_sequence name=<name>');
      return true;
    });
  }
  // Any other engine error passes through untouched.
  const other = { execute: () => Promise.reject(new Error('track V9 does not exist')) };
  await assert.rejects(runTool('filmcraft.place', { item: '3', track: 'V1' }, other), error => {
    assert.equal(error.name, 'Error');
    assert.equal(error.message, 'track V9 does not exist');
    return true;
  });
});

test('new_sequence runs file.newSequence, named or bare', async () => {
  const craft = fakeCraft();
  await runTool('filmcraft.new_sequence', { name: 'Cut' }, craft);
  await runTool('filmcraft.new_sequence', {}, craft);
  assert.deepEqual(craft.calls, [['execute', 'file.newSequence', { name: 'Cut' }], ['execute', 'file.newSequence', {}]]);
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

// A fake wrapper window for the file tools: the #file input records the change dispatch
// (openFromBytes drives it, app.mjs:38); message listeners are stored so a test can fire
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
      readBytes: path => { calls.read.push(path); return Promise.resolve({ path, name: 'talk.fcproj', bytes, size: bytes.byteLength }); },
      writeBytes: (path, b, { overwrite } = {}) => { calls.write.push({ path, size: b.byteLength, overwrite }); return Promise.resolve({ path, size: b.byteLength, created: !overwrite }); },
    },
  };
};

test('filmcraft.open_file reads the file, drives the wrapper input, and waits for the load', async () => {
  const wrapper = fakeWrapper();
  const ctx = fileCtx(new Uint8Array([1, 2, 3]), wrapper);
  const state = { project: { name: 'Old' } };
  const input = wrapper.document.getElementById('file');
  const original = input.dispatchEvent;
  input.dispatchEvent = event => { if (event?.type === 'change') state.project.name = 'talk'; return original(event); };
  ctx.craft = () => Promise.resolve({ ...fakeCraft(), inspect: async () => state });
  const out = await byName('filmcraft.open_file').run({ path: '/FilmCraft/talk.fcproj' }, ctx);
  assert.deepEqual(ctx.calls.read, ['/FilmCraft/talk.fcproj']);
  assert.equal(wrapper.opened.length, 1);
  assert.equal(wrapper.opened[0].name, 'talk.fcproj');
  assert.deepEqual(out, { name: 'talk.fcproj', bytes: 3, opened: 'the app state changed', next: 'talk.fcproj is open. To check it, call filmcraft.inspect. Opening it again shows a dialog and blocks the app.' });
  assert.equal(byName('filmcraft.open_file').effect, 'destructive'); // a project open replaces the open one
});

test('filmcraft.save_copy triggers the no-path file.save and captures the filmcraft:save bytes', async () => {
  const wrapper = fakeWrapper();
  const ctx = fileCtx(new Uint8Array([1, 2, 3]), wrapper);
  const calls = [];
  ctx.craft = () => Promise.resolve({
    ...fakeCraft(),
    commands: async () => [{ id: 'file.save' }],
    execute: (command, params) => {
      calls.push([command, params]);
      wrapper.fire({ origin: 'https://pc.example', source: wrapper.frame, data: { type: 'filmcraft:save', name: 'talk.fcproj', bytes: new Uint8Array([4, 5]) } });
      return { command, params };
    },
  });
  const out = await byName('filmcraft.save_copy').run({ path: '/FilmCraft/talk.fcproj' }, ctx);
  assert.deepEqual(calls, [['file.save', {}]]); // the no-path trigger (s.path after an open)
  assert.deepEqual(ctx.calls.write, [{ path: '/FilmCraft/talk.fcproj', size: 2, overwrite: false }]);
  assert.deepEqual(out, { path: '/FilmCraft/talk.fcproj', name: 'talk.fcproj', size: 2, created: true, note: 'the app also downloaded the file in the browser' });
});

test('filmcraft.save_copy passes overwrite through and refuses a foreign target extension', async () => {
  const ctx = fileCtx(new Uint8Array([1]), fakeWrapper());
  const tool = byName('filmcraft.save_copy');
  assert.equal(tool.effect, 'change');
  assert.equal(tool.effectFor({ overwrite: true }), 'destructive');
  assert.equal(tool.effectFor({}), 'change');
  ctx.craft = () => Promise.resolve({ ...fakeCraft(), commands: async () => [{ id: 'file.save' }], execute: async () => ({}) });
  await assert.rejects(byName('filmcraft.save_copy').run({ path: '/FilmCraft/talk.mp4' }, ctx), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'invalid_argument');
    assert.match(error.message, /FilmCraft saves \.fcproj files; it cannot write \.mp4 here\./);
    assert.equal(error.fix, callLine('filmcraft.save_copy', { path: '/FilmCraft/talk.fcproj' }));
    return true;
  });
  assert.equal(ctx.calls.write.length, 0);
});

const { skills, errors: skillErrors } = parseSkills(SKILLS_MD, 'filmcraft');

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

test('set-in-and-out-marks routes marks through markers.markIn/markOut, never the cut tools (sweep b19 06)', () => {
  const skill = skills.find(s => s.slug === 'set-in-and-out-marks');
  assert.ok(skill, 'the marks skill exists');
  const runLines = skill.steps.filter(step => step.tool === 'filmcraft.run_command').map(step => step.line);
  assert.deepEqual(runLines, [
    '3. call_tool tool=filmcraft.run_command command=markers.markIn',
    '5. call_tool tool=filmcraft.run_command command=markers.markOut',
  ], 'the marks are the markers commands, at the playhead set in the step before');
  assert.match(skill.gotchas, /razor and filmcraft\.add_edit cut the timeline/, 'the gotcha separates marks from cuts');
  assert.match(skill.summary, /without cutting/i);
});

test('add_edit is a cut, not a mark: the model-facing wording keeps "marker" out (sweep b19 06)', () => {
  const edit = byName('filmcraft.add_edit');
  assert.match(edit.purpose, /a cut, not a mark/);
  assert.ok(!/marker/i.test(edit.purpose + edit.when + edit.examples[0].says), 'no "marker" wording lures the mark task here');
});

test('open_file carries the import vocabulary so a generic import search ranks it (sweep b19 02)', () => {
  const open = byName('filmcraft.open_file');
  for (const word of ['import', 'still', 'photo', 'video', 'audio']) assert.ok(open.keywords.includes(word), `keyword ${word}`);
});

test('a no-position playhead rejection carries the seconds fix line', async () => {
  const craft = fakeCraft();
  await assert.rejects(runTool('filmcraft.playhead', {}, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'invalid_argument');
    assert.match(error.message, /give one of seconds, frame or timecode/);
    assert.equal(error.fix, 'call_tool tool=filmcraft.playhead seconds=<n>');
    return true;
  });
});
