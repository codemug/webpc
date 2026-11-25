// Unit tests for the Buddy M1 meta tools (src/apps/ai-agent/runtime/meta-tools.mjs): the
// six tools over a real catalog (buildCatalog, 2 fake packs, 10 tools), 6 fake skills
// (parseSkills), real search indexes (buildIndex/loadIndex) and an injected recording run.
// Run: node --test tests/agent-meta-tools.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog } from '../src/apps/ai-agent/runtime/catalog.mjs';
import { parseSkills } from '../src/apps/ai-agent/runtime/skills.mjs';
import { buildIndex, loadIndex } from '../src/apps/ai-agent/runtime/search.mjs';
import { ToolError } from '../src/apps/ai-agent/runtime/args.mjs';
import { createMetaTools, META_TOOL_NAMES, bareApp } from '../src/apps/ai-agent/runtime/meta-tools.mjs';

const appChoices = (kind) => (kind === 'apps' ? ['gridcraft', 'docs', 'files'] : []);
const desktopPack = {
  pack: { id: 'desktop', title: 'Desktop' },
  tools: [
    { name: 'desktop.open_app', purpose: 'Open an app window.', when: 'Use when the user wants an app open.', params: { app: { type: 'enum', values: 'apps', required: true, description: 'App id to open' }, wait: { type: 'boolean', required: false, description: 'Wait until the window is ready' } }, effect: 'change', needs: ['app'], examples: [{ args: { app: 'gridcraft' }, says: 'Open GridCraft' }] },
    { name: 'desktop.close_app', purpose: 'Close the window of an open app.', when: 'Use when the user wants to quit an app.', params: { app: { type: 'enum', values: 'apps', required: true, description: 'App id to close' } }, effect: 'change', examples: [{ args: { app: 'gridcraft' }, says: 'Close GridCraft' }] },
    { name: 'desktop.screenshot', purpose: 'Capture the screen as an image.', when: 'Use when the user wants a picture of the screen.', params: {}, effect: 'read', examples: [] },
    { name: 'desktop.set_theme', purpose: 'Set the desktop theme.', when: 'Use when the user wants a different look.', params: { theme: { type: 'enum', values: ['light', 'dark'], required: true, description: 'The theme' }, save: { type: 'boolean', required: false, description: 'Remember the choice' } }, effect: 'change', examples: [{ args: { theme: 'dark' }, says: 'Switch to dark' }] },
    { name: 'desktop.focus_window', purpose: 'Bring a window to the front.', when: 'Use when the user wants a window in front.', params: { window: { type: 'string', required: false, description: 'The window to focus' } }, effect: 'read', examples: [{ args: { window: 'main' }, says: 'Focus the main window' }] }
  ]
};
const gridcraftPack = {
  pack: { id: 'gridcraft', title: 'GridCraft' },
  tools: [
    { name: 'gridcraft.set_cells', purpose: 'Write values or formulas into a block of cells.', when: 'Use when the user asks to fill cells.', params: { start: { type: 'string', required: true, description: 'Top-left cell, e.g. A1' }, values: { type: 'table', required: true, description: 'Rows and cells as text' } }, effect: 'change', needs: ['app:gridcraft'], examples: [{ args: { start: 'A1', values: 'Total\n42' }, says: 'Fill A1:A2' }] },
    { name: 'gridcraft.select', purpose: 'Select a range of cells.', when: 'Use before reading or changing a range.', params: { range: { type: 'string', required: true, description: 'The range to select' } }, effect: 'read', examples: [{ args: { range: 'A1:B6' }, says: 'Select the data range' }] },
    { name: 'gridcraft.insert_chart', purpose: 'Insert a chart into the sheet.', when: 'Use when the user wants a chart.', params: { kind: { type: 'enum', values: ['bar', 'line', 'pie'], required: true, description: 'The chart kind' } }, effect: 'change', examples: [{ args: { kind: 'bar' }, says: 'Insert a bar chart' }] },
    { name: 'gridcraft.inspect', purpose: 'Read the active sheet back.', when: 'Use after a change to verify it.', params: { range: { type: 'string', required: false, description: 'A range to read' } }, effect: 'read', examples: [{ args: { range: 'A1:B6' }, says: 'Read the range back' }] },
    { name: 'gridcraft.export', purpose: 'Save the sheet as a file.', when: 'Use when the user wants the sheet shared.', params: { format: { type: 'enum', values: ['csv', 'xlsx'], required: true, description: 'The file format' }, path: { type: 'path', required: false, description: 'Where to save it' } }, effect: 'external', examples: [{ args: { format: 'csv', path: '/tmp/sheet.csv' }, says: 'Export as CSV' }] }
  ]
};
const SKILL_MDS = [
  ['gridcraft', [
    '## Make a chart from a range', 'slug: chart-from-range', 'summary: Select data in GridCraft and insert a chart of it.',
    'keywords: chart, graph, plot, bar, line', 'tools: desktop.open_app, gridcraft.select, gridcraft.insert_chart', '',
    'When: the user wants a chart of numbers that are in the open sheet.', 'Steps:',
    '1. call_tool tool=desktop.open_app app=gridcraft', '2. call_tool tool=gridcraft.select range=A1:B6',
    '3. call_tool tool=gridcraft.insert_chart kind=bar', 'Check: gridcraft.inspect shows a chart on the sheet.',
    'Gotchas: a chart needs a header row; without one, add it with gridcraft.set_cells first.', '',
    '## Fill totals into a sheet', 'slug: fill-totals', 'summary: Put a total row under a column of numbers.',
    'keywords: total, sum, totals, add up', 'tools: gridcraft.set_cells, gridcraft.inspect', '',
    'When: the user asks for a total or sum of a column.', 'Steps:',
    '1. call_tool tool=gridcraft.inspect range=A1:A10', '2. call_tool tool=gridcraft.set_cells start=A11 values=Total\\n42',
    'Check: the total row shows the added-up number.', '',
    '## Export a sheet', 'slug: export-sheet', 'summary: Save the active sheet as CSV or XLSX.',
    'keywords: export, csv, xlsx, save', 'tools: gridcraft.export', '',
    'When: the user wants the sheet as a file to share.', 'Steps:',
    '1. call_tool tool=gridcraft.export format=csv path=/tmp/sheet.csv', 'Check: the file exists in Files.'
  ]],
  ['desktop', [
    '## Open an app and a file', 'slug: open-app', 'summary: Pick the app and open a file with it.',
    'keywords: open, app, file, launch', 'tools: desktop.open_app', '',
    'When: the user names a file or app to open.', 'Steps:', '1. call_tool tool=desktop.open_app app=gridcraft',
    'Check: the app window is focused.', '',
    '## Close an app window', 'slug: close-app', 'summary: Close the window of an open app.',
    'keywords: close, quit, window', 'tools: desktop.close_app', '',
    'When: the user wants to close or quit an app.', 'Steps:', '1. call_tool tool=desktop.close_app app=gridcraft',
    'Check: the window is gone and the taskbar no longer shows it.'
  ]],
  ['files', [
    '## Organise a folder', 'slug: organise-folder', 'summary: Sort a folder files into subfolders by kind.',
    'keywords: organise, sort, folder, tidy', 'tools: files.list, files.move', '',
    'When: the user wants a messy folder tidied up.', 'Steps:',
    '1. call_tool tool=files.list folder=/notes', '2. call_tool tool=files.move from=/notes/a.png to=/notes/images/a.png',
    'Check: the folder has one subfolder per file kind.'
  ]]
];

