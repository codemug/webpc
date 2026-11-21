// Unit tests for the Terminal pack: agent/apps/terminal/tools.js and skills.md.
// The fake terminal page mirrors the app DOM the pack reads (src/scripts/pc/apps/terminal.mjs):
// #linux-pause (controls(): disabled when the VM is off or the page is busy; textContent
// "Pause" = running, "Resume" = paused), #terminal-status (the last report() line) and
// #linux-save (the app's own save action, disabled until booted). terminal.run delegates to
// ctx.legacy.run_code, the AI-4 exec bridge the model also sees as the run_code tool.
// Run: node --test tests/agent-pack-terminal.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack, tools } from '../agent/apps/terminal/tools.js';
import { tools as desktopTools } from '../agent/desktop/tools.js';
import { ToolError, specErrors, checkArgs } from '../src/apps/ai-agent/runtime/args.mjs';
import { parseSkills, checkSkills } from '../src/apps/ai-agent/runtime/skills.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_MD = readFileSync(join(HERE, '..', 'agent', 'apps', 'terminal', 'skills.md'), 'utf8');
// The enabled app ids scripts/agent/build.mjs resolves the live 'apps' enum with (catalog.yaml).
const APP_IDS = ['gridcraft', 'docs', 'deckcraft', 'terminal', 'sqliteviz', 'files', 'media', 'cyberchef', 'vscode', 'nettools', 'packets', 'ai-agent', 'lightcraft', 'figcraft', 'pdfcraft', 'soundcraft', 'beepbox', 'filmcraft', 'cadcraft', 'vectorcraft', 'photocraft', 'effectcraft', 'materialcraft', 'texturecraft', 'excalidraw', 'vert', 'about'];
const choices = name => (name === 'apps' || name === 'windows' ? APP_IDS : []);
const byName = name => tools.find(tool => tool.name === name) ?? desktopTools.find(tool => tool.name === name);

const fakeTerminal = (overrides = {}) => {
  const state = { opened: 0, runs: [], saves: 0, runResult: { exitCode: 0, output: 'ok\n', truncated: false }, saveOutcome: 'Saved in this browser · 1.0 MB · 12:00:00. Linux is paused.' };
  const statusEl = { textContent: '', dataset: {} };
  const pause = { disabled: false, textContent: 'Pause' };
  const save = {
    disabled: false,
    click() {
      state.saves += 1;
      statusEl.textContent = 'Capturing Linux memory and files… this may take several seconds.';
      queueMicrotask(() => { statusEl.textContent = state.saveOutcome; });
    },
  };
  const document = { getElementById: id => ({ 'linux-pause': pause, 'terminal-status': statusEl, 'linux-save': save }[id] ?? null) };
  const win = { document };
  const host = { appWindow: async () => { state.opened += 1; return win; } };
  const legacy = { run_code: { run: args => { state.runs.push(args); return Promise.resolve(state.runResult); } } };
  const runTool = (name, args, extra = {}) => byName(name).run(args, { host, legacy, sleep: async () => {}, ...extra });
  return { state, win, pause, save, statusEl, runTool };
};

test('the pack declares its id and title', () => {
  assert.deepEqual(pack, { id: 'terminal', title: 'Terminal' });
});

test('the pack exposes exactly the 4 terminal tools', () => {
  assert.equal(tools.length, 4);
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'terminal.open', 'terminal.run', 'terminal.save_session', 'terminal.status',
  ]);
});

