// Unit tests for the eval runner's pure check logic (scripts/agent/eval.mjs): the shared
// check-kind list and validators, dot-notation path reading, value comparisons, the answer
// checks and tool_result over a fake trace. No browser, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECK_KINDS, validateCheck, readPath, valuesEqual, compareValue, checkAnswer, checkToolResult,
  checkReadTool, checkTerminalOutput, normalizeText, oracleAnswerText, toRegExp, fillStepRefs, within,
} from '../scripts/agent/eval.mjs';

/** The shared kind list covers the old task kinds and the five journey kinds. */
test('CHECK_KINDS covers the old task kinds and the journey kinds', () => {
  const kinds = new Set(CHECK_KINDS);
  for (const kind of ['window_open', 'theme', 'file_exists', 'file_contains', 'cell', 'docs_text_contains', 'excalidraw_count_at_least', 'cyberchef_output', 'terminal_output']) assert.ok(kinds.has(kind), `missing old kind ${kind}`);
  for (const kind of ['file_matches', 'answer_contains', 'answer_matches', 'tool_result', 'craft_request', 'read_tool']) assert.ok(kinds.has(kind), `missing new kind ${kind}`);
});

/** validateCheck accepts the well-formed shapes and rejects the broken ones. */
test('validateCheck accepts well-formed checks and rejects broken shapes', () => {
  const good = [
    ['window_open', 'gridcraft'],
    ['theme', 'dark'],
    ['file_exists', '/notes.txt'],
    ['file_contains', { path: 'a.txt', text: 'hi' }],
    ['file_matches', { path: 'a.txt', regex: '^hi' }],
    ['cell', { app: 'gridcraft', cell: 'A1', input: 'x' }],
    ['docs_text_contains', 'hello'],
    ['excalidraw_count_at_least', 2],
    ['cyberchef_output', 'ok'],
    ['terminal_output', 'ok'],
    ['answer_contains', '42'],
    ['answer_matches', '\\d+'],
    ['tool_result', { tool: 'terminal.run', path: 'output', contains: 'hi' }],
    ['tool_result', { tool: 'terminal.run', path: 'exitCode', equals: 0 }],
    ['tool_result', { tool: 'pdfcraft.text_find', contains: '4821' }], // no path: over the whole result
    ['craft_request', { app: 'gridcraft', method: 'cell.get', params: { cell: 'A1' }, expect: { path: 'input', equals: 'x' } }],
    ['craft_request', { app: 'lightcraft', method: 'library.info', expect: { path: 'count', at_least: 1 } }],
    ['docs_text_contains', { text: 'Hello', exact: true }],
    ['terminal_output', { text: 'ok' }],
    ['answer_contains', { text: '42', exact: true }],
    ['file_contains', { path: 'a.txt', text: 'hi', exact: true }],
    ['tool_result', { tool: 'terminal.run', path: 'output', contains: 'hi', exact: true }],
    ['tool_result', { tool: 'terminal.run', path: 'output', contains: 'hi', any: true }], // T17: any-result mode
    ['craft_request', { app: 'gridcraft', method: 'cell.get', expect: { path: 'input', contains: 'x', exact: true } }],
    ['read_tool', { tool: 'gridcraft.inspect', args: { sheet: 'Sheet1' }, path: 'rows', at_least: 1 }],
    ['read_tool', { tool: 'deckcraft.inspect', contains: 'Q1' }],
    ['read_tool', { tool: 'lightcraft.library_info', path: 'count', equals: 3, exact: true }],
  ];
  for (const [kind, value] of good) {
    const res = validateCheck(kind, value);
    assert.ok(res.ok, `${kind} ${JSON.stringify(value)} should be well-formed: ${res.detail}`);
  }
  const bad = [
    ['window_open', ''],
    ['theme', 'sepia'],
    ['file_contains', { path: 'a.txt' }],
    ['file_matches', { path: 'a.txt', regex: '' }],
    ['excalidraw_count_at_least', '2'],
    ['tool_result', { tool: 'a.b', path: 'p', contains: 'x', equals: 1 }], // two comparators
    ['tool_result', { tool: 'a.b', path: 'p' }], // no comparator
    ['tool_result', { tool: 'a.b', path: 3, contains: 'x' }], // path must be a string
    ['craft_request', { app: 'gridcraft', method: 'cell.get', expect: { equals: 1 } }], // no path
    ['craft_request', { app: 'gridcraft', method: 'cell.get', expect: { path: 'input', equals: 1, contains: 'x' } }],
    ['answer_contains', ''],
    ['answer_contains', { text: '' }],
    ['file_contains', { path: 'a.txt', text: { x: 1 } }],
    ['tool_result', { tool: 'a.b', path: 'p', contains: 'x', exact: 'yes' }], // exact must be a boolean
    ['tool_result', { tool: 'a.b', contains: 'x', any: 'yes' }], // any must be a boolean
    ['read_tool', { tool: 'a.b', contains: 'x', equals: 1 }], // two comparators
    ['read_tool', { tool: 'a.b', args: [1], contains: 'x' }], // args must be an object
    ['read_tool', { tool: 'a.b', path: 2, contains: 'x' }], // path must be a string
    ['no_such_kind', 'x'],
  ];
  for (const [kind, value] of bad) {
    const res = validateCheck(kind, value);
    assert.ok(!res.ok, `${kind} ${JSON.stringify(value)} should be rejected`);
    assert.ok(typeof res.detail === 'string' && res.detail.length > 0, `${kind} rejection carries a detail`);
  }
});

