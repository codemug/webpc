import test from 'node:test';
import assert from 'node:assert/strict';
import { checkArgs, repairArgs, closest, callLine, specErrors, ToolError, templateLine, templateStep } from '../src/apps/ai-agent/runtime/args.mjs';

// One tool exercising every flat type, with a first example the fix lines build from.
const tool = {
  name: 'demo.set',
  params: {
    name: { type: 'string', required: true, description: 'Target name' },
    count: { type: 'integer', description: 'How many', min: 0, max: 9 },
    rate: { type: 'number', description: 'Per cent', min: 0, max: 100 },
    flag: { type: 'boolean', description: 'Enable it' },
    mode: { type: 'enum', values: ['fast', 'slow', 'dark'], description: 'Which mode' },
    tags: { type: 'list', description: 'Tags' },
    grid: { type: 'table', description: 'Rows' },
    where: { type: 'path', description: 'Files path' },
    note: { type: 'text', description: 'Long text' },
  },
  examples: [{ args: { name: 'ada', count: 3, mode: 'fast', tags: 'a,b', grid: 'x,y\n1,2', where: '/tmp/x', flag: true, rate: 1.5, note: 'hi' } }],
};
const calc = { name: 'demo2.calc', params: { n: { type: 'integer', description: 'N' }, d: { type: 'number', description: 'D' } }, examples: [{ args: { n: 1, d: 1 } }] };
const apps = { name: 'desktop.open_app', params: { app: { type: 'enum', values: 'apps', required: true, description: 'App id' } }, examples: [{ args: { app: 'gridcraft' } }] };

test('string trims, strips one quote pair and collapses whitespace', () => {
  assert.equal(checkArgs(tool, { name: '  "  Ada   Lovelace "  ' }).args.name, 'Ada Lovelace');
  assert.equal(checkArgs(tool, { name: '"multi\nline\tvalue"' }).args.name, 'multi line value');
  assert.equal(checkArgs(tool, { name: '""a""' }).args.name, '"a"', 'only one pair of wrapping quotes is stripped');
  assert.equal(checkArgs(tool, { name: 5 }).ok, false, 'a JSON number is not a string');
});

test('text keeps inner newlines and strips wrapping quotes', () => {
  assert.equal(checkArgs(tool, { name: 'n', note: 'line1\nline2' }).args.note, 'line1\nline2');
  assert.equal(checkArgs(tool, { name: 'n', note: '"a\nb"' }).args.note, 'a\nb');
  assert.equal(checkArgs(tool, { name: 'n', note: true }).ok, false);
});

test('integer accepts digit strings and JSON integers only', () => {
  assert.equal(checkArgs(calc, { n: '7' }).args.n, 7);
  assert.equal(checkArgs(calc, { n: 42 }).args.n, 42);
  assert.equal(checkArgs(calc, { n: '"-3"' }).args.n, -3);
  for (const bad of ['4.5', 4.5, 'x', '1e2', true]) assert.equal(checkArgs(calc, { n: bad }).ok, false, `rejects ${JSON.stringify(bad)}`);
});

test('number accepts finite numbers, min and max bounds are enforced', () => {
  assert.equal(checkArgs(calc, { d: '1.5' }).args.d, 1.5);
  assert.equal(checkArgs(calc, { d: 2 }).args.d, 2);
  for (const bad of ['abc', 'Infinity', NaN, true]) assert.equal(checkArgs(calc, { d: bad }).ok, false, `rejects ${JSON.stringify(bad)}`);
  assert.equal(checkArgs(calc, { d: '   ' }).args.d, undefined, 'a whitespace-only value counts as absent');
  const over = checkArgs(tool, { name: 'n', count: '50' });
  assert.equal(over.ok, false);
  assert.equal(over.error.type, 'invalid_argument');
  assert.equal(over.error.message, 'count must be an integer at least 0 and at most 9; got "50"');
  assert.match(over.error.fix, /count=9/, 'the fix uses the nearest bound as the corrected value');
  const under = checkArgs(tool, { name: 'n', count: '-1' });
  assert.match(under.error.message, /at least 0 and at most 9/);
  assert.match(under.error.fix, /count=0/);
});

test('boolean accepts true, false, yes, no, 1, 0, on, off and JSON values', () => {
  for (const [raw, out] of [['true', true], ['YES', true], [1, true], [true, true], ['on', true], ['false', false], ['No', false], [0, false], [false, false], ['off', false]])
    assert.equal(checkArgs(tool, { name: 'n', flag: raw }).args.flag, out, `accepts ${JSON.stringify(raw)}`);
  for (const bad of ['maybe', 2, 'twofish']) assert.equal(checkArgs(tool, { name: 'n', flag: bad }).ok, false);
});

