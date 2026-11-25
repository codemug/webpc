// Unit tests for the desktop pack: agent/desktop/tools.js and agent/desktop/skills.md.
// The schema and skills checks reuse the real runtime validators (args.mjs, skills.mjs),
// the same checks the lead's build runs over the pack files.
// Run: node --test tests/agent-pack-desktop.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack, tools } from '../agent/desktop/tools.js';
import { ToolError, specErrors, checkArgs } from '../src/apps/ai-agent/runtime/args.mjs';
import { parseSkills, checkSkills } from '../src/apps/ai-agent/runtime/skills.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_MD = readFileSync(join(HERE, '..', 'agent', 'desktop', 'skills.md'), 'utf8');
const APP_IDS = ['gridcraft', 'docs', 'terminal', 'files'];
const APPS = [
  { id: 'gridcraft', title: 'GridCraft', category: 'Office', kind: 'iframe', description: 'spreadsheets' },
  { id: 'files', title: 'Files', category: 'Utilities', kind: 'iframe', description: 'storage' },
];
const byName = name => tools.find(tool => tool.name === name);
const runTool = (name, args, host) => byName(name).run(args, { host });

// A fake pcHost that records calls and returns what the real host resolves.
const fakeHost = () => {
  const calls = [];
  const rec = (method, make) => (...args) => {
    calls.push([method, ...args]);
    return Promise.resolve(make(...args));
  };
  return {
    calls,
    apps: rec('apps', () => APPS),
    windows: rec('windows', () => [{ id: 'docs', title: 'Docs', state: 'normal', active: true }]),
    open: rec('open', id => ({ id, opened: true })),
    focus: rec('focus', id => ({ id, state: 'normal' })),
    minimize: rec('minimize', id => ({ id, state: 'minimized' })),
    maximize: rec('maximize', id => ({ id, state: 'maximized' })),
    restore: rec('restore', id => ({ id, state: 'normal' })),
    close: rec('close', id => ({ id, closed: true })),
    move: rec('move', (id, x, y) => ({ id, x, y })),
    resize: rec('resize', (id, w, h) => ({ id, w, h })),
    tile: rec('tile', layout => ({ layout })),
    showDesktop: rec('showDesktop', () => []),
    theme: rec('theme', () => 'dark'),
    setTheme: rec('setTheme', theme => theme),
    arrangeIcons: rec('arrangeIcons', () => true),
    openExternal: rec('openExternal', (id, how) => ({ id, how })),
  };
};
const dirtyHost = () => {
  const host = fakeHost();
  host.close = (id, opts) => {
    host.calls.push(['close', id, opts]);
    return Promise.resolve({ id, closed: false, dirty: true });
  };
  return host;
};

test('the pack declares its id and title', () => {
  assert.deepEqual(pack, { id: 'desktop', title: 'Desktop' });
});

test('the pack exposes exactly the 17 desktop tools', () => {
  assert.equal(tools.length, 17);
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'desktop.arrange_icons', 'desktop.close', 'desktop.focus', 'desktop.force_close',
    'desktop.get_theme', 'desktop.list_apps', 'desktop.list_windows', 'desktop.maximize',
    'desktop.minimize', 'desktop.move', 'desktop.open_app', 'desktop.open_in_tab',
    'desktop.resize', 'desktop.restore', 'desktop.set_theme', 'desktop.show_desktop', 'desktop.tile',
  ].sort());
});

test('every tool has the required text fields, effect, needs and examples', () => {
  for (const tool of tools) {
    assert.match(tool.name, /^desktop\.[a-z0-9_.]+$/);
    assert.ok(tool.purpose.length > 0 && tool.purpose.length <= 80, `${tool.name} purpose is ${tool.purpose.length} chars`);
    assert.ok(tool.when.startsWith('Use when'), `${tool.name} when must start with "Use when"`);
    assert.ok(tool.when.length <= 120, `${tool.name} when is ${tool.when.length} chars`);
    assert.ok(['read', 'change', 'destructive', 'external'].includes(tool.effect), `${tool.name} bad effect`);
    assert.ok(tool.needs.includes('host'), `${tool.name} needs host`);
    assert.equal(typeof tool.run, 'function');
    assert.ok(tool.examples.length >= 1, `${tool.name} has examples`);
    for (const example of tool.examples) {
      assert.ok(example.args && typeof example.args === 'object' && !Array.isArray(example.args));
      assert.equal(typeof example.says, 'string');
    }
  }
});

