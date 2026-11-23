// Unit tests for the TextureCraft pack: agent/apps/texturecraft/tools.js and skills.md.
// TextureCraft is a standalone wrapper app with no page API, so the file tools drive the
// wrapper window (fake) rather than a ctx.craft API. The schema and skills checks reuse the
// real runtime validators, with the choices function that scripts/agent/build.mjs builds the
// catalog with.
// Run: node --test tests/agent-pack-texturecraft.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack, tools } from '../agent/apps/texturecraft/tools.js';
import { tools as desktopTools } from '../agent/desktop/tools.js';
import { ToolError, specErrors, checkArgs, callLine } from '../src/apps/ai-agent/runtime/args.mjs';
import { parseSkills, checkSkills } from '../src/apps/ai-agent/runtime/skills.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_MD = readFileSync(join(HERE, '..', 'agent', 'apps', 'texturecraft', 'skills.md'), 'utf8');
const APP_IDS = ['texturecraft'];
const choices = name => (name === 'apps' ? APP_IDS : []);
const byName = name => tools.find(tool => tool.name === name) ?? desktopTools.find(tool => tool.name === name);

// A fake wrapper window: the #file input records the change dispatch (openFromBytes drives
// it, app.mjs:38); message listeners are stored so a test can fire the texturecraft:save
// event the wrapper would hear from the editor frame (the bootstrap capture,
// bootstrap.js:92-98). #status/#error carry the state text the status tool reads (app.mjs:7-8).
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
  const status = { textContent: 'Save in the editor to download and keep a browser copy' };
  const error = { textContent: '', hidden: true };
  return {
    opened,
    DataTransfer, File, Event,
    document: {
      getElementById: id => (id === 'file' ? fileInput : id === 'editor' ? editor : id === 'status' ? status : id === 'error' ? error : null),
    },
    location: { origin: 'https://pc.example' },
    addEventListener: (type, fn) => { if (type === 'message') listeners.add(fn); },
    removeEventListener: (type, fn) => { if (type === 'message') listeners.delete(fn); },
    frame: editor.contentWindow,
    fire: event => { for (const fn of [...listeners]) fn(event); },
    armed: () => listeners.size,
    status, error,
  };
};
// saveCopy arms its listener on a microtask after appWindow resolves (the user's editor save
// happens later in reality); wait for it before firing the save so the tests are deterministic.
const waitForArm = async wrapper => {
  for (let i = 0; i < 1000; i++) {
    if (wrapper.armed()) return;
    await new Promise(done => setTimeout(done, 1));
  }
  throw new Error('the save listener never armed');
};
const fileCtx = (bytes, wrapper) => {
  const calls = { read: [], write: [] };
  return {
    calls,
    host: { appWindow: async () => wrapper },
    files: {
      readBytes: path => { calls.read.push(path); return Promise.resolve({ path, name: 'car.tcraft', bytes, size: bytes.byteLength }); },
      writeBytes: (path, b, { overwrite } = {}) => { calls.write.push({ path, size: b.byteLength, overwrite }); return Promise.resolve({ path, size: b.byteLength, created: !overwrite }); },
    },
  };
};

test('the pack declares its id and title', () => {
  assert.deepEqual(pack, { id: 'texturecraft', title: 'TextureCraft' });
});

test('the pack exposes exactly the 3 texturecraft tools', () => {
  assert.equal(tools.length, 3);
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['texturecraft.open_file', 'texturecraft.save_copy', 'texturecraft.status']);
});

