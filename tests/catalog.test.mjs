import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { validateCatalog, checkNpmPins, registryEntries, loadCatalog, appSources, isEnabled } from '../scripts/catalog/catalog.mjs';

const base = () => parse(readFileSync(new URL('../catalog.yaml', import.meta.url), 'utf8'));
const errorsOf = mutate => { const c = base(); mutate(c); return validateCatalog(c); };
const byId = (c, id) => c.apps.find(a => a.id === id);

test('the committed catalog is valid and its npm pins match package.json and the lockfile', () => {
  const catalog = base();
  assert.deepEqual(validateCatalog(catalog), []);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.deepEqual(checkNpmPins(catalog, pkg, lock), []);
  assert.equal(loadCatalog().apps.length, catalog.apps.length);
});

test('validation names the app and field for each defect', () => {
  assert.match(errorsOf(c => { byId(c, 'gridcraft').enabled = 'yes'; }).join('\n'), /gridcraft: enabled must be true or false/);
  assert.match(errorsOf(c => { byId(c, 'gridcraft').colour = 'red'; }).join('\n'), /gridcraft: unknown key "colour"/);
  assert.match(errorsOf(c => { byId(c, 'gridcraft').sources[0].sha256 = 'abc'; }).join('\n'), /gridcraft: sources\[0\]\.sha256 must be 64 lowercase hex/);
  assert.match(errorsOf(c => { byId(c, 'gridcraft').sources[0].upgrade = 'sometimes'; }).join('\n'), /gridcraft: sources\[0\]\.upgrade must be auto or manual/);
  assert.match(errorsOf(c => { byId(c, 'gridcraft').sources[0].type = 'ftp'; }).join('\n'), /gridcraft: sources\[0\]\.type "ftp" is not one of/);
  assert.match(errorsOf(c => { byId(c, 'gridcraft').src = '/pc/apps/other/'; }).join('\n'), /gridcraft: src must be \/pc\/apps\/gridcraft\//);
  assert.match(errorsOf(c => { byId(c, 'vert').src = 'http://vert.sh/'; }).join('\n'), /vert: src must be an https URL/);
  assert.match(errorsOf(c => { c.apps.push({ ...byId(c, 'files') }); }).join('\n'), /files: duplicate id/);
  assert.match(errorsOf(c => { byId(c, 'gridcraft').sources[0].url = 'https://evil.example/x.zip'; }).join('\n'), /gridcraft: sources\[0\]\.url must be a release asset of storytold\/gridcraft/);
});

test('npm pins that drift from package.json or the lockfile are reported', () => {
  const catalog = base();
  const pinned = appSources(catalog, 'terminal', 'npm', 'v86')[0].version;
  const pkg = { dependencies: {}, devDependencies: { v86: `${pinned}-other` } };
  const lock = { packages: { 'node_modules/v86': { version: pinned } } };
  const errors = checkNpmPins({ apps: [byId(catalog, 'terminal')] }, pkg, lock).join('\n');
  assert.ok(errors.includes(`terminal: v86 is ${pinned} in the catalog but ${pinned}-other in package.json`), errors);
  assert.match(errors, /terminal: @xterm\/xterm is missing from package\.json/);
});

test('a disabled app leaves the desktop registry; the others keep their order and fields', () => {
  const catalog = base();
  byId(catalog, 'beepbox').enabled = false;
  const entries = registryEntries(catalog);
  assert.equal(entries.some(e => e.id === 'beepbox'), false);
  assert.equal(entries.length, catalog.apps.length - 1);
  assert.deepEqual(entries[0], { id: 'gridcraft', title: 'GridCraft', category: 'Office', keywords: byId(catalog, 'gridcraft').keywords, description: byId(catalog, 'gridcraft').description, src: '/pc/apps/gridcraft/', kind: 'iframe', loadTimeout: 75000, width: 1180, height: 760, icon: '/pc/icons/gridcraft.png' });
  assert.equal('sources' in entries[0] || 'enabled' in entries[0], false);
  assert.equal(isEnabled(catalog, 'beepbox'), false);
  assert.equal(isEnabled(catalog, 'gridcraft'), true);
  assert.throws(() => isEnabled(catalog, 'nope'), /unknown app "nope"/);
});

test('appSources filters an app\'s sources by type and package', () => {
  const catalog = base();
  assert.equal(appSources(catalog, 'gridcraft', 'github-release')[0].repo, 'storytold/gridcraft');
  assert.equal(appSources(catalog, 'terminal', 'npm', 'v86')[0].version, byId(catalog, 'terminal').sources[0].version);
  assert.deepEqual(appSources(catalog, 'files'), []);
});

test('icons: each form validates, and the registry carries the served icon URL', () => {
  assert.match(errorsOf(c => { byId(c, 'gridcraft').icon.sha256 = 'x'; }).join('\n'), /gridcraft: icon\.sha256 must be 64 lowercase hex/);
  assert.match(errorsOf(c => { byId(c, 'sqliteviz').icon.path = '../escape.png'; }).join('\n'), /sqliteviz: icon\.path must be a relative path without \.\./);
  assert.match(errorsOf(c => { byId(c, 'vert').icon.url = 'http://vert.sh/x.png'; }).join('\n'), /vert: icon\.url must be an https URL/);
  assert.match(errorsOf(c => { byId(c, 'files').icon = { from: 'repo', path: 'a.png', sha256: 'a'.repeat(64) }; }).join('\n'), /files: icon: from: repo needs a github-release source/);
  assert.match(errorsOf(c => { byId(c, 'beepbox').icon.path = 'icon.gif'; }).join('\n'), /beepbox: icon must be a \.png, \.jpg or \.svg file/);
  const entries = registryEntries(base());
  assert.equal(entries.find(e => e.id === 'gridcraft').icon, '/pc/icons/gridcraft.png');
  assert.equal('icon' in entries.find(e => e.id === 'files'), false, 'WebPC-native apps keep their own tile');
});

test('folders: an app may name a desktop folder; bad names are rejected and the registry carries it', () => {
  assert.match(errorsOf(c => { byId(c, 'beepbox').folder = 'games/../x'; }).join('\n'), /beepbox: folder must be a short name/);
  assert.deepEqual(errorsOf(c => { byId(c, 'beepbox').folder = 'Games'; }), []);
  const c = base(); byId(c, 'beepbox').folder = 'Games';
  assert.equal(registryEntries(c).find(e => e.id === 'beepbox').folder, 'Games');
  assert.equal('folder' in registryEntries(c).find(e => e.id === 'gridcraft'), false);
});