test('every tool has the required text fields, effect, needs and examples', () => {
  for (const tool of tools) {
    assert.match(tool.name, /^terminal\.[a-z0-9_]+$/);
    assert.ok(tool.purpose.length > 0 && tool.purpose.length <= 80, `${tool.name} purpose is ${tool.purpose.length} chars`);
    assert.ok(tool.when.startsWith('Use when'), `${tool.name} when must start with "Use when"`);
    assert.ok(tool.when.length <= 120, `${tool.name} when is ${tool.when.length} chars`);
    assert.ok(['read', 'change', 'destructive', 'external'].includes(tool.effect), `${tool.name} bad effect`);
    assert.deepEqual(tool.needs, ['host', 'app:terminal']);
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

test('terminal.open opens the app window', async () => {
  const term = fakeTerminal();
  const got = await term.runTool('terminal.open', {});
  assert.deepEqual(got, { opened: true });
  assert.equal(term.state.opened, 1);
});

test('terminal.status maps the pause control to running, paused or unavailable', async () => {
  const term = fakeTerminal();
  term.statusEl.textContent = 'Linux started · Alpine 3.20';
  let got = await term.runTool('terminal.status', {});
  assert.deepEqual(got, { state: 'running', status: 'Linux started · Alpine 3.20' });
  term.pause.textContent = 'Resume';
  term.statusEl.textContent = 'Linux paused · memory is retained until this page closes.';
  got = await term.runTool('terminal.status', {});
  assert.equal(got.state, 'paused');
  term.pause.disabled = true;
  term.statusEl.textContent = 'Capturing Linux memory and files… this may take several seconds.';
  got = await term.runTool('terminal.status', {});
  assert.deepEqual(got, { state: 'unavailable', status: 'Capturing Linux memory and files… this may take several seconds.' });
});

test('terminal.run opens the window first, then delegates to the run_code bridge', async () => {
  const term = fakeTerminal();
  const got = await term.runTool('terminal.run', { lang: 'sh', code: 'echo hello' });
  assert.deepEqual(got, { exitCode: 0, output: 'ok\n', truncated: false });
  assert.equal(term.state.opened, 1, 'the approval prompt must be visible to the user');
  assert.equal(term.state.runs.length, 1);
  assert.equal(term.state.runs[0].lang, 'sh');
  assert.equal(term.state.runs[0].code, 'echo hello');
  assert.ok(!('timeout_ms' in term.state.runs[0]) || term.state.runs[0].timeout_ms === undefined, 'no timeout means the bridge default (30000)');
});

test('terminal.run passes timeout_ms through to the bridge', async () => {
  const term = fakeTerminal();
  await term.runTool('terminal.run', { lang: 'python', code: 'print(1)', timeout_ms: 5000 });
  assert.equal(term.state.runs[0].timeout_ms, 5000);
});

test('terminal.run passes the bridge reply through unchanged', async () => {
  const term = fakeTerminal();
  term.state.runResult = { error: 'The user denied this run.' };
  const got = await term.runTool('terminal.run', { lang: 'node', code: 'x' });
  assert.deepEqual(got, { error: 'The user denied this run.' });
  term.state.runResult = { error: 'The run exceeded its time limit and was interrupted with Ctrl+C.', output: 'partial\n', truncated: true };
  const timed = await term.runTool('terminal.run', { lang: 'sh', code: 'sleep 99' });
  assert.deepEqual(timed, { error: 'The run exceeded its time limit and was interrupted with Ctrl+C.', output: 'partial\n', truncated: true });
});

test('terminal.run rejects with not_available when the run_code bridge is not wired', async () => {
  const term = fakeTerminal();
  await assert.rejects(byName('terminal.run').run({ lang: 'sh', code: 'x' }, { host: { appWindow: async () => term.win } }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    assert.match(error.message, /run_code bridge/);
    return true;
  });
});

test('terminal.run rejects a lang outside the app languages', () => {
  const tool = byName('terminal.run');
  assert.equal(checkArgs(tool, { lang: 'ruby', code: 'x' }, { choices }).ok, false, 'ruby is not an app language');
  assert.equal(checkArgs(tool, { lang: 'sh' }, { choices }).ok, false, 'code is required');
});

test('terminal.save_session clicks the app save action and waits for the status line', async () => {
  const term = fakeTerminal();
  const got = await term.runTool('terminal.save_session', {});
  assert.equal(term.state.saves, 1);
  assert.deepEqual(got, { saved: true, status: term.state.saveOutcome });
});

test('terminal.save_session reports a storage failure as saved false', async () => {
  const term = fakeTerminal();
  term.state.saveOutcome = 'Could not save in this browser. Export session now to keep your work. QuotaExceededError';
  const got = await term.runTool('terminal.save_session', {});
  assert.deepEqual(got, { saved: false, status: term.state.saveOutcome });
});

test('terminal.save_session rejects when the save action is disabled', async () => {
  const term = fakeTerminal();
  term.save.disabled = true;
  await assert.rejects(term.runTool('terminal.save_session', {}), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'app_error');
    assert.match(error.message, /not ready to save/);
    return true;
  });
  assert.equal(term.state.saves, 0, 'nothing was clicked');
});

test('terminal.save_session does not report a stale Saved line as the new save', async () => {
  const term = fakeTerminal();
  // The status already holds the result of an earlier save, and this save reports the same
  // text: only a status change counts, so the tool times out instead of a false positive.
  term.statusEl.textContent = term.state.saveOutcome;
  await assert.rejects(term.runTool('terminal.save_session', {}), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'app_error');
    assert.match(error.message, /did not finish/);
    return true;
  });
});

test('a tool rejects with not_available when ctx.host is absent', async () => {
  await assert.rejects(byName('terminal.status').run({}, { host: null }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    return true;
  });
});

test('a host rejection code is passed through as the ToolError type', async () => {
  const boom = () => { const error = new Error('window "terminal" is not open'); error.code = 'not_open'; throw error; };
  await assert.rejects(byName('terminal.open').run({}, { host: { appWindow: boom } }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_open');
    return true;
  });
});

const { skills, errors: skillErrors } = parseSkills(SKILLS_MD, 'terminal');

test('skills.md parses with the runtime parser without errors and has 4 skills', () => {
  assert.deepEqual(skillErrors, []);
  assert.equal(skills.length, 4);
  for (const skill of skills) {
    assert.ok(skill.slug && skill.summary, `skill ${skill.slug} slug/summary`);
    assert.ok(skill.summary.length <= 160, `skill ${skill.slug} summary is ${skill.summary.length} chars`);
    assert.ok(skill.keywords.length >= 5, `skill ${skill.slug} keywords: ${skill.keywords.join(', ')}`);
    assert.ok(skill.tools.length >= 1, `skill ${skill.slug} tools`);
    assert.ok(skill.when && skill.steps.length >= 1 && skill.check, `skill ${skill.slug} body sections`);
  }
});

test('every skill opens by launching the terminal, then uses numbered terminal steps', () => {
  for (const skill of skills) {
    assert.equal(skill.steps[0].line, '1. call_tool tool=desktop.open_app app=terminal', `skill ${skill.slug}`);
    skill.steps.forEach((step, i) => {
      assert.equal(step.n, i + 1, `skill ${skill.slug} step numbering`);
      assert.ok(step.tool.startsWith('desktop.') || step.tool.startsWith('terminal.'), `skill ${skill.slug} step ${step.n}: ${step.line}`);
    });
  }
});

test('skill steps and tools lines validate against the runtime checkArgs', () => {
  const errors = checkSkills(skills, byName, { checkArgs: (tool, args) => checkArgs(tool, args, { choices }) });
  assert.deepEqual(errors, []);
});
