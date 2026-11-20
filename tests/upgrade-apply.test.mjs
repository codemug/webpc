import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { applyApp, fieldsFor } from '../scripts/upgrade/apply.mjs';

const repo = new URL('..', import.meta.url).pathname;
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'webpc-apply-'));
  copyFileSync(join(repo, 'catalog.yaml'), join(root, 'catalog.yaml'));
  mkdirSync(join(root, 'scripts/pc/linux'), { recursive: true });
  copyFileSync(join(repo, 'scripts/pc/linux/packages.lock.json'), join(root, 'scripts/pc/linux/packages.lock.json'));
  return root;
}
const hashes = [];
const hash = async url => { hashes.push(url); return 'f'.repeat(64); };

test('github release: tag, url and the hash of the exact new asset are written; nothing else changes', async () => {
  const root = sandbox();
  const before = readFileSync(join(root, 'catalog.yaml'), 'utf8');
  const url = 'https://github.com/storytold/gridcraft/releases/download/v0.20.0/gridcraft-web-0.20.0.zip';
  hashes.length = 0;
  const changed = await applyApp([{ app: 'gridcraft', index: 0, type: 'github-release', from: 'v0.19.1', to: 'v0.20.0', url }], { root, hash });
  assert.deepEqual(changed, ['catalog.yaml']);
  const after = readFileSync(join(root, 'catalog.yaml'), 'utf8');
  const app = parse(after).apps.find(a => a.id === 'gridcraft'), source = app.sources[0];
  assert.deepEqual(hashes, [url, `https://raw.githubusercontent.com/storytold/gridcraft/v0.20.0/${app.icon.path}`]);
  assert.deepEqual([source.tag, source.url, source.sha256], ['v0.20.0', url, 'f'.repeat(64)]);
  // tag, url and sha256 of the release, plus the icon's sha256 at the new tag; nothing else.
  assert.deepEqual(after.split('\n').filter((l, i) => l !== before.split('\n')[i]).map(l => l.trim().split(':')[0]), ['sha256', 'tag', 'url', 'sha256']);
});

test('github release with a pinned licence file: the licence at the new tag is hashed too', async () => {
  const beepbox = parse(readFileSync(join(repo, 'catalog.yaml'), 'utf8')).apps.find(a => a.id === 'beepbox').sources[0];
  hashes.length = 0;
  const fields = await fieldsFor({ type: 'github-release', to: 'v4.3.0', url: 'https://github.com/johnnesky/beepbox/releases/download/v4.3.0/BeepBox_4_3_0.zip' }, beepbox, { hash });
  assert.deepEqual(Object.keys(fields), ['tag', 'url', 'sha256', 'license.sha256']);
  assert.equal(hashes[1], 'https://raw.githubusercontent.com/johnnesky/beepbox/v4.3.0/LICENSE.md');
});

test('npm: the catalog version changes and npm installs that exact version', async () => {
  const root = sandbox();
  const installs = [];
  const changed = await applyApp([{ app: 'nettools', index: 3, type: 'npm', from: '0.3.1', to: '0.3.2' }], { root, hash, npmInstall: (dir, spec) => installs.push([dir, spec]) });
  assert.deepEqual(changed.sort(), ['catalog.yaml', 'package-lock.json', 'package.json']);
  assert.deepEqual(installs, [[root, 'age-encryption@0.3.2']]);
  assert.equal(parse(readFileSync(join(root, 'catalog.yaml'), 'utf8')).apps.find(a => a.id === 'nettools').sources[3].version, '0.3.2');
});

test('alpine: the lock file is rewritten from the index and the catalog is untouched', async () => {
  const root = sandbox();
  const lock = JSON.parse(readFileSync(join(root, 'scripts/pc/linux/packages.lock.json'), 'utf8'));
  const index = new Map(lock.packages.map(p => [p.name, { ...p }]));
  index.set(lock.packages[0].name, { ...lock.packages[0], version: `${lock.packages[0].version}-next` });
  const terminal = parse(readFileSync(join(root, 'catalog.yaml'), 'utf8')).apps.find(a => a.id === 'terminal');
  const at = terminal.sources.findIndex(s => s.type === 'alpine');
  const changed = await applyApp([{ app: 'terminal', index: at, type: 'alpine' }], { root, hash, apk: async () => index });
  assert.deepEqual(changed, ['scripts/pc/linux/packages.lock.json']);
  const next = JSON.parse(readFileSync(join(root, 'scripts/pc/linux/packages.lock.json'), 'utf8'));
  assert.equal(next.packages[0].version, `${lock.packages[0].version}-next`);
  assert.equal(readFileSync(join(root, 'catalog.yaml'), 'utf8'), readFileSync(join(repo, 'catalog.yaml'), 'utf8'));
});

test('github release: an icon taken from the app repo is re-pinned at the new tag', async () => {
  const root = sandbox();
  const url = 'https://github.com/storytold/gridcraft/releases/download/v0.20.0/gridcraft-web-0.20.0.zip';
  hashes.length = 0;
  await applyApp([{ app: 'gridcraft', index: 0, type: 'github-release', from: 'v0.19.1', to: 'v0.20.0', url }], { root, hash });
  const app = parse(readFileSync(join(root, 'catalog.yaml'), 'utf8')).apps.find(a => a.id === 'gridcraft');
  assert.equal(hashes[1], `https://raw.githubusercontent.com/storytold/gridcraft/v0.20.0/${app.icon.path}`);
  assert.equal(app.icon.sha256, 'f'.repeat(64));
});
