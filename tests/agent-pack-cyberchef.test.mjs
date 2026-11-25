// Unit tests for the CyberChef pack: agent/apps/cyberchef/tools.js and skills.md.
// A fake ctx.host.appWindow returns a fake window whose app (the vendored CyberChef, v11.5.0)
// records calls; every tool must use the app.bake(input, recipeConfig, {returnType}) and
// app.operations registry shapes the release installs on window.app. The schema and skills checks
// reuse the real runtime validators, with the choices function the build uses.
// Run: node --test tests/agent-pack-cyberchef.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack, tools } from '../agent/apps/cyberchef/tools.js';
import { tools as desktopTools } from '../agent/desktop/tools.js';
import { ToolError, specErrors, checkArgs } from '../src/apps/ai-agent/runtime/args.mjs';
import { parseSkills, checkSkills } from '../src/apps/ai-agent/runtime/skills.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_MD = readFileSync(join(HERE, '..', 'agent', 'apps', 'cyberchef', 'skills.md'), 'utf8');
// The enabled app ids scripts/agent/build.mjs resolves the live 'apps' enum with (catalog.yaml).
const APP_IDS = ['gridcraft', 'docs', 'deckcraft', 'terminal', 'sqliteviz', 'files', 'media', 'cyberchef', 'vscode', 'nettools', 'packets', 'ai-agent', 'lightcraft', 'figcraft', 'pdfcraft', 'soundcraft', 'beepbox', 'filmcraft', 'cadcraft', 'vectorcraft', 'photocraft', 'effectcraft', 'materialcraft', 'texturecraft', 'excalidraw', 'vert'];
const choices = name => (name === 'apps' || name === 'windows' ? APP_IDS : []);
const byName = name => tools.find(tool => tool.name === name) ?? desktopTools.find(tool => tool.name === name);

