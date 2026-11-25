import test from 'node:test';
import assert from 'node:assert/strict';
import { checkArgs, repairArgs, closest, callLine, specErrors, ToolError, templateLine, templateStep, snapToUserText } from '../src/apps/ai-agent/runtime/args.mjs';

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

// B17 (cyberchef-09): the missing-arg fix for a live app/window enum names the context app
// instead of the example app - desktop.open_app's example (gridcraft) lured 09 into opening
// the wrong app; with no context app the placeholder shows, which the guard refuses cleanly.
test('missing_argument fix for a live app enum names the context app, else the placeholder', () => {
  const openApp = { name: 'desktop.open_app', params: { app: { type: 'enum', values: 'apps', required: true, description: 'App id to open' } }, examples: [{ args: { app: 'gridcraft' } }] };
  assert.equal(checkArgs(openApp, {}).error.fix, 'call_tool tool=desktop.open_app app=<app>');
  assert.equal(checkArgs(openApp, {}, { liveApp: 'cyberchef' }).error.fix, 'call_tool tool=desktop.open_app app=cyberchef');
  // A fixed-value enum is unaffected: its first value still shows.
  const fixed = { name: 't.theme', params: { theme: { type: 'enum', values: ['light', 'dark'], required: true, description: 'Theme' } }, examples: [] };
  assert.equal(checkArgs(fixed, {}).error.fix, 'call_tool tool=t.theme theme=light');
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
  // The flat refusal is opt-in (gridcraft set `flat: false`): without it, a flat list of scalars
  // still coerces to one-cell rows - vectorcraft.rows and deckcraft.data/series rely on that.
  assert.deepEqual(checkArgs(tool, { name: 'n', grid: ['a', 'b', 'c'] }).args.grid, [['a'], ['b'], ['c']]);
});

test('a flat table refusal carries a copyable rows-form fix line built from the given values (A27)', () => {
  // gridcraft-12 (sweep b17): the refusal showed both JSON forms with a hardcoded "values=" and
  // no copyable line; lfm3 retried the identical flat list three times.
  const strict = { ...tool, params: { ...tool.params, grid: { type: 'table', flat: false, description: 'Rows' } } };
  const out = checkArgs(strict, { name: 'n', grid: ['Date', 'Income', 'Expenses', 'Left'] });
  assert.ok(!out.ok, 'the flat list is refused');
  assert.equal(out.error.type, 'invalid_argument');
  assert.match(out.error.message, /^grid: a flat list of 4 values is ambiguous: grid=\[\["Date","Income","Expenses","Left"\]\] writes a row; grid=\[\["Date"\],\["Income"\],\["Expenses"\],\["Left"\]\] writes a column$/);
  // The fix line is the tool's own example with the given values in the rows form - one line,
  // copyable. A29: for a flat:false table that must be the JSON rows form, because the
  // single-line CSV rendering the model used to copy is now refused as ambiguous.
  assert.match(out.error.fix, /^call_tool tool=demo\.set name=ada /);
  assert.match(out.error.fix, /grid=\[\["Date","Income","Expenses","Left"\]\]/);
  assert.ok(!out.error.fix.includes('\n'), 'the fix line stays on one line');
  // Round trip: the copyable line parses back as one row, so a retry with it is accepted.
  assert.deepEqual(checkArgs(strict, { name: 'n', grid: '[["Date","Income","Expenses","Left"]]' }).args.grid, [['Date', 'Income', 'Expenses', 'Left']]);
});

