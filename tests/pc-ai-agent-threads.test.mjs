import test from 'node:test';
import assert from 'node:assert/strict';
import { createThreadStore, threadKey, INDEX_KEY, MIGRATED_KEY, MAX_THREADS, TITLE_MAX, STATUSES, ThreadLimitError, titleFrom } from '../src/apps/ai-agent/threads.js';
import { STORE_KEY, BACKUP_KEY } from '../src/apps/ai-agent/storage.js';

// In-memory kv with idb-keyval's clone-on-read/write semantics.
function setup({ slow = false } = {}) {
  const db = new Map();
  let ts = 1_000_000;
  let n = 0;
  const delay = () => new Promise(resolve => setTimeout(resolve, 0));
  const kv = {
    get: async key => { if (slow) await delay(); const v = db.get(key); return v === undefined ? undefined : structuredClone(v); },
    set: async (key, value) => { if (slow) await delay(); db.set(key, structuredClone(value)); },
    del: async key => { if (slow) await delay(); db.delete(key); },
  };
  const store = createThreadStore({ kv, now: () => ts += 1, newId: () => `t${++n}` });
  return { db, kv, store };
}
const msg = (role, content) => ({ role, content });

test('create makes idle threads and list orders them newest first', async () => {
  const { db, store } = setup();
  const a = await store.create({ title: 'First' });
  const b = await store.create({ title: 'Second', backend: 'cloud' });
  const c = await store.create({});
  assert.equal(a.id, 't1');
  assert.equal(a.status, 'idle');
  assert.equal(a.backend, undefined);
  assert.equal(b.backend, 'cloud');
  assert.equal(c.title, 'New chat');
  assert.deepEqual((await store.list()).map(r => r.id), [c.id, b.id, a.id]);
  assert.deepEqual(db.get(threadKey(a.id)), { history: [], summary: '', revision: 0 });
});

test('save and load round trip and bump the revision', async () => {
  const { store } = setup();
  const row = await store.create();
  assert.equal((await store.load(row.id)).revision, 0);
  const first = [msg('user', 'question'), msg('assistant', 'answer')];
  const saved = await store.save(row.id, { history: first, summary: 'S' });
  assert.equal(saved.revision, 1);
  await store.save(row.id, { history: [...first, msg('user', 'more')], summary: 'S2' });
  const loaded = await store.load(row.id);
  assert.deepEqual(loaded, { id: row.id, history: [...first, msg('user', 'more')], summary: 'S2', revision: 2 });
});

test('save reorders by updatedAt and derives the title while it is still the default', async () => {
  const { store } = setup();
  const a = await store.create();
  const b = await store.create();
  assert.deepEqual((await store.list()).map(r => r.id), [b.id, a.id]);
  await store.save(a.id, { history: [msg('user', '  Hello   world\nagain')], summary: '' });
  const rows = await store.list();
  assert.deepEqual(rows.map(r => r.id), [a.id, b.id]);
  assert.equal(rows[0].title, 'Hello world again');
});

test('titleFrom collapses whitespace, cuts long titles and falls back to New chat', () => {
  assert.equal(titleFrom([]), 'New chat');
  assert.equal(titleFrom(undefined), 'New chat');
  assert.equal(titleFrom([msg('assistant', 'no user yet')]), 'New chat');
  assert.equal(titleFrom([msg('user', '   \n  ')]), 'New chat');
  assert.equal(titleFrom([msg('user', '  a\tb\nc  ')]), 'a b c');
  const cut = titleFrom([msg('user', 'w'.repeat(TITLE_MAX + 20))]);
  assert.equal(cut.length, TITLE_MAX);
  assert.ok(cut.endsWith('...'));
  assert.equal(titleFrom([msg('user', 'x'.repeat(TITLE_MAX))]).length, TITLE_MAX);
});

