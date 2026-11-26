// Unit tests for the Terminal pack: agent/apps/terminal/tools.js and skills.md.
// The fake terminal page mirrors the app DOM the pack reads (src/scripts/pc/apps/terminal-unkernel.mjs):
// #linux-start (controls(): disabled while the guest runs or the page is busy) and
// #linux-restart (disabled while the guest is off or the page is busy), plus #terminal-status
// (the last report() line; "Booting Alpine Linux…" while a boot is in flight). There is no
// pause and no save: files are kept automatically on the guest's IndexedDB data disk.
// terminal.start clicks #linux-start (the fake click flips both buttons, as action() does
// synchronously); terminal.run delegates to ctx.legacy.run_code, the exec bridge the model
// also sees as the run_code tool. The exec error strings come from execReplyToToolResult
// (src/apps/ai-agent/agent.js).
// Run: node --test tests/agent-pack-terminal.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack, tools, resetShellReadiness } from '../agent/apps/terminal/tools.js';
import { tools as desktopTools } from '../agent/desktop/tools.js';
import { tools as systemTools } from '../agent/system/tools.js';
import { ToolError, specErrors, checkArgs } from '../src/apps/ai-agent/runtime/args.mjs';
import { parseSkills, checkSkills } from '../src/apps/ai-agent/runtime/skills.mjs';
import { execReplyToToolResult } from '../src/apps/ai-agent/agent.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_MD = readFileSync(join(HERE, '..', 'agent', 'apps', 'terminal', 'skills.md'), 'utf8');
// The enabled app ids scripts/agent/build.mjs resolves the live 'apps' enum with (catalog.yaml).
const APP_IDS = ['gridcraft', 'docs', 'deckcraft', 'terminal', 'sqliteviz', 'files', 'media', 'cyberchef', 'vscode', 'nettools', 'packets', 'ai-agent', 'lightcraft', 'figcraft', 'pdfcraft', 'soundcraft', 'beepbox', 'filmcraft', 'cadcraft', 'vectorcraft', 'photocraft', 'effectcraft', 'materialcraft', 'texturecraft', 'excalidraw', 'vert'];
const choices = name => (name === 'apps' || name === 'windows' ? APP_IDS : []);
const byName = name => tools.find(tool => tool.name === name) ?? desktopTools.find(tool => tool.name === name) ?? systemTools.find(tool => tool.name === name);
const NEXT = 'call system.sleep seconds=3, then terminal.status, until state is running';

// The fake guest carries the boot race the real guest had in sweep-terminal-b17
// (terminal-01): the page reports running before the shell runs commands, so the first
// command after a boot is swallowed (exit 0, empty output). An echo command answers with
// its value like the guest's vm.exec (clean output, no echoed code); anything else returns
// the fixed runResult the test sets.
const fakeTerminal = ({ boots = true, swallowFirst = 1 } = {}) => {
  const state = { opened: 0, starts: 0, runs: [], runResult: { exitCode: 0, output: 'ok\n', truncated: false }, customBridge: null };
  let swallowed = 0;
  let ready = false;
  const armShell = () => { swallowed = 0; ready = false; };
  armShell();
  const statusEl = { textContent: '', dataset: {} };
  const start = {
    disabled: false,
    // action() sets busy and re-runs controls() synchronously on click; boot() then reports
    // "Booting Alpine Linux…", and once the guest runs controls() enables #linux-restart.
    click: () => {
      state.starts += 1; start.disabled = true; statusEl.textContent = 'Booting Alpine Linux…';
      armShell(); // a fresh boot is a fresh shell: the next command is swallowed again
      if (boots) setTimeout(() => { restart.disabled = false; statusEl.textContent = 'Linux is running'; }, 5);
    },
  };
  const restart = { disabled: true };
  const buttons = { 'linux-start': start, 'linux-restart': restart, 'terminal-status': statusEl };
  const document = { getElementById: id => buttons[id] ?? null };
  const win = { document };
  const host = { appWindow: async () => { state.opened += 1; return win; } };
  const legacy = { run_code: { run: args => {
    state.runs.push(args);
    if (state.customBridge) return state.customBridge(args, state);
    if (!ready) {
      if (swallowed < swallowFirst) { swallowed += 1; return Promise.resolve({ exitCode: 0, output: '', truncated: false }); }
      ready = true;
    }
    const echo = /^echo (.+)$/.exec(String(args.code ?? '').trim());
    if (echo) return Promise.resolve({ exitCode: 0, output: `${echo[1]}\n`, truncated: false });
    return Promise.resolve(state.runResult);
  } } };
  const runTool = (name, args, extra = {}) => byName(name).run(args, { host, legacy, ...extra });
  return { state, win, start, restart, statusEl, runTool };
};

