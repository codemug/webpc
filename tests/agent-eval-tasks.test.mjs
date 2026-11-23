// Unit test for the M6 eval task suite (tests/agent-eval/tasks.yaml).
// Validates: the YAML parses and every task carries the required fields; every expect.tools
// name exists in the generated catalog; every check kind is in the supported set (and is
// well-formed); and the set counts are A20 / B20 / C15 / D5. No browser, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const tasks = parse(readFileSync(join(ROOT, 'tests/agent-eval/tasks.yaml'), 'utf8')).tasks;
const catalog = JSON.parse(readFileSync(join(ROOT, 'src/apps/ai-agent/generated/catalog.json'), 'utf8'));
const toolNames = new Set(catalog.tools.map((t) => t.name));
const appIds = new Set(catalog.apps.map((a) => a.id));

const SETS = new Set(['A', 'B', 'C', 'D']);
const EXPECTED_COUNTS = { A: 20, B: 20, C: 15, D: 5 };
// The check kinds the runner (scripts/agent/eval.mjs) implements.
const CHECK_KINDS = new Set([
  'window_open', 'theme', 'file_exists', 'file_contains', 'cell',
  'docs_text_contains', 'excalidraw_count_at_least', 'cyberchef_output',
]);

/** Every task has the required fields and sane types. */
test('tasks.yaml parses and every task has the required fields', () => {
  assert.ok(Array.isArray(tasks) && tasks.length > 0, 'tasks must be a non-empty array');
  const ids = new Set();
  for (const task of tasks) {
    assert.ok(typeof task.id === 'string' && task.id.length > 0, `id must be a non-empty string (got ${JSON.stringify(task.id)})`);
    assert.ok(!ids.has(task.id), `duplicate id ${task.id}`);
    ids.add(task.id);
    assert.ok(SETS.has(task.set), `unknown set ${task.set} in ${task.id}`);
    assert.ok(typeof task.prompt === 'string' && task.prompt.length > 0, `prompt must be a non-empty string in ${task.id}`);
    assert.ok(Array.isArray(task.setup), `setup must be an array in ${task.id}`);
    for (const step of task.setup) {
      assert.ok(step && typeof step === 'object', `setup step must be an object in ${task.id}`);
      const keys = Object.keys(step);
      assert.ok(keys.length === 1, `setup step must have exactly one key in ${task.id}: ${keys.join(',')}`);
      assert.ok(['close_all', 'open_app', 'seed_file'].includes(keys[0]), `unknown setup step ${keys[0]} in ${task.id}`);
    }
    assert.ok(task.expect && Array.isArray(task.expect.tools), `expect.tools must be an array in ${task.id}`);
    assert.ok(task.check && typeof task.check === 'object', `check must be an object in ${task.id}`);
  }
});

/** Every expected tool name is a real catalog tool. */
test('every expect.tools name exists in the generated catalog', () => {
  const missing = [];
  for (const task of tasks) for (const name of task.expect?.tools ?? []) if (!toolNames.has(name)) missing.push(`${task.id}: ${name}`);
  assert.deepEqual(missing, [], 'tool names not in catalog: ' + missing.join(', '));
});

/** Every check kind is supported and its value is well-formed. */
test('every check kind is in the supported set and well-formed', () => {
  const problems = [];
  for (const task of tasks) {
    const [kind, value] = Object.entries(task.check ?? {})[0] ?? [];
    if (!CHECK_KINDS.has(kind)) { problems.push(`${task.id}: unsupported check kind ${kind}`); continue; }
    if (Object.keys(task.check).length !== 1) { problems.push(`${task.id}: check must have exactly one kind`); continue; }
    switch (kind) {
      case 'window_open': if (!appIds.has(value)) problems.push(`${task.id}: unknown app ${value}`); break;
      case 'theme': if (value !== 'dark' && value !== 'light') problems.push(`${task.id}: theme must be light or dark`); break;
      case 'file_exists': if (typeof value !== 'string' || !value.startsWith('/')) problems.push(`${task.id}: file_exists needs a /path`); break;
      case 'file_contains': if (typeof value?.path !== 'string' || typeof value?.text !== 'string') problems.push(`${task.id}: file_contains needs {path, text}`); break;
      case 'cell': if (!appIds.has(value?.app) || typeof value?.cell !== 'string' || value?.input == null) problems.push(`${task.id}: cell needs {app, cell, input}`); break;
      case 'docs_text_contains': case 'cyberchef_output': if (typeof value !== 'string' || value === '') problems.push(`${task.id}: ${kind} needs a non-empty text`); break;
      case 'excalidraw_count_at_least': if (!Number.isInteger(value) || value < 1) problems.push(`${task.id}: excalidraw_count_at_least needs an integer >= 1`); break;
    }
  }
  assert.deepEqual(problems, [], problems.join('; '));
});

/** setup open_app and window_open targets are real desktop apps. */
test('open_app and window_open targets are real apps', () => {
  const problems = [];
  for (const task of tasks) {
    for (const step of task.setup ?? []) if (step.open_app && !appIds.has(step.open_app)) problems.push(`${task.id}: setup unknown app ${step.open_app}`);
    if (task.check?.window_open && !appIds.has(task.check.window_open)) problems.push(`${task.id}: check unknown app ${task.check.window_open}`);
  }
  assert.deepEqual(problems, [], problems.join('; '));
});

/** The set spread is exactly A20 / B20 / C15 / D5. */
test('set counts match A20 B20 C15 D5', () => {
  const counts = {};
  for (const task of tasks) counts[task.set] = (counts[task.set] ?? 0) + 1;
  for (const [set, want] of Object.entries(EXPECTED_COUNTS)) assert.equal(counts[set] ?? 0, want, `set ${set}: got ${counts[set] ?? 0}, want ${want}`);
  assert.equal(tasks.length, 60, `total tasks: got ${tasks.length}, want 60`);
});
