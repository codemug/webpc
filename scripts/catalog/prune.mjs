// Prune dist/ output of apps that catalog.yaml has disabled: after `astro build`, a disabled
// app must ship no bytes. Run directly it loads the catalog and prunes dist/.
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog, ROOT } from './catalog.mjs';

// Same shape validateCatalog enforces for app ids; the check keeps rm() inside dist/ even for a
// hand-built catalog object passed to prune().
const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/;

/** Remove dist/pc/apps/<id>/, dist/pc/vendor/<id>/ and dist/third-party/<id>/ for each disabled
 *  app of the catalog (enabled apps and everything else are never touched). Returns the removed
 *  dist-relative paths, in catalog order. */
export async function prune(root, catalog) {
  const removed = [];
  for (const app of catalog.apps) {
    if (app.enabled) continue;
    if (!SAFE_ID.test(app.id)) throw new Error(`prune: refusing unsafe app id "${app.id}"`);
    for (const dir of [`pc/apps/${app.id}`, `pc/vendor/${app.id}`, `third-party/${app.id}`]) {
      const path = join(root, 'dist', dir);
      try { await stat(path); } catch { continue; } // never built: nothing to remove
      await rm(path, { recursive: true, force: true });
      removed.push(`dist/${dir}`);
    }
  }
  return removed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const removed = await prune(ROOT, loadCatalog());
  console.log(`prune: removed ${removed.length ? removed.join(', ') : 'nothing (no disabled app has dist output)'} from dist/.`);
}
