// Apply one planned entry to the working tree: new pins in catalog.yaml (and package.json /
// package-lock.json or the Alpine lock). Downloads are hashed here, so the recorded sha256 is
// of the exact bytes the builder will verify against.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseDocument, parse } from 'yaml';
import { ROOT } from '../catalog/catalog.mjs';
import { applyToCatalog, alpineLockUpdate } from './plan.mjs';

export async function sha256OfUrl(url) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
  const hash = createHash('sha256');
  for await (const chunk of response.body) hash.update(chunk);
  return hash.digest('hex');
}

const catalogPath = root => join(root, 'catalog.yaml');

/** Fields to write for an entry (network: hashes the new asset). */
export async function fieldsFor(entry, source, { hash = sha256OfUrl } = {}) {
  if (entry.type === 'github-release') {
    const fields = { tag: entry.to, url: entry.url, sha256: await hash(entry.url) };
    if (source.license) fields['license.sha256'] = await hash(`https://raw.githubusercontent.com/${source.repo}/${entry.to}/${source.license.path}`);
    return fields;
  }
  if (entry.type === 'npm-tarball') return { version: entry.to, integrity: entry.integrity };
  if (entry.type === 'cdn-file') return { version: entry.to, sha256: await hash(`https://cdn.jsdelivr.net/npm/${source.package}@${entry.to}/${source.file}`) };
  if (entry.type === 'npm') return { version: entry.to };
  throw new Error(`no catalog fields for ${entry.type}`);
}

/**
 * Apply every auto entry for one app. Returns the repo-relative files it changed.
 * `deps` lets tests replace the network and npm.
 */
export async function applyApp(entries, { root = ROOT, hash = sha256OfUrl, apk, npmInstall = defaultNpmInstall } = {}) {
  const text = readFileSync(catalogPath(root), 'utf8');
  const doc = parseDocument(text);
  const catalog = parse(text);
  const changed = new Set();
  for (const entry of entries) {
    const app = catalog.apps.find(a => a.id === entry.app);
    const source = app.sources[entry.index];
    if (entry.type === 'alpine') {
      const lockFile = join(root, source.lock);
      const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
      const { lock: next } = alpineLockUpdate(lock, await apk(lock.branch, lock.architecture));
      writeFileSync(lockFile, `${JSON.stringify(next, null, 2)}\n`);
      changed.add(source.lock);
      continue;
    }
    applyToCatalog(doc, entry, await fieldsFor(entry, source, { hash }));
    changed.add('catalog.yaml');
    if (entry.type === 'npm') { npmInstall(root, `${source.package}@${entry.to}`); changed.add('package.json').add('package-lock.json'); }
  }
  if (changed.has('catalog.yaml')) writeFileSync(catalogPath(root), doc.toString({ lineWidth: 0 }));
  return [...changed];
}

function defaultNpmInstall(root, spec) {
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', spec], { cwd: root, stdio: 'inherit' });
}
