import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { staticApps, staticPlan, isUnsafeArchivePath, rowFingerprint } from '../scripts/pc/prepare-static-apps.mjs';
import { appSources } from '../scripts/catalog/catalog.mjs';

const base = () => parse(readFileSync(new URL('../catalog.yaml', import.meta.url), 'utf8'));

test('every static-apps row keeps its behaviour; the pins come from the catalog', () => {
  assert.ok(staticApps.length > 0, 'table must not be empty');
  const ids = new Set();
  for (const app of staticApps) {
    assert.match(app.id, /^[a-z0-9][a-z0-9-]*$/, `${app.id} must be a safe vendor directory name`);
    assert.ok(!ids.has(app.id), `${app.id} appears twice`);
    ids.add(app.id);
    assert.ok(typeof app.title === 'string' && app.title.length > 0, `${app.id} missing title`);
    assert.ok(typeof app.notice === 'string' && app.notice.length > 0, `${app.id} missing WEBPC.txt notice`);
    assert.ok(app.tweak == null || typeof app.tweak === 'function', `${app.id} tweak must be absent, null or a function`);
    assert.ok(app.inject == null || (typeof app.inject.name === 'string' && typeof app.inject.src === 'string'), `${app.id} inject must be absent or {name, src}`);
    assert.ok('version' in app === false && 'url' in app === false && 'sha256' in app === false, `${app.id} must not hard-code pins here; catalog.yaml does`);
  }
});

test('staticPlan merges each enabled row with its catalog pin (version = tag without a leading v)', () => {
  const catalog = base();
  const plan = staticPlan(catalog);
  assert.equal(plan.length, staticApps.length, 'one plan entry per row');
  for (const app of plan) {
    const source = appSources(catalog, app.id, 'github-release')[0];
    assert.equal(app.version, String(source.tag).replace(/^v/, ''), `${app.id} version from the catalog tag`);
    assert.equal(app.url, source.url, `${app.id} url from the catalog`);
    assert.equal(app.sha256, source.sha256, `${app.id} sha256 from the catalog`);
    assert.equal(app.upstream, `https://github.com/${source.repo}`, `${app.id} upstream derived from the catalog repo`);
  }
});

test('a row whose ZIP ships no licence file pins the repo licence from the catalog (path, sha256, raw tag URL)', () => {
  const plan = staticPlan(base()).find(app => app.id === 'beepbox');
  const source = appSources(base(), 'beepbox', 'github-release')[0];
  assert.equal(plan.license.sha256, source.license.sha256, 'licence digest from the catalog');
  assert.equal(plan.license.name, source.license.path, 'saved under the catalog licence path');
  assert.equal(plan.license.url, `https://raw.githubusercontent.com/${source.repo}/${source.tag}/${source.license.path}`, 'fetched from the raw tag path');
});

test('a disabled static app leaves the plan', () => {
  const catalog = base();
  const rowId = staticApps[0].id;
  catalog.apps.find(a => a.id === rowId).enabled = false;
  const plan = staticPlan(catalog);
  assert.ok(!plan.some(app => app.id === rowId), `the disabled app (${rowId}) is not planned`);
  assert.equal(plan.length, staticApps.length - 1, 'the other rows are still planned');
});

test('unsafe archive paths are rejected, safe paths accepted', () => {
  for (const name of ['../x', '/abs', 'a\\b', 'a/../../b', 'a/../../../etc']) {
    assert.ok(isUnsafeArchivePath(name), `must reject: ${JSON.stringify(name)}`);
  }
  for (const name of ['index.html', 'assets/app.js', 'LICENSE', 'nested/dir/file.png']) {
    assert.ok(!isUnsafeArchivePath(name), `must accept: ${JSON.stringify(name)}`);
  }
});

test('rowFingerprint is deterministic and changes with preparer source or injected files', () => {
  const a = rowFingerprint('preparer source v1');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(rowFingerprint('preparer source v1'), a, 'must be deterministic');
  assert.notEqual(rowFingerprint('preparer source v2'), a, 'a preparer change must force re-preparation');
  const withFile = rowFingerprint('preparer source v1', ['audio guard v1']);
  assert.notEqual(withFile, a, 'an injected file must be part of the fingerprint');
  assert.equal(rowFingerprint('preparer source v1', ['audio guard v1']), withFile, 'must be deterministic');
  assert.notEqual(rowFingerprint('preparer source v1', ['audio guard v2']), withFile, 'an injected-file change must force re-preparation');
});