test('enum matches case-insensitively, through live choices and aliases', () => {
  assert.equal(checkArgs(tool, { name: 'n', mode: 'DARK' }).args.mode, 'dark');
  const withApps = checkArgs(apps, { app: 'GRIDCRAFT' }, { choices: name => (name === 'apps' ? ['gridcraft', 'docs'] : []) });
  assert.equal(withApps.args.app, 'gridcraft');
  const withAlias = checkArgs(apps, { app: 'grid craft' }, { choices: () => ['gridcraft', 'docs'], aliases: { 'grid craft': 'gridcraft' } });
  assert.equal(withAlias.args.app, 'gridcraft');
  const darkMode = checkArgs(tool, { name: 'n', mode: 'dark mode' }, { aliases: { 'dark mode': 'dark' } });
  assert.equal(darkMode.args.mode, 'dark');
  assert.equal(checkArgs(apps, { app: 'ghost' }, { choices: () => [] }).ok, false, 'a live enum with no choices rejects');
});

test('an invalid enum message lists the choices and suggests the closest', () => {
  const error = checkArgs(tool, { name: 'n', mode: 'fasst' }).error;
  assert.equal(error.type, 'invalid_argument');
  assert.equal(error.message, 'mode must be one of fast|slow|dark; got "fasst"; did you mean fast?');
  assert.equal(error.fix, 'call_tool tool=demo.set name=ada count=3 mode=fast tags=a,b grid=x,y\\n1,2 where=<where> flag=true rate=1.5 note=hi');
});

test('closest ranks by edit distance and breaks ties by input order', () => {
  assert.deepEqual(closest('fasst', ['fast', 'slow', 'dark']), ['fast', 'dark', 'slow']);
  assert.deepEqual(closest('zz', ['bb', 'aa', 'zz'], 2), ['zz', 'bb'], 'ties keep the input order');
  assert.deepEqual(closest('x', ['a'], 5), ['a']);
  assert.deepEqual(closest('x', [], 3), []);
});

test('unknown_argument reports the extra key and fixes it with the first example', () => {
  const error = checkArgs(tool, { name: 'ada', bogus: 'x' }).error;
  assert.equal(error.type, 'unknown_argument');
  assert.equal(error.message, 'demo.set has no parameter bogus; it takes: name, count, rate, flag, mode, tags, grid, where, note');
  assert.equal(error.fix, 'call_tool tool=demo.set name=ada count=3 mode=fast tags=a,b grid=x,y\\n1,2 where=<where> flag=true rate=1.5 note=hi');
  const bare = checkArgs(calc, { nope: 1 }).error;
  assert.equal(bare.fix, 'call_tool tool=demo2.calc n=1 d=1');
});

test('missing_argument names the required param, its description and a fixed call', () => {
  const error = checkArgs(tool, { count: 1 }).error;
  assert.equal(error.type, 'missing_argument');
  assert.equal(error.message, 'demo.set needs name (Target name)');
  assert.match(error.fix, /^call_tool tool=demo\.set name=ada /);
  for (const empty of [null, '', '   ', '""', '  ""  ']) assert.equal(checkArgs(tool, { name: empty }).error.type, 'missing_argument', `treats ${JSON.stringify(empty)} as absent`);
});

test('cloud JSON values are accepted: booleans, numbers, arrays for list and table', () => {
  const out = checkArgs(tool, { name: 'ada', count: 3, rate: 2, flag: false, tags: ['a', 2, ''], grid: [['x', 'y'], ['1', 2]], mode: 'slow' });
  assert.equal(out.ok, true);
  assert.deepEqual(out.args.tags, ['a', '2']);
  assert.deepEqual(out.args.grid, [['x', 'y'], ['1', '2']]);
  assert.equal(out.args.count, 3);
  assert.equal(out.args.flag, false);
  assert.equal(checkArgs(tool, { name: 'n', tags: { a: 1 } }).ok, false, 'an object is not a list');
  assert.equal(checkArgs(tool, { name: 'n', grid: [['a', ['b']]] }).ok, false, 'nested arrays are not a table');
});

test('list splits on newlines, else on commas, and drops empty items', () => {
  assert.deepEqual(checkArgs(tool, { name: 'n', tags: 'a,b ,c' }).args.tags, ['a', 'b', 'c']);
  assert.deepEqual(checkArgs(tool, { name: 'n', tags: 'a\nb, c\n\nd' }).args.tags, ['a', 'b, c', 'd']);
  assert.deepEqual(checkArgs(tool, { name: 'n', tags: ' , ' }).args.tags, []);
});

