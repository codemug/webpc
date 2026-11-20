// Upgrade planning: walk the enabled apps' sources, ask each source type for its newest eligible
// release, and describe what would change. Applying writes the new pins into catalog.yaml
// through the YAML document model, so comments and layout survive.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pickGithubRelease, pickNpmVersion } from './discover.mjs';
import { ROOT } from '../catalog/catalog.mjs';

const EDITABLE = {
  'github-release': ['tag', 'url', 'sha256', 'license.sha256'],
  npm: ['version'],
  'npm-tarball': ['version', 'integrity'],
  'cdn-file': ['version', 'sha256'],
};

/** Every newer release for the enabled apps. Each entry: { app, index, type, name, from, to, auto, ... }. */
export async function planUpgrades(catalog, { now = new Date(), releases, npm, hfHead, apk, readLock = p => JSON.parse(readFileSync(join(ROOT, p), 'utf8')) }) {
  const plan = [];
  for (const app of catalog.apps.filter(a => a.enabled)) {
    for (const [index, source] of (app.sources ?? []).entries()) {
      const base = { app: app.id, index, type: source.type, auto: source.upgrade === 'auto' };
      try {
        plan.push(...await entriesFor(source, base, { now, releases, npm, hfHead, apk, readLock }));
      } catch (error) {
        plan.push({ ...base, name: source.repo ?? source.package ?? source.type, auto: false, error: String(error.message ?? error) });
      }
    }
  }
  return plan;
}

async function entriesFor(source, base, { now, releases, npm, hfHead, apk, readLock }) {
  if (source.type === 'github-release') {
    const pick = pickGithubRelease(await releases(source.repo), source, now);
    return pick ? [{ ...base, name: source.repo, from: source.tag, to: pick.tag, url: pick.url }] : [];
  }
  if (source.type === 'npm' || source.type === 'npm-tarball' || source.type === 'cdn-file') {
    const pick = pickNpmVersion(await npm(source.package), source.version, now);
    const out = [];
    if (pick.version) out.push({ ...base, name: source.package, from: source.version, to: pick.version, ...(source.type === 'npm-tarball' ? { integrity: pick.integrity } : {}) });
    if (pick.newerMajor) out.push({ ...base, name: source.package, from: source.version, to: pick.newerMajor, auto: false, note: 'new major: review and bump by hand' });
    return out;
  }
  if (source.type === 'huggingface') {
    const out = [];
    for (const [repo, sha] of Object.entries(source.models)) {
      const head = await hfHead(repo);
      if (head && head !== sha) out.push({ ...base, name: repo, from: sha, to: head, auto: false, note: 'model revision: review and bump by hand' });
    }
    return out;
  }
  if (source.type === 'alpine') {
    const lock = readLock(source.lock);
    const { changes } = alpineLockUpdate(lock, await apk(lock.branch, lock.architecture));
    return changes.length ? [{ ...base, name: `alpine ${lock.branch} packages`, from: `${changes.length} pinned`, to: changes.map(c => `${c.name} ${c.to}`).join(', '), changes }] : [];
  }
  return [];
}

/** Set the given fields of one source in the parsed catalog document (in place). */
export function applyToCatalog(doc, entry, fields) {
  const apps = doc.get('apps');
  const appIndex = apps.items.findIndex(node => node.get('id') === entry.app);
  if (appIndex === -1) throw new Error(`unknown app "${entry.app}"`);
  for (const [key, value] of Object.entries(fields)) {
    if (!EDITABLE[entry.type]?.includes(key)) throw new Error(`"${key}" is not a field the upgrader edits on ${entry.type} sources`);
    doc.setIn(['apps', appIndex, 'sources', entry.index, ...key.split('.')], value);
  }
  return doc;
}

/** New lock with every package moved to the index's current build. Throws if a package left the index. */
export function alpineLockUpdate(lock, index) {
  const changes = [];
  const packages = lock.packages.map(p => {
    const rec = index.get(p.name);
    if (!rec) throw new Error(`${p.name} is no longer in the ${lock.branch} index`);
    if (rec.version === p.version) return p;
    changes.push({ name: p.name, from: p.version, to: rec.version });
    return { ...p, version: rec.version, origin: rec.origin, license: rec.license, sourceCommit: rec.sourceCommit, url: rec.url };
  });
  return { lock: { ...lock, packages }, changes };
}