/** readPath walks dot notation with [n] indexes; anything else is undefined. */
test('readPath reads dot paths with indexes', () => {
  assert.equal(readPath({ a: { b: 1 } }, 'a.b'), 1);
  assert.equal(readPath({ a: [{ b: 7 }, { b: 8 }] }, 'a[1].b'), 8);
  assert.equal(readPath({ a: { b: { c: 'x' } } }, 'a.b.c'), 'x');
  assert.equal(readPath([9, 10], '[0]'), 9);
  assert.equal(readPath({ a: 1 }, 'a.b'), undefined);
  assert.equal(readPath({ a: [1] }, 'a[5]'), undefined);
  assert.equal(readPath({ a: [1] }, 'a[0]'), 1);
  assert.equal(readPath({ a: 1 }, 'a[0'), undefined); // unbalanced bracket
  assert.equal(readPath(null, 'a'), undefined);
  assert.equal(readPath({ a: { b: null } }, 'a.b.c'), undefined);
});

/** equals compares numerically when both sides parse as numbers. */
test('valuesEqual compares numbers numerically', () => {
  assert.ok(valuesEqual(3, '3'));
  assert.ok(valuesEqual('3.0', 3));
  assert.ok(valuesEqual('42', 42));
  assert.ok(valuesEqual('a', 'a'));
  assert.ok(valuesEqual({ a: 1, b: [2] }, { a: 1, b: [2] })); // whole-result equals
  assert.ok(!valuesEqual({ a: 1 }, { a: 2 }));
  assert.ok(!valuesEqual('a', 'b'));
  assert.ok(!valuesEqual('a', 1)); // a string that is not a number is not equal to 1
  assert.ok(!valuesEqual(null, 0));
  assert.ok(!valuesEqual('1', true)); // booleans are not numbers here
  assert.ok(!valuesEqual('', 0)); // blank is not a number
});

/** compareValue: one comparison in each of the four shapes. */
test('compareValue does contains, equals, matches and at_least', () => {
  assert.ok(compareValue('all good', { contains: 'good' }).ok);
  assert.ok(!compareValue('nope', { contains: 'good' }).ok);
  assert.ok(!compareValue(null, { contains: 'good' }).ok);
  assert.ok(compareValue('42', { equals: 42 }).ok);
  assert.ok(!compareValue('41', { equals: 42 }).ok);
  assert.ok(compareValue('done', { equals: 'done' }).ok);
  assert.ok(compareValue('hello world', { matches: '^hello' }).ok);
  assert.ok(!compareValue('world', { matches: '^hello' }).ok);
  const bad = compareValue('x', { matches: '[' });
  assert.ok(!bad.ok && bad.detail.includes('bad regex'));
  assert.ok(compareValue('5', { at_least: 3 }).ok);
  assert.ok(!compareValue('2', { at_least: 3 }).ok);
  assert.ok(!compareValue('x', { at_least: 1 }).ok);
  assert.ok(!compareValue(null, { at_least: 1 }).ok);
  assert.ok(!compareValue('x', {}).ok); // no comparator
});

