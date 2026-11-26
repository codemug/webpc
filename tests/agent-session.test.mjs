// Agent mode end to end with a scripted model: the real generated catalog, skills and indexes
// (npm test runs `npm run catalog` first), the real meta tools, repairs and executor, and fake
// desktop and Files hosts that record what Buddy asked them to do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentSession, repeatNote, searchLoopNote, stopMessage, priorFailed, unknownToolMessage, windowsLine, metaAlias, readLoopNudge, discoveryNextLine } from '../src/apps/ai-agent/session.js';
import { createAgent, META_TOOL_NAMES } from '../src/apps/ai-agent/runtime/index.mjs';

const call = (name, args) => `<tool_call><function=${name}>${Object.entries(args).map(([k, v]) => `<parameter=${k}>${v}</parameter>`).join('')}</function></tool_call>`;
function setup(outputs, clientOverride = {}) {
  const seen = { prompts: [], schemas: [], host: [], files: [] };
  const client = { ready: true, stop() {}, count: async () => 100, generate: async (messages, schemas) => { seen.prompts.push(messages); seen.schemas.push(schemas); return outputs.shift() ?? 'Done.'; }, ...clientOverride };
  const record = (name, value) => async (...args) => { seen.host.push([name, ...args]); return value; };
  const host = { open: record('open', { id: 'gridcraft', opened: true }), close: record('close', { closed: true }), setTheme: record('setTheme', 'dark'), apps: record('apps', []), windows: record('windows', []) };
  const filesCtx = { mkdir: async path => { seen.files.push(['mkdir', path]); return { path }; }, remove: async (path, opts) => { seen.files.push(['remove', path, opts]); return { path, removed: true }; } };
  const session = new AgentSession({
    client, store: { save: async () => {} }, webSearch: async () => ({ results: [] }), httpGet: async () => ({}), runJavaScript: async () => ({ result: 42 }),
    agent: createAgent(), host: () => host, filesCtx,
  });
  return { session, seen };
}
const toolMessages = session => session.history.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
// Host actions the tools took; the turn's own read of the open windows (context for the note) is left out.
const actions = seen => seen.host.filter(h => h[0] !== 'windows');

