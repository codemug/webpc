import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePackagesLock, apkPackages, buildInstallInput, buildOfflineInput, unkernelPins, planBlocks, TODO } from '../scripts/pc/terminal/plan.mjs';

const validLock = {
  schema: 1,
  kernelVersion: '0.2.0-261123-8f039c5',
  distro: 'alpine',
  packages: [
    { name: 'python3', version: '3.12.16-r0' },
    { name: 'nodejs', version: '24.22.3-r0' },
  ],
  templateSha256: 'a'.repeat(64),
};

test('packages lock: a complete lock validates', () => {
  assert.deepEqual(validatePackagesLock(validLock), []);
  assert.deepEqual(validatePackagesLock(validLock, { requireTemplateSha: true }), []);
});

test('packages lock: TODO versions refuse, naming the package', () => {
  const lock = structuredClone(validLock);
  lock.packages[0].version = TODO;
  const errors = validatePackagesLock(lock);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /python3/);
  assert.match(errors[0], /TODO/);
});

test('packages lock: package names and shape are checked', () => {
  assert.ok(validatePackagesLock({ ...validLock, packages: [{ name: 'Python3', version: '1.0' }] }).length > 0, 'uppercase name refused');
  assert.ok(validatePackagesLock({ ...validLock, packages: [] }).length > 0, 'empty list refused');
  assert.ok(validatePackagesLock({ ...validLock, packages: 'nope' }).length > 0, 'non-list refused');
  assert.ok(validatePackagesLock({ ...validLock, distro: 'Alpine!' }).length > 0, 'distro refused');
  assert.ok(validatePackagesLock({ ...validLock, schema: 2 }).length > 0, 'schema refused');
  assert.ok(validatePackagesLock(null).length > 0, 'non-object refused');
});

test('packages lock: templateSha256 is only enforced when required', () => {
  const lock = { ...validLock, templateSha256: TODO };
  assert.deepEqual(validatePackagesLock(lock), [], 'the pre-bake prints the value, so it may be a placeholder');
  assert.ok(validatePackagesLock(lock, { requireTemplateSha: true }).length > 0, 'prepare must refuse the placeholder');
  const short = { ...validLock, templateSha256: 'abc' };
  assert.ok(validatePackagesLock(short, { requireTemplateSha: true }).length > 0, 'a non-hex64 value is refused');
});

test('apk install input: one line, pinned versions, verify chain', () => {
  assert.equal(apkPackages(validLock), 'python3=3.12.16-r0 nodejs=24.22.3-r0');
  assert.equal(
    buildInstallInput(validLock),
    `sudo apk add --no-progress python3=3.12.16-r0 nodejs=24.22.3-r0 && ${buildOfflineInput()}`
  );
  assert.equal(buildOfflineInput(), `python3 -c 'import json, sqlite3, sys; print("python3-ok", sys.version.split()[0])' && node -e 'console.log("node-ok", process.version)'; sudo poweroff\n`);
  const script = buildInstallInput(validLock);
  // The CLI exits only when the guest halts, so the line must end in a poweroff that runs even
  // when a check fails (";", not "&&"); the marker check then reports the failure.
  assert.match(script, /; sudo poweroff\n$/);
  assert.equal(script.match(/\n/g).length, 1, 'a single line (one trailing Enter) so a busy console never sees a half-typed next command');
});

const pinSources = [
  { type: 'npm', package: 'v86', version: '0.5.473', upgrade: 'manual' },
  { type: 'npm', package: 'unkernel', version: '0.2.0-261123-8f039c5', upgrade: 'manual' },
  { type: 'github-release', repo: 'pithings/unkernel', tag: 'v0.2.0-261123-8f039c5', asset: 'distros.json', url: 'https://github.com/pithings/unkernel/releases/download/v0.2.0-261123-8f039c5/distros.json', sha256: 'b'.repeat(64), upgrade: 'manual' },
  { type: 'github-release', repo: 'pithings/unkernel', tag: 'v0.2.0-261123-8f039c5', asset: 'alpine.erofs', url: 'https://github.com/pithings/unkernel/releases/download/v0.2.0-261123-8f039c5/alpine.erofs', sha256: 'c'.repeat(64), upgrade: 'manual' },
];

test('catalog pins: a complete source list validates', () => {
  const pins = unkernelPins(pinSources, 'alpine');
  assert.deepEqual(pins.errors, []);
  assert.equal(pins.ok, true);
  assert.equal(pins.npm, '0.2.0-261123-8f039c5');
  assert.equal(pins.tag, 'v0.2.0-261123-8f039c5');
  assert.equal(pins.assets['alpine.erofs'].sha256, 'c'.repeat(64));
  assert.equal(pins.assets['distros.json'].sha256, 'b'.repeat(64));
});

test('catalog pins: missing or inconsistent sources refuse', () => {
  assert.ok(unkernelPins(pinSources.filter(s => !(s.type === 'npm' && s.package === 'unkernel')), 'alpine').errors.length > 0, 'npm pin missing');
  assert.ok(unkernelPins(pinSources.filter(s => s.asset !== 'distros.json'), 'alpine').errors.length > 0, 'distros.json missing');
  assert.ok(unkernelPins(pinSources.filter(s => s.asset !== 'alpine.erofs'), 'alpine').errors.length > 0, 'distro image missing');
  const mismatched = pinSources.map(s => (s.asset === 'alpine.erofs' ? { ...s, tag: 'v9.9.9' } : s));
  assert.ok(unkernelPins(mismatched, 'alpine').errors.length > 0, 'mixed tags refused');
  const badSha = pinSources.map(s => (s.asset === 'distros.json' ? { ...s, sha256: 'xyz' } : s));
  assert.ok(unkernelPins(badSha, 'alpine').errors.length > 0, 'non-hex sha256 refused');
});

test('kwsparse block planning: zero blocks skipped, partial tail kept', () => {
  const image = new Uint8Array(10);
  image[0] = 1; // block 0 (4 bytes) non-zero
  image[9] = 1; // block 2 (3 bytes, partial tail) non-zero; block 1 all zero
  const blocks = planBlocks(image, 4);
  assert.deepEqual(blocks.map(b => b[0]), [0, 2]);
  assert.equal(blocks[1][1].length, 2, 'the tail block is only as long as the image is past block start 8');
  assert.deepEqual(planBlocks(new Uint8Array(8), 4), []);
  assert.throws(() => planBlocks(new Uint8Array(4), 0), /blockSize/);
  // Chunked reads (a 4 GiB sparse disk cannot be read into one buffer): indices continue from firstIndex.
  assert.deepEqual(planBlocks(image, 4, 100).map(b => b[0]), [100, 102]);
  // The blocks must be copies: the pre-bake reuses one read buffer, and Buffer#slice returns a view.
  const reused = Buffer.from([1, 1, 1, 1]);
  const [[, kept]] = planBlocks(reused, 4);
  reused.fill(0);
  assert.deepEqual([...kept], [1, 1, 1, 1]);
});