/** The answer checks run against the final reply text (normalised unless exact). */
test('checkAnswer checks the final answer', () => {
  assert.ok(checkAnswer('the answer is 42', 'answer_contains', { text: '42' }).ok);
  assert.ok(!checkAnswer('the answer is 43', 'answer_contains', { text: '42' }).ok);
  assert.ok(checkAnswer('The Answer is  42', 'answer_contains', { text: 'the answer is 42' }).ok); // case and whitespace
  assert.ok(!checkAnswer('The Answer is 42', 'answer_contains', { text: 'the answer is 42', exact: true }).ok);
  assert.ok(checkAnswer('done in 3 steps', 'answer_matches', { text: 'in [0-9]+ step' }).ok);
  assert.ok(!checkAnswer('done', 'answer_matches', { text: '^nope' }).ok);
  const empty = checkAnswer('', 'answer_contains', { text: 'x' });
  assert.ok(!empty.ok && empty.detail.includes('no final answer'));
  const bad = checkAnswer('x', 'answer_matches', { text: '[' });
  assert.ok(!bad.ok && bad.detail.includes('bad regex'));
});

/** Normalisation: collapse whitespace, trim, lowercase; exact keeps it as-is. */
test('normalizeText collapses whitespace and case unless exact', () => {
  assert.equal(normalizeText('  Hello   WORLD  ', false), 'hello world');
  assert.equal(normalizeText('  Hello   WORLD  ', true), '  Hello   WORLD  ');
  assert.equal(normalizeText('a\nb\tc', false), 'a b c');
});

/** contains ignores case and repeated whitespace unless exact: true. */
test('compareValue contains normalises unless exact', () => {
  assert.ok(compareValue('All Good', { contains: 'good' }).ok);
  assert.ok(compareValue('a  b\n c', { contains: 'a b c' }).ok);
  assert.ok(!compareValue('All Good', { contains: 'good', exact: true }).ok);
  assert.ok(compareValue('All Good', { contains: 'Good', exact: true }).ok);
});

/** terminal_output reads the last terminal.run result, normalised unless exact. */
test('checkTerminalOutput normalises the output unless exact', () => {
  const trace = [{ name: 'call_tool', arguments: { tool: 'terminal.run' }, result: { ok: true, tool: 'terminal.run', result: { exitCode: 0, output: 'Hello   World\n' } } }];
  assert.ok(checkTerminalOutput(trace, { text: 'hello world' }).ok);
  assert.ok(checkTerminalOutput(trace, { text: 'Hello   World', exact: true }).ok);
  assert.ok(!checkTerminalOutput(trace, { text: 'HELLO   WORLD', exact: true }).ok);
  assert.ok(!checkTerminalOutput(trace, { text: 'nope' }).ok);
});

/** read_tool calls the read tool through the page (a fake frame) and tests the result. */
test('checkReadTool calls the read tool and tests its result', async () => {
  const okRes = { ok: true, tool: 'gridcraft.inspect', result: { rows: [1, 2, 3], summary: 'three rows' } };
  const frame = (res) => ({ evaluate: async () => res });
  assert.ok((await checkReadTool(frame(okRes), { tool: 'gridcraft.inspect', path: 'rows', equals: [1, 2, 3] })).ok);
  assert.ok((await checkReadTool(frame(okRes), { tool: 'gridcraft.inspect', contains: 'three rows' })).ok); // whole result
  assert.ok(!(await checkReadTool(frame(okRes), { tool: 'gridcraft.inspect', contains: 'four rows' })).ok);
  assert.ok(!(await checkReadTool(frame(okRes), { tool: 'gridcraft.inspect', path: 'rows', equals: 4 })).ok);
  const failed = await checkReadTool(frame({ ok: false, error: { type: 'not_available', message: 'no window' } }), { tool: 'gridcraft.inspect', contains: 'x' });
  assert.ok(!failed.ok && failed.detail.includes('failed'));
  const noBuddy = await checkReadTool(null, { tool: 'gridcraft.inspect', contains: 'x' });
  assert.ok(!noBuddy.ok && noBuddy.detail.includes('journey runner'));
});

