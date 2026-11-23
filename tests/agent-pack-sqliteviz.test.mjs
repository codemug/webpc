// Unit tests for the Sqliteviz pack: agent/apps/sqliteviz/tools.js and skills.md.
// The fake inner window mirrors the vendored SQLiteViz DOM the pack drives
// (public/pc/vendor/sqliteviz/assets/index-bU6rOQZr.js plus the wrapper rule in
// src/scripts/pc/apps/sqliteviz.mjs): #app holding the static #sqliteviz-loading-wrapper until
// the app mounts; the db-uploader drop path (div.drop-area on the home route #/, drawn a few
// seconds after the window is ready and gone on a workspace route once a database is open; the
// drop handler reads dataTransfer.files[0], the app's isDatabase name regex /\.(db|sqlite(3)?)+$/
// decides and failures land in the static #error div); #db .db-name and #schema-container .table-name (the
// render prepends a space to each name); the workspace "Create new inquiry" page
// (button#create-btn, live-confirmed after open_db) whose click mounts the visible
// div.tab-content-container (v-show) with the CodeMirror 5.65 editor driven through the
// classless hidden input textarea (cm5-lib.js
// TextareaInput: the 'input' event triggers the poll), the run IconButton (button.icon-btn >
// i.myicon-run, whose click executes the app model's SQL - the model only picks up the typed
// text after the 400 ms-debounced onChange, so the tool waits at least 600 ms past the input
// event before clicking (a second run clicked earlier would re-run the previous query). The
// result panel is the live shape (confirmed after a real run): .result-in-progress while
// running, then .result-set-container holding the column headers as div.fixed-header cells,
// the rows as table.sqliteviz-table tbody tr > td cells and the "N rows retrieved in <s>s"
// footer whose elapsed time varies per run; the footer is read from the container's innerText
// anchored to a line start (in textContent the last cell runs into it, "80" + "2 rows
// retrieved" would read as "802"); a SQL error renders in the panel as a span.msg-text
// "Error: <message>" (the global .error div, the same element as #error, stays empty for
// query errors).
// Run: node --test tests/agent-pack-sqliteviz.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack, tools } from '../agent/apps/sqliteviz/tools.js';
import { tools as desktopTools } from '../agent/desktop/tools.js';
import { ToolError, specErrors, checkArgs } from '../src/apps/ai-agent/runtime/args.mjs';
import { parseSkills, checkSkills } from '../src/apps/ai-agent/runtime/skills.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_MD = readFileSync(join(HERE, '..', 'agent', 'apps', 'sqliteviz', 'skills.md'), 'utf8');
// The enabled app ids scripts/agent/build.mjs resolves the live 'apps' enum with (catalog.yaml).
const APP_IDS = ['gridcraft', 'docs', 'deckcraft', 'terminal', 'sqliteviz', 'files', 'media', 'cyberchef', 'vscode', 'nettools', 'packets', 'ai-agent', 'lightcraft', 'figcraft', 'pdfcraft', 'soundcraft', 'beepbox', 'filmcraft', 'cadcraft', 'vectorcraft', 'photocraft', 'effectcraft', 'materialcraft', 'texturecraft', 'excalidraw', 'vert'];
const choices = name => (name === 'apps' || name === 'windows' ? APP_IDS : []);
const byName = name => tools.find(tool => tool.name === name) ?? desktopTools.find(tool => tool.name === name);

const SQLITE_HEADER = 'SQLite format 3\0';
// Code points, not characters: a typed array constructor coerces string elements to NaN (0).
const headerBytes = () => new Uint8Array([...SQLITE_HEADER].map(c => c.charCodeAt(0)).concat([0, 0, 4, 0, 0, 0, 0]));
// Cell text, not objects: the tool reads td.textContent, so results are plain text. The
// GROUP BY dataset matches the lead's recheck (sales table, seeded in the live file).
const COLUMNS = ['name', 'value'];
const GROUP_COLUMNS = ['region', 'total'];
const GROUP_ROWS = [['North', '160'], ['South', '80']];
// The default SELECT result: 250 rows, so the tool's 200-row cap is exercised.
const BODY_ROWS = Array.from({ length: 250 }, (_, i) => [String(i), `v${i}`]);
const SCHEMA = ['sales']; // the seeded sample.db's schema, as the live recheck listed it

