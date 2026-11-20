// Prepare prebuilt static web apps into public/pc/vendor/<id>/; the table below is the extension point.
// Pins come from catalog.yaml (version = tag minus a leading v, url, sha256, licence pin):
// no row hard-codes a version, URL or checksum. Reuse rules from prepare-cyberchef.mjs /
// prepare-craft.mjs: verify the digest before extraction, reject unsafe archive paths, stage
// then swap, keep licence files in public/third-party/<id>/.
// The skip marker also carries a fingerprint (hash of this file's source plus the row's injected file),
// so preparer or tweak changes force a re-preparation.
import { mkdir, readFile, writeFile, rename, rm, readdir, copyFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadCatalog, appSources, isEnabled } from '../catalog/catalog.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cache = join(root, 'node_modules/.cache/webpc/static');
const preparerSource = await readFile(fileURLToPath(import.meta.url), 'utf8');

// Absolute paths, backslashes and parent-directory traversal are unsafe to extract into vendor output.
export function isUnsafeArchivePath(name) {
  return name.startsWith('/') || name.includes('\\') || name.split('/').includes('..');
}

// Pure (takes source texts), so tests can exercise it: sha256 of the preparer source + each injected file.
export function rowFingerprint(source, injected = []) {
  const hash = createHash('sha256').update(source);
  for (const text of injected) hash.update('\0').update(text);
  return hash.digest('hex');
}

// Row shape: id, title, notice (WEBPC.txt body), optional tweak (payloadDir) => {}, optional
// inject { name, src }. Version, URL, SHA-256, upstream and the licence pin come from
// catalog.yaml and are merged in by staticPlan (imported by other preparers for
// rowFingerprint, so nothing here may run at import time).
export const staticApps = [
  {
    id: 'sqliteviz',
    title: 'SQLiteViz',
    notice: 'Official Vite build, unmodified. All asset URLs are relative, so it serves from the /pc/vendor/sqliteviz/ sub-path. The bundled service worker is scoped to /pc/vendor/sqliteviz/ and only precaches its own assets. Map charts can fetch tiles and fonts from public map tile servers when the user creates a map (user-initiated, like CyberChef URL-fetch operations). See docs/webpc/static-apps.md.',
  },
  {
    id: 'beepbox',
    title: 'BeepBox',
    notice: 'Official release bundle (MIT; the release ZIP ships no licence file, so the repo LICENSE.md at the pinned tag is pinned by SHA-256 and copied here). WebPC removes the Google Fonts stylesheet (the UI falls back to system sans-serif), removes the service-worker registration (upstream requests scope "/" and would precache a third-party CDN, shadowing the whole site if it could install), prunes the files nothing loads (unminified editor, minified synth, beepbox_offline.html, index_debug.html, source maps, macOS .DS_Store — the About link to beepbox_offline.html 404s by design), keeps player/ (the "View in Song Player" menu item and copied HTML embeds point at it at runtime) with its Google Fonts link stripped, and injects webpc-audio-guard.js before the app scripts so the WebPC wrapper can pause and suspend audio when its window closes. The song stays in the URL hash; the WebPC wrapper mirrors it to localStorage. Share-menu shortener links (tinyurl, is.gd, …) and the PayPal donation form only send data when the user explicitly submits them. See docs/webpc/static-apps.md.',
    inject: { name: 'webpc-audio-guard.js', src: 'scripts/pc/static-apps/audio-guard.js' },
    tweak: tweakBeepBox,
  },
];

// Pure (unit-tested): every enabled row merged with its catalog pin. Rows whose release ZIP
// ships no licence file get the repo licence fetched from the raw tag path, pinned by SHA-256.
export function staticPlan(catalog) {
  return staticApps.filter(row => isEnabled(catalog, row.id)).map(row => {
    const source = appSources(catalog, row.id, 'github-release')[0];
    if (!source) throw new Error(`${row.id}: catalog.yaml has no github-release source`);
    const license = source.license ? { name: source.license.path, sha256: source.license.sha256, url: `https://raw.githubusercontent.com/${source.repo}/${source.tag}/${source.license.path}` } : null;
    return { ...row, version: String(source.tag).replace(/^v/, ''), url: source.url, sha256: source.sha256, upstream: `https://github.com/${source.repo}`, license };
  });
}