test('the model sees only the six meta tools and an agent system prompt with the app list', async () => {
  const { session, seen } = setup(['Hello!']);
  await session.send('Hi Buddy');
  assert.deepEqual(seen.schemas[0].map(s => s.function.name), META_TOOL_NAMES);
  const system = seen.prompts[0][0].content;
  assert.match(system, /You are WebPC Agent/);
  assert.match(system, /Apps: .*gridcraft \(GridCraft\)/);
  // The small-model precision rules (build 8: cyberchef-01/02 baked reworded text and then
  // wrote results it never baked) - and a length guard, the prompt is paid on every turn.
  assert.match(system, /Copy the user's text exactly, character for character/);
  assert.match(system, /Run every step with a tool; never write a result you did not get from a tool/);
  assert.ok(system.length < 2500, `agent system prompt is ${system.length} chars`);
  assert.doesNotMatch(system, /desktop\.open_app/);
});

test('prefetch puts the best skill in the prompt but never in the saved history', async () => {
  const { session, seen } = setup([call('call_tool', { tool: 'desktop.open_app', app: 'gridcraft' }), 'GridCraft is open.']);
  await session.send('Open GridCraft');
  const user = seen.prompts[0].at(-1).content;
  assert.match(user, /Note: matching skill .* Steps \(fill each <placeholder> with the user's own values\):\n1\. call_tool tool=desktop\.open_app app=<app>/);
  assert.doesNotMatch(session.history.find(m => m.role === 'user').content, /Note:/);
  assert.deepEqual(actions(seen)[0], ['open', 'gridcraft']);
  assert.equal(toolMessages(session)[0].ok, true);
});

test('repairs: signature text in the tool name, an app title, and a directly called catalog tool', async () => {
  const { session, seen } = setup([
    call('call_tool', { tool: 'files.mkdir(path)', path: 'Reports' }),
    call('desktop.open_app', { app: 'GridCraft' }),
    call('call_tool', { tool: 'docs.close' }),
    'Done.',
  ]);
  await session.send('Make a Reports folder, open GridCraft and close Docs');
  assert.deepEqual(seen.files[0], ['mkdir', '/Reports']);
  assert.deepEqual(actions(seen).map(h => h.slice(0, 2)), [['open', 'gridcraft'], ['close', 'docs']]);
  const results = toolMessages(session);
  assert.ok(results.every(r => r.ok), JSON.stringify(results));
  assert.ok(results[0].repaired?.length, 'the model is told what was repaired');
});

test('a destructive tool runs without asking', async () => {
  const { session, seen } = setup([call('call_tool', { tool: 'files.delete', path: '/Old' }), 'OK, I left it.']);
  await session.send('Delete the Old folder');
  assert.equal(seen.files.length, 1);
  assert.deepEqual(seen.files[0].slice(0, 2), ['remove', '/Old']);
  assert.equal(toolMessages(session)[0].ok, true, JSON.stringify(toolMessages(session)[0]));
});

test('bad arguments get a teaching error with a fix, and an old tool name still works', async () => {
  const { session } = setup([call('call_tool', { tool: 'desktop.set_theme', theme: 'purple' }), call('calculate', { expression: '6*7' }), 'Done.']);
  await session.send('Make it purple, then what is 6 times 7?');
  const [theme, calc] = toolMessages(session);
  assert.equal(theme.error.type, 'invalid_argument');
  assert.match(theme.error.fix, /^call_tool tool=desktop\.set_theme theme=/);
  assert.equal(calc.ok, true);
  assert.equal(calc.tool, 'system.calculate');
});

test('without a desktop host the desktop tools say they are not available', async () => {
  const { session } = setup([call('call_tool', { tool: 'desktop.open_app', app: 'docs' }), 'Sorry.']);
  session.host = () => null;
  await session.send('Open Docs');
  assert.equal(toolMessages(session)[0].error.type, 'not_available');
});

test('prefetch skips skills that only share filler words with the request', async () => {
  const agent = createAgent();
  // The sum skill itself, not a tool list where effectcraft.keyframe_add ("key times") ranked first.
  assert.match(agent.prefetch('What is 6 times 7?'), /matching skill "Work out a sum exactly"/);
  assert.doesNotMatch(agent.prefetch('What is 6 times 7?'), /see-what-is-open/);
  assert.equal(agent.prefetch('zzz qqq'), '');
});

test('a generic run_command that deletes runs without asking, through the tool effectFor', async () => {
  const { session } = setup([call('call_tool', { tool: 'gridcraft.run_command', command: 'sheet.delete', params: 'sheet=Sheet2' }), 'OK.']);
  const sent = [];
  session.craft = async () => ({ commands: async () => [{ id: 'sheet.delete', label: 'Delete sheet', params: '{sheet}' }], execute: async (...a) => { sent.push(a); return {}; } });
  await session.send('Delete Sheet2 in GridCraft');
  assert.equal(sent.length, 1, 'the command executed without an approval gate');
  assert.equal(toolMessages(session)[0].error, undefined, JSON.stringify(toolMessages(session)[0]));
});

/** A22: an unnamed query gets a tie-break boost for the app active on screen. */
test('A22: the active app wins a near-tie for an unnamed query; a named rival app suppresses the boost', () => {
  const agent = createAgent();
  // deckcraft is active on screen and the query names no app; gridcraft out-scores by 196:169
  // (a 14% gap, inside the tie-break epsilon).
  assert.match(agent.prefetch('make a table with these values', 'deckcraft'), /deckcraft\/add-a-table/);
  // No active app: the raw ranking stands.
  assert.match(agent.prefetch('make a table with these values'), /gridcraft\/type-values-into-cells/);
  // The query names gridcraft: the deckcraft boost is suppressed and gridcraft keeps the note.
  assert.match(agent.prefetch('make a table with these values in gridcraft', 'deckcraft'), /gridcraft/);
  assert.doesNotMatch(agent.prefetch('make a table with these values in gridcraft', 'deckcraft'), /deckcraft\/add-a-table/);
});

test('A22: the note stays on the on-screen app - a cross-app out-scoring cannot win it (B17 scoping)', () => {
  const agent = createAgent();
  // terminal-05: gridcraft out-scores the terminal skill ~2x on this prompt, but the terminal
  // is the app on screen and the journey is a pure terminal.run one - the note was the
  // gridcraft skill, the same wrong-app lure as excalidraw-08. The note now stays on the
  // on-screen app; the cross-app skill is still reachable through the model's own
  // lookup_skill_index (unscoped, with the A22 active-app boost).
  const p05 = 'I need a quick total from a small table before the standup. Create sales-mini.csv in the home directory with the header line region,units and these rows: North,23 / South,41 / East,36. Then ignore the header row, print the average units per region, and end with just the total so I can read it off the terminal.';
  assert.match(agent.prefetch(p05, 'terminal'), /terminal\/run-code-in-the-linux-guest/);
  assert.doesNotMatch(agent.prefetch(p05, 'terminal'), /gridcraft\//);
  // No active app: the raw ranking stands (the gridcraft skill keeps the note).
  assert.match(agent.prefetch(p05), /gridcraft\/total-a-column-by-category/);
});

// B17 (excalidraw-08): "pipeline" is a word in an excalidraw "pipeline diagram" prompt, and
// the cyberchef multi-step-pipeline skill (keyword "pipeline") out-scored every excalidraw
// skill - the model got a cyberchef.bake step list for a canvas task.
test('B17: the prefetch note never names a rival app while the on-screen app has a matching skill', () => {
  const agent = createAgent();
  const p08 = 'Build me a simple three step pipeline diagram on the canvas. Three rectangles, each 180 wide by 70 high, at 100, 100, 350, 100 and 600, 100, labelled A, B and C in that order. Add arrows from A to B and from B to C, put a title reading Pipeline at 100, 20, and finally fit the view so everything is visible.';
  assert.match(agent.prefetch(p08, 'excalidraw'), /excalidraw\//);
  assert.doesNotMatch(agent.prefetch(p08, 'excalidraw'), /cyberchef\//);
});

// A24 (figcraft-02/filmcraft-02, b16): the user's message names one app and the model's
// unscoped query names none - that app's hits lead the list as a partition, not an epsilon.
test('A24: find_tool and lookup_skill_index lead with the app the user names, off for two apps', async () => {
  const agent = createAgent();
  const userText = 'Open beach-sunset.jpg in FilmCraft and put it on the timeline.';
  const tools = await agent.metaTools.find_tool.run({ query: 'import a still' }, { userText });
  assert.ok(tools.hits.some(h => h.tool === 'filmcraft.open_file'), 'the named app tool is in the list');
  assert.ok(tools.hits.findIndex(h => h.tool === 'filmcraft.open_file') < tools.hits.findIndex(h => h.tool === 'lightcraft.import_file'), 'filmcraft.open_file outranks lightcraft.import_file');
  const skills = await agent.metaTools.lookup_skill_index.run({ query: 'import a still' }, { userText });
  assert.match(skills.hits[0].path, /^filmcraft\//, 'the named app skill leads the index');
  // Two apps named in the message: a cross-app journey, the ranking is the raw one.
  const two = await agent.metaTools.find_tool.run({ query: 'import a still' }, { userText: 'Open it in FilmCraft, and the photo in LightCraft too.' });
  const bare = await agent.metaTools.find_tool.run({ query: 'import a still' }, {});
  assert.deepEqual(two.hits.map(h => h.tool), bare.hits.map(h => h.tool), 'no partition: the raw ranking stands');
  // An app= scope is the answer: the partition stays off.
  const scoped = await agent.metaTools.find_tool.run({ query: 'import a still', app: 'lightcraft' }, { userText });
  assert.ok(scoped.hits.every(h => h.tool.startsWith('lightcraft.') || h.tool.startsWith('desktop.')));
});

// b17 (excalidraw-08, the measured path): eval runs are prefetch-off, so the on-screen
// scoping must hold in the model's own lookup_skill_index - an unscoped "pipeline diagram"
// query with excalidraw on screen ranked cyberchef/multi-step-pipeline first.
test('b17: lookup_skill_index leads with the on-screen app when the query and the user name no app', async () => {
  const agent = createAgent();
  const p08 = 'Build me a simple three step pipeline diagram on the canvas. Three rectangles, each 180 wide by 70 high, at 100, 100, 350, 100 and 600, 100, labelled A, B and C in that order. Add arrows from A to B and from B to C, put a title reading Pipeline at 100, 20, and finally fit the view so everything is visible.';
  const query = 'three step pipeline diagram with rectangles and arrows';
  const active = await agent.metaTools.lookup_skill_index.run({ query }, { userText: p08, activeApp: 'excalidraw' });
  assert.equal(active.hits[0].path, 'excalidraw/draw-a-diagram', active.hits.map(h => h.path).join(' | '));
  // Control: without the on-screen app the lure stands - the measured b16 behaviour.
  const bare = await agent.metaTools.lookup_skill_index.run({ query }, { userText: p08 });
  assert.equal(bare.hits[0].path, 'cyberchef/multi-step-pipeline', 'the cyberchef skill wins unscoped');
  // Two apps named in the message: a cross-app journey, the raw ranking stands.
  const two = await agent.metaTools.lookup_skill_index.run({ query }, { userText: 'Do it in FilmCraft and LightCraft.', activeApp: 'excalidraw' });
  assert.deepEqual(two.hits.map(h => h.path), bare.hits.map(h => h.path), 'no partition for a cross-app prompt');
  // The app the user names still outranks the on-screen app (A24 owns the named case).
  const named = await agent.metaTools.lookup_skill_index.run({ query: 'import a still' }, { userText: 'Open beach-sunset.jpg in FilmCraft.', activeApp: 'excalidraw' });
  assert.match(named.hits[0].path, /^filmcraft\//);
  // The same on-screen partition in find_tool (08's model searched with find_tool, and the
  // eval run never sees the prefetch note): the active app's tools lead when it has a
  // matching hit, others follow, and the raw ranking stands when the user names apps.
  const bareTools = await agent.metaTools.find_tool.run({ query: 'import a still' }, { userText: 'Import this still into the project.' });
  // b19 sweep 02: filmcraft.open_file carries the import vocabulary (its keywords), so it is
  // now the raw top - effectcraft.add_item was the measured b16 lure and now follows (still in
  // the hits, asserted below under the on-screen partition).
  assert.equal(bareTools.hits[0].tool, 'filmcraft.open_file', 'the raw top without the on-screen app');
  const activeTools = await agent.metaTools.find_tool.run({ query: 'import a still' }, { userText: 'Import this still into the project.', activeApp: 'filmcraft' });
  assert.equal(activeTools.hits[0].tool, 'filmcraft.open_file', activeTools.hits.map(h => h.tool).join(' | '));
  assert.ok(activeTools.hits.some(h => h.tool === 'effectcraft.add_item'), 'other apps follow: cross-app tools stay reachable');
  const twoTools = await agent.metaTools.find_tool.run({ query: 'import a still' }, { userText: 'Import it in FilmCraft and LightCraft.', activeApp: 'filmcraft' });
  assert.deepEqual(twoTools.hits.map(h => h.tool), bareTools.hits.map(h => h.tool), 'two apps named: the raw ranking stands');
});

test('A22: the turn note carries the active app skill end to end', async () => {
  const { session, seen } = setup(['Table added.']);
  session.host = () => ({ windows: async () => [{ id: 'deckcraft', title: 'DeckCraft', state: 'normal', active: true }] });
  await session.send('Make a table with these values');
  assert.match(seen.prompts[0].at(-1).content, /deckcraft\/add-a-table/);
});

/** A22 part 2: the runs go with prefetch off, so the model-facing discovery searches carry
 *  the same tie-break (the find_skill alias resolves to lookup_skill_index). */
test('A22: lookup_skill_index and find_tool boost the active app in a near-tie; a named rival app or an app= scope suppresses it', async () => {
  const { metaTools } = createAgent();
  // No active app: the raw ranking stands (gridcraft out-scores deckcraft 196:169).
  const plain = await metaTools.lookup_skill_index.run({ query: 'make a table with these values' }, {});
  assert.equal(plain.hits[0].path, 'gridcraft/type-values-into-cells');
  // deckcraft is active on screen and the query names no app: the near-tie flips to the active app.
  const boosted = await metaTools.lookup_skill_index.run({ query: 'make a table with these values' }, { activeApp: 'deckcraft' });
  assert.equal(boosted.hits[0].path, 'deckcraft/add-a-table');
  // The query names a rival app: the boost is suppressed and gridcraft keeps the top.
  const rival = await metaTools.lookup_skill_index.run({ query: 'make a table with these values in gridcraft' }, { activeApp: 'deckcraft' });
  assert.equal(rival.hits[0].path, 'gridcraft/type-values-into-cells');
  // find_tool: 'put numbers in a grid table' ranks gridcraft.create_table 154 and
  // gridcraft.sort_range 76 above deckcraft.insert_table 60. b17 partition (lead-approved,
  // superseding the A22 near-tie boost for the unscoped case): with deckcraft active and no
  // app named anywhere, the active app's hit leads outright, not just a boosted second.
  const toolPlain = await metaTools.find_tool.run({ query: 'put numbers in a grid table' }, {});
  assert.deepEqual(toolPlain.hits.slice(0, 3).map(h => h.tool), ['gridcraft.create_table', 'gridcraft.sort_range', 'deckcraft.insert_table']);
  const toolBoosted = await metaTools.find_tool.run({ query: 'put numbers in a grid table' }, { activeApp: 'deckcraft' });
  assert.deepEqual(toolBoosted.hits.slice(0, 3).map(h => h.tool), ['deckcraft.insert_table', 'gridcraft.create_table', 'gridcraft.sort_range']);
  // The explicit app= scope is the answer, so the boost stays off.
  const scoped = await metaTools.find_tool.run({ query: 'put numbers in a grid table', app: 'gridcraft' }, { activeApp: 'deckcraft' });
  assert.deepEqual(scoped.hits.slice(0, 2).map(h => h.tool), ['gridcraft.create_table', 'gridcraft.sort_range']);
});

test('lookup_skill_index: "open LightCraft" never ranks another app\'s skill above the named app or the general packs (eval M6, B17)', async () => {
  const { createAgent } = await import('../src/apps/ai-agent/runtime/index.mjs');
  const { hits } = await createAgent().metaTools.lookup_skill_index.run({ query: 'open LightCraft' });
  const packs = hits.map(h => h.path.split('/')[0]);
  const firstOther = packs.findIndex(p => !['lightcraft', 'system', 'desktop', 'files'].includes(p));
  if (firstOther >= 0) assert.ok(packs.slice(firstOther).every(p => !['lightcraft', 'system', 'desktop', 'files'].includes(p)), JSON.stringify(hits.map(h => h.path)));
  assert.ok(['lightcraft', 'desktop'].includes(packs[0]), JSON.stringify(hits.map(h => h.path)));
});

test('a repeated lookup_skill_index call runs again: same hits plus a note, never a refusal', async () => {
  const { session } = setup([
    call('lookup_skill_index', { query: 'list all apps on my PC' }),
    call('lookup_skill_index', { query: 'list all apps on my PC' }),
    call('lookup_skill_index', { query: 'list all apps on my PC' }),
    'Done.',
  ]);
  await session.send('What apps are on my PC?');
  const [first, second, third] = toolMessages(session);
  assert.ok(first.hits.length > 0, 'the first lookup ran and found hits');
  assert.equal(first.note, undefined);
  for (const again of [second, third]) {
    assert.deepEqual(again.hits, first.hits, 'the repeat ran and returned the same hits');
    assert.equal(again.error, undefined, 'no refusal');
    assert.match(again.note, /Same results as your earlier search/);
  }
});

test('a repeated find_tool call runs again with its hits and a note', async () => {
  const { session } = setup([
    call('find_tool', { query: 'list apps' }),
    call('find_tool', { query: 'list apps' }),
    'Done.',
  ]);
  await session.send('What apps are on my PC?');
  const [first, second] = toolMessages(session);
  assert.ok(first.hits.length > 0, 'the first find_tool ran and found hits');
  assert.deepEqual(second.hits, first.hits);
  assert.match(second.note, /Same tools as your earlier search/);
});

// terminal.run proves the shell with a sentinel echo before the first command of a boot
// (the boot race, sweep-terminal-b17 terminal-01): the fake runCode bridges answer the
// sentinel like a ready shell; everything else goes to the scripted fake.
const withSentinel = runCode => async (lang, code) => {
  if (typeof code === 'string' && code.startsWith('echo wcpc-ready-')) {
    return { type: 'exec-result', exitCode: 0, output: `${code.slice(5)}\n` };
  }
  return runCode(lang, code);
};

test('a repeated non-meta call still runs twice and stops at the third failing one', async () => {
  // A bare "terminal" name with a command= param is the lfm3-1.7b terminal-03/10 shape: since
  // build 15 it routes straight to terminal.run behind call_tool, and the repeat-stop guard
  // still bounds a third identical failing run.
  const { session } = setup([
    call('terminal', { command: 'echo hi' }),
    call('terminal', { command: 'echo hi' }),
    call('terminal', { command: 'echo hi' }),
    'Done.',
  ]);
  const win = { document: { getElementById: id => (id === 'linux-start' ? { disabled: true } : id === 'linux-restart' ? { disabled: false } : { textContent: '' }) } };
  session.host = () => ({ appWindow: async () => win, windows: async () => [] });
  session.runCode = withSentinel(async () => ({ type: 'exec-result', exitCode: 127, output: '/bin/sh: echi: not found\n' }));
  await session.send('Run echo hi in the terminal');
  const msg = r => (typeof r.error === 'string' ? r.error : r.error?.message ?? '');
  const [one, two, three] = toolMessages(session);
  assert.equal(one.result?.exitCode, 127, 'the bare terminal call routed to terminal.run');
  assert.equal(two.result?.exitCode, 127, 'the repeat runs again');
  assert.match(msg(three), /Stopped: this exact call already failed twice \(the command exited with code 127/);
  // terminal-10: the model re-ran the command that had already answered, and the stop became
  // the last result the check reads - a successful identical call runs again.
  const { session: ok } = setup([
    call('calculate', { expression: '6*7' }),
    call('calculate', { expression: '6*7' }),
    call('calculate', { expression: '6*7' }),
    'Done.',
  ]);
  await ok.send('What is 6 times 7?');
  const [a, b, c] = toolMessages(ok);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(c.ok, true, 'the third successful run is not a stop');
});

/** A23: a third identical call whose two prior results are identical runs nothing (terminal-05:
 *  22x the same cat on a file an earlier printf bug had corrupted). */
test('A23: a third identical call with identical results is not executed and returns the prior result with the note', async () => {
  let runs = 0;
  const { session } = setup([
    call('terminal', { command: 'cat /home/user/sales-mini.csv' }),
    call('terminal', { command: 'cat /home/user/sales-mini.csv' }),
    call('terminal', { command: 'cat /home/user/sales-mini.csv' }),
    call('terminal', { command: 'cat /home/user/sales-mini.csv' }),
    'Done.',
  ]);
  const win = { document: { getElementById: id => (id === 'linux-start' ? { disabled: true } : id === 'linux-restart' ? { disabled: false } : { textContent: '' }) } };
  session.host = () => ({ appWindow: async () => win, windows: async () => [] });
  session.runCode = withSentinel(async () => { runs += 1; return { type: 'exec-result', exitCode: 0, output: 'region,units\nNorth,23\n' }; });
  await session.send('Show me the file');
  const [one, two, three, four] = toolMessages(session);
  assert.equal(runs, 2, 'the third and fourth identical calls are not executed');
  assert.equal(one.result?.exitCode, 0);
  assert.equal(two.result?.exitCode, 0);
  assert.equal(three.result?.exitCode, 0, 'the prior successful result is returned, not a stop (terminal-10 pin)');
  assert.deepEqual(three.result, two.result, 'the returned result is the prior one');
  assert.match(String(three.next), /ran this exact call 3 times/);
  assert.deepEqual(four.result, two.result, 'a 4th identical call is served from the cache too, not re-run (terminal-05: 22 straight cats)');
  assert.match(String(four.next), /ran this exact call 3 times/);
});

test('A23: identical calls whose results differ all run, with no note', async () => {
  let runs = 0;
  const { session } = setup([
    call('terminal', { command: 'cat /home/user/sales-mini.csv' }),
    call('terminal', { command: 'cat /home/user/sales-mini.csv' }),
    call('terminal', { command: 'cat /home/user/sales-mini.csv' }),
    'Done.',
  ]);
  const win = { document: { getElementById: id => (id === 'linux-start' ? { disabled: true } : id === 'linux-restart' ? { disabled: false } : { textContent: '' }) } };
  session.host = () => ({ appWindow: async () => win, windows: async () => [] });
  session.runCode = withSentinel(async () => { runs += 1; return { type: 'exec-result', exitCode: 0, output: `attempt ${runs}\n` }; });
  await session.send('Show me the file');
  const [one, two, three] = toolMessages(session);
  assert.equal(runs, 3, 'a differing result runs again');
  assert.notDeepEqual(three.result, two.result);
  assert.equal(three.next, undefined, 'no change-something note');
});

test('A20: a successful state-changing call clears the failure memory, so a retry after the fix runs', async () => {
  // pdfcraft-05 (build 14): page_insert_blank failed twice ("no document open"), open_file
  // succeeded, and the third insert_blank was still stopped although the precondition was fixed.
  const { session } = setup([
    call('call_tool', { tool: 'files.mkdir' }),
    call('call_tool', { tool: 'files.mkdir' }),
    call('call_tool', { tool: 'desktop.open_app', app: 'gridcraft' }),
    call('call_tool', { tool: 'files.mkdir' }),
    'Done.',
  ]);
  await session.send('Make a folder after opening GridCraft');
  const [one, two, opened, retry] = toolMessages(session);
  const msg = r => (typeof r.error === 'string' ? r.error : r.error?.message ?? '');
  assert.match(msg(one), /needs path/);
  assert.match(msg(two), /needs path/);
  assert.equal(opened.ok, true);
  assert.match(msg(retry), /needs path/, 'the retry runs again after the state change');
  assert.doesNotMatch(msg(retry), /Stopped/, 'no stop: the failure memory was cleared by the successful change');
});

// A craft app with no document open; driving the wrapper's #file input (open_file's own
// path) flips it open, the way the real wrapper consumes the change event (A20: the
// pdfcraft-05 / filmcraft open_file shapes as the fixer of the failing call).
const openFileHarness = (name) => {
  const state = { open: false };
  const input = { files: null, dispatchEvent: () => { state.open = true; } };
  const wrapperWindow = {
    document: { getElementById: id => (id === 'file' ? input : null) },
    DataTransfer: class { constructor() { this.items = { add: () => {} }; this.files = []; } },
    File: class { constructor(parts, n) { this.name = n; } },
    Event: class { constructor(type) { this.type = type; } },
  };
  const host = { open: async () => ({ opened: true }), close: async () => ({ closed: true }), setTheme: async () => 'dark', apps: async () => [], windows: async () => [], appWindow: async () => wrapperWindow };
  const craft = {
    inspect: async () => ({ documents: state.open ? [{ name }] : [] }),
    execute: async () => { if (!state.open) throw new Error('no document open'); return { ok: true }; },
  };
  return { host, craft };
};

test('A20: the pdfcraft-05 shape with pdfcraft.open_file (change) as the fixer - the retry runs', async () => {
  const { host, craft } = openFileHarness('contract.pdf');
  const { session } = setup([
    call('call_tool', { tool: 'pdfcraft.page_insert_blank', at: 2 }),
    call('call_tool', { tool: 'pdfcraft.page_insert_blank', at: 2 }),
    call('call_tool', { tool: 'pdfcraft.open_file', path: '/PDFCraft/contract.pdf' }),
    call('call_tool', { tool: 'pdfcraft.page_insert_blank', at: 2 }),
    'Done.',
  ]);
  session.host = () => host;
  session.craft = async () => craft;
  session.filesCtx = { mkdir: async p => ({ path: p }), remove: async () => ({ removed: true }), readBytes: async path => ({ name: path.split('/').pop(), bytes: new Uint8Array([1]) }) };
  await session.send('Open the contract PDF, then insert a blank page before page 2');
  const [one, two, opened, retry] = toolMessages(session);
  assert.equal(one.ok, false, 'the first insert fails: no document open');
  assert.equal(two.ok, false, 'the second insert fails');
  assert.equal(opened.ok, true, 'open_file succeeds', JSON.stringify(opened));
  assert.equal(retry.ok, true, 'the retry runs after the open', JSON.stringify(retry));
  assert.doesNotMatch(retry.error ?? '', /Stopped/);
});

test('A20: a DESTRUCTIVE opener (filmcraft.open_file) clears the failure memory too', async () => {
  // filmcraft.open_file replaces the open project, so the catalog marks it destructive;
  // the A20 condition is "change or destructive", not "change" alone (lead: the real
  // pdfcraft-05 fixer was open_file, and filmcraft/effectcraft opens are destructive).
  const { host, craft } = openFileHarness('talk.fcproj');
  const { session } = setup([
    call('call_tool', { tool: 'filmcraft.place', item: '3', track: 'V1', seconds: 0 }),
    call('call_tool', { tool: 'filmcraft.place', item: '3', track: 'V1', seconds: 0 }),
    call('call_tool', { tool: 'filmcraft.open_file', path: '/FilmCraft/talk.fcproj' }),
    call('call_tool', { tool: 'filmcraft.place', item: '3', track: 'V1', seconds: 0 }),
    'Done.',
  ]);
  session.host = () => host;
  session.craft = async () => craft;
  session.filesCtx = { mkdir: async p => ({ path: p }), remove: async () => ({ removed: true }), readBytes: async path => ({ name: path.split('/').pop(), bytes: new Uint8Array([1]) }) };
  await session.send('Open the talk project and put item 3 on V1');
  const [one, two, opened, retry] = toolMessages(session);
  assert.equal(one.ok, false, 'placing into no project fails');
  assert.equal(opened.ok, true, 'the destructive open succeeds', JSON.stringify(opened));
  assert.equal(retry.ok, true, 'the retry runs after the destructive open', JSON.stringify(retry));
  assert.doesNotMatch(retry.error ?? '', /Stopped/);
});

test('A20: every open_file and lightcraft.import_file in the built catalog carries a change or destructive effect', () => {
  const agent = createAgent();
  const openers = [...agent.catalog.tools.keys()].filter(name => /\.open_file$/.test(name) || name === 'lightcraft.import_file');
  assert.ok(openers.length >= 5, `expected at least 5 openers, got ${openers.length}: ${openers.join(', ')}`);
  for (const name of openers) {
    const effect = agent.catalog.tools.get(name)?.effect;
    assert.ok(effect === 'change' || effect === 'destructive', `${name} has effect ${effect}, which the A20 clear would not see`);
  }
});

test('stopMessage unwraps an earlier stop wrapper and carries the original fix through', () => {
  const inner = 'Stopped: this exact call already failed twice (deckcraft.add_slide has no parameter title). Change it: call_tool tool=deckcraft.add_slide layout=<layout>';
  const nested = { error: `Stopped: this exact call already failed twice (${inner}). Change it: call_tool tool=deckcraft.add_slide layout=<layout>`, fix: 'call_tool tool=deckcraft.add_slide layout=<layout>' };
  assert.equal(stopMessage(nested), inner, 'no nesting, original fix kept');
});

test('unknownToolMessage names the closest catalog tool and the call_tool route', () => {
  const agent = { catalog: { tools: new Map([['terminal.run', {}], ['terminal.open', {}], ['gridcraft.set_cell', {}]]) } };
  const msg = unknownToolMessage('terminal', agent, ['lookup_skill_index', 'call_tool']);
  assert.match(msg, /^Unknown tool terminal\. Available tools: lookup_skill_index, call_tool\./);
  assert.match(msg, /Closest: terminal\.run, terminal\.open/);
  assert.match(msg, /call it with call_tool/);
  assert.equal(unknownToolMessage('x', null, ['a', 'b']), 'Unknown tool x. Available tools: a, b.', 'classic mode keeps the plain message');
});

test('repeatNote gives each repeatable meta tool a note that picks no hit, and is null for other tools', () => {
  assert.match(repeatNote('lookup_skill_index', { hits: [{ path: 'sqliteviz/inspect-the-schema' }] }), /Same results as your earlier search/);
  assert.doesNotMatch(repeatNote('lookup_skill_index', { hits: [{ path: 'sqliteviz/inspect-the-schema' }] }), /sqliteviz/, 'no hit is pushed');
  assert.match(repeatNote('find_tool', { hits: [] }), /Same tools as your earlier search/);
  assert.match(repeatNote('find_in_skill', { hits: [] }), /Same lines as your earlier search/);
  assert.equal(repeatNote('read_skill', { text: 'Open an app\nSteps:\n1. call_tool tool=desktop.open_app app=<app>' }), 'You already read this; its first step: call_tool tool=desktop.open_app app=<app>');
  assert.equal(repeatNote('describe_tool', { text: 'x\nCall: call_tool tool=desktop.list_apps' }), 'You already read this; its first step: call_tool tool=desktop.list_apps');
  assert.match(repeatNote('read_skill', { ok: false }), /You already read this/);
  assert.equal(repeatNote('call_tool', {}), null);
  assert.equal(repeatNote('desktop.list_apps', {}), null);
});

test('a truncated final answer emits reply-cut once; an untruncated answer emits nothing', async () => {
  const { session } = setup([{ text: 'Your apps:', truncated: true }]);
  const events = [];
  session.emit = (type) => { events.push(type); };
  await session.send('List my apps');
  assert.deepEqual(events.filter(type => type === 'reply-cut'), ['reply-cut']);
  const plain = setup(['No cut here.']);
  const none = [];
  plain.session.emit = (type) => { none.push(type); };
  await plain.session.send('Hi');
  assert.ok(!none.includes('reply-cut'), `events: ${none.join(', ')}`);
});


/** The J2 search loop: the right tool topped find_tool, the model kept searching. */
test('searchLoopNote says to call a tool that topped find_tool twice and was never called', () => {
  const tops = new Map(); const called = new Set();
  const hit = { hits: [{ tool: 'cyberchef.bake', call: 'call_tool tool=cyberchef.bake recipe=<recipe> input=<input>' }] };
  assert.equal(searchLoopNote(tops, called, 'find_tool', hit), null, 'first time: no nudge');
  assert.match(searchLoopNote(tops, called, 'find_tool', hit), /found cyberchef\.bake 2 times.*call_tool tool=cyberchef\.bake recipe=<recipe>/);
  called.add('cyberchef.bake');
  assert.equal(searchLoopNote(tops, called, 'find_tool', hit), null, 'once called: no nudge');
  assert.equal(searchLoopNote(new Map(), new Set(), 'lookup_skill_index', hit), null);
  assert.equal(searchLoopNote(new Map(), new Set(), 'find_tool', { hits: [] }), null);
});

/** A18: the read-loop nudge fires on the third consecutive discovery call and names the next step. */
test('readLoopNudge fires on the third consecutive discovery call, resets on a catalog call, names the right step', () => {
  const state = { n: 0, skill: null, toolLine: null };
  const hit = { hits: [{ tool: 'cyberchef.bake', call: 'call_tool tool=cyberchef.bake recipe=<recipe> input=<input>' }] };
  assert.equal(readLoopNudge(state, 'find_tool', hit), null, 'first discovery call');
  assert.equal(readLoopNudge(state, 'lookup_skill_index', { hits: [] }), null, 'second');
  const skill = { path: 'cyberchef/base64-encode', text: 'Encode text in Base64\n1. call_tool tool=cyberchef.bake recipe=To_Base64 input=<input>' };
  assert.equal(readLoopNudge(state, 'read_skill', skill),
    "You have read enough; act now. Next step of cyberchef/base64-encode: call_tool tool=cyberchef.bake recipe=To_Base64 input=<input>");
  assert.match(readLoopNudge(state, 'find_in_skill', { lines: [] }), /You have read enough; act now/, 'the nudge persists while the discovery streak continues');
  assert.equal(readLoopNudge(state, 'call_tool', { ok: true }), null, 'a catalog call resets the streak');
  assert.equal(readLoopNudge(state, 'find_tool', hit), null, 'and a new streak restarts at one');
  // Fallback: the top find_tool hit's call line when no skill read carried a call step.
  const fresh = { n: 0, skill: null, toolLine: null };
  readLoopNudge(fresh, 'find_tool', hit);
  readLoopNudge(fresh, 'describe_tool', { text: 'a description without steps' });
  assert.match(readLoopNudge(fresh, 'read_skill', { path: 'x/y', text: 'prose only' }),
    /You have read enough; act now\. Call the tool you found.*call_tool tool=cyberchef\.bake recipe=<recipe>/);
  // No line anywhere: the bare nudge still fires.
  const bare = { n: 0, skill: null, toolLine: null };
  bare.n = 2;
  assert.equal(readLoopNudge(bare, 'lookup_skill_index', { hits: [] }), 'You have read enough; act now.');
});

// B17 (cyberchef-09): the A21 next line skips steps whose effect already holds and gives the
// next two steps on the 2nd consecutive refusal instead of repeating the same line.
test('discoveryNextLine skips the done open_app/open_file steps and gives two steps on the 2nd refusal', () => {
  const state = { skill: { path: 'x/y', line: 'l1', steps: ['call_tool tool=desktop.open_app app=cyberchef', 'call_tool tool=cadcraft.line p1=<p1> p2=<p2>', 'call_tool tool=cadcraft.circle center=<c> radius=<r>'] } };
  const wins = [{ id: 'cyberchef', title: 'CyberChef', state: 'normal', active: true }];
  assert.equal(discoveryNextLine(state, wins, 1), 'call_tool tool=cadcraft.line p1=<p1> p2=<p2>', 'open_app skipped: the window is open');
  assert.equal(discoveryNextLine(state, wins, 2), 'call_tool tool=cadcraft.line p1=<p1> p2=<p2> then call_tool tool=cadcraft.circle center=<c> radius=<r>', 'the 2nd refusal gives the next two steps');
  assert.equal(discoveryNextLine(state, [], 1), 'call_tool tool=desktop.open_app app=cyberchef', 'no windows: the open_app step stands first');
  // open_file: done when a window shows the file.
  const file = { skill: { path: 'x/y', line: 'f', steps: ['call_tool tool=cadcraft.open_file path=/drawings/x.dwg', 'call_tool tool=cadcraft.line p1=<p1> p2=<p2>'] } };
  assert.equal(discoveryNextLine(file, [{ id: 'cadcraft', title: 'x.dwg - CadCraft', state: 'normal' }], 1), 'call_tool tool=cadcraft.line p1=<p1> p2=<p2>');
  // Templated steps can be identical: a repeated line teaches nothing, so give the one.
  const dup = { skill: { path: 'x/y', line: 's', steps: ['s', 's'] } };
  assert.equal(discoveryNextLine(dup, [], 2), 's');
});

test('A21 refusal skips the done open_app step and points at the skill step still owed (cyberchef-09)', async () => {
  const script = () => [
    call('find_tool', { query: 'cyberchef shift' }),
    call('read_skill', { path: 'cyberchef/shift-the-letters' }),
    call('find_in_skill', { path: 'cyberchef', query: 'shift' }),
    call('lookup_skill_index', { query: 'shift letters' }),
    call('describe_tool', { tool: 'cyberchef.bake' }),
    call('find_tool', { query: 'rot13' }),
    call('lookup_skill_index', { query: 'rot13 verify' }),
    call('find_tool', { query: 'shift letters again' }),
    call('find_tool', { query: 'shift letters once more' }),
    'Done.',
  ];
  const { session } = setup(script());
  session.host = () => ({ windows: async () => [{ id: 'cyberchef', title: 'CyberChef', state: 'normal', active: true }] });
  await session.send('Shift these letters for me');
  const msgs = toolMessages(session);
  assert.equal(msgs.length, 9, 'seven discovery calls run, the 8th and 9th are refused');
  const msg = m => String(m.error);
  assert.ok(msgs.slice(0, 7).every(m => !m.error), 'the first seven discovery calls run');
  assert.match(msg(msgs[7]), /Discovery is closed for this turn/);
  // The fix skips the open_app step (the window is open) and points at the still-owed bake step.
  assert.equal(msgs[7].fix, 'call_tool tool=cyberchef.bake recipe=<recipe> input=<input>');
  assert.doesNotMatch(msgs[7].fix, /open_app/);
  // The 2nd refusal: the two remaining templated steps are identical, so the line stays one.
  assert.equal(msgs[8].fix, msgs[7].fix);
  // Control: without the window the open_app step stands first - the skip is what changed.
  const { session: s2 } = setup(script());
  await s2.send('Shift these letters for me');
  const m2 = toolMessages(s2);
  assert.match(String(m2[7].error), /Discovery is closed for this turn/);
  assert.match(m2[7].fix, /desktop\.open_app app=cyberchef/);
});

// B17 redirect reuse (cyberchef-09, sweep b19): the close skipped find_in_skill's dotted-name
// redirect, so the refused "files.read"/"files.write" queries got only the generic message.
test('the A21 close refusal carries the call line of a catalog tool name in the refused query', async () => {
  const disc = q => call('find_in_skill', { path: 'cyberchef/base64-decode', query: q });
  const script = [
    disc('shift'), disc('shift'), disc('shift'), disc('shift'), disc('shift'), disc('shift'), disc('shift'),
    disc('files.read'), // the 8th: closed - carries the files.read call line
    disc('files.write'), // still closed - carries the files.write call line
    disc('nota.tool'), // closed, unknown name - the generic message stands alone
    'Done.',
  ];
  const { session } = setup(script);
  await session.send('Decode the note in my files');
  const msgs = toolMessages(session);
  const msg = m => String(m.error);
  assert.ok(msgs.slice(0, 7).every(m => !m.error), 'the first seven discovery calls run');
  assert.match(msg(msgs[7]), /Discovery is closed for this turn/);
  assert.match(msg(msgs[7]), /"files\.read" is a tool, not skill text/);
  assert.match(msg(msgs[7]), /call_tool tool=files\.read to run it/);
  assert.match(msg(msgs[8]), /"files\.write" is a tool, not skill text/);
  assert.match(msg(msgs[9]), /Discovery is closed for this turn/, 'an unknown dotted word is still refused');
  assert.doesNotMatch(msg(msgs[9]), /is a tool, not skill text/, 'unknown words keep the generic message');
});

// A26 (gridcraft-10): the model dodged the A21 close with one trivial action and ran sixteen
// more discovery calls to the cap. A reopen now lasts three discovery calls, and an open_app
// of a window that is already open is not an action, so it does not reopen at all.
test('A26: after the close, a reopen lasts three discovery calls; a real call_tool reopens; a trivial open_app does not', async () => {
  const disc = () => call('find_in_skill', { path: 'cyberchef', query: 'shift' });
  // Close at 8, one real open_app (no windows open), then the close comes back at the 3rd
  // discovery call; a real call_tool reopens again (and its reopen is three calls too).
  const script = [
    disc(), disc(), disc(), disc(), disc(), disc(), disc(), disc(),
    call('call_tool', { tool: 'desktop.open_app', app: 'cadcraft' }),
    disc(), disc(), disc(),
    call('call_tool', { tool: 'cadcraft.line', p1: '0,0', p2: '5,5' }),
    disc(), disc(), disc(),
    'Done.',
  ];
  const { session } = setup(script);
  await session.send('Shift these letters for me');
  const msgs = toolMessages(session);
  assert.ok(msgs.slice(0, 7).every(m => !m.error), 'seven discovery calls run');
  assert.match(String(msgs[7].error), /Discovery is closed for this turn/, 'the 8th is refused');
  assert.equal(msgs[8].error, undefined, 'the open_app runs');
  assert.ok(!msgs[9].error && !msgs[10].error, 'the reopen allows two discovery calls');
  assert.match(String(msgs[11].error), /Discovery is closed for this turn/, 'the 3rd discovery call of the reopen is refused');
  // The real call_tool reopens again: two more discovery calls run, the 3rd is refused.
  assert.ok(!msgs[13].error && !msgs[14].error, 'a real call_tool reopens discovery');
  assert.match(String(msgs[15].error), /Discovery is closed for this turn/, 'its reopen is three calls too');
  // A trivial open_app (the app is already open) does not reopen: discovery stays closed.
  const trivialScript = [
    disc(), disc(), disc(), disc(), disc(), disc(), disc(), disc(),
    call('call_tool', { tool: 'desktop.open_app', app: 'gridcraft' }),
    disc(), disc(),
    'Done.',
  ];
  const { session: s2 } = setup(trivialScript);
  s2.host = () => ({ windows: async () => [{ id: 'gridcraft', title: 'GridCraft', state: 'normal', active: true }] });
  await s2.send('Shift these letters for me');
  const m2 = toolMessages(s2);
  assert.match(String(m2[7].error), /Discovery is closed for this turn/);
  assert.match(String(m2[9].error), /Discovery is closed for this turn/, 'the trivial open_app did not reopen: the next discovery call is refused at once');
  assert.match(String(m2[10].error), /Discovery is closed for this turn/);
});

test('a bare app name with a code-bearing arg routes to the app run tool (terminal-03/10)', async () => {
  // terminal-03/10 on build 14: the model called "terminal" with {command} for fifteen
  // rounds on "Unknown tool terminal"; the real tool is terminal.run behind call_tool.
  const { session } = setup([call('terminal', { command: 'whoami' }), 'Done.']);
  const win = { document: { getElementById: id => (id === 'linux-start' ? { disabled: true } : id === 'linux-restart' ? { disabled: false } : { textContent: '' }) } };
  session.host = () => ({ appWindow: async () => win, windows: async () => [] });
  session.runCode = withSentinel(async (lang, code) => ({ type: 'exec-result', exitCode: 0, output: `ran ${lang}: ${code}\n` }));
  await session.send('Who am I in the Linux terminal?');
  const [result] = toolMessages(session);
  assert.equal(result.ok, true, 'the bare terminal call reached terminal.run', JSON.stringify(result));
  assert.equal(result.tool, 'terminal.run');
  assert.match(result.result.output, /ran sh: whoami/, 'the command arg became the run code');
});

test('a bare app name with a code-bearing arg is traced under the acting tool (sweep b17)', async () => {
  // lfm3 called bare "terminal" with {command}; the run executed terminal.run behind call_tool,
  // but the eval trace recorded "terminal", so every terminal-03/05/08/10 check scored
  // "no terminal.run call in the trace". The trace card now carries the acting name.
  const { session } = setup([call('terminal', { command: 'whoami' }), 'Done.']);
  const cards = [];
  session.emit = (type, data) => { if (type === 'tool-start') cards.push(data); };
  const win = { document: { getElementById: id => (id === 'linux-start' ? { disabled: true } : id === 'linux-restart' ? { disabled: false } : { textContent: '' }) } };
  session.host = () => ({ appWindow: async () => win, windows: async () => [] });
  session.runCode = withSentinel(async (lang, code) => ({ type: 'exec-result', exitCode: 0, output: `ran ${lang}: ${code}\n` }));
  await session.send('Who am I?');
  assert.deepEqual(cards.map(c => c.name), ['terminal.run'], 'the trace records the tool that acted');
  const [result] = toolMessages(session);
  assert.equal(result.tool, 'terminal.run', 'the result still reports terminal.run');
});

test('A27 (1): near the 28k guard the prompt trims old tool results and the model keeps its tools', async () => {
  // gridcraft-01 (sweep b17): big results pushed the context past 28k at round 20, the guard
  // stripped the tools, the empty answer-only reply ended the run with the table half built.
  // The trim keeps the last three call rounds whole and cuts older tool results in the prompt
  // view only - the stored history stays intact.
  const big = 'x'.repeat(7000);
  const { session, seen } = setup([
    call('terminal', { command: 'cat /big/one' }),
    call('terminal', { command: 'cat /big/two' }),
    call('terminal', { command: 'cat /big/three' }),
    call('terminal', { command: 'cat /big/four' }),
    'Done.',
  ], { count: async (messages) => messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0) });
  const win = { document: { getElementById: id => (id === 'linux-start' ? { disabled: true } : id === 'linux-restart' ? { disabled: false } : { textContent: '' }) } };
  session.host = () => ({ appWindow: async () => win, windows: async () => [] });
  session.runCode = withSentinel(async () => ({ type: 'exec-result', exitCode: 0, output: big }));
  const full = [];
  session.emit = (type, data) => { if (type === 'tool-result') full.push(data.result); };
  await session.send('Read four big files');
  assert.equal(full.length, 4, 'four tool results ran');
  assert.equal(full[0].result.output.length, 7000, 'the live result is never trimmed - only the prompt view is');
  // Round 5 (index 4) sits at ~31k with four 7000-char results: without the trim the guard
  // strips the tools; with it, the oldest result is cut to 300 chars and the schemas stay on.
  assert.ok(seen.schemas[4].length > 0, 'the round after four big results still gets the tool schemas');
  const promptTools = seen.prompts[4].filter(m => m.role === 'tool').map(m => m.content);
  assert.ok(promptTools[0].includes('…[trimmed]'), 'the oldest tool result is trimmed in the prompt view');
  assert.ok(promptTools[1].length > 7000, 'the last three rounds are not trimmed');
});

test('A27 (2): an empty answer-only reply gets exactly one retry with the nudge', async () => {
  // canTools is off (30k count), so the round is answer-only: the empty first reply gets one
  // retry whose prompt carries the nudge; the nudge is never stored, so the saved history reads
  // as a normal answer.
  const { session, seen } = setup(['', 'Done: the table is built.'], { count: async () => 30000 });
  await session.send('Build the budget table');
  assert.equal(seen.prompts.length, 2, 'the empty reply was retried once');
  assert.match(seen.prompts[1].at(-1).content, /Answer the user now in one or two sentences/);
  const assistant = session.history.filter(m => m.role === 'assistant');
  assert.equal(assistant.length, 1);
  assert.equal(assistant[0].content, 'Done: the table is built.');
  // Empty twice lands on the placeholder - no second retry.
  const { session: again, seen: seen2 } = setup(['', ''], { count: async () => 30000 });
  await again.send('Build the budget table');
  assert.equal(seen2.prompts.length, 2, 'no second retry');
  assert.match(again.history.filter(m => m.role === 'assistant').at(-1).content, /no visible answer/);
});

/** A21: the 8th consecutive discovery call in a turn is not run; it answers the next-call fix. */
test('A21: ten discovery calls get real results 1-7, the closed error plus fix 8-10, and real results again after one call_tool', async () => {
  const outputs = [
    ...new Array(10).fill(call('find_tool', { query: 'gridcraft' })),
    call('calculate', { expression: '6*7' }),
    call('find_tool', { query: 'gridcraft' }),
    'Done.',
  ];
  const { session } = setup(outputs);
  await session.send('Find the gridcraft tools');
  const results = toolMessages(session);
  assert.equal(results.length, 12, 'twelve tool results, one per scripted call');
  for (let i = 0; i < 7; i++) {
    assert.ok(Array.isArray(results[i].hits), `call ${i + 1} ran and got real hits`);
    assert.equal(results[i].error, undefined, `call ${i + 1} is not closed`);
  }
  for (let i = 7; i < 10; i++) {
    assert.match(results[i].error, /discovery is closed/i, `call ${i + 1} is the closed error`);
    assert.ok(!Array.isArray(results[i].hits) || !results[i].hits.length, `call ${i + 1} has no hits`);
    assert.match(results[i].fix, /^call_tool tool=/, `call ${i + 1} carries the next-call fix`);
  }
  assert.equal(results[10].ok, true, 'the catalog call between the two streaks runs');
  assert.ok(Array.isArray(results[11].hits), 'a discovery call after the reset runs again');
  assert.equal(results[11].error, undefined, 'the reopened streak is not closed');
});

test('A21: the nudge and hard break fill app=<app> from the skill own app and leave other placeholders raw', () => {
  const state = { n: 0, skill: null, toolLine: null };
  readLoopNudge(state, 'find_tool', { hits: [] });
  readLoopNudge(state, 'read_skill', { path: 'docs/find-and-replace', text: 'Find and replace in the document\n1. call_tool tool=desktop.open_app app=<app>\n2. call_tool tool=docs.find_replace find=<find> replace=<replace>' });
  const nudge = readLoopNudge(state, 'find_in_skill', { lines: [] });
  assert.match(nudge, /app=docs/, 'app=<app> filled from the skill own app');
  assert.doesNotMatch(nudge, /app=<app>/);
  // A skill whose step has no app slot and a path with no slash keep their placeholders raw.
  const fresh = { n: 0, skill: null, toolLine: null };
  fresh.n = 2;
  assert.match(readLoopNudge(fresh, 'read_skill', { path: 'cyberchef/base64-encode', text: '1. call_tool tool=cyberchef.bake recipe=<recipe> input=<input>' }), /recipe=<recipe> input=<input>/);
  const noslash = { n: 0, skill: null, toolLine: null };
  noslash.n = 2;
  assert.match(readLoopNudge(noslash, 'read_skill', { path: 'the skill', text: '1. call_tool tool=desktop.open_app app=<app>' }), /app=<app>/);
});

test('discoveryNextLine: the skill step, else the top find_tool call line, else the generic call_tool form', () => {
  assert.equal(discoveryNextLine({ n: 8, skill: { path: 'docs/x', line: 'call_tool tool=docs.find_replace find=<find> replace=<replace>' }, toolLine: 'call_tool tool=a.b' }), 'call_tool tool=docs.find_replace find=<find> replace=<replace>');
  assert.equal(discoveryNextLine({ n: 8, skill: null, toolLine: 'call_tool tool=gridcraft.create_sheet' }), 'call_tool tool=gridcraft.create_sheet');
  assert.match(discoveryNextLine({ n: 8, skill: null, toolLine: null }), /^call_tool tool=/);
});

test('the agent round cap is 28: a model that keeps searching runs exactly 28 rounds, the last answer-only', async () => {
  const { session, seen } = setup(new Array(40).fill(call('find_tool', { query: 'gridcraft' })));
  await session.send('Find the gridcraft tools');
  // 28 rounds; the final answer-only round comes back empty (the model still emits call syntax,
  // which is invisible), so A27 (2) adds exactly one nudge retry - 29 generate calls.
  assert.equal(seen.prompts.length, 29, 'agent mode runs 28 rounds plus the one empty-reply retry');
  assert.deepEqual(seen.schemas[27], [], 'the final round is answer-only');
  assert.deepEqual(seen.schemas[28], [], 'the retry is answer-only too');
  assert.match(seen.prompts[28].at(-1).content, /Answer the user now in one or two sentences/);
  assert.match(session.history.filter(m => m.role === 'assistant').at(-1).content, /no visible answer/);
});

test('stopMessage names the earlier error and its fix when a failing call is repeated', () => {
  // terminal-08: a tool-level success whose command exited nonzero stops with the shell's error
  assert.equal(stopMessage({ ok: true, tool: 'terminal.run', result: { exitCode: 127, output: '/bin/sh: seds/8080/9090/: not found\n' } }),
    'Stopped: this exact call already failed twice (the command exited with code 127: /bin/sh: seds/8080/9090/: not found). Change the arguments (describe_tool lists them) or try another tool.');
  const failed = { ok: false, error: { type: 'unknown_argument', message: 'deckcraft.add_slide has no parameter title', fix: 'call_tool tool=deckcraft.add_slide layout=<layout>' } };
  assert.equal(stopMessage(failed), 'Stopped: this exact call already failed twice (deckcraft.add_slide has no parameter title). Change it: call_tool tool=deckcraft.add_slide layout=<layout>');
  assert.match(stopMessage({ error: 'Unknown tool x' }), /failed twice \(Unknown tool x\)\. Change the arguments/);
  // media-08: a call repeated after a stop carries the earlier stop message as its error -
  // the un-nesting loop must leave one clean message, not stacked ones.
  assert.equal(stopMessage({ error: 'Stopped: this exact call already failed twice (Stopped: this exact call already failed twice (That file or folder does not exist.). Change the arguments (describe_tool lists them) or try another tool.). Change the arguments (describe_tool lists them) or try another tool.' }),
    'Stopped: this exact call already failed twice (That file or folder does not exist.). Change the arguments (describe_tool lists them) or try another tool.');
});

test('priorFailed: tool errors and nonzero shell exits fail; a successful run does not', () => {
  assert.equal(priorFailed(undefined), false);
  assert.equal(priorFailed({ ok: true, result: { exitCode: 0, output: '110\n' } }), false, 'terminal-10: a successful repeat runs again');
  assert.equal(priorFailed({ ok: true, result: { exitCode: 127, output: 'nope\n' } }), true, 'terminal-08: the shell exit decides');
  assert.equal(priorFailed({ error: 'Unknown tool x' }), true);
  assert.equal(priorFailed({ ok: false, error: { type: 'not_found' } }), true);
});

/** beepbox-03: the agent opened Media while BeepBox was the only window on screen. */
test('windowsLine lists the visible windows, active first, and is empty with none', () => {
  const wins = [{ id: 'files', title: 'Files', state: 'normal', active: false }, { id: 'beepbox', title: 'BeepBox', state: 'normal', active: true }, { id: 'media', title: 'Media Player', state: 'minimized', active: false }];
  assert.equal(windowsLine(wins), 'On screen: BeepBox (beepbox, active), Files (files). A request that names no app is about these.');
  assert.equal(windowsLine([]), '');
  assert.equal(windowsLine(null), '');
});

test('the turn note names the windows on screen, so an unnamed request acts on the open app', async () => {
  const { session, seen } = setup(['Playing it now.']);
  session.host = () => ({ windows: async () => [{ id: 'beepbox', title: 'BeepBox', state: 'normal', active: true }] });
  await session.send('Play the song in my editor');
  assert.match(seen.prompts[0].at(-1).content, /On screen: BeepBox \(beepbox, active\)/);
  assert.doesNotMatch(session.history.find(m => m.role === 'user').content, /On screen/, 'the note is never stored');
});

/** gridcraft-01: lfm3-1.7b invented find_skill and find_skill_index and lost a round on each. */
test('metaAlias maps an invented meta tool name to the one it means, and nothing else', () => {
  assert.equal(metaAlias('find_skill'), 'lookup_skill_index');
  assert.equal(metaAlias('find_skill_index'), 'lookup_skill_index');
  assert.equal(metaAlias('read_skill_text'), 'read_skill');
  assert.equal(metaAlias('search_tools'), 'find_tool');
  assert.equal(metaAlias('tool_info'), 'describe_tool');
  assert.equal(metaAlias('run_tool'), 'call_tool');
  assert.equal(metaAlias('open_app'), null);
  // gridcraft-01 (build 10): find_skill path=... is a read, not a search.
  assert.equal(metaAlias('find_skill', { path: 'gridcraft/build-a-budget-with-formula-columns' }), 'read_skill');
  assert.equal(metaAlias('find_skill', { query: 'budget' }), 'lookup_skill_index');
});

test('an invented meta tool name runs the meant meta tool and says so', async () => {
  const { session } = setup([call('find_skill', { query: 'open an app' }), 'Done.']);
  await session.send('Open GridCraft');
  const first = toolMessages(session)[0];
  assert.ok(Array.isArray(first.hits), JSON.stringify(first));
  assert.match(first.note, /There is no find_skill; this ran lookup_skill_index/);
});
