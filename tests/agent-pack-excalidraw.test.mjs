// Unit tests for the Excalidraw pack: agent/apps/excalidraw/tools.js and skills.md.
// A fake ctx.host.appWindow returns a fake window whose webpcExcalidraw.api records calls; every
// tool must send the exact ExcalidrawImperativeAPI shape (element base fields, captureUpdate) that
// @excalidraw/excalidraw 0.18.1 accepts. The schema and skills checks reuse the real runtime
// validators, with the choices function the build uses.
// Run: node --test tests/agent-pack-excalidraw.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack, tools } from '../agent/apps/excalidraw/tools.js';
import { tools as desktopTools } from '../agent/desktop/tools.js';
import { ToolError, specErrors, checkArgs } from '../src/apps/ai-agent/runtime/args.mjs';
import { parseSkills, checkSkills } from '../src/apps/ai-agent/runtime/skills.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_MD = readFileSync(join(HERE, '..', 'agent', 'apps', 'excalidraw', 'skills.md'), 'utf8');
// The enabled app ids scripts/agent/build.mjs resolves the live 'apps' enum with (catalog.yaml).
const APP_IDS = ['gridcraft', 'docs', 'deckcraft', 'terminal', 'sqliteviz', 'files', 'media', 'cyberchef', 'vscode', 'nettools', 'packets', 'ai-agent', 'lightcraft', 'figcraft', 'pdfcraft', 'soundcraft', 'beepbox', 'filmcraft', 'cadcraft', 'vectorcraft', 'photocraft', 'effectcraft', 'materialcraft', 'texturecraft', 'excalidraw', 'vert', 'about'];
const choices = name => (name === 'apps' || name === 'windows' ? APP_IDS : []);
const byName = name => tools.find(tool => tool.name === name) ?? desktopTools.find(tool => tool.name === name);

// A fake appWindow returning the wrapper window; the real API sits in the #excalidraw-frame
// iframe's contentWindow (webpcExcalidraw.api). The fake api records the imperative-API calls.
const fakeExcalidraw = (existing = []) => {
  const calls = [];
  let scene = [...existing];
  const api = {
    getSceneElements: () => { calls.push(['getSceneElements']); return scene; },
    updateScene: data => { calls.push(['updateScene', data]); if (data.elements) scene = [...data.elements]; },
    resetScene: () => { calls.push(['resetScene']); scene = []; },
    scrollToContent: (t, o) => { calls.push(['scrollToContent', t, o]); },
  };
  const innerWin = { webpcExcalidraw: { flush: () => {}, api } };
  const wrapper = { document: { getElementById: id => (id === 'excalidraw-frame' ? { contentWindow: innerWin } : null) } };
  const runTool = (name, args, ctx = { host: { appWindow: async () => wrapper } }) => byName(name).run(args, ctx);
  return { calls, runTool, api, wrapper, innerWin, scene: () => scene };
};

test('the pack declares its id and title', () => {
  assert.deepEqual(pack, { id: 'excalidraw', title: 'Excalidraw' });
});

test('the pack exposes exactly the 5 excalidraw tools', () => {
  assert.equal(tools.length, 5);
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'excalidraw.add_shapes', 'excalidraw.add_text', 'excalidraw.clear', 'excalidraw.fit_view', 'excalidraw.list_elements',
  ]);
});