const catalog = buildCatalog([desktopPack, gridcraftPack], { choices: appChoices });
const skills = SKILL_MDS.flatMap(([pack, lines]) => parseSkills(lines.join('\n'), pack).skills);
const skillDocs = skills.map(s => ({ id: s.path, title: s.title, keywords: s.keywords, summary: s.summary, body: s.body }));
const skillIndex = loadIndex(buildIndex(skillDocs, { store: ['title', 'summary'] }), { store: ['title', 'summary'] });
const toolIndex = loadIndex(buildIndex(catalog.docs, { store: ['purpose'] }), { store: ['purpose'] });

const calls = [];
const recordingRun = async (tool, args, ctx) => { calls.push({ tool, args, ctx }); return { ran: tool, args }; };
const defaultRepair = (raw) => {
  const args = {};
  for (const [key, value] of Object.entries(raw ?? {})) if (key !== 'tool') args[key] = value;
  return { tool: raw?.tool, args, repairs: [] };
};
function makeDeps(over = {}) {
  return {
    catalog, skills, toolIndex, skillIndex,
    toolDocs: catalog.docs, skillDocs,
    run: recordingRun, repairCall: defaultRepair, choices: appChoices, aliases: {},
    skillPathsFor: (name) => (name === 'gridcraft.insert_chart' ? ['gridcraft/chart-from-range'] : []),
    ...over
  };
}
const tools = createMetaTools(makeDeps());

