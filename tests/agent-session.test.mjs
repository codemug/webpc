// Agent mode end to end with a scripted model: the real generated catalog, skills and indexes
// (npm test runs `npm run catalog` first), the real meta tools, repairs and executor, and fake
// desktop and Files hosts that record what Buddy asked them to do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentSession, nextStepFor } from '../src/apps/ai-agent/session.js';
import { createAgent, createPolicy, META_TOOL_NAMES } from '../src/apps/ai-agent/runtime/index.mjs';

const call = (name, args) => `<tool_call><function=${name}>${Object.entries(args).map(([k, v]) => `<parameter=${k}>${v}</parameter>`).join('')}</function></tool_call>`;
function setup(outputs, { approve = async () => true } = {}) {
  const seen = { prompts: [], schemas: [], host: [], files: [], approvals: [] };
  const client = { ready: true, stop() {}, count: async () => 100, generate: async (messages, schemas) => { seen.prompts.push(messages); seen.schemas.push(schemas); return outputs.shift() ?? 'Done.'; } };
  const record = (name, value) => async (...args) => { seen.host.push([name, ...args]); return value; };
  const host = { open: record('open', { id: 'gridcraft', opened: true }), close: record('close', { closed: true }), setTheme: record('setTheme', 'dark'), apps: record('apps', []), windows: record('windows', []) };
  const filesCtx = { mkdir: async path => { seen.files.push(['mkdir', path]); return { path }; }, remove: async (path, opts) => { seen.files.push(['remove', path, opts]); return { path, removed: true }; } };
  const session = new AgentSession({
    client, store: { save: async () => {} }, webSearch: async () => ({ results: [] }), httpGet: async () => ({}), runJavaScript: async () => ({ result: 42 }),
    agent: createAgent(), host: () => host, filesCtx, approve: async request => { seen.approvals.push(request); return approve(request); },
  });
  return { session, seen };
}
const toolMessages = session => session.history.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));

test('the model sees only the six meta tools and an agent system prompt with the app list', async () => {
  const { session, seen } = setup(['Hello!']);
  await session.send('Hi Buddy');
  assert.deepEqual(seen.schemas[0].map(s => s.function.name), META_TOOL_NAMES);
  const system = seen.prompts[0][0].content;
  assert.match(system, /You are Buddy/);
  assert.match(system, /Apps: .*gridcraft \(GridCraft\)/);
  assert.doesNotMatch(system, /desktop\.open_app/);
});

