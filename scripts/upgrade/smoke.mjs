// Headless smoke check of one app on the built site: it loads, reaches its ready state, throws
// no page errors and makes zero requests to any other host.
// Usage: node scripts/upgrade/smoke.mjs <app-id>   (after npm run build; starts its own preview)
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { loadCatalog, ROOT } from '../catalog/catalog.mjs';

const PORT = 4331;
const BASE = `http://127.0.0.1:${PORT}`;

/** Ready state per app: Craft wrappers enable Open on the editor's ready message; Terminal boots Linux. */
export function readiness(app) {
  if (app.id === 'terminal') {
    return async page => {
      await page.getByRole('button', { name: 'Start Linux', exact: true }).click();
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Save session' && !b.disabled), null, { timeout: 180_000 });
      await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.trim().endsWith('webpc:~#'), null, { timeout: 60_000 });
    };
  }
  if (app.sources?.some(s => s.type === 'github-release' && s.repo.startsWith('storytold/'))) {
    return page => page.locator('#open:enabled').waitFor({ state: 'attached', timeout: app.loadTimeout ?? 75_000 });
  }
  // Everything else: the page and all its frames finish loading, then a quiet period for late errors.
  return async page => {
    await page.waitForLoadState('load');
    for (const frame of page.frames()) await frame.waitForLoadState('load');
    await page.waitForTimeout(3000);
  };
}

export async function smoke(app, base = BASE) {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const external = []; const errors = [];
    page.on('request', r => { const url = r.url(); if (/^https?:/.test(url) && new URL(url).origin !== base) external.push(url); });
    page.on('pageerror', e => errors.push(String(e.message ?? e)));
    page.on('dialog', d => d.dismiss());
    const response = await page.goto(`${base}${app.src}`, { waitUntil: 'domcontentloaded' });
    if (!response?.ok()) throw new Error(`${app.src}: HTTP ${response?.status()}`);
    await readiness(app)(page);
    const problems = [...external.map(u => `request to another host: ${u}`), ...errors.map(e => `page error: ${e}`)];
    if (problems.length) throw new Error(`${app.id} smoke check failed:\n- ${problems.slice(0, 10).join('\n- ')}`);
  } finally { await browser.close(); }
}

async function withPreview(fn) {
  const server = spawn('npx', ['astro', 'preview', '--host', '127.0.0.1', '--port', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
  try {
    for (let i = 0; i < 60; i++) {
      if (await fetch(`${BASE}/pc/`).then(r => r.ok, () => false)) return await fn();
      await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error('the preview server did not start');
  } finally { server.kill(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const id = process.argv[2];
  const app = loadCatalog().apps.find(a => a.id === id);
  if (!app) { console.error('usage: node scripts/upgrade/smoke.mjs <app-id>'); process.exit(2); }
  if (app.kind !== 'iframe') { console.log(`${id}: ${app.kind} app, nothing to smoke-check.`); process.exit(0); }
  await withPreview(() => smoke(app));
  console.log(`${id}: smoke check passed (ready, no page errors, no requests to other hosts).`);
}