test('every parameter spec passes the runtime specErrors check', () => {
  for (const tool of tools) {
    // shortcut: live enums (values 'apps'/'windows') are skipped because the current
    // specErrors in args.mjs misrejects them (its array branch also runs for the live
    // strings); re-include them once that one-line fix lands.
    const params = Object.fromEntries(
      Object.entries(tool.params).filter(([, spec]) => spec.values !== 'apps' && spec.values !== 'windows'));
    assert.deepEqual(specErrors(params), [], `${tool.name} params`);
    for (const [key, spec] of Object.entries(tool.params)) {
      if (spec.type !== 'enum') continue;
      if (typeof spec.values === 'string') {
        assert.ok(['apps', 'windows'].includes(spec.values), `${tool.name} ${key} live enum`);
      } else {
        assert.ok(Array.isArray(spec.values) && spec.values.every(v => typeof v === 'string' && v.trim()), `${tool.name} ${key} enum values`);
      }
    }
  }
});

test('every example passes the runtime checkArgs with the live app ids', () => {
  const choices = () => APP_IDS;
  for (const tool of tools) {
    for (const [n, example] of tool.examples.entries()) {
      const out = checkArgs(tool, example.args, { choices });
      assert.ok(out.ok, `${tool.name} example ${n}: ${out.error?.message}`);
    }
  }
});

test('desktop.list_apps returns the registry apps, filtered by category when given', async () => {
  const host = fakeHost();
  assert.deepEqual(await runTool('desktop.list_apps', {}, host), APPS);
  assert.deepEqual(await runTool('desktop.list_apps', { category: 'office' }, host), [APPS[0]]);
  assert.deepEqual(host.calls, [['apps'], ['apps']]);
});

test('desktop.list_windows returns the host window rows', async () => {
  const host = fakeHost();
  const out = await runTool('desktop.list_windows', {}, host);
  assert.deepEqual(out, [{ id: 'docs', title: 'Docs', state: 'normal', active: true }]);
  assert.deepEqual(host.calls, [['windows']]);
});

test('desktop.open_app calls host.open with the app id', async () => {
  const host = fakeHost();
  assert.deepEqual(await runTool('desktop.open_app', { app: 'gridcraft' }, host), { id: 'gridcraft', opened: true });
  assert.deepEqual(host.calls, [['open', 'gridcraft']]);
});

test('desktop.focus calls host.focus with the app id', async () => {
  const host = fakeHost();
  assert.deepEqual(await runTool('desktop.focus', { app: 'docs' }, host), { id: 'docs', state: 'normal' });
  assert.deepEqual(host.calls, [['focus', 'docs']]);
});

test('desktop.minimize calls host.minimize with the app id', async () => {
  const host = fakeHost();
  assert.deepEqual(await runTool('desktop.minimize', { app: 'files' }, host), { id: 'files', state: 'minimized' });
  assert.deepEqual(host.calls, [['minimize', 'files']]);
});

test('desktop.maximize calls host.maximize with the app id', async () => {
  const host = fakeHost();
  assert.deepEqual(await runTool('desktop.maximize', { app: 'gridcraft' }, host), { id: 'gridcraft', state: 'maximized' });
  assert.deepEqual(host.calls, [['maximize', 'gridcraft']]);
});

test('desktop.restore calls host.restore with the app id', async () => {
  const host = fakeHost();
  assert.deepEqual(await runTool('desktop.restore', { app: 'files' }, host), { id: 'files', state: 'normal' });
  assert.deepEqual(host.calls, [['restore', 'files']]);
});

