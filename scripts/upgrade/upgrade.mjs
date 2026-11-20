// `npm run upgrade -- --dry-run`: list what is newer upstream for every enabled app.
// (The apply, verify and commit loop lands in the next step of M2.)
import { appendFileSync, writeFileSync } from 'node:fs';
import { loadCatalog } from '../catalog/catalog.mjs';
import { planUpgrades } from './plan.mjs';
import { reportMarkdown } from './report.mjs';
import { fetchGithubReleases, fetchNpm, fetchHfHead, fetchApkIndex } from './discover.mjs';

const args = new Set(process.argv.slice(2));
const memo = fn => { const cache = new Map(); return key => (cache.has(key) ? cache.get(key) : (cache.set(key, fn(key)), cache.get(key))); };
const network = {
  releases: memo(fetchGithubReleases),
  npm: memo(fetchNpm),
  hfHead: memo(fetchHfHead),
  // The guest installs from main and community; a package may live in either.
  apk: async (branch, arch) => new Map([...await fetchApkIndex(branch, 'community', arch), ...await fetchApkIndex(branch, 'main', arch)]),
};

const catalog = loadCatalog();
const plan = await planUpgrades(catalog, network);
const report = reportMarkdown(plan);
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
writeFileSync('upgrade-plan.json', `${JSON.stringify(plan, null, 1)}\n`);
if (!args.has('--dry-run')) {
  console.error('Only --dry-run is implemented so far.');
  process.exit(2);
}
