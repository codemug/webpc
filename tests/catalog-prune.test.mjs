// Unit tests for scripts/catalog/prune.mjs: a disabled app's dist/ folders go, an enabled
// app's stay, and files outside the three per-app folders stay.
// Run: node --test tests/catalog-prune.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prune } from '../scripts/catalog/prune.mjs';

const catalog = {
  apps: [
    { id: 'alpha', enabled: false },
    { id: 'beta', enabled: true },
  ],
};

test('prune removes only the disabled app\'s three dist folders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'webpc-prune-'));
  try {
    const dirs = [
      'dist/pc/apps/alpha', 'dist/pc/vendor/alpha', 'dist/third-party/alpha',
      'dist/pc/apps/beta', 'dist/pc/vendor/beta', 'dist/third-party/beta',
      'dist/pc/apps/gamma',
    ];
    for (const dir of dirs) await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, 'dist/pc/apps/alpha/index.html'), 'x');
    await writeFile(join(root, 'dist/pc/apps/gamma/index.html'), 'x');
    await writeFile(join(root, 'dist/index.html'), 'x');

    const removed = await prune(root, catalog);
    assert.deepEqual(removed.sort(), ['dist/pc/apps/alpha', 'dist/pc/vendor/alpha', 'dist/third-party/alpha'].sort());
    for (const gone of removed) await assert.rejects(access(join(root, gone)), `expected removed: ${gone}`);
    for (const kept of ['dist/pc/apps/beta', 'dist/pc/vendor/beta', 'dist/third-party/beta', 'dist/pc/apps/gamma', 'dist/index.html']) {
      await access(join(root, kept));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('prune is a no-op with no disabled apps, or with no dist/ at all', async () => {
  const root = await mkdtemp(join(tmpdir(), 'webpc-prune-'));
  try {
    assert.deepEqual(await prune(root, { apps: [{ id: 'beta', enabled: true }] }), []);
    assert.deepEqual(await prune(root, catalog), [], 'no dist/ at all: nothing to remove, no error');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('prune refuses unsafe ids instead of escaping dist/', async () => {
  const root = await mkdtemp(join(tmpdir(), 'webpc-prune-'));
  try {
    for (const id of ['../evil', 'a/b', 'a b', '-lead']) {
      await assert.rejects(prune(root, { apps: [{ id, enabled: false }] }), /unsafe app id/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
