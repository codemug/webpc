import test from 'node:test';
import assert from 'node:assert/strict';
import { repairCall, WINDOW_VERBS } from '../src/apps/ai-agent/runtime/repair.mjs';
import { checkArgs } from '../src/apps/ai-agent/runtime/args.mjs';

// A catalog as the runtime would pass it: known() over tool names, apps as catalog app ids.
const NAMES = ['files.mkdir', 'desktop.move', 'desktop.set_theme', 'desktop.close', 'desktop.open_app', 'desktop.minimize', 'desktop.maximize', 'desktop.focus', 'desktop.resize', 'desktop.restore', 'gridcraft.set_cells', 'terminal.run'];
const OPTS = { known: name => NAMES.includes(name), apps: ['gridcraft', 'docs', 'terminal'] };

test('signature text is stripped from the tool name (spike fixture)', () => {
  const out = repairCall({ tool: 'files.mkdir(path)', path: 'Reports' }, OPTS);
  assert.equal(out.tool, 'files.mkdir');
  assert.deepEqual(out.args, { path: 'Reports' });
  assert.deepEqual(out.repairs, ['stripped signature text from tool']);
});

test('a signature with parameters keeps its flat args and stays missing-app (spike fixture)', () => {
  const out = repairCall({ tool: 'desktop.move(app, x, y)', x: '100', y: '50' }, OPTS);
  assert.equal(out.tool, 'desktop.move');
  assert.deepEqual(out.args, { x: '100', y: '50' });
  assert.equal('app' in out.args, false, 'app stays missing so validation reports it');
  assert.deepEqual(out.repairs, ['stripped signature text from tool']);
});

test('inline pairs are parsed out of the tool value (spike fixture)', () => {
  const out = repairCall({ tool: 'desktop.tile layout=left-right' }, OPTS);
  assert.equal(out.tool, 'desktop.tile');
  assert.deepEqual(out.args, { layout: 'left-right' });
  assert.deepEqual(out.repairs, ['parsed inline pairs from tool']);
});

test('an app window verb is aliased to the desktop tool (spike fixture)', () => {
  const out = repairCall({ tool: 'docs.close' }, OPTS);
  assert.equal(out.tool, 'desktop.close');
  assert.deepEqual(out.args, { app: 'docs' });
  assert.deepEqual(out.repairs, ['aliased docs.close to desktop.close']);
});

test('a known docs.close (if a pack really defines it) is left alone', () => {
  const out = repairCall({ tool: 'docs.close' }, { ...OPTS, known: name => NAMES.includes(name) || name === 'docs.close' });
  assert.equal(out.tool, 'docs.close');
  assert.deepEqual(out.args, {});
  assert.deepEqual(out.repairs, []);
});

test('terminal.move aliases to desktop.move with the app (spike fixture)', () => {
  const out = repairCall({ tool: 'terminal.move', x: '100', y: '50' }, OPTS);
  assert.equal(out.tool, 'desktop.move');
  assert.equal(out.args.app, 'terminal');
  assert.equal(out.args.x, '100');
});

test('set_theme keeps its explicit argument (spike fixture)', () => {
  const out = repairCall({ tool: 'desktop.set_theme(theme: light|dark)', theme: 'dark' }, OPTS);
  assert.equal(out.tool, 'desktop.set_theme');
  assert.deepEqual(out.args, { theme: 'dark' });
  assert.deepEqual(out.repairs, ['stripped signature text from tool']);
});

test('gridcraft.set_cells passes through untouched and values reach args.mjs (spike fixture)', () => {
  const raw = { tool: 'gridcraft.set_cells', start: 'A1', values: '["Total"]' };
  const out = repairCall(raw, OPTS);
  assert.equal(out.tool, 'gridcraft.set_cells');
  assert.deepEqual(out.repairs, []);
  assert.equal(out.args.values, '["Total"]', 'repair leaves the value for args.mjs');
  const spec = { values: { type: 'list', description: 'Values' }, start: { type: 'string', description: 'Start' } };
  assert.deepEqual(checkArgs({ name: 'gridcraft.set_cells', params: spec, examples: [] }, out.args).args.values, ['Total']);
});

test('Tool, tool_name and name are read as tool when tool is missing', () => {
  for (const [key, text] of [['Tool', 'read tool from Tool'], ['tool_name', 'read tool from tool_name'], ['name', 'read tool from name']]) {
    const out = repairCall({ [key]: 'files.mkdir', path: 'x' }, OPTS);
    assert.equal(out.tool, 'files.mkdir', key);
    assert.deepEqual(out.args, { path: 'x' }, `the source key is not left in args (${key})`);
    assert.deepEqual(out.repairs, [text]);
  }
  const explicit = repairCall({ tool: 'files.mkdir', Tool: 'other' }, OPTS);
  assert.equal(explicit.tool, 'files.mkdir', 'an explicit tool wins over the other casings');
});