test('the six meta tools exist under META_TOOL_NAMES with description, schema and run', () => {
  assert.deepEqual(META_TOOL_NAMES, ['lookup_skill_index', 'read_skill', 'find_in_skill', 'find_tool', 'describe_tool', 'call_tool']);
  for (const name of META_TOOL_NAMES) {
    const tool = tools[name];
    assert.ok(tool, name + ' exists');
    assert.equal(typeof tool.description, 'string');
    assert.equal(tool.parameters.type, 'object');
    assert.equal(typeof tool.run, 'function');
  }
});

test('hygiene: descriptions are at most 160 characters and the schemas are flat strings', () => {
  for (const name of META_TOOL_NAMES) {
    const tool = tools[name];
    assert.ok(tool.description.length > 0 && tool.description.length <= 160, `${name} description is ${tool.description.length} chars`);
    for (const property of Object.values(tool.parameters.properties)) {
      assert.equal(property.type, 'string', `${name} property is a flat string`);
      assert.equal(typeof property.description, 'string');
    }
  }
  assert.equal(tools.call_tool.parameters.additionalProperties, true, 'call_tool accepts the target params as extra keys');
  assert.deepEqual(tools.call_tool.parameters.required, ['tool']);
});

test('lookup_skill_index: hits carry path, title and summary', async () => {
  const result = await tools.lookup_skill_index.run({ query: 'chart' });
  assert.ok(result.hits.length > 0, JSON.stringify(result));
  assert.ok(result.hits.some(hit => hit.path === 'gridcraft/chart-from-range'), JSON.stringify(result.hits));
  for (const hit of result.hits) assert.deepEqual(Object.keys(hit).sort(), ['path', 'summary', 'title']);
});

test('lookup_skill_index: more is true when matches run past five', async () => {
  const result = await tools.lookup_skill_index.run({ query: 'call' });
  assert.equal(result.hits.length, 5);
  assert.equal(result.more, true, 'every skill body mentions call_tool, so more than five match');
});

test('lookup_skill_index: nothing found gives the note', async () => {
  assert.deepEqual(await tools.lookup_skill_index.run({ query: 'zebraquantum' }), { hits: [], note: 'No skill matches. Try find_tool.' });
});

test('bareApp: only the app id or title plus filler words is bare (A15)', () => {
  const apps = [{ id: 'gridcraft', title: 'GridCraft' }];
  for (const q of ['gridcraft', 'GridCraft', 'gridcraft skills', 'gridcraft help', 'gridcraft tool']) assert.equal(bareApp(q, apps)?.id, 'gridcraft', q);
  for (const q of ['budget', 'gridcraft budget', 'gridcrafts', '', 'skills']) assert.equal(bareApp(q, apps), null, q);
});

