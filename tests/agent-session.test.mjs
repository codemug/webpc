// Agent mode end to end with a scripted model: the real generated catalog, skills and indexes
// (npm test runs `npm run catalog` first), the real meta tools, repairs and executor, and fake
// desktop and Files hosts that record what Buddy asked them to do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentSession, repeatNote, searchLoopNote, stopMessage, windowsLine, metaAlias } from '../src/apps/ai-agent/session.js';
import { createAgent, META_TOOL_NAMES } from '../src/apps/ai-agent/runtime/index.mjs';

const call = (name, args) => `<tool_call><function=${name}>${Object.entries(args).map(([k, v]) => `<parameter=${k}>${v}</parameter>`).join('')}</function></tool_call>`;
function setup(outputs) {
  const seen = { prompts: [], schemas: [], host: [], files: [] };
  const client = { ready: true, stop() {}, count: async () => 100, generate: async (messages, schemas) => { seen.prompts.push(messages); seen.schemas.push(schemas); return outputs.shift() ?? 'Done.'; } };
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

test('a repeated non-meta call still runs twice and stops at the third, as before', async () => {
  const { session } = setup([
    call('calculate', { expression: '6*7' }),
    call('calculate', { expression: '6*7' }),
    call('calculate', { expression: '6*7' }),
    'Done.',
  ]);
  await session.send('What is 6 times 7?');
  const [one, two, three] = toolMessages(session);
  assert.equal(one.ok, true);
  assert.equal(two.ok, true);
  assert.equal(three.error, 'Repeated tool call stopped. Answer from the available information.');
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

test('stopMessage names the earlier error and its fix when a failing call is repeated', () => {
  assert.equal(stopMessage({ ok: true }), 'Repeated tool call stopped. Answer from the available information.');
  const failed = { ok: false, error: { type: 'unknown_argument', message: 'deckcraft.add_slide has no parameter title', fix: 'call_tool tool=deckcraft.add_slide layout=<layout>' } };
  assert.equal(stopMessage(failed), 'Stopped: this exact call already failed twice (deckcraft.add_slide has no parameter title). Change it: call_tool tool=deckcraft.add_slide layout=<layout>');
  assert.match(stopMessage({ error: 'Unknown tool x' }), /failed twice \(Unknown tool x\)\. Change the arguments/);
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
});

test('an invented meta tool name runs the meant meta tool and says so', async () => {
  const { session } = setup([call('find_skill', { query: 'open an app' }), 'Done.']);
  await session.send('Open GridCraft');
  const first = toolMessages(session)[0];
  assert.ok(Array.isArray(first.hits), JSON.stringify(first));
  assert.match(first.note, /There is no find_skill; this ran lookup_skill_index/);
});
