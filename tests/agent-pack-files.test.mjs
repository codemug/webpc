// Unit tests for the files pack: agent/files/tools.js and agent/files/skills.md.
// The schema and skills checks reuse the real runtime validators, and checkArgs gets the
// same choices function scripts/agent/build.mjs uses for live enum lists.
// Run: node --test tests/agent-pack-files.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack, tools } from '../agent/files/tools.js';
import { ToolError, specErrors, checkArgs, callLine } from '../src/apps/ai-agent/runtime/args.mjs';
import { parseSkills, checkSkills } from '../src/apps/ai-agent/runtime/skills.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_MD = readFileSync(join(HERE, '..', 'agent', 'files', 'skills.md'), 'utf8');
// The same choices function scripts/agent/build.mjs builds the catalog with.
const APP_IDS = ['gridcraft', 'docs', 'terminal', 'files'];
const choices = name => (name === 'apps' || name === 'windows' ? APP_IDS : []);
const byName = name => tools.find(tool => tool.name === name);
const runTool = (name, args, ctx) => byName(name).run(args, ctx);

// A fake ctx.files that records calls and returns what the real interface resolves.
const fakeFiles = () => {
  const calls = [];
  const rec = (method, make) => (...args) => {
    calls.push([method, ...args]);
    return Promise.resolve(make(...args));
  };
  return {
    calls,
    list: rec('list', path => [{ name: 'notes', path: '/notes', kind: 'folder' }, { name: 'todo.txt', path: '/todo.txt', kind: 'file', size: 9, modified: 1 }]),
    stat: rec('stat', path => ({ name: 'todo.txt', path, kind: 'file', size: 9, modified: 1 })),
    readText: rec('readText', path => ({ path, text: 'Buy milk', truncated: false })),
    writeText: rec('writeText', (path, text, opts) => ({ path, size: text.length, created: true })),
    appendText: rec('appendText', (path, text) => ({ path, size: text.length })),
    mkdir: rec('mkdir', path => ({ path })),
    rename: rec('rename', (path, to) => ({ path: to })),
    remove: rec('remove', path => ({ path, removed: true })),
    find: rec('find', query => [{ path: `/${query}.txt`, kind: 'file' }]),
  };
};
const rejecting = (files, method, code) => {
  files[method] = () => Promise.reject(Object.assign(new Error('nope'), { code }));
  return files;
};

test('the pack declares its id and title', () => {
  assert.deepEqual(pack, { id: 'files', title: 'Files' });
});

test('the pack exposes exactly the 10 files tools', () => {
  assert.equal(tools.length, 10);
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'files.append', 'files.delete', 'files.find', 'files.info', 'files.list',
    'files.mkdir', 'files.overwrite', 'files.read', 'files.rename', 'files.write',
  ]);
});

