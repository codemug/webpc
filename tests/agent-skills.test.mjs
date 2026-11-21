// Unit tests for the Buddy M1 skills module (src/apps/ai-agent/runtime/skills.mjs):
// parsing skills.md (multi-skill files, metadata, slugs, steps with quoted values, spaces
// and escaped newlines), checking skills against the tool catalog (with the args checker
// injected as a stub, since args.mjs belongs to another lane), and capped rendering.
// Run: node --test tests/agent-skills.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSkills, checkSkills, renderSkill } from '../src/apps/ai-agent/runtime/skills.mjs';

// A clean two-skill file: the first follows the plan example, the second has no Gotchas.
const MD = [
  '# GridCraft pack skills (a note above the first skill, ignored by the parser)',
  '',
  '## Make a chart from a range',
  'slug: chart-from-range',
  'summary: Select data in GridCraft and insert a chart of it.',
  'keywords: chart, graph, plot, visualise, bar, line',
  'tools: desktop.open_app, gridcraft.select, gridcraft.insert_chart',
  '',
  'When: the user wants a chart of numbers that are in the open sheet.',
  'Steps:',
  '1. call_tool tool=desktop.open_app app=gridcraft',
  '2. call_tool tool=gridcraft.select range=A1:B6',
  '3. call_tool tool=gridcraft.insert_chart kind=bar',
  'Check: gridcraft.inspect shows a chart on the sheet.',
  'Gotchas: a chart needs a header row; without one, add it with gridcraft.set_cells first.',
  '',
  '## Open a file in an app',
  'slug: open-file',
  'summary: Pick the right app and open a file with it.',
  'keywords: open, file, app',
  'tools: desktop.open_app, files.read',
  '',
  'When: the user names a file and an app to use.',
  'Steps:',
  '1. call_tool tool=desktop.open_app app=docs',
  '2. call_tool tool=files.read path=/notes/todo.md note=fill in the values',
  'Check: the file is visible in the app window.'
].join('\n');

// Value-parsing edge cases: a quoted value holding " x=", and an escaped newline.
const EDGE_MD = [
  '## Edge values',
  'slug: edge-values',
  'summary: Values with spaces, quotes and escaped newlines.',
  'keywords: edge',
  'tools: gridcraft.set_cells',
  '',
  'When: testing value parsing.',
  'Steps:',
  '1. call_tool tool=gridcraft.set_cells start=A1 note="values with spaces x=1" mode=dark',
  '2. call_tool tool=gridcraft.set_cells start=B2 text=line one\\nline two',
  'Check: done.'
].join('\n');

const TOOLS = new Map([
  ['desktop.open_app', { name: 'desktop.open_app' }],
  ['gridcraft.select', { name: 'gridcraft.select' }],
  ['gridcraft.insert_chart', { name: 'gridcraft.insert_chart' }],
  ['gridcraft.set_cells', { name: 'gridcraft.set_cells' }],
  ['files.read', { name: 'files.read' }]
]);
const toolByName = (name) => TOOLS.get(name);
// Stub for the args.mjs checkArgs contract: (tool, args) -> { ok, args } | { ok: false, error }.
const okArgs = (tool, args) => ({ ok: true, args });
const pickyArgs = (tool, args) => (args.app === 'docs'
  ? { ok: false, error: "app 'docs' is not an app id; did you mean documents?" }
  : { ok: true, args });
const mkSkill = (over) => ({
  path: 'gridcraft/test', slug: 'test', title: 'Test', summary: 'A short summary.',
  keywords: [], tools: [], when: 'w', steps: [], check: 'c', gotchas: '', body: 'b', ...over
});

test('parse: a clean multi-skill file gives one skill per "## " heading, no errors', () => {
  const out = parseSkills(MD, 'gridcraft');
  assert.equal(out.errors.length, 0, JSON.stringify(out.errors));
  assert.equal(out.skills.length, 2);
  assert.deepEqual(out.skills.map(s => s.path), ['gridcraft/chart-from-range', 'gridcraft/open-file']);
  assert.equal(out.skills[1].gotchas, '', 'a missing Gotchas section is empty, not an error');
});

test('parse: the first skill carries every field, body is the raw markdown', () => {
  const skill = parseSkills(MD, 'gridcraft').skills[0];
  assert.equal(skill.slug, 'chart-from-range');
  assert.equal(skill.title, 'Make a chart from a range');
  assert.equal(skill.summary, 'Select data in GridCraft and insert a chart of it.');
  assert.deepEqual(skill.keywords, ['chart', 'graph', 'plot', 'visualise', 'bar', 'line']);
  assert.deepEqual(skill.tools, ['desktop.open_app', 'gridcraft.select', 'gridcraft.insert_chart']);
  assert.equal(skill.when, 'the user wants a chart of numbers that are in the open sheet.');
  assert.equal(skill.check, 'gridcraft.inspect shows a chart on the sheet.');
  assert.ok(skill.gotchas.startsWith('a chart needs a header row'));
  assert.ok(skill.body.includes('slug: chart-from-range'), 'body keeps the raw markdown');
  assert.equal(skill.steps.length, 3);
});

