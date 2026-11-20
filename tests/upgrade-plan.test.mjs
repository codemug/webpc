import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, parseDocument } from 'yaml';
import { planUpgrades, applyToCatalog, alpineLockUpdate } from '../scripts/upgrade/plan.mjs';

const text = readFileSync(new URL('../catalog.yaml', import.meta.url), 'utf8');
const catalog = () => parse(text);
const now = new Date('2026-12-01T00:00:00Z');
const releasesFixture = JSON.parse(readFileSync(new URL('./fixtures/upgrade/gridcraft-releases.json', import.meta.url), 'utf8'));
const oneApp = id => { const c = catalog(); c.apps = c.apps.filter(a => a.id === id); return c; };
const noNetwork = { releases: async () => [], npm: async () => ({ versions: {} }), hfHead: async () => null, apk: async () => new Map() };

test('github-release: an auto source with a newer release becomes an auto entry with the new tag and url', async () => {
  const c = oneApp('gridcraft');
  c.apps[0].sources[0].tag = 'v0.18.0';
  const plan = await planUpgrades(c, { now, ...noNetwork, releases: async repo => (assert.equal(repo, 'storytold/gridcraft'), releasesFixture) });
  assert.equal(plan.length, 1);
  assert.deepEqual({ ...plan[0], source: undefined }, { app: 'gridcraft', index: 0, type: 'github-release', name: 'storytold/gridcraft', from: 'v0.18.0', to: 'v0.19.1', auto: true, url: 'https://github.com/storytold/gridcraft/releases/download/v0.19.1/gridcraft-web-0.19.1.zip', source: undefined });
});

test('manual sources and disabled apps: manual ones are reported (auto false), disabled apps are not checked', async () => {
  const c = oneApp('terminal');
  const seen = [];
  const npm = async pkg => { seen.push(pkg); return { time: { '0.5.480': '2026-01-01T00:00:00Z' }, versions: { '0.5.473': { dist: {} }, '0.5.480': { dist: { integrity: 'sha512-x' } } } }; };
  const plan = await planUpgrades(c, { now, ...noNetwork, npm });
  const v86 = plan.find(e => e.name === 'v86');
  assert.equal(v86.auto, false);
  assert.equal(v86.to, '0.5.480');
  c.apps[0].enabled = false;
  seen.length = 0;
  assert.deepEqual(await planUpgrades(c, { now, ...noNetwork, npm }), []);
  assert.deepEqual(seen, []);
});

test('npm: a newer major is reported as a manual note, never as an auto bump', async () => {
  const c = oneApp('terminal');
  const meta = JSON.parse(readFileSync(new URL('./fixtures/upgrade/npm-xterm.json', import.meta.url), 'utf8'));
  const plan = await planUpgrades(c, { now, ...noNetwork, npm: async pkg => (pkg === '@xterm/xterm' ? meta : { versions: {} }) });
  const xterm = plan.filter(e => e.name === '@xterm/xterm');
  assert.deepEqual(xterm.map(e => [e.to, e.auto]), [['6.0.0', false]]); // 5.5.0 is already the newest 5.x
  assert.match(xterm[0].note, /new major/);
});

test('applyToCatalog edits only the bumped fields and keeps comments and layout', () => {
  const doc = parseDocument(text);
  applyToCatalog(doc, { app: 'gridcraft', index: 0, type: 'github-release' }, { tag: 'v0.19.2', url: 'https://github.com/storytold/gridcraft/releases/download/v0.19.2/gridcraft-web-0.19.2.zip', sha256: 'a'.repeat(64) });
  const before = text.split('\n'), after = doc.toString({ lineWidth: 0 }).split('\n');
  const changed = after.filter((line, i) => line !== before[i]);
  assert.equal(after.length, before.length);
  assert.deepEqual(changed.map(l => l.trim().split(':')[0]), ['tag', 'url', 'sha256']);
  assert.equal(after[0], before[0], 'the header comment stays');
  assert.throws(() => applyToCatalog(doc, { app: 'gridcraft', index: 0, type: 'github-release' }, { colour: 'red' }), /not a field/);
});

test('alpine: only packages whose version changed in the index are updated; a missing one is an error', () => {
  const lock = { branch: 'v3.22', architecture: 'x86', packages: [
    { name: 'bash', version: '5.2.37-r0', origin: 'bash', license: 'GPL-3.0-or-later', sourceCommit: 'a'.repeat(40), url: 'u' },
    { name: 'nano', version: '8.4-r0', origin: 'nano', license: 'GPL-3.0-or-later', sourceCommit: 'b'.repeat(40), url: 'v' },
  ] };
  const index = new Map([['bash', { name: 'bash', version: '5.2.37-r1', origin: 'bash', license: 'GPL-3.0-or-later', sourceCommit: 'c'.repeat(40), url: 'u' }], ['nano', { ...lock.packages[1] }]]);
  const { lock: next, changes } = alpineLockUpdate(lock, index);
  assert.deepEqual(changes, [{ name: 'bash', from: '5.2.37-r0', to: '5.2.37-r1' }]);
  assert.equal(next.packages[0].sourceCommit, 'c'.repeat(40));
  assert.equal(lock.packages[0].version, '5.2.37-r0', 'the input lock is not mutated');
  assert.throws(() => alpineLockUpdate(lock, new Map([['bash', index.get('bash')]])), /nano is no longer in the v3\.22 index/);
});
