// `npm run upgrade` (scheduled workflow) and `npm run upgrade -- --dry-run`.
// Dry run: list what is newer upstream for every enabled app.
// Real run, one app at a time: apply its auto bumps, then validate, test, build and smoke-check
// it. Pass: commit (one commit per app). Fail: restore the tree and report. Needs a clean tree,
// because a failed app is reverted with `git checkout`.
import { appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadCatalog, ROOT } from '../catalog/catalog.mjs';
import { planUpgrades } from './plan.mjs';
import { reportMarkdown } from './report.mjs';
import { applyApp } from './apply.mjs';
import { fetchGithubReleases, fetchNpm, fetchHfHead, fetchApkIndex } from './discover.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const memo = fn => { const cache = new Map(); return key => (cache.has(key) ? cache.get(key) : (cache.set(key, fn(key)), cache.get(key))); };
const network = {
  releases: memo(fetchGithubReleases),
  npm: memo(fetchNpm),
  hfHead: memo(fetchHfHead),
  // The guest installs from main and community; a package may live in either.
  apk: async (branch, arch) => new Map([...await fetchApkIndex(branch, 'community', arch), ...await fetchApkIndex(branch, 'main', arch)]),
};
const run = (cmd, argv) => execFileSync(cmd, argv, { cwd: ROOT, stdio: 'inherit' });
const git = (...argv) => execFileSync('git', argv, { cwd: ROOT, encoding: 'utf8' });
const key = e => `${e.app}#${e.index}#${e.name}`;

function publish(report) {
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  writeFileSync(`${ROOT}upgrade-report.md`, `${report}\n`);
}

function verify(app) {
  run('npm', ['test']); // validates the catalog first (pretest)
  run('npm', ['run', 'build']); // prepares changed apps, builds, prunes disabled apps, checks size
  if (existsSync(`${ROOT}scripts/upgrade/smoke.mjs`)) run('node', ['scripts/upgrade/smoke.mjs', app]);
}

function revert(changed) {
  git('checkout', '--', '.');
  git('clean', '-fdq', '--', 'public/third-party');
  if (changed.includes('package-lock.json')) run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
}

const plan = (await planUpgrades(loadCatalog(), network)).filter(e => !only || e.app === only);
const results = new Map();
if (!dryRun) {
  if (git('status', '--porcelain').trim()) throw new Error('The working tree has changes; commit or stash them first (a failed upgrade is reverted with git checkout).');
  const byApp = Map.groupBy(plan.filter(e => e.auto && !e.error), e => e.app);
  for (const [app, entries] of byApp) {
    const summary = entries.map(e => (e.type === 'alpine' ? `${e.changes.length} Alpine packages` : `${e.name} ${e.from} -> ${e.to}`)).join('; ');
    console.log(`\n=== ${app}: ${summary}`);
    let changed = [];
    try {
      changed = await applyApp(entries, { apk: network.apk });
      verify(app);
      git('add', '--', ...changed, 'public/third-party');
      git('commit', '-q', '-m', `chore(upgrade): ${app}: ${summary}`);
      for (const e of entries) results.set(key(e), { ok: true });
    } catch (error) {
      const reason = String(error.message ?? error).split('\n')[0].slice(0, 160);
      console.error(`${app}: upgrade reverted: ${reason}`);
      revert(changed);
      for (const e of entries) results.set(key(e), { ok: false, reason });
    }
  }
}
publish(reportMarkdown(plan, results));
writeFileSync(`${ROOT}upgrade-plan.json`, `${JSON.stringify(plan, null, 1)}\n`);
if ([...results.values()].some(r => !r.ok)) process.exitCode = 1;
