// Unit tests for the Buddy M1 search module (src/apps/ai-agent/runtime/search.mjs): the
// MiniSearch wrapper with text, regex and auto modes; OR semantics, prefix and fuzzy;
// boosts; limit/more/filter; store projection; round trip; determinism; excerpts.
// Run: node --test tests/agent-search.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIELDS, BOOST, buildIndex, loadIndex, search, excerpt, namedApps, preferNamed } from '../src/apps/ai-agent/runtime/search.mjs';

// Fixture: 15 fake tool docs and 10 fake skill docs (the brief's examples are in there).
const tools = [
  { id: 'desktop.open_app', name: 'open_app', keywords: ['open', 'app', 'launch', 'start'], purpose: 'Open a desktop app by name', when: 'The user wants to open or launch an app', body: 'Launches the app given its name and focuses its window. Works for every installed app, including the GridCraft spreadsheet app.' },
  { id: 'desktop.close_app', name: 'close_app', keywords: ['close', 'quit'], purpose: 'Close a running app', body: 'Closes the window of the app named by id.' },
  { id: 'desktop.screenshot', name: 'screenshot', keywords: ['capture', 'image'], purpose: 'Capture the screen as an image', body: 'Takes a screenshot of the whole screen and returns a PNG.' },
  { id: 'files.read', name: 'read_file', keywords: ['read', 'file', 'text'], purpose: 'Read a file from the Files app', body: 'Returns the text contents of a file by path.' },
  { id: 'files.write', name: 'write_file', keywords: ['write', 'save', 'file'], purpose: 'Write a file to the Files app', body: 'Creates or overwrites a file at the given path.' },
  { id: 'files.delete', name: 'delete_file', keywords: ['delete', 'remove', 'file'], purpose: 'Delete a file', body: 'Removes the file at the given path. The user is asked to confirm first.' },
  { id: 'files.list', name: 'list_files', keywords: ['list', 'folder', 'directory'], purpose: 'List a folder', body: 'Lists the files and folders inside a directory.' },
  { id: 'gridcraft.set_cells', name: 'set_cells', keywords: ['cells', 'values', 'spreadsheet', 'grid'], purpose: 'Set values in spreadsheet cells', when: 'The user wants to fill cells with numbers or text', body: 'Writes values into the selected range of the active GridCraft sheet.' },
  { id: 'gridcraft.insert_chart', name: 'insert_chart', keywords: ['chart', 'graph', 'plot', 'spreadsheet'], purpose: 'Insert a chart into a sheet', when: 'The user wants a chart or graph from their data', body: 'Creates a bar, line or pie chart from a range and inserts it into the active sheet.' },
  { id: 'gridcraft.formula', name: 'evaluate_formula', keywords: ['formula', 'calculate', 'sum'], purpose: 'Evaluate a spreadsheet formula', body: 'Evaluates a formula such as =SUM(A1:A10) and returns the result.' },
  { id: 'notes.create', name: 'create_note', keywords: ['note', 'memo', 'write'], purpose: 'Create a note', body: 'Creates a new note with the given title and text.' },
  { id: 'notes.search', name: 'search_notes', keywords: ['search', 'note', 'find'], purpose: 'Search notes by text', body: 'Finds notes whose title or text contains the query.' },
  { id: 'clock.time', name: 'current_time', keywords: ['time', 'date', 'clock'], purpose: 'Return the current date and time', body: 'Returns the device date and time in ISO format.' },
  { id: 'clock.reminder', name: 'set_reminder', keywords: ['reminder', 'alarm', 'later'], purpose: 'Set a reminder', body: 'Shows a reminder banner at the given time.' },
  { id: 'web.open', name: 'open_url', keywords: ['url', 'browser', 'link'], purpose: 'Open a URL in the browser app', body: 'Opens the given URL in the default browser.' }
];
const skills = [
  { id: 'gridcraft/chart-from-range', title: 'Make a chart from a range', keywords: ['chart', 'spreadsheet', 'range'], summary: 'Turn a range of cells into a chart in one step', body: 'Select the range, open the insert chart tool, pick the chart kind and place it. Works with the GridCraft spreadsheet app.' },
  { id: 'desktop/open-app', title: 'Open a file in an app', keywords: ['open', 'file', 'app'], summary: 'Pick the right app and open a file with it', body: 'Match the file type to an app, open the app with open_app, then pass the file path. Useful for spreadsheets and documents.' },
  { id: 'files/organize', title: 'Organise a folder', keywords: ['organize', 'folder', 'files'], summary: 'Sort files into folders by kind', body: 'List the folder, group files by extension and move the groups into subfolders.' },
  { id: 'gridcraft/format-table', title: 'Format a table', keywords: ['table', 'format', 'spreadsheet'], summary: 'Borders, bold headers and number formats for a range', body: 'Apply header styling and number formats to a range so it reads like a table.' },
  { id: 'notes/daily-log', title: 'Keep a daily log', keywords: ['log', 'note', 'day'], summary: 'Append an entry to today note', body: 'Find today note, append a timestamped entry and save it.' },
  { id: 'web/clip-article', title: 'Clip an article', keywords: ['clip', 'article', 'save'], summary: 'Save a page for later reading', body: 'Open the URL, extract the main text and save it as a note.' },
  { id: 'clock/daily-routine', title: 'Set up a daily routine', keywords: ['routine', 'reminder', 'schedule'], summary: 'A reminder at the same time every day', body: 'Use set_reminder for the first day and explain how to repeat it.' },
  { id: 'desktop/screen-shot', title: 'Capture part of the screen', keywords: ['screenshot', 'capture'], summary: 'Screenshot the screen and crop it', body: 'Take a full screenshot, then describe how to crop the region you need.' },
  { id: 'files/clean-up', title: 'Clean up a folder', keywords: ['clean', 'delete', 'duplicate'], summary: 'Find duplicates and delete them safely', body: 'List the folder, compare file names and sizes, then delete duplicates after confirmation.' },
  { id: 'gridcraft/summarise-data', title: 'Summarise a data set', keywords: ['summarise', 'formula', 'statistics'], summary: 'Totals, averages and a quick read of a data set', body: 'Use evaluate_formula for totals and averages and write a short summary note.' }
];
const docs = [...tools, ...skills];
const STORE = ['name', 'title', 'purpose', 'summary'];
const handle = loadIndex(buildIndex(docs, { store: STORE }), { store: STORE });