test('rename trims and caps, rejects empty, control and bidi titles', async () => {
  const { store } = setup();
  const row = await store.create();
  await store.rename(row.id, '  Padded  ');
  assert.equal((await store.list())[0].title, 'Padded');
  const renamed = await store.rename(row.id, 'x'.repeat(TITLE_MAX + 5));
  assert.equal(renamed.title.length, TITLE_MAX);
  assert.ok(renamed.title.endsWith('...'));
  await assert.rejects(store.rename(row.id, '   '), /empty/);
  await assert.rejects(store.rename(row.id, 'bad\u0007'), /disallowed/);
  await assert.rejects(store.rename(row.id, 'bidi\u202Eend'), /disallowed/);
  await assert.rejects(store.rename('nope', 'x'), /Unknown thread/);
  await store.save(row.id, { history: [msg('user', 'new words')], summary: '' });
  assert.equal((await store.list())[0].title, 'x'.repeat(TITLE_MAX - 3) + '...', 'a renamed title survives a save');
});

test('setStatus accepts the seven statuses and rejects the rest', async () => {
  const { store } = setup();
  const row = await store.create();
  for (const status of STATUSES) assert.equal((await store.setStatus(row.id, status)).status, status);
  assert.equal((await store.list())[0].status, 'interrupted');
  await assert.rejects(store.setStatus(row.id, 'bogus'), /Invalid thread status/);
  await assert.rejects(store.setStatus('nope', 'idle'), /Unknown thread/);
});

test('remove deletes the record and the row and is idempotent', async () => {
  const { db, store } = setup();
  const a = await store.create();
  await store.create();
  await store.remove(a.id);
  assert.equal(db.has(threadKey(a.id)), false);
  assert.equal((await store.list()).length, 1);
  await store.remove(a.id);
  await store.remove('ghost');
  assert.equal((await store.list()).length, 1);
});

test('markInterrupted flips only active threads and is a no-op twice', async () => {
  const { store } = setup();
  const r1 = await store.create();
  await store.setStatus(r1.id, 'running');
  const r2 = await store.create();
  await store.setStatus(r2.id, 'waiting');
  const r3 = await store.create();
  await store.setStatus(r3.id, 'needs_you');
  const r4 = await store.create();
  await store.setStatus(r4.id, 'done');
  assert.equal(await store.markInterrupted(), 3);
  const rows = await store.list();
  for (const id of [r1.id, r2.id, r3.id]) assert.equal(rows.find(r => r.id === id).status, 'interrupted');
  assert.equal(rows.find(r => r.id === r4.id).status, 'done');
  assert.equal(await store.markInterrupted(), 0);
});

test('create stops at MAX_THREADS and remove frees a slot', async () => {
  const { store } = setup();
  for (let i = 0; i < MAX_THREADS; i += 1) await store.create();
  await assert.rejects(store.create(), ThreadLimitError);
  assert.equal((await store.list()).length, MAX_THREADS);
  await store.remove((await store.list()).at(-1).id);
  await store.create();
  assert.equal((await store.list()).length, MAX_THREADS);
});

test('corrupt and malformed index data is skipped, never thrown, and rebuilt on write', async () => {
  const { db, store } = setup();
  const row = await store.create({ title: 'Good' });
  db.set(INDEX_KEY, [{ ...row }, { broken: 1 }, null]);
  assert.deepEqual((await store.list()).map(r => r.id), [row.id]);
  db.set(INDEX_KEY, 'garbage');
  assert.deepEqual(await store.list(), []);
  const revived = await store.create({ title: 'After' });
  assert.deepEqual((await store.list()).map(r => r.id), [revived.id], 'the next write rebuilds the index');
});

test('a row without a record is not listed, loads as null and self-heals on save', async () => {
  const { db, store } = setup();
  const row = await store.create();
  db.delete(threadKey(row.id));
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.load(row.id), null);
  await store.save(row.id, { history: [msg('user', 'back again')], summary: '' });
  const healed = (await store.list())[0];
  assert.equal(healed.id, row.id);
  assert.equal(healed.title, 'back again');
  assert.equal(healed.status, 'idle');
});