/** A trace with the call_tool wrapper and a direct catalog call. */
const WRAPPED = { name: 'call_tool', arguments: { tool: 'terminal.run' }, result: { ok: true, tool: 'terminal.run', result: { exitCode: 0, output: 'first\n' } } };
const WRAPPED_LATER = { name: 'call_tool', arguments: { tool: 'terminal.run' }, result: { ok: true, tool: 'terminal.run', result: { exitCode: 0, output: 'second\n' } } };
const DIRECT = { name: 'media.analyze', arguments: { path: '/a.png' }, result: { width: 240, height: 160 } };

/** tool_result reads the last result of the named tool at the path (or over the whole result). */
test('checkToolResult reads the last result of the named tool', () => {
  const trace = [WRAPPED, DIRECT, WRAPPED_LATER];
  assert.ok(checkToolResult(trace, { tool: 'terminal.run', path: 'output', contains: 'second' }).ok);
  assert.ok(!checkToolResult(trace, { tool: 'terminal.run', path: 'output', contains: 'first' }).ok); // the last call wins
  assert.ok(checkToolResult(trace, { tool: 'terminal.run', path: 'exitCode', equals: 0 }).ok);
  assert.ok(checkToolResult(trace, { tool: 'media.analyze', path: 'width', equals: 240 }).ok);
  assert.ok(checkToolResult(trace, { tool: 'media.analyze', path: 'height', at_least: 100 }).ok);
  // No path: the comparator runs over the whole result (JSON text for objects).
  assert.ok(checkToolResult(trace, { tool: 'media.analyze', contains: '"width":240' }).ok);
  assert.ok(checkToolResult(trace, { tool: 'media.analyze', equals: { width: 240, height: 160 } }).ok);
  assert.ok(!checkToolResult(trace, { tool: 'media.analyze', equals: { width: 241, height: 160 } }).ok);
  const missing = checkToolResult(trace, { tool: 'nettools.dig', path: 'a', equals: 1 });
  assert.ok(!missing.ok && missing.detail.includes('no nettools.dig call'));
  // A session-level refusal (the identical-fail stop) never ran the tool, so the check reads
  // the last real result behind it (sweep b17 terminal-08/10: stopped duplicates end the trace).
  const stopped = [
    { name: 'terminal.run', arguments: { command: 'ls' }, result: { ok: true, tool: 'terminal.run', result: { exitCode: 0, output: 'total 12\n' } } },
    { name: 'terminal.run', arguments: { command: 'ls' }, result: { error: 'Stopped: this exact call already failed twice' } },
  ];
  assert.ok(checkToolResult(stopped, { tool: 'terminal.run', path: 'output', contains: 'total' }).ok, 'a stopped duplicate is not the tool\'s last result');
  const refusedOnly = [stopped[1]];
  assert.ok(!checkToolResult(refusedOnly, { tool: 'terminal.run', path: 'output', contains: 'total' }).ok, 'a trace of refusals has no result');
});

/** T17 (sweep-terminal-b20 01): any: true matches any result of the named tool - the prompt
 *  asked for a listing, not for it to be the last command. The default stays last. */