const fakeSqliteviz = () => {
  const fileStore = {
    '/data/shop.db': { bytes: headerBytes(), name: 'shop.db' },
    '/data/backup.sqlite3': { bytes: headerBytes(), name: 'backup.sqlite3' },
    '/data/notes.csv': { bytes: new Uint8Array([1, 2, 3]), name: 'notes.csv' },
    '/data/broken.db': { bytes: new Uint8Array([9, 9, 9, 9, 16]), name: 'broken.db' },
  };
  const state = { mounted: false, loading: false, loaded: false, query: '', running: false, result: 'pending', error: '', columns: COLUMNS, rows: BODY_ROWS, runs: 0, drops: 0, dropReads: 0, inquiryCreated: false, createClicks: 0 };
  const location = { hash: '#/' }; // the app is hash-routed; a fresh window sits on the home page

  const loadingWrapper = { textContent: 'Loading' };
  const appEl = { querySelector: sel => (sel === '#sqliteviz-loading-wrapper' ? (state.mounted ? null : loadingWrapper) : null) };
  const errorEl = { textContent: '' };
  const dbName = { textContent: '' };
  const tableNames = [];
  const tabHeaders = [{ classList: { contains: c => c === 'tab-selected' }, textContent: 'Query 1' }];
  const tabsEl = { querySelectorAll: sel => (sel === '.tab' ? (state.loaded ? tabHeaders : []) : []) };

  // The CM5 hidden input textarea (cm5-lib.js:8277): classless, inside .CodeMirror; its
  // 'input' event runs the poll that reads the value (cm5-lib.js:9405).
  const ta = {
    value: '', focused: false, listeners: {},
    focus() { ta.focused = true; },
    addEventListener(type, fn) { (ta.listeners[type] ??= []).push(fn); },
    dispatchEvent(event) { (ta.listeners[event.type] ?? []).forEach(fn => fn(event)); return true; },
  };
  // The run IconButton (bundle: button.icon-btn > div.icon > i.myicon-run); the app enables it
  // once the 400 ms-debounced onChange has stored the query and a database is open.
  const runBtn = { disabled: true, click() { executeQuery(); } };
  const icon = { closest: sel => (sel === 'button' ? runBtn : null) };
  const updateRunBtn = () => { runBtn.disabled = !state.loaded || !state.query || state.running; };
  // The app's 400 ms onChange debounce (live-confirmed): the model - state.query, what the run
  // executes - picks up the typed text only ~400 ms after the input event (four 100 ms
  // microtask hops).
  ta.addEventListener('input', () => {
    let hops = 4;
    const hop = () => {
      if (--hops > 0) { queueMicrotask(hop); return; }
      state.query = ta.value;
      updateRunBtn();
    };
    queueMicrotask(hop);
  });
  // The app's run: it executes the model's SQL (state.query), not whatever is in the textarea.
  // A SQL error renders in the result panel as a span.msg-text "Error: <message>" (live: the
  // global .error div and #error stay empty for query errors); the panel resets it when a new
  // run starts. A SELECT from a table of the seeded database returns rows (a GROUP BY on sales
  // returns the region totals the live recheck expects, every other SELECT the capped 250-row
  // dataset); an unknown table is the app's own "no such table" error.
  const executeQuery = () => {
    if (!state.query) return;
    state.running = true; state.result = 'pending'; state.error = '';
    runBtn.disabled = true;
    queueMicrotask(() => {
      state.running = false;
      state.runs += 1; // the footer's elapsed time varies per run (the stale-guard input)
      const q = state.query.trim();
      const lower = q.toLowerCase();
      const from = /\bfrom\s+([a-z0-9_]+)/i.exec(lower);
      const unknownTable = from && !SCHEMA.includes(from[1]);
      if (/^(select|pragma)\b/i.test(lower) && unknownTable) {
        state.result = 'error';
        state.error = `no such table: ${from[1]}.`; // the live app text ends with a period
      } else if (/^(select|pragma)\b/i.test(lower)) {
        state.columns = /group\s+by/i.test(lower) ? GROUP_COLUMNS : COLUMNS;
        state.rows = /group\s+by/i.test(lower) ? GROUP_ROWS : BODY_ROWS;
        state.result = 'rows';
      } else if (/^(insert|update|delete|create|drop|alter|vacuum|begin|commit|rollback)\b/i.test(lower)) {
        state.result = 'empty';
      } else {
        state.result = 'error';
        state.error = `near "${q.slice(0, 10)}": syntax error`;
      }
    });
  };
  // table.sqliteviz-table (live probe): the rows are the tbody tr > td cell text.
  const table = {
    querySelector: sel => (sel === 'tbody' ? {
      querySelectorAll: () => state.rows.map(cells => ({
        querySelectorAll: s => (s === 'td' ? cells.map(text => ({ textContent: text })) : []),
      })),
    } : null),
  };
  // The live .result-set-container (confirmed after a real run): the column headers are the
  // div.fixed-header cells, the rows sit in table.sqliteviz-table and the footer "N rows
  // retrieved in <s>s" is its own block whose elapsed time varies per run. innerText
  // separates the blocks with newlines; textContent concatenates the text nodes straight, so
  // the last cell runs into the footer (live: "80" + "2 rows retrieved" would read as "802").
  // A query error replaces the container text with the error string (live probe).
  const resultContainer = {
    get textContent() {
      if (state.result === 'error') return `Error: ${state.error}`;
      if (state.result !== 'rows') return '';
      return `${state.columns.join('')}${state.rows.map(r => r.join('')).join('')}${state.rows.length} rows retrieved in 0.00${2 + state.runs}s`;
    },
    get innerText() {
      if (state.result === 'error') return `Error: ${state.error}`;
      if (state.result !== 'rows') return '';
      return `${state.columns.join('\n')}\n${state.rows.map(r => r.join('\n')).join('\n')}\n${state.rows.length} rows retrieved in 0.00${2 + state.runs}s`;
    },
    querySelectorAll: sel => (sel === 'div.fixed-header' ? state.columns.map(c => ({ textContent: c })) : []),
    querySelector: sel => (sel === 'table.sqliteviz-table' ? table : null),
  };
  // The result panel: .result-in-progress while running; the container holds the result once
  // the query finishes; a SQL error renders as a span.msg-text "Error: <message>" (the global
  // .error div stays empty); the DML empty-result preview is a v-show element.
  const panel = {
    querySelector: sel => ({
      '.result-in-progress': state.running ? { textContent: ' Fetching results... ' } : null,
      '.result-set-container': resultContainer,
      'span.msg-text': state.error ? { textContent: `Error: ${state.error}` } : null,
      '.table-preview.result-empty': { style: { display: state.result === 'empty' ? '' : 'none' } },
    }[sel] ?? null),
  };
  const container = {
    style: { display: 'none' },
    querySelector: sel => ({ '.CodeMirror textarea': ta, '.run-result-panel': panel }[sel] ?? null),
    querySelectorAll: sel => (sel === 'i.myicon-run' ? [icon] : []),
  };
  // The db-uploader drop area (bundle checkFile): only present before a database loads; the
  // drop handler reads dataTransfer.files[0].
  const dropArea = {
    listeners: {},
    addEventListener(type, fn) { (dropArea.listeners[type] ??= []).push(fn); },
    dispatchEvent(event) { (dropArea.listeners[event.type] ?? []).forEach(fn => fn(event)); return true; },
  };
  dropArea.addEventListener('drop', e => {
    const f = e.dataTransfer?.files?.[0];
    state.drops += 1;
    if (!f) { errorEl.textContent = 'You should drop a file. It can be an SQLite database, CSV file, JSON or NDJSON file.'; return; }
    if (!/\.(db|sqlite(3)?)+$/.test(f.name)) { errorEl.textContent = `Could not load ${f.name}.`; return; }
    state.loading = true;
    queueMicrotask(() => {
      state.loading = false;
      const head = f.bytes.slice(0, 16);
      if (head.length < 16 || String.fromCharCode(...head) !== SQLITE_HEADER) { errorEl.textContent = 'The file is not a valid SQLite database.'; return; }
      state.loaded = true;
      state.query = '';
      state.result = 'pending';
      location.hash = '#/workspace'; // opening a database moves the route to the workspace
      dbName.textContent = ` ${f.name.replace(/\.[^.]+$/, '')}`; // the render prepends a space
      tableNames.length = 0;
      for (const name of SCHEMA) tableNames.push({ textContent: ` ${name}` });
      container.style.display = '';
      updateRunBtn();
    });
  });
  // The workspace "Create new inquiry" page (live-confirmed after open_db): no query editor,
  // button#create-btn (text "Create"); clicking it mounts the inquiry tab with the CM5 editor.
  const createBtn = {
    click() {
      state.createClicks += 1;
      queueMicrotask(() => { state.inquiryCreated = true; });
    },
  };
  const document = {
    getElementById: id => (id === 'app' ? appEl : id === 'create-btn' ? (state.loaded && !state.inquiryCreated ? createBtn : null) : null),
    querySelector: sel => {
      if (sel === 'div.drop-area') {
        // The Vue app draws the drop area a few seconds after the window is ready (live: about
        // 4 s); the fake models the delay as absent reads (the tool polls every 100 ms).
        if (state.loaded) return null;
        state.dropReads += 1;
        return state.dropReads >= 5 ? dropArea : null;
      }
      return ({
        '#db .db-name': state.loaded ? dbName : null,
        '.error': errorEl, // the global error div carries id "error" and class "error"
        '#error': errorEl,
        '#tabs': tabsEl,
      }[sel] ?? null);
    },
    querySelectorAll: sel => (sel === '.tab-content-container' ? (state.loaded && state.inquiryCreated ? [container] : []) : sel === '#schema-container .table-name' ? (state.loaded ? tableNames : []) : []),
  };
  const File = class { constructor(parts, name) { this.name = name; this.bytes = parts[0]; } arrayBuffer() { return Promise.resolve(this.bytes); } };
  const DataTransfer = class { constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; } };
  const Event = class { constructor(type) { this.type = type; } };
  const DragEvent = class { constructor(type, init = {}) { this.type = type; this.dataTransfer = init.dataTransfer; } };
  const win = { File, DataTransfer, Event, DragEvent, document, location };
  queueMicrotask(() => { state.mounted = true; }); // the app mounts, replacing the loading wrapper
  const wrapper = { document: { getElementById: id => (id === 'sqliteviz-frame' ? { contentWindow: win } : null) } };
  const files = {
    readBytes: path => {
      const file = fileStore[path];
      if (!file) { const error = new Error(`${path} is not a file.`); error.code = 'not_found'; return Promise.reject(error); }
      return Promise.resolve({ path, name: file.name, bytes: file.bytes, size: file.bytes.length });
    },
  };
  const runTool = (name, args, extra = {}) => byName(name).run(args, { host: { appWindow: async () => wrapper }, files, sleep: async () => {}, ...extra });
  return { win, files, runTool, state, dropArea, ta, runBtn };
};