test('FIELDS and BOOST match the brief contract', () => {
  assert.deepEqual(FIELDS, ['name', 'title', 'keywords', 'purpose', 'when', 'summary', 'body']);
  assert.deepEqual(BOOST, { name: 3, title: 3, keywords: 2, purpose: 1.5, when: 1.5, summary: 1.5, body: 1 });
});

test('OR beats AND: a wordy query still finds the open app tool and a GridCraft doc in the top 3', () => {
  const result = search(handle, 'please open the spreadsheet app for me', { docs });
  assert.equal(result.mode_used, 'text');
  assert.equal(result.hits[0].id, 'desktop.open_app');
  const isGridcraft = id => id.startsWith('gridcraft.') || id.startsWith('gridcraft/');
  assert.ok(result.hits.slice(0, 3).some(hit => isGridcraft(hit.id)), 'a GridCraft doc lands in the top 3');
});

test('prefix: "char" finds the chart tools, name-boosted insert_chart first', () => {
  const result = search(handle, 'char', { docs });
  assert.equal(result.hits[0].id, 'gridcraft.insert_chart');
  assert.equal(result.hits[1].id, 'gridcraft/chart-from-range');
});

test('fuzzy: the typo "spredsheet" finds the gridcraft docs in auto mode as fuzzy', () => {
  const result = search(handle, 'spredsheet', { mode: 'auto', docs });
  assert.equal(result.mode_used, 'fuzzy');
  assert.equal(result.hits[0].id, 'gridcraft.set_cells');
  const isGridcraft = id => id.startsWith('gridcraft.') || id.startsWith('gridcraft/');
  for (const hit of result.hits.slice(0, 5)) assert.ok(isGridcraft(hit.id), hit.id + ' is a gridcraft doc');
});

test('fuzzy: the same typo works in explicit text mode and is labelled text', () => {
  const result = search(handle, 'spredsheet', { mode: 'text' });
  assert.equal(result.mode_used, 'text');
  assert.equal(result.hits[0].id, 'gridcraft.set_cells');
});

test('boosts: a name match outranks a body-only match', () => {
  const mini = loadIndex(buildIndex([
    { id: 'probe.name', name: 'quixotic_probe', body: 'A body that only mentions quixotic deep in the text, buried under many other words about unrelated subjects such as tea, trains and tides.' },
    { id: 'probe.body', name: 'plain_name', body: 'quixotic is the only place this word appears.' }
  ]), {});
  const result = search(mini, 'quixotic');
  assert.equal(result.hits[0].id, 'probe.name');
  assert.ok(result.hits[0].score > result.hits[1].score, 'the name-boosted hit scores higher');
});

