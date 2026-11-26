#!/usr/bin/env node
// M6 real-model eval runner. Drives real Buddy in Chrome (WebGPU) against a RUNNING preview.
// It starts nothing itself: a preview must already be serving the desktop at --base.
//
//   node scripts/agent/eval.mjs --model lfm3-1.7b --set A [--limit N] [--base http://127.0.0.1:4333]
//
// Per task it: opens a NEW chat, runs the runner-driven setup (close_all / open_app / seed_file /
// seed_fixture / run), types the prompt, waits for the run to finish (120 s cap), reads the
// ?eval=1 tool trace, and evaluates the end-state check. Results go to
// tests/agent-eval/results/<model>-<set>-<ts>.json.
//
// Journeys (tests/agent-eval/journeys/<app>.yaml): each journey has a prompt, a setup,
// oracle steps (the catalog tool calls that achieve it with no model) and a checks list
// that all must pass on the end state. --oracle runs the oracle steps and the checks with
// no model (the proof a journey is achievable before the agent ever runs it); a journey no
// tool can achieve yet carries needs: and is listed as NEEDS. A journey is solved when it
// passes all checks on every --repeat run. Results go to
// tests/agent-eval/results/journeys-<app>-<split>-<model>-<stamp>.json.
import { chromium } from '@playwright/test';
import { parse } from 'yaml';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const PROFILE = '/tmp/webpc-eval-profile'; // persistent: model downloads are cached across runs
const DONE_TIMEOUT = 120_000; // per-task cap (tasks.yaml)
const JOURNEY_TIMEOUT = 240_000; // per-journey cap (journeys are longer than the old tasks)
const READY_TIMEOUT = 60_000; // app-load cap for a single appWindow
const JOURNEYS_DIR = join(ROOT, 'tests/agent-eval/journeys');

const USAGE = 'usage: node scripts/agent/eval.mjs --model <key> ((--set <A|B|C|D> | --task <id>) [--limit N] | --journeys <app|all> [--split train|holdout|all] [--repeat N] [--models m1,m2,...] [--oracle]) [--prefetch on|off] [--base http://127.0.0.1:4333]';

function parseArgs(argv) {
  const out = { model: 'lfm3-1.7b', set: null, limit: Number.POSITIVE_INFINITY, base: 'http://127.0.0.1:4333', split: 'train', repeat: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') out.model = argv[++i];
    else if (a === '--set') out.set = argv[++i];
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--base') out.base = argv[++i];
    else if (a === '--task') out.task = argv[++i];
    else if (a === '--prefetch') out.prefetch = argv[++i]; // on: the eval-only ?prefetch=1 switch (Buddy's default is off)
    else if (a === '--journeys') out.journeys = argv[++i]; // an app id, or all for every journey file
    else if (a === '--split') out.split = argv[++i]; // train | holdout | all (journeys)
    else if (a === '--repeat') out.repeat = Number(argv[++i]); // runs per journey, fresh chat each (journeys)
    else if (a === '--oracle') out.oracle = true; // run the journeys' oracle steps with no model
    else if (a === '--models') out.models = argv[++i]; // comma list: each model runs in the one session (journeys)
    else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
  }
  return out;
}

// ---- pure helpers (no browser) ---------------------------------------------

/** A trace entry that produced a result. Session-level refusals (the A21 close, the
 *  identical-fail stop, the unknown tool) carry a plain-string error and never ran the
 *  tool, so a check must not read a refusal as the tool's last result (sweep b17
 *  terminal-08/10: the stopped duplicates become the last terminal.run entry after the
 *  acting-name fix, and the real last output sits behind them). */
const ran = (e) => !(e.result && typeof e.result === 'object' && typeof e.result.error === 'string');

/** The ordered sequence of catalog tool invocations implied by a trace: a direct
 *  catalog-tool name, or the `tool` argument of a call_tool. Meta tools are skipped. */
