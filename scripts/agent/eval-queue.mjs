#!/usr/bin/env node
// Queue runner for journey evals: holds ONE shared browser session (the eval runner's
// launch, page and frame helpers, imported from eval.mjs - never copied) and processes
// teammates' request files one at a time, so every lane shares the single webpc session
// and its downloaded models instead of each launching its own browser.
//
//   node scripts/agent/eval-queue.mjs [--queue <dir>] [--base http://127.0.0.1:4333]
//
// A request file <id>.json in the queue directory is:
//   { id, requester, journeys: "<app>" | ["<journey id>", ...], split, models: [...], repeat, oracle }
// (split defaults to train, repeat to 1, oracle to false). The runner takes the oldest
// request - preferring one that reuses the last model so it avoids a switch - writes
// <id>.running, runs it, writes <id>.result.json (the same shape as a results file) and
// <id>.done, then moves on. It never runs two requests at once. A request that fails to
// parse or validate gets <id>.error with the reason. Ctrl+C stops after the current
// journey. Pure parts (validateRequest, nextRequest, requestFileNames) are unit-tested
// in tests/agent-eval-queue.test.mjs.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchEval, loadModel, loadJourneys, runJourneyAll, journeySummary, printJourneyRows } from './eval.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_QUEUE = '.lanes/scratch/journeys/queue'; // cwd-relative: the lead starts the runner
const POLL_MS = 5_000;
const USAGE = 'usage: node scripts/agent/eval-queue.mjs [--queue <dir>] [--base http://127.0.0.1:4333]';

// ---- pure parts (unit-tested in tests/agent-eval-queue.test.mjs) --------------

