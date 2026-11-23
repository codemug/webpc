// A real 32-bit Linux guest. Generated runtime/guest files stay out of git.
import { readFile, writeFile, mkdir, cp, rm, rename, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadCatalog, isEnabled, appSources } from '../catalog/catalog.mjs';
import { unkernelPins, validatePackagesLock } from './terminal/plan.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const catalog = loadCatalog(root);
if (!isEnabled(catalog, 'terminal')) { console.log('Skipped terminal: disabled in catalog.yaml.'); process.exit(0); }
const recipe = join(root, 'scripts/pc/linux');
const output = join(root, 'public/pc/vendor/terminal');
const cache = join(root, 'node_modules/.cache/webpc/linux');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const lockText = await readFile(join(recipe, 'packages.lock.json'), 'utf8');
const lock = JSON.parse(lockText);
// The v86 stage. M1 keeps it intact and adds the unkernel stage below; M2 removes it.
async function prepareV86() {
const v86Pin = appSources(catalog, 'terminal', 'npm', 'v86')[0].version;
const installed = JSON.parse(await readFile(join(root, 'node_modules/v86/package.json'), 'utf8'));
if (installed.version.split('+')[0] !== v86Pin) throw new Error(`Expected v86 ${v86Pin} (catalog.yaml); found ${installed.version}. Run npm ci.`);
const runtime = await Promise.all(['v86.wasm', 'libv86.mjs'].map(name => readFile(join(root, 'node_modules/v86/build', name))));
const inputs = await Promise.all(['Dockerfile', 'flatten.py'].map(name => readFile(join(recipe, name))));
const recipeId = sha(Buffer.concat([Buffer.from(lockText), ...inputs, ...runtime, await readFile(fileURLToPath(import.meta.url))]));
try {
  const existing = JSON.parse(await readFile(join(output, 'release.json'), 'utf8'));
  for (const name of ['fs.json', 'v86.wasm', 'libv86.mjs', 'seabios.bin', 'vgabios.bin']) await access(join(output, name));
  if (existing.recipeId === recipeId) { console.log(`Alpine Linux already prepared (${existing.imageId.slice(0, 12)}).`); return; }
} catch { /* Missing/incomplete generated output: prepare it. */ }
await mkdir(cache, { recursive: true });
const stage = `${output}.staging-${process.pid}`;
const container = `webpc-linux-export-${process.pid}`;
await mkdir(stage, { recursive: true });
try {
  // Docker is a build-time tool only; the deployed page is completely static.
  execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'pipe' });
  await cp(join(recipe, 'Dockerfile'), join(cache, 'Dockerfile'));
  await writeFile(join(cache, 'packages.txt'), lock.packages.map(p => `${p.name}=${p.version}`).join('\n'));
  const image = `webpc-linux:${recipeId.slice(0, 16)}`;
  console.log('Preparing pinned Alpine Linux guest (Docker + Python 3 required on a clean build)…');
  execFileSync('docker', ['build', '--platform', 'linux/386', '-t', image, cache], { stdio: 'inherit' });
  execFileSync('docker', ['create', '--name', container, image], { stdio: 'pipe' });
  const tar = join(cache, 'rootfs.tar');
  execFileSync('docker', ['export', container, '-o', tar], { stdio: 'inherit' });
  execFileSync('python3', [join(recipe, 'flatten.py'), tar, stage, String(lock.epoch)], { stdio: 'inherit' });
  for (const name of ['libv86.mjs', 'v86.wasm']) await cp(join(root, 'node_modules/v86/build', name), join(stage, name));
  const bios = {
    'seabios.bin': '73e3f359102e3a9982c35fce98eb7cd08f18303ac7f1ba6ebfbe6cdc1c244d98',
    'vgabios.bin': 'a4bc0d80cc3ca028c73dafa8fee396b8d054ce87ebd8abfbd31b06b437607880',
  };
  for (const [name, digest] of Object.entries(bios)) {
    const url = `https://raw.githubusercontent.com/copy/v86/${lock.v86Commit}/bios/${name}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`BIOS download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha(bytes) !== digest) throw new Error(`BIOS checksum mismatch: ${name}`);
    await writeFile(join(stage, name), bytes);
  }
  const manifest = await readFile(join(stage, 'fs.json'));
  const imageId = sha(Buffer.concat([manifest, ...runtime, Buffer.from(JSON.stringify(bios)), Buffer.from(JSON.stringify(lock.vm))]));
  await writeFile(join(stage, 'release.json'), JSON.stringify({ version: 1, recipeId, imageId, v86: lock.v86Version, alpine: '3.22', memoryMiB: lock.vm.memoryMiB, vm: lock.vm, guestBytes: JSON.parse(manifest).size }));
  await cp(join(root, 'node_modules/v86/LICENSE'), join(root, 'public/third-party/terminal/v86-LICENSE.txt'));
  await cp(join(recipe, 'packages.lock.json'), join(root, 'public/third-party/terminal/packages.lock.json'));
  await rm(output, { recursive: true, force: true });
  await rename(stage, output);
  console.log(`Prepared Alpine Linux (${imageId.slice(0, 12)}); all guest files served locally.`);
} finally {
  try { execFileSync('docker', ['rm', '-f', container], { stdio: 'pipe' }); } catch { /* May not have reached create. */ }
  await rm(stage, { recursive: true, force: true });
}
}
await prepareV86();