test('the pack declares its id and title', () => {
  assert.deepEqual(pack, { id: 'sqliteviz', title: 'SQLiteViz' });
});

test('the pack exposes exactly the 3 sqliteviz tools', () => {
  assert.equal(tools.length, 3);
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'sqliteviz.list_tables', 'sqliteviz.open_db', 'sqliteviz.run_query',
  ]);
});

test('every tool has the required text fields, effect, needs and examples', () => {
  for (const tool of tools) {
    assert.match(tool.name, /^sqliteviz\.[a-z0-9_]+$/);
    assert.ok(tool.purpose.length > 0 && tool.purpose.length <= 80, `${tool.name} purpose is ${tool.purpose.length} chars`);
    assert.ok(tool.when.startsWith('Use when'), `${tool.name} when must start with "Use when"`);
    assert.ok(tool.when.length <= 120, `${tool.name} when is ${tool.when.length} chars`);
    assert.ok(['read', 'change', 'destructive', 'external'].includes(tool.effect), `${tool.name} bad effect`);
    assert.deepEqual(tool.needs, ['host', 'app:sqliteviz']);
    assert.equal(typeof tool.run, 'function');
    assert.ok(tool.examples.length >= 1, `${tool.name} has examples`);
    for (const example of tool.examples) {
      assert.ok(example.args && typeof example.args === 'object' && !Array.isArray(example.args));
      assert.equal(typeof example.says, 'string');
    }
  }
});

