// Sqliteviz pack: drive the vendored SQLiteViz Vue app (public/pc/vendor/sqliteviz), which runs
// in the #sqliteviz-frame inner iframe of the app page (pcHost.appWindow('sqliteviz') resolves
// the wrapper page, scripts/pc/apps/sqliteviz.mjs, whose readiness rule is: #app exists and its
// static #sqliteviz-loading-wrapper has been replaced by the mounted app). The app is a plain
// Vue build with no public API, so the tools drive the DOM surface (all selectors confirmed in
// the bundle index-bU6rOQZr.js): a database is dropped onto div.drop-area (the db-uploader in
// "illustrated" mode; after a load only the small browse picker remains) and the uploader's
// drop handler reads dataTransfer.files[0] (checkFile: the name must match the app's own
// isDatabase regex /\.(db|sqlite(3)?)+$/, case-sensitive, when the file has no MIME type);
// the schema names are #schema-container .table-name (the render prepends a space); the open
// database name is #db .db-name; load failures land in the static #error div; query tabs are
// div.tab-content-container (v-show, the visible one has style.display !== 'none') inside
// #tabs headers div.tab.tab-selected.
// The SQL editor is CodeMirror 5.65.18 (vendor-DIEro6HE.js). This build exposes no instance on
// the DOM (the wrapper element carries no cm property; verified against cm5-lib.js 5.65.18), so
// run_query drives the hidden input textarea (the CM5 TextareaInput, cm5-lib.js:9369-9405: a
// classless textarea inside .CodeMirror whose 'input' event triggers the poll that reads its
// value). The run button is the IconButton whose icon is i.myicon-run (button.icon-btn,
// title "Run SQL query"; live-confirmed). The app debounces the editor's onChange by
// 400 ms before it copies the editor text into its model and re-enables the run button,
// and the run executes the model's SQL, so the click waits at least 600 ms past the input
// event (a second run clicked earlier re-runs the previous query; live-confirmed). Results
// render in the .run-result-panel: .result-in-progress while running, and once the query
// finishes the .result-set-container holds the column headers as div.fixed-header cells,
// the rows as table.sqliteviz-table tbody tr > td cells and the footer "N rows retrieved
// in <s>s" (live shape, confirmed after a real run); the footer is read from the
// container's innerText anchored to a line start, because in textContent the last cell
// runs into it (live: "80" + "2 rows retrieved" reads as "802"), and the hidden
// .result-empty preview ("No rows retrieved according to your query") is a different
// element and is never read as the footer; a SQL error renders inside the panel as a
// span.msg-text whose text starts with "Error:" (the global .error div, the same element
// as #error, stays empty for query errors; live-confirmed). The app resets the run state
// asynchronously after the run click, so the previous run's terminal state - including a
// write's empty preview - is still visible right after the click; the panel fingerprint is
// therefore captured before the click, and a terminal state is accepted only once the new
// run is known to have happened (the .result-in-progress marker was seen, or the
// fingerprint left the pre-run state; the footer's elapsed time differs per run, so a
// repeated query changes the text). An identical terminal state whose run was never
// observed is never read stale: the tool times out instead, and the retry returns data.
import { ToolError } from '../../../src/apps/ai-agent/runtime/args.mjs';
import { innerApi } from '../../shared/inner-app.js';

const APP = 'sqliteviz';
const NEEDS = ['host', 'app:sqliteviz'];
const NOT_HERE = 'SQLiteViz is not available here (WebPC Agent is not running inside WebPC).';

// Gate on ctx.host (needs: ['host', 'app:sqliteviz']), then turn host rejections, which carry a
// code (unknown_app, not_open, not_iframe, timeout), innerApi's not_available and Files
// readBytes rejections (not_found, not_a_file, too_large) into a ToolError.
const call = (ctx, fn) => {
  if (!ctx.host) throw new ToolError('not_available', NOT_HERE, '');
  return Promise.resolve()
    .then(() => fn(ctx.host))
    .catch(error => {
      if (error instanceof ToolError) throw error;
      throw new ToolError(error.code || 'app_error', error.message, '');
    });
};

// Dig into the #sqliteviz-frame inner window; ready once #app no longer holds the static
// loading wrapper (the wrapper page polls the same rule, scripts/pc/apps/sqliteviz.mjs).
const app = async (host, ctx) => innerApi(await host.appWindow(APP), 'sqliteviz-frame', win => {
  const root = win.document?.getElementById?.('app');
  return root && !root.querySelector('#sqliteviz-loading-wrapper') ? win : null;
}, { sleep: ctx.sleep, timeoutMs: ctx.timeoutMs });
const sleepOf = ctx => ctx.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));