test('checkToolResult any: true matches an earlier result, not only the last', () => {
  const trace = [WRAPPED, DIRECT, WRAPPED_LATER];
  assert.ok(checkToolResult(trace, { tool: 'terminal.run', path: 'output', contains: 'first', any: true }).ok, 'the earlier result matches');
  assert.ok(!checkToolResult(trace, { tool: 'terminal.run', path: 'output', contains: 'first' }).ok, 'without any the last result still wins');
  const miss = checkToolResult(trace, { tool: 'terminal.run', path: 'output', contains: 'nope', any: true });
  assert.ok(!miss.ok && miss.detail.includes('none of the 2'), miss.detail);
  assert.ok(checkToolResult(trace, { tool: 'media.analyze', path: 'width', equals: 240, any: true }).ok, 'any works with a path too');
});

/** Oracle runs have no reply, so answer checks read the oracle's tool results. */
test('oracleAnswerText joins every tool result so an answer check can find the fact', () => {
  const text = oracleAnswerText([{ result: { rows: [{ name: 'Ana', n: 9 }] } }, { result: 'The and' }, { result: null }]);
  assert.equal(checkAnswer(text, 'answer_contains', { text: 'the AND' }).ok, true);
  assert.equal(checkAnswer(text, 'answer_matches', { text: '"n":9\\b' }).ok, true);
  assert.equal(checkAnswer(text, 'answer_matches', { text: '"n":19\\b' }).ok, false);
  assert.equal(checkAnswer(text, 'answer_contains', { text: 'This was' }).ok, false);
  assert.equal(oracleAnswerText([]), '');
});

/** Authors write (?i) as in other regex dialects; JavaScript needs it as a flag. */
test('toRegExp turns a leading (?i) into the i flag and leaves other patterns alone', () => {
  assert.equal(toRegExp('(?i)\\b(3|three) circles\\b').test('I count THREE circles'), true);
  assert.equal(toRegExp('#FF5A5F').test('#ff5a5f'), false);
  assert.equal(checkAnswer('fill is #FF5A5F', 'answer_matches', { text: '(?i)#ff5a5f' }).ok, true);
});

/** equals on two texts follows the text rule; numbers and exact: true still compare strictly. */
test('equals ignores case and spacing on text unless exact, and stays numeric for numbers', () => {
  assert.equal(compareValue('RECTANGLE', { equals: 'rectangle' }).ok, true);
  assert.equal(compareValue('RECTANGLE', { equals: 'rectangle', exact: true }).ok, false);
  assert.equal(compareValue('8.9', { equals: '8.90' }).ok, true);
  assert.equal(compareValue(17, { equals: 33 }).ok, false);
});

/** Oracles can act on ids the app hands out at run time. */
test('fillStepRefs takes an earlier step result at a path and leaves plain args alone', () => {
  const results = [{ shapes: [{ id: 'sp7', text: 'Q3' }] }, { ok: true }];
  assert.deepEqual(fillStepRefs({ shape_id: '${0.shapes[0].id}', text: 'Q4', note: 'cost ${0}' }, results), { shape_id: 'sp7', text: 'Q4', note: 'cost ${0}' });
  assert.equal(fillStepRefs({ id: '${3.x}' }, results).id, undefined);
});

/** A range brackets a value the app rounds (a 5 s comp reads back 5.005). */
test('at_least and at_most bracket a number; a range and an exact comparator do not mix', () => {
  assert.equal(compareValue(5.005, { at_least: 4.99, at_most: 5.01 }).ok, true);
  assert.equal(compareValue(10.01, { at_least: 4.99, at_most: 5.01 }).ok, false);
  assert.equal(compareValue(3, { at_most: 3 }).ok, true);
  assert.equal(validateCheck('read_tool', { tool: 'x.y', at_least: 1, at_most: 2 }).ok, true);
  assert.equal(validateCheck('read_tool', { tool: 'x.y', equals: 1, at_most: 2 }).ok, false);
  assert.equal(validateCheck('craft_request', { app: 'a', method: 'm', expect: { path: 'p', at_most: 2 } }).ok, true);
});

/** A page step that never settles must not hang the queue. */
test('within rejects a step that does not settle in time and passes one that does', async () => {
  await assert.rejects(within(new Promise(() => {}), 20, 'check read_tool'), /check read_tool did not finish within 0.02 s/);
  assert.equal(await within(Promise.resolve(7), 1000, 'x'), 7);
});
