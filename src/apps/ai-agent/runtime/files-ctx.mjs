// ctx.files for Buddy's Files pack: the interface in .lanes files-pack brief, over the Files
// app's OPFS store (src/scripts/pc/files/store.mjs). Paths are Files paths ("/notes/a.txt").
// Every failure rejects with an Error carrying a `code` the pack turns into a teaching error.
const fail = (code, message) => Object.assign(new Error(message), { code });

/** "/a/b/c.txt" -> { dir: 'a/b', name: 'c.txt' }; "/" -> { dir: '', name: '' }. Rejects '..' and empty segments. */
export function splitPath(path) {
  const parts = String(path ?? '/').split('/').filter(Boolean);
  if (parts.some(p => p === '..' || p === '.')) throw fail('invalid_name', `"${path}" may not contain . or .. segments.`);
  const name = parts.pop() ?? '';
  return { dir: parts.join('/'), name };
}
const toPath = (dir, name) => `/${[dir, name].filter(Boolean).join('/')}`;

/** store: the store.mjs module (or a fake with the same functions). broadcast(path): tell other apps a file changed. */
export function createFilesCtx(store, { broadcast = () => {}, maxFind = 500 } = {}) {
  const wrap = async fn => {
    try { return await fn(); } catch (error) {
      if (error?.code) throw error;
      const text = String(error?.message ?? error);
      if (error?.name === 'NotFoundError' || /not found|could not be found/i.test(text)) throw fail('not_found', 'That file or folder does not exist.');
      if (error?.name === 'TypeMismatchError') throw fail('not_a_folder', 'That path is a file, not a folder.');
      if (/already exists/i.test(text)) throw fail('exists', text);
      if (store.validateName && /name|character|long/i.test(text)) throw fail('invalid_name', text);
      throw fail('app_error', text);
    }
  };
  const kindOf = async path => { const { dir, name } = splitPath(path); return name ? store.exists(dir, name) : 'folder'; };
  const api = {
    list: path => wrap(async () => {
      const { dir, name } = splitPath(path); const full = [dir, name].filter(Boolean).join('/');
      if (name && (await store.exists(dir, name)) !== 'folder') throw fail((await store.exists(dir, name)) ? 'not_a_folder' : 'not_found', `${toPath(dir, name)} is not a folder.`);
      return (await store.list(full)).map(e => ({ name: e.name, path: toPath(full, e.name), kind: e.kind, size: e.size ?? null, modified: e.modified ?? null }));
    }),
    stat: path => wrap(async () => {
      const { dir, name } = splitPath(path);
      if (!name) return { name: '', path: '/', kind: 'folder', size: null, modified: null };
      const hit = (await store.list(dir)).find(e => e.name === name);
      if (!hit) throw fail('not_found', `${toPath(dir, name)} does not exist.`);
      return { name, path: toPath(dir, name), kind: hit.kind, size: hit.size ?? null, modified: hit.modified ?? null };
    }),
    readText: (path, { maxChars = 20000 } = {}) => wrap(async () => {
      const { dir, name } = splitPath(path);
      const kind = await store.exists(dir, name);
      if (kind !== 'file') throw fail(kind ? 'not_a_file' : 'not_found', `${toPath(dir, name)} is not a file.`);
      const { data } = await store.read(dir, name);
      const head = new Uint8Array(await data.slice(0, 4096).arrayBuffer());
      if (head.includes(0)) throw fail('not_a_file', `${name} is a binary file; open it in an app instead.`);
      const text = await data.text();
      return { path: toPath(dir, name), text: text.slice(0, maxChars), truncated: text.length > maxChars };
    }),
    writeText: (path, text, { overwrite = false } = {}) => wrap(async () => {
      const { dir, name } = splitPath(path);
      if (!name) throw fail('invalid_name', 'Give a file name.');
      if (dir && (await kindOf(`/${dir}`)) !== 'folder') throw fail('not_found', `The folder /${dir} does not exist; make it first.`);
      const kind = await store.exists(dir, name);
      if (kind === 'folder') throw fail('not_a_file', `${toPath(dir, name)} is a folder.`);
      if (kind === 'file' && !overwrite) throw fail('exists', `${toPath(dir, name)} already exists.`);
      const data = new Blob([String(text)], { type: 'text/plain' });
      await store.write(dir, name, data); broadcast(toPath(dir, name));
      return { path: toPath(dir, name), size: data.size, created: kind !== 'file' };
    }),
    // Binary files for app open/save tools: bytes in, bytes out (Uint8Array), capped at maxBytes.
    readBytes: (path, { maxBytes = 512 * 1024 * 1024 } = {}) => wrap(async () => {
      const { dir, name } = splitPath(path);
      const kind = await store.exists(dir, name);
      if (kind !== 'file') throw fail(kind ? 'not_a_file' : 'not_found', `${toPath(dir, name)} is not a file.`);
      const { data } = await store.read(dir, name);
      if (data.size > maxBytes) throw fail('too_large', `${name} is ${Math.round(data.size / 1048576)} MB; the limit is ${Math.round(maxBytes / 1048576)} MB.`);
      return { path: toPath(dir, name), name, bytes: new Uint8Array(await data.arrayBuffer()), size: data.size };
    }),
    writeBytes: (path, bytes, { overwrite = false, type = 'application/octet-stream' } = {}) => wrap(async () => {
      const { dir, name } = splitPath(path);
      if (!name) throw fail('invalid_name', 'Give a file name.');
      if (dir && (await kindOf(`/${dir}`)) !== 'folder') throw fail('not_found', `The folder /${dir} does not exist; make it first.`);
      const kind = await store.exists(dir, name);
      if (kind === 'folder') throw fail('not_a_file', `${toPath(dir, name)} is a folder.`);
      if (kind === 'file' && !overwrite) throw fail('exists', `${toPath(dir, name)} already exists.`);
      const data = bytes instanceof Blob ? bytes : new Blob([bytes], { type });
      await store.write(dir, name, data); broadcast(toPath(dir, name));
      return { path: toPath(dir, name), size: data.size, created: kind !== 'file' };
    }),
    appendText: (path, text) => wrap(async () => {
      const { dir, name } = splitPath(path);
      const before = (await store.exists(dir, name)) === 'file' ? await (await store.read(dir, name)).data.text() : '';
      const data = new Blob([before + String(text)], { type: 'text/plain' });
      await store.write(dir, name, data); broadcast(toPath(dir, name));
      return { path: toPath(dir, name), size: data.size };
    }),
    mkdir: path => wrap(async () => {
      const parts = String(path ?? '').split('/').filter(Boolean); splitPath(path);
      for (let i = 0; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/'); const kind = await store.exists(dir, parts[i]);
        if (kind === 'file') throw fail('not_a_folder', `/${parts.slice(0, i + 1).join('/')} is a file.`);
        if (!kind) await store.createFolder(dir, parts[i]);
      }
      broadcast(`/${parts.join('/')}`);
      return { path: `/${parts.join('/')}` };
    }),
    rename: (path, to) => wrap(async () => {
      const a = splitPath(path); const b = splitPath(to);
      const kind = await store.exists(a.dir, a.name);
      if (!kind) throw fail('not_found', `${toPath(a.dir, a.name)} does not exist.`);
      if (await store.exists(b.dir, b.name)) throw fail('exists', `${toPath(b.dir, b.name)} already exists.`);
      if (a.dir === b.dir) await store.rename(a.dir, a.name, b.name);
      else {
        if (kind === 'folder') throw fail('not_a_file', 'Moving a folder to another folder is not supported; move its files one by one.');
        const { data } = await store.read(a.dir, a.name); await store.write(b.dir, b.name, data); await store.remove(a.dir, a.name);
      }
      broadcast(toPath(b.dir, b.name));
      return { path: toPath(b.dir, b.name) };
    }),
    remove: (path, { recursive = false } = {}) => wrap(async () => {
      const { dir, name } = splitPath(path);
      if (!name) throw fail('not_allowed', 'The Files root cannot be deleted.');
      const kind = await store.exists(dir, name);
      if (!kind) throw fail('not_found', `${toPath(dir, name)} does not exist.`);
      if (kind === 'folder' && !recursive && (await store.list([dir, name].filter(Boolean).join('/'))).length) throw fail('not_allowed', `${toPath(dir, name)} is not empty; delete it with recursive=true after the user agrees.`);
      await store.remove(dir, name); broadcast(toPath(dir, name));
      return { path: toPath(dir, name), removed: true };
    }),
    find: (query, { under = '/', limit = 20 } = {}) => wrap(async () => {
      const needle = String(query ?? '').toLowerCase(); const hits = []; let seen = 0;
      const queue = [splitPath(under)].map(({ dir, name }) => [dir, name].filter(Boolean).join('/'));
      while (queue.length && hits.length < limit && seen < maxFind) {
        const dir = queue.shift();
        for (const e of await store.list(dir)) {
          seen++; const full = [dir, e.name].filter(Boolean).join('/');
          if (e.name.toLowerCase().includes(needle)) hits.push({ path: `/${full}`, kind: e.kind });
          if (e.kind === 'folder') queue.push(full);
          if (hits.length >= limit || seen >= maxFind) break;
        }
      }
      return hits;
    }),
  };
  return Object.freeze(api);
}