// A16: call_tool snaps a near-miss text argument to the user's own span and says so.
const notePadTool = {
  name: 'notepad.write', purpose: 'Write text into the note.', when: 'Use to save text.',
  params: { input: { type: 'text', required: true, description: 'The text to write' }, code: { type: 'string', description: 'A command' } },
  effect: 'change', examples: []
};

test('call_tool snaps a near-miss input to the user span and notes it (A16)', async () => {
  const ran = [];
  const t = createMetaTools(makeDeps({
    catalog: { tools: new Map([['notepad.write', notePadTool]]), docs: [] },
    run: async (tool, args) => { ran.push({ tool, args }); return { wrote: args.input }; }
  }));
  const user = 'The log line is Guvf jnf; decode it.';
  const out = await t.call_tool.run({ tool: 'notepad.write', input: 'Gvf jnf', code: 'echo hi' }, { userText: user });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.note, "used your exact text 'Guvf jnf'");
  assert.deepEqual(ran[0].args, { input: 'Guvf jnf', code: 'echo hi' }, 'the snapped span ran; the code arg is untouched');
  const verbatim = await t.call_tool.run({ tool: 'notepad.write', input: 'Guvf jnf' }, { userText: user });
  assert.ok(!verbatim.note, 'verbatim needs no note');
  const noCtx = await t.call_tool.run({ tool: 'notepad.write', input: 'Gvf jnf' }, {});
  assert.equal(noCtx.ok, true);
  assert.ok(!noCtx.note, 'without the user message nothing snaps');
});

test('skill read paths show step values as placeholders only (M6: small models copy verbatim)', async () => {
  // The fill-totals steps carry literal values (start=A11, range=A1:A10) in the pack text; every
  // path that shows a skill line to the model must template them (off arm 2026-11-25: cyberchef-01
  // saw templated steps through read_skill - the runtime guarantee this pins).
  const read = await tools.read_skill.run({ path: 'gridcraft/fill-totals' });
  assert.ok(!/A11|A1:A10/.test(read.text), read.text);
  assert.ok(read.text.includes('start=<start>'), read.text);
  assert.ok(read.text.includes('range=<range>'), read.text);
  const found = await tools.find_in_skill.run({ path: 'gridcraft/fill-totals', query: 'A11' });
  assert.ok(found.hits.length > 0, JSON.stringify(found));
  assert.ok(!found.hits.some(hit => /A11/.test(hit.line)), JSON.stringify(found.hits));
});

test('a bare app-name query lists the app skills and tools instead of searching (A15)', async () => {
  // lfm3-1.7b searched "gridcraft" and the search never surfaced the budget skill: the app id
  // matches no skill field, so the listing is the task-shaped picks.
  const budget = parseSkills(['## Build a budget with formula columns', 'slug: build-a-budget-with-formula-columns', 'summary: Build a budget sheet whose totals are formula columns.', 'keywords: budget, formula, columns, plan', 'tools: gridcraft.set_cells, gridcraft.inspect', '', 'When: the user wants a budget sheet with live totals.', 'Steps:', '1. call_tool tool=gridcraft.set_cells start=A1 values=Income\\n100', 'Check: the total column is a formula, not a number.'].join('\n'), 'gridcraft').skills[0];
  const all = [...skills, budget];
  const docs = all.map(s => ({ id: s.path, title: s.title, keywords: s.keywords, summary: s.summary, body: s.body }));
  const t = createMetaTools(makeDeps({
    skills: all, skillDocs: docs,
    skillIndex: loadIndex(buildIndex(docs, { store: ['title', 'summary'] }), { store: ['title', 'summary'] }),
    apps: [{ id: 'gridcraft', title: 'GridCraft' }, { id: 'files', title: 'Files' }]
  }));
  const list = await t.lookup_skill_index.run({ query: 'gridcraft' });
  assert.deepEqual(list.hits.map(h => h.path), ['gridcraft/chart-from-range', 'gridcraft/fill-totals', 'gridcraft/export-sheet', 'gridcraft/build-a-budget-with-formula-columns']);
  for (const hit of list.hits) assert.deepEqual(Object.keys(hit).sort(), ['path', 'title'], 'compact rows, no summary');
  assert.match(list.note, /read_skill/);
  const normal = await t.lookup_skill_index.run({ query: 'budget' });
  assert.equal(normal.hits[0].path, 'gridcraft/build-a-budget-with-formula-columns', 'a task query still ranks by search');
  const toolList = await t.find_tool.run({ query: 'gridcraft' });
  assert.deepEqual(toolList.hits.map(h => h.tool), ['gridcraft.set_cells', 'gridcraft.select', 'gridcraft.insert_chart', 'gridcraft.inspect', 'gridcraft.export']);
  assert.ok(toolList.hits.every(h => h.does), 'each tool carries its purpose');
});

