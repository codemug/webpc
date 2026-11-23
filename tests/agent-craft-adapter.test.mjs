// Unit tests for the shared Craft adapter: agent/shared/craft.js.
// The fake wrapper window nests the craft API on an editor frame's contentWindow, like
// scripts/pc/craft/app.mjs does in the real desktop; sleep is injected to keep polling fast.
// Run: node --test tests/agent-craft-adapter.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { craftApi, METHODS, NO_DOCUMENT, noDoc, noDocResult, teachApp } from '../agent/shared/craft.js';
import { ToolError } from '../src/apps/ai-agent/runtime/args.mjs';

// A fake app-window API recording every call, like window.gridcraft does.
const makeApi = () => {
  const calls = [];
  const rec = (name, make = () => ({})) => (...args) => { calls.push([name, ...args]); return Promise.resolve(make(...args)); };
  return {
    calls,
    request: rec('request', (method, params) => ({ method, params })),
    execute: rec('execute', (command, params) => ({ command, params })),
    commands: rec('commands', () => [{ id: 'cell.set', label: 'Set Cell', menu: 'Home', params: 'cell, input', shortcut: 'F2', enabled: true }]),
    docInspect: rec('docInspect', () => ({ sheets: ['Sheet1'] })),
    screenshot: rec('screenshot', () => ({ data: 'png-base64' })),
  };
};

// A fake wrapper window whose editor frame shows the API after showAfter sleeps
// (showAfter 0: immediately; a large number: never, for the timeout test).
const makeWindow = (api, showAfter = 0) => {
  const sleeps = { count: 0, ms: [] };
  const win = showAfter === 0
    ? { gridcraft: api }
    : { get gridcraft() { return sleeps.count >= showAfter ? api : undefined; } };
  const sleep = ms => { sleeps.count++; sleeps.ms.push(ms); return Promise.resolve(); };
  const wrapper = { document: { getElementById: id => (id === 'editor' ? { contentWindow: win } : null) } };
  return { wrapper, sleep, sleeps };
};

test('finds the API on the editor frame and returns the unified shape', async () => {
  const api = makeApi();
  const { wrapper, sleep } = makeWindow(api);
  const app = await craftApi(wrapper, 'gridcraft', { sleep });
  assert.equal(app.id, 'gridcraft');
  for (const name of ['request', 'execute', 'commands', 'inspect', 'screenshot']) assert.equal(typeof app[name], 'function');
  assert.deepEqual(await app.request('cell.get', { cell: 'A1' }), { method: 'cell.get', params: { cell: 'A1' } });
  assert.deepEqual(await app.execute('cell.set', { cell: 'A2' }), { command: 'cell.set', params: { cell: 'A2' } });
  assert.deepEqual(api.calls, [['request', 'cell.get', { cell: 'A1' }], ['execute', 'cell.set', { cell: 'A2' }]]);
});

test('waits for window.<id>, polling every 100 ms until it appears', async () => {
  const api = makeApi();
  const { wrapper, sleep, sleeps } = makeWindow(api, 2);
  const app = await craftApi(wrapper, 'gridcraft', { sleep });
  assert.equal(sleeps.count, 2);
  assert.deepEqual(sleeps.ms, [100, 100]);
  assert.deepEqual(await app.inspect(), { sheets: ['Sheet1'] });
});

test('rejects with not_available when the API never appears, after the timeout', async () => {
  const { wrapper, sleep, sleeps } = makeWindow(makeApi(), 999999);
  await assert.rejects(craftApi(wrapper, 'gridcraft', { timeoutMs: 300, sleep }), error => {
    assert.equal(error.code, 'not_available');
    assert.match(error.message, /did not finish loading/);
    return true;
  });
  assert.equal(sleeps.count, 2); // 300 ms / 100 ms = 3 polls, 2 waits between them
});

test('rejects with not_available for an app id without a METHODS entry', async () => {
  const { wrapper, sleep } = makeWindow(makeApi());
  await assert.rejects(craftApi(wrapper, 'unknowncraft', { sleep }), error => {
    assert.equal(error.code, 'not_available');
    assert.match(error.message, /no craft method mapping/);
    return true;
  });
});

test('rejects with not_available when the window has no editor frame', async () => {
  const wrapper = { document: { getElementById: () => null } };
  await assert.rejects(craftApi(wrapper, 'gridcraft', { sleep: () => Promise.resolve() }), error => {
    assert.equal(error.code, 'not_available');
    assert.match(error.message, /no editor frame/);
    return true;
  });
});

