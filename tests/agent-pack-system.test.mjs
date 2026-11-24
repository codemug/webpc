// Unit tests for the System pack: agent/system/tools.js and skills.md.
// Every tool delegates to the session's legacy tools (ctx.legacy, built per turn by
// src/apps/ai-agent/agent.js createTools), so the behaviour, limits and safety checks of
// every legacy tool stay exactly as they were. system.sleep is the only self-contained
// one: it waits seconds (default 3, 1 to 30) and rejects at once on the turn's abort
// signal (Stop), so the agent can poll a state that changes over time (a Linux boot)
// instead of guessing. The schema and skills checks reuse the real runtime validators
// (args.mjs, skills.mjs), the same checks the lead's build runs over the pack files.
// Run: node --test tests/agent-pack-system.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack, tools } from '../agent/system/tools.js';
import { ToolError, specErrors, checkArgs } from '../src/apps/ai-agent/runtime/args.mjs';
import { parseSkills, checkSkills } from '../src/apps/ai-agent/runtime/skills.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_MD = readFileSync(join(HERE, '..', 'agent', 'system', 'skills.md'), 'utf8');
const byName = name => tools.find(tool => tool.name === name);
const sleep = byName('system.sleep');

test('the pack declares its id and the WebPC Agent title', () => {
  assert.deepEqual(pack, { id: 'system', title: 'WebPC Agent' });
});

test('the pack exposes exactly the 12 system tools', () => {
  assert.equal(tools.length, 12);
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'system.calculate', 'system.detect_language', 'system.http_get', 'system.ocr_image',
    'system.remove_background', 'system.run_code', 'system.run_javascript', 'system.search_files',
    'system.sleep', 'system.summarize', 'system.translate', 'system.web_search',
  ]);
});

test('every tool has the required text fields, effect and examples', () => {
  for (const tool of tools) {
    assert.match(tool.name, /^system\.[a-z0-9_]+$/);
    assert.ok(tool.purpose.length > 0 && tool.purpose.length <= 80, `${tool.name} purpose is ${tool.purpose.length} chars`);
    assert.ok(tool.when.startsWith('Use when'), `${tool.name} when must start with "Use when"`);
    assert.ok(tool.when.length <= 120, `${tool.name} when is ${tool.when.length} chars`);
    assert.ok(['read', 'change', 'destructive', 'external'].includes(tool.effect), `${tool.name} bad effect`);
    if (tool.needs !== undefined) assert.ok(Array.isArray(tool.needs), `${tool.name} needs must be a list`);
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
      const out = checkArgs(tool, example.args, { choices: () => [] });
      assert.ok(out.ok, `${tool.name} example ${n}: ${out.error?.message}`);
    }
  }
});

test('system.sleep is a no-needs read tool with seconds from 1 to 30', () => {
  assert.equal(sleep.effect, 'read');
  assert.equal(sleep.needs, undefined, 'sleep works everywhere, no host or app needed');
  assert.equal(sleep.params.seconds.type, 'integer');
  assert.equal(sleep.params.seconds.min, 1);
  assert.equal(sleep.params.seconds.max, 30);
  assert.equal(checkArgs(sleep, { seconds: 0 }, { choices: () => [] }).ok, false, 'below 1 is rejected');
  assert.equal(checkArgs(sleep, { seconds: 31 }, { choices: () => [] }).ok, false, 'above 30 is rejected');
});

test('system.sleep waits the asked seconds (1 second real case)', async () => {
  const start = performance.now();
  const got = await sleep.run({ seconds: 1 }, {});
  const elapsed = performance.now() - start;
  assert.ok(elapsed >= 950, `waited ${Math.round(elapsed)} ms`);
  assert.deepEqual(got, { slept: 1 });
});

test('system.sleep defaults to 3 seconds and resolves there', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const done = sleep.run({}, {}).then(result => { settled = true; return result; });
  await Promise.resolve();
  t.mock.timers.tick(2999);
  assert.equal(settled, false, 'still waiting just before the 3 second mark');
  t.mock.timers.tick(1);
  assert.deepEqual(await done, { slept: 3 }, 'resolves at 3 seconds with the default');
  t.mock.timers.reset();
});

test('system.sleep rejects at once when the turn is stopped while waiting', async () => {
  const controller = new AbortController();
  const start = performance.now();
  const p = sleep.run({ seconds: 30 }, { signal: controller.signal });
  const abortIn = setTimeout(() => controller.abort(), 50);
  await assert.rejects(p, error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'aborted');
    assert.match(error.message, /stopped while waiting/);
    assert.ok(performance.now() - start < 1000, 'rejected well before the 30 second wait');
    return true;
  });
  clearTimeout(abortIn);
});

test('system.sleep rejects at once when the turn was already stopped', async () => {
  const controller = new AbortController();
  controller.abort();
  const start = performance.now();
  await assert.rejects(sleep.run({ seconds: 30 }, { signal: controller.signal }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'aborted');
    assert.ok(performance.now() - start < 100, 'no wait at all');
    return true;
  });
});

test('a legacy tool without its ctx.legacy entry rejects not_available', async () => {
  const calculate = byName('system.calculate');
  await assert.rejects(calculate.run({ expression: '1+1' }, {}), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    assert.match(error.message, /not available right now/);
    return true;
  });
});

test('a legacy tool delegates to ctx.legacy and turns { error } results into errors', async () => {
  const calculate = byName('system.calculate');
  const legacy = { calculate: { run: args => Promise.resolve({ value: 2 }) } };
  assert.deepEqual(await calculate.run({ expression: '1+1' }, { legacy }), { value: 2 });
  const broken = { calculate: { run: () => Promise.resolve({ error: 'bad expression' }) } };
  await assert.rejects(calculate.run({ expression: '1+' }, { legacy: broken }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'app_error');
    assert.equal(error.message, 'bad expression');
    return true;
  });
});

const { skills, errors: skillErrors } = parseSkills(SKILLS_MD, 'system');

test('skills.md parses with the runtime parser without errors and has 7 skills', () => {
  assert.deepEqual(skillErrors, []);
  assert.equal(skills.length, 7);
  for (const skill of skills) {
    assert.ok(skill.slug && skill.summary, `skill ${skill.slug} slug/summary`);
    assert.ok(skill.summary.length <= 160, `skill ${skill.slug} summary is ${skill.summary.length} chars`);
    assert.ok(skill.keywords.length >= 5, `skill ${skill.slug} keywords: ${skill.keywords.join(', ')}`);
    assert.ok(skill.tools.length >= 1, `skill ${skill.slug} tools`);
    assert.ok(skill.when && skill.steps.length >= 1 && skill.check, `skill ${skill.slug} body sections`);
  }
});

test('skill steps and tools lines validate against the runtime checkArgs', () => {
  const errors = checkSkills(skills, name => byName(name), { checkArgs: (tool, args) => checkArgs(tool, args, { choices: () => [] }) });
  assert.deepEqual(errors, []);
});