test('table rows split on newlines, cells on tabs or quoted commas', () => {
  const value = 'x\ty\n"p,q",r\na,b';
  assert.deepEqual(checkArgs(tool, { name: 'n', grid: value }).args.grid, [['x', 'y'], ['p,q', 'r'], ['a', 'b']]);
  assert.deepEqual(checkArgs(tool, { name: 'n', grid: ['x,y', 'z,w'] }).args.grid, [['x', 'y'], ['z', 'w']], 'array rows still parse cells');
});

test('list and table accept a string that parses as a JSON array', () => {
  assert.deepEqual(checkArgs(tool, { name: 'n', tags: '["Total"]' }).args.tags, ['Total']);
  assert.deepEqual(checkArgs(tool, { name: 'n', tags: '[1, 2]' }).args.tags, ['1', '2']);
  assert.deepEqual(checkArgs(tool, { name: 'n', tags: '  ["a", "b"]  ' }).args.tags, ['a', 'b']);
  assert.deepEqual(checkArgs(tool, { name: 'n', grid: '["Total"]' }).args.grid, [['Total']], 'a flat JSON array is one row');
  assert.deepEqual(checkArgs(tool, { name: 'n', grid: '[[\"a\",\"b\"],[\"c\",\"d\"]]' }).args.grid, [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(checkArgs(tool, { name: 'n', grid: '"[[\"a\",\"b\"]]"' }).args.grid, [['a', 'b']], 'a quoted JSON array still parses');
  assert.deepEqual(checkArgs(tool, { name: 'n', tags: 'a, [b' }).args.tags, ['a', '[b'], 'invalid JSON falls back to text parsing');
  assert.deepEqual(checkArgs(tool, { name: 'n', grid: 'x\ny' }).args.grid, [['x'], ['y']], 'plain text keeps the old parsing');
});

test('path normalises to a leading slash and rejects unsafe values', () => {
  const pathTool = { name: 't7', params: { where: { type: 'path', required: true, description: 'Files path' } }, examples: [{ args: { where: '/x' } }] };
  assert.equal(checkArgs(pathTool, { where: 'docs/a.txt' }).args.where, '/docs/a.txt');
  assert.equal(checkArgs(pathTool, { where: '/ok/here/' }).args.where, '/ok/here/');
  assert.equal(checkArgs(pathTool, { where: '' }).error.type, 'missing_argument');
  assert.equal(checkArgs(pathTool, { where: '  ' }).error.type, 'missing_argument');
  for (const bad of ['a/../b', '..', '/a/..', 'a\0b', 'a\u202Eb', 'line\nbreak']) assert.equal(checkArgs(pathTool, { where: bad }).error.type, 'invalid_argument', `rejects ${JSON.stringify(bad)}`);
  assert.equal(checkArgs(pathTool, { where: 42 }).error.type, 'invalid_argument');
  assert.equal(checkArgs(tool, { name: 'n', where: '  ' }).args.where, undefined, 'empty stays absent for an optional path');
});

test('defaults fill absent params and are not applied when a value is given', () => {
  const withDefault = { name: 't4', params: { m: { type: 'enum', values: ['a', 'b'], description: 'M', default: 'b' } }, examples: [] };
  assert.deepEqual(checkArgs(withDefault, {}).args, { m: 'b' });
  assert.deepEqual(checkArgs(withDefault, { m: 'a' }).args, { m: 'a' });
  assert.deepEqual(checkArgs(withDefault, { m: null }).args, { m: 'b' }, 'a null slot falls back to the default');
  for (const empty of ['', '  ', '""']) assert.deepEqual(checkArgs(withDefault, { m: empty }).args, { m: 'b' }, `an empty slot falls back to the default (${JSON.stringify(empty)})`);
});

test('specErrors flags nested types, unknown fields and missing or misplaced fields', () => {
  assert.deepEqual(specErrors({ a: { type: 'string', description: 'ok' } }), []);
  const problems = specErrors({
    a: { type: 'object', description: 'x' },
    b: { type: 'enum', description: 'x' },
    c: { type: 'string', foo: 1, description: 'x' },
    d: { type: 'integer', description: 'x', min: 'many' },
    e: { type: 'boolean', values: ['y'], description: 'x' },
    f: { type: 'string' },
    g: { type: 'number', min: 0, max: 10, default: 2, description: 'x' },
  });
  assert.match(problems.join('\n'), /params\.a.*nested/);
  assert.match(problems.join('\n'), /params\.b.*needs values/);
  assert.match(problems.join('\n'), /params\.c.*unknown field 'foo'/);
  assert.match(problems.join('\n'), /params\.d.*finite number/);
  assert.match(problems.join('\n'), /params\.e.*only allowed on an enum/);
  assert.match(problems.join('\n'), /params\.f.*description/);
  assert.ok(!problems.some(p => p.startsWith('params.g')), 'a valid bounded spec has no problems');
  assert.deepEqual(specErrors(null), ['params must be a flat object of parameter specs']);
});

test('ToolError carries type, message and fix', () => {
  const error = new ToolError('busy', 'Another thread holds the app', 'call_tool tool=desktop.open_app app=docs');
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'ToolError');
  assert.equal(error.type, 'busy');
  assert.equal(error.message, 'Another thread holds the app');
  assert.equal(error.fix, 'call_tool tool=desktop.open_app app=docs');
});

test('callLine renders the flat form with escaped newlines and arrays', () => {
  assert.equal(callLine('demo.set', { name: 'ada', count: 3, flag: true }), 'call_tool tool=demo.set name=ada count=3 flag=true');
  assert.equal(callLine('t', { a: 'x\ny\tz', rows: ['p,q', 'r'] }), 'call_tool tool=t a=x\\ny\\tz rows=p,q, r');
  assert.equal(callLine('t', {}), 'call_tool tool=t');
});

test('long enum lists are capped in the message but closest still searches all values', () => {
  const many = Array.from({ length: 30 }, (_, i) => `app${String(i + 1).padStart(2, '0')}`);
  const manyTool = { name: 't8', params: { app: { type: 'enum', required: true, values: many, description: 'App' } }, examples: [] };
  const error = checkArgs(manyTool, { app: 'app29x' }).error;
  assert.equal(error.message, `app must be one of ${many.slice(0, 12).join('|')}, ... (18 more); got "app29x"; did you mean app29?`);
  assert.equal(checkArgs(manyTool, { app: 'app30' }).args.app, 'app30', 'values past the cap still match');
});

test('a tool with no examples still gets a usable fix line from the spec', () => {
  const bare = { name: 't3', params: { m: { type: 'enum', required: true, values: ['alpha', 'beta'], description: 'M' }, k: { type: 'integer', required: true, description: 'K', min: 5 } }, examples: [] };
  assert.equal(checkArgs(bare, { m: 'alpah' }).error.fix, 'call_tool tool=t3 m=alpha', 'the closest valid value replaces the bad one');
  assert.equal(checkArgs(bare, { m: 'alpha' }).error.fix, 'call_tool tool=t3 k=5', 'the missing integer falls back to its min bound');
  assert.equal(checkArgs(bare, {}).error.message, 't3 needs m (M)');
});

test('error messages cap long values instead of flooding the context', () => {
  const long = checkArgs(calc, { d: 'x'.repeat(200) }).error;
  assert.match(long.message, /\.\.\."$/);
  assert.ok(long.message.length < 200);
});

test('missing wins over later params and defaults only apply to absent optional params', () => {
  const twoRequired = { name: 't6', params: { a: { type: 'string', required: true, description: 'A' }, b: { type: 'string', required: true, description: 'B', default: 'db' } }, examples: [] };
  const error = checkArgs(twoRequired, { b: 'x' }).error;
  assert.equal(error.message, 't6 needs a (A)');
});

test('specErrors accepts live enums and rejects unknown live names', () => {
  assert.deepEqual(specErrors({ app: { type: 'enum', values: 'apps', description: 'App id' } }), []);
  assert.deepEqual(specErrors({ win: { type: 'enum', values: 'windows', description: 'Window id' } }), []);
  assert.match(specErrors({ app: { type: 'enum', values: 'files', description: 'App id' } }).join('\n'), /live values must be 'apps' or 'windows'/);
});

// Small models copy example values into their calls (eval M6: "Second draft notes" for any
// Docs text). Discovery surfaces show templates instead, and an unfilled placeholder is refused.
test('templateLine names each argument with a placeholder, no values', () => {
  assert.equal(templateLine('docs.insert_text', ['text']), 'call_tool tool=docs.insert_text text=<text>');
  assert.equal(templateLine('excalidraw.list_elements', []), 'call_tool tool=excalidraw.list_elements');
});

test('templateStep swaps every value in a call_tool step for its placeholder', () => {
  assert.equal(templateStep('2. call_tool tool=docs.insert_text text=Second draft notes'), '2. call_tool tool=docs.insert_text text=<text>');
  assert.equal(templateStep('call_tool tool=excalidraw.add_shapes spec="rectangle 100 100 200 80 Start\\narrow 1 2" x=20'), 'call_tool tool=excalidraw.add_shapes spec=<spec> x=<x>');
  assert.equal(templateStep('3. call_tool tool=gridcraft.inspect'), '3. call_tool tool=gridcraft.inspect');
  assert.equal(templateStep('Check: gridcraft.inspect shows a chart.'), 'Check: gridcraft.inspect shows a chart.');
});

test('an unfilled placeholder is refused with a teaching error; real angle-bracket text passes', () => {
  const tool = { name: 'docs.insert_text', params: { text: { type: 'text', required: true, description: 'The text' } }, examples: [] };
  const bad = checkArgs(tool, { text: '<text>' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.type, 'placeholder');
  assert.match(bad.error.message, /text=<text> is a placeholder/);
  assert.equal(checkArgs(tool, { text: '<b>bold</b>' }).ok, true);
  assert.equal(checkArgs(tool, { text: '"<text>"' }).ok, false, 'a quoted placeholder is still a placeholder');
});

test('a fix line never echoes an example path (eval M6, B16): path params show <key>', () => {
  // The model copied "path=/PDFCraft/contract.pdf" from a missing_argument fix line into its
  // next call, got not found and looped. Paths in fix lines are placeholders now.
  const opener = { name: 'pdfcraft.open_file', params: { path: { type: 'path', required: true, description: 'A Files path to a PDF' } }, examples: [{ args: { path: '/PDFCraft/contract.pdf' } }] };
  const missing = checkArgs(opener, {});
  assert.equal(missing.error.type, 'missing_argument');
  assert.equal(missing.error.fix, 'call_tool tool=pdfcraft.open_file path=<path>');
  const bad = checkArgs(opener, { path: 'a/../b' });
  assert.equal(bad.error.fix, 'call_tool tool=pdfcraft.open_file path=<path>');
  assert.ok(!JSON.stringify([missing, bad]).includes('contract.pdf'), 'no example path anywhere in the errors');
});


// repairArgs: the schema-aware fixes for small-model argument mistakes (eval task C16).
const RUN = { name: 'terminal.run', params: {
  lang: { type: 'enum', values: ['python', 'node', 'sh'], default: 'sh', description: 'Language' },
  code: { type: 'text', required: true, description: 'Code' },
  timeout_ms: { type: 'integer', min: 1, max: 120000, description: 'Limit' },
} };

test('repairArgs splits an unknown key whose value spells the tool own pairs, keeping spaces in the last value', () => {
  assert.deepEqual(repairArgs(RUN, { arg: 'lang=sh code=uname -a' }), { lang: 'sh', code: 'uname -a' });
  assert.deepEqual(checkArgs(RUN, { tool_param: 'lang=python code=print(6 * 7)' }), { ok: true, args: { lang: 'python', code: 'print(6 * 7)' } });
});

test('repairArgs moves one unknown key into the one missing required text parameter', () => {
  assert.deepEqual(checkArgs(RUN, { query: 'uname -a' }), { ok: true, args: { code: 'uname -a', lang: 'sh' } });
});

test('repairArgs leaves calls alone when no rule applies', () => {
  const ok = { lang: 'sh', code: 'ls' };
  assert.deepEqual(repairArgs(RUN, ok), ok);
  assert.equal(checkArgs(RUN, { query: 'a', other: 'b' }).error.type, 'unknown_argument', 'two unknown keys: no guess');
  assert.equal(checkArgs(RUN, { code: 'ls', query: 'x' }).error.type, 'unknown_argument', 'nothing required is missing: no guess');
  const twoRequired = { name: 't', params: { a: { type: 'string', required: true, description: 'a' }, b: { type: 'string', required: true, description: 'b' } } };
  assert.equal(checkArgs(twoRequired, { x: 'v' }).error.type, 'unknown_argument', 'two required params missing: no guess');
  const numeric = { name: 'n', params: { count: { type: 'integer', required: true, description: 'c' } } };
  assert.equal(checkArgs(numeric, { x: '3' }).error.type, 'unknown_argument', 'only string or text params are filled');
});

test('a copied placeholder on a parameter with a default takes the default; without one it is an error', () => {
  assert.deepEqual(checkArgs(RUN, { lang: '<lang>', code: 'ls' }), { ok: true, args: { code: 'ls', lang: 'sh' } });
  assert.equal(checkArgs(RUN, { code: '<code>' }).error.type, 'placeholder');
});