test('every parameter spec passes the runtime specErrors check', () => {
  for (const tool of tools) assert.deepEqual(specErrors(tool.params), [], `${tool.name} params`);
});

test('every example passes the runtime checkArgs the way the build runs it', () => {
  for (const tool of tools) {
    for (const [n, example] of tool.examples.entries()) {
      const out = checkArgs(tool, example.args, { choices });
      assert.ok(out.ok, `${tool.name} example ${n}: ${out.error?.message}`);
    }
  }
});

test('sqliteviz.open_db drops a valid database and reports its name', async () => {
  const sv = fakeSqliteviz();
  const got = await sv.runTool('sqliteviz.open_db', { path: '/data/shop.db' });
  assert.deepEqual(got, { db: 'shop' });
  assert.equal(sv.state.drops, 1, 'the drop event was dispatched with a DataTransfer File');
  assert.equal(sv.state.loaded, true);
  assert.equal(sv.runBtn.disabled, true, 'the run button stays disabled until a query is typed');
  // The fake draws the drop area late (like the app, a few seconds after the window is ready),
  // so the tool had to poll for it instead of assuming an absent drop area means a db is open.
  assert.ok(sv.state.dropReads >= 5, `the drop area was absent for the first ${sv.state.dropReads - 1} polls`);
});