test('every tool has the required text fields, effect, needs and examples', () => {
  for (const tool of tools) {
    assert.match(tool.name, /^texturecraft\.[a-z0-9_]+$/);
    assert.ok(tool.purpose.length > 0 && tool.purpose.length <= 80, `${tool.name} purpose is ${tool.purpose.length} chars`);
    assert.ok(tool.when.startsWith('Use when'), `${tool.name} when must start with "Use when"`);
    assert.ok(tool.when.length <= 120, `${tool.name} when is ${tool.when.length} chars`);
    assert.ok(['read', 'change', 'destructive', 'external'].includes(tool.effect), `${tool.name} bad effect`);
    const fileTools = ['texturecraft.open_file', 'texturecraft.save_copy'];
    assert.deepEqual(tool.needs, fileTools.includes(tool.name) ? ['host', 'app:texturecraft', 'files'] : ['host', 'app:texturecraft']);
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

test('the effects are read for status, change for open and save', () => {
  assert.equal(byName('texturecraft.status').effect, 'read');
  assert.equal(byName('texturecraft.open_file').effect, 'change');
  assert.equal(byName('texturecraft.save_copy').effect, 'change');
  assert.equal(byName('texturecraft.save_copy').effectFor({ overwrite: true }), 'destructive');
  assert.equal(byName('texturecraft.save_copy').effectFor({}), 'change');
});

test('texturecraft.status reads the wrapper status line and the error when it is shown', async () => {
  const wrapper = fakeWrapper();
  const out = await byName('texturecraft.status').run({}, { host: { appWindow: async () => wrapper } });
  assert.deepEqual(out, { status: wrapper.status.textContent });
  wrapper.status.textContent = 'Opened: car.tcraft';
  wrapper.error.textContent = 'the file is not a project';
  wrapper.error.hidden = false;
  assert.deepEqual(await byName('texturecraft.status').run({}, { host: { appWindow: async () => wrapper } }), {
    status: 'Opened: car.tcraft', error: 'the file is not a project',
  });
});

test('texturecraft.open_file reads the file and drives the wrapper file input, with no opened field', async () => {
  const wrapper = fakeWrapper();
  const ctx = fileCtx(new Uint8Array([1, 2, 3]), wrapper);
  const out = await byName('texturecraft.open_file').run({ path: '/TextureCraft/car.tcraft' }, ctx);
  assert.deepEqual(ctx.calls.read, ['/TextureCraft/car.tcraft']);
  assert.equal(wrapper.opened.length, 1);
  assert.equal(wrapper.opened[0].name, 'car.tcraft');
  assert.deepEqual(out, { name: 'car.tcraft', bytes: 3 }); // no opened field: there is no page API to poll
});

test('texturecraft.open_file turns a store not_found into a teaching ToolError', async () => {
  const wrapper = fakeWrapper();
  const ctx = fileCtx(new Uint8Array([1]), wrapper);
  ctx.files.readBytes = () => Promise.reject(Object.assign(new Error('/missing.tcraft is not a file.'), { code: 'not_found' }));
  await assert.rejects(byName('texturecraft.open_file').run({ path: '/missing.tcraft' }, ctx), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_found');
    assert.equal(error.message, '/missing.tcraft is not in Files. To open TextureCraft itself, use desktop.open_app; to open a file, find it first with files.find.');
    assert.equal(error.fix, 'call_tool tool=desktop.open_app app=texturecraft');
    return true;
  });
  assert.equal(wrapper.opened.length, 0);
});

test('texturecraft.save_copy captures the texturecraft:save from the editor save and writes it', async () => {
  const wrapper = fakeWrapper();
  const ctx = fileCtx(new Uint8Array([1, 2, 3]), wrapper);
  // craft is null (no page API): saveBytesCopy arms the capture and the user's editor save
  // becomes the wrapper's texturecraft:save message (the bootstrap capture, bootstrap.js:92-98).
  const promise = byName('texturecraft.save_copy').run({ path: '/TextureCraft/car.tcraft' }, ctx);
  await waitForArm(wrapper);
  wrapper.fire({ origin: 'https://pc.example', source: wrapper.frame, data: { type: 'texturecraft:save', name: 'car.tcraft', bytes: new Uint8Array([4, 5, 6]) } });
  const out = await promise;
  assert.deepEqual(ctx.calls.write, [{ path: '/TextureCraft/car.tcraft', size: 3, overwrite: false }]);
  assert.deepEqual(out, { path: '/TextureCraft/car.tcraft', name: 'car.tcraft', size: 3, created: true, note: 'the app also downloaded the file in the browser' });
});

test('texturecraft.save_copy passes overwrite through and suggests overwrite on exists', async () => {
  const wrapper = fakeWrapper();
  const ctx = fileCtx(new Uint8Array([1]), wrapper);
  const promise = byName('texturecraft.save_copy').run({ path: '/TextureCraft/car.tcraft', overwrite: true }, ctx);
  await waitForArm(wrapper);
  wrapper.fire({ origin: 'https://pc.example', source: wrapper.frame, data: { type: 'texturecraft:save', name: 'car.tcraft', bytes: new Uint8Array([4]) } });
  await promise;
  assert.deepEqual(ctx.calls.write, [{ path: '/TextureCraft/car.tcraft', size: 1, overwrite: true }]);
  ctx.files.writeBytes = () => Promise.reject(Object.assign(new Error('/TextureCraft/car.tcraft already exists.'), { code: 'exists' }));
  const again = byName('texturecraft.save_copy').run({ path: '/TextureCraft/car.tcraft' }, ctx);
  await waitForArm(wrapper);
  wrapper.fire({ origin: 'https://pc.example', source: wrapper.frame, data: { type: 'texturecraft:save', name: 'car.tcraft', bytes: new Uint8Array([4]) } });
  await assert.rejects(again, error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'exists');
    assert.equal(error.fix, callLine('texturecraft.save_copy', { path: '/TextureCraft/car.tcraft', overwrite: true }));
    return true;
  });
});

