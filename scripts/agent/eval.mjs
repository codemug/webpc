#!/usr/bin/env node
// M6 real-model eval runner. Drives real Buddy in Chrome (WebGPU) against a RUNNING preview.
// It starts nothing itself: a preview must already be serving the desktop at --base.
//
//   node scripts/agent/eval.mjs --model lfm3-1.7b --set A [--limit N] [--base http://127.0.0.1:4333]
//
// Per task it: opens a NEW chat, runs the runner-driven setup (close_all / open_app / seed_file),
// types the prompt, waits for the run to finish (120 s cap), reads the ?eval=1 tool trace, and
// evaluates the end-state check. Results go to tests/agent-eval/results/<model>-<set>-<ts>.json.
import { chromium } from '@playwright/test';
import { parse } from 'yaml';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const PROFILE = '/tmp/webpc-eval-profile'; // persistent: model downloads are cached across runs
const DONE_TIMEOUT = 120_000; // per-run cap
const READY_TIMEOUT = 60_000; // app-load cap for a single appWindow

const USAGE = 'usage: node scripts/agent/eval.mjs --model <key> (--set <A|B|C|D> | --task <id>) [--limit N] [--prefetch on|off] [--base http://127.0.0.1:4333]';

function parseArgs(argv) {
  const out = { model: 'lfm3-1.7b', set: null, limit: Number.POSITIVE_INFINITY, base: 'http://127.0.0.1:4333' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') out.model = argv[++i];
    else if (a === '--set') out.set = argv[++i];
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--base') out.base = argv[++i];
    else if (a === '--task') out.task = argv[++i];
    else if (a === '--prefetch') out.prefetch = argv[++i]; // on: the eval-only ?prefetch=1 switch (Buddy's default is off)
    else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
  }
  return out;
}

// ---- pure helpers (no browser) ---------------------------------------------

/** The ordered sequence of catalog tool invocations implied by a trace: a direct
 *  catalog-tool name, or the `tool` argument of a call_tool. Meta tools are skipped. */
function catalogToolSequence(trace, catalogNames) {
  const seq = [];
  for (const entry of trace) {
    if (catalogNames.has(entry.name)) { seq.push(entry.name); continue; }
    if (entry.name === 'call_tool') {
      const tool = entry.arguments?.tool;
      if (typeof tool === 'string' && catalogNames.has(tool)) seq.push(tool);
    }
  }
  return seq;
}

// Tools that do the same job count as one in expect.tools (the end-state check still decides
// the content): set_cell and set_cells both write cells (B02, B03, B05 passed their checks).
const SAME_JOB = { 'gridcraft.set_cell': 'gridcraft.set_cells' };
const jobOf = name => SAME_JOB[name] ?? name;

/** true when `needle` is an in-order subsequence of `haystack`. */
function isSubsequence(needle, haystack) {
  let i = 0;
  for (const item of haystack) if (i < needle.length && item === needle[i]) i++;
  return i === needle.length;
}

/** Median of a number list (0 for an empty list). */
function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// webpc-files/ is the OPFS root the agent's files tools and the Files app both use. The tiny
// handle helpers are inlined into each page.evaluate (Playwright serialises each function on
// its own, so they cannot be shared as an outer scope or an eval'd string).
const FILES_ROOT = 'webpc-files';

/** Write a text file into the shared Files area (the runner-driven seed_file step). */
export async function seedFile(page, path, text) {
  return page.evaluate(async ({ path, text, root }) => {
    const openDir = (h, n, c) => (h.getDirectory ? h.getDirectory(n, { create: c }) : h.getDirectoryHandle(n, { create: c }));
    const openFile = (h, n, c) => (h.getFile ? h.getFile(n, { create: c }) : h.getFileHandle(n, { create: c }));
    const parts = String(path).replace(/^\/+/, '').split('/').filter(Boolean);
    const base = parts.pop();
    let dir = await openDir(await navigator.storage.getDirectory(), root, true);
    for (const seg of parts) dir = await openDir(dir, seg, true);
    const file = await openFile(dir, base, true);
    const handle = await file.createWritable();
    await handle.write(text);
    await handle.close();
    return { seeded: path };
  }, { path, text, root: FILES_ROOT });
}