test('sqliteviz.open_db waits out the late drop-area draw before giving up on a fresh window', async () => {
  const sv = fakeSqliteviz();
  const got = await sv.runTool('sqliteviz.open_db', { path: '/data/backup.sqlite3' });
  assert.deepEqual(got, { db: 'backup' });
  assert.equal(sv.win.location.hash, '#/workspace', 'the route moved to the workspace once the database is open');
});

test('sqliteviz.open_db accepts a .sqlite3 name', async () => {
  const sv = fakeSqliteviz();
  const got = await sv.runTool('sqliteviz.open_db', { path: '/data/backup.sqlite3' });
  assert.deepEqual(got, { db: 'backup' });
});

test('sqliteviz.open_db rejects a non-database name before touching the app', async () => {
  const sv = fakeSqliteviz();
  await assert.rejects(sv.runTool('sqliteviz.open_db', { path: '/data/notes.csv' }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'invalid_argument');
    assert.match(error.message, /not a SQLite database name/);
    return true;
  });
  assert.equal(sv.state.drops, 0, 'the CSV takes the app import path, so nothing was dropped');
});

test('sqliteviz.open_db rejects bytes that are not a SQLite database', async () => {
  const sv = fakeSqliteviz();
  await assert.rejects(sv.runTool('sqliteviz.open_db', { path: '/data/broken.db' }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'app_error');
    assert.match(error.message, /the app could not open the database/);
    return true;
  });
  assert.equal(sv.state.loaded, false);
});