test('a single-line comma string is refused for a flat:false table with the rows-form fix (A29)', () => {
  // gridcraft-05 (sweep b19): the refused flat list was re-sent as one CSV string and accepted
  // as one row of six cells - a silent wrong success. Newlines keep the string form.
  const strict = { ...tool, params: { ...tool.params, grid: { type: 'table', flat: false, description: 'Rows' } } };
  const out = checkArgs(strict, { name: 'n', grid: 'Quarter, Revenue, Q1 120, Q2 180, Q3 95, Q4 150' });
  assert.ok(!out.ok, 'the CSV string is refused');
  assert.equal(out.error.type, 'invalid_argument');
  assert.match(out.error.message, /^grid: a single-line comma string is ambiguous: grid=\[\["Quarter","Revenue","Q1 120","Q2 180","Q3 95","Q4 150"\]\] writes a row; /);
  // The fix line is the JSON rows form - the only single-line copy that parses back.
  assert.match(out.error.fix, /grid=\[\["Quarter","Revenue","Q1 120","Q2 180","Q3 95","Q4 150"\]\]/);
  assert.deepEqual(checkArgs(strict, { name: 'n', grid: out.error.fix.match(/grid=(\[[\s\S]*\])/)[1] }).args.grid, [['Quarter', 'Revenue', 'Q1 120', 'Q2 180', 'Q3 95', 'Q4 150']], 'the fix line round-trips as one row');
  // Newlines keep the string form: one row per line, cells by comma.
  assert.deepEqual(checkArgs(strict, { name: 'n', grid: 'a,b\nc,d' }).args.grid, [['a', 'b'], ['c', 'd']]);
  // A single cell is not ambiguous.
  assert.deepEqual(checkArgs(strict, { name: 'n', grid: 'hello' }).args.grid, [['hello']]);
  // Without flat:false the CSV string keeps the old behaviour (vectorcraft.rows relies on it).
  assert.deepEqual(checkArgs(tool, { name: 'n', grid: 'a,b' }).args.grid, [['a', 'b']]);
  // gridcraft-04 (sweep b20): a 2D array string truncated mid-way (it ends with a literal
  // "...") fails the JSON parse, so it must not be re-rendered as a comma-split row of
  // garbage - it is refused as unparseable with a clean 2D example as the fix.
  const broken = checkArgs(strict, { name: 'n', grid: '[["Widget North 1250", "North", "1250"], ["Gadget South 300", "South", "300"],...]' });
  assert.ok(!broken.ok, 'the truncated 2D string is refused');
  assert.match(broken.error.message, /^grid: looks like a 2D JSON array but does not parse/);
  assert.match(broken.error.fix, /grid=\[\["a","b"\],\["c","d"\]\]/);
  assert.deepEqual(checkArgs(strict, { name: 'n', grid: '[["a","b"],["c","d"]]' }).args.grid, [['a', 'b'], ['c', 'd']], 'the fix line round-trips as two rows');
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

test('repairArgs unwraps the tool own args sent as a JSON object under an unknown key', () => {
  // lfm3-1.7b on journey cadcraft-01: params="{\"text\": \"line 0,0 10,0\"}" to a tool with no params param.
  assert.deepEqual(checkArgs(RUN, { params: '{"code": "uname -a", "lang": "sh"}' }), { ok: true, args: { code: 'uname -a', lang: 'sh' } });
  assert.deepEqual(checkArgs(RUN, { args: { code: 'ls' } }), { ok: true, args: { code: 'ls', lang: 'sh' } });
  // Wrong inner keys are unwrapped too: one stray key fills the one missing required param,
  assert.deepEqual(checkArgs(RUN, { params: '{"cmd": "ls"}' }), { ok: true, args: { code: 'ls', lang: 'sh' } });
  // and otherwise the error names the wrong inner key, not the wrapper.
  assert.match(checkArgs(RUN, { parameters: '{"code": "ls", "title": "x"}' }).error.message, /no parameter title/);
});

test('A25: a loose-JSON blob (unquoted keys) under the one unknown arg unwraps into the params', () => {
  // filmcraft-03/06 (b16): args="{ item: beach-sunset.jpg, track: V1, seconds: 0 }" used to
  // hand the whole blob to the one required param and loop on "item <blob> not in the project".
  const place = { name: 'filmcraft.place', params: {
    item: { type: 'string', required: true, description: 'Item id' },
    track: { type: 'string', description: 'Track' },
    seconds: { type: 'integer', description: 'Seconds' },
  } };
  const out = checkArgs(place, { args: '{ item: beach-sunset.jpg, track: V1, seconds: 0 }' });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.args, { item: 'beach-sunset.jpg', track: 'V1', seconds: 0 });
  // Negative: a plain string value is still the content of the one required param.
  assert.deepEqual(checkArgs(place, { args: 'beach-sunset.jpg' }), { ok: true, args: { item: 'beach-sunset.jpg' } });
  // Strict JSON and the k=v form took their own rules before; all three now unwrap.
  assert.deepEqual(checkArgs(place, { args: '{"item": "a.jpg", "track": "V1"}' }).args, { item: 'a.jpg', track: 'V1' });
  assert.deepEqual(checkArgs(place, { args: 'item=a.jpg track=V1' }).args, { item: 'a.jpg', track: 'V1' });
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

test('repairArgs unwraps a full call the model wrapped under a declared parameter (run_command family)', () => {
  // lfm3-1.7b on J2 cadcraft 0/2 and effectcraft 0/12: the whole call, command included,
  // sits inside the params= wrapper because run_command declares a params parameter itself.
  // The inner object then lands as key=value lines in the params slot (gridcraft-08 rule),
  // which the packs' parseParams accepts.
  const RUN_CMD = { name: 'cadcraft.run_command', params: {
    command: { type: 'string', required: true, description: 'Command id' },
    params: { type: 'text', description: 'Parameters as key=value lines' },
  } };
  assert.deepEqual(checkArgs(RUN_CMD, { params: '{"command": "line", "params": {"from": "0,0", "to": "10,0"}}' }),
    { ok: true, args: { command: 'line', params: 'from=0,0\nto=10,0' } });
  // An object value, not just JSON text.
  assert.deepEqual(checkArgs(RUN_CMD, { params: { command: 'circle', params: { center: '20,0', radius: 5 } } }),
    { ok: true, args: { command: 'circle', params: 'center=20,0\nradius=5' } });
  // A present command= is never lost or duplicated by the unwrap.
  assert.deepEqual(checkArgs(RUN_CMD, { command: 'circle', params: '{"center": "20,0", "radius": 5}' }),
    { ok: true, args: { command: 'circle', params: 'center=20,0\nradius=5' } });
  // A wrapper that carries no missing required param stays put (the error then names command).
  assert.equal(checkArgs(RUN_CMD, { params: '{"center": "20,0"}' }).error.type, 'missing_argument');
});

test('repairArgs accepts key: value colons in a wrapped string (tool_param colon form)', () => {
  // lfm3-1.7b sent tool_param="new: true" to effectcraft.project_open (J2 effectcraft-06).
  const OPEN = { name: 'effectcraft.project_open', params: { demo: { type: 'boolean', description: 'Demo' }, new: { type: 'boolean', description: 'New' } } };
  assert.deepEqual(checkArgs(OPEN, { tool_param: 'new: true' }), { ok: true, args: { new: true } });
  assert.deepEqual(checkArgs(RUN, { tool_param: 'lang: python code: print(6 * 7)' }), { ok: true, args: { lang: 'python', code: 'print(6 * 7)' } });
  // The equals form still wins when both appear.
  assert.deepEqual(checkArgs(OPEN, { tool_param: 'new=true' }), { ok: true, args: { new: true } });
});

test('repairArgs splits comma- and semicolon-separated pairs in a wrapped string (tool_param comma form)', () => {
  // lfm3-1.7b sweep b17 cyberchef-01/02 sent tool_param "recipe=SHA256,input=4865": the comma
  // form used to swallow the second pair into the first value ("unknown operation(s) input=...").
  const BAKE = { name: 'cyberchef.bake', params: { recipe: { type: 'text', required: true, description: 'Ops' }, input: { type: 'text', description: 'Text' } } };
  assert.deepEqual(checkArgs(BAKE, { tool_param: 'recipe=SHA256,input=48656c6c6f20576f726c64' }), { ok: true, args: { recipe: 'SHA256', input: '48656c6c6f20576f726c64' } });
  assert.deepEqual(checkArgs(RUN, { tool_param: 'lang=python;code=print(6 * 7)' }), { ok: true, args: { lang: 'python', code: 'print(6 * 7)' } });
  // A multi-op recipe keeps its own commas: only a declared param name splits.
  assert.deepEqual(checkArgs(BAKE, { tool_param: 'recipe=From_Hex,To_Upper_case,To_Base64, input=4865' }), { ok: true, args: { recipe: 'From_Hex,To_Upper_case,To_Base64', input: '4865' } });
});

test('a copied placeholder on a parameter with a default takes the default; without one it is an error', () => {
  assert.deepEqual(checkArgs(RUN, { lang: '<lang>', code: 'ls' }), { ok: true, args: { code: 'ls', lang: 'sh' } });
  assert.equal(checkArgs(RUN, { code: '<code>' }).error.type, 'placeholder');
});

/** lfm3-1.7b copied a generic slot word into a value (cyberchef-01: input=<text>). */
test('a generic slot word like <text> is a placeholder error, real angle-bracket input is not', () => {
  const BAKE = { name: 'cyberchef.bake', params: { recipe: { type: 'text', required: true, description: 'Ops' }, input: { type: 'text', required: true, description: 'Text' } } };
  assert.equal(checkArgs(BAKE, { recipe: 'To Base64', input: '<text>' }).error.type, 'placeholder');
  assert.equal(checkArgs(BAKE, { recipe: 'To Base64', input: '<b>' }).ok, true);
  assert.equal(checkArgs(BAKE, { recipe: 'To Base64', input: '<div>' }).ok, true);
});

/** lfm3-1.7b carried find_tool's own app parameter over into the tool call (files-01:
 *  files.list app=files, eight rounds lost to unknown_argument loops). */
test('repairArgs drops a redundant app argument that spells the tool own app prefix', () => {
  const LIST = { name: 'files.list', params: { path: { type: 'path', description: 'The folder to look in' } } };
  assert.deepEqual(repairArgs(LIST, { app: 'files', path: '/notes/trip' }), { path: '/notes/trip' });
  assert.deepEqual(checkArgs(LIST, { app: 'files', path: '/notes/trip' }), { ok: true, args: { path: '/notes/trip' } });
  // A different app value is a real mistake: it stays for the unknown_argument error.
  assert.deepEqual(repairArgs(LIST, { app: 'gridcraft', path: '/notes/trip' }), { app: 'gridcraft', path: '/notes/trip' });
  // A tool with a real app parameter is untouched.
  const MIN = { name: 'desktop.minimize', params: { app: { type: 'enum', values: ['gridcraft', 'docs'], description: 'The app id' } } };
  assert.deepEqual(repairArgs(MIN, { app: 'gridcraft' }), { app: 'gridcraft' });
});

/** lfm3-1.7b sent the run_command tools' params as a JSON object and spelled the command id
 *  inside the params text (gridcraft-08/09 on the lfm3 baseline). */
test('repairArgs flattens a params object into key=value lines and lifts a command id spelled in the text', () => {
  const RC = { name: 'gridcraft.run_command', params: {
    command: { type: 'string', required: true, description: 'Command id' },
    params: { type: 'text', description: 'Parameters as key=value lines' },
  } };
  assert.deepEqual(repairArgs(RC, { command: 'cell.set', params: { cell: 'B2', input: 'Hello' } }), { command: 'cell.set', params: 'cell=B2\ninput=Hello' });
  assert.deepEqual(repairArgs(RC, { args: '{"command": "cell.set", "params": {"path": "a.xlsx"}}' }), { command: 'cell.set', params: 'path=a.xlsx' });
  assert.deepEqual(repairArgs(RC, { params: 'command=cell.set cell=A2 input=100' }), { command: 'cell.set', params: 'cell=A2 input=100' });
  assert.deepEqual(checkArgs(RC, { params: 'command=cell.set' }), { ok: true, args: { command: 'cell.set' } });
  // A single-key object on a non-params text parameter is content, not a map: it stays put so
  // the normal "must be text" error teaches instead of a mis-repair writing wrong content.
  const APPEND = { name: 'files.append', params: { text: { type: 'text', required: true, description: 'Text' } } };
  assert.deepEqual(repairArgs(APPEND, { text: { line: 'Call Ana' } }), { text: { line: 'Call Ana' } });
  // Rule 4 only lifts a pair that starts the text: a required param spelled mid-text stays put.
  assert.deepEqual(repairArgs(RC, { params: 'cell=A2 command=cell.set' }), { params: 'cell=A2 command=cell.set' });
});

/** A16: a near-miss text argument snaps to the user's own span; deliberate transformations never do. */
test('snapToUserText: the Guvf/Gvf case snaps to the user span', () => {
  const user = 'One of the lines in my log is rot13 encoded and it reads Guvf jnf. Decode it for me.';
  assert.equal(snapToUserText(user, 'input', 'Gvf jnf'), 'Guvf jnf');
});

test('snapToUserText: a three-word paraphrase, an uppercased form and short values do not snap', () => {
  const user = 'Encode the text meeting at noon in base64 for me.';
  assert.equal(snapToUserText(user, 'input', 'Meet at noon'), null, 'meeting -> Meet is three edits, over the budget');
  assert.equal(snapToUserText(user, 'input', 'MEETING AT NOON'), null, 'case changes are edits: an uppercasing is far, not near');
  assert.equal(snapToUserText('it reads Guvf jnf here', 'input', 'GUVF JNF'), null);
  assert.equal(snapToUserText(user, 'input', 'noon'), null, 'under the minimum length');
});

test('snapToUserText: only input/text params snap, and verbatim text never does', () => {
  const user = 'Decode the line Guvf jnf and verify it.';
  assert.equal(snapToUserText(user, 'code', 'Gvf jnf'), null, 'code carries commands, not user content');
  assert.equal(snapToUserText(user, 'path', '/notess/jn'), null, 'paths are ruled out by name');
  assert.equal(snapToUserText(user, 'input', 'Guvf jnf'), null, 'verbatim is already the user text');
  assert.equal(snapToUserText('a note that says hello there', 'text', 'hello thre'), 'hello there', 'a text param snaps like input');
});

/** j3 b14 (vectorcraft-06): the model wraps every call in an args= blob; a zero-parameter
    tool has nothing to validate, so the blob must be ignored, not refused (the old
    "has no parameter args; it takes: " was a dead end). */
test('checkArgs: zero-parameter tools ignore whatever arguments arrive', () => {
  const UNDO = { name: 'vectorcraft.undo', params: {} };
  assert.deepEqual(checkArgs(UNDO, { args: '{}' }), { ok: true, args: {} });
  assert.deepEqual(checkArgs(UNDO, { args: '{' }), { ok: true, args: {} });
  assert.deepEqual(checkArgs(UNDO, {}), { ok: true, args: {} });
  assert.deepEqual(checkArgs(UNDO, null), { ok: true, args: {} });
});