// The unkernel stage (M1): the SDK browser files, the distro image and the pre-baked
// data disk template into public/pc/vendor/unkernel/. The page hosts the images itself
// because the web SDK ships no downloader (its GitHub release assets send no CORS
// headers). All loads are pinned: the npm pin is checked against node_modules, every
// asset against catalog.yaml's SHA-256, the image also against distros.json, and the
// template against packages.json.
async function prepareUnkernel() {
  const unkernelOut = join(root, 'public/pc/vendor/unkernel');
  const unkernelCache = join(root, 'node_modules/.cache/webpc/unkernel');
  const lockText = await readFile(join(root, 'scripts/pc/terminal/packages.json'), 'utf8');
  const lock = JSON.parse(lockText);
  const lockErrors = validatePackagesLock(lock, { requireTemplateSha: true });
  if (lockErrors.length) throw new Error(`terminal/packages.json is not ready:\n- ${lockErrors.join('\n- ')}`);
  const pins = unkernelPins(appSources(catalog, 'terminal'), lock.distro);
  if (!pins.ok) throw new Error(`catalog.yaml terminal sources are not ready for unkernel:\n- ${pins.errors.join('\n- ')}`);
  const installed = JSON.parse(await readFile(join(root, 'node_modules/unkernel/package.json'), 'utf8'));
  if (installed.version !== pins.npm) throw new Error(`Expected unkernel ${pins.npm} (catalog.yaml); found ${installed.version}. Run npm ci.`);
  const distroFile = `${lock.distro}.erofs`;
  const sdk = new Map([['web.mjs', 'dist/web.mjs'], ['_chunks/core.mjs', 'dist/_chunks/core.mjs'], ['unkernel.wasm', 'dist/unkernel.wasm']]);
  const sdkBytes = await Promise.all([...sdk.values()].map(name => readFile(join(root, 'node_modules/unkernel', name))));
  const recipeId = sha(Buffer.concat([Buffer.from(lockText), Buffer.from(JSON.stringify(pins.assets)), Buffer.from(pins.npm), ...sdkBytes, await readFile(fileURLToPath(import.meta.url))]));
  try {
    const existing = JSON.parse(await readFile(join(unkernelOut, 'release.json'), 'utf8'));
    for (const name of [...sdk.keys(), 'distros.json', distroFile, 'data-template.kwsparse.gz']) await access(join(unkernelOut, name));
    if (existing.recipeId === recipeId) { console.log(`unkernel already prepared (release ${pins.tag}).`); return; }
  } catch { /* Missing/incomplete generated output: prepare it. */ }
  const stage = `${unkernelOut}.staging-${process.pid}`;
  await mkdir(join(stage, '_chunks'), { recursive: true });
  try {
    for (const [name, source] of sdk) await cp(join(root, 'node_modules/unkernel', source), join(stage, name));
    const fetchAsset = async name => {
      const response = await fetch(pins.assets[name].url, { signal: AbortSignal.timeout(300000) });
      if (!response.ok) throw new Error(`${name} download failed: HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    };
    const indexBytes = await fetchAsset('distros.json');
    if (sha(indexBytes) !== pins.assets['distros.json'].sha256) throw new Error('distros.json checksum mismatch against the catalog pin.');
    const index = JSON.parse(indexBytes.toString('utf8'));
    const entry = (Array.isArray(index.distros) ? index.distros : []).find(d => d?.name === lock.distro);
    if (!entry) throw new Error(`distros.json has no entry for distro "${lock.distro}".`);
    if (entry.sha256 !== pins.assets[distroFile].sha256) throw new Error(`${distroFile}: distros.json's SHA-256 does not match the catalog pin; re-pin catalog.yaml from distros.json.`);
    const imageBytes = await fetchAsset(distroFile);
    if (sha(imageBytes) !== entry.sha256) throw new Error(`${distroFile} checksum mismatch against distros.json.`);
    if (imageBytes.length !== entry.size) throw new Error(`${distroFile} size mismatch: ${imageBytes.length} bytes, distros.json says ${entry.size}.`);
    const templateBytes = await readFile(join(unkernelCache, 'data-template.kwsparse.gz'));
    if (sha(templateBytes) !== lock.templateSha256) throw new Error('The pre-baked data disk does not match packages.json templateSha256. Re-run scripts/pc/terminal/prebake.mjs and pin the printed SHA-256, or restore the pinned template.');
    await Promise.all([
      writeFile(join(stage, 'distros.json'), indexBytes),
      writeFile(join(stage, distroFile), imageBytes),
      writeFile(join(stage, 'data-template.kwsparse.gz'), templateBytes),
    ]);
    const manifest = { version: 1, recipeId, unkernel: installed.version, release: pins.tag, distro: { name: entry.name, file: entry.file, sha256: entry.sha256, bytes: imageBytes.length }, template: { sha256: lock.templateSha256, bytes: templateBytes.length }, disk: { name: 'webpc-terminal', version: 'v1' }, memoryMiB: 512 };
    await writeFile(join(stage, 'release.json'), JSON.stringify(manifest));
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
  await rm(unkernelOut, { recursive: true, force: true });
  await rename(stage, unkernelOut);
  console.log(`Prepared unkernel guest (release ${pins.tag}); all guest files served locally.`);
}
await prepareUnkernel();