/** Empty the shared Files area, so a task never sees files an earlier task or run left behind. */
export async function clearFiles(page) {
  return page.evaluate(async (root) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(root, { create: true });
    const names = []; for await (const name of dir.keys()) names.push(name);
    for (const name of names) await dir.removeEntry(name, { recursive: true });
    return { removed: names.length };
  }, FILES_ROOT);
}

/** Close every open desktop window (force), for a clean start. */
export async function closeAll(page) {
  return page.evaluate(async () => {
    const host = window.pcHost;
    if (!host) return { closed: 0, error: 'pcHost is not installed (is the desktop page loaded?)' };
    const wins = await host.windows();
    let closed = 0;
    for (const win of wins) { try { await host.close(win.id, { force: true }); closed++; } catch { /* already gone */ } }
    return { closed };
  });
}

/**
 * Give an app a clean document, so a task never sees what an earlier task left: closing the
 * window does not clear the app's model (B10 read B09's "Hello"; B06 hit B04's table).
 */
export async function resetApp(page, id) {
  return page.evaluate(async ({ id, timeoutMs }) => {
    const wrapper = await window.pcHost.appWindow(id, { timeoutMs });
    if (id === 'gridcraft') { const win = wrapper.document.getElementById('editor').contentWindow; let api = null; for (let i = 0; i < 300 && !api; i++) { api = win.gridcraft; if (!api) await new Promise((r) => setTimeout(r, 100)); } await api.execute('file.new', {}); }
    else if (id === 'docs') wrapper.webpcDocs.createDocument({ title: 'Untitled document', sections: [] });
    else if (id === 'excalidraw') { const win = wrapper.document.getElementById('excalidraw-frame').contentWindow; let api = null; for (let i = 0; i < 300 && !api; i++) { api = win.webpcExcalidraw?.api; if (!api) await new Promise((r) => setTimeout(r, 100)); } api.resetScene(); }
    return { reset: id };
  }, { id, timeoutMs: READY_TIMEOUT });
}
const STATEFUL = new Set(['gridcraft', 'docs', 'excalidraw']);

/** Open an app window and wait until it posts pc:ready. */
export async function openApp(page, id) {
  return page.evaluate(async ({ id, timeoutMs }) => {
    const host = window.pcHost;
    if (!host) return { error: 'pcHost is not installed' };
    await host.open(id);
    try { await host.appWindow(id, { timeoutMs }); }
    catch (error) { return { error: 'app did not finish loading: ' + error.message }; }
    return { opened: id };
  }, { id, timeoutMs: READY_TIMEOUT });
}

// ---- end-state checks (each returns { ok, detail }) -------------------------

export async function checkWindowOpen(page, app) {
  const ok = await page.evaluate(async (id) => {
    const host = window.pcHost;
    if (!host) return false;
    const wins = await host.windows();
    return wins.some((w) => w.id === id);
  }, app);
  return { ok, detail: `window ${app} ${ok ? 'open' : 'not open'}` };
}

export async function checkTheme(page, expected) {
  const theme = await page.evaluate(async () => {
    const host = window.pcHost;
    return host ? host.theme() : Promise.resolve(document.documentElement.dataset.theme ?? 'dark');
  });
  return { ok: theme === expected, detail: `theme is ${theme}, wanted ${expected}` };
}