/** The state-file names for one request id. */
export function requestFileNames(id) {
  return { request: `${id}.json`, running: `${id}.running`, result: `${id}.result.json`, done: `${id}.done`, error: `${id}.error` };
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SPLITS = ['train', 'holdout', 'all'];
const str = v => typeof v === 'string' && v.length > 0;

/** Validate and normalise a request. Returns { ok: true, request } or { ok: false, errors }. */
export function validateRequest(raw) {
  const errors = [];
  const req = {};
  if (!str(raw?.id) || !ID_RE.test(raw.id)) errors.push('id must be a non-empty filename-safe string (letters, digits, dot, dash, underscore)');
  else req.id = raw.id;
  if (!str(raw?.requester)) errors.push('requester must be a non-empty string');
  else req.requester = raw.requester;
  if (str(raw?.journeys)) req.journeys = raw.journeys;
  else if (Array.isArray(raw?.journeys) && raw.journeys.length > 0 && raw.journeys.every(str)) req.journeys = raw.journeys;
  else errors.push('journeys must be an app id (like "terminal", or "all") or a non-empty list of journey ids');
  if (raw?.split === undefined) req.split = 'train';
  else if (SPLITS.includes(raw.split)) req.split = raw.split;
  else errors.push(`split must be one of ${SPLITS.join(', ')}`);
  if (Array.isArray(raw?.models) && raw.models.length > 0 && raw.models.every(str)) req.models = raw.models;
  else errors.push('models must be a non-empty list of model keys');
  if (raw?.repeat === undefined) req.repeat = 1;
  else if (Number.isInteger(raw.repeat) && raw.repeat >= 1) req.repeat = raw.repeat;
  else errors.push('repeat must be a positive integer');
  if (raw?.oracle === undefined) req.oracle = false;
  else if (typeof raw.oracle === 'boolean') req.oracle = raw.oracle;
  else errors.push('oracle must be true or false');
  return errors.length ? { ok: false, errors } : { ok: true, request: req };
}

/** The next request to run: the oldest first (queueTime, then id for ties), preferring
 *  one that reuses the last model so a switch is avoided while the session is warm. */
export function nextRequest(requests, lastModel = null) {
  const sorted = [...requests].sort((a, b) => a.queueTime - b.queueTime || a.id.localeCompare(b.id));
  // Oracle runs need no model and take seconds: they go first, so a lane fixing its journeys
  // never waits behind a long model baseline.
  const oracle = sorted.find((r) => r.oracle);
  if (oracle) return oracle;
  const matching = lastModel ? sorted.filter((r) => r.models.includes(lastModel)) : [];
  return (matching.length ? matching[0] : sorted[0]) ?? null;
}

// ---- main ---------------------------------------------------------------------

/** Scan the queue directory for pending requests (skipped once .done or .error exists). */
function scanRequests(queueDir) {
  const out = [];
  for (const name of readdirSync(queueDir)) {
    if (!name.endsWith('.json') || name.endsWith('.result.json')) continue; // results are not requests
    const id = name.slice(0, -'.json'.length);
    const names = requestFileNames(id);
    if (existsSync(join(queueDir, names.done)) || existsSync(join(queueDir, names.error))) continue;
    const file = join(queueDir, name);
    let raw;
    try { raw = JSON.parse(readFileSync(file, 'utf8')); }
    catch (error) { writeFileSync(join(queueDir, names.error), `parse error: ${error.message}\n`); continue; }
    const v = validateRequest(raw);
    if (!v.ok) { writeFileSync(join(queueDir, names.error), v.errors.join('\n') + '\n'); continue; }
    if (v.request.id !== id) { writeFileSync(join(queueDir, names.error), `id mismatch: the file is ${id}.json but the request says ${v.request.id}\n`); continue; }
    out.push({ ...v.request, queueTime: statSync(file).mtimeMs, file });
  }
  return out;
}

const sleep = ms => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const argv = process.argv.slice(2);
  let queueDir = DEFAULT_QUEUE, base = 'http://127.0.0.1:4333';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--queue') queueDir = argv[++i];
    else if (a === '--base') base = argv[++i];
    else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
  }
  mkdirSync(queueDir, { recursive: true });
  console.log(`eval-queue: queue=${queueDir} base=${base} (one shared session; Ctrl+C stops after the current journey)`);
  const { ctx, page, buddy } = await launchEval(base, 'off', { handleSIGINT: false });

  let stop = false;
  process.on('SIGINT', () => { stop = true; console.log('stopping after the current journey...'); });
  let lastModel = null;
  try {
    for (;;) {
      if (stop) break;
      const candidates = scanRequests(queueDir);
      if (!candidates.length) { await sleep(POLL_MS); continue; }
      const pick = nextRequest(candidates, lastModel);
      const names = requestFileNames(pick.id);
      console.log(`next: ${pick.id} (requester ${pick.requester}, models ${pick.models.join(', ')}, ${Array.isArray(pick.journeys) ? pick.journeys.length + ' journeys' : 'app ' + pick.journeys}, split ${pick.split}, repeat ${pick.repeat}${pick.oracle ? ', oracle' : ''})`);
      writeFileSync(join(queueDir, names.running), new Date().toISOString() + '\n');
      let byApp;
      try { byApp = loadJourneys(Array.isArray(pick.journeys) ? 'all' : pick.journeys, Array.isArray(pick.journeys) ? pick.journeys : null); }
      catch (error) { writeFileSync(join(queueDir, names.error), error.message + '\n'); rmSync(join(queueDir, names.running), { force: true }); console.log(`rejected ${pick.id}: ${error.message}`); continue; }
      const results = [];
      const appSummaries = [];
      try {
        for (const m of pick.models) {
          // The loaded model's Load button is disabled, so loading it again would wait and time out.
          if (!pick.oracle && m !== lastModel) { await loadModel(buddy, m); lastModel = m; }
          for (const [app, journeys] of byApp) {
            const { rows, needList } = await runJourneyAll(buddy, page, app, journeys, { repeat: pick.repeat, oracle: pick.oracle, shouldStop: () => stop });
            printJourneyRows(rows, needList);
            appSummaries.push(journeySummary({ model: m, scope: Array.isArray(pick.journeys) ? pick.journeys.join(',') : pick.journeys, split: pick.split, repeat: pick.repeat, oracle: pick.oracle, app, journeyList: journeys, rows, needList, base }));
            for (const row of rows) results.push({ ...row, model: m });
          }
        }
      } catch (error) {
        if (error?.fatal) {
          writeFileSync(join(queueDir, names.error), error.message + '\n');
          console.error(error.message);
          await ctx.close();
          process.exit(1); // the shared session is broken; no request can run until it restarts
        }
        // Any other failure ends this request only; the runner keeps serving the queue.
        writeFileSync(join(queueDir, names.error), `${error?.message ?? error}\n`);
        console.log(`failed ${pick.id}: ${String(error?.message ?? error).split('\n')[0]}`);
        continue;
      }
      if (stop) {
        // Stopped part way: leave the request pending (no .done, no result) so it reruns in full.
        rmSync(join(queueDir, names.running), { force: true });
        console.log(`stopped during ${pick.id}; it stays queued and reruns in full`);
        break;
      }
      const out = {
        summary: {
          id: pick.id, requester: pick.requester, journeys: pick.journeys, split: pick.split,
          models: pick.models, repeat: pick.repeat, oracle: pick.oracle,
          apps: Object.fromEntries(appSummaries.map((s) => [s.app, { total: s.total, solved: s.solved, runs: s.runs, pass: s.pass, needs: s.needs }])),
          base, generatedAt: new Date().toISOString()
        },
        results
      };
      writeFileSync(join(queueDir, names.result), JSON.stringify(out, null, 1));
      writeFileSync(join(queueDir, names.done), new Date().toISOString() + '\n');
      console.log(`done: ${pick.id} (results: ${join(queueDir, names.result)})`);
    }
  } finally {
    await ctx.close();
  }
  if (stop) console.log('stopped');
}

// Run only as a script (the queue runner must not start when imported for its pure parts).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error('eval-queue failed:', error); process.exit(1); });