// The visible query tab's content container (v-show: style.display !== 'none').
const activeContainer = win => [...win.document.querySelectorAll('.tab-content-container')].find(c => c.style?.display !== 'none') ?? null;

// The result-set footer ("N rows retrieved in <s>s"), read from the container's innerText and
// anchored to a line start: in textContent the last cell runs straight into the footer (live:
// "80" + "2 rows retrieved" would read as "802"). The hidden .table-preview.result-empty
// element ("No rows retrieved according to your query") is a different leaf and is never read.
const footerCount = el => {
  const match = (el?.innerText ?? '').match(/(?:^|\n)\s*(\d+) rows? retrieved in/);
  return match ? Number(match[1]) : null;
};

// The result set (live shape after a real run): the column headers are the div.fixed-header
// cells of .result-set-container, the rows are the table.sqliteviz-table tbody tr > td cells,
// and the rowCount is the footer total. Large results are capped for the model.
const readResult = panel => {
  const container = panel.querySelector('.result-set-container') ?? panel;
  const columns = [...container.querySelectorAll('div.fixed-header')].map(h => h.textContent.trim());
  const table = container.querySelector('table.sqliteviz-table') ?? panel.querySelector('table.sqliteviz-table');
  const bodyRows = table ? [...(table.querySelector('tbody') ?? table).querySelectorAll('tr')] : [];
  const rows = bodyRows.slice(0, 200).map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent.trim()));
  const count = footerCount(container);
  return { columns, rows, rowCount: count ?? rows.length, truncated: bodyRows.length > 200 };
};

export const pack = { id: APP, title: 'SQLiteViz' };