test('parse: a step line gives n, tool, args and the original line', () => {
  const skill = parseSkills(MD, 'gridcraft').skills[0];
  assert.deepEqual(skill.steps[1], {
    n: 2, tool: 'gridcraft.select', args: { range: 'A1:B6' }, line: '2. call_tool tool=gridcraft.select range=A1:B6'
  });
  assert.deepEqual(skill.steps[0].args, { app: 'gridcraft' });
});

test('parse: an unquoted value runs until the next " word=" and keeps its spaces', () => {
  const skill = parseSkills(MD, 'gridcraft').skills[1];
  assert.deepEqual(skill.steps[1].args, { path: '/notes/todo.md', note: 'fill in the values' });
});

test('parse: a quoted value may hold " x=" text, and the next key still parses', () => {
  const skill = parseSkills(EDGE_MD, 'gridcraft').skills[0];
  assert.deepEqual(skill.steps[0].args, { start: 'A1', note: 'values with spaces x=1', mode: 'dark' });
});

test('parse: a backslash-n inside a value becomes a real newline', () => {
  const skill = parseSkills(EDGE_MD, 'gridcraft').skills[0];
  assert.equal(skill.steps[1].args.text, 'line one\nline two');
});

test('parse: a missing metadata line is an error, the skill is still returned', () => {
  const md = [
    '## No tools line', 'slug: no-tools', 'summary: A skill missing its tools line.', 'keywords: x', '',
    'When: w.', 'Steps:', '1. call_tool tool=gridcraft.set_cells start=A1', 'Check: c.'
  ].join('\n');
  const out = parseSkills(md, 'gridcraft');
  assert.equal(out.skills.length, 1);
  assert.ok(out.errors.some(e => e.includes("missing metadata 'tools'")), JSON.stringify(out.errors));
  assert.equal(out.skills[0].tools.length, 0);
});

test('parse: a bad slug is an error, and so is each missing required metadata line', () => {
  const md = [
    '## Bad slug', 'slug: Bad Slug!', 'summary: s', 'keywords: k', 'tools: gridcraft.set_cells', '',
    'When: w.', 'Steps:', '1. call_tool tool=gridcraft.set_cells start=A1', 'Check: c.'
  ].join('\n');
  const out = parseSkills(md, 'gridcraft');
  assert.ok(out.errors.some(e => e.includes('invalid slug')), JSON.stringify(out.errors));
  assert.equal(out.skills[0].slug, 'Bad Slug!');
  const missing = [
    '## No meta', 'slug: no-meta', 'keywords: k', 'tools: gridcraft.set_cells', '',
    'When: w.', 'Steps:', '1. call_tool tool=gridcraft.set_cells start=A1', 'Check: c.'
  ].join('\n');
  const missingOut = parseSkills(missing, 'gridcraft');
  assert.ok(missingOut.errors.some(e => e.includes("missing metadata 'summary'")), JSON.stringify(missingOut.errors));
});

test('parse: duplicate slugs in one pack are an error, both skills are returned', () => {
  const one = (title, start) => [
    `## ${title}`, 'slug: dup', 'summary: s', 'keywords: k', 'tools: gridcraft.set_cells', '',
    'When: w.', 'Steps:', `1. call_tool tool=gridcraft.set_cells start=${start}`, 'Check: c.'
  ].join('\n');
  const out = parseSkills(`${one('First', 'A1')}\n\n${one('Second', 'A2')}`, 'gridcraft');
  assert.equal(out.skills.length, 2);
  assert.ok(out.errors.some(e => e.includes('duplicate slug "dup"')), JSON.stringify(out.errors));
});

test('parse: a line that is not a call_tool step is an error and drops out of steps', () => {
  const md = [
    '## Bad step', 'slug: bad-step', 'summary: s', 'keywords: k', 'tools: gridcraft.set_cells', '',
    'When: w.', 'Steps:', '1. not a call_tool line', 'Check: c.'
  ].join('\n');
  const out = parseSkills(md, 'gridcraft');
  assert.ok(out.errors.some(e => e.includes('bad step line')), JSON.stringify(out.errors));
  assert.equal(out.skills[0].steps.length, 0);
});

test('parse: When, Steps and Check are required, Gotchas is not', () => {
  const md = [
    '## No sections', 'slug: no-sections', 'summary: s', 'keywords: k', 'tools: gridcraft.set_cells', '',
    'Steps:', '1. call_tool tool=gridcraft.set_cells start=A1'
  ].join('\n');
  const out = parseSkills(md, 'gridcraft');
  assert.ok(out.errors.some(e => e.includes("missing section 'When'")), JSON.stringify(out.errors));
  assert.ok(out.errors.some(e => e.includes("missing section 'Check'")), JSON.stringify(out.errors));
  assert.ok(!out.errors.some(e => e.includes('Gotchas')), 'no error for the optional Gotchas');
});