export async function checkFileExists(page, path) {
  const ok = await page.evaluate(async ({ path, root }) => {
    const openDir = (h, n, c) => (h.getDirectory ? h.getDirectory(n, { create: c }) : h.getDirectoryHandle(n, { create: c }));
    const openFile = (h, n, c) => (h.getFile ? h.getFile(n, { create: c }) : h.getFileHandle(n, { create: c }));
    const parts = String(path).replace(/^\/+/, '').split('/').filter(Boolean);
    const base = parts.pop();
    try { // a missing folder or file is a failed check, not a harness error
      let dir = await openDir(await navigator.storage.getDirectory(), root, false);
      for (const seg of parts) dir = await openDir(dir, seg, false);
      try { await openFile(dir, base, false); return true; } catch { await openDir(dir, base, false); return true; } // a folder counts (A04: files.mkdir /Reports)
    } catch { return false; }
  }, { path, root: FILES_ROOT });
  return { ok, detail: `${path} ${ok ? 'exists' : 'missing'}` };
}

export async function checkFileContains(page, path, text) {
  const ok = await page.evaluate(async ({ path, text, root }) => {
    const openDir = (h, n, c) => (h.getDirectory ? h.getDirectory(n, { create: c }) : h.getDirectoryHandle(n, { create: c }));
    const openFile = (h, n, c) => (h.getFile ? h.getFile(n, { create: c }) : h.getFileHandle(n, { create: c }));
    const parts = String(path).replace(/^\/+/, '').split('/').filter(Boolean);
    const base = parts.pop();
    let file;
    try {
      let dir = await openDir(await navigator.storage.getDirectory(), root, false);
      for (const seg of parts) dir = await openDir(dir, seg, false);
      file = await openFile(dir, base, false);
    } catch { return false; }
    const blob = await file.getFile();
    const content = await blob.text();
    return content.includes(text);
  }, { path, text, root: FILES_ROOT });
  return { ok, detail: `${path} ${ok ? 'contains' : 'does not contain'} ${JSON.stringify(text)}` };
}

export async function checkCell(page, { app, cell, input }) {
  const ok = await page.evaluate(async ({ app, cell, input, timeoutMs }) => {
    const host = window.pcHost;
    if (!host) return false;
    let wrapper;
    try { wrapper = await host.appWindow(app, { timeoutMs }); } catch { return false; }
    const win = wrapper?.document?.getElementById?.('editor')?.contentWindow;
    if (!win) return false;
    let api = null;
    for (let i = 0; i < 300 && !api; i++) { api = win[app]; if (!api) await new Promise((r) => setTimeout(r, 100)); }
    if (!api) return false;
    let res;
    try { res = await api.execute('cell.get', { cell }); } catch { return false; }
    const want = String(input).trim();
    const candidates = [res?.input, res?.value, res?.display, res?.text, res?.formula].filter((v) => v != null).map((v) => String(v).trim());
    return candidates.includes(want);
  }, { app, cell, input, timeoutMs: READY_TIMEOUT });
  return { ok, detail: `${app}!${cell} ${ok ? '=' : '!='} ${JSON.stringify(input)}` };
}

export async function checkDocsContains(page, text) {
  const ok = await page.evaluate(async ({ text, timeoutMs }) => {
    const host = window.pcHost;
    if (!host) return false;
    let wrapper;
    try { wrapper = await host.appWindow('docs', { timeoutMs }); } catch { return false; }
    const ed = wrapper?.webpcDocs;
    const doc = ed?.getEditorRef?.()?.getState?.()?.doc;
    if (!doc) return false;
    let all = '';
    doc.descendants((node) => { if (node.isText) all += node.text + ' '; });
    return all.includes(text);
  }, { text, timeoutMs: READY_TIMEOUT });
  return { ok, detail: `docs ${ok ? 'contains' : 'does not contain'} ${JSON.stringify(text)}` };
}

