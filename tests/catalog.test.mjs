import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { validateCatalog, checkNpmPins, registryEntries, loadCatalog, appSources, isEnabled, LEGACY_NON_WASM } from '../scripts/catalog/catalog.mjs';

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
  const pinned = appSources(catalog, 'terminal', 'npm', '@xterm/xterm')[0].version;
  const pkg = { dependencies: {}, devDependencies: { '@xterm/xterm': `${pinned}-other` } };
  const lock = { packages: { 'node_modules/@xterm/xterm': { version: pinned } } };
  const errors = checkNpmPins({ apps: [byId(catalog, 'terminal')] }, pkg, lock).join('\n');
  assert.ok(errors.includes(`terminal: @xterm/xterm is ${pinned} in the catalog but ${pinned}-other in package.json`), errors);
  assert.match(errors, /terminal: @xterm\/addon-fit is missing from package\.json/);
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
  assert.equal(appSources(catalog, 'terminal', 'npm', '@xterm/xterm')[0].version, byId(catalog, 'terminal').sources[0].version);
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

test('panel: WebPC Agent is the one kind: panel app, with an iframe-style src', () => {
  assert.equal(byId(base(), 'ai-agent').kind, 'panel');
  assert.equal(registryEntries(base()).find(e => e.id === 'ai-agent').title, 'WebPC Agent');
  assert.match(errorsOf(c => { byId(c, 'ai-agent').src = '/pc/apps/other/'; }).join('\n'), /ai-agent: src must be \/pc\/apps\/ai-agent\//);
  assert.match(errorsOf(c => { byId(c, 'sqliteviz').kind = 'panel'; }).join('\n'), /only one app may be kind: panel .* found sqliteviz, ai-agent|only one app may be kind: panel .* found ai-agent, sqliteviz/);
});

test('wasm.build: every packaged (kind: iframe) app declares how its wasm is built; the legacy list is the only exception', () => {
  const addApp = c => c.apps.push({ id: 'newapp', enabled: true, title: 'New App', category: 'Utilities', keywords: ['new'], description: 'A newly packaged app.', src: '/pc/apps/newapp/', kind: 'iframe' });
  // A new iframe app without wasm.build fails, naming the app and the field to add.
  assert.match(errorsOf(addApp).join('\n'), /newapp: wasm\.build is required/);
  // ...and the same app with a build command validates.
  assert.deepEqual(errorsOf(c => { addApp(c); c.apps.at(-1).wasm = { build: 'cargo xtask web' }; }), []);
  // The committed catalog has a wasm block for exactly the non-legacy iframe apps and validates.
  const catalog = base();
  for (const app of catalog.apps) {
    const needsWasm = app.kind === 'iframe' && !LEGACY_NON_WASM.has(app.id);
    assert.equal('wasm' in app, needsWasm, `${app.id}: the committed catalog must ${needsWasm ? 'have' : 'not have'} a wasm block`);
  }
  assert.equal(validateCatalog(catalog).length, 0, 'the real catalog.yaml validates');
});

test('wasm block shape: unknown keys and empty builds are rejected; legacy, external and panel apps pass without one', () => {
  assert.match(errorsOf(c => { byId(c, 'gridcraft').wasm.note = 'trunk'; }).join('\n'), /gridcraft: wasm: unknown key "note"/);
  assert.match(errorsOf(c => { byId(c, 'gridcraft').wasm.build = '   '; }).join('\n'), /gridcraft: wasm\.build must be a non-empty string/);
  assert.match(errorsOf(c => { byId(c, 'gridcraft').wasm = 'trunk build'; }).join('\n'), /gridcraft: wasm must be a mapping/);
  // Dropping every wasm block still leaves the legacy, external and panel apps valid.
  assert.deepEqual(errorsOf(c => { for (const id of LEGACY_NON_WASM) delete byId(c, id).wasm; }), []);
  assert.deepEqual(errorsOf(c => { for (const id of ['vscode', 'vert', 'ai-agent']) delete byId(c, id).wasm; }), []);
});