test('every tool has the required text fields, effect, needs and examples', () => {
  for (const tool of tools) {
    assert.match(tool.name, /^files\.[a-z0-9_]+$/);
    assert.ok(tool.purpose.length > 0 && tool.purpose.length <= 80, `${tool.name} purpose is ${tool.purpose.length} chars`);
    assert.ok(tool.when.startsWith('Use when'), `${tool.name} when must start with "Use when"`);
    assert.ok(tool.when.length <= 120, `${tool.name} when is ${tool.when.length} chars`);
    assert.ok(['read', 'change', 'destructive', 'external'].includes(tool.effect), `${tool.name} bad effect`);
    assert.ok(tool.needs.includes('files'), `${tool.name} needs files`);
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

test('files.list calls list with the path, defaulting to the root', async () => {
  const files = fakeFiles();
  await runTool('files.list', { path: '/notes' }, { files });
  await runTool('files.list', {}, { files });
  assert.deepEqual(files.calls, [['list', '/notes'], ['list', '/']]);
});

test('files.info calls stat with the path', async () => {
  const files = fakeFiles();
  const out = await runTool('files.info', { path: '/notes/todo.txt' }, { files });
  assert.equal(out.kind, 'file');
  assert.deepEqual(files.calls, [['stat', '/notes/todo.txt']]);
});

test('files.read calls readText with maxChars, defaulting to 20000', async () => {
  const files = fakeFiles();
  await runTool('files.read', { path: '/notes/todo.txt' }, { files });
  await runTool('files.read', { path: '/notes/ideas.md', max_chars: 500 }, { files });
  assert.deepEqual(files.calls, [['readText', '/notes/todo.txt', { maxChars: 20000 }], ['readText', '/notes/ideas.md', { maxChars: 500 }]]);
});

test('files.write calls writeText without overwrite', async () => {
  const files = fakeFiles();
  const out = await runTool('files.write', { path: '/notes/todo.txt', text: 'Buy milk' }, { files });
  assert.deepEqual(out, { path: '/notes/todo.txt', size: 8, created: true });
  assert.deepEqual(files.calls, [['writeText', '/notes/todo.txt', 'Buy milk', { overwrite: false }]]);
});

test('files.overwrite calls writeText with overwrite: true', async () => {
  const files = fakeFiles();
  await runTool('files.overwrite', { path: '/notes/todo.txt', text: 'Updated list' }, { files });
  assert.deepEqual(files.calls, [['writeText', '/notes/todo.txt', 'Updated list', { overwrite: true }]]);
});

test('files.append calls appendText with path and text', async () => {
  const files = fakeFiles();
  await runTool('files.append', { path: '/notes/todo.txt', text: 'Call Ana' }, { files });
  assert.deepEqual(files.calls, [['appendText', '/notes/todo.txt', 'Call Ana']]);
});

test('files.mkdir calls mkdir with the path', async () => {
  const files = fakeFiles();
  assert.deepEqual(await runTool('files.mkdir', { path: '/notes/2026' }, { files }), { path: '/notes/2026' });
  assert.deepEqual(files.calls, [['mkdir', '/notes/2026']]);
});

test('files.rename calls rename with path and to', async () => {
  const files = fakeFiles();
  assert.deepEqual(await runTool('files.rename', { path: '/notes/todo.txt', to: '/notes/todo-2026.txt' }, { files }), { path: '/notes/todo-2026.txt' });
  assert.deepEqual(files.calls, [['rename', '/notes/todo.txt', '/notes/todo-2026.txt']]);
});

test('files.delete calls remove with the recursive flag, defaulting to false', async () => {
  const files = fakeFiles();
  await runTool('files.delete', { path: '/notes/old.txt' }, { files });
  await runTool('files.delete', { path: '/notes/2025', recursive: true }, { files });
  assert.deepEqual(files.calls, [['remove', '/notes/old.txt', { recursive: false }], ['remove', '/notes/2025', { recursive: true }]]);
});

test('files.find calls find with query and under, defaulting under to the root', async () => {
  const files = fakeFiles();
  await runTool('files.find', { query: 'todo' }, { files });
  await runTool('files.find', { query: 'report', under: '/inbox' }, { files });
  assert.deepEqual(files.calls, [['find', 'todo', { under: '/' }], ['find', 'report', { under: '/inbox' }]]);
});

test('an exists rejection on files.write becomes a ToolError with the files.overwrite fix line', async () => {
  const files = rejecting(fakeFiles(), 'writeText', 'exists');
  await assert.rejects(runTool('files.write', { path: '/notes/todo.txt', text: 'Buy milk' }, { files }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'exists');
    assert.equal(error.fix, callLine('files.overwrite', { path: '/notes/todo.txt', text: 'Buy milk' }));
    return true;
  });
});

test('an exists rejection on files.rename becomes a ToolError whose fix names a free target with (2)', async () => {
  const files = rejecting(fakeFiles(), 'rename', 'exists');
  await assert.rejects(runTool('files.rename', { path: '/notes/todo.txt', to: '/notes/todo.txt' }, { files }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'exists');
    assert.equal(error.fix, callLine('files.rename', { path: '/notes/todo.txt', to: '/notes/todo (2).txt' }));
    return true;
  });
});

test('any other rejection keeps its code and an empty fix', async () => {
  const files = rejecting(fakeFiles(), 'readText', 'not_found');
  await assert.rejects(runTool('files.read', { path: '/nope.txt' }, { files }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_found');
    assert.equal(error.fix, '');
    return true;
  });
});

test('a missing ctx.files rejects every tool with not_available', async () => {
  for (const tool of tools) {
    await assert.rejects(tool.run({}, {}), error => {
      assert.ok(error instanceof ToolError, `${tool.name} throws ToolError`);
      assert.equal(error.type, 'not_available');
      assert.match(error.message, /Files are not available/);
      return true;
    });
  }
});

const { skills, errors: skillErrors } = parseSkills(SKILLS_MD, 'files');

test('skills.md parses with the runtime parser without errors', () => {
  assert.deepEqual(skillErrors, []);
});

test('skills.md has the 12 skills with the required metadata', () => {
  assert.equal(skills.length, 12);
  for (const skill of skills) {
    assert.ok(skill.slug && skill.summary, `skill ${skill.slug} slug/summary`);
    assert.ok(skill.summary.length <= 160, `skill ${skill.slug} summary is ${skill.summary.length} chars`);
    assert.ok(skill.keywords.length >= 5, `skill ${skill.slug} keywords: ${skill.keywords.join(', ')}`);
    assert.ok(skill.tools.length >= 1, `skill ${skill.slug} tools`);
    assert.ok(skill.when && skill.steps.length >= 1 && skill.check, `skill ${skill.slug} body sections`);
  }
});

test('every skill step is a numbered files call_tool line', () => {
  for (const skill of skills) {
    skill.steps.forEach((step, i) => {
      assert.equal(step.n, i + 1, `skill ${skill.slug} step numbering`);
      assert.ok(step.line.startsWith(`${step.n}. call_tool tool=files.`), `skill ${skill.slug} step ${step.n}: ${step.line}`);
    });
  }
});

test('skill steps and tools lines validate against the runtime checkArgs', () => {
  const errors = checkSkills(skills, byName, { checkArgs: (tool, args) => checkArgs(tool, args, { choices }) });
  assert.deepEqual(errors, []);
});