test('read_skill: the full render carries every section', async () => {
  const result = await tools.read_skill.run({ path: 'gridcraft/chart-from-range' });
  assert.equal(result.path, 'gridcraft/chart-from-range');
  for (const needle of ['Make a chart from a range', 'When:', 'Steps:', 'Check:', 'Gotchas:', 'a chart needs a header row']) {
    assert.ok(result.text.includes(needle), 'missing: ' + needle);
  }
});

test('read_skill: a section renders only that section', async () => {
  const result = await tools.read_skill.run({ path: 'gridcraft/chart-from-range', section: 'steps' });
  assert.ok(result.text.startsWith('Steps:'), result.text.slice(0, 20));
  assert.ok(result.text.includes('1. call_tool tool=desktop.open_app app=<app>'), result.text);
  assert.ok(result.text.includes('2. call_tool tool=gridcraft.select range=<range>'), 'step values are templated');
  assert.ok(!result.text.includes('Gotchas:'), 'no other section leaks in');
});

test('read_skill: the path is normalised (case, leading slash, .md, pack:slug)', async () => {
  const canonical = await tools.read_skill.run({ path: 'gridcraft/chart-from-range' });
  for (const variant of ['GridCraft/CHART-FROM-RANGE', '/gridcraft/chart-from-range.md', 'gridcraft:chart-from-range']) {
    assert.deepEqual(await tools.read_skill.run({ path: variant }), canonical);
  }
});

test('read_skill: an unknown path errors with the three closest and a fix', async () => {
  const result = await tools.read_skill.run({ path: 'gridcraft/chart-from-ramge' });
  assert.equal(result.ok, false);
  assert.equal(result.error.type, 'unknown_skill');
  assert.ok(result.error.message.includes('closest:'), result.error.message);
  assert.ok(result.error.message.includes('gridcraft/chart-from-range'), result.error.message);
  assert.equal(result.error.fix, 'read_skill path=gridcraft/chart-from-range');
});

test('find_in_skill: a matching line comes with its section and a capped excerpt', async () => {
  const result = await tools.find_in_skill.run({ path: 'gridcraft/chart-from-range', query: 'header row' });
  assert.equal(result.hits.length, 1, JSON.stringify(result));
  assert.equal(result.hits[0].section, 'Gotchas');
  assert.ok(result.hits[0].line.includes('header row'));
  assert.ok(result.hits[0].excerpt.length <= 200);
});

test('find_in_skill: a step line is attributed to the Steps section', async () => {
  const result = await tools.find_in_skill.run({ path: 'gridcraft/chart-from-range', query: 'insert_chart' });
  const hit = result.hits.find(h => h.line.includes('insert_chart kind=<kind>'));
  assert.ok(hit, JSON.stringify(result.hits));
  assert.equal(hit.section, 'Steps');
});

test('find_in_skill: regex mode, an invalid regex and an over-long one never throw', async () => {
  const found = await tools.find_in_skill.run({ path: 'gridcraft/chart-from-range', query: 'kind=(bar|pie)', mode: 'regex' });
  assert.ok(found.hits.some(hit => hit.line.includes('kind=<kind>')), 'the regex matches the raw step; the returned line is templated');
  const invalid = await tools.find_in_skill.run({ path: 'gridcraft/chart-from-range', query: '([unclosed', mode: 'regex' });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.type, 'invalid_regex');
  assert.ok(invalid.error.message.startsWith('invalid regex:'), invalid.error.message);
  const tooLong = await tools.find_in_skill.run({ path: 'gridcraft/chart-from-range', query: 'a'.repeat(201), mode: 'regex' });
  assert.equal(tooLong.error.message, 'regex too long');
});

