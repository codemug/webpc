// Fail the build when dist/ is over budget. GitHub Pages limits a site to 1 GB, and the host
// site adds its own pages, so WebPC keeps a margin.
import { readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from './catalog.mjs';

export const BUDGET_MB = 990;

/** Apparent size in bytes of every regular file under dir (symlinks are not followed). */
export function dirBytes(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += dirBytes(path);
    else if (entry.isFile()) total += lstatSync(path).size;
  }
  return total;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mb = dirBytes(join(ROOT, 'dist')) / 1_000_000;
  console.log(`dist is ${mb.toFixed(0)} MB (budget ${BUDGET_MB} MB).`);
  if (mb > BUDGET_MB) { console.error('dist is over budget: disable an app in catalog.yaml or cut its size.'); process.exit(1); }
}