test('cloud arguments as an object merge under explicit flat keys', () => {
  const out = repairCall({ tool: 'files.mkdir', arguments: { path: 'Docs', depth: 2 }, path: 'flat' }, OPTS);
  assert.equal(out.args.path, 'flat', 'explicit keys win');
  assert.equal(out.args.depth, 2);
  assert.equal('arguments' in out.args, false);
  assert.equal('tool' in out.args, false);
  assert.ok(out.repairs.includes('merged arguments into args'));
});

test('cloud arguments as a JSON object string merge the same way', () => {
  const out = repairCall({ tool: 'files.mkdir', arguments: '{"path":"Docs","depth":2}' }, OPTS);
  assert.deepEqual(out.args, { path: 'Docs', depth: 2 });
  assert.ok(out.repairs.includes('merged arguments into args'));
  const garbage = repairCall({ tool: 'files.mkdir', arguments: 'not json' }, OPTS);
  assert.deepEqual(garbage.args, {}, 'a non-object arguments string is dropped');
});

test('explicit keys win over inline pairs', () => {
  const out = repairCall({ tool: 'files.mkdir path=inline', path: 'flat' }, OPTS);
  assert.equal(out.args.path, 'flat');
  assert.ok(out.repairs.includes('parsed inline pairs from tool'));
});

test('an unknown app prefix is not aliased and a non-known rewrite is kept', () => {
  const ghost = repairCall({ tool: 'ghost.close' }, { ...OPTS, apps: ['docs'] });
  assert.equal(ghost.tool, 'ghost.close');
  assert.deepEqual(ghost.repairs, []);
  const noDesktop = repairCall({ tool: 'docs.close' }, { ...OPTS, known: name => NAMES.includes(name) && name !== 'desktop.close' });
  assert.equal(noDesktop.tool, 'docs.close');
  assert.equal('app' in noDesktop.args, false);
  assert.deepEqual(noDesktop.repairs, []);
});

test('the function is total and never throws on junk raw shapes', () => {
  for (const raw of [null, undefined, 42, 'files.mkdir', ['tool'], { tool: 123 }, { tool: null }]) {
    const out = repairCall(raw, OPTS);
    assert.deepEqual(out, { tool: '', args: {}, repairs: [] }, `handles ${JSON.stringify(raw)}`);
  }
});

test('case and separators are normalised (Desktop Open-App becomes desktop.open_app)', () => {
  const out = repairCall({ tool: 'Desktop Open-App' }, OPTS);
  assert.equal(out.tool, 'desktop.open_app');
  assert.deepEqual(out.repairs, ['normalised tool name']);
  const slash = repairCall({ tool: 'Files/Mkdir' }, OPTS);
  assert.equal(slash.tool, 'files.mkdir');
});

test('quotes and backticks around the name are stripped with a trailing purpose', () => {
  assert.equal(repairCall({ tool: '`files.mkdir`' }, OPTS).tool, 'files.mkdir');
  assert.equal(repairCall({ tool: '"docs.write - Write a doc"' }, OPTS).tool, 'docs.write');
  assert.equal(repairCall({ tool: "'files.mkdir'" }, OPTS).tool, 'files.mkdir');
  assert.ok(repairCall({ tool: '`files.mkdir`' }, OPTS).repairs.includes('stripped signature text from tool'));
});

test('open-verb aliases land on desktop.open_app and _app/_window forms match', () => {
  const open = repairCall({ tool: 'gridcraft.open' }, OPTS);
  assert.equal(open.tool, 'desktop.open_app');
  assert.equal(open.args.app, 'gridcraft');
  const window = repairCall({ tool: 'docs.close_window' }, OPTS);
  assert.equal(window.tool, 'desktop.close');
  assert.equal(window.args.app, 'docs');
  const appForm = repairCall({ tool: 'terminal.focus_app' }, OPTS);
  assert.equal(appForm.tool, 'desktop.focus');
  assert.equal(appForm.args.app, 'terminal');
  const explicit = repairCall({ tool: 'docs.close', app: 'keep' }, OPTS);
  assert.equal(explicit.args.app, 'keep', 'an explicit app is not overwritten');
});

test('WINDOW_VERBS is the eight window verbs and the verbs option works', () => {
  assert.deepEqual(WINDOW_VERBS, ['open', 'close', 'minimize', 'maximize', 'focus', 'move', 'resize', 'restore']);
  const onlyOpen = repairCall({ tool: 'docs.close' }, { ...OPTS, verbs: ['open'] });
  assert.equal(onlyOpen.tool, 'docs.close', 'a verb outside the list is not aliased');
});