test('checkSkills: unknown tools are reported in steps and in the tools metadata', () => {
  const bad = mkSkill({
    path: 'gridcraft/bad', tools: ['gridcraft.missing_tool'],
    steps: [{ n: 1, tool: 'gridcraft.ghost', args: {}, line: '1. call_tool tool=gridcraft.ghost' }]
  });
  const errors = checkSkills([bad], toolByName);
  assert.ok(errors.some(e => e.includes('unknown tool gridcraft.missing_tool in tools')), JSON.stringify(errors));
  assert.ok(errors.some(e => e.includes('unknown tool gridcraft.ghost in step 1')), JSON.stringify(errors));
  assert.equal(errors.length, 2);
});

test('checkSkills: step args failing the injected checkArgs become errors, passing ones do not', () => {
  const skills = parseSkills(MD, 'gridcraft').skills;
  assert.equal(checkSkills(skills, toolByName, { checkArgs: okArgs }).length, 0);
  const errors = checkSkills(skills, toolByName, { checkArgs: pickyArgs });
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.ok(errors[0].includes('step 1 desktop.open_app'), errors[0]);
  assert.ok(errors[0].includes("app 'docs' is not an app id"), errors[0]);
});

test('checkSkills: a body over 1500 and a summary over 160 are errors, at the limit they are not', () => {
  const at = mkSkill({ body: 'x'.repeat(1500), summary: 'y'.repeat(160) });
  assert.equal(checkSkills([at], toolByName).length, 0);
  const over = mkSkill({ body: 'x'.repeat(1501), summary: 'y'.repeat(161) });
  const errors = checkSkills([over], toolByName);
  assert.ok(errors.some(e => e.includes('body is 1501 characters')), JSON.stringify(errors));
  assert.ok(errors.some(e => e.includes('summary is 161 characters')), JSON.stringify(errors));
});

test('renderSkill: the full render has the title, every section and the step lines, no note', () => {
  const skill = parseSkills(MD, 'gridcraft').skills[0];
  const out = renderSkill(skill);
  for (const needle of [
    'Make a chart from a range', 'Select data in GridCraft and insert a chart of it.',
    'When:', 'the user wants a chart', 'Steps:',
    '1. call_tool tool=desktop.open_app app=gridcraft',
    '3. call_tool tool=gridcraft.insert_chart kind=bar', 'Check:', 'Gotchas:'
  ]) assert.ok(out.includes(needle), 'missing: ' + needle);
  assert.ok(!out.includes('(more'), 'no cap note when the text fits');
  const plain = renderSkill(parseSkills(MD, 'gridcraft').skills[1]);
  assert.ok(!plain.includes('Gotchas:'), 'a skill without Gotchas renders no Gotchas header');
});

test('renderSkill: a section renders only that section, names are case-insensitive', () => {
  const skill = parseSkills(MD, 'gridcraft').skills[0];
  const out = renderSkill(skill, 'steps');
  assert.ok(out.startsWith('Steps:'), out.slice(0, 20));
  assert.ok(out.includes('2. call_tool tool=gridcraft.select range=A1:B6'));
  assert.ok(!out.includes('When:'), 'no other section leaks in');
  assert.equal(renderSkill(skill, 'STEPS'), out);
  assert.equal(renderSkill(skill, 'bogus'), '', 'an unknown section renders empty');
});

test('renderSkill: over the cap the text is cut and the note names the cut sections', () => {
  const long = mkSkill({
    path: 'gridcraft/long', when: 'w'.repeat(2000), check: 'c'.repeat(400),
    steps: [{ n: 1, tool: 'gridcraft.set_cells', args: {}, line: '1. call_tool tool=gridcraft.set_cells start=A1' }]
  });
  const out = renderSkill(long);
  assert.ok(out.length <= 1800, `length ${out.length}`);
  assert.ok(out.includes('(more: sections'), out.slice(-120));
  assert.ok(out.endsWith('find_in_skill)'), 'the note offers find_in_skill');
  assert.ok(out.includes('Steps'), 'a section cut by the cap is named in the note');
  const small = renderSkill(long, undefined, 300);
  assert.ok(small.length <= 300, `length ${small.length}`);
  assert.ok(small.includes('(more:'), 'the custom cap cuts too');
});

test('renderSkill: a single over-cap section caps with the plain note, and renders are deterministic', () => {
  const skill = parseSkills(MD, 'gridcraft').skills[0];
  const short = renderSkill(skill, 'when', 40);
  assert.ok(short.length <= 40, `length ${short.length}`);
  assert.ok(short.endsWith('\n(more: or find_in_skill)'), short);
  assert.equal(renderSkill(skill), renderSkill(skill), 'the same inputs render the same text');
  const a = parseSkills(MD, 'gridcraft');
  const b = parseSkills(MD, 'gridcraft');
  assert.deepEqual(b.skills, a.skills, 'parsing is deterministic');
});
