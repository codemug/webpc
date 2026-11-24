// Unit tests for the Buddy safety policy (src/apps/ai-agent/runtime/policy.mjs):
// every call on every backend allows (M3 removed the approval prompts, taint tracking and
// repeat approvals); the only remaining guardrail is the cloud Files grant rule (inside,
// exactly at the grant root, nested, .. escape, every path arg, no path arg, no grants).
// Run: node --test tests/agent-policy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPolicy } from '../src/apps/ai-agent/runtime/policy.mjs';

const GRANT_DENY = 'Grant this folder to Buddy in Settings to use it with a cloud model.';

const pathParam = { type: 'path', required: true, description: 'A path' };
const makeTool = (name, over = {}) => ({
  name, effect: 'read', purpose: `Purpose of ${name}.`, params: {},
  ...over, params: { ...over.params },
});
const FILES_READ = makeTool('files.read', { params: { path: pathParam } });
const FILES_WRITE = makeTool('files.write', { effect: 'change', params: { path: pathParam, content: { type: 'text', required: true, description: 'The content' } } });
const FILES_DELETE = makeTool('files.delete', { effect: 'destructive', params: { path: pathParam } });
const FILES_MOVE = makeTool('files.move', { effect: 'change', params: { from: pathParam, to: pathParam } });
const SET_CELLS = makeTool('gridcraft.set_cells', { effect: 'change', params: { start: { type: 'string', required: true, description: 'Top-left cell' }, values: { type: 'table', required: true, description: 'Rows' } } });
const HTTP_GET = makeTool('web.http_get', { effect: 'external', untrusted: true, params: { url: { type: 'string', required: true, description: 'The url' } } });
const LIST_WINDOWS = makeTool('desktop.list_windows');

const local = createPolicy({ backend: 'local' });
const cloud = createPolicy({ backend: 'cloud', grants: ['/notes', '/work/docs'] });
const chrome = createPolicy({ backend: 'chrome' });
const backends = [local, cloud, chrome];

test('every effect allows on every backend, with no reason', () => {
  const calls = [
    [LIST_WINDOWS, {}],
    [SET_CELLS, { start: 'A1', values: '42' }],
    [FILES_DELETE, { path: '/notes/todo.md' }],
    [HTTP_GET, { url: 'https://example.com' }],
  ];
  for (const policy of backends) {
    for (const [tool, args] of calls) {
      const r = policy.decide(tool, args);
      assert.equal(r.action, 'allow', JSON.stringify(r));
      assert.equal(r.reason, undefined, JSON.stringify(r));
    }
  }
});

test('local and chrome: files tools need no grant', () => {
  assert.equal(local.decide(FILES_READ, { path: '/private/hidden.md' }).action, 'allow');
  assert.equal(chrome.decide(FILES_READ, { path: '/private/hidden.md' }).action, 'allow');
  assert.equal(local.decide(FILES_DELETE, { path: '/private/hidden.md' }).action, 'allow');
});

test('cloud: a files path inside a grant allows, exactly at the grant root too', () => {
  assert.equal(cloud.decide(FILES_READ, { path: '/notes/todo.md' }).action, 'allow');
  assert.equal(cloud.decide(FILES_READ, { path: '/work/docs' }).action, 'allow', 'the grant folder itself counts');
});

test('cloud: a files path outside every grant denies, with the exact reason', () => {
  const r = cloud.decide(FILES_READ, { path: '/etc/passwd' });
  assert.equal(r.action, 'deny', JSON.stringify(r));
  assert.equal(r.reason, GRANT_DENY);
});

test('cloud: a grant covers nested folders below it', () => {
  assert.equal(cloud.decide(FILES_READ, { path: '/notes/projects/2026/plan.md' }).action, 'allow');
  assert.equal(cloud.decide(FILES_WRITE, { path: '/notes/draft.md', content: 'x' }).action, 'allow');
});

test('cloud: a path that escapes with .. (or is relative) is denied', () => {
  assert.equal(cloud.decide(FILES_READ, { path: '/notes/../../etc/passwd' }).action, 'deny');
  assert.equal(cloud.decide(FILES_READ, { path: 'notes/todo.md' }).action, 'deny', 'relative paths match no absolute grant');
});

test('cloud: every path argument of a files tool must be inside a grant', () => {
  assert.equal(cloud.decide(FILES_MOVE, { from: '/notes/a.md', to: '/notes/b.md' }).action, 'allow');
  assert.equal(cloud.decide(FILES_MOVE, { from: '/notes/a.md', to: '/work/other.md' }).action, 'deny');
  assert.equal(cloud.decide(FILES_MOVE, { from: '/notes/a.md', to: '/notes/../work/b.md' }).action, 'deny');
});

test('cloud: a files call with no path argument left to check is not a grant denial', () => {
  assert.equal(cloud.decide(FILES_READ, {}).action, 'allow', 'checkArgs later reports the missing required path');
});

test('cloud with no grants denies every files path but nothing else', () => {
  const none = createPolicy({ backend: 'cloud' });
  assert.equal(none.decide(FILES_READ, { path: '/notes/todo.md' }).action, 'deny');
  assert.equal(none.decide(SET_CELLS, { start: 'A1', values: '42' }).action, 'allow');
});

test('decide is deterministic for the same inputs', () => {
  const a = cloud.decide(FILES_READ, { path: '/etc/passwd' });
  const b = cloud.decide(FILES_READ, { path: '/etc/passwd' });
  assert.deepEqual(b, a);
});