export async function checkExcalidrawCount(page, n) {
  const ok = await page.evaluate(async ({ n, timeoutMs }) => {
    const host = window.pcHost;
    if (!host) return false;
    let wrapper;
    try { wrapper = await host.appWindow('excalidraw', { timeoutMs }); } catch { return false; }
    const win = wrapper?.document?.getElementById?.('excalidraw-frame')?.contentWindow;
    if (!win) return false;
    let api = null;
    for (let i = 0; i < 300 && !api; i++) { api = win.webpcExcalidraw?.api; if (!api) await new Promise((r) => setTimeout(r, 100)); }
    if (!api) return false;
    const elements = await api.getSceneElements();
    return elements.filter((e) => !e.isDeleted).length >= n;
  }, { n, timeoutMs: READY_TIMEOUT });
  return { ok, detail: `excalidraw elements >= ${n}: ${ok ? 'yes' : 'no'}` };
}

/** The model's bake leaves no readable app state, so the runner reads the actual output
 *  from the ?eval=1 trace: the last cyberchef.bake call's result (call_tool wraps it as
 *  { ok, tool, result: { output } }). */
export function checkCyberchefOutput(trace, expected) {
  const entry = [...trace].reverse().find((e) => e.name === 'cyberchef.bake' || (e.name === 'call_tool' && e.arguments?.tool === 'cyberchef.bake'));
  const output = entry?.result?.result?.output;
  const ok = typeof output === 'string' && output.trim() === String(expected).trim();
  return { ok, detail: ok ? 'bake output matches' : `no matching bake output (got ${JSON.stringify(output ?? null)})` };
}

/** The guest's real output, read from the ?eval=1 trace: the last terminal.run call's result
 *  (call_tool wraps it as { ok, tool, result: { exitCode, output } }). */
export function checkTerminalOutput(trace, expected) {
  const entry = [...trace].reverse().find((e) => e.name === 'terminal.run' || (e.name === 'call_tool' && e.arguments?.tool === 'terminal.run'));
  const output = entry?.result?.result?.output;
  const ok = typeof output === 'string' && output.includes(String(expected));
  return { ok, detail: ok ? `terminal output contains ${JSON.stringify(expected)}` : `no terminal output containing ${JSON.stringify(expected)} (got ${JSON.stringify(output ?? null)})` };
}

/** Dispatch a task's single end-state check. */
async function runCheck(page, trace, check) {
  if (check == null || typeof check !== 'object') return { ok: false, detail: 'no check defined' };
  const [kind, value] = Object.entries(check)[0] ?? [];
  switch (kind) {
    case 'window_open': return checkWindowOpen(page, value);
    case 'theme': return checkTheme(page, value);
    case 'file_exists': return checkFileExists(page, value);
    case 'file_contains': return checkFileContains(page, value.path, value.text);
    case 'cell': return checkCell(page, value);
    case 'docs_text_contains': return checkDocsContains(page, value);
    case 'excalidraw_count_at_least': return checkExcalidrawCount(page, value);
    case 'cyberchef_output': return checkCyberchefOutput(trace, value);
    case 'terminal_output': return checkTerminalOutput(trace, value);
    default: return { ok: false, detail: `unsupported check kind ${kind}` };
  }
}

// ---- main ------------------------------------------------------------------