test('prefetch puts the best skill in the prompt but never in the saved history', async () => {
  const { session, seen } = setup([call('call_tool', { tool: 'desktop.open_app', app: 'gridcraft' }), 'GridCraft is open.']);
  await session.send('Open GridCraft');
  const user = seen.prompts[0].at(-1).content;
  assert.match(user, /Note: matching skill .* Steps \(fill each <placeholder> with the user's own values\):\n1\. call_tool tool=desktop\.open_app app=<app>/);
  assert.doesNotMatch(session.history.find(m => m.role === 'user').content, /Note:/);
  assert.deepEqual(seen.host[0], ['open', 'gridcraft']);
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
  assert.deepEqual(seen.host.map(h => h.slice(0, 2)), [['open', 'gridcraft'], ['close', 'docs']]);
  const results = toolMessages(session);
  assert.ok(results.every(r => r.ok), JSON.stringify(results));
  assert.ok(results[0].repaired?.length, 'the model is told what was repaired');
});

test('a destructive tool asks first; a refusal comes back as needs_approval_denied', async () => {
  const { session, seen } = setup([call('call_tool', { tool: 'files.delete', path: '/Old' }), 'OK, I left it.'], { approve: async () => false });
  await session.send('Delete the Old folder');
  assert.equal(seen.approvals.length, 1);
  assert.match(seen.approvals[0].preview, /files\.delete path=\/Old/);
  assert.equal(seen.files.length, 0);
  assert.equal(toolMessages(session)[0].error.type, 'needs_approval_denied');
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
  assert.match(agent.prefetch('What is 6 times 7?'), /system\.calculate|Work out a sum/);
  assert.doesNotMatch(agent.prefetch('What is 6 times 7?'), /see-what-is-open/);
  assert.equal(agent.prefetch('zzz qqq'), '');
});

test('with the real policy, a cloud model cannot touch ungranted Files and a web read taints later changes', async () => {
  const outputs = [call('call_tool', { tool: 'files.mkdir', path: '/Secret' }), 'Done.'];
  const { session, seen } = setup(outputs);
  session.agent = createAgent({ policy: createPolicy({ backend: 'cloud', grants: ['/Shared'] }) });
  await session.send('Make a folder called Secret');
  assert.equal(seen.files.length, 0);
  assert.equal(toolMessages(session)[0].error.type, 'not_allowed');
  const policy = createPolicy({ backend: 'local' }); const turn = policy.newTurn('read this page');
  policy.noteResult({ name: 'system.http_get', effect: 'read', untrusted: true }, { url: 'https://example.com/' }, turn);
  assert.equal(policy.decide({ name: 'desktop.open_app', effect: 'change', purpose: 'Open an app window.' }, { app: 'docs' }, turn).action, 'ask');
});

test('a generic run_command that deletes asks first, through the tool effectFor', async () => {
  const { session, seen } = setup([call('call_tool', { tool: 'gridcraft.run_command', command: 'sheet.delete', params: 'sheet=Sheet2' }), 'OK.'], { approve: async () => false });
  const sent = [];
  session.craft = async () => ({ commands: async () => [{ id: 'sheet.delete', label: 'Delete sheet', params: '{sheet}' }], execute: async (...a) => { sent.push(a); return {}; } });
  await session.send('Delete Sheet2 in GridCraft');
  assert.equal(seen.approvals.length, 1);
  assert.equal(sent.length, 0);
  assert.equal(toolMessages(session)[0].error.type, 'needs_approval_denied');
});

test('lookup_skill_index: "open LightCraft" never ranks another app\'s skill above the named app or the general packs (eval M6, B17)', async () => {
  const { createAgent } = await import('../src/apps/ai-agent/runtime/index.mjs');
  const { hits } = await createAgent().metaTools.lookup_skill_index.run({ query: 'open LightCraft' });
  const packs = hits.map(h => h.path.split('/')[0]);
  const firstOther = packs.findIndex(p => !['lightcraft', 'system', 'desktop', 'files'].includes(p));
  if (firstOther >= 0) assert.ok(packs.slice(firstOther).every(p => !['lightcraft', 'system', 'desktop', 'files'].includes(p)), JSON.stringify(hits.map(h => h.path)));
  assert.ok(['lightcraft', 'desktop'].includes(packs[0]), JSON.stringify(hits.map(h => h.path)));
});

test('a repeated lookup_skill_index call gets a teaching repeated error with the read_skill fix on the second call', async () => {
  const { session } = setup([
    call('lookup_skill_index', { query: 'list all apps on my PC' }),
    call('lookup_skill_index', { query: 'list all apps on my PC' }),
    'Done.',
  ]);
  await session.send('What apps are on my PC?');
  const [first, second] = toolMessages(session);
  assert.ok(first.hits.length > 0, 'the first lookup ran and found hits');
  assert.equal(second.ok, false);
  assert.equal(second.error.type, 'repeated');
  assert.match(second.error.message, /You already searched for this/);
  assert.equal(second.error.fix, `read_skill path=${first.hits[0].path}`);
});

test('a repeated find_tool call repeats the first hit call line as the fix', async () => {
  const { session } = setup([
    call('find_tool', { query: 'list apps' }),
    call('find_tool', { query: 'list apps' }),
    'Done.',
  ]);
  await session.send('What apps are on my PC?');
  const [first, second] = toolMessages(session);
  assert.ok(first.hits.length > 0, 'the first find_tool ran and found hits');
  assert.equal(second.error.type, 'repeated');
  assert.match(second.error.message, /You already found these tools/);
  assert.equal(second.error.fix, first.hits[0].call);
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

test('nextStepFor points each repeated meta tool at its next step, or the plain message, and is null for other tools', () => {
  assert.deepEqual(nextStepFor('lookup_skill_index', { hits: [{ path: 'desktop/find-the-right-app', title: 't', summary: 's' }] }),
    { message: 'You already searched for this. Read the best match next.', fix: 'read_skill path=desktop/find-the-right-app' });
  assert.deepEqual(nextStepFor('find_tool', { hits: [{ tool: 'desktop.list_apps', does: 'd', call: 'call_tool tool=desktop.list_apps' }] }),
    { message: 'You already found these tools. Call the best one next.', fix: 'call_tool tool=desktop.list_apps' });
  assert.deepEqual(nextStepFor('describe_tool', { tool: 'desktop.list_apps', text: 'desktop.list_apps - List apps\nParams:\nEffect: read\nCall: call_tool tool=desktop.list_apps\nSkills: desktop/see-what-is-open' }),
    { message: "You already have this tool's call. Make the call next.", fix: 'call_tool tool=desktop.list_apps' });
  assert.deepEqual(nextStepFor('read_skill', { path: 'desktop/open-an-app', text: 'Open an app\nSteps:\n1. call_tool tool=desktop.open_app app=<app>\nCheck: desktop.list_windows shows it.' }),
    { message: 'You already read this skill. Do its first step next.', fix: 'call_tool tool=desktop.open_app app=<app>' });
  assert.deepEqual(nextStepFor('find_in_skill', { hits: [{ section: 'Steps', line: '1. call_tool tool=desktop.focus app=docs', excerpt: 'e' }] }),
    { message: 'You already read this skill. Do its first step next.', fix: 'call_tool tool=desktop.focus app=docs' });
  for (const [name, earlier] of [
    ['lookup_skill_index', { hits: [] }],
    ['find_tool', { hits: [], note: 'No tool matches. Try lookup_skill_index.' }],
    ['describe_tool', { ok: false, error: { type: 'unknown_tool', message: 'unknown tool' } }],
    ['read_skill', { ok: false, error: { type: 'unknown_skill', message: 'unknown skill path' } }],
    ['find_in_skill', { hits: [] }],
  ]) {
    const step = nextStepFor(name, earlier);
    assert.equal(step.fix, undefined, name);
    assert.match(step.message, /You already did this/);
  }
  assert.equal(nextStepFor('call_tool', { hits: [{ path: 'a/b' }] }), null);
  assert.equal(nextStepFor('desktop.list_apps', { hits: [{ path: 'a/b' }] }), null);
});