test('find_in_skill: an unknown path errors like read_skill', async () => {
  const result = await tools.find_in_skill.run({ path: 'gridcraft/nope', query: 'chart' });
  assert.equal(result.ok, false);
  assert.equal(result.error.type, 'unknown_skill');
});

// B17 (cyberchef-09): the model searched tool names (files.read, desktop.open_app) inside the
// skill index ten times and found nothing. A dotted query redirects to the tool index instead.
test('find_in_skill: a dotted tool-name query redirects to the tool index, with the purpose when the tool is known', async () => {
  const known = await tools.find_in_skill.run({ path: 'gridcraft', query: 'desktop.open_app' });
  assert.deepEqual(known.hits, []);
  assert.match(known.note, /"desktop.open_app" is a tool, not skill text: Open an app window\./);
  assert.match(known.note, /describe_tool tool=desktop\.open_app/);
  assert.match(known.note, /call_tool tool=desktop\.open_app to run it/);
  const unknown = await tools.find_in_skill.run({ path: 'gridcraft', query: 'files.read' });
  assert.deepEqual(unknown.hits, []);
  assert.match(unknown.note, /"files.read" looks like a tool name, not skill text - find_tool query=files\.read/);
  // A non-dotted query is unaffected: skill text matching still runs.
  const plain = await tools.find_in_skill.run({ path: 'gridcraft/chart-from-range', query: 'header row' });
  assert.ok(plain.hits.length > 0, 'plain queries still search the skill');
});

// lfm3-1.7b loops on the bare app name as the skill path (J2 effectcraft 0/12, figcraft 3/6):
// the app is not a skill, but its skills are what the model wants.
test('find_in_skill: a bare app name ranks that app skills by the query instead of erroring', async () => {
  const result = await tools.find_in_skill.run({ path: 'gridcraft', query: 'chart' });
  assert.ok(Array.isArray(result.hits) && result.hits.length > 0, JSON.stringify(result));
  assert.ok(result.hits.every(hit => hit.path.startsWith('gridcraft/')));
  assert.equal(result.hits[0].path, 'gridcraft/chart-from-range');
  assert.match(result.note, /app, not a skill/);
});

test('find_in_skill: a bare app name with a query matching nothing still lists the app skills', async () => {
  const result = await tools.find_in_skill.run({ path: 'desktop', query: 'zzz' });
  assert.deepEqual(result.hits.map(hit => hit.path), ['desktop/close-app', 'desktop/open-app']);
});