test('sqliteviz.open_db rejects when a database is already open (workspace route)', async () => {
  const sv = fakeSqliteviz();
  await sv.runTool('sqliteviz.open_db', { path: '/data/shop.db' });
  await assert.rejects(sv.runTool('sqliteviz.open_db', { path: '/data/backup.sqlite3' }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'app_error');
    assert.match(error.message, /already open in the app \(route is #\/workspace\)/);
    return true;
  });
  assert.equal(sv.state.drops, 1, 'no second drop was attempted');
});

test('sqliteviz.open_db passes the Files error code through for a missing file', async () => {
  const sv = fakeSqliteviz();
  await assert.rejects(sv.runTool('sqliteviz.open_db', { path: '/nope.db' }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_found');
    return true;
  });
});

test('sqliteviz.run_query returns the result table, capped, with the app row count', async () => {
  const sv = fakeSqliteviz();
  await sv.runTool('sqliteviz.open_db', { path: '/data/shop.db' });
  const got = await sv.runTool('sqliteviz.run_query', { sql: 'SELECT region, amount FROM sales' });
  assert.deepEqual(got.columns, COLUMNS);
  assert.equal(got.rowCount, 250, 'the footer count is the app total');
  assert.equal(got.rows.length, 200, 'the rows are capped for the model');
  assert.equal(got.truncated, true);
  assert.deepEqual(got.rows[0], ['0', 'v0']);
  assert.equal(sv.ta.focused, true, 'the hidden textarea was focused before typing');
});

test('sqliteviz.run_query creates the inquiry when the workspace has no editor, then reuses it', async () => {
  const sv = fakeSqliteviz();
  await sv.runTool('sqliteviz.open_db', { path: '/data/shop.db' });
  assert.equal(sv.state.inquiryCreated, false, 'a freshly opened database has no inquiry yet');
  const got = await sv.runTool('sqliteviz.run_query', { sql: 'SELECT region, amount FROM sales' });
  assert.deepEqual(got.columns, COLUMNS);
  assert.equal(sv.state.createClicks, 1, 'the app Create button was clicked once');
  assert.equal(sv.state.inquiryCreated, true, 'the SQL editor is mounted after the create');
  const again = await sv.runTool('sqliteviz.run_query', { sql: 'SELECT 1' });
  assert.deepEqual(again.columns, COLUMNS);
  assert.equal(sv.state.createClicks, 1, 'a second run_query reuses the open tab');
});

test('sqliteviz.run_query returns the exact GROUP BY answer the live probe showed, and a repeated query is not read stale', async () => {
  const sv = fakeSqliteviz();
  await sv.runTool('sqliteviz.open_db', { path: '/data/shop.db' });
  const sql = 'SELECT region, SUM(amount) AS total FROM sales GROUP BY region ORDER BY region';
  const got = await sv.runTool('sqliteviz.run_query', { sql });
  assert.deepEqual(got.columns, ['region', 'total']);
  assert.deepEqual(got.rows, [['North', '160'], ['South', '80']], 'text cells, as the live result table renders them');
  assert.equal(got.rowCount, 2, 'the rowCount comes from the app footer, not the row cap');
  assert.equal(got.truncated, false);
  // The second identical run must pass the stale guard: the footer's elapsed time varies per
  // run in the fake (as in the live app), so the container text differs from the pre-run capture.
  const again = await sv.runTool('sqliteviz.run_query', { sql });
  assert.deepEqual(again.rows, [['North', '160'], ['South', '80']]);
  assert.equal(again.rowCount, 2);
});

test('sqliteviz.run_query reports a DML statement as an empty result', async () => {
  const sv = fakeSqliteviz();
  await sv.runTool('sqliteviz.open_db', { path: '/data/shop.db' });
  const got = await sv.runTool('sqliteviz.run_query', { sql: "INSERT INTO sales (region, amount) VALUES ('East', 40)" });
  assert.deepEqual(got, { columns: [], rows: [], rowCount: 0, truncated: false });
});

test('sqliteviz.run_query second run executes the new SQL, not the previous query', async () => {
  const sv = fakeSqliteviz();
  await sv.runTool('sqliteviz.open_db', { path: '/data/shop.db' });
  const first = await sv.runTool('sqliteviz.run_query', { sql: 'SELECT region, SUM(amount) AS total FROM sales GROUP BY region ORDER BY region' });
  assert.deepEqual(first.rows, [['North', '160'], ['South', '80']]);
  // After the first run the run button is enabled and the model still holds the GROUP BY. A
  // click before the 400 ms model debounce would re-run the GROUP BY and return the previous
  // rows; the new SQL selects a table the seeded database does not have, so the new-SQL run
  // is observable only through the app's own error (live probe: a span.msg-text "Error: no
  // such table: nope." inside the result panel, while #error stays empty).
  await assert.rejects(sv.runTool('sqliteviz.run_query', { sql: 'SELECT * FROM nope' }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'app_error');
    assert.match(error.message, /the query failed: no such table: nope\./, 'the app error text, without the "Error:" prefix');
    return true;
  });
  assert.equal(sv.win.document.querySelector('#error').textContent, '', 'query errors do not land in the global #error div');
});

