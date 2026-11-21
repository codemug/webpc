// Unit tests for the PdfCraft pack: agent/apps/pdfcraft/tools.js and skills.md.
// A fake ctx.craft records calls; every tool must send the exact engine command id and wire
// params that storytold/pdfcraft@v0.21.1 crates/automation/src/tools.rs dispatches (.cmd() table).
// The schema and skills checks reuse the real runtime validators, with the choices function
// that scripts/agent/build.mjs builds the catalog with.
// Run: node --test tests/agent-pack-pdfcraft.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack, tools, usesCommands, usesMethods } from '../agent/apps/pdfcraft/tools.js';
import { tools as desktopTools } from '../agent/desktop/tools.js';
import { ToolError, specErrors, checkArgs, callLine } from '../src/apps/ai-agent/runtime/args.mjs';
import { parseSkills, checkSkills } from '../src/apps/ai-agent/runtime/skills.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_MD = readFileSync(join(HERE, '..', 'agent', 'apps', 'pdfcraft', 'skills.md'), 'utf8');
const APP_IDS = ['pdfcraft'];
const choices = name => (name === 'apps' ? APP_IDS : []);
const byName = name => tools.find(tool => tool.name === name) ?? desktopTools.find(tool => tool.name === name);

// The live command list, shaped like the craft-web-api commands() reply.
const COMMANDS = [
  { id: 'file.properties', label: 'Document Properties', menu: 'File', params: 'doc', shortcut: '', enabled: true },
  { id: 'page.rotate', label: 'Rotate Pages', menu: 'Page', params: 'doc, degrees', shortcut: '', enabled: true },
  { id: 'page.delete', label: 'Delete Pages', menu: 'Page', params: 'doc, pages', shortcut: '', enabled: true },
  { id: 'edit.find', label: 'Find Text', menu: 'Edit', params: 'doc, query', shortcut: '', enabled: true },
  { id: 'file.save', label: 'Save', menu: 'File', params: 'doc', shortcut: '', enabled: true },
];
// A fake app API at the ctx.craft level, recording the unified calls the tools make.
const fakeCraft = () => {
  const calls = [];
  const rec = (name, make = () => ({})) => (...args) => { calls.push([name, ...args]); return Promise.resolve(make(...args)); };
  return {
    calls,
    request: rec('request', (method, params) => ({ method, params })),
    execute: rec('execute', (command, params) => ({ command, params })),
    commands: rec('commands', () => COMMANDS),
    inspect: rec('inspect', () => ({ document: 'report.pdf', pages: 3 })),
    screenshot: rec('screenshot', () => 'png-base64'),
  };
};
const runTool = (name, args, craft) => byName(name).run(args, { host: {}, craft: () => Promise.resolve(craft) });

test('the pack declares its id, title and live-check exports', () => {
  assert.deepEqual(pack, { id: 'pdfcraft', title: 'PdfCraft' });
  assert.deepEqual(usesCommands.sort(), ['edit.find', 'edit.link', 'edit.redo', 'edit.replace', 'edit.text', 'edit.undo', 'file.close', 'file.properties', 'file.save', 'file.word_count', 'page.delete', 'page.duplicate', 'page.insert_blank', 'page.reverse', 'page.rotate'].sort());
  assert.deepEqual(usesMethods, []);
});

test('the pack exposes exactly the 18 pdfcraft tools', () => {
  assert.equal(tools.length, 18);
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'pdfcraft.command_list', 'pdfcraft.doc_close', 'pdfcraft.doc_info', 'pdfcraft.doc_inspect',
    'pdfcraft.doc_save', 'pdfcraft.edit_redo', 'pdfcraft.edit_undo', 'pdfcraft.link_add',
    'pdfcraft.page_add_text', 'pdfcraft.page_delete', 'pdfcraft.page_duplicate', 'pdfcraft.page_insert_blank',
    'pdfcraft.page_reverse', 'pdfcraft.page_rotate', 'pdfcraft.run_command', 'pdfcraft.text_find',
    'pdfcraft.text_replace', 'pdfcraft.text_word_count',
  ]);
});

