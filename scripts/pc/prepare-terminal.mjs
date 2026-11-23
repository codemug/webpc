// The unkernel Linux guest: a real Linux kernel compiled to WebAssembly. The page
// hosts the pinned guest files itself because the web SDK ships no downloader (its
// GitHub release assets send no CORS headers). Every load is pinned: the npm pin
// against node_modules, each release asset against its SHA-256 in catalog.yaml,
// the data disk template also against packages.json. Generated files stay out of git.
import { readFile, writeFile, mkdir, cp, rm, rename, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadCatalog, isEnabled, appSources } from '../catalog/catalog.mjs';
import { unkernelPins, validatePackagesLock } from './terminal/plan.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const catalog = loadCatalog(root);
if (!isEnabled(catalog, 'terminal')) { console.log('Skipped terminal: disabled in catalog.yaml.'); process.exit(0); }
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const TEMPLATE_REPO = 'codemug/webpc';
const templateName = 'data-template.kwsparse.gz';
async function prepareUnkernel() {
  const unkernelOut = join(root, 'public/pc/vendor/unkernel');
  const unkernelCache = join(root, 'node_modules/.cache/webpc/unkernel');
  const lockText = await readFile(join(root, 'scripts/pc/terminal/packages.json'), 'utf8');
  const lock = JSON.parse(lockText);
  const lockErrors = validatePackagesLock(lock, { requireTemplateSha: true });
  if (lockErrors.length) throw new Error(`terminal/packages.json is not ready:\n- ${lockErrors.join('\n- ')}`);
  const pins = unkernelPins(appSources(catalog, 'terminal'), lock.distro);
  if (!pins.ok) throw new Error(`catalog.yaml terminal sources are not ready for unkernel:\n- ${pins.errors.join('\n- ')}`);
  const templateSource = appSources(catalog, 'terminal', 'github-release').find(s => s.repo === TEMPLATE_REPO);
  if (!templateSource?.url || typeof templateSource.sha256 !== 'string') throw new Error(`catalog.yaml needs a ${TEMPLATE_REPO} github-release source (url + sha256) for the data disk template.`);
  if (templateSource.sha256 !== lock.templateSha256) throw new Error('The data disk template SHA-256 differs between catalog.yaml and packages.json; re-pin one of them.');
  const installed = JSON.parse(await readFile(join(root, 'node_modules/unkernel/package.json'), 'utf8'));
  if (installed.version !== pins.npm) throw new Error(`Expected unkernel ${pins.npm} (catalog.yaml); found ${installed.version}. Run npm ci.`);
  const distroFile = `${lock.distro}.erofs`;
  const sdk = new Map([['web.mjs', 'dist/web.mjs'], ['_chunks/core.mjs', 'dist/_chunks/core.mjs'], ['unkernel.wasm', 'dist/unkernel.wasm']]);
  const sdkBytes = await Promise.all([...sdk.values()].map(name => readFile(join(root, 'node_modules/unkernel', name))));
  const recipeId = sha(Buffer.concat([Buffer.from(lockText), Buffer.from(JSON.stringify(pins.assets)), Buffer.from(pins.npm), Buffer.from(`${templateSource.url}\n${templateSource.sha256}`), ...sdkBytes, await readFile(fileURLToPath(import.meta.url))]));
  try {
    const existing = JSON.parse(await readFile(join(unkernelOut, 'release.json'), 'utf8'));
    for (const name of [...sdk.keys(), 'distros.json', distroFile, templateName]) await access(join(unkernelOut, name));
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
    // The pre-baked data disk. A local prebake cache is reused only when it already
    // matches the pinned hash; otherwise fetch the release asset and cache it.
    let templateBytes = null;
    try {
      const cached = await readFile(join(unkernelCache, templateName));
      if (sha(cached) === templateSource.sha256) templateBytes = cached;
    } catch { /* No cached template: fetch the release asset. */ }
    if (!templateBytes) {
      const response = await fetch(templateSource.url, { signal: AbortSignal.timeout(300000) });
      if (!response.ok) throw new Error('data disk template download failed: HTTP ' + response.status);
      templateBytes = Buffer.from(await response.arrayBuffer());
      if (sha(templateBytes) !== templateSource.sha256) throw new Error('data disk template checksum mismatch against the catalog pin.');
      await mkdir(unkernelCache, { recursive: true });
      await writeFile(join(unkernelCache, templateName), templateBytes);
    }
    await Promise.all([
      writeFile(join(stage, 'distros.json'), indexBytes),
      writeFile(join(stage, distroFile), imageBytes),
      writeFile(join(stage, templateName), templateBytes),
    ]);
    const manifest = { version: 1, recipeId, unkernel: installed.version, release: pins.tag, distro: { name: entry.name, file: entry.file, sha256: entry.sha256, bytes: imageBytes.length }, template: { sha256: templateSource.sha256, bytes: templateBytes.length }, disk: { name: 'webpc-terminal', version: 'v1' }, memoryMiB: 512 };
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
