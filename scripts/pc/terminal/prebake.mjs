#!/usr/bin/env node
// Pre-bake the unkernel data disk. Boots the pinned Alpine twice under Node (JSPI is
// behind --experimental-wasm-jspi, so Node 24 or newer; CI is Node 22 and never runs
// this): once with the host network to install the pinned packages, once with
// --no-net on the same disk to prove they persist and run offline. The disk is then
// exported as a gzipped kwsparse template into the cache dir (outside public/);
// prepare-terminal.mjs vendors it into public/pc/vendor/unkernel/ after checking its
// SHA-256 against packages.json.
//   node --experimental-wasm-jspi scripts/pc/terminal/prebake.mjs
import { execFile } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundledBoot, decodeKwsparse, encodeKwsparse, gunzipIfNeeded } from 'unkernel';
import { buildInstallInput, buildOfflineInput, planBlocks, validatePackagesLock } from './plan.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 24) {
  console.error(`Node 24 or newer is required for the pre-bake (found ${process.versions.node}); it needs WebAssembly JSPI behind --experimental-wasm-jspi.`);
  process.exit(1);
}
const cli = join(root, 'node_modules/unkernel/dist/cli.mjs');
if (!existsSync(cli)) {
  console.error(`The unkernel package is missing (${cli}). Run npm ci first.`);
  process.exit(1);
}
const lock = JSON.parse(await readFile(join(here, 'packages.json'), 'utf8'));
const errors = validatePackagesLock(lock);
if (errors.length) {
  console.error('Refusing to pre-bake; fix scripts/pc/terminal/packages.json first:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
const cache = join(root, 'node_modules/.cache/webpc/unkernel');
const work = join(cache, `prebake-${process.pid}`);
const image = join(work, 'prebake.img');
await mkdir(work, { recursive: true });
// One scripted boot: the CLI types the one-line script into the console after boot
// and exits when it is done; the output must then show both verify markers.
const boot = (label, extraArgs, input) => new Promise((resolve, reject) => {
  execFile(process.execPath, ['--experimental-wasm-jspi', cli, '--data', image, '--timeout', '300', ...extraArgs, '--input', input], { maxBuffer: 256 * 1024 * 1024, timeout: 600000 }, (error, stdout, stderr) => {
    const output = `${stdout}\n${stderr}`;
    if (error) return reject(new Error(`${label} failed: ${error.message}\n${output.slice(-4000)}`));
    const missing = ['python3-ok', 'node-ok'].filter(marker => !output.includes(marker));
    if (missing.length) return reject(new Error(`${label} did not show the expected markers (${missing.join(', ')}).\n${output.slice(-4000)}`));
    resolve();
  });
});
const exportTemplate = async () => {
  const wasm = await readFile(join(root, 'node_modules/unkernel/dist/unkernel.wasm'));
  const section = bundledBoot(new WebAssembly.Module(wasm)).datadisk; // the SDK's reader for the bundled template
  if (!section) throw new Error('unkernel.wasm has no unkernel.datadisk section; the SDK layout changed, so check the pinned release before retrying.');
  const base = decodeKwsparse(await gunzipIfNeeded(section)); // the bundled data disk template: size and block geometry
  const { size } = statSync(image);
  if (size !== base.size) throw new Error(`The pre-baked image is ${size} bytes but the data disk is ${base.size}; they must match.`);
  if (base.size % base.blockSize !== 0) throw new Error(`The data disk (${base.size} bytes) is not a multiple of its block size (${base.blockSize}).`);
  // The image is 4 GiB and sparse: read it in chunks (Node cannot read a file over 2 GiB into one
  // buffer) and keep only the non-zero blocks.
  const chunkBytes = base.blockSize * 256, chunk = Buffer.alloc(chunkBytes), blocks = [], fd = openSync(image, 'r');
  try {
    for (let offset = 0; offset < size; offset += chunkBytes) {
      const read = readSync(fd, chunk, 0, Math.min(chunkBytes, size - offset), offset);
      blocks.push(...planBlocks(chunk.subarray(0, read), base.blockSize, offset / base.blockSize));
    }
  } finally { closeSync(fd); }
  return { bytes: gzipSync(encodeKwsparse({ size: base.size, blockSize: base.blockSize, blocks })), size: base.size };
};
try {
  console.log(`Installing ${lock.packages.map(p => `${p.name}=${p.version}`).join(', ')} into a fresh data disk (networked boot)…`);
  await boot('The package install boot', [], buildInstallInput(lock));
  console.log('Booting the same disk with --no-net to verify the packages persist…');
  await boot('The offline verify boot', ['--no-net'], buildOfflineInput());
  const template = await exportTemplate();
  await writeFile(join(cache, 'data-template.kwsparse.gz'), template.bytes);
  const digest = sha(template.bytes);
  console.log(`Pre-baked data disk: ${template.size} bytes disk, ${template.bytes.length} bytes gzipped kwsparse.`);
  console.log(`SHA-256: ${digest}`);
  console.log(`Pin in scripts/pc/terminal/packages.json: "templateSha256": "${digest}" (and the package versions exactly as installed).`);
} finally {
  await rm(work, { recursive: true, force: true });
}
