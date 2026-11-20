import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIcons } from '../scripts/catalog/icons.mjs';

const png = Buffer.from('89504e470d0a1a0a', 'hex');
const sha = b => createHash('sha256').update(b).digest('hex');
const catalog = icon => ({ apps: [
  { id: 'alpha', enabled: true, sources: [{ type: 'github-release', repo: 'o/alpha', tag: 'v1.0.0' }], icon: { from: 'repo', path: 'icon.png', sha256: sha(png) } },
  { id: 'beta', enabled: true, icon: { from: 'release', path: 'img/logo.png' } },
  { id: 'gamma', enabled: false, icon: { url: 'https://example.test/g.png', sha256: sha(png) } },
  { id: 'delta', enabled: true, ...(icon ? { icon } : {}) },
] });
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'webpc-icons-'));
  mkdirSync(join(root, 'public/pc/vendor/beta/img'), { recursive: true });
  writeFileSync(join(root, 'public/pc/vendor/beta/img/logo.png'), png);
  return root;
}

test('downloads are verified and cached, release icons are copied, disabled apps get none', async () => {
  const root = sandbox(); const fetched = [];
  const fetchBytes = async url => { fetched.push(url); return png; };
  const written = await buildIcons(root, catalog(), { fetchBytes });
  assert.deepEqual(written.sort(), ['public/pc/icons/alpha.png', 'public/pc/icons/beta.png']);
  assert.deepEqual(fetched, ['https://raw.githubusercontent.com/o/alpha/v1.0.0/icon.png']);
  await buildIcons(root, catalog(), { fetchBytes });
  assert.equal(fetched.length, 1, 'the second build uses the verified cache');
  assert.deepEqual(readFileSync(join(root, 'public/pc/icons/beta.png')), png);
});

test('a checksum mismatch stops the build, and an icon whose app is disabled is removed', async () => {
  const root = sandbox();
  await assert.rejects(buildIcons(root, catalog({ url: 'https://example.test/d.png', sha256: 'a'.repeat(64) }), { fetchBytes: async () => png }), /delta: icon checksum mismatch/);
  const c = catalog(); await buildIcons(root, c, { fetchBytes: async () => png });
  c.apps[1].enabled = false;
  await buildIcons(root, c, { fetchBytes: async () => png });
  assert.deepEqual(readdirSync(join(root, 'public/pc/icons')), ['alpha.png']);
});
