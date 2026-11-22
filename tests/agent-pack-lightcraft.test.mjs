// Unit tests for the LightCraft pack: agent/apps/lightcraft/tools.js and skills.md.
// A fake app window nests the page API (window.lightcraft = { command }) on an editor frame's
// contentWindow, like the vendored index.html installs it; every tool must send the exact
// command id and JSON params that storytold/lightcraft@v0.21.1 apps/lightcraft-web/src/web.rs
// command() and the engine cmd! specs run. The schema and skills checks reuse the real runtime
// validators, with the choices function that scripts/agent/build.mjs builds the catalog with.
// Run: node --test tests/agent-pack-lightcraft.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack, tools, usesCommands, usesMethods } from '../agent/apps/lightcraft/tools.js';
import { tools as desktopTools } from '../agent/desktop/tools.js';
import { ToolError, specErrors, checkArgs } from '../src/apps/ai-agent/runtime/args.mjs';
import { parseSkills, checkSkills } from '../src/apps/ai-agent/runtime/skills.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_MD = readFileSync(join(HERE, '..', 'agent', 'apps', 'lightcraft', 'skills.md'), 'utf8');
const APP_IDS = ['lightcraft'];
const choices = name => (name === 'apps' ? APP_IDS : []);
const byName = name => tools.find(tool => tool.name === name) ?? desktopTools.find(tool => tool.name === name);

// The fake page: lightcraft.command(id, paramsText) records the id and the parsed params,
// answers with the result as JSON text (web.rs command()), and rejects like the app does.
const makePage = () => {
  const calls = [];
  return {
    calls,
    command: (id, text) => {
      const params = JSON.parse(text);
      calls.push([id, params]);
      if (id === 'edit.undo') return Promise.reject(new Error('nothing to undo'));
      return Promise.resolve(JSON.stringify({ id, params, done: true }));
    },
  };
};
// A fake app window: pcHost.appWindow(lightcraft) -> wrapper with the editor frame's page.
const fakeHost = page => ({
  appWindow: async app => {
    assert.equal(app, 'lightcraft');
    return { document: { getElementById: el => (el === 'editor' ? { contentWindow: { lightcraft: page } } : null) } };
  },
});
const runTool = (name, args, page) => byName(name).run(args, { host: fakeHost(page) });

test('the pack declares its id, title and live-check exports', () => {
  assert.deepEqual(pack, { id: 'lightcraft', title: 'LightCraft' });
  assert.deepEqual(usesCommands.sort(), [
    'develop.reset', 'edit.redo', 'edit.undo', 'library.filter', 'library.info', 'library.select',
    'library.sort', 'photo.delete', 'photo.rate', 'photo.restore', 'photo.rotateLeft', 'photo.rotateRight',
  ].sort());
  assert.deepEqual(usesMethods, []);
});

test('the pack exposes exactly the 13 lightcraft tools', () => {
  assert.equal(tools.length, 13);
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'lightcraft.delete', 'lightcraft.develop_reset', 'lightcraft.filter', 'lightcraft.import_file',
    'lightcraft.library_info', 'lightcraft.rate', 'lightcraft.redo', 'lightcraft.restore', 'lightcraft.rotate',
    'lightcraft.run_command', 'lightcraft.select', 'lightcraft.sort', 'lightcraft.undo',
  ]);
});