// The operation registry shape the release uses: name -> { module, description, args }.
// Each arg carries its real default (value), and option/editableOption args carry the option
// list, so the pack's default-filling is testable. editableOption defaults (the Base64
// Alphabet) are a list of {name, value} options; the first option's value string is the default.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const OPS = {
  'To Base64': { module: 'Encodings', description: 'Encode text as Base64.', args: [{ name: 'Alphabet', type: 'editableOption', value: [{ name: 'Standard Base64', value: B64 }, { name: 'URL', value: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_' }] }] },
  'From Base64': { module: 'Encodings', description: 'Decode Base64-encoded text.', args: [{ name: 'Alphabet', type: 'editableOption', value: [{ name: 'Standard Base64', value: B64 }] }] },
  'To Hex': { module: 'Encodings', description: 'Encode text as Hex.', args: [{ name: 'Delimiter', type: 'option', value: ['None', 'Space'] }, { name: 'Bytes per line', type: 'number', value: 0 }] },
  'From Hex': { module: 'Encodings', description: 'Decode Hex-encoded text.', args: [{ name: 'Delimiter', type: 'option', value: ['None', 'Space'] }] },
  'To Upper case': { module: 'Utils', description: 'Convert text to UPPER CASE.', args: [{ name: 'Scope', type: 'option', value: ['All', 'Word', 'Sentence', 'Paragraph'] }] },
  'MD5': { module: 'Hashing', description: 'Compute an MD5 <a href="#">hash</a>.', args: [{ name: 'Output format', type: 'option', value: ['Hex', 'Base64'] }, { name: 'Endianness', type: 'option', value: ['Big', 'Little'] }] },
  // v11.5.0's ROT13 is a general rotate with an Amount arg (default 13) - the per-op-arg tests
  // and the cyberchef-08 Caesar-shift journey both drive it this way.
  'ROT13': { module: 'Default', description: 'Rotates alphabet characters by the given amount.', args: [{ name: 'Rotate lower case chars', type: 'boolean', value: true }, { name: 'Rotate upper case chars', type: 'boolean', value: true }, { name: 'Rotate numbers', type: 'boolean', value: false }, { name: 'Amount', type: 'number', value: 13 }] },
  'URL Decode': { module: 'URL', description: 'Converts URI/URL percent-encoded characters back.', args: [] },
  // The SHA2 arg layout the vendored v11.5.0 definition carries: Size (argSelector) first, then
  // two Rounds number args - the second applies to the smaller sizes. The alias test asserts
  // against this shape, so a layout change upstream surfaces as a failing test.
  'SHA2': { module: 'Crypto', description: 'The SHA-2 family hash (Size picks 224, 256, 384 or 512).', args: [{ name: 'Size', type: 'argSelector', value: [{ name: '512', on: [2], off: [1] }, { name: '384', on: [2], off: [1] }, { name: '256', on: [1], off: [2] }, { name: '224', on: [1], off: [2] }, { name: '512/256', on: [2], off: [1] }, { name: '512/224', on: [2], off: [1] }] }, { name: 'Rounds', type: 'number', value: 64, min: 16 }, { name: 'Rounds', type: 'number', value: 160, min: 32 }] },
};

// A fake appWindow returning the wrapper window; the real app sits in the #cyberchef-frame
// iframe's contentWindow (window.app). The fake app exposes the operations registry and a
// background chef worker whose bake(input, ops, options, progress, step, callback) delivers the
// result to the callback, mirroring the real worker's bakeComplete/bakeError delivery.
const fakeChef = ({ bake = (input, ops, o) => ({ result: 'OUTPUT', type: 'string', input, ops, o }), operations = OPS, ready = true } = {}) => {
  const calls = [];
  const worker = ready
    ? {
      chefWorker: {},
      bake: (input, ops, o, progress, step, callback) => { calls.push(['bake', input, ops, o, progress, step]); callback(bake(input, ops, o)); },
    }
    : undefined;
  const app = { operations, bake: () => {}, manager: { background: worker } };
  const innerWin = { app };
  const wrapper = { document: { getElementById: id => (id === 'cyberchef-frame' ? { contentWindow: innerWin } : null) } };
  const runTool = (name, args, ctx = { host: { appWindow: async () => wrapper } }) => byName(name).run(args, ctx);
  return { calls, runTool, wrapper, innerWin, operations, worker };
};

test('the pack declares its id and title', () => {
  assert.deepEqual(pack, { id: 'cyberchef', title: 'CyberChef' });
});

test('the pack exposes exactly the 2 cyberchef tools', () => {
  assert.equal(tools.length, 2);
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['cyberchef.bake', 'cyberchef.list_operations']);
});

test('every tool has the required text fields, effect, needs and examples', () => {
  for (const tool of tools) {
    assert.match(tool.name, /^cyberchef\.[a-z0-9_]+$/);
    assert.ok(tool.purpose.length > 0 && tool.purpose.length <= 80, `${tool.name} purpose is ${tool.purpose.length} chars`);
    assert.ok(tool.when.startsWith('Use when'), `${tool.name} when must start with "Use when"`);
    assert.ok(tool.when.length <= 120, `${tool.name} when is ${tool.when.length} chars`);
    assert.ok(['read', 'change', 'destructive', 'external'].includes(tool.effect), `${tool.name} bad effect`);
    assert.deepEqual(tool.needs, ['host', 'app:cyberchef']);
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

test('bake is a change and list_operations is a read', () => {
  assert.equal(byName('cyberchef.bake').effect, 'change', 'bake');
  assert.equal(byName('cyberchef.list_operations').effect, 'read', 'list_operations');
});

test('cyberchef.bake bakes the recipe as {op, args} with returnType STRING', async () => {
  const chef = fakeChef();
  const out = await chef.runTool('cyberchef.bake', { recipe: 'To_Base64', input: 'hello' });
  assert.deepEqual(out, { output: 'OUTPUT', type: 'string', ops: ['To Base64'] });
  const [name, input, ops, options, progress, step] = chef.calls[0];
  assert.equal(name, 'bake');
  assert.equal(input, 'hello');
  // editableOption args take the first option's value string (not the {name, value} list), so
  // the op's run() gets a string alphabet and base64("hello world") yields "aGVsbG8gd29ybGQ=".
  assert.deepEqual(ops, [{ op: 'To Base64', args: [B64] }]);
  assert.deepEqual(options, { returnType: 1 });
  assert.equal(progress, 0);
  assert.equal(step, false);
});

test('cyberchef.bake fills each operation arg from its default before baking', async () => {
  const chef = fakeChef();
  await chef.runTool('cyberchef.bake', { recipe: 'From_Hex,To_Upper_case', input: '48656c6c6f' });
  const [, , ops] = chef.calls[0];
  // option args take the first option (value[0]); this is what makes the ops run instead of
  // erroring on null args ("Cannot read properties of null", "Unrecognized capitalization scope").
  assert.deepEqual(ops, [{ op: 'From Hex', args: ['None'] }, { op: 'To Upper case', args: ['All'] }]);
});

test('cyberchef.bake turns the SHA256 recipe into the SHA2 operation with Size "256" and default other args', async () => {
  const chef = fakeChef();
  const out = await chef.runTool('cyberchef.bake', { recipe: 'SHA256', input: 'abc' });
  assert.deepEqual(out, { output: 'OUTPUT', type: 'string', ops: ['SHA256'] });
  const [, , ops] = chef.calls[0];
  // The alias overrides only the Size arg; the two Rounds args keep their defaults (64, 160).
  assert.deepEqual(ops, [{ op: 'SHA2', args: ['256', 64, 160] }]);
});

test('cyberchef.bake maps the other hash alias spellings onto SHA2 with the matching Size', async () => {
  const chef = fakeChef();
  for (const [recipe, size] of [['sha-256', '256'], ['SHA_224', '224'], ['Sha 384', '384'], ['SHA512', '512']]) {
    const out = await chef.runTool('cyberchef.bake', { recipe, input: 'abc' });
    assert.deepEqual(out.ops, [recipe.replace(/_/g, ' ')]);
    const [, , ops] = chef.calls.at(-1);
    assert.deepEqual(ops, [{ op: 'SHA2', args: [size, 64, 160] }]);
  }
});

test('cyberchef.bake matches operation names case- and separator-insensitively', async () => {
  const chef = fakeChef();
  for (const [recipe, op] of [['rot13', 'ROT13'], ['to_base64', 'To Base64'], ['FROM_HEX', 'From Hex'], ['to-base64', 'To Base64']]) {
    await chef.runTool('cyberchef.bake', { recipe, input: 'x' });
    assert.equal(chef.calls.at(-1)[2][0].op, op, recipe);
  }
});

test('cyberchef.bake maps the plain phrasings the models use onto the real operation names', async () => {
  const chef = fakeChef();
  for (const [recipe, op] of [
    ['base64_encode', 'To Base64'],
    ['base64 encode', 'To Base64'],
    ['encode base64', 'To Base64'],
    ['base64 decode', 'From Base64'],
    ['hex decode', 'From Hex'],
    ['hex encode', 'To Hex'],
    ['uppercase', 'To Upper case'],
    ['upper case', 'To Upper case'],
    ['rot13 decode', 'ROT13'],
    ['url decode', 'URL Decode'],
  ]) {
    await chef.runTool('cyberchef.bake', { recipe, input: 'x' });
    assert.equal(chef.calls.at(-1)[2][0].op, op, recipe);
  }
});

test('cyberchef.bake carries per-operation args into the op settings, coerced to the arg types', async () => {
  const chef = fakeChef();
  const out = await chef.runTool('cyberchef.bake', { recipe: 'ROT13(Amount=19)', input: 'OLSSV' });
  assert.deepEqual(out.ops, ['ROT13']);
  const [, , ops] = chef.calls[0];
  // The Amount number arg is coerced to 19; the boolean args keep their defaults.
  assert.deepEqual(ops, [{ op: 'ROT13', args: [true, true, false, 19] }]);
});

test('cyberchef.bake keeps arg-list commas inside the step parens and matches option values by label', async () => {
  const chef = fakeChef();
  await chef.runTool('cyberchef.bake', { recipe: 'From_Hex,To_Upper_case(Scope=Word),ROT13(Amount=19,Rotate_numbers=true),MD5', input: '48656c6c6f' });
  const [, , ops] = chef.calls[0];
  assert.deepEqual(ops.map(op => op.op), ['From Hex', 'To Upper case', 'ROT13', 'MD5']);
  assert.deepEqual(ops[1].args, ['Word'], 'the option value is matched by label');
  assert.deepEqual(ops[2].args, [true, true, true, 19], 'the underscored arg name matches and the boolean is coerced');
});

test('cyberchef.bake rejects an unknown per-operation argument with the closest arg name and the fixed call', async () => {
  const chef = fakeChef();
  await assert.rejects(chef.runTool('cyberchef.bake', { recipe: 'To_Hex(Delimitr=Space)', input: 'x' }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'invalid_argument');
    assert.match(error.message, /To Hex has no argument named "Delimitr"; closest: Delimiter/);
    assert.equal(error.fix, 'call_tool tool=cyberchef.bake recipe=To Hex(Delimiter=Space) input=x');
    return true;
  });
  assert.equal(chef.calls.length, 0, 'bake is not called for a bad recipe');
});

test('cyberchef.bake runs a comma-separated multi-step pipeline in order', async () => {
  const chef = fakeChef();
  const out = await chef.runTool('cyberchef.bake', { recipe: 'From_Hex,To_Upper_case', input: '48656c6c6f' });
  assert.deepEqual(out.ops, ['From Hex', 'To Upper case']);
  const [name, input, ops, options] = chef.calls[0];
  assert.equal(name, 'bake');
  assert.equal(input, '48656c6c6f');
  assert.deepEqual(ops.map(op => op.op), ['From Hex', 'To Upper case']);
  assert.deepEqual(options, { returnType: 1 });
});

test('cyberchef.bake defaults the input to an empty string when omitted', async () => {
  const chef = fakeChef();
  await chef.runTool('cyberchef.bake', { recipe: 'To_Hex' });
  assert.equal(chef.calls[0][1], '');
});

test('cyberchef.bake rejects an unknown operation with the closest names and the fixed call', async () => {
  const chef = fakeChef();
  await assert.rejects(chef.runTool('cyberchef.bake', { recipe: 'To_Base6', input: 'x' }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'invalid_argument');
    assert.match(error.message, /unknown operation\(s\) To Base/);
    assert.match(error.message, /closest: To Base64/);
    // The fix line is the exact call with the closest operation name filled in.
    assert.equal(error.fix, 'call_tool tool=cyberchef.bake recipe=To Base64 input=x');
    return true;
  });
  assert.equal(chef.calls.length, 0, 'bake is not called for a bad recipe');
});

test('cyberchef.bake rejects an empty recipe without calling bake', async () => {
  const chef = fakeChef();
  await assert.rejects(chef.runTool('cyberchef.bake', { recipe: ', ,', input: 'x' }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'invalid_argument');
    assert.match(error.message, /recipe is empty/);
    return true;
  });
  assert.equal(chef.calls.length, 0);
});

test('cyberchef.bake surfaces the bake error displayStr as an app_error', async () => {
  const chef = fakeChef({ bake: () => ({ result: null, type: null, error: { displayStr: 'Input not valid as Hex' } }) });
  await assert.rejects(chef.runTool('cyberchef.bake', { recipe: 'From_Hex', input: 'zz' }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'app_error');
    assert.match(error.message, /Input not valid as Hex/);
    return true;
  });
});

test('cyberchef.list_operations filters by a case-insensitive name substring', async () => {
  const chef = fakeChef();
  const out = await chef.runTool('cyberchef.list_operations', { query: 'base64' });
  assert.deepEqual(out.operations.map(row => row.name), ['To Base64', 'From Base64']);
  assert.deepEqual(out.operations[0], { name: 'To Base64', module: 'Encodings', args: ['Alphabet'], description: 'Encode text as Base64.' });
  // The model passes the recipe spelling (underscores): the query matches the normalized names.
  const underscored = await chef.runTool('cyberchef.list_operations', { query: 'To_Upper_case' });
  assert.deepEqual(underscored.operations.map(row => row.name), ['To Upper case']);
});

test('cyberchef.list_operations strips HTML from descriptions and maps arg names', async () => {
  const chef = fakeChef();
  const out = await chef.runTool('cyberchef.list_operations', { query: 'md5' });
  assert.deepEqual(out.operations, [{ name: 'MD5', module: 'Hashing', args: ['Output format', 'Endianness'], description: 'Compute an MD5 hash.' }]);
});

test('cyberchef.list_operations caps the result at the top 10 matches', async () => {
  const many = {};
  for (let n = 0; n < 15; n++) many[`Op ${n}`] = { module: 'M', description: 'd', args: [] };
  const chef = fakeChef({ operations: many });
  const out = await chef.runTool('cyberchef.list_operations', {});
  assert.equal(out.count, 10);
  assert.equal(out.operations.length, 10);
});

test('a tool rejects with not_available when ctx.host is absent', async () => {
  await assert.rejects(byName('cyberchef.bake').run({ recipe: 'To_Base64' }, { host: null }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    return true;
  });
});

test('a tool rejects with not_available when the app is not ready yet', async () => {
  const chef = fakeChef({ ready: false });
  const fast = { sleep: async () => {}, timeoutMs: 200 };
  await assert.rejects(byName('cyberchef.bake').run({ recipe: 'To_Base64' }, { host: { appWindow: async () => chef.wrapper }, ...fast }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    assert.match(error.message, /did not finish loading/);
    return true;
  });
  assert.equal(chef.calls.length, 0, 'bake is not called for a not-ready app');
});

test('a tool rejects with not_available when the wrapper has no cyberchef frame', async () => {
  const noFrame = { document: { getElementById: () => null } };
  await assert.rejects(byName('cyberchef.list_operations').run({}, { host: { appWindow: async () => noFrame } }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    assert.match(error.message, /no cyberchef-frame frame/);
    return true;
  });
});

test('a host rejection code is passed through as the ToolError type', async () => {
  const boom = () => { const error = new Error('window "cyberchef" is not open'); error.code = 'not_open'; throw error; };
  await assert.rejects(byName('cyberchef.list_operations').run({}, { host: { appWindow: boom } }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_open');
    return true;
  });
});

const { skills, errors: skillErrors } = parseSkills(SKILLS_MD, 'cyberchef');

test('skills.md parses with the runtime parser without errors and has 6 skills', () => {
  assert.deepEqual(skillErrors, []);
  assert.equal(skills.length, 6);
  for (const skill of skills) {
    assert.ok(skill.slug && skill.summary, `skill ${skill.slug} slug/summary`);
    assert.ok(skill.summary.length <= 160, `skill ${skill.slug} summary is ${skill.summary.length} chars`);
    assert.ok(skill.keywords.length >= 5, `skill ${skill.slug} keywords: ${skill.keywords.join(', ')}`);
    assert.ok(skill.tools.length >= 1, `skill ${skill.slug} tools`);
    assert.ok(skill.when && skill.steps.length >= 1 && skill.check, `skill ${skill.slug} body sections`);
  }
});

test('every skill opens by launching CyberChef, then uses numbered cyberchef steps', () => {
  for (const skill of skills) {
    assert.equal(skill.steps[0].line, '1. call_tool tool=desktop.open_app app=cyberchef', `skill ${skill.slug}`);
    skill.steps.forEach((step, i) => {
      assert.equal(step.n, i + 1, `skill ${skill.slug} step numbering`);
      assert.ok(step.tool.startsWith('desktop.') || step.tool.startsWith('cyberchef.'), `skill ${skill.slug} step ${step.n}: ${step.line}`);
    });
  }
});

test('skill steps and tools lines validate against the runtime checkArgs', () => {
  const errors = checkSkills(skills, byName, { checkArgs: (tool, args) => checkArgs(tool, args, { choices }) });
  assert.deepEqual(errors, []);
});

test('the hash skill names the SHA aliases and the pipeline skill the single-input rule and per-op args', () => {
  const hash = skills.find(skill => skill.slug === 'hash-text');
  for (const alias of ['SHA256', 'SHA224', 'SHA384', 'SHA512']) assert.ok(hash.gotchas.includes(alias), `hash skill names ${alias}`);
  assert.ok(!hash.gotchas.includes('UNVERIFIED'), 'the SHA256 alias is verified live');
  const pipeline = skills.find(skill => skill.slug === 'multi-step-pipeline');
  assert.ok(pipeline.gotchas.includes('previous one\'s output'), 'the pipeline skill says each step reads the previous output');
  assert.ok(pipeline.gotchas.includes('ROT13(Amount=19)'), 'the pipeline skill shows the per-op arg syntax');
});