test('every tool has the required text fields, effect, needs and examples', () => {
  for (const tool of tools) {
    assert.match(tool.name, /^excalidraw\.[a-z0-9_]+$/);
    assert.ok(tool.purpose.length > 0 && tool.purpose.length <= 80, `${tool.name} purpose is ${tool.purpose.length} chars`);
    assert.ok(tool.when.startsWith('Use when'), `${tool.name} when must start with "Use when"`);
    assert.ok(tool.when.length <= 120, `${tool.name} when is ${tool.when.length} chars`);
    assert.ok(['read', 'change', 'destructive', 'external'].includes(tool.effect), `${tool.name} bad effect`);
    assert.deepEqual(tool.needs, ['host', 'app:excalidraw']);
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

test('the effects are read for reads, change for edits, and clear is destructive', () => {
  assert.equal(byName('excalidraw.list_elements').effect, 'read', 'list_elements');
  for (const name of ['excalidraw.add_shapes', 'excalidraw.add_text', 'excalidraw.fit_view']) assert.equal(byName(name).effect, 'change', name);
  assert.equal(byName('excalidraw.clear').effect, 'destructive', 'clear');
});

test('excalidraw.add_shapes appends built elements to the scene, undoable', async () => {
  const ex = fakeExcalidraw();
  const out = await ex.runTool('excalidraw.add_shapes', { spec: 'rectangle 100 100 200 80 Start\nellipse 10 20 140 60' });
  assert.deepEqual(out, { added: 3 }); // rectangle + bound label + ellipse
  const [scene, data] = ex.calls.find(c => c[0] === 'updateScene');
  assert.equal(scene, 'updateScene');
  assert.equal(data.captureUpdate, 'IMMEDIATELY');
  assert.equal(data.elements.length, 3);
  const rect = data.elements[0];
  assert.equal(rect.type, 'rectangle');
  assert.deepEqual([rect.x, rect.y, rect.width, rect.height], [100, 100, 200, 80]);
  assert.ok(rect.id && rect.seed !== undefined && rect.version === 1 && rect.isDeleted === false, 'base fields present');
  assert.equal(rect.roundness?.type, 2, 'rectangle roundness PROPORTIONAL_RADIUS');
  const label = data.elements[1];
  assert.equal(label.type, 'text');
  assert.equal(label.text, 'Start');
  assert.equal(label.containerId, rect.id, 'label bound to the shape');
});

test('excalidraw.add_shapes builds an arrow between the numbered shape lines', async () => {
  const ex = fakeExcalidraw();
  await ex.runTool('excalidraw.add_shapes', { spec: 'rectangle 0 0 100 50 A\nrectangle 300 0 100 50 B\narrow 1 2' });
  const data = ex.calls.find(c => c[0] === 'updateScene')[1];
  const arrow = data.elements.at(-1);
  assert.equal(arrow.type, 'arrow');
  assert.equal(arrow.endArrowhead, 'arrow');
  assert.deepEqual([arrow.x, arrow.y], [50, 25]); // centre of shape 1
  assert.deepEqual([arrow.points[1][0], arrow.points[1][1]], [300, 0]); // to centre of shape 2
});

test('excalidraw.add_shapes rejects an unknown shape and a bad arrow target', async () => {
  const ex = fakeExcalidraw();
  await assert.rejects(ex.runTool('excalidraw.add_shapes', { spec: 'circle 0 0 10 10' }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'invalid_argument');
    assert.match(error.message, /unknown shape "circle"/);
    return true;
  });
  await assert.rejects(ex.runTool('excalidraw.add_shapes', { spec: 'arrow 1 2' }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'invalid_argument');
    assert.match(error.message, /must be listed before the arrow/);
    return true;
  });
});

test('excalidraw.add_text appends a single free text element', async () => {
  const ex = fakeExcalidraw();
  const out = await ex.runTool('excalidraw.add_text', { text: 'Title', x: 20, y: 30 });
  assert.deepEqual(out, { added: 1 });
  const data = ex.calls.find(c => c[0] === 'updateScene')[1];
  assert.equal(data.elements.length, 1);
  const el = data.elements[0];
  assert.equal(el.type, 'text');
  assert.deepEqual([el.x, el.y], [20, 30]);
  assert.equal(el.text, 'Title');
  assert.equal(el.autoResize, true);
});

test('excalidraw.list_elements trims elements to the fields the model can act on', async () => {
  const ex = fakeExcalidraw([
    { id: 'r1', type: 'rectangle', x: 10.4, y: 20.9, width: 100, height: 50 },
    { id: 't1', type: 'text', x: 0, y: 0, width: 80, height: 25, text: 'Hi' },
  ]);
  const out = await ex.runTool('excalidraw.list_elements', {});
  assert.deepEqual(out, {
    count: 2,
    elements: [
      { id: 'r1', type: 'rectangle', x: 10, y: 21, width: 100, height: 50 },
      { id: 't1', type: 'text', x: 0, y: 0, width: 80, height: 25, text: 'Hi' },
    ],
  });
});

test('excalidraw.fit_view fits the content and animates', async () => {
  const ex = fakeExcalidraw();
  assert.deepEqual(await ex.runTool('excalidraw.fit_view', {}), { fitted: true });
  assert.deepEqual(ex.calls, [['scrollToContent', undefined, { fitToContent: true, animate: true }]]);
});

test('excalidraw.clear resets the scene', async () => {
  const ex = fakeExcalidraw([{ id: 'r1', type: 'rectangle' }]);
  assert.deepEqual(await ex.runTool('excalidraw.clear', {}), { cleared: true });
  assert.deepEqual(ex.calls, [['resetScene']]);
  assert.equal(ex.scene().length, 0);
});

test('a tool rejects with not_available when ctx.host is absent', async () => {
  await assert.rejects(byName('excalidraw.list_elements').run({}, { host: null }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    return true;
  });
});

test('a tool rejects with not_available when the API is not ready yet', async () => {
  const emptyWrapper = { document: { getElementById: () => ({ contentWindow: {} }) } };
  const fast = { sleep: async () => {}, timeoutMs: 200 };
  await assert.rejects(byName('excalidraw.list_elements').run({}, { host: { appWindow: async () => emptyWrapper }, ...fast }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    assert.match(error.message, /did not finish loading/);
    return true;
  });
});

test('a tool rejects with not_available when the wrapper has no excalidraw frame', async () => {
  const noFrame = { document: { getElementById: () => null } };
  await assert.rejects(byName('excalidraw.list_elements').run({}, { host: { appWindow: async () => noFrame } }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    assert.match(error.message, /no excalidraw-frame frame/);
    return true;
  });
});

test('a host rejection code is passed through as the ToolError type', async () => {
  const boom = () => { const error = new Error('window "excalidraw" is not open'); error.code = 'not_open'; throw error; };
  await assert.rejects(byName('excalidraw.add_text').run({ text: 'x', x: 0, y: 0 }, { host: { appWindow: boom } }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_open');
    return true;
  });
});

const { skills, errors: skillErrors } = parseSkills(SKILLS_MD, 'excalidraw');

test('skills.md parses with the runtime parser without errors and has 6 skills', () => {
  assert.deepEqual(skillErrors, []);
  assert.equal(skills.length, 6);
  for (const skill of skills) {
    assert.ok(skill.slug && skill.summary, `skill ${skill.slug} slug/summary`);
    assert.ok(skill.summary.length <= 160, `skill ${skill.slug} summary is ${skill.summary.length} chars`);
    assert.ok(skill.keywords.length >= 5, `skill ${skill.slug} keywords: ${skill.keywords.join(', ')}`);
    assert.ok(skill.tools.length >= 1, `skill ${skill.slug} tools`);
    assert.ok(skill.when && skill.steps.length >= 1 && skill.check, `skill ${skill.slug} body sections`);
  }
});

test('every skill opens by launching Excalidraw, then uses numbered excalidraw steps', () => {
  for (const skill of skills) {
    assert.equal(skill.steps[0].line, '1. call_tool tool=desktop.open_app app=excalidraw', `skill ${skill.slug}`);
    skill.steps.forEach((step, i) => {
      assert.equal(step.n, i + 1, `skill ${skill.slug} step numbering`);
      assert.ok(step.tool.startsWith('desktop.') || step.tool.startsWith('excalidraw.'), `skill ${skill.slug} step ${step.n}: ${step.line}`);
    });
  }
});

test('the multi-line add_shapes skill step decodes to a real newline spec', () => {
  const draw = skills.find(s => s.slug === 'draw-a-diagram');
  const step = draw.steps[1];
  assert.deepEqual(step.args.spec, 'rectangle 100 100 200 80 Start\nrectangle 400 100 200 80 End\narrow 1 2');
  assert.ok(checkArgs(byName('excalidraw.add_shapes'), step.args, { choices }).ok, 'spec passes checkArgs');
});

test('skill steps and tools lines validate against the runtime checkArgs', () => {
  const errors = checkSkills(skills, byName, { checkArgs: (tool, args) => checkArgs(tool, args, { choices }) });
  assert.deepEqual(errors, []);
});
