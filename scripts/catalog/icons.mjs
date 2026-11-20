// Build step (after the app preparers): put each enabled app's upstream icon at
// public/pc/icons/<id><ext>. Downloads are verified against their pinned SHA-256 and cached;
// `from: release` icons are copied out of the app's already-verified prepared release.
// Icons of apps that lost their icon or are disabled are removed.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog, iconSource, iconUrl, ROOT } from './catalog.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** @returns {Promise<string[]>} the icon files written, repo-relative. */
export async function buildIcons(root, catalog, { fetchBytes = download } = {}) {
  const out = join(root, 'public/pc/icons'), cache = join(root, 'node_modules/.cache/webpc/icons');
  await mkdir(out, { recursive: true }); await mkdir(cache, { recursive: true });
  const wanted = new Map();
  for (const app of catalog.apps.filter(a => a.enabled && a.icon)) {
    const target = iconUrl(app).replace('/pc/icons/', ''), source = iconSource(app);
    if (source.release) {
      const from = join(root, 'public/pc/vendor', app.id, source.release);
      await copyFile(from, join(out, target)).catch(() => { throw new Error(`${app.id}: icon ${source.release} is not in the prepared release; check catalog.yaml`); });
    } else {
      const cached = join(cache, `${source.sha256}${target.slice(target.lastIndexOf('.'))}`);
      let bytes = await readFile(cached).catch(() => null);
      if (!bytes || sha256(bytes) !== source.sha256) {
        bytes = await fetchBytes(source.download);
        if (sha256(bytes) !== source.sha256) throw new Error(`${app.id}: icon checksum mismatch for ${source.download}`);
        await writeFile(cached, bytes);
      }
      await writeFile(join(out, target), bytes);
    }
    wanted.set(target, app.id);
  }
  for (const name of await readdir(out)) if (!wanted.has(name)) await rm(join(out, name), { force: true });
  return [...wanted.keys()].map(name => `public/pc/icons/${name}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const written = await buildIcons(ROOT, loadCatalog());
  console.log(`icons: ${written.length} upstream app icons in public/pc/icons/.`);
}