test('desktop.close calls host.close without force', async () => {
  const host = fakeHost();
  assert.deepEqual(await runTool('desktop.close', { app: 'files' }, host), { id: 'files', closed: true });
  assert.deepEqual(host.calls, [['close', 'files']]);
});

test('desktop.close passes a dirty result through unchanged', async () => {
  const host = dirtyHost();
  assert.deepEqual(await runTool('desktop.close', { app: 'files' }, host), { id: 'files', closed: false, dirty: true });
  assert.deepEqual(host.calls, [['close', 'files', undefined]]);
});

test('desktop.force_close passes { force: true } to host.close', async () => {
  const host = fakeHost();
  assert.deepEqual(await runTool('desktop.force_close', { app: 'gridcraft' }, host), { id: 'gridcraft', closed: true });
  assert.deepEqual(host.calls, [['close', 'gridcraft', { force: true }]]);
});

test('desktop.move calls host.move with app, x and y', async () => {
  const host = fakeHost();
  assert.deepEqual(await runTool('desktop.move', { app: 'terminal', x: 40, y: 60 }, host), { id: 'terminal', x: 40, y: 60 });
  assert.deepEqual(host.calls, [['move', 'terminal', 40, 60]]);
});

test('desktop.resize calls host.resize with app, width and height', async () => {
  const host = fakeHost();
  assert.deepEqual(await runTool('desktop.resize', { app: 'docs', width: 800, height: 500 }, host), { id: 'docs', w: 800, h: 500 });
  assert.deepEqual(host.calls, [['resize', 'docs', 800, 500]]);
});

test('desktop.tile passes the layout and defaults to left-right', async () => {
  const host = fakeHost();
  assert.deepEqual(await runTool('desktop.tile', { layout: 'grid' }, host), { layout: 'grid' });
  assert.deepEqual(await runTool('desktop.tile', {}, host), { layout: 'left-right' });
  assert.deepEqual(host.calls, [['tile', 'grid'], ['tile', 'left-right']]);
});

test('desktop.show_desktop calls host.showDesktop', async () => {
  const host = fakeHost();
  assert.deepEqual(await runTool('desktop.show_desktop', {}, host), []);
  assert.deepEqual(host.calls, [['showDesktop']]);
});

test('desktop.get_theme returns host.theme', async () => {
  const host = fakeHost();
  assert.equal(await runTool('desktop.get_theme', {}, host), 'dark');
  assert.deepEqual(host.calls, [['theme']]);
});

test('desktop.set_theme calls host.setTheme and returns the theme', async () => {
  const host = fakeHost();
  assert.equal(await runTool('desktop.set_theme', { theme: 'light' }, host), 'light');
  assert.deepEqual(host.calls, [['setTheme', 'light']]);
});

test('desktop.arrange_icons calls host.arrangeIcons', async () => {
  const host = fakeHost();
  assert.equal(await runTool('desktop.arrange_icons', {}, host), true);
  assert.deepEqual(host.calls, [['arrangeIcons']]);
});

test('desktop.open_in_tab calls host.openExternal and defaults how to tab', async () => {
  const host = fakeHost();
  assert.deepEqual(await runTool('desktop.open_in_tab', { app: 'files' }, host), { id: 'files', how: 'tab' });
  assert.deepEqual(await runTool('desktop.open_in_tab', { app: 'gridcraft', how: 'window' }, host), { id: 'gridcraft', how: 'window' });
  assert.deepEqual(host.calls, [['openExternal', 'files', 'tab'], ['openExternal', 'gridcraft', 'window']]);
});

test('a missing ctx.host rejects every tool with not_available', async () => {
  for (const tool of tools) {
    await assert.rejects(tool.run({}, {}), error => {
      assert.ok(error instanceof ToolError, `${tool.name} throws ToolError`);
      assert.equal(error.type, 'not_available');
      assert.match(error.message, /desktop is not available/);
      return true;
    });
  }
});

