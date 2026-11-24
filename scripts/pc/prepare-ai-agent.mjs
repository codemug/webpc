// Rebuild an explicit public allowlist; no home-directory source, private configs, or databases.
import { mkdir, readFile, writeFile, copyFile, cp, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { build } from 'esbuild';
import { loadCatalog, isEnabled, appSources } from '../catalog/catalog.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const catalog = loadCatalog(root);
if (!isEnabled(catalog, 'ai-agent')) { console.log('Skipped ai-agent: disabled in catalog.yaml.'); process.exit(0); }
const source = join(root, 'src/apps/ai-agent');
const output = join(root, 'public/pc/vendor/ai-agent');
const cache = join(root, 'node_modules/.cache/webpc/ai-agent');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// BYOK cloud provider (opt-in, per session): the Anthropic SDK is bundled locally with the pinned esbuild
// from the pinned npm package (package-lock.json integrity pins the package), never fetched.
const ANTHROPIC_SDK_VERSION = appSources(catalog, 'ai-agent', 'npm')[0].version;
const sdkEntry = 'export { default as Anthropic } from "@anthropic-ai/sdk";\nexport { APIError, APIConnectionError, APIUserAbortError, AuthenticationError, RateLimitError, BadRequestError } from "@anthropic-ai/sdk";\n';
// CDN artifacts from catalog.yaml cdn-file sources: jsDelivr URL <package>@<version>/<file>, sha256 as the
// checksum. Local name is the file's basename, except idb-keyval: its package file is dist/index.js but the
// app imports the stable name ./vendor/idb-keyval.js, which must not change.
const artifacts = appSources(catalog, 'ai-agent', 'cdn-file').map(s => {
  const base = s.file.split('/').pop();
  return [s.package === 'idb-keyval' ? 'idb-keyval.js' : base, `${s.package}@${s.version}/${s.file}`, s.sha256, s];
});
await mkdir(cache, { recursive: true });
const stage = `${output}.staging-${process.pid}`;
try {
  await mkdir(join(stage, 'vendor'), { recursive: true });
  for (const [name, path, digest, src] of artifacts) {
    let bytes; try { bytes = await readFile(join(cache, name)); } catch {}
    if (!bytes || hash(bytes) !== digest) {
      console.log(`Downloading pinned AI Agent dependency: ${name}`);
      const response = await fetch(`https://cdn.jsdelivr.net/npm/${path}`, { signal: AbortSignal.timeout(180000) });
      if (!response.ok) throw new Error(`AI Agent dependency ${name}: HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    if (hash(bytes) !== digest) throw new Error(`AI Agent dependency checksum mismatch: ${name}`);
    await writeFile(join(cache, name), bytes);
    if (name.endsWith('.wasm')) {
      await writeFile(join(stage, 'vendor', `${name}.parta`), bytes.subarray(0, 14000000));
      await writeFile(join(stage, 'vendor', `${name}.partb`), bytes.subarray(14000000));
    } else if (name === 'Readability.js') {
      const footer = 'if (typeof module === "object") {\n  /* eslint-disable-next-line no-redeclare */\n  /* global module */\n  module.exports = Readability;\n}';
      const text = bytes.toString(); if (!text.includes(footer)) throw new Error('Unexpected Readability export format');
      await writeFile(join(stage, 'vendor/readability.mjs'), `// ${src.package} ${src.version} (Apache-2.0), CommonJS footer replaced with an ESM export.\n` + text.replace(footer, 'export { Readability };'));
    } else await writeFile(join(stage, 'vendor', name), name === 'idb-keyval.js' ? Buffer.concat([Buffer.from(`// ${src.package} ${src.version} (Apache-2.0) ${src.file}\n`), bytes]) : bytes);
  }
  for (const name of ['app.js','agent.js','chrome-ai.js','cloud.js','cloud-client.js','embed-worker.js','exec-client.js','file-tools.js','files-host.js','hf-pin.js','help.js','models.js','model-client.js','search-host.js','search-index.js','storage.js','session.js','threads.js','shared-model.js','vision-tools.js','vision-worker.js','web.js','worker.js','sandbox.js','styles.css']) await copyFile(join(source, name), join(stage, name));
  // markdown.js imports bare mdast package names, so it is bundled (same pinned esbuild) instead
  // of copied: app.js keeps importing the served ./markdown.js.
  await build({ entryPoints: [join(source, 'markdown.js')], bundle: true, format: 'esm', minify: true, platform: 'browser', target: 'es2022', outfile: join(stage, 'markdown.js'), logLevel: 'silent', legalComments: 'inline' });
  // Shared Files app modules (AI-2 grants), copied verbatim from src so the same-origin vendor page can import them.
  for (const name of ['store.mjs','picker.mjs']) await copyFile(join(root, 'src/scripts/pc/files', name), join(stage, name));
  // Agent runtime: meta tools, catalog, skills, search indexes and every enabled pack, bundled to the
  // same relative path session.js and app.js import (runtime/index.mjs), so source and served layouts match.
  for (const entry of ['index.mjs', 'files-ctx.mjs', 'scheduler.mjs']) await build({ entryPoints: [join(source, 'runtime', entry)], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile: join(stage, 'runtime', entry), logLevel: 'silent', legalComments: 'inline' });
  let sdkBundleSha256;
  { // Anthropic SDK browser bundle from the pinned npm package (deterministic: pinned esbuild + pinned package).
    const sdk = JSON.parse(await readFile(join(root, 'node_modules/@anthropic-ai/sdk/package.json'), 'utf8'));
    if (sdk.version !== ANTHROPIC_SDK_VERSION) throw new Error(`Anthropic SDK version ${sdk.version} does not match the catalog pin ${ANTHROPIC_SDK_VERSION}`);
    await build({
      stdin: { contents: sdkEntry, resolveDir: root, sourcefile: 'anthropic-sdk-entry.mjs' },
      bundle: true, platform: 'browser', format: 'esm', minify: true, target: 'es2022',
      outfile: join(stage, 'vendor/anthropic-sdk.mjs'), define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
    });
    // Lead ruling: no bundle-hash gate — package-lock.json integrity pins the package and esbuild is pinned.
    sdkBundleSha256 = hash(await readFile(join(stage, 'vendor/anthropic-sdk.mjs')));
  }
  await copyFile(join(root, 'public/third-party/ai-agent/NOTICE.txt'), join(stage, 'NOTICE.txt'));
  await cp(join(root, 'public/third-party/ai-agent/licenses'), join(stage, 'licenses'), { recursive: true });
  await writeFile(join(stage, 'release.json'), JSON.stringify({ artifacts: [...artifacts.map(([file, path, sha256]) => ({ file, url: `https://cdn.jsdelivr.net/npm/${path}`, sha256 })), { file: 'vendor/anthropic-sdk.mjs', url: `https://www.npmjs.com/package/@anthropic-ai/sdk/v/${ANTHROPIC_SDK_VERSION}`, sha256: sdkBundleSha256, note: 'esbuild browser bundle of the pinned npm package (hash for information; the package is pinned by package-lock.json integrity)' }] }, null, 2));
  await rm(output, { recursive: true, force: true }); await rename(stage, output);
} finally { await rm(stage, { recursive: true, force: true }); }
console.log('Prepared AI Agent static sources and verified local runtime (no model weights).');