async function main() {
  const { model, set, limit, base, task: only, prefetch = 'off' } = parseArgs(process.argv.slice(2));
  if (!set && !only) { console.error('--set or --task is required.\n' + USAGE); process.exit(1); }

  const allTasks = parse(readFileSync(join(ROOT, 'tests/agent-eval/tasks.yaml'), 'utf8')).tasks;
  const catalog = JSON.parse(readFileSync(join(ROOT, 'src/apps/ai-agent/generated/catalog.json'), 'utf8'));
  const catalogNames = new Set(catalog.tools.map((t) => t.name));
  let tasks = allTasks.filter((t) => (only ? t.id === only : t.set === set));
  tasks = tasks.slice(0, limit);
  if (!tasks.length) { console.error(`no tasks for set ${set}`); process.exit(1); }

  console.log(`eval: model=${model} set=${set ?? only} tasks=${tasks.length} base=${base}`);

  const ctx = await chromium.launchPersistentContext(PROFILE, { channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] });
  const page = await ctx.newPage();
  page.setDefaultTimeout(0);
  await page.goto(`${base}/pc/`);
  await page.locator('[data-buddy-toggle]').click();
  let buddy = null; // Playwright has no waitForFrame: poll the page's frames for Buddy's document
  for (let i = 0; i < 300 && !buddy; i++) { buddy = page.frames().find((f) => f.url().includes('/pc/apps/ai-agent/')) ?? null; if (!buddy) await page.waitForTimeout(100); }
  if (!buddy) throw new Error('the Buddy panel frame did not appear within 30 s');
  // The hook reads location.search, which a route rewrite does not change: load the Buddy
  // document itself with ?eval=1 (the panel keeps this frame, so later chats keep the flag).
  // Start from no saved chats. Buddy keeps at most 200 (threads.js MAX_THREADS); past that,
  // New chat fails and every later task would run inside one shared chat, where the model
  // copies earlier tasks' calls (this skewed the runs of 2026-11-21 and 22).
  await buddy.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('keyval-store'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    if (db.objectStoreNames.contains('keyval')) {
      const keys = await new Promise((res, rej) => { const r = db.transaction('keyval').objectStore('keyval').getAllKeys(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const tx = db.transaction('keyval', 'readwrite');
      for (const key of keys) if (String(key).startsWith('buddy:thread')) tx.objectStore('keyval').delete(key);
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    }
    db.close(); localStorage.removeItem('buddy:openThread');
  });
  await buddy.goto(buddy.url(), { waitUntil: 'domcontentloaded' });
  if (!new URL(buddy.url()).searchParams.get('eval')) { const u = new URL(buddy.url()); u.searchParams.set('eval', '1'); if (prefetch === 'on') u.searchParams.set('prefetch', '1'); await buddy.goto(u.toString(), { waitUntil: 'domcontentloaded' }); }

  // Select and load the model once; wait until the model state says it is ready (Send stays
  // disabled while the box is empty, so it is no longer the ready signal).
  await buddy.waitForFunction(() => { const s = document.querySelector('#load-model'); return s && !s.disabled; }, null, { timeout: 60_000, polling: 250 });
  await buddy.locator('#model').selectOption(model);
  await buddy.locator('#load-model').click();
  await buddy.waitForFunction(() => /^(Ready|Cloud|Chrome)/.test(document.querySelector('#model-state')?.textContent ?? ''), null, { timeout: 300_000, polling: 500 });
  console.log(`model ${model} loaded and ready`);
  // The ?eval=1 hook must be live, or every task's tool trace would be empty and the run meaningless.
  const hookOn = await buddy.evaluate(() => Array.isArray(window.__buddyTrace));
  if (!hookOn) {
    console.error('FATAL: the ?eval=1 trace hook is not active (window.__buddyTrace missing). Check that the prepared app.js is current and the Buddy document loaded with ?eval=1.');
    await ctx.close();
    process.exit(1);
  }

  const results = [];
  for (const task of tasks) {
    const started = Date.now();
    const row = { id: task.id, set: task.set, pass: false, tools: { seen: [], missing: [], pass: false }, checks: null, seconds: 0, rounds: 0, error: null };
    try {
      // Setup: clean desktop, then the task's steps.
      await closeAll(page);
      await clearFiles(page);
      for (const step of task.setup ?? []) {
        if (step.close_all) await closeAll(page);
        else if (step.open_app) { await openApp(page, step.open_app); if (STATEFUL.has(step.open_app)) await resetApp(page, step.open_app); }
        else if (step.seed_file) await seedFile(page, step.seed_file.path, step.seed_file.text);
      }
      // New chat, clear the trace, type the prompt, send.
      await buddy.locator('#new-chat').click();
      // A task must start in an empty chat: no messages and no "chat limit" error.
      try { await buddy.waitForFunction(() => document.querySelectorAll('#messages article.message').length === 0 && !document.getElementById('error')?.textContent.trim(), null, { timeout: 10_000, polling: 100 }); }
      catch { const why = await buddy.evaluate(() => `${document.querySelectorAll('#messages article.message').length} messages; error: ${document.getElementById('error')?.textContent.trim() || 'none'}`); throw Object.assign(new Error(`FATAL: New chat did not start an empty chat (${why})`), { fatal: true }); }
      await buddy.evaluate(() => { if (window.__buddyTrace) window.__buddyTrace.length = 0; });
      await buddy.locator('#message').fill(task.prompt);
      await buddy.locator('#send').click();
      // Wait for the run to finish (the model state leaves "Working" when the active run ends), 120 s cap.
      try { await buddy.waitForFunction(() => /^Working/.test(document.querySelector('#model-state')?.textContent ?? ''), null, { timeout: 8_000, polling: 100 }); } catch { /* finished before we sampled */ }
      await buddy.waitForFunction(() => !/^Working/.test(document.querySelector('#model-state')?.textContent ?? ''), null, { timeout: DONE_TIMEOUT, polling: 250 });
      await page.waitForTimeout(400); // let the final trace entry land

      const trace = await buddy.evaluate(() => (window.__buddyTrace ?? []).map((e) => ({ name: e.name, arguments: e.arguments, ok: e.ok, errorType: e.errorType, result: e.result })));
      const seen = catalogToolSequence(trace, catalogNames);
      const expected = task.expect?.tools ?? [];
      const seenSet = new Set(seen.map(jobOf));
      const missing = expected.filter((name) => !seenSet.has(jobOf(name)));
      const toolsPass = isSubsequence(expected.map(jobOf), seen.map(jobOf));
      const check = await runCheck(page, trace, task.check);
      row.tools = { seen, missing, pass: toolsPass };
      row.checks = check;
      row.rounds = trace.length;
      row.trace = trace.map((e) => ({ name: e.name, arguments: e.arguments, ok: e.ok, errorType: e.errorType, result: JSON.stringify(e.result ?? null).slice(0, 300) }));
      row.pass = check.ok && toolsPass; // many checks hold after setup alone (window_open), so the tools must match too
      row.error = toolsPass ? null : `missing tools: ${missing.join(', ') || '(wrong order)'}`;
    } catch (error) {
      if (error?.fatal) { console.error(error.message); await ctx.close(); process.exit(1); }
      row.error = String(error?.message ?? error).slice(0, 300);
    } finally {
      row.seconds = +((Date.now() - started) / 1000).toFixed(1);
    }
    results.push(row);
    console.log(`${row.pass ? 'PASS' : 'FAIL'} ${row.id}  ${row.seconds}s  tools=${row.tools.seen.join(',') || '-'}  ${row.checks?.detail ?? ''} ${row.error ? '  [' + row.error + ']' : ''}`);
  }

  const passCount = results.filter((r) => r.pass).length;
  const toolsPassCount = results.filter((r) => r.tools.pass).length;
  const summary = {
    model, set: set ?? only, prefetch, base, total: results.length,
    pass: passCount, successRate: +(passCount / results.length).toFixed(3),
    checkRate: +(results.filter((r) => r.checks?.ok).length / results.length).toFixed(3),
    toolAccuracy: +(toolsPassCount / results.length).toFixed(3),
    medianSeconds: median(results.map((r) => r.seconds)),
    generatedAt: new Date().toISOString(),
  };
  const outDir = join(ROOT, 'tests/agent-eval/results');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${model}-${set ?? only}${prefetch === 'on' ? '-prefetch' : ''}-${Date.now()}.json`);
  writeFileSync(outFile, JSON.stringify({ summary, results }, null, 1));
  console.log(JSON.stringify(summary));
  console.log('wrote ' + outFile);
  await ctx.close();
}

// Run only as a script, so a probe can import the checks (a positive control for each one).
if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error('eval failed:', error); process.exit(1); });