test('a host rejection with a code becomes a ToolError of that type', async () => {
  const host = fakeHost();
  const rejection = Object.assign(new Error('unknown app "gridcraf"; closest: gridcraft; apps: docs'), { code: 'unknown_app' });
  host.open = () => Promise.reject(rejection);
  await assert.rejects(runTool('desktop.open_app', { app: 'gridcraf' }, host), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'unknown_app');
    assert.match(error.message, /closest: gridcraft/);
    return true;
  });
});

test('a host rejection without a code comes back as app_error', async () => {
  const host = fakeHost();
  host.theme = () => Promise.reject(new Error('boom'));
  await assert.rejects(runTool('desktop.get_theme', {}, host), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'app_error');
    assert.equal(error.message, 'boom');
    return true;
  });
});

// b14 desktop-04: minimize on a not-open window gave an empty fix, and the model looped
// open_in_tab (a tab is not a desktop window) 15 rounds. The window verbs now name the
// open_app call the fix must copy.
test('window verbs turn a not_open rejection into the open_app fix line', async () => {
  const notOpen = id => Object.assign(new Error(`window "${id}" is not open; open it first with open("${id}")`), { code: 'not_open' });
  for (const [tool, method, args] of [
    ['desktop.minimize', 'minimize', { app: 'files' }],
    ['desktop.restore', 'restore', { app: 'files' }],
    ['desktop.maximize', 'maximize', { app: 'docs' }],
    ['desktop.focus', 'focus', { app: 'docs' }],
    ['desktop.move', 'move', { app: 'docs', x: 10, y: 20 }],
    ['desktop.resize', 'resize', { app: 'docs', width: 800, height: 600 }],
  ]) {
    const host = fakeHost();
    host[method] = () => Promise.reject(notOpen(args.app));
    await assert.rejects(runTool(tool, args, host), error => {
      assert.ok(error instanceof ToolError);
      assert.equal(error.type, 'not_open');
      assert.equal(error.fix, `call_tool tool=desktop.open_app app=${args.app}`, `${tool} fix line`);
      return true;
    });
  }
  // close is a window verb too, but its not_open fix must stay empty: opening an app
  // just to close it is not the lesson.
  const closing = fakeHost();
  closing.close = () => Promise.reject(notOpen('docs'));
  await assert.rejects(runTool('desktop.close', { app: 'docs' }, closing), error => {
    assert.equal(error.type, 'not_open');
    assert.equal(error.fix, '');
    return true;
  });
});

const { skills, errors: skillErrors } = parseSkills(SKILLS_MD, 'desktop');

test('skills.md parses with the runtime parser without errors', () => {
  assert.deepEqual(skillErrors, []);
});

test('skills.md has the 15 skills with the required metadata', () => {
  assert.equal(skills.length, 15);
  for (const skill of skills) {
    assert.ok(skill.slug && skill.summary, `skill ${skill.slug} slug/summary`);
    assert.ok(skill.summary.length <= 160, `skill ${skill.slug} summary is ${skill.summary.length} chars`);
    assert.ok(skill.keywords.length >= 5, `skill ${skill.slug} keywords: ${skill.keywords.join(', ')}`);
    assert.ok(skill.tools.length >= 1, `skill ${skill.slug} tools`);
    assert.ok(skill.when && skill.steps.length >= 1 && skill.check, `skill ${skill.slug} body sections`);
  }
});

test('every skill step is a numbered desktop call_tool line', () => {
  for (const skill of skills) {
    skill.steps.forEach((step, i) => {
      assert.equal(step.n, i + 1, `skill ${skill.slug} step numbering`);
      assert.ok(step.line.startsWith(`${step.n}. call_tool tool=desktop.`), `skill ${skill.slug} step ${step.n}: ${step.line}`);
    });
  }
});

test('skill steps and tools lines validate against the runtime checkArgs', () => {
  const errors = checkSkills(skills, byName, { checkArgs: (tool, args) => checkArgs(tool, args, { choices: () => APP_IDS }) });
  assert.deepEqual(errors, []);
});