test('maps app rejections to app_error with the app message, never retrying', async () => {
  const api = makeApi();
  api.execute = (...args) => { api.calls.push(['execute', ...args]); return Promise.reject(new Error('cell out of range')); };
  const { wrapper, sleep } = makeWindow(api);
  const app = await craftApi(wrapper, 'gridcraft', { sleep });
  await assert.rejects(app.execute('cell.set', { cell: 'Z99' }), error => {
    assert.equal(error.code, 'app_error');
    assert.equal(error.message, 'cell out of range');
    return true;
  });
  assert.equal(api.calls.filter(call => call[0] === 'execute').length, 1); // one underlying call, no retry
});

test('a rejection that is not an Error still comes back as app_error with a message', async () => {
  const api = makeApi();
  api.request = () => Promise.reject('boom');
  const { wrapper, sleep } = makeWindow(api);
  const app = await craftApi(wrapper, 'gridcraft', { sleep });
  await assert.rejects(app.request('cell.get', { cell: 'A1' }), error => {
    assert.equal(error.code, 'app_error');
    assert.equal(error.message, 'boom');
    return true;
  });
});

test('defaults params to {} and passes successes through unchanged', async () => {
  const api = makeApi();
  const { wrapper, sleep } = makeWindow(api);
  const app = await craftApi(wrapper, 'gridcraft', { sleep });
  assert.deepEqual(await app.inspect(), { sheets: ['Sheet1'] });
  assert.deepEqual(await app.screenshot(), { data: 'png-base64' });
  assert.deepEqual(api.calls.at(-2), ['docInspect', {}]);
  assert.deepEqual(api.calls.at(-1), ['screenshot', {}]);
});

test('caches commands() per api object', async () => {
  const api = makeApi();
  const { wrapper, sleep } = makeWindow(api);
  const app = await craftApi(wrapper, 'gridcraft', { sleep });
  const first = await app.commands();
  const second = await app.commands();
  assert.deepEqual(second, first);
  assert.equal(api.calls.filter(call => call[0] === 'commands').length, 1);
});

test('a second craftApi object has its own commands cache', async () => {
  const api = makeApi();
  const { wrapper, sleep } = makeWindow(api);
  const one = await craftApi(wrapper, 'gridcraft', { sleep });
  const two = await craftApi(wrapper, 'gridcraft', { sleep });
  await one.commands();
  await two.commands();
  assert.equal(api.calls.filter(call => call[0] === 'commands').length, 2);
});

test('METHODS maps the craft apps to the craft-web-api default names, with the batch 2 exceptions', () => {
  const defaultNames = { request: 'request', execute: 'execute', commands: 'commands', inspect: 'docInspect', screenshot: 'screenshot' };
  for (const id of ['cadcraft', 'deckcraft', 'figcraft', 'gridcraft', 'pdfcraft', 'vectorcraft']) {
    assert.deepEqual(METHODS[id], defaultNames, `${id} entry`);
  }
  // FilmCraft's Methods table has doc_inspect: None, so PageApi installs no docInspect; the
  // page's own uiInspect (ui.inspect) is the inspect. EffectCraft's page installs its own
  // inspect instead of the PageApi pair (vendor index.html).
  for (const [id, inspect] of [['filmcraft', 'uiInspect'], ['effectcraft', 'inspect']]) {
    assert.deepEqual(METHODS[id], { ...defaultNames, inspect }, `${id} entry`);
  }
  assert.equal(METHODS.lightcraft, undefined); // lightcraft.command only: no PageApi surface
});

test('commands() normalises the page reply to a plain array: array, {commands}, object map, empty', async () => {
  const rows = [{ id: 'page.rotate', label: 'Rotate', menu: 'Page', enabled: true }, { id: 'edit.find', label: 'Find', menu: 'Edit', enabled: true }];
  const cases = [
    [rows, ['page.rotate', 'edit.find']], // most apps answer an array
    [{ commands: rows }, ['page.rotate', 'edit.find']], // pdfcraft answers {commands: [...]} (control/host.rs:184)
    [{ 'page.rotate': { label: 'Rotate', enabled: true }, 'edit.find': { label: 'Find', enabled: true } }, ['page.rotate', 'edit.find']], // object map keyed by id
    [null, []], // anything else: empty list
  ];
  for (const [shape, ids] of cases) {
    const api = makeApi();
    api.commands = () => Promise.resolve(shape);
    const { wrapper, sleep } = makeWindow(api);
    const app = await craftApi(wrapper, 'gridcraft', { sleep });
    assert.deepEqual((await app.commands()).map(row => row.id), ids, `shape ${JSON.stringify(shape)}`);
  }
});