test('every tool has the required text fields, effect, needs and examples', () => {
  for (const tool of tools) {
    assert.match(tool.name, /^pdfcraft\.[a-z0-9_]+$/);
    assert.ok(tool.purpose.length > 0 && tool.purpose.length <= 80, `${tool.name} purpose is ${tool.purpose.length} chars`);
    assert.ok(tool.when.startsWith('Use when'), `${tool.name} when must start with "Use when"`);
    assert.ok(tool.when.length <= 120, `${tool.name} when is ${tool.when.length} chars`);
    assert.ok(['read', 'change', 'destructive', 'external'].includes(tool.effect), `${tool.name} bad effect`);
    assert.deepEqual(tool.needs, ['host', 'app:pdfcraft']);
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

test('the effects follow the upstream destructive flags plus the close rule', () => {
  const reads = ['pdfcraft.doc_inspect', 'pdfcraft.doc_info', 'pdfcraft.text_word_count', 'pdfcraft.text_find', 'pdfcraft.command_list'];
  for (const name of reads) assert.equal(byName(name).effect, 'read', name);
  for (const name of ['pdfcraft.page_delete', 'pdfcraft.doc_close', 'pdfcraft.doc_save']) assert.equal(byName(name).effect, 'destructive', name);
  for (const tool of tools) if (!reads.includes(tool.name) && tool.effect !== 'destructive') assert.equal(tool.effect, 'change', tool.name);
});

test('pdfcraft.doc_inspect calls the adapter inspect (ui.state on the page)', async () => {
  const craft = fakeCraft();
  assert.deepEqual(await runTool('pdfcraft.doc_inspect', {}, craft), { document: 'report.pdf', pages: 3 });
  assert.deepEqual(craft.calls, [['inspect']]);
});

test('the read tools send their engine command ids with the doc param optional', async () => {
  const craft = fakeCraft();
  await runTool('pdfcraft.doc_info', { doc: 2 }, craft);
  await runTool('pdfcraft.doc_info', {}, craft);
  await runTool('pdfcraft.text_word_count', { pages: '1-2' }, craft);
  await runTool('pdfcraft.text_find', { query: 'invoice', limit: 10 }, craft);
  assert.deepEqual(craft.calls, [
    ['execute', 'file.properties', { doc: 2 }],
    ['execute', 'file.properties', {}],
    ['execute', 'file.word_count', { pages: '1-2' }],
    ['execute', 'edit.find', { query: 'invoice', limit: 10 }],
  ]);
});

test('the page tools send their engine command ids', async () => {
  const craft = fakeCraft();
  await runTool('pdfcraft.text_replace', { find: '2025', replace: '2026' }, craft);
  await runTool('pdfcraft.page_rotate', { degrees: 90 }, craft);
  await runTool('pdfcraft.page_reverse', { pages: '1-5' }, craft);
  await runTool('pdfcraft.page_insert_blank', { at: 2 }, craft);
  await runTool('pdfcraft.page_duplicate', { pages: '1', at: 3 }, craft);
  await runTool('pdfcraft.page_delete', { pages: '3' }, craft);
  await runTool('pdfcraft.edit_undo', {}, craft);
  await runTool('pdfcraft.edit_redo', {}, craft);
  await runTool('pdfcraft.doc_close', { discard_changes: true }, craft);
  await runTool('pdfcraft.doc_save', { flatten_fill_sign: true }, craft);
  assert.deepEqual(craft.calls, [
    ['execute', 'edit.replace', { find: '2025', replace: '2026' }],
    ['execute', 'page.rotate', { degrees: 90 }],
    ['execute', 'page.reverse', { pages: '1-5' }],
    ['execute', 'page.insert_blank', { at: 2 }],
    ['execute', 'page.duplicate', { pages: '1', at: 3 }],
    ['execute', 'page.delete', { pages: '3' }],
    ['execute', 'edit.undo', {}],
    ['execute', 'edit.redo', {}],
    ['execute', 'file.close', { discard_changes: true }],
    ['execute', 'file.save', { flatten_fill_sign: true }],
  ]);
});

test('page_add_text turns x and y into the at point of edit.text', async () => {
  const craft = fakeCraft();
  await runTool('pdfcraft.page_add_text', { page: 1, text: 'CONFIDENTIAL', x: 50, y: 50, size: 24, bold: true }, craft);
  assert.deepEqual(craft.calls, [['execute', 'edit.text', { page: 1, text: 'CONFIDENTIAL', size: 24, bold: true, at: [50, 50] }]]);
});

test('link_add coerces the flat rect to numbers and rejects a bad rect', async () => {
  const craft = fakeCraft();
  await runTool('pdfcraft.link_add', { page: 1, rect: ['50', '50', '200', '70'], url: 'https://example.com' }, craft);
  assert.deepEqual(craft.calls, [['execute', 'edit.link', { page: 1, url: 'https://example.com', rect: [50, 50, 200, 70] }]]);
  await assert.rejects(runTool('pdfcraft.link_add', { page: 1, rect: ['50', 'x', '200', '70'] }, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.match(error.message, /rect must be 4 numbers/);
    return true;
  });
});

test('pdfcraft.command_list returns the top 10 matches by id or label', async () => {
  const craft = fakeCraft();
  const byLabel = await runTool('pdfcraft.command_list', { query: 'rotate' }, craft);
  assert.deepEqual(byLabel, [{ id: 'page.rotate', label: 'Rotate Pages', menu: 'Page', params: 'doc, degrees' }]);
  const all = await runTool('pdfcraft.command_list', {}, craft);
  assert.equal(all.length, 5);
  assert.ok(!('enabled' in all[0]));
});

test('pdfcraft.run_command parses key=value lines with coercion and checks the id', async () => {
  const craft = fakeCraft();
  await runTool('pdfcraft.run_command', { command: 'page.rotate', params: 'degrees=180' }, craft);
  assert.deepEqual(craft.calls, [['commands'], ['execute', 'page.rotate', { degrees: 180 }]]);
});

test('pdfcraft.run_command rejects an unknown id with invalid_argument and the 3 closest', async () => {
  const craft = fakeCraft();
  await assert.rejects(runTool('pdfcraft.run_command', { command: 'page.rotat' }, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.match(error.message, /unknown command "page.rotat"; closest: page.rotate/);
    assert.equal(error.fix, callLine('pdfcraft.run_command', { command: 'page.rotate' }));
    return true;
  });
});

test('effectFor marks the destructive command ids for run_command', () => {
  const run = byName('pdfcraft.run_command');
  assert.equal(run.effectFor({ command: 'file.close' }), 'destructive');
  assert.equal(run.effectFor({ command: 'file.save' }), 'destructive');
  assert.equal(run.effectFor({ command: 'page.delete' }), 'destructive');
  assert.equal(run.effectFor({ command: 'page.rotate' }), 'change');
});

test('a disabled-right-now rejection (the no-document gate) becomes the teaching ToolError', async () => {
  const noDoc = () => Promise.reject(Object.assign(new Error('file.properties is disabled right now'), { code: 'app_error' })); // the adapter sets the code
  const craft = fakeCraft();
  craft.execute = () => noDoc();
  await assert.rejects(runTool('pdfcraft.doc_info', {}, craft), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    assert.equal(error.message, 'PDFCraft has no document open.');
    assert.equal(error.fix, 'Open a PDF in PDFCraft first');
    return true;
  });
  const runner = fakeCraft(); // the generic run_command path teaches the same way
  runner.execute = () => Promise.reject(Object.assign(new Error('page.rotate is disabled right now'), { code: 'app_error' }));
  await assert.rejects(runTool('pdfcraft.run_command', { command: 'page.rotate' }, runner), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    assert.equal(error.fix, 'Open a PDF in PDFCraft first');
    return true;
  });
});

const { skills, errors: skillErrors } = parseSkills(SKILLS_MD, 'pdfcraft');

test('skills.md parses with the runtime parser without errors and has 9 skills', () => {
  assert.deepEqual(skillErrors, []);
  assert.equal(skills.length, 9);
  for (const skill of skills) {
    assert.ok(skill.slug && skill.summary, `skill ${skill.slug} slug/summary`);
    assert.ok(skill.summary.length <= 160, `skill ${skill.slug} summary is ${skill.summary.length} chars`);
    assert.ok(skill.keywords.length >= 5, `skill ${skill.slug} keywords: ${skill.keywords.join(', ')}`);
    assert.ok(skill.tools.length >= 1, `skill ${skill.slug} tools`);
    assert.ok(skill.when && skill.steps.length >= 1 && skill.check, `skill ${skill.slug} body sections`);
  }
});

test('every skill opens by launching PdfCraft, then uses numbered pdfcraft steps', () => {
  for (const skill of skills) {
    assert.equal(skill.steps[0].line, '1. call_tool tool=desktop.open_app app=pdfcraft', `skill ${skill.slug}`);
    skill.steps.forEach((step, i) => {
      assert.equal(step.n, i + 1, `skill ${skill.slug} step numbering`);
      assert.ok(step.tool.startsWith('desktop.') || step.tool.startsWith('pdfcraft.'), `skill ${skill.slug} step ${step.n}: ${step.line}`);
    });
  }
});

test('the edit skills check the open document in step 2 (doc_info), so a missing file is named before edits', () => {
  const bySlug = Object.fromEntries(skills.map(skill => [skill.slug, skill]));
  for (const slug of ['rotate-pages', 'delete-or-duplicate-pages', 'write-text-on-a-page', 'add-a-page-link', 'save-or-close-the-document', 'run-any-menu-command']) {
    assert.equal(bySlug[slug].steps[1].line, '2. call_tool tool=pdfcraft.doc_info', `skill ${slug}`);
  }
  assert.equal(bySlug['replace-text'].steps[1].line, '2. call_tool tool=pdfcraft.text_find query=2025', 'replace-text keeps its find check');
});

test('skill steps and tools lines validate against the runtime checkArgs', () => {
  const errors = checkSkills(skills, byName, { checkArgs: (tool, args) => checkArgs(tool, args, { choices }) });
  assert.deepEqual(errors, []);
});