test('regex: a working pattern matches over the fields, ties break by id', () => {
  const result = search(handle, 'set_cells|insert_chart', { mode: 'regex', docs });
  assert.equal(result.mode_used, 'regex');
  assert.deepEqual(result.hits.map(hit => hit.id), ['gridcraft.insert_chart', 'gridcraft.set_cells']);
  assert.ok(result.hits.every(hit => hit.score === 1));
});

test('regex: case-insensitive, and the score counts every match', () => {
  const result = search(handle, 'GRIDCRAFT', { mode: 'regex', docs });
  assert.deepEqual(result.hits.map(hit => hit.id), ['desktop.open_app', 'gridcraft.set_cells', 'gridcraft/chart-from-range']);
  assert.ok(result.hits.every(hit => hit.score === 1));
  const matchDocs = [
    { id: 'aa.two', body: 'aa aa' },
    { id: 'aa.one', body: 'aa' }
  ];
  const mini = loadIndex(buildIndex(matchDocs), {});
  const out = search(mini, 'aa', { mode: 'regex', docs: matchDocs });
  assert.deepEqual(out.hits.map(hit => [hit.id, hit.score]), [['aa.two', 2], ['aa.one', 1]]);
});

test('regex: an invalid pattern never throws and returns the error text', () => {
  const result = search(handle, '([unclosed', { mode: 'regex', docs });
  assert.deepEqual(result.hits, []);
  assert.equal(result.mode_used, 'regex');
  assert.ok(result.error.startsWith('invalid regex:'), 'error text: ' + result.error);
});

test('regex: over 200 characters is too long, exactly 200 is still accepted', () => {
  const tooLong = search(handle, 'a'.repeat(201), { mode: 'regex', docs });
  assert.equal(tooLong.error, 'regex too long');
  assert.deepEqual(tooLong.hits, []);
  const atLimit = search(handle, 'a'.repeat(200), { mode: 'regex', docs });
  assert.equal(atLimit.error, undefined);
});

test('regex: the docs option is required', () => {
  const result = search(handle, 'open', { mode: 'regex' });
  assert.equal(result.error, 'docs option is required for regex mode');
  assert.deepEqual(result.hits, []);
});

test('auto: tries text, then fuzzy, then an escaped regex of the longest word', () => {
  assert.equal(search(handle, 'chart', { mode: 'auto', docs }).mode_used, 'text');
  assert.equal(search(handle, 'spredsheet', { mode: 'auto', docs }).mode_used, 'fuzzy');
  const miniDocs = [
    { id: 'x.alpha', name: 'alpha', body: 'The alpha line stores its entries in superchartbook.' },
    { id: 'x.beta', name: 'beta', body: 'Nothing to see here at all.' }
  ];
  const mini = loadIndex(buildIndex(miniDocs), {});
  const fallback = search(mini, 'chartbook', { mode: 'auto', docs: miniDocs });
  assert.equal(fallback.mode_used, 'regex');
  assert.deepEqual(fallback.hits.map(hit => hit.id), ['x.alpha']);
});

test('auto: without a docs array the regex step is skipped, not an error', () => {
  const miniDocs = [{ id: 'x.alpha', name: 'alpha', body: 'The alpha line stores its entries in superchartbook.' }];
  const mini = loadIndex(buildIndex(miniDocs), {});
  const result = search(mini, 'chartbook', { mode: 'auto' });
  assert.deepEqual(result, { hits: [], more: false, mode_used: null });
  const allStop = search(handle, 'please the', { mode: 'auto', docs });
  assert.deepEqual(allStop, { hits: [], more: false, mode_used: null });
});

test('limit and more: the limit caps the hits, more reports the overflow', () => {
  const capped = search(handle, 'file', { limit: 2, docs });
  assert.equal(capped.hits.length, 2);
  assert.equal(capped.more, true);
  const full = search(handle, 'file', { limit: 99, docs });
  assert.equal(full.hits.length, 7);
  assert.equal(full.more, false);
  assert.deepEqual(full.hits.slice(0, 2).map(hit => hit.id), ['files.read', 'files.write']);
});

