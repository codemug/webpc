// Model of the verified writers in app.js: a flaky kv that silently drops index writes
// (the field failure: a thread's row keeps its old title and status; not reproducible on
// real IndexedDB). The verify-and-retry pattern must land the committed state. The real
// store logic comes from threads.js; only the write is flaky.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createThreadStore, INDEX_KEY } from '../src/apps/ai-agent/threads.js';

const msg = (role, content) => ({ role, content });

// In-memory kv with idb-keyval's clone-on-read/write semantics. dropNext(n) makes the next n
// index writes resolve without storing anything: the silent loss under test.
function setup() {
  const db = new Map();
  let ts = 1_000_000;
  let n = 0;
  let dropIndex = 0;
  const now = () => ts += 1;
  const kv = {
    get: async key => { const v = db.get(key); return v === undefined ? undefined : structuredClone(v); },
    set: async (key, value) => { if (key === INDEX_KEY && dropIndex > 0) { dropIndex -= 1; return; } db.set(key, structuredClone(value)); },
    del: async key => { db.delete(key); },
  };
  const store = createThreadStore({ kv, now, newId: () => `t${++n}` });
  return { store, now, dropNext: count => { dropIndex = count; } };
}
// Same pattern as app.js's verifiedSave: save, then re-read through list() until the committed
// value is visible (a row with a fresh updatedAt); repeat the write after short delays.
async function verifiedSave(store, id, value, now, retries = [1, 2]) {
  const before = now();
  await store.save(id, value);
  for (const wait of retries) {
    const row = (await store.list()).find(r => r.id === id);
    if (row && row.updatedAt >= before) return;
    await new Promise(resolve => setTimeout(resolve, wait));
    await store.save(id, value);
  }
}
// Same pattern as app.js's verifiedSetStatus: set, then re-read through list() until the
// status is visible; repeat the write after short delays.
async function verifiedSetStatus(store, id, status, retries = [1, 2]) {
  await store.setStatus(id, status);
  for (const wait of retries) {
    const row = (await store.list()).find(r => r.id === id);
    if (row && row.status === status) return;
    await new Promise(resolve => setTimeout(resolve, wait));
    await store.setStatus(id, status);
  }
}

test('a lost row is self-healed by the verify-and-retry save', async () => {
  const { store, now, dropNext } = setup();
  dropNext(2); // create's index write and the first save's index write are silently lost
  const row = await store.create();
  assert.deepEqual(await store.list(), []); // the silent loss: the row is missing from the index
  const value = { history: [msg('user', 'Lost row hello')], summary: '' };
  await verifiedSave(store, row.id, value, now);
  const rows = await store.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, row.id);
  assert.equal(rows[0].title, 'Lost row hello');
  assert.equal(rows[0].status, 'idle');
  assert.deepEqual((await store.load(row.id)).history, [msg('user', 'Lost row hello')]);
});

test('a lost index write leaves a stale row that the retry refreshes', async () => {
  const { store, now, dropNext } = setup();
  const row = await store.create();
  await store.save(row.id, { history: [msg('user', 'First line')], summary: '' });
  const stale = (await store.list())[0].updatedAt;
  dropNext(1); // the next index write is silently lost
  await verifiedSave(store, row.id, { history: [msg('user', 'First line'), msg('assistant', 'answer'), msg('user', 'Second line')], summary: '' }, now);
  const rows = await store.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'First line'); // the title is only derived while it is the default
  assert.ok(rows[0].updatedAt > stale); // the retried write landed; the stale row is gone
  assert.deepEqual((await store.load(row.id)).history, [msg('user', 'First line'), msg('assistant', 'answer'), msg('user', 'Second line')]);
});

test('a lost status write is re-applied by the verify-and-retry status set', async () => {
  const { store, dropNext } = setup();
  const row = await store.create();
  await store.save(row.id, { history: [msg('user', 'hello')], summary: '' });
  dropNext(1); // the setStatus index write is silently lost
  await verifiedSetStatus(store, row.id, 'running');
  const rows = await store.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'running');
});