test('the pack declares its id and title', () => {
  assert.deepEqual(pack, { id: 'terminal', title: 'Terminal' });
});

test('the pack exposes exactly the 4 terminal tools', () => {
  assert.equal(tools.length, 4);
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'terminal.open', 'terminal.run', 'terminal.start', 'terminal.status',
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

test('terminal.start is a no-param change tool with the sleep-and-poll hint', () => {
  const start = byName('terminal.start');
  assert.equal(start.effect, 'change');
  assert.deepEqual(start.params, {});
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

test('terminal.start clicks #linux-start and returns starting with the next hint', async () => {
  const term = fakeTerminal();
  const got = await term.runTool('terminal.start', {});
  assert.deepEqual(got, { state: 'starting', next: NEXT });
  assert.equal(term.state.starts, 1, 'the enabled button is clicked');
  assert.equal(term.state.opened, 1, 'the window is opened first so the user sees the boot');
});

test('terminal.start does not click when the guest already runs', async () => {
  const term = fakeTerminal();
  term.start.disabled = true;
  term.restart.disabled = false;
  term.statusEl.textContent = 'Linux is running · offline · files are kept in this browser.';
  const got = await term.runTool('terminal.start', {});
  assert.deepEqual(got, { state: 'running', next: NEXT });
  assert.equal(term.state.starts, 0);
});

test('terminal.start does not click while an action is in flight and reads the state', async () => {
  const term = fakeTerminal();
  term.start.disabled = true;
  term.restart.disabled = true;
  term.statusEl.textContent = 'Booting Alpine Linux…';
  let got = await term.runTool('terminal.start', {});
  assert.deepEqual(got, { state: 'starting', next: NEXT });
  assert.equal(term.state.starts, 0, 'no double click while a boot is in flight');
  term.statusEl.textContent = 'Linux is running · offline · files are kept in this browser.';
  got = await term.runTool('terminal.start', {});
  assert.equal(got.state, 'busy', 'a non-boot line in flight stays busy');
});

test('terminal.status maps the start and restart controls to running, stopped, starting or busy', async () => {
  const term = fakeTerminal();
  term.statusEl.textContent = 'Ready to start. The Linux image loads only when you start.';
  let got = await term.runTool('terminal.status', {});
  assert.deepEqual(got, { state: 'stopped', status: 'Ready to start. The Linux image loads only when you start.', next: NEXT });
  term.start.disabled = true;
  term.restart.disabled = false;
  term.statusEl.textContent = 'Linux is running · offline · files are kept in this browser.';
  got = await term.runTool('terminal.status', {});
  assert.deepEqual(got, { state: 'running', status: 'Linux is running · offline · files are kept in this browser.' }, 'running carries no next hint');
  term.start.disabled = true;
  term.restart.disabled = true;
  term.statusEl.textContent = 'Booting Alpine Linux…';
  got = await term.runTool('terminal.status', {});
  assert.deepEqual(got, { state: 'starting', status: 'Booting Alpine Linux…', next: NEXT });
  term.statusEl.textContent = 'Linux is running · offline · files are kept in this browser.';
  got = await term.runTool('terminal.status', {});
  assert.deepEqual(got, { state: 'busy', status: 'Linux is running · offline · files are kept in this browser.', next: NEXT });
});

test('terminal.status reports unavailable when the page controls are missing', async () => {
  const win = { document: { getElementById: () => null } };
  const got = await byName('terminal.status').run({}, { host: { appWindow: async () => win } });
  assert.deepEqual(got, { state: 'unavailable', status: '', next: NEXT });
});

test('terminal.run proves the shell with a sentinel before the first real command', async () => {
  // sweep-terminal-b17 terminal-01: the first two commands returned exit 0 with empty output
  // because the guest reports ready before its shell runs. The sentinel retries until the
  // shell actually echoes, then the real command runs.
  resetShellReadiness();
  const term = fakeTerminal();
  const got = await term.runTool('terminal.run', { lang: 'sh', code: 'echo hello' });
  assert.deepEqual(got, { exitCode: 0, output: 'hello\n', truncated: false });
  assert.equal(term.state.opened, 1, 'the window must be open so the user sees the run');
  const [first, second, real] = term.state.runs;
  assert.match(first.code, /^echo wcpc-ready-[a-z0-9]+$/);
  assert.equal(first.lang, 'sh');
  assert.equal(second.code, first.code, 'the swallowed sentinel is retried with the same token');
  assert.equal(real.code, 'echo hello', 'the real command runs only after the shell proved ready');
});

test('terminal.run on a stopped guest starts it once, waits until it runs, then runs the code', async () => {
  resetShellReadiness();
  const term = fakeTerminal();
  const got = await term.runTool('terminal.run', { lang: 'sh', code: 'uname -a' });
  assert.equal(term.state.starts, 1, 'Start Linux is pressed once');
  assert.equal(term.state.runs.length, 3, 'two sentinel runs, then the code');
  assert.match(term.state.runs[0].code, /^echo wcpc-ready-/);
  assert.equal(term.state.runs[2].code, 'uname -a', 'the code runs after the guest is up and the shell proved ready');
  assert.deepEqual(got, { exitCode: 0, output: 'ok\n', truncated: false });
});

test('terminal.run on a running guest does not press Start Linux', async () => {
  const term = fakeTerminal();
  term.start.disabled = true;
  term.restart.disabled = false;
  await term.runTool('terminal.run', { lang: 'sh', code: 'echo hi' });
  assert.equal(term.state.starts, 0);
  assert.ok(term.state.runs.some(run => run.code === 'echo hi'), 'the code ran');
});

test('terminal.run rejects with not_running when the Terminal controls are missing', async () => {
  const win = { document: { getElementById: () => null } };
  const legacy = { run_code: { run: () => assert.fail('nothing may run') } };
  await assert.rejects(byName('terminal.run').run({ lang: 'sh', code: 'x' }, { host: { appWindow: async () => win }, legacy }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_running');
    return true;
  });
});

test('terminal.run stops waiting for the boot when the turn is stopped', async () => {
  const term = fakeTerminal({ boots: false });
  const controller = new AbortController();
  const pending = term.runTool('terminal.run', { lang: 'sh', code: 'x' }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'aborted');
    return true;
  });
  assert.equal(term.state.runs.length, 0, 'nothing ran');
});

test('terminal.run passes timeout_ms through to the bridge', async () => {
  const term = fakeTerminal();
  await term.runTool('terminal.run', { lang: 'python', code: 'print(1)', timeout_ms: 5000 });
  const real = term.state.runs.find(run => run.code === 'print(1)');
  assert.equal(real.timeout_ms, 5000);
  const sentinel = term.state.runs[0];
  assert.ok(sentinel.timeout_ms === 3000, 'the sentinel runs under its own short limit');
});

test('an echoed sentinel line alone does not prove the shell ready', async () => {
  // The token must appear as real output: a reply that only carries the echoed command
  // line (the terminal echoing what it was sent) would false-positive on a raw includes().
  resetShellReadiness();
  const term = fakeTerminal();
  let n = 0;
  term.state.customBridge = (args, state) => {
    const code = String(args.code ?? '');
    if (!code.startsWith('echo wcpc-ready-')) return Promise.resolve(state.runResult);
    n += 1;
    const token = code.replace(/^echo /, '');
    if (n === 1) return Promise.resolve({ exitCode: 0, output: '', truncated: false });
    if (n === 2) return Promise.resolve({ exitCode: 0, output: `${code}\n`, truncated: false });
    return Promise.resolve({ exitCode: 0, output: `${token}\n`, truncated: false });
  };
  const got = await term.runTool('terminal.run', { lang: 'sh', code: 'ls' });
  assert.deepEqual(got, { exitCode: 0, output: 'ok\n', truncated: false });
  assert.equal(n, 3, 'the echoed line alone did not prove the shell; the real output did');
  assert.equal(term.state.runs.length, 4, 'three sentinel runs, then the real command');
  assert.equal(term.state.runs[3].code, 'ls');
});

test('the sentinel runs once per boot, not on every command', async () => {
  resetShellReadiness();
  const term = fakeTerminal();
  await term.runTool('terminal.run', { lang: 'sh', code: 'uname -a' });
  await term.runTool('terminal.run', { lang: 'sh', code: 'whoami' });
  assert.equal(term.state.runs.length, 4, 'the second command of the same boot skips the sentinel');
  assert.match(term.state.runs[0].code, /^echo wcpc-ready-/);
  assert.equal(term.state.runs[1].code, term.state.runs[0].code);
  assert.equal(term.state.runs[2].code, 'uname -a');
  assert.equal(term.state.runs[3].code, 'whoami');
});

test('a guest reboot re-proves the shell', async () => {
  resetShellReadiness();
  const term = fakeTerminal();
  await term.runTool('terminal.run', { lang: 'sh', code: 'uname -a' });
  // The guest came back from a stop (the user pressed Restart): the next run boots it again.
  term.start.disabled = false;
  term.restart.disabled = true;
  term.statusEl.textContent = 'Ready to start. The Linux image loads only when you start.';
  await term.runTool('terminal.run', { lang: 'sh', code: 'whoami' });
  assert.equal(term.state.starts, 2);
  const sentinels = term.state.runs.filter(run => /^echo wcpc-ready-/.test(run.code));
  assert.equal(sentinels.length, 4, 'the fresh boot proves the shell again');
});

test('terminal.run fails honestly when the shell never proves ready', async () => {
  resetShellReadiness();
  const term = fakeTerminal();
  term.state.customBridge = () => Promise.resolve({ exitCode: 0, output: '', truncated: false });
  const t0 = Date.now();
  await assert.rejects(term.runTool('terminal.run', { lang: 'sh', code: 'ls' }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_running');
    assert.match(error.message, /shell never echoed the readiness check/);
    assert.match(error.message, /swallows the first commands, or the exec channel went dead/);
    return true;
  });
  assert.ok(Date.now() - t0 < 9000, 'the wait is bounded, not a hang');
  assert.ok(term.state.runs.length > 1, 'the sentinel was retried');
  assert.ok(term.state.runs.every(run => /^echo wcpc-ready-/.test(run.code)), 'only the sentinel ran, never the real command');
});

test('terminal.run re-proves once when a run answers exit 0 with empty output, and fails honestly when the channel is dead', async () => {
  // sweep-terminal-b19 terminal-01: the oracle phase proved the shell on the page, the sweep
  // reused it with the guest already running, and the guest's exec session had gone silent -
  // every terminal.run, the sentinel included, answered {exitCode:0, output:""}. A run that
  // ends that way must re-prove: a dead sentinel means the shell is not executing, which is
  // the honest not_running, not another empty success.
  resetShellReadiness();
  const term = fakeTerminal();
  let sentinels = 0;
  term.state.customBridge = args => {
    const code = String(args.code ?? '');
    if (/^echo wcpc-ready-/.test(code)) {
      sentinels += 1;
      // the first sentinel is the boot proof (the shell answers); after it the channel is
      // dead: every run - sentinel or not - answers exit 0 with empty output.
      return Promise.resolve(sentinels === 1 ? { exitCode: 0, output: `${code.replace(/^echo /, '')}\n`, truncated: false } : { exitCode: 0, output: '', truncated: false });
    }
    return Promise.resolve({ exitCode: 0, output: '', truncated: false });
  };
  const t0 = Date.now();
  await assert.rejects(term.runTool('terminal.run', { lang: 'sh', code: 'ls -la ~' }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_running');
    assert.match(error.message, /shell never echoed the readiness check/);
    return true;
  });
  assert.ok(Date.now() - t0 < 9000, 'the dead channel surfaces in bounded time, not after 27 empty rounds');
  assert.ok(term.state.runs.some(run => run.code === 'ls -la ~'), 'the real command ran once, then the re-proof took over');
});

test('a live shell answering an empty command still gets the empty reply, after one re-proof', async () => {
  // `true` prints nothing: the re-proof must not turn a legitimate empty answer into a
  // failure - the sentinel answers (the shell is live), so the original reply stands.
  resetShellReadiness();
  const term = fakeTerminal();
  let sentinels = 0;
  term.state.customBridge = args => {
    const code = String(args.code ?? '');
    if (/^echo wcpc-ready-/.test(code)) {
      sentinels += 1;
      return Promise.resolve({ exitCode: 0, output: `${code.replace(/^echo /, '')}\n`, truncated: false });
    }
    return Promise.resolve({ exitCode: 0, output: '', truncated: false });
  };
  const got = await term.runTool('terminal.run', { lang: 'sh', code: 'true' });
  assert.deepEqual(got, { exitCode: 0, output: '', truncated: false }, 'the empty output is the real answer, passed through');
  assert.equal(sentinels, 2, 'the boot proof plus exactly one re-proof on the empty reply');
});

test('terminal.run passes the bridge reply through unchanged', async () => {
  const term = fakeTerminal();
  term.state.runResult = { error: 'The user denied this run.' };
  const got = await term.runTool('terminal.run', { lang: 'node', code: 'x' });
  assert.deepEqual(got, { error: 'The user denied this run.' });
  term.state.runResult = { error: 'The run exceeded its time limit and was killed in the guest.', output: '', truncated: false };
  const timed = await term.runTool('terminal.run', { lang: 'sh', code: 'sleep 99' });
  assert.deepEqual(timed, { error: 'The run exceeded its time limit and was killed in the guest.', output: '', truncated: false });
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

test('the exec errors tell the model to start Linux and poll, instead of asking the user', () => {
  assert.match(execReplyToToolResult({ type: 'exec-error', reason: 'not-running' }).error, /Linux is not running: call terminal\.start, then system\.sleep seconds=3 and terminal\.status until the state is running/);
  assert.match(execReplyToToolResult({ type: 'exec-error', reason: 'no-terminal' }).error, /No reply from the Linux Terminal app.*call terminal\.start, then system\.sleep seconds=3 and terminal\.status until the state is running/s);
  assert.match(execReplyToToolResult({ type: 'exec-error', reason: 'timeout', output: '', truncated: false }).error, /time limit/);
});

const { skills, errors: skillErrors } = parseSkills(SKILLS_MD, 'terminal');

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

test('the run-code skill pins the home directory as ~, never the filesystem root', () => {
  // terminal-07 listed /proj-t7 instead of ~/proj-t7.
  const run = skills.find(skill => skill.slug === 'run-code-in-the-linux-guest');
  assert.ok(run.gotchas.includes('/home/user'), 'the home directory is named');
  assert.ok(run.gotchas.includes('never /file'), 'the root is ruled out');
});

test('the run-code skill is findable from the user\'s own task words (A/B: prefetch stays off, 2026-11-25)', () => {
  // "count words" ranked a pdfcraft skill first and "create csv file" / "sed replace" hit no
  // terminal skill: the user's words must be in the keywords.
  const run = skills.find(skill => skill.slug === 'run-code-in-the-linux-guest');
  for (const word of ['word count', 'count words', 'wc', 'grep', 'sed', 'csv', 'directory', 'copy', 'home directory']) assert.ok(run.keywords.includes(word), `keyword ${word}`);
});

test('the run-code skill separates the guest filesystem from Files (lfm3-1.7b terminal-05/07 used the Files tools)', () => {
  const run = skills.find(skill => skill.slug === 'run-code-in-the-linux-guest');
  assert.ok(run.gotchas.includes('not in the guest'), 'the skill says files.write does not reach the guest');
  assert.ok(run.gotchas.includes('terminal.run'), 'the skill routes file work to terminal.run');
});

test('the run-code skill is one terminal.run step (terminal.run starts a stopped guest itself)', () => {
  const run = skills.find(skill => skill.slug === 'run-code-in-the-linux-guest');
  assert.deepEqual(run.steps.map(step => step.tool), ['terminal.run']);
  assert.match(run.gotchas, /starts Linux itself/);
});

test('questions about what Linux has are answered by running a listing command in the guest', () => {
  const list = skills.find(skill => skill.slug === 'list-what-is-installed-in-linux');
  assert.ok(list, 'the list-what-is-installed skill exists');
  assert.deepEqual(list.steps.map(step => step.tool), ['terminal.run']);
  assert.equal(list.steps[0].args.lang, 'sh');
  assert.match(list.steps[0].args.code, /^ls \/bin \/sbin \/usr\/bin \/usr\/sbin$/);
  assert.match(list.gotchas, /not WebPC tools/);
  for (const word of ['installed', 'commands', 'cli', 'network tools']) assert.ok(list.keywords.includes(word), `keyword ${word}`);
});

test('every skill uses numbered steps from the desktop, terminal or system packs', () => {
  for (const skill of skills) {
    skill.steps.forEach((step, i) => {
      assert.equal(step.n, i + 1, `skill ${skill.slug} step numbering`);
      assert.ok(step.tool.startsWith('desktop.') || step.tool.startsWith('terminal.') || step.tool.startsWith('system.'), `skill ${skill.slug} step ${step.n}: ${step.line}`);
    });
  }
});

test('skill steps and tools lines validate against the runtime checkArgs', () => {
  const errors = checkSkills(skills, name => byName(name), { checkArgs: (tool, args) => checkArgs(tool, args, { choices }) });
  assert.deepEqual(errors, []);
});

test('no skill or tool tells the user to save the session', () => {
  for (const tool of tools) {
    assert.ok(!/save the (Linux )?session/i.test(`${tool.purpose} ${tool.when}`), `${tool.name} mentions saving`);
  }
  for (const skill of skills) {
    assert.ok(!/call_tool tool=terminal\.save_session/.test(skill.body), `skill ${skill.slug} calls the retired save tool`);
  }
});