test('sqliteviz.run_query reports a syntax error from the engine', async () => {
  const sv = fakeSqliteviz();
  await sv.runTool('sqliteviz.open_db', { path: '/data/shop.db' });
  await assert.rejects(sv.runTool('sqliteviz.run_query', { sql: 'SELEKT nonsense' }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'app_error');
    assert.match(error.message, /the query failed:.*syntax error/);
    return true;
  });
});

test('sqliteviz.run_query rejects when no database is open', async () => {
  const sv = fakeSqliteviz();
  await assert.rejects(sv.runTool('sqliteviz.run_query', { sql: 'SELECT 1' }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'app_error');
    assert.match(error.message, /no database is open/);
    return true;
  });
});

test('sqliteviz.list_tables returns the trimmed schema names of the seeded database', async () => {
  const sv = fakeSqliteviz();
  await sv.runTool('sqliteviz.open_db', { path: '/data/shop.db' });
  const got = await sv.runTool('sqliteviz.list_tables', {});
  assert.deepEqual(got, { tables: SCHEMA }, 'the leading space of the app render is trimmed');
});

test('sqliteviz.list_tables rejects when no database is open', async () => {
  const sv = fakeSqliteviz();
  await assert.rejects(sv.runTool('sqliteviz.list_tables', {}), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'app_error');
    assert.match(error.message, /no database is open/);
    return true;
  });
});

test('a tool rejects with not_available when ctx.host is absent', async () => {
  await assert.rejects(byName('sqliteviz.list_tables').run({}, { host: null }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    return true;
  });
});

test('a tool rejects with not_available when the app never replaces the loading wrapper', async () => {
  const bare = { document: { getElementById: () => ({ contentWindow: { document: {} } }) } };
  await assert.rejects(byName('sqliteviz.list_tables').run({}, { host: { appWindow: async () => bare }, sleep: async () => {}, timeoutMs: 300 }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    assert.match(error.message, /did not finish loading/);
    return true;
  });
});

test('a host rejection code is passed through as the ToolError type', async () => {
  const boom = () => { const error = new Error('window "sqliteviz" is not open'); error.code = 'not_open'; throw error; };
  await assert.rejects(byName('sqliteviz.open_db').run({ path: '/data/shop.db' }, { host: { appWindow: boom }, files: { readBytes: () => Promise.resolve({ name: 'shop.db' }) } }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_open');
    return true;
  });
});

const { skills, errors: skillErrors } = parseSkills(SKILLS_MD, 'sqliteviz');

test('skills.md parses with the runtime parser without errors and has 5 skills', () => {
  assert.deepEqual(skillErrors, []);
  assert.equal(skills.length, 5);
  for (const skill of skills) {
    assert.ok(skill.slug && skill.summary, `skill ${skill.slug} slug/summary`);
    assert.ok(skill.summary.length <= 160, `skill ${skill.slug} summary is ${skill.summary.length} chars`);
    assert.ok(skill.keywords.length >= 5, `skill ${skill.slug} keywords: ${skill.keywords.join(', ')}`);
    assert.ok(skill.tools.length >= 1, `skill ${skill.slug} tools`);
    assert.ok(skill.when && skill.steps.length >= 1 && skill.check, `skill ${skill.slug} body sections`);
  }
});

test('every skill opens by launching the sqliteviz app, then uses numbered sqliteviz steps', () => {
  for (const skill of skills) {
    assert.equal(skill.steps[0].line, '1. call_tool tool=desktop.open_app app=sqliteviz', `skill ${skill.slug}`);
    skill.steps.forEach((step, i) => {
      assert.equal(step.n, i + 1, `skill ${skill.slug} step numbering`);
      assert.ok(step.tool.startsWith('desktop.') || step.tool.startsWith('sqliteviz.'), `skill ${skill.slug} step ${step.n}: ${step.line}`);
    });
  }
});

test('skill steps and tools lines validate against the runtime checkArgs', () => {
  const errors = checkSkills(skills, byName, { checkArgs: (tool, args) => checkArgs(tool, args, { choices }) });
  assert.deepEqual(errors, []);
});