// BeepBox tweaks. Each find/replace fails loudly: a missing string means upstream changed.
async function tweakBeepBox(payload) {
  const html = join(payload, 'index.html');
  let text = await readFile(html, 'utf8');
  const font = '<link href="https://fonts.googleapis.com/css?family=Roboto" rel="stylesheet" rel="stylesheet" media="none" onload="if (this.media != \'all\') this.media=\'all\';" />';
  if (!text.includes(font)) throw new Error('beepbox: Google Fonts link not found; upstream changed, refusing to prepare.');
  if (text.split('<head>').length !== 2) throw new Error('beepbox: index.html must contain <head> exactly once; upstream changed, refusing to prepare.');
  text = text.replace(font, '').replace('<head>', '<head>\n\t<script src="./webpc-audio-guard.js"></script>');
  await writeFile(html, text);
  const js = join(payload, 'beepbox_editor.min.js');
  const code = await readFile(js, 'utf8');
  const sw = '"serviceWorker"in navigator&&navigator.serviceWorker.register("/service_worker.js",{updateViaCache:"all",scope:"/"}).catch((()=>{}))';
  if (!code.includes(sw)) throw new Error('beepbox: service-worker registration not found; upstream changed, refusing to prepare.');
  const tweaked = code.replace(sw, 'false');
  new Script(tweaked); // syntax-check the tweaked bundle before it can be served
  await writeFile(js, tweaked);
  // Prune the files nothing loads: they would stay publicly reachable even though no page
  // fetches them (unminified editor, minified synth, offline/debug pages, source maps, macOS
  // junk). The minified synth is unreferenced (editor and player bundles inline the synth; the
  // About example page uses the UNminified one), so it goes, but beepbox_synth.js and
  // synth_example.html stay: index.html's About section links to the example page.
  for (const junk of ['beepbox_editor.js', 'beepbox_synth.min.js', 'beepbox_offline.html', 'index_debug.html', 'service_worker.js', '.DS_Store']) await rm(join(payload, junk), { force: true });
  const pruneMaps = async dir => { for (const entry of await readdir(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) await pruneMaps(path); else if (entry.name.endsWith('.map')) await rm(path, { force: true }); } };
  await pruneMaps(payload);
  // player/ stays: the bundle builds "View in Song Player" and copied HTML embeds at runtime,
  // pointing at player/#song=... Strip its Google Fonts link, fail loudly.
  const playerHtml = join(payload, 'player', 'index.html');
  const playerText = await readFile(playerHtml, 'utf8');
  if (!playerText.includes(font)) throw new Error('beepbox: player Google Fonts link not found; upstream changed, refusing to prepare.');
  await writeFile(playerHtml, playerText.replace(font, ''));
}

async function notices(dir, target, relative = '') {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name), rel = join(relative, entry.name);
    if (entry.isDirectory()) await notices(path, target, rel);
    else if (/^(LICENSE|NOTICE)|\.LICEN[CS]E(?:\.txt)?$/i.test(entry.name)) {
      await mkdir(join(target, relative), { recursive: true });
      await copyFile(path, join(target, rel));
    }
  }
}

async function prepare(app) {
  const injected = app.inject ? [await readFile(join(root, app.inject.src), 'utf8')] : [];
  const fingerprint = rowFingerprint(preparerSource, injected);
  const output = join(root, 'public/pc/vendor', app.id);
  const marker = join(output, '.release.json');
  try {
    const installed = JSON.parse(await readFile(marker, 'utf8'));
    await access(join(output, 'index.html'));
    if (installed.sha256 === app.sha256 && installed.fingerprint === fingerprint) { console.log(`${app.title} ${app.version} already prepared.`); return; }
  } catch { /* First build or incomplete cache: verify and extract below. */ }
  await mkdir(cache, { recursive: true });
  const zip = join(cache, `${app.id}-${app.version}.zip`);
  let bytes;
  try { bytes = await readFile(zip); } catch {
    console.log(`Downloading ${app.title} ${app.version}…`);
    const response = await fetch(app.url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`${app.id}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (createHash('sha256').update(bytes).digest('hex') !== app.sha256) throw new Error(`${app.id}: checksum mismatch; no assets replaced.`);
  await writeFile(zip, bytes);
  const names = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n');
  if (names.some(isUnsafeArchivePath)) throw new Error(`${app.id}: unsafe archive path`);
  await mkdir(join(root, 'public/pc/vendor'), { recursive: true });
  const stage = `${output}.staging-${process.pid}`;
  await mkdir(stage, { recursive: true });
  try {
    execFileSync('unzip', ['-q', zip, '-d', stage]);
    // Payload is the single top-level directory when the zip wraps one (__MACOSX junk aside), otherwise the zip root.
    const entries = (await readdir(stage, { withFileTypes: true })).filter(entry => entry.name !== '__MACOSX');
    const payload = entries.length === 1 && entries[0].isDirectory() ? join(stage, entries[0].name) : stage;
    try { await access(join(payload, 'index.html')); } catch { throw new Error(`${app.id}: index.html not found in zip payload`); }
    if (app.tweak) await app.tweak(payload);
    if (app.inject) await writeFile(join(payload, app.inject.name), injected[0]);
    const thirdParty = join(root, 'public/third-party', app.id);
    await mkdir(thirdParty, { recursive: true });
    await notices(payload, thirdParty);
    if (app.license) {
      const response = await fetch(app.license.url, { signal: AbortSignal.timeout(60000) });
      const license = Buffer.from(await response.arrayBuffer());
      if (createHash('sha256').update(license).digest('hex') !== app.license.sha256) throw new Error(`${app.id}: licence checksum mismatch; not copied.`);
      await writeFile(join(thirdParty, app.license.name), license);
    }
    await writeFile(join(thirdParty, 'WEBPC.txt'), `${app.title} ${app.version}\nUpstream: ${app.upstream}\nRelease: ${app.url}\nSHA-256: ${app.sha256}\n${app.notice}\n`);
    await writeFile(join(payload, '.release.json'), JSON.stringify({ version: app.version, sha256: app.sha256, url: app.url, fingerprint }));
    await rm(output, { recursive: true, force: true });
    await rename(payload, output);
  } finally { await rm(stage, { recursive: true, force: true }); }
  console.log(`Prepared ${app.title} ${app.version}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const catalog = loadCatalog();
  const planned = new Map(staticPlan(catalog).map(app => [app.id, app]));
  for (const row of staticApps) {
    const app = planned.get(row.id);
    if (!app) { console.log(`Skipped ${row.id}: disabled in catalog.yaml.`); continue; }
    await prepare(app);
  }
}