test('read_skill: a bare app name lists the app skills in the error', async () => {
  const result = await tools.read_skill.run({ path: 'gridcraft' });
  assert.equal(result.ok, false);
  assert.equal(result.error.type, 'unknown_skill');
  assert.match(result.error.message, /chart-from-range/);
  assert.match(result.error.fix, /^read_skill path=gridcraft\//);
});

test('find_in_skill: at most five lines are returned', async () => {
  const result = await tools.find_in_skill.run({ path: 'gridcraft/chart-from-range', query: 'chart' });
  assert.equal(result.hits.length, 5, 'six lines mention chart, the cap is five');
});

test('find_tool: a hit is the name, the purpose and a call template with no example values', async () => {
  const result = await tools.find_tool.run({ query: 'cells' });
  const hit = result.hits.find(h => h.tool === 'gridcraft.set_cells');
  assert.ok(hit, JSON.stringify(result));
  assert.deepEqual(Object.keys(hit).sort(), ['call', 'does', 'tool']);
  assert.equal(hit.does, 'Write values or formulas into a block of cells.');
  assert.equal(hit.call, 'call_tool tool=gridcraft.set_cells start=<start> values=<values>');
  assert.ok(!JSON.stringify(result).includes('Total'), 'no example value reaches the model');
  assert.ok(!JSON.stringify(hit).includes('('), 'no parenthesised signature next to the name');
});

test('find_tool: the app filter keeps the app tools plus desktop tools with an app parameter', async () => {
  const result = await tools.find_tool.run({ query: 'open', app: 'gridcraft' });
  assert.ok(result.hits.some(hit => hit.tool === 'desktop.open_app'), JSON.stringify(result.hits));
  for (const hit of result.hits) {
    assert.ok(hit.tool.startsWith('gridcraft.') || hit.tool.startsWith('desktop.'), hit.tool);
    if (hit.tool.startsWith('desktop.')) assert.ok('app' in catalog.tools.get(hit.tool).params, hit.tool);
  }
});

test('find_tool: the app filter drops a desktop tool without an app parameter', async () => {
  assert.deepEqual(await tools.find_tool.run({ query: 'screen', app: 'gridcraft' }), { hits: [], note: 'No tool matches. Try lookup_skill_index.' });
});

test('find_tool: nothing found gives the note', async () => {
  assert.deepEqual(await tools.find_tool.run({ query: 'zebraquantum' }), { hits: [], note: 'No tool matches. Try lookup_skill_index.' });
});

test('describe_tool: a known tool shows params, effect, a call template and no unrelated skills', async () => {
  const result = await tools.describe_tool.run({ tool: 'gridcraft.set_cells' });
  assert.equal(result.tool, 'gridcraft.set_cells');
  for (const needle of ['gridcraft.set_cells - Write values or formulas', 'start: string', 'Effect: change', 'Call: call_tool tool=gridcraft.set_cells start=<start> values=<values>']) {
    assert.ok(result.text.includes(needle), 'missing: ' + needle);
  }
  assert.ok(!result.text.includes('Total'), 'no example value in the describe text');
  assert.ok(!result.text.includes('Skills:'), 'set_cells has no related skills in this fixture');
});

test('describe_tool: related skill paths are listed', async () => {
  const result = await tools.describe_tool.run({ tool: 'gridcraft.insert_chart' });
  assert.ok(result.text.includes('kind: bar|line|pie'), result.text);
  assert.ok(result.text.includes('Skills: gridcraft/chart-from-range'), result.text);
});

test('describe_tool: an unknown tool errors with the closest names and a fix', async () => {
  const result = await tools.describe_tool.run({ tool: 'gridcraft.set_cell' });
  assert.equal(result.ok, false);
  assert.equal(result.error.type, 'unknown_tool');
  assert.ok(result.error.message.includes('gridcraft.set_cells'), result.error.message);
  assert.equal(result.error.fix, 'describe_tool tool=gridcraft.set_cells');
});

test('describe_tool: the name is repaired before the lookup', async () => {
  const repaired = createMetaTools(makeDeps({
    repairCall: (raw) => ({ tool: String(raw.tool ?? '').replace(/\(.*$/, '').trim(), args: {}, repairs: [] })
  }));
  const result = await repaired.describe_tool.run({ tool: 'gridcraft.set_cells(start, values)' });
  assert.equal(result.tool, 'gridcraft.set_cells', 'the signature text in the name is stripped');
  assert.equal(result.ok, undefined, 'a known repaired name resolves');
});

test('call_tool: flat args are checked and the executor is called with them', async () => {
  const result = await tools.call_tool.run({ tool: 'gridcraft.set_cells', start: 'A1', values: 'Total\n42' });
  assert.equal(result.ok, true);
  assert.equal(result.tool, 'gridcraft.set_cells');
  assert.deepEqual(result.result.args, { start: 'A1', values: [['Total'], ['42']] });
  assert.equal(calls.at(-1).tool, 'gridcraft.set_cells');
  assert.equal(calls.at(-1).ctx, undefined, 'the ctx reaches the executor');
});

test('call_tool: cloud arguments are merged by the injected repairCall and reported', async () => {
  const merged = createMetaTools(makeDeps({
    repairCall: (raw) => ({
      tool: raw.tool,
      args: typeof raw.arguments === 'string' ? JSON.parse(raw.arguments) : (raw.arguments ?? {}),
      repairs: raw.arguments !== undefined ? ['merged the arguments object'] : []
    })
  }));
  const result = await merged.call_tool.run({ tool: 'desktop.set_theme', arguments: JSON.stringify({ theme: 'dark' }) });
  assert.equal(result.ok, true);
  assert.deepEqual(result.repaired, ['merged the arguments object']);
  assert.deepEqual(calls.at(-1).args, { theme: 'dark' });
});

test('call_tool: a missing required argument fails with a fix', async () => {
  const result = await tools.call_tool.run({ tool: 'gridcraft.set_cells', start: 'A1' });
  assert.equal(result.ok, false);
  assert.equal(result.error.type, 'missing_argument');
  assert.ok(result.error.message.includes('needs values'), result.error.message);
  assert.ok(result.error.fix.startsWith('call_tool tool=gridcraft.set_cells'), result.error.fix);
});

test('call_tool: an invalid argument fails with the closest choice', async () => {
  const result = await tools.call_tool.run({ tool: 'gridcraft.insert_chart', kind: 'piee' });
  assert.equal(result.ok, false);
  assert.equal(result.error.type, 'invalid_argument');
  assert.ok(result.error.message.includes('did you mean pie'), result.error.message);
});

test('call_tool: an unknown argument fails and names the taken parameters', async () => {
  const result = await tools.call_tool.run({ tool: 'gridcraft.inspect', range: 'A1', bogus: 'x' });
  assert.equal(result.ok, false);
  assert.equal(result.error.type, 'unknown_argument');
  assert.ok(result.error.message.includes('no parameter bogus'), result.error.message);
});

test('call_tool: an unknown tool fails with the closest names and the best tool template as fix', async () => {
  const result = await tools.call_tool.run({ tool: 'gridcraft.set_cellzz' });
  assert.equal(result.ok, false);
  assert.equal(result.error.type, 'unknown_tool');
  assert.ok(result.error.message.includes('gridcraft.set_cells'), result.error.message);
  assert.equal(result.error.fix, 'call_tool tool=gridcraft.set_cells start=<start> values=<values>');
});

test('call_tool: a ToolError from the executor keeps its type, message and fix', async () => {
  const throwing = createMetaTools(makeDeps({
    run: async () => { throw new ToolError('busy', 'gridcraft is busy with another thread', 'call_tool tool=gridcraft.inspect range=A1'); }
  }));
  const result = await throwing.call_tool.run({ tool: 'gridcraft.inspect', range: 'A1' });
  assert.deepEqual(result, { ok: false, error: { type: 'busy', message: 'gridcraft is busy with another thread', fix: 'call_tool tool=gridcraft.inspect range=A1' } });
});

test('call_tool: any other throw becomes an app_error, and nothing is retried', async () => {
  let attempts = 0;
  const throwing = createMetaTools(makeDeps({
    run: async () => { attempts++; throw new Error('boom'); }
  }));
  const result = await throwing.call_tool.run({ tool: 'gridcraft.inspect', range: 'A1' });
  assert.deepEqual(result, { ok: false, error: { type: 'app_error', message: 'boom' } });
  assert.equal(attempts, 1, 'never retry');
});

test('results are deterministic for the same inputs', async () => {
  assert.deepEqual(await tools.lookup_skill_index.run({ query: 'chart' }), await tools.lookup_skill_index.run({ query: 'chart' }));
  assert.deepEqual(await tools.read_skill.run({ path: 'gridcraft/chart-from-range' }), await tools.read_skill.run({ path: 'gridcraft/chart-from-range' }));
  assert.deepEqual(await tools.find_tool.run({ query: 'cells' }), await tools.find_tool.run({ query: 'cells' }));
});
