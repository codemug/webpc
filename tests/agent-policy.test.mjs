// Unit tests for the Buddy M1 safety policy (src/apps/ai-agent/runtime/policy.mjs):
// the effect table on every backend, cloud Files grants (inside, outside, nested, .. escape),
// taint (untrusted tools, unmentioned files.read, mentioned files), the tainted change ask,
// the approvedOnce repeat-approval skip and the capped preview.
// Run: node --test tests/agent-policy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPolicy } from '../src/apps/ai-agent/runtime/policy.mjs';

const GRANT_DENY = 'Grant this folder to Buddy in Settings to use it with a cloud model.';
const TAINT_REASON = 'This chat read web or file content this turn; confirm before changing things.';
const DESTRUCTIVE_REASON = 'This can delete or overwrite data; confirm before running it.';
const EXTERNAL_REASON = 'This reaches outside the PC; confirm before running it.';

const pathParam = { type: 'path', required: true, description: 'A path' };
const makeTool = (name, over = {}) => ({
  name, effect: 'read', purpose: `Purpose of ${name}.`, params: {}, ...over
});
const FILES_READ = makeTool('files.read', { params: { path: pathParam } });
const FILES_WRITE = makeTool('files.write', { effect: 'change', params: { path: pathParam, content: { type: 'text', required: true, description: 'The content' } } });
const FILES_DELETE = makeTool('files.delete', { effect: 'destructive', params: { path: pathParam } });
const FILES_MOVE = makeTool('files.move', { effect: 'change', params: { from: pathParam, to: pathParam } });
const SET_CELLS = makeTool('gridcraft.set_cells', { effect: 'change', params: { start: { type: 'string', required: true, description: 'Top-left cell' }, values: { type: 'table', required: true, description: 'Rows' } } });
const HTTP_GET = makeTool('web.http_get', { effect: 'external', untrusted: true, params: { url: { type: 'string', required: true, description: 'The url' } } });
const OCR = makeTool('vision.ocr', { untrusted: true, params: { path: pathParam } });
const LIST_WINDOWS = makeTool('desktop.list_windows');

const local = createPolicy({ backend: 'local' });
const cloud = createPolicy({ backend: 'cloud', grants: ['/notes', '/work/docs'] });
const chrome = createPolicy({ backend: 'chrome' });
const backends = [local, cloud, chrome];
const turn = () => local.newTurn('summarise the sheet');

test('newTurn gives a fresh untainted state with an approvedOnce Set', () => {
  const t = local.newTurn('hello there');
  assert.equal(t.userText, 'hello there');
  assert.equal(t.tainted, false);
  assert.ok(t.approvedOnce instanceof Set);
  assert.equal(t.approvedOnce.size, 0);
});

test('read allows on every backend, with no reason', () => {
  for (const policy of backends) {
    const r = policy.decide(LIST_WINDOWS, {}, policy.newTurn(''));
    assert.equal(r.action, 'allow', JSON.stringify(r));
    assert.equal(r.reason, undefined);
    assert.ok(r.preview.length > 0);
  }
});

test('destructive always asks on every backend, with the destructive reason', () => {
  for (const policy of backends) {
    const r = policy.decide(FILES_DELETE, { path: '/notes/todo.md' }, policy.newTurn(''));
    assert.equal(r.action, 'ask', JSON.stringify(r));
    assert.equal(r.reason, DESTRUCTIVE_REASON);
  }
});

test('external always asks on every backend, with the external reason', () => {
  for (const policy of backends) {
    const r = policy.decide(HTTP_GET, { url: 'https://example.com' }, policy.newTurn(''));
    assert.equal(r.action, 'ask', JSON.stringify(r));
    assert.equal(r.reason, EXTERNAL_REASON);
  }
});

test('change allows on a clean turn on every backend', () => {
  for (const policy of backends) {
    const r = policy.decide(SET_CELLS, { start: 'A1', values: '42' }, policy.newTurn(''));
    assert.equal(r.action, 'allow', JSON.stringify(r));
  }
});

test('change asks on a tainted turn, with the taint reason', () => {
  const t = turn();
  t.tainted = true;
  const r = local.decide(SET_CELLS, { start: 'A1', values: '42' }, t);
  assert.equal(r.action, 'ask');
  assert.equal(r.reason, TAINT_REASON);
});

test('cloud: a files path inside a grant allows, exactly at the grant root too', () => {
  assert.equal(cloud.decide(FILES_READ, { path: '/notes/todo.md' }, turn()).action, 'allow');
  assert.equal(cloud.decide(FILES_READ, { path: '/work/docs' }, turn()).action, 'allow', 'the grant folder itself counts');
});

test('cloud: a files path outside every grant denies, with the exact reason', () => {
  const r = cloud.decide(FILES_READ, { path: '/etc/passwd' }, turn());
  assert.equal(r.action, 'deny', JSON.stringify(r));
  assert.equal(r.reason, GRANT_DENY);
  assert.ok(r.preview.includes('call_tool tool=files.read path=/etc/passwd'), r.preview);
});

test('cloud: a grant covers nested folders below it', () => {
  assert.equal(cloud.decide(FILES_READ, { path: '/notes/projects/2026/plan.md' }, turn()).action, 'allow');
  assert.equal(cloud.decide(FILES_WRITE, { path: '/notes/draft.md', content: 'x' }, turn()).action, 'allow');
});

test('cloud: a path that escapes with .. (or is relative) is denied', () => {
  assert.equal(cloud.decide(FILES_READ, { path: '/notes/../../etc/passwd' }, turn()).action, 'deny');
  assert.equal(cloud.decide(FILES_READ, { path: 'notes/todo.md' }, turn()).action, 'deny', 'relative paths match no absolute grant');
});