test('migration copies both legacy records into threads', async () => {
  const { db, kv, store } = setup();
  const current = { version: 1, history: [msg('user', 'the current words'), msg('assistant', 'reply')], summary: 'cur', savedAt: 5 };
  const previous = { version: 1, history: [msg('user', 'the old words')], summary: 'prev', savedAt: 4 };
  db.set(STORE_KEY, current);
  db.set(BACKUP_KEY, previous);
  assert.equal(await store.migrateLegacy({ current: await kv.get(STORE_KEY), previous: await kv.get(BACKUP_KEY) }), 2);
  const rows = await store.list();
  assert.equal(rows[0].title, 'the current words', 'the current chat is newest');
  assert.equal(rows[1].title, 'Previous chat');
  assert.deepEqual(await store.load(rows[0].id), { id: rows[0].id, history: current.history, summary: 'cur', revision: 0 });
  assert.deepEqual(await store.load(rows[1].id), { id: rows[1].id, history: previous.history, summary: 'prev', revision: 0 });
});

test('migration is idempotent and leaves the legacy keys untouched', async () => {
  const { db, store } = setup();
  const current = { version: 1, history: [msg('user', 'keep me')], summary: '', savedAt: 5 };
  const previous = { version: 1, history: [msg('user', 'older')], summary: '', savedAt: 4 };
  db.set(STORE_KEY, current);
  db.set(BACKUP_KEY, previous);
  assert.equal(await store.migrateLegacy({ current, previous }), 2);
  assert.equal(await store.migrateLegacy({ current, previous }), 0, 'the second call does nothing');
  assert.equal((await store.list()).length, 2);
  assert.deepEqual(db.get(STORE_KEY), current);
  assert.deepEqual(db.get(BACKUP_KEY), previous);
});

test('migration with no records sets the flag and blocks later records', async () => {
  const { db, store } = setup();
  assert.equal(await store.migrateLegacy({}), 0);
  assert.deepEqual(await store.list(), []);
  assert.equal(db.get(MIGRATED_KEY), true);
  assert.equal(await store.migrateLegacy({ current: { history: [msg('user', 'late')], summary: '' } }), 0);
});

test('save rejects histories that validateConversation rejects', async () => {
  const { store } = setup();
  const row = await store.create();
  await store.save(row.id, { history: [msg('user', 'ok')], summary: '' });
  await assert.rejects(store.save(row.id, { history: 'nope', summary: '' }), /not a valid Buddy conversation/);
  await assert.rejects(store.save(row.id, { history: [msg('hacker', 'x')], summary: '' }), /invalid message/);
  const loaded = await store.load(row.id);
  assert.equal(loaded.revision, 1);
  assert.deepEqual(loaded.history, [msg('user', 'ok')]);
});

test('a second store over the same kv sees the same threads', async () => {
  const { kv } = setup();
  const first = createThreadStore({ kv, now: () => 1, newId: () => 'a1' });
  await first.create({ title: 'Shared' });
  const second = createThreadStore({ kv, now: () => 2, newId: () => 'b1' });
  assert.deepEqual((await second.list()).map(r => [r.id, r.title]), [['a1', 'Shared']]);
  assert.equal((await second.load('a1')).revision, 0);
  const row = await second.create({ title: 'From B' });
  assert.equal(row.id, 'b1');
  assert.equal((await first.list()).length, 2);
});

test('concurrent saves and status changes do not drop row updates', async () => {
  const { store } = setup({ slow: true });
  const rows = [];
  for (let i = 0; i < 5; i += 1) rows.push(await store.create());
  await Promise.all(rows.map((row, i) => Promise.all([
    store.save(row.id, { history: [msg('user', `first words ${i}`)], summary: '' }),
    store.setStatus(row.id, 'running'),
  ])));
  const listed = await store.list();
  assert.equal(listed.length, 5);
  for (let i = 0; i < rows.length; i += 1) {
    const found = listed.find(r => r.id === rows[i].id);
    assert.equal(found.title, `first words ${i}`, `thread ${i} keeps its derived title`);
    assert.equal(found.status, 'running', `thread ${i} keeps its status`);
  }
});

test('a rejected operation does not block the following operations', async () => {
  const { store } = setup();
  const row = await store.create();
  const rejected = assert.rejects(store.rename(row.id, ''), /empty/);
  await store.save(row.id, { history: [msg('user', 'after the rejection')], summary: '' });
  await rejected;
  const listed = (await store.list())[0];
  assert.equal(listed.title, 'after the rejection');
  assert.equal(listed.status, 'idle');
});
