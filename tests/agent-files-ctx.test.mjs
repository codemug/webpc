import test from 'node:test';
import assert from 'node:assert/strict';
import { createFilesCtx, splitPath } from '../src/apps/ai-agent/runtime/files-ctx.mjs';

// An in-memory store with the same functions and error messages as store.mjs.
function fakeStore() {
  const root = new Map(); // dir path ('' root) -> Map(name -> { kind, data })
  root.set('', new Map());
  const dir = path => { const d = root.get(path); if (!d) throw Object.assign(new Error('not found'), { name: 'NotFoundError' }); return d; };
  return {
    validateName: name => (/[/\\]/.test(name) ? 'bad name characters' : ''),
    list: async (path = '') => [...dir(path)].map(([name, e]) => ({ name, kind: e.kind, size: e.data?.size, modified: 1 })).sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1)),
    exists: async (path, name) => dir(path).get(name)?.kind ?? null,
    createFolder: async (path, name) => { if (dir(path).has(name)) throw new Error(`"${name}" already exists here.`); dir(path).set(name, { kind: 'folder' }); root.set([path, name].filter(Boolean).join('/'), new Map()); },
    write: async (path, name, data) => { dir(path).set(name, { kind: 'file', data }); },
    read: async (path, name) => { const e = dir(path).get(name); if (!e || e.kind !== 'file') throw Object.assign(new Error('not found'), { name: 'NotFoundError' }); return { name, data: e.data }; },
    rename: async (path, from, to) => { const d = dir(path); if (d.has(to)) throw new Error(`"${to}" already exists here.`); d.set(to, d.get(from)); d.delete(from); },
    remove: async (path, name) => { dir(path).delete(name); root.delete([path, name].filter(Boolean).join('/')); },
  };
}
const setup = () => { const changed = []; return { changed, files: createFilesCtx(fakeStore(), { broadcast: p => changed.push(p) }) }; };
const code = async (promise, expected) => { await assert.rejects(promise, e => e.code === expected); };

test('splitPath splits and rejects dot segments', () => {
  assert.deepEqual(splitPath('/a/b/c.txt'), { dir: 'a/b', name: 'c.txt' });
  assert.deepEqual(splitPath('/'), { dir: '', name: '' });
  assert.throws(() => splitPath('/a/../b'), e => e.code === 'invalid_name');
});

test('write, read, append, overwrite and the exists guard', async () => {
  const { files, changed } = setup();
  assert.equal((await files.writeText('/notes.txt', 'hello')).created, true);
  await code(files.writeText('/notes.txt', 'again'), 'exists');
  await files.appendText('/notes.txt', '\nworld');
  assert.equal((await files.readText('/notes.txt')).text, 'hello\nworld');
  await files.writeText('/notes.txt', 'new', { overwrite: true });
  assert.deepEqual(await files.readText('/notes.txt', { maxChars: 2 }), { path: '/notes.txt', text: 'ne', truncated: true });
  assert.ok(changed.includes('/notes.txt'));
});

test('mkdir makes parents, list shows paths, stat and find work', async () => {
  const { files } = setup();
  await files.mkdir('/Reports/2026');
  await files.writeText('/Reports/2026/march.txt', 'x');
  assert.deepEqual((await files.list('/Reports')).map(e => [e.path, e.kind]), [['/Reports/2026', 'folder']]);
  assert.equal((await files.stat('/Reports/2026/march.txt')).kind, 'file');
  assert.deepEqual(await files.find('MARCH'), [{ path: '/Reports/2026/march.txt', kind: 'file' }]);
  await code(files.writeText('/Missing/a.txt', 'x'), 'not_found');
  await code(files.list('/Reports/2026/march.txt'), 'not_a_folder');
});

test('rename within a folder and across folders; clashes and folder moves refuse', async () => {
  const { files } = setup();
  await files.mkdir('/A'); await files.writeText('/A/one.txt', '1'); await files.writeText('/A/two.txt', '2');
  assert.equal((await files.rename('/A/one.txt', '/A/uno.txt')).path, '/A/uno.txt');
  await code(files.rename('/A/uno.txt', '/A/two.txt'), 'exists');
  await files.mkdir('/B');
  await files.rename('/A/two.txt', '/B/two.txt');
  assert.equal((await files.readText('/B/two.txt')).text, '2');
  await code(files.stat('/A/two.txt'), 'not_found');
  await code(files.rename('/B', '/A/B'), 'not_a_file');
});

test('remove refuses the root and non-empty folders unless recursive', async () => {
  const { files } = setup();
  await files.mkdir('/Old'); await files.writeText('/Old/a.txt', 'a');
  await code(files.remove('/'), 'not_allowed');
  await code(files.remove('/Old'), 'not_allowed');
  assert.equal((await files.remove('/Old', { recursive: true })).removed, true);
  await code(files.remove('/Old'), 'not_found');
});

test('binary files are refused by readText', async () => {
  const { files } = setup();
  const store = fakeStore(); const ctx = createFilesCtx(store);
  await store.write('', 'pic.png', new Blob([new Uint8Array([137, 80, 0, 71])]));
  await code(ctx.readText('/pic.png'), 'not_a_file');
  await code(files.readText('/nope.txt'), 'not_found');
});

test('readBytes and writeBytes round-trip binary files with the exists guard and a size cap', async () => {
  const { files } = setup();
  const bytes = new Uint8Array([0, 1, 2, 250]);
  assert.equal((await files.writeBytes('/pic.bin', bytes)).size, 4);
  await code(files.writeBytes('/pic.bin', bytes), 'exists');
  assert.deepEqual([...(await files.readBytes('/pic.bin')).bytes], [0, 1, 2, 250]);
  await code(files.readBytes('/pic.bin', { maxBytes: 2 }), 'too_large');
  await code(files.readBytes('/nope.bin'), 'not_found');
});