test('NO_DOCUMENT matches every app no-document wording, including the live probe messages', () => {
  for (const message of [
    'no drawing open',
    'no open document',
    'no active document',
    'no document open',
    'file.properties is disabled right now',
    'command circle is not available right now: no drawing open', // cadcraft live probe (in-band)
    'command shape.rectangle is not available right now: no document open', // vectorcraft live probe
  ]) {
    assert.ok(NO_DOCUMENT.test(message), message);
  }
  assert.ok(!NO_DOCUMENT.test('cell out of range'));
});

test('noDoc turns the no-document rejection into the teaching ToolError, passes the rest through', async () => {
  const appError = message => Object.assign(new Error(message), { code: 'app_error' });
  for (const message of ['no drawing open', 'no open document', 'no active document', 'no document open', 'file.properties is disabled right now']) {
    await assert.rejects(noDoc(() => Promise.reject(appError(message)), 'No doc open.', 'the-fix'), error => {
      assert.ok(error instanceof ToolError);
      assert.equal(error.type, 'not_available');
      assert.equal(error.message, 'No doc open.');
      assert.equal(error.fix, 'the-fix');
      return true;
    });
  }
  const other = appError('cell out of range');
  await assert.rejects(noDoc(() => Promise.reject(other), 'No doc open.', 'the-fix'), error => error === other); // unchanged
  assert.deepEqual(await noDoc(async () => ({ ok: 1 }), 'No doc open.', 'the-fix'), { ok: 1 });
});

test('noDocResult turns the in-band error field into a ToolError', () => {
  const state = { accept: null, error: 'command circle is not available right now: no drawing open' };
  assert.throws(() => noDocResult(state, 'No doc open.', 'the-fix'), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    assert.equal(error.fix, 'the-fix');
    return true;
  });
  assert.throws(() => noDocResult({ output: [], error: 'bad point' }, 'No doc open.', 'the-fix'), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'app_error');
    assert.equal(error.message, 'bad point');
    return true;
  });
  assert.deepEqual(noDocResult({ accept: null, output: [] }, 'No doc open.', 'the-fix'), { accept: null, output: [] }); // no error field
  assert.equal(noDocResult('plain', 'No doc open.', 'the-fix'), 'plain'); // non-object passes through
});

test('teachApp guards rejection and in-band wording on the unified calls, leaves the rest untouched', async () => {
  const appError = message => Object.assign(new Error(message), { code: 'app_error' });
  const failing = {
    request: () => Promise.resolve({ error: 'no drawing open' }),
    execute: () => Promise.reject(appError('no open document')),
    commands: async () => [{ id: 'a' }],
    inspect: async () => ({}),
  };
  const guarded = teachApp(failing, 'No doc open.', 'the-fix');
  await assert.rejects(guarded.request('cmdline.input', {}), error => error instanceof ToolError && error.type === 'not_available' && error.fix === 'the-fix');
  await assert.rejects(guarded.execute('entities', {}), error => error instanceof ToolError && error.type === 'not_available' && error.message === 'No doc open.');
  assert.deepEqual(await guarded.commands(), [{ id: 'a' }]); // passthrough
  const clean = {
    request: async () => ({ output: [] }),
    execute: async () => ({ ok: 1 }),
    commands: async () => [{ id: 'a' }],
    inspect: async () => ({}),
  };
  const ok = teachApp(clean, 'No doc open.', 'the-fix');
  assert.deepEqual(await ok.request('cmdline.state', {}), { output: [] });
  assert.deepEqual(await ok.execute('entities', {}), { ok: 1 });
  const passthrough = teachApp({ request: () => Promise.reject('timeout'), execute: () => Promise.reject(appError('other')) }, 'No doc open.', 'the-fix');
  await assert.rejects(passthrough.request('x', {}), error => error === 'timeout');
  await assert.rejects(passthrough.execute('x', {}), error => error.code === 'app_error');
});