test('every tool has the required text fields, effect, needs and examples', () => {
  for (const tool of tools) {
    assert.match(tool.name, /^lightcraft\.[a-z0-9_]+$/);
    assert.ok(tool.purpose.length > 0 && tool.purpose.length <= 80, `${tool.name} purpose is ${tool.purpose.length} chars`);
    assert.ok(tool.when.startsWith('Use when'), `${tool.name} when must start with "Use when"`);
    // run_command lists the destructive ids in when (the model must see them).
    if (tool.name !== 'lightcraft.run_command') assert.ok(tool.when.length <= 120, `${tool.name} when is ${tool.when.length} chars`);
    assert.ok(['read', 'change', 'destructive', 'external'].includes(tool.effect), `${tool.name} bad effect`);
    const fileTools = ['lightcraft.import_file'];
    assert.deepEqual(tool.needs, fileTools.includes(tool.name) ? ['host', 'app:lightcraft', 'files'] : ['host', 'app:lightcraft']);
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

test('the effects are read for the info read, destructive for delete and reset, change for the rest', () => {
  assert.equal(byName('lightcraft.library_info').effect, 'read');
  for (const name of ['lightcraft.delete', 'lightcraft.develop_reset']) assert.equal(byName(name).effect, 'destructive', name);
  for (const tool of tools) if (!['read', 'destructive'].includes(tool.effect)) assert.equal(tool.effect, 'change', tool.name);
});

test('library_info, select, sort, rate, rotate, delete, restore, develop_reset, undo and redo send their commands', async () => {
  const page = makePage();
  await runTool('lightcraft.library_info', {}, page);
  await runTool('lightcraft.select', { ids: [3, 7] }, page);
  await runTool('lightcraft.select', {}, page);
  await runTool('lightcraft.sort', { key: 'rating', ascending: false }, page);
  await runTool('lightcraft.rate', { rating: 4, ids: [3], advance: true }, page);
  await runTool('lightcraft.rotate', { direction: 'left' }, page);
  await runTool('lightcraft.rotate', { direction: 'right', ids: [5] }, page);
  await runTool('lightcraft.delete', { ids: [3] }, page);
  await runTool('lightcraft.restore', { ids: [3] }, page);
  await runTool('lightcraft.develop_reset', {}, page);
  await runTool('lightcraft.redo', {}, page);
  assert.deepEqual(page.calls, [
    ['library.info', {}],
    ['library.select', { ids: [3, 7] }],
    ['library.select', {}],
    ['library.sort', { key: 'rating', ascending: false }],
    ['photo.rate', { rating: 4, ids: [3], advance: true }],
    ['photo.rotateLeft', {}],
    ['photo.rotateRight', { ids: [5] }],
    ['photo.delete', { ids: [3] }],
    ['photo.restore', { ids: [3] }],
    ['develop.reset', {}],
    ['edit.redo', {}],
  ]);
});

// A fake wrapper window for the file tool: the #file input records the change dispatch
// (openFromBytes drives it, app.mjs:38). The host bridge (not the page API) opens the file,
// so no page command is involved.
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
  return {
    opened,
    DataTransfer, File, Event,
    document: { getElementById: id => (id === 'file' ? fileInput : null) },
    location: { origin: 'https://pc.example' },
  };
};
const fileHost = (bytes, wrapper) => {
  const calls = { read: [] };
  return {
    calls,
    host: { appWindow: async app => { assert.equal(app, 'lightcraft'); return wrapper; } },
    files: {
      readBytes: path => { calls.read.push(path); return Promise.resolve({ path, name: 'IMG_0001.cr2', bytes, size: bytes.byteLength }); },
    },
  };
};

test('lightcraft.import_file reads the photo and drives the wrapper file input', async () => {
  const wrapper = fakeWrapper();
  const ctx = fileHost(new Uint8Array([1, 2, 3]), wrapper);
  const out = await byName('lightcraft.import_file').run({ path: '/Photos/trip/IMG_0001.cr2' }, ctx);
  assert.deepEqual(ctx.calls.read, ['/Photos/trip/IMG_0001.cr2']);
  assert.equal(wrapper.opened.length, 1); // the change dispatch the wrapper handler (app.mjs:38) hears
  assert.equal(wrapper.opened[0].name, 'IMG_0001.cr2');
  assert.deepEqual([...wrapper.opened[0].parts[0]], [1, 2, 3]);
  assert.deepEqual(out, { name: 'IMG_0001.cr2', bytes: 3 }); // no opened field: the page has no inspect
});

test('lightcraft.import_file turns a store not_found into a teaching ToolError', async () => {
  const wrapper = fakeWrapper();
  const ctx = fileHost(new Uint8Array([1]), wrapper);
  ctx.files.readBytes = () => Promise.reject(Object.assign(new Error('/missing.cr2 is not a file.'), { code: 'not_found' }));
  await assert.rejects(byName('lightcraft.import_file').run({ path: '/missing.cr2' }, ctx), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_found');
    assert.match(error.message, /not a file/);
    return true;
  });
  assert.equal(wrapper.opened.length, 0);
});

test('the page answer is the JSON text, parsed back into a value', async () => {
  const page = makePage();
  const out = await runTool('lightcraft.library_info', {}, page);
  assert.deepEqual(out, { id: 'library.info', params: {}, done: true });
});

test('filter sends the parsed JSON object, and refuses non-JSON', async () => {
  const page = makePage();
  await runTool('lightcraft.filter', { filter: '{"rating":4,"flag":"pick"}' }, page);
  assert.deepEqual(page.calls, [['library.filter', { rating: 4, flag: 'pick' }]]);
  await assert.rejects(runTool('lightcraft.filter', { filter: 'rating 4' }, page), error => {
    assert.ok(error instanceof ToolError);
    assert.match(error.message, /filter must be a JSON object/);
    return true;
  });
});

test('undo surfaces the app error when there is nothing to undo', async () => {
  const page = makePage();
  await assert.rejects(runTool('lightcraft.undo', {}, page), error => {
    assert.equal(error.message, 'nothing to undo');
    return true;
  });
});

test('the page api is refused when the window has no editor frame', async () => {
  const bare = { appWindow: async () => ({ document: { getElementById: () => null } }) };
  await assert.rejects(byName('lightcraft.library_info').run({}, { host: bare }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    assert.match(error.message, /no editor frame/);
    return true;
  });
});

test('run_command sends key=value lines, a JSON object, or {} for none', async () => {
  const page = makePage();
  await runTool('lightcraft.run_command', { command: 'preset.apply', params: 'id=9\namount=50' }, page);
  await runTool('lightcraft.run_command', { command: 'album.setCover', params: '{"id": 2, "photo": 9}' }, page);
  await runTool('lightcraft.run_command', { command: 'mask.invert' }, page);
  assert.deepEqual(page.calls, [
    ['preset.apply', { id: 9, amount: 50 }],
    ['album.setCover', { id: 2, photo: 9 }],
    ['mask.invert', {}],
  ]);
  await assert.rejects(runTool('lightcraft.run_command', { command: 'mask.invert', params: 'nonsense' }, page), error => {
    assert.match(error.message, /bad params line "nonsense"/);
    return true;
  });
});

test('effectFor marks destructive command ids for run_command', () => {
  const run = byName('lightcraft.run_command');
  assert.equal(run.effectFor({ command: 'photo.delete' }), 'destructive');
  assert.equal(run.effectFor({ command: 'mask.deleteAll' }), 'destructive');
  assert.equal(run.effectFor({ command: 'library.select' }), 'change');
});

const { skills, errors: skillErrors } = parseSkills(SKILLS_MD, 'lightcraft');

test('skills.md parses with the runtime parser without errors and has 8 skills', () => {
  assert.deepEqual(skillErrors, []);
  assert.equal(skills.length, 9);
  for (const skill of skills) {
    assert.ok(skill.slug && skill.summary, `skill ${skill.slug} slug/summary`);
    assert.ok(skill.summary.length <= 160, `skill ${skill.slug} summary is ${skill.summary.length} chars`);
    assert.ok(skill.keywords.length >= 5, `skill ${skill.slug} keywords: ${skill.keywords.join(', ')}`);
    assert.ok(skill.tools.length >= 1, `skill ${skill.slug} tools`);
    assert.ok(skill.when && skill.steps.length >= 1 && skill.check, `skill ${skill.slug} body sections`);
  }
});

test('every skill opens by launching LightCraft, then uses numbered lightcraft steps', () => {
  for (const skill of skills) {
    assert.equal(skill.steps[0].line, '1. call_tool tool=desktop.open_app app=lightcraft', `skill ${skill.slug}`);
    skill.steps.forEach((step, i) => {
      assert.equal(step.n, i + 1, `skill ${skill.slug} step numbering`);
      assert.ok(step.tool.startsWith('desktop.') || step.tool.startsWith('lightcraft.'), `skill ${skill.slug} step ${step.n}: ${step.line}`);
    });
  }
});

test('skill steps and tools lines validate against the runtime checkArgs', () => {
  const errors = checkSkills(skills, byName, { checkArgs: (tool, args) => checkArgs(tool, args, { choices }) });
  assert.deepEqual(errors, []);
});
