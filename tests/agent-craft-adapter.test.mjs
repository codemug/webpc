// Unit tests for the shared Craft adapter: agent/shared/craft.js.
// The fake wrapper window nests the craft API on an editor frame's contentWindow, like
// scripts/pc/craft/app.mjs does in the real desktop; sleep is injected to keep polling fast.
// Run: node --test tests/agent-craft-adapter.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { craftApi, METHODS } from '../agent/shared/craft.js';

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

test('METHODS maps gridcraft to the craft-web-api default names', () => {
  assert.deepEqual(METHODS.gridcraft, { request: 'request', execute: 'execute', commands: 'commands', inspect: 'docInspect', screenshot: 'screenshot' });
});