test('cloud: every path argument of a files tool must be inside a grant', () => {
  assert.equal(cloud.decide(FILES_MOVE, { from: '/notes/a.md', to: '/notes/b.md' }, turn()).action, 'allow');
  assert.equal(cloud.decide(FILES_MOVE, { from: '/notes/a.md', to: '/work/other.md' }, turn()).action, 'deny');
  assert.equal(cloud.decide(FILES_MOVE, { from: '/notes/a.md', to: '/notes/../work/b.md' }, turn()).action, 'deny');
});

test('cloud: a files call with no path argument left to check is not a grant denial', () => {
  assert.equal(cloud.decide(FILES_READ, {}, turn()).action, 'allow', 'checkArgs later reports the missing required path');
});

test('local and chrome: files tools need no grant, and effects still apply', () => {
  assert.equal(local.decide(FILES_READ, { path: '/private/hidden.md' }, turn()).action, 'allow');
  assert.equal(chrome.decide(FILES_READ, { path: '/private/hidden.md' }, turn()).action, 'allow');
  assert.equal(local.decide(FILES_DELETE, { path: '/private/hidden.md' }, turn()).action, 'ask');
});

test('noteResult: an untrusted tool taints the turn', () => {
  const t = turn();
  assert.equal(t.tainted, false);
  cloud.noteResult(HTTP_GET, { url: 'https://example.com' }, t);
  assert.equal(t.tainted, true);
  const t2 = turn();
  cloud.noteResult(OCR, { path: '/notes/scan.png' }, t2);
  assert.equal(t2.tainted, true);
});

test('noteResult: files.read taints only when the file name is not in the user text', () => {
  const mentioned = turn();
  mentioned.userText = 'open /notes/todo.md for me';
  cloud.noteResult(FILES_READ, { path: '/notes/todo.md' }, mentioned);
  assert.equal(mentioned.tainted, false, 'the file was mentioned');
  const upper = turn();
  upper.userText = 'please read TODO.MD';
  cloud.noteResult(FILES_READ, { path: '/notes/todo.md' }, upper);
  assert.equal(upper.tainted, false, 'the mention is case-insensitive');
  const unmentioned = turn();
  cloud.noteResult(FILES_READ, { path: '/notes/secret.md' }, unmentioned);
  assert.equal(unmentioned.tainted, true, 'a file the user did not name taints the turn');
});

test('tainted change: asks once, then the approvedOnce skip allows the identical call', () => {
  const t = local.newTurn('fill in the totals');
  local.noteResult(HTTP_GET, { url: 'https://example.com' }, t);
  assert.equal(local.decide(SET_CELLS, { start: 'A1', values: 'Total\n42' }, t).action, 'ask');
  local.noteResult(SET_CELLS, { start: 'A1', values: 'Total\n42' }, t); // the user approved, the tool ran
  assert.equal(local.decide(SET_CELLS, { start: 'A1', values: 'Total\n42' }, t).action, 'allow', 'the identical call is not asked again');
  assert.equal(local.decide(SET_CELLS, { start: 'B1', values: 'Other' }, t).action, 'ask', 'different arguments still ask');
});

test('a change that ran unapproved is not recorded as approved', () => {
  const t = local.newTurn('fill in the totals');
  assert.equal(local.decide(SET_CELLS, { start: 'A1', values: '42' }, t).action, 'allow');
  local.noteResult(SET_CELLS, { start: 'A1', values: '42' }, t); // ran without an approval
  local.noteResult(HTTP_GET, { url: 'https://example.com' }, t); // the taint arrives later
  assert.equal(local.decide(SET_CELLS, { start: 'A1', values: '42' }, t).action, 'ask', 'the late taint still asks');
});

test('destructive approvals skip on the identical call via approvedOnce', () => {
  const t = local.newTurn('clean up');
  assert.equal(local.decide(FILES_DELETE, { path: '/notes/old.md' }, t).action, 'ask');
  local.noteResult(FILES_DELETE, { path: '/notes/old.md' }, t); // approved, ran
  assert.equal(local.decide(FILES_DELETE, { path: '/notes/old.md' }, t).action, 'allow');
  assert.equal(local.decide(FILES_DELETE, { path: '/notes/new.md' }, t).action, 'ask');
});

test('preview: the human line plus the call line, values on one line', () => {
  const r = local.decide(SET_CELLS, { start: 'A1', values: 'x\ny' }, turn());
  assert.equal(r.preview, 'Purpose of gridcraft.set_cells. (change)\ncall_tool tool=gridcraft.set_cells start=A1 values=x\\ny');
});

test('preview: strings over 300 characters are cut to 300', () => {
  const r = local.decide(FILES_WRITE, { path: '/notes/long.md', content: 'z'.repeat(400) }, turn());
  assert.equal(r.preview.length, 300);
  assert.ok(r.preview.startsWith('Purpose of files.write. (change)\ncall_tool tool=files.write'), r.preview.slice(0, 60));
  const short = local.decide(LIST_WINDOWS, {}, turn());
  assert.ok(short.preview.length <= 300);
});

test('decide is deterministic for the same inputs', () => {
  const t1 = cloud.newTurn('x');
  cloud.noteResult(HTTP_GET, { url: 'https://example.com' }, t1);
  const a = local.decide(SET_CELLS, { start: 'A1', values: '1' }, t1);
  const b = local.decide(SET_CELLS, { start: 'A1', values: '1' }, t1);
  assert.deepEqual(b, a);
});