test('texturecraft.save_copy refuses a foreign target extension using the captured name', async () => {
  const wrapper = fakeWrapper();
  const ctx = fileCtx(new Uint8Array([1]), wrapper);
  const promise = byName('texturecraft.save_copy').run({ path: '/TextureCraft/car.obj' }, ctx);
  await waitForArm(wrapper);
  wrapper.fire({ origin: 'https://pc.example', source: wrapper.frame, data: { type: 'texturecraft:save', name: 'car.tcraft', bytes: new Uint8Array([4]) } });
  await assert.rejects(promise, error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'invalid_argument');
    assert.match(error.message, /TextureCraft saves \.tcraft files; it cannot write \.obj here\./);
    assert.equal(error.fix, callLine('texturecraft.save_copy', { path: '/TextureCraft/car.tcraft' }));
    return true;
  });
  assert.equal(ctx.calls.write.length, 0); // nothing is written under a foreign extension
});

const { skills, errors: skillErrors } = parseSkills(SKILLS_MD, 'texturecraft');

test('skills.md parses with the runtime parser without errors and has 3 skills', () => {
  assert.deepEqual(skillErrors, []);
  assert.equal(skills.length, 3);
  for (const skill of skills) {
    assert.ok(skill.slug && skill.summary, `skill ${skill.slug} slug/summary`);
    assert.ok(skill.summary.length <= 160, `skill ${skill.slug} summary is ${skill.summary.length} chars`);
    assert.ok(skill.keywords.length >= 5, `skill ${skill.slug} keywords: ${skill.keywords.join(', ')}`);
    assert.ok(skill.tools.length >= 1, `skill ${skill.slug} tools`);
    assert.ok(skill.when && skill.steps.length >= 1 && skill.check, `skill ${skill.slug} body sections`);
  }
});

test('every skill opens by launching TextureCraft, then uses numbered texturecraft steps', () => {
  for (const skill of skills) {
    assert.equal(skill.steps[0].line, '1. call_tool tool=desktop.open_app app=texturecraft', `skill ${skill.slug}`);
    skill.steps.forEach((step, i) => {
      assert.equal(step.n, i + 1, `skill ${skill.slug} step numbering`);
      assert.ok(step.tool.startsWith('desktop.') || step.tool.startsWith('texturecraft.'), `skill ${skill.slug} step ${step.n}: ${step.line}`);
    });
  }
});

test('skill steps and tools lines validate against the runtime checkArgs', () => {
  const errors = checkSkills(skills, byName, { checkArgs: (tool, args) => checkArgs(tool, args, { choices }) });
  assert.deepEqual(errors, []);
});