test('filter: applied before the limit, and receives id plus the stored fields', () => {
  const result = search(handle, 'open', { filter: hit => hit.id.startsWith('desktop.'), docs });
  assert.deepEqual(result.hits.map(hit => hit.id), ['desktop.open_app']);
  assert.equal(result.more, false);
  assert.equal(typeof result.hits[0].name, 'string', 'stored fields reach the filter');
});

test('store: hits carry only id, score and the stored fields, or none without a store', () => {
  const hit = search(handle, 'char', { docs }).hits[0];
  assert.deepEqual(Object.keys(hit).sort(), ['id', 'name', 'purpose', 'score']);
  const bare = loadIndex(buildIndex(docs), {});
  assert.deepEqual(Object.keys(search(bare, 'char', { docs }).hits[0]), ['id', 'score']);
});

test('round trip: buildIndex to loadIndex gives the same results as a fresh build', () => {
  const first = loadIndex(buildIndex(docs), { store: STORE });
  const second = loadIndex(buildIndex(docs), { store: STORE });
  const a = search(first, 'open the app', { docs });
  const b = search(second, 'open the app', { docs });
  assert.deepEqual(a.hits, b.hits);
  assert.equal(a.mode_used, b.mode_used);
  assert.equal(a.more, b.more);
});

test('determinism: identical inputs give identical order, including score ties', () => {
  const one = search(handle, 'file', { docs });
  const two = search(handle, 'file', { docs });
  assert.deepEqual(JSON.stringify(one.hits), JSON.stringify(two.hits));
  // the tie at the top (files.read / files.write share a score) is broken by id
  assert.equal(one.hits[0].id, 'files.read');
  assert.equal(one.hits[1].id, 'files.write');
});

test('buildIndex throws on duplicate ids, loadIndex rejects garbage envelopes', () => {
  assert.throws(() => buildIndex([{ id: 'a', name: 'a' }, { id: 'a', name: 'b' }]), /duplicate ID/);
  assert.throws(() => loadIndex('garbage'));
  assert.throws(() => loadIndex(JSON.stringify({ v: 2, index: {}, docs: [] })));
});

test('excerpt: centres on the first term match within max characters', () => {
  const text = 'x'.repeat(100) + 'needle' + 'y'.repeat(100);
  const out = excerpt(text, 'needle', 100);
  assert.equal(out.length, 100);
  assert.ok(out.includes('needle'));
  assert.ok(out.startsWith('x'.repeat(50)), 'the window starts 50 characters before the match');
});

test('excerpt: the cap, the no-match fallback and stop-word-only queries', () => {
  assert.equal(excerpt('abcdef', 'a', 3), 'abc');
  assert.equal(excerpt('hello world', 'zebra', 8), 'hello wo');
  assert.equal(excerpt('hello world today', 'please the', 8), 'hello wo');
  assert.equal(excerpt('short', 'q', 200), 'short');
  // the earliest match wins, even when a later term appears in the query first
  assert.equal(excerpt('b at ten, a at five', 'a b', 10), 'b at ten, ');
});

// Eval M6: "Open LightCraft" pulled terminal/open-the-terminal through the word "open", and the
// model opened the Terminal. A request that names an app ranks that app's skills first.
const APPS = [{ id: 'gridcraft', title: 'GridCraft' }, { id: 'lightcraft', title: 'LightCraft' }, { id: 'media', title: 'Media Player' }, { id: 'docs', title: 'Docs' }];

test('namedApps finds apps named by id or title as whole words', () => {
  assert.deepEqual(namedApps('Open LightCraft', APPS), ['lightcraft']);
  assert.deepEqual(namedApps('Open GridCraft and Docs, side by side', APPS), ['gridcraft', 'docs']);
  assert.deepEqual(namedApps('play it in the media player', APPS), ['media']);
  assert.deepEqual(namedApps('Type Total in cell A1', APPS), []);
  assert.deepEqual(namedApps('my documents folder', APPS), [], 'docs must be a whole word');
});

test('preferNamed moves other apps after the named apps and the general packs, keeping order', () => {
  const ids = ['terminal/open-the-terminal', 'desktop/open-an-app', 'lightcraft/run-a-command', 'files/save-a-note', 'gridcraft/type-values'];
  assert.deepEqual(preferNamed(ids, ['lightcraft']), ['desktop/open-an-app', 'lightcraft/run-a-command', 'files/save-a-note', 'terminal/open-the-terminal', 'gridcraft/type-values']);
  assert.deepEqual(preferNamed(ids, []), ids, 'no named app: unchanged');
});