export const tools = [
  {
    name: 'sqliteviz.open_db',
    purpose: 'Open a SQLite database from the Files app (drops it into the app).',
    when: 'Use when the user wants to query a SQLite database.',
    params: { path: { type: 'path', required: true, description: 'The .db, .sqlite or .sqlite3 file path in the Files app' } },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { path: '/data/shop.db' }, says: 'Open this database' }],
    // The drop path (db-uploader, bundle checkFile): a File on a DataTransfer, dispatched as a
    // drop event on div.drop-area; the app validates the name with isDatabase (a file from
    // readBytes has no MIME type, so the case-sensitive name regex decides) and the magic
    // bytes are checked by the worker. The app is hash-routed: the home page (#/) shows the
    // uploader's div.drop-area, but only a few seconds after the Vue app has mounted, while a
    // workspace route means a database is already open. So the route is checked first, and on
    // the home page the drop area is polled for (30 s cap) rather than assumed - a temporarily
    // absent drop area is a load delay, not an open database.
    run: async (args, ctx) => call(ctx, async host => {
      const read = ctx.files?.readBytes;
      if (typeof read !== 'function') throw new ToolError('not_available', 'the Files tools are not enabled here, so no database can be opened', '');
      const file = await read(args.path);
      if (!/\.(db|sqlite(3)?)+$/.test(file.name)) throw new ToolError('invalid_argument', `"${file.name}" is not a SQLite database name (the app accepts .db, .sqlite and .sqlite3 files; CSV and JSON files take a different import path)`, '');
      const win = await app(host, ctx);
      const isHome = route => { const r = route ?? ''; return r === '' || r === '#' || r === '#/'; };
      if (!isHome(win.location?.hash)) {
        throw new ToolError('app_error', `a database is already open in the app (route is ${win.location?.hash ?? ''}); close it in the app and try again`, '');
      }
      const sleep = sleepOf(ctx);
      let dropArea = null;
      for (let i = 0; i < 300; i++) { // 30 s: the uploader renders a few seconds after mount
        dropArea = win.document.querySelector('div.drop-area');
        if (dropArea) break;
        if (!isHome(win.location?.hash)) {
          throw new ToolError('app_error', `a database is already open in the app (route is ${win.location?.hash ?? ''}); close it in the app and try again`, '');
        }
        await sleep(100);
      }
      if (!dropArea) throw new ToolError('app_error', 'the drop area did not appear within 30 s; the app may still be loading, so wait and try again', '');
      const dt = new win.DataTransfer();
      dt.items.add(new win.File([file.bytes], file.name));
      dropArea.dispatchEvent(new win.DragEvent('drop', { bubbles: true, dataTransfer: dt }));
      for (let i = 0; i < 120; i++) { // 60 s: the worker parses the database
        const error = win.document.querySelector('#error')?.textContent?.trim();
        if (error) throw new ToolError('app_error', `the app could not open the database: ${error}`, '');
        const db = win.document.querySelector('#db .db-name')?.textContent?.trim();
        if (db) return { db };
        await sleep(500);
      }
      throw new ToolError('app_error', 'the database did not finish loading within 60 s; the file may be large, so wait and try sqliteviz.list_tables', '');
    }),
  },
  {
    name: 'sqliteviz.list_tables',
    purpose: 'List the tables (and views) of the open database.',
    when: 'Use when checking what is in the database, or before running queries.',
    params: {},
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: {}, says: 'What tables are in this database?' }],
    // The schema panel lists every schema name in #schema-container as .table-name; the app
    // render prepends a space to each name, so trim.
    run: async (args, ctx) => call(ctx, async host => {
      const win = await app(host, ctx);
      if (!win.document.querySelector('#db .db-name')) throw new ToolError('app_error', 'no database is open (open one first with sqliteviz.open_db)', '');
      const tables = [...win.document.querySelectorAll('#schema-container .table-name')].map(el => el.textContent.trim());
      if (!tables.length) throw new ToolError('app_error', 'the app has not listed the schema yet; wait a moment and try again', '');
      return { tables };
    }),
  },
  {
    name: 'sqliteviz.run_query',
    purpose: 'Run a SQL statement in the open database and read its result table.',
    when: 'Use when the user wants to query or modify data in the open database.',
    params: { sql: { type: 'text', required: true, description: 'The SQL to run, e.g. SELECT * FROM users LIMIT 10' } },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { sql: 'SELECT name, value FROM settings LIMIT 5' }, says: 'Show the settings table' }],
    // Type into the editor through the CM5 hidden input textarea (there is no cm instance on
    // the DOM in this build). The app's onChange is debounced by 400 ms before it copies the
    // editor text into its model and re-enables the run button, and the run executes the
    // model's SQL - so the click waits at least 600 ms past the input event, no matter whether
    // the button is already enabled (live: a second run_query clicked early re-ran the
    // previous query from the model). Then detect completion from the result panel: the "N
    // rows retrieved in <s>s" footer of .result-set-container, read from its innerText and
    // anchored to a line start, once the container text has changed since before the run (the
    // footer's elapsed time differs per run, so a repeated query is not read stale), or a
    // new/changed "Error:"-prefixed span.msg-text inside the result panel for SQL errors
    // (the global .error div stays empty for query errors; live-confirmed). A freshly
    // opened database shows the workspace's "Create new inquiry" page (no query editor,
    // button#create-btn with the text "Create"; live-confirmed): the tool creates the
    // inquiry the app's own way, waits for the SQL editor to mount (10 s cap) and then
    // proceeds; a second run_query reuses the open tab.
    run: async (args, ctx) => {
      // Small models bring parameterised placeholders (lfm3-1.7b sent VALUES (7,?, 13.50) on
      // sqliteviz-04): a ? outside string literals has no bind value here and corrupts the
      // row, so refuse it with the inline fix before touching the app.
      if (String(args.sql).replace(/'(?:[^']|'')*'/g, '').includes('?')) {
        throw new ToolError('invalid_argument', 'no ? placeholders here: write the values inline in the SQL, e.g. VALUES (7, 2, 9.99)', '');
      }
      return call(ctx, async host => {
      const win = await app(host, ctx);
      const sleep = sleepOf(ctx);
      const taOf = c => (c?.querySelector('.CodeMirror textarea') ?? null);
      let container = activeContainer(win);
      if (!taOf(container)) {
        // No open query editor. With a database open but no inquiry yet, the workspace shows
        // the Create page; with an inquiry open the editor may simply still be mounting.
        if (!container) {
          const createBtn = win.document.getElementById('create-btn');
          if (!createBtn) {
            if (!win.document.querySelector('#db .db-name')) {
              throw new ToolError('app_error', 'no database is open (open one first with sqliteviz.open_db)', '');
            }
            throw new ToolError('app_error', 'the Create button was not found in the app workspace; the app may still be loading', '');
          }
          createBtn.click();
        }
        for (let i = 0; i < 100; i++) { // 10 s: the app mounts the SQL editor for the new inquiry
          container = activeContainer(win);
          if (taOf(container)) break;
          await sleep(100);
        }
        if (!taOf(container)) throw new ToolError('app_error', 'the SQL editor did not appear within 10 s; the app may still be loading, so wait and try again', '');
      }
      const ta = taOf(container);
      ta.focus();
      ta.value = args.sql;
      ta.dispatchEvent(new win.Event('input'));
      const runBtn = [...container.querySelectorAll('i.myicon-run')][0]?.closest?.('button');
      if (!runBtn) throw new ToolError('app_error', 'the run button was not found in the app', '');
      // The run executes the model's SQL, and the model only picks up the typed text after the
      // app's 400 ms onChange debounce. On a second run_query the button is already enabled,
      // so "wait until enabled" is not enough (live: the second run re-ran the previous
      // query); wait at least 600 ms past the input event, up to 5 s for the cold first
      // enable.
      for (let i = 0; i < 50; i++) { // 5 s
        if (i >= 6 && !runBtn.disabled) break; // 600 ms past the input event, button enabled
        await sleep(100);
      }
      if (runBtn.disabled) throw new ToolError('app_error', 'the run button stayed disabled (no database is open, or the editor did not accept the query)', '');
      // The live result panel (confirmed after real runs): the column headers (div.fixed-header)
      // and the "N rows retrieved in <s>s" footer live in .result-set-container, the rows are
      // in the table.sqliteviz-table cells, a DML run leaves the .table-preview.result-empty
      // preview visible, and a SQL error renders as a span.msg-text inside the panel whose
      // text starts with "Error:" (the global .error div, the same element as #error, stays
      // empty for query errors). The fingerprint (result text, empty preview, error texts) is
      // captured before the click: the app resets the run state asynchronously after the
      // click, so the previous run's terminal state - a write's empty preview included - is
      // still visible right after it (the oracle-run race that read a write's empty preview
      // as the next SELECT's result). A terminal state is accepted only once the new run is
      // known to have happened: the .result-in-progress marker was seen, or the fingerprint
      // left the pre-run state (the footer's elapsed time differs per run, so a repeated
      // query changes the text). An identical terminal state whose run was never observed
      // times out instead of being read stale; only a new or changed error message is a
      // failure of this run (a repeated identical error is one too, once the run was seen).
      const panel = container.querySelector('.run-result-panel');
      if (!panel) throw new ToolError('app_error', 'the result panel was not found in the app', '');
      const errorEl = win.document.querySelector('.error');
      const emptyVisible = () => {
        const empty = panel.querySelector('.table-preview.result-empty');
        return Boolean(empty && empty.style?.display !== 'none');
      };
      const before = {
        result: panel.querySelector('.result-set-container')?.textContent ?? '',
        error: (errorEl?.textContent ?? '').trim(),
        message: (panel.querySelector('span.msg-text')?.textContent ?? '').trim(),
        empty: emptyVisible(),
      };
      runBtn.click();
      let started = false;
      let sawInProgress = false;
      for (let i = 0; i < 600; i++) { // 60 s: the query may be long-running
        const errText = (errorEl?.textContent ?? '').trim();
        if (errText && errText !== before.error) throw new ToolError('app_error', `the query failed: ${errText}`, '');
        if (panel.querySelector('.result-in-progress')) {
          // The run is in flight: its terminal state, whatever it is, belongs to this run.
          started = true;
          sawInProgress = true;
          await sleep(100);
          continue;
        }
        const resultEl = panel.querySelector('.result-set-container');
        const resultText = resultEl?.textContent ?? '';
        const emptyNow = emptyVisible();
        if (resultText !== before.result || emptyNow !== before.empty) started = true;
        const msgText = (panel.querySelector('span.msg-text')?.textContent ?? '').trim();
        if (msgText.startsWith('Error:') && started && (msgText !== before.message || sawInProgress)) {
          // The app's own error text minus the "Error:" prefix (live: "Error: no such table: nope.")
          throw new ToolError('app_error', `the query failed: ${msgText.replace(/^Error:\s*/, '')}`, '');
        }
        if (footerCount(resultEl) !== null && resultText !== before.result) {
          const result = readResult(panel);
          // b17 sqliteviz-04: lfm3 read the whole (capped) orders table and counted by
          // hand, one customer at a time, for twenty rounds: point at SQL aggregation.
          if (result.truncated) result.note = 'rowCount is the total but only 200 rows are shown: do not count rows by hand - aggregate in SQL (COUNT(*), GROUP BY customer, ORDER BY n DESC LIMIT 1)';
          return result;
        }
        if (emptyNow && started) return { columns: [], rows: [], rowCount: 0, truncated: false };
        await sleep(100);
      }
      throw new ToolError('app_error', 'the query did not finish within 60 s; it may still be running, so wait and run a lighter query', '');
      });
    },
  },
];