function catalogToolSequence(trace, catalogNames) {
  const seq = [];
  for (const entry of trace) {
    if (!ran(entry)) continue;
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
    else if (id === 'lightcraft') {
      // A throwaway library (the vendor's ?store=memory, craft/app.mjs:72 sets store=idb): every
      // journey starts from the first-run demo library, not from what earlier journeys imported.
      const ed = wrapper.document.getElementById('editor');
      ed.src = ed.src.replace('store=idb', 'store=memory');
      // Ready means the demo library has finished loading: the photo count is above 0 and the same
      // for four reads in a row (an early read saw a library still filling, so counts drifted).
      let last = null, same = 0;
      for (let i = 0; i < 600 && same < 4; i++) {
        try {
          const api = ed.contentWindow.lightcraft;
          // A call made before the app is up can stay pending forever: give each try 2 s.
          const info = api?.command ? await Promise.race([api.command('catalog.stats', '{}'), new Promise((r) => setTimeout(() => r(null), 2000))]) : null;
          const photos = info ? JSON.parse(info)?.photos : null;
          same = typeof photos === 'number' && photos > 0 && photos === last ? same + 1 : 0;
          last = photos;
        } catch { same = 0; /* still loading */ }
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    else if (id === 'excalidraw') { const win = wrapper.document.getElementById('excalidraw-frame').contentWindow; let api = null; for (let i = 0; i < 300 && !api; i++) { api = win.webpcExcalidraw?.api; if (!api) await new Promise((r) => setTimeout(r, 100)); } api.resetScene(); }
    return { reset: id };
  }, { id, timeoutMs: READY_TIMEOUT });
}
const STATEFUL = new Set(['gridcraft', 'docs', 'excalidraw', 'lightcraft']);

/** Open an app window with a fresh frame and wait until it posts pc:ready. Closing a window
 *  only hides it (desktop.js caches the iframe so pending saves finish), so without the reload
 *  a journey would see what the last one left (cadcraft-08 counted the earlier journeys' lines).
 *  The reload is the desktop's own Try again path (loadApp). */
export async function openApp(page, id) {
  return page.evaluate(async ({ id, timeoutMs }) => {
    const host = window.pcHost;
    if (!host) return { error: 'pcHost is not installed' };
    await host.open(id);
    document.querySelector(`[data-window="${CSS.escape(id)}"] [data-retry]`)?.click();
    // Apps that restore their last session from localStorage (pdfcraft reopened every earlier
    // journey's document) would undo the reload: drop the app's own keys now, after the old
    // frame's unload save and before the new frame runs. Files and other apps' keys stay.
    const own = new RegExp(`^(pc:)?${id}([.:/-]|$)`, 'i');
    for (const key of Object.keys(localStorage)) if (own.test(key)) localStorage.removeItem(key);
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

export async function checkFileContains(page, { path, text, exact }) {
  const ok = await page.evaluate(async ({ path, text, exact, root }) => {
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
    const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    return (exact ? content : norm(content)).includes(exact ? text : norm(text));
  }, { path, text, exact: Boolean(exact), root: FILES_ROOT });
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

export async function checkDocsContains(page, { text, exact }) {
  const ok = await page.evaluate(async ({ text, exact, timeoutMs }) => {
    const host = window.pcHost;
    if (!host) return false;
    let wrapper;
    try { wrapper = await host.appWindow('docs', { timeoutMs }); } catch { return false; }
    const ed = wrapper?.webpcDocs;
    const doc = ed?.getEditorRef?.()?.getState?.()?.doc;
    if (!doc) return false;
    let all = '';
    doc.descendants((node) => { if (node.isText) all += node.text + ' '; });
    const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    return (exact ? all : norm(all)).includes(exact ? text : norm(text));
  }, { text, exact: Boolean(exact), timeoutMs: READY_TIMEOUT });
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

/** A check's regex. JavaScript has no inline flags, so the leading (?i) authors write
 *  becomes the i flag (new RegExp('(?i)x') throws "Invalid group"). */
export function toRegExp(pattern) {
  const text = String(pattern);
  return text.startsWith('(?i)') ? new RegExp(text.slice(4), 'i') : new RegExp(text);
}

/** file_matches: the shared Files area file's text matches the regex (file_contains, regex). */
export async function checkFileMatches(page, { path, regex }) {
  let re;
  try { re = toRegExp(regex); } catch (error) { return { ok: false, detail: `bad regex ${JSON.stringify(regex)}: ${error.message}` }; }
  const ok = await page.evaluate(async ({ path, source, flags, root }) => {
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
    const content = await (await file.getFile()).text();
    return new RegExp(source, flags).test(content);
  }, { path, source: re.source, flags: re.flags, root: FILES_ROOT });
  return { ok, detail: `${path} ${ok ? 'matches' : 'does not match'} ${JSON.stringify(regex)}` };
}

/** craft_request: read a value through the craft app's own page API (request, falling back to
 *  execute, then command(id, JSON text) for apps like LightCraft) and compare one path of its
 *  reply. The editor frame holds window.<app>, the same surface checkCell's cell.get reads. */
export async function checkCraftRequest(page, { app, method, params, expect }) {
  const got = await page.evaluate(async ({ app, method, params, timeoutMs }) => {
    const host = window.pcHost;
    if (!host) return { error: 'pcHost is not installed' };
    let wrapper;
    try { wrapper = await host.appWindow(app, { timeoutMs }); } catch (error) { return { error: 'app window: ' + error.message }; }
    const win = wrapper?.document?.getElementById?.('editor')?.contentWindow;
    if (!win) return { error: 'the app window has no editor frame' };
    let api = null;
    for (let i = 0; i < 300 && !api; i++) { api = win[app]; if (!api) await new Promise((r) => setTimeout(r, 100)); }
    if (!api) return { error: `the ${app} page did not finish loading` };
    try {
      let lastError = null;
      // A plain function on the API (pdfcraft's docInspect, uiInspect) is called directly.
      if (typeof api[method] === 'function' && !['request', 'execute', 'command', 'commands'].includes(method)) return { value: await api[method](params ?? {}) };
      try { return { value: await api.request(method, params) }; }
      catch (error) {
        lastError = error;
        try { return { value: await api.execute(method, params) }; }
        catch (error2) {
          lastError = error2;
          // Apps that install only command(id, paramsText) (LightCraft, web.rs:824): JSON-encode
          // the params and parse the JSON text the page replies (raw text if it is not JSON).
          // With no command surface, report the app's own error, not a missing API.
          if (typeof api.command !== 'function') throw new Error(`${method} failed: ${lastError?.message ?? lastError}`);
          const text = await api.command(method, JSON.stringify(params));
          try { return { value: JSON.parse(text) }; } catch { return { value: text }; }
        }
      }
    } catch (error) { return { error: error.message ?? String(error) }; }
  }, { app, method, params: params ?? {}, timeoutMs: READY_TIMEOUT });
  if (got.error) return { ok: false, detail: `${app} ${method}: ${got.error}` };
  const cmp = compareValue(readPath(got.value, expect.path), expect);
  return { ok: cmp.ok, detail: `${app} ${method} ${expect.path}: ${cmp.detail}` };
}

/** read_tool: after the run (or after the oracle) the checker itself calls the catalog
 *  read tool through the ?eval=1 oracle hook and tests its result - the end state no
 *  matter which tools the agent used. path is dot notation; without it the whole
 *  result is tested. */
export async function checkReadTool(buddy, value) {
  if (!buddy) return { ok: false, detail: 'read_tool needs the journey runner (window.__buddyRun is only on the ?eval=1 page)' };
  const res = await runToolInPage(buddy, value.tool, value.args ?? {});
  if (res?.ok !== true) return { ok: false, detail: `read ${value.tool} failed: ${JSON.stringify(res?.error ?? res)}`.slice(0, 200) };
  const { tool, args, path, ...cmp } = value;
  return compareValue(path ? readPath(res.result ?? null, path) : res.result ?? null, cmp);
}

/** Call a catalog tool through the ?eval=1 page (the window.__buddyRun oracle hook). */
export async function runToolInPage(buddy, tool, args) {
  return buddy.evaluate(async (input) => window.__buddyRun ? window.__buddyRun(input.tool, input.args) : Promise.reject(new Error('window.__buddyRun is missing (app.js not current or ?eval=1 not active)')), { tool, args });
}

/** The model's bake leaves no readable app state, so the runner reads the actual output
 *  from the ?eval=1 trace: the last cyberchef.bake call's result (call_tool wraps it as
 *  { ok, tool, result: { output } }). */
export function checkCyberchefOutput(trace, expected) {
  const entry = [...trace].reverse().find((e) => ran(e) && (e.name === 'cyberchef.bake' || (e.name === 'call_tool' && e.arguments?.tool === 'cyberchef.bake')));
  const output = entry?.result?.result?.output;
  const ok = typeof output === 'string' && output.trim() === String(expected).trim();
  return { ok, detail: ok ? 'bake output matches' : `no matching bake output (got ${JSON.stringify(output ?? null)})` };
}

/** The guest's real output, read from the ?eval=1 trace: the last terminal.run call's result
 *  (call_tool wraps it as { ok, tool, result: { exitCode, output } }). */
export function checkTerminalOutput(trace, expected) {
  const entry = [...trace].reverse().find((e) => ran(e) && (e.name === 'terminal.run' || (e.name === 'call_tool' && e.arguments?.tool === 'terminal.run')));
  const output = entry?.result?.result?.output;
  const exact = Boolean(expected.exact);
  const ok = typeof output === 'string' && normalizeText(output, exact).includes(normalizeText(expected.text, exact));
  return { ok, detail: ok ? `terminal output contains ${JSON.stringify(expected.text)}` : `no terminal output containing ${JSON.stringify(expected.text)} (got ${JSON.stringify(output ?? null)})` };
}

// ---- shared check validation and the new check kinds (pure parts unit-tested in
// ---- tests/agent-eval-checks.test.mjs; the journey schema test imports validateCheck) ----

/** Every check kind the runner and the journey schema test share, in one place. */
export const CHECK_KINDS = [
  'window_open', 'theme', 'file_exists', 'file_contains', 'file_matches', 'cell',
  'docs_text_contains', 'excalidraw_count_at_least', 'cyberchef_output', 'terminal_output',
  'answer_contains', 'answer_matches', 'tool_result', 'craft_request', 'read_tool',
];

/**
 * Validate one check's value part. Returns { ok: true, value } when the shape is right,
 * { ok: false, detail } when it is not. The runner and the journey schema test both use
 * this, so a well-formed check is defined in exactly one place. Text checks (docs_text_contains,
 * file_contains, answer_contains, terminal_output) take a bare string, or { text, exact? }:
 * without exact the comparison ignores case and repeated whitespace (the regex kinds stay
 * as written; exact: true turns the normalisation off).
 */
/** A comparison is one of equals / contains / matches, or a numeric range: at_least and/or at_most
 *  (effectcraft reads a 5 s comp back as 5.005, so a check brackets it instead of pinning equals). */
function oneComparison(cmp) {
  const exact = ['equals', 'contains', 'matches'].filter((k) => k in (cmp ?? {}));
  const range = ['at_least', 'at_most'].filter((k) => k in (cmp ?? {}));
  return (exact.length === 1 && range.length === 0) || (exact.length === 0 && range.length > 0);
}

export function validateCheck(kind, value) {
  const str = v => typeof v === 'string' && v.length > 0;
  const textOrExact = (v) => (str(v) ? { text: v, exact: false }
    : (v && typeof v === 'object' && str(v.text) && (v.exact === undefined || typeof v.exact === 'boolean') ? { text: v.text, exact: Boolean(v.exact) } : null));
  const boolOrAbsent = v => v === undefined || typeof v === 'boolean';
  switch (kind) {
    case 'window_open':
    case 'file_exists':
      return str(value) ? { ok: true, value } : { ok: false, detail: 'expects a non-empty string' };
    case 'docs_text_contains':
    case 'terminal_output':
    case 'answer_contains':
    case 'answer_matches': {
      const t = textOrExact(value);
      return t ? { ok: true, value: t } : { ok: false, detail: 'expects a non-empty string, or { text, exact? }' };
    }
    case 'cyberchef_output':
      return str(value) ? { ok: true, value } : { ok: false, detail: 'expects a non-empty string' };
    case 'theme':
      return value === 'light' || value === 'dark' ? { ok: true, value } : { ok: false, detail: 'expects light or dark' };
    case 'file_contains': {
      const t = textOrExact(value?.text);
      return str(value?.path) && t ? { ok: true, value: { path: value.path, ...t } } : { ok: false, detail: 'expects { path, text, exact? }' };
    }
    case 'file_matches':
      return str(value?.path) && str(value?.regex) ? { ok: true, value } : { ok: false, detail: 'expects { path, regex }' };
    case 'cell':
      return str(value?.app) && str(value?.cell) && typeof value?.input === 'string' ? { ok: true, value } : { ok: false, detail: 'expects { app, cell, input }' };
    case 'excalidraw_count_at_least':
      return typeof value === 'number' && Number.isFinite(value) ? { ok: true, value } : { ok: false, detail: 'expects a number' };
    case 'tool_result': {
      const comparators = ['contains', 'equals', 'matches'].filter((k) => k in (value ?? {}));
      // path is optional: without it the comparator runs over the whole result. any: true (T17)
      // matches any result of the named tool; the default stays the last result, which the
      // journey notes keep only where the prompt pins the order.
      return str(value?.tool) && (value?.path === undefined || str(value.path)) && comparators.length === 1 && boolOrAbsent(value?.exact) && boolOrAbsent(value?.any)
        ? { ok: true, value: { ...value, exact: Boolean(value?.exact), any: Boolean(value?.any) } }
        : { ok: false, detail: 'expects { tool, path?, contains | equals | matches, exact?, any? }' };
    }
    case 'craft_request': {
      return str(value?.app) && str(value?.method) && str(value?.expect?.path) && oneComparison(value?.expect) && boolOrAbsent(value?.expect?.exact)
        ? { ok: true, value }
        : { ok: false, detail: 'expects { app, method, params, expect: { path, equals | contains | matches | at_least and/or at_most, exact? } }' };
    }
    case 'read_tool': {
      const argsOk = value?.args === undefined || (typeof value?.args === 'object' && value.args !== null && !Array.isArray(value.args));
      return str(value?.tool) && argsOk && (value?.path === undefined || str(value.path)) && oneComparison(value) && boolOrAbsent(value?.exact)
        ? { ok: true, value }
        : { ok: false, detail: 'expects { tool, args?, path?, equals | contains | matches | at_least and/or at_most, exact? }' };
    }
    default:
      return { ok: false, detail: `unknown check kind ${kind}` };
  }
}

/** Read dot notation with [n] indexes into a value: readPath({ a: [{ b: 1 }] }, 'a[0].b') is 1. */
export function readPath(value, path) {
  let out = value;
  for (const segment of String(path).split('.')) {
    if (!/^[^[\]]*(\[\d+\])*$/.test(segment)) return undefined;
    const key = segment.replace(/\[\d+\]/g, '');
    if (key !== '') {
      if (out == null || typeof out !== 'object') return undefined;
      out = out[key];
    }
    for (const index of segment.matchAll(/\[(\d+)\]/g)) {
      if (!Array.isArray(out)) return undefined;
      out = out[Number(index[1])];
    }
  }
  return out;
}

/** A value that parses as a finite number (a number, or a non-blank string of one), else null. */
const numLike = v => (typeof v === 'number' && Number.isFinite(v)) ? v
  : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** equals compares numbers numerically when both sides parse as numbers; two objects
 *  compare by their JSON text (whole-result equals; both sides come from the same code path). */
export function valuesEqual(a, b) {
  if (a === b) return true;
  const na = numLike(a), nb = numLike(b);
  if (na !== null && nb !== null) return na === nb;
  return a != null && b != null && typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b);
}

/** Text-comparison normalisation: collapse whitespace runs, trim and lowercase.
 *  exact: true keeps the text as-is (case and whitespace significant). The regex kinds
 *  never use this: authors add a leading (?i) themselves (toRegExp). */
export function normalizeText(value, exact) {
  const text = String(value);
  return exact ? text : text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** A value as text for contains/matches: strings as-is, anything else as JSON. */
const valueText = v => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

/** One comparison of an actual value: contains / equals / matches / at_least. contains
 *  ignores case and repeated whitespace unless exact: true. */
export function compareValue(actual, cmp) {
  if ('contains' in cmp) {
    const exact = Boolean(cmp.exact);
    const ok = actual != null && normalizeText(valueText(actual), exact).includes(normalizeText(cmp.contains, exact));
    return { ok, detail: ok ? `contains ${JSON.stringify(cmp.contains)}` : `does not contain ${JSON.stringify(cmp.contains)} (got ${JSON.stringify(actual ?? null)})` };
  }
  if ('equals' in cmp) {
    const bothText = typeof actual === 'string' && typeof cmp.equals === 'string' && numLike(actual) === null;
    const ok = bothText ? normalizeText(actual, Boolean(cmp.exact)) === normalizeText(cmp.equals, Boolean(cmp.exact)) : valuesEqual(actual, cmp.equals);
    return { ok, detail: ok ? `equals ${JSON.stringify(cmp.equals)}` : `is ${JSON.stringify(actual ?? null)}, wanted ${JSON.stringify(cmp.equals)}` };
  }
  if ('matches' in cmp) {
    let re;
    try { re = toRegExp(cmp.matches); } catch (error) { return { ok: false, detail: `bad regex ${JSON.stringify(cmp.matches)}: ${error.message}` }; }
    const ok = actual != null && re.test(valueText(actual));
    return { ok, detail: ok ? `matches ${JSON.stringify(cmp.matches)}` : `does not match ${JSON.stringify(cmp.matches)} (got ${JSON.stringify(actual ?? null)})` };
  }
  if ('at_least' in cmp || 'at_most' in cmp) {
    const n = numLike(actual);
    const lo = 'at_least' in cmp ? numLike(cmp.at_least) : -Infinity, hi = 'at_most' in cmp ? numLike(cmp.at_most) : Infinity;
    const range = `${'at_least' in cmp ? `at least ${lo}` : ''}${'at_least' in cmp && 'at_most' in cmp ? ' and ' : ''}${'at_most' in cmp ? `at most ${hi}` : ''}`;
    const ok = n !== null && lo !== null && hi !== null && n >= lo && n <= hi;
    return { ok, detail: ok ? `is ${n}, ${range}` : `${JSON.stringify(actual ?? null)} is not a number ${range}` };
  }
  return { ok: false, detail: 'no comparison given' };
}

/** The agent's final reply against contains / matches (the answer checks). */
export function checkAnswer(answer, kind, value) {
  const text = String(answer ?? '');
  if (text === '') return { ok: false, detail: 'no final answer to check' };
  if (kind === 'answer_contains') {
    const exact = Boolean(value.exact);
    const ok = normalizeText(text, exact).includes(normalizeText(value.text, exact));
    return { ok, detail: ok ? `answer contains ${JSON.stringify(value.text)}` : `answer does not contain ${JSON.stringify(value.text)}` };
  }
  let re;
  try { re = toRegExp(value.text); } catch (error) { return { ok: false, detail: `bad regex ${JSON.stringify(value.text)}: ${error.message}` }; }
  const ok = re.test(text);
  return { ok, detail: ok ? `answer matches ${JSON.stringify(value.text)}` : `answer does not match ${JSON.stringify(value.text)} (got ${JSON.stringify(text.slice(0, 200))})` };
}

/** tool_result: the last result of the named catalog tool in the trace, read at path (or the
 *  whole result when no path); with any: true (T17) the first matching result wins instead,
 *  for checks whose prompt does not require the result to be the tool's last call. A direct
 *  catalog call carries its result in entry.result; the call_tool wrapper carries it in
 *  entry.result.result ({ ok, tool, result }). */
export function checkToolResult(trace, { tool, path, any, ...cmp }) {
  const hits = trace.filter((e) => ran(e) && (e.name === tool || (e.name === 'call_tool' && e.arguments?.tool === tool)));
  if (!hits.length) return { ok: false, detail: `no ${tool} call in the trace` };
  const read = raw => { const result = raw && typeof raw === 'object' && 'result' in raw && 'tool' in raw ? raw.result : raw; return path ? readPath(result, path) : result; };
  if (!any) return compareValue(read(hits.at(-1).result), cmp);
  let last;
  for (const entry of hits) { last = compareValue(read(entry.result), cmp); if (last.ok) return last; }
  return { ok: false, detail: `none of the ${hits.length} ${tool} results: ${last.detail}` };
}

/** Dispatch a task's single end-state check (tasks.yaml keeps one check per task). */
async function runCheck(page, trace, check) {
  if (check == null || typeof check !== 'object') return { ok: false, detail: 'no check defined' };
  const [kind, value] = Object.entries(check)[0] ?? [];
  const validated = validateCheck(kind, value);
  if (!validated.ok) return { ok: false, detail: `${kind}: ${validated.detail}` };
  return runNamedCheck(page, { trace, answer: '', buddy: null }, kind, validated.value);
}

/** Run one validated check (kind + value) and return { ok, detail }. */
async function runNamedCheck(page, { trace, answer, buddy }, kind, value) {
  switch (kind) {
    case 'window_open': return checkWindowOpen(page, value);
    case 'theme': return checkTheme(page, value);
    case 'file_exists': return checkFileExists(page, value);
    case 'file_contains': return checkFileContains(page, value);
    case 'file_matches': return checkFileMatches(page, value);
    case 'cell': return checkCell(page, value);
    case 'docs_text_contains': return checkDocsContains(page, value);
    case 'excalidraw_count_at_least': return checkExcalidrawCount(page, value);
    case 'cyberchef_output': return checkCyberchefOutput(trace, value);
    case 'terminal_output': return checkTerminalOutput(trace, value);
    case 'answer_contains':
    case 'answer_matches': return checkAnswer(answer, kind, value);
    case 'tool_result': return checkToolResult(trace, value);
    case 'craft_request': return checkCraftRequest(page, value);
    case 'read_tool': return checkReadTool(buddy, value);
    default: return { ok: false, detail: `unsupported check kind ${kind}` };
  }
}

// ---- shared runner steps (the old tasks and the journeys both use these) ----

/** Copy one fixture file (tests/agent-eval/fixtures/<fixture>) into the shared Files area,
 *  byte for byte (the seed_file step is for text only; binaries come from real fixtures). */
export async function seedFixture(page, path, fixture) {
  if (!/^[\w.-]+$/.test(String(fixture))) throw new Error(`bad fixture name: ${JSON.stringify(fixture)}`);
  const bytes = new Uint8Array(readFileSync(join(ROOT, 'tests/agent-eval/fixtures', String(fixture))));
  return page.evaluate(async ({ path, bytes, root, fixture }) => {
    const openDir = (h, n, c) => (h.getDirectory ? h.getDirectory(n, { create: c }) : h.getDirectoryHandle(n, { create: c }));
    const openFile = (h, n, c) => (h.getFile ? h.getFile(n, { create: c }) : h.getFileHandle(n, { create: c }));
    const parts = String(path).replace(/^\/+/, '').split('/').filter(Boolean);
    const base = parts.pop();
    let dir = await openDir(await navigator.storage.getDirectory(), root, true);
    for (const seg of parts) dir = await openDir(dir, seg, true);
    const file = await openFile(dir, base, true);
    const handle = await file.createWritable();
    await handle.write(bytes);
    await handle.close();
    return { seeded: path, fixture };
  }, { path, bytes, root: FILES_ROOT, fixture });
}

/** Close every window, empty the Files area, then run the journey/task setup steps. The
 *  `run` step drives a catalog tool through the ?eval=1 oracle hook (no model) and clears the
 *  trace afterwards, so setup calls never count as the agent's work. */
async function runSetup(page, buddy, steps) {
  await closeAll(page);
  await clearFiles(page);
  for (const step of steps ?? []) {
    if (step.close_all) await closeAll(page);
    else if (step.open_app || step.reset_app) { // reset_app: the same fresh open (the gate briefs asked for it)
      const id = step.open_app || step.reset_app;
      await openApp(page, id);
      if (STATEFUL.has(id)) await resetApp(page, id);
    }
    else if (step.seed_file) await seedFile(page, step.seed_file.path, step.seed_file.text);
    else if (step.seed_fixture) await seedFixture(page, step.seed_fixture.path, step.seed_fixture.fixture);
    else if (step.run) {
      const { tool, ...args } = step.run ?? {};
      const res = await buddy.evaluate(async ({ tool, args }) => window.__buddyRun ? window.__buddyRun(tool, args) : Promise.reject(new Error('window.__buddyRun is missing (app.js not current or ?eval=1 not active)')), { tool, args });
      if (res?.ok !== true) throw new Error(`setup run failed: ${tool} ${JSON.stringify(res?.error ?? res)}`.slice(0, 200));
      await buddy.evaluate(() => { if (window.__buddyTrace) window.__buddyTrace.length = 0; }); // setup calls never count
    }
    else throw new Error(`unknown setup step: ${JSON.stringify(step)}`);
  }
}

/** Select and load the model once; wait until the model state says it is ready (Send stays
 *  disabled while the box is empty, so it is no longer the ready signal). */
export async function loadModel(buddy, model) {
  // Select first: while the loaded model is the one selected, Load stays disabled, so waiting for it
  // before choosing the next model timed out on every switch (qwen3.5-2b to lfm3-1.7b, j3-cyberchef-1).
  await buddy.locator('#model').selectOption(model);
  await buddy.waitForFunction(() => { const s = document.querySelector('#load-model'); return s && !s.disabled; }, null, { timeout: 60_000, polling: 250 });
  await buddy.locator('#load-model').click();
  await buddy.waitForFunction(() => /^(Ready|Cloud|Chrome)/.test(document.querySelector('#model-state')?.textContent ?? ''), null, { timeout: 1_200_000, polling: 500 }); // 20 min: a first download of a large model (gemma4-e2b) took longer than 5
  console.log(`model ${model} loaded and ready`);
}

/** Start an empty chat (and clear the trace): a run must never see an earlier run's state. */
async function newChat(buddy) {
  await buddy.evaluate(() => window.__buddyPruneThreads?.()); // stay far below the 200-chat limit
  await buddy.locator('#new-chat').click();
  // A task must start in an empty chat: no messages and no "chat limit" error.
  try { await buddy.waitForFunction(() => document.querySelectorAll('#messages article.message').length === 0 && !document.getElementById('error')?.textContent.trim(), null, { timeout: 10_000, polling: 100 }); }
  catch { const why = await buddy.evaluate(() => `${document.querySelectorAll('#messages article.message').length} messages; error: ${document.getElementById('error')?.textContent.trim() || 'none'}`); throw Object.assign(new Error(`FATAL: New chat did not start an empty chat (${why})`), { fatal: true }); }
  await buddy.evaluate(() => { if (window.__buddyTrace) window.__buddyTrace.length = 0; });
}

/** The ?eval=1 tool trace as plain data. */
async function readTrace(buddy) {
  return buddy.evaluate(() => (window.__buddyTrace ?? []).map((e) => ({ name: e.name, arguments: e.arguments, ok: e.ok, errorType: e.errorType, result: e.result })));
}

/** The one shared eval session: the persistent browser context, the desktop page and the
 *  agent frame loaded with ?eval=1 and an empty chat history. The queue runner (and any
 *  other driver) reuses this instead of copying the launch; the hook must be live or every
 *  tool trace would be empty and the run meaningless. */
export async function launchEval(base, prefetch = 'off', { handleSIGINT = true } = {}) {
  // handleSIGINT false: the queue runner's own Ctrl+C handler finishes the current journey; with
  // Playwright's default the browser closed under it (beepbox-03, oracle-sqliteviz-r5).
  // SIGTERM too: Playwright's own handler closed the browser under the runner, which then marked
  // every pending request done with "browser closed" rows (19 requests lost at 10:15:47).
  const ctx = await chromium.launchPersistentContext(PROFILE, { channel: 'chrome', headless: true, handleSIGINT, handleSIGTERM: handleSIGINT, args: ['--enable-unsafe-webgpu'] });
  const page = await ctx.newPage();
  page.setDefaultTimeout(0);
  await page.goto(`${base}/pc/`);
  await page.locator('[data-buddy-toggle]').click();
  let buddy = null; // Playwright has no waitForFrame: poll the page's frames for the agent's document
  for (let i = 0; i < 300 && !buddy; i++) { buddy = page.frames().find((f) => f.url().includes('/pc/apps/ai-agent/')) ?? null; if (!buddy) await page.waitForTimeout(100); }
  if (!buddy) { await ctx.close(); throw new Error('the agent panel frame did not appear within 30 s'); }
  // The hook reads location.search, which a route rewrite does not change: load the agent
  // document itself with ?eval=1 (the panel keeps this frame, so later chats keep the flag).
  // Start from no saved chats. The agent keeps at most 200 threads (threads.js MAX_THREADS);
  // past that, New chat fails and every later run would share one chat, where the model
  // copies earlier runs' calls (this skewed the runs of 2026-11-21 and 22).
  await buddy.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('keyval-store'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    if (db.objectStoreNames.contains('keyval')) {
      const keys = await new Promise((res, rej) => { const r = db.transaction('keyval').objectStore('keyval').getAllKeys(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const tx = db.transaction('keyval', 'readwrite');
      for (const key of keys) if (String(key).startsWith('buddy:thread')) tx.objectStore('keyval').delete(key);
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
      db.close();
    } else {
      // A bare open() of a missing database creates it at version 1 with no stores, and
      // idb-keyval's upgrade never runs again on it: every chat then fails with "object
      // stores was not found" (118 runs on 2026-11-25). Drop it so idb-keyval recreates it.
      db.close();
      await new Promise((res, rej) => { const r = indexedDB.deleteDatabase('keyval-store'); r.onsuccess = res; r.onerror = () => rej(r.error); });
    }
    localStorage.removeItem('buddy:openThread');
  });
  await buddy.goto(buddy.url(), { waitUntil: 'domcontentloaded' });
  if (!new URL(buddy.url()).searchParams.get('eval')) { const u = new URL(buddy.url()); u.searchParams.set('eval', '1'); if (prefetch === 'on') u.searchParams.set('prefetch', '1'); await buddy.goto(u.toString(), { waitUntil: 'domcontentloaded' }); }
  const hookOn = await buddy.evaluate(() => Array.isArray(window.__buddyTrace));
  if (!hookOn) { await ctx.close(); throw new Error('FATAL: the ?eval=1 trace hook is not active (window.__buddyTrace missing). Check that the prepared app.js is current and the agent document loaded with ?eval=1.'); }
  return { ctx, page, buddy };
}

/** The visible text of the last assistant message (the agent's final answer). */
async function finalAnswer(buddy) {
  return buddy.evaluate(() => {
    const bodies = [...document.querySelectorAll('#messages article.message.assistant .message-body')];
    const last = bodies.at(-1);
    return last ? last.innerText : '';
  });
}

/** What the page still holds when a journey's run fails after the prompt was sent (T19):
 *  the trace as it stands (a call in flight is an entry with no result recorded yet), the
 *  last assistant bubble, the composer state, and the model status line. */
async function timeoutDiag(buddy) {
  return buddy.evaluate(() => {
    const bodies = [...document.querySelectorAll('#messages article.message.assistant .message-body')];
    const last = bodies.at(-1);
    const message = document.querySelector('#message');
    const send = document.querySelector('#send');
    return {
      trace: (window.__buddyTrace ?? []).map((e) => ({ name: e.name, arguments: e.arguments, ok: e.ok, errorType: e.errorType, result: e.result })),
      lastBubble: last ? last.innerText : '',
      composerValue: message ? message.value : '',
      composerSendDisabled: send ? send.disabled : null,
      status: document.querySelector('#model-state')?.textContent ?? '',
    };
  });
}

/** Run a journey's whole checks list; every check must pass. Records { kind, ok, detail }.
 *  read_tool checks call the read tool through the agent frame (buddy). */
/** Settle a step that runs in the page within ms, or reject: a check read, a setup call or an
 *  oracle tool that never answers hung the whole queue for 15 minutes (j3-gridcraft-b9, build 10). */
export function within(promise, ms, what) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms / 1000} s`)), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}
const CHECK_TIMEOUT = 60_000;
const SETUP_TIMEOUT = 180_000;
const STEP_TIMEOUT = 120_000;

async function runChecks(buddy, page, trace, answer, checks) {
  const out = [];
  for (const entry of checks ?? []) {
    const [kind, value] = Object.entries(entry ?? {})[0] ?? [];
    const validated = validateCheck(kind, value);
    if (!validated.ok) { out.push({ kind: kind ?? null, ok: false, detail: validated.detail ?? 'malformed check' }); continue; }
    const res = await within(runNamedCheck(page, { trace, answer, buddy }, kind, validated.value), CHECK_TIMEOUT, `check ${kind}`).catch((error) => ({ ok: false, detail: error.message }));
    out.push({ kind, ok: res.ok, detail: res.detail });
  }
  return out;
}

/** A journey's full trace for the results file (results cut at 4000 chars). */
const traceOf = trace => trace.map((e) => ({ name: e.name, arguments: e.arguments, result: JSON.stringify(e.result ?? null).slice(0, 4000) }));

// ---- main ------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.journeys) await runJourneys(args);
  else await runTasks(args);
}

async function runTasks(args) {
  const { model, set, limit, base, task: only, prefetch = 'off' } = args;
  if (!set && !only) { console.error('--set or --task is required.\n' + USAGE); process.exit(1); }

  const allTasks = parse(readFileSync(join(ROOT, 'tests/agent-eval/tasks.yaml'), 'utf8')).tasks;
  const catalog = JSON.parse(readFileSync(join(ROOT, 'src/apps/ai-agent/generated/catalog.json'), 'utf8'));
  const catalogNames = new Set(catalog.tools.map((t) => t.name));
  let tasks = allTasks.filter((t) => (only ? t.id === only : t.set === set));
  tasks = tasks.slice(0, limit);
  if (!tasks.length) { console.error(`no tasks for set ${set}`); process.exit(1); }

  console.log(`eval: model=${model} set=${set ?? only} tasks=${tasks.length} base=${base}`);

  // The one shared eval session (see launchEval): context, desktop page, agent frame with ?eval=1.
  const { ctx, page, buddy } = await launchEval(base, prefetch);
  // Select and load the model once (see loadModel).
  await loadModel(buddy, model);

  const results = [];
  for (const task of tasks) {
    const started = Date.now();
    const row = { id: task.id, set: task.set, pass: false, tools: { seen: [], missing: [], pass: false }, checks: null, seconds: 0, rounds: 0, error: null };
    try {
      // Setup: clean desktop, then the task's steps.
      await runSetup(page, buddy, task.setup ?? []);
      // New chat, clear the trace, type the prompt, send.
      await newChat(buddy);
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

// ---- journeys ----------------------------------------------------------------
// tests/agent-eval/journeys/<app>.yaml: { app, journeys: [ { id, split, title, prompt,
// setup?, oracle? | needs?, checks, covers?, notes? } ] }. A journey is solved when it
// passes every check on every --repeat run. --oracle runs the oracle steps with no model
// through window.__buddyRun (app.js, EVAL_TRACE only); a journey with needs: and no oracle
// is listed NEEDS and skipped.

/** Load the journey files (zero files is a valid state), grouped by app. Per file: a file
 *  that does not parse (a lane mid-edit) is skipped and logged once; a request fails only
 *  when a file it needs did not parse - its app's file for an app request, every file for
 *  an all-apps request, or a file that may hold a requested id the parsed files lack.
 *  dir is injectable for tests (the queue runner passes the real journeys dir). */
const brokenLogged = new Set(); // journey files whose parse failure was logged (once per process)
export function loadJourneys(appFilter, journeyIds = null, dir = JOURNEYS_DIR) {
  let files = [];
  try { files = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith('.yaml')).map((d) => d.name).sort(); } catch { /* the dir does not exist yet */ }
  const names = appFilter === 'all' ? files : [`${appFilter}.yaml`];
  const missing = names.filter((name) => !files.includes(name));
  if (missing.length) throw new Error(`no journey file ${missing.join(', ')} in ${dir} (have: ${files.join(', ') || 'none'})`);
  const byApp = new Map();
  const broken = [];
  for (const name of names) {
    let doc;
    try { doc = parse(readFileSync(join(dir, name), 'utf8')); }
    catch (error) {
      broken.push(name);
      if (!brokenLogged.has(name)) {
        brokenLogged.add(name);
        console.error(`journey file ${name} does not parse (${String(error.message).split('\n')[0]}); requests that need it fail until it is fixed`);
      }
      continue;
    }
    if (typeof doc?.app !== 'string' || !Array.isArray(doc?.journeys) || !doc.journeys.length) throw new Error(`journey file ${name} must have an app and a non-empty journeys list`);
    byApp.set(doc.app, [...(byApp.get(doc.app) ?? []), ...doc.journeys]);
  }
  if (journeyIds?.length) {
    const known = new Set([...byApp.values()].flat().map((j) => j.id));
    const unknown = journeyIds.filter((id) => !known.has(id));
    if (unknown.length) throw new Error(broken.length
      ? `journey ids ${unknown.join(', ')} are not in the journey files that parse; ${broken.join(', ')} does not parse and may hold them`
      : `unknown journey ids: ${unknown.join(', ')}`);
    for (const [app, journeys] of [...byApp]) byApp.set(app, journeys.filter((j) => journeyIds.includes(j.id)));
  } else if (broken.length) {
    // An app request needs its file; an all-apps request needs every file.
    throw new Error(`journey file${broken.length > 1 ? 's' : ''} ${broken.join(', ')} ${broken.length > 1 ? 'do' : 'does'} not parse`);
  }
  return byApp;
}

/** An oracle arg "${N.path}" (N counts steps from 0) takes step N's result at path, so an oracle can
 *  act on an id the app hands out at run time (deckcraft-11's shape id, docs-07's paragraph id). */
export const STEP_REF = /^\$\{(\d+)\.([^}]+)\}$/;
export function fillStepRefs(args, results) {
  return Object.fromEntries(Object.entries(args ?? {}).map(([key, value]) => {
    const ref = typeof value === 'string' ? value.match(STEP_REF) : null;
    return [key, ref ? readPath(results[Number(ref[1])], ref[2]) : value];
  }));
}

/** Oracle mode: the journey's oracle steps run through window.__buddyRun with no model,
 *  then the same checks on the end state (same result shape as an agent run). */
async function runJourneyOracle(buddy, page, journey) {
  const started = Date.now();
  const row = { id: journey.id, split: journey.split, pass: false, checks: [], seconds: 0, rounds: 0, answer: '', trace: [], error: null };
  try {
    await within(runSetup(page, buddy, journey.setup), SETUP_TIMEOUT, 'setup');
    const hasRun = await buddy.evaluate(() => typeof window.__buddyRun === 'function');
    if (!hasRun) throw Object.assign(new Error('FATAL: window.__buddyRun is missing (app.js not current or ?eval=1 not active)'), { fatal: true });
    await buddy.evaluate(() => { if (window.__buddyTrace) window.__buddyTrace.length = 0; });
    const stepResults = [];
    for (const step of journey.oracle ?? []) {
      const { tool, ...args } = step ?? {}; // the step is { tool, ...args }, like a setup run step
      const res = await within(runToolInPage(buddy, tool, fillStepRefs(args, stepResults)), STEP_TIMEOUT, `oracle step ${tool}`).catch((error) => ({ ok: false, error: error.message }));
      stepResults.push(res?.result);
      if (res?.ok !== true) { row.error = `oracle step failed: ${tool} ${JSON.stringify(res?.error ?? res)}`.slice(0, 300); break; }
    }
    const trace = await readTrace(buddy);
    row.rounds = trace.length;
    row.trace = traceOf(trace);
    // No model, so no reply: answer_* checks read the oracle's own tool results instead,
    // which proves the fact the check pins really comes out of the app.
    row.answer = oracleAnswerText(trace);
    row.checks = await runChecks(buddy, page, trace, row.answer, journey.checks);
    row.pass = !row.error && row.checks.length > 0 && row.checks.every((c) => c.ok);
  } catch (error) {
    if (error?.fatal) throw error;
    row.error = String(error?.message ?? error).slice(0, 300);
  } finally {
    row.seconds = +((Date.now() - started) / 1000).toFixed(1);
  }
  return row;
}

/** The text an oracle run's answer checks read: every tool result in the trace, as JSON. */
export function oracleAnswerText(trace) {
  return (trace ?? []).map((e) => (typeof e.result === 'string' ? e.result : JSON.stringify(e.result ?? null))).join('\n');
}

/** T19 (deckcraft-10, build 21: 240 s, 0 rounds, empty trace - and no way to tell whether
 *  it hung on a tool call that never returned, the model still generating, or a prompt that
 *  never left the composer): shape a timeoutDiag capture into the result-row fields
 *  (partialTrace, chatTail, status). A call in flight is a trace entry with no result
 *  recorded yet; captured text is capped so one bad run cannot bloat the results file. */
export function shapeTimeoutDiag(capture) {
  const trace = Array.isArray(capture?.trace) ? capture.trace : [];
  return {
    partialTrace: trace.map((e) => ({ name: e?.name, arguments: e?.arguments, ok: 'ok' in (e ?? {}) ? e.ok : undefined, errorType: e?.errorType ?? null, result: e?.result ?? null, inFlight: !('ok' in (e ?? {})) })),
    chatTail: {
      lastBubble: String(capture?.lastBubble ?? '').slice(-1000),
      composerValue: String(capture?.composerValue ?? '').slice(0, 300),
      composerSendDisabled: Boolean(capture?.composerSendDisabled),
    },
    status: String(capture?.status ?? '').slice(0, 300),
  };
}

/** Agent mode: the journey, --repeat times, a fresh chat each. */
async function runJourneyAgent(buddy, page, journey, repeat, shouldStop = () => false) {
  const rows = [];
  for (let rep = 1; rep <= repeat; rep++) {
    if (shouldStop()) break; // the queue runner's Ctrl+C: stop after the current journey
    const started = Date.now();
    const row = { id: journey.id, split: journey.split, rep, repeat, pass: false, checks: [], seconds: 0, rounds: 0, answer: '', trace: [], error: null };
    let sent = false;
    try {
      await within(runSetup(page, buddy, journey.setup), SETUP_TIMEOUT, 'setup');
      await newChat(buddy);
      await buddy.locator('#message').fill(journey.prompt);
      await buddy.locator('#send').click();
      sent = true;
      // Wait for the run to finish (the model state leaves "Working" when the active run ends), 240 s cap.
      try { await buddy.waitForFunction(() => /^Working/.test(document.querySelector('#model-state')?.textContent ?? ''), null, { timeout: 8_000, polling: 100 }); } catch { /* finished before we sampled */ }
      await buddy.waitForFunction(() => !/^Working/.test(document.querySelector('#model-state')?.textContent ?? ''), null, { timeout: JOURNEY_TIMEOUT, polling: 250 });
      await page.waitForTimeout(400); // let the final trace entry land
      const trace = await readTrace(buddy);
      row.answer = await finalAnswer(buddy);
      row.rounds = trace.length;
      row.trace = traceOf(trace);
      row.checks = await runChecks(buddy, page, trace, row.answer, journey.checks);
      row.pass = row.checks.length > 0 && row.checks.every((c) => c.ok);
    } catch (error) {
      if (error?.fatal) throw error;
      row.error = String(error?.message ?? error).slice(0, 300);
      if (sent) {
        // T19: the prompt is in flight, so capture what the page still holds (partialTrace,
        // chatTail, status) - a tool call that never returned, a model still generating, or a
        // prompt that never left the composer all read the same as an empty trace otherwise.
        // Bounded: a frozen app page (same-origin frames share its main thread) left this
        // evaluate pending forever and stalled the whole queue (sweep-figcraft-b22, 44 min).
        const diag = await within(timeoutDiag(buddy), 15_000, 'timeout capture').catch(() => null);
        if (diag) Object.assign(row, shapeTimeoutDiag(diag));
      }
    } finally {
      row.seconds = +((Date.now() - started) / 1000).toFixed(1);
    }
    rows.push(row);
  }
  return rows;
}

/** One app's journeys, oracle or agent (the queue runner calls this too). Returns the
 *  run rows and the journeys listed NEEDS (oracle mode: needs: and no oracle steps). */
export async function runJourneyAll(buddy, page, app, journeys, { repeat, oracle, shouldStop = () => false }) {
  const rows = [];
  const needList = [];
  for (const journey of journeys) {
    if (shouldStop()) break;
    if (oracle && journey.needs && !(Array.isArray(journey.oracle) && journey.oracle.length)) { needList.push(journey); continue; }
    rows.push(...(oracle ? [await runJourneyOracle(buddy, page, journey)] : await runJourneyAgent(buddy, page, journey, repeat, shouldStop)));
  }
  return { rows, needList };
}

/** The per-app results summary (pure: the queue runner builds the same shape). */
export function journeySummary({ model, scope, split, repeat, oracle, app, journeyList, rows, needList, base }) {
  const byId = new Map();
  for (const row of rows) byId.set(row.id, [...(byId.get(row.id) ?? []), row]);
  const solved = [...byId.values()].filter((list) => list.every((r) => r.pass)).length;
  return {
    model, journeys: scope, split, repeat, oracle: Boolean(oracle), app,
    total: journeyList.length, solved, runs: rows.length, pass: rows.filter((r) => r.pass).length,
    needs: needList.map((j) => j.id), base, generatedAt: new Date().toISOString()
  };
}

/** The results file name (pure, unit-tested): journeys-<app>-<split>-<model>-<stamp>.json. */
export const resultsFileName = (app, split, model, stamp) => `journeys-${app}-${split}-${model}-${stamp}.json`;

/** Print the per-run lines and the NEEDS list for one app's rows. */
export function printJourneyRows(rows, needList) {
  for (const row of rows) {
    const failed = row.checks.filter((c) => !c.ok);
    const rep = row.rep ? ` rep ${row.rep}/${row.repeat}` : ' oracle';
    console.log(`${row.pass ? 'PASS' : 'FAIL'} ${row.id}${rep} ${row.seconds}s checks=${row.checks.length - failed.length}/${row.checks.length} ${failed.length ? failed.map((c) => `${c.kind}: ${c.detail}`).join('; ') : row.error ? '[' + row.error + ']' : 'all checks passed'}`);
  }
  for (const journey of needList) console.log(`NEEDS ${journey.id}: ${journey.needs}`);
}

async function runJourneys(args) {
  const { model, base, split, repeat, oracle } = args;
  if (!['train', 'holdout', 'all'].includes(split)) { console.error(`--split must be train, holdout or all (got ${split})\n` + USAGE); process.exit(1); }
  if (!Number.isInteger(repeat) || repeat < 1) { console.error('--repeat must be a positive integer'); process.exit(1); }
  // Oracle runs use no model, so --models does not apply to them.
  const models = oracle ? [model] : (args.models ? args.models.split(',').map((s) => s.trim()).filter(Boolean) : [model]);
  if (!models.length) { console.error('--models needs at least one model'); process.exit(1); }
  let byApp;
  try { byApp = loadJourneys(args.journeys); }
  catch (error) { console.error(error.message); process.exit(1); }
  for (const [app, journeys] of [...byApp]) byApp.set(app, journeys.filter((j) => split === 'all' || j.split === split));
  if (![...byApp.values()].some((list) => list.length)) { console.error(`no journeys match (split=${split}, journeys=${args.journeys})`); process.exit(1); }
  console.log(`journeys: models=${models.join(',')} apps=${[...byApp.keys()].join(',')} split=${split} repeat=${repeat} oracle=${oracle ? 'on' : 'off'} base=${base}`);

  // One shared session for every model: the runner selects each model in the agent's
  // picker, loads it (up to 30 min for a first download) and runs that model's journeys.
  const { ctx, page, buddy } = await launchEval(base);
  const outDir = join(ROOT, 'tests/agent-eval/results');
  mkdirSync(outDir, { recursive: true });
  const stamp = Date.now();
  try {
    for (const m of models) {
      if (!oracle) await loadModel(buddy, m);
      console.log(`== model ${m} ==`);
      for (const [app, journeys] of byApp) {
        const { rows, needList } = await runJourneyAll(buddy, page, app, journeys, { repeat, oracle });
        printJourneyRows(rows, needList);
        const summary = journeySummary({ model: m, scope: args.journeys, split, repeat, oracle, app, journeyList: journeys, rows, needList, base });
        const outFile = join(outDir, resultsFileName(app, split, m, stamp));
        writeFileSync(outFile, JSON.stringify({ summary, results: rows }, null, 1));
        console.log(`JOURNEYS ${app} [${m}]: solved ${summary.solved}/${journeys.length} (runs ${summary.pass}/${rows.length}${oracle ? ', oracle' : ''})  wrote ${outFile}`);
      }
    }
  } catch (error) {
    if (error?.fatal) { console.error(error.message); await ctx.close(); process.exit(1); }
    throw error;
  } finally {
    await ctx.close();
  }
}

// Run only as a script, so a probe can import the checks (a positive control for each one).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error('eval failed:', error); process.exit(1); });
