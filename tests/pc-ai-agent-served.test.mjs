// Buddy's page loads its modules from /pc/vendor/ai-agent/, which prepare-ai-agent.mjs fills
// from an explicit copy list plus esbuild bundles. A module that is imported but not listed
// 404s in the browser while every unit test (which imports from src/) still passes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const src = new URL('../src/apps/ai-agent/', import.meta.url);
const prepare = readFileSync(new URL('../scripts/pc/prepare-ai-agent.mjs', import.meta.url), 'utf8');
const listed = new Set([...prepare.matchAll(/'([\w.-]+\.(?:js|mjs|css))'/g)].map(m => m[1]));
const bundled = new Set([...prepare.match(/for \(const entry of \[([^\]]+)\]\)/)[1].matchAll(/'([\w.-]+)'/g)].map(m => `runtime/${m[1]}`));

test('every relative import of Buddy page modules is copied or bundled by prepare-ai-agent', () => {
  const missing = [];
  for (const file of readdirSync(src).filter(name => /\.js$/.test(name))) {
    const text = readFileSync(new URL(file, src), 'utf8');
    for (const [, target] of text.matchAll(/(?:from|import\()\s*'\.\/([^']+)'/g)) {
      if (target.startsWith('vendor/')) continue; // fetched or generated vendor files
      if (!listed.has(target) && !bundled.has(target)) missing.push(`${file} imports ./${target}`);
    }
  }
  assert.deepEqual(missing, [], `not served from /pc/vendor/ai-agent/:\n${missing.join('\n')}`);
});
