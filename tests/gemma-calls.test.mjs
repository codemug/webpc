// Unit tests for src/apps/ai-agent/gemma-calls.js: Gemma 4's tool-call markup to the
// canonical form the agent reads (parseToolCalls, agent.js). The verbatim sample is
// the one measured on 2026-11-24 with the pinned Transformers.js 4.3.2 (decoded with
// skip_special_tokens: false); the value syntax is the chat template's format_argument.
// Every canonical assertion runs the translated text through the real parseToolCalls.
// Pure functions under test: no DOM, no network.
// Run: node --test tests/gemma-calls.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gemmaToCanonical, gemmaVisible } from '../src/apps/ai-agent/gemma-calls.js';
import { parseToolCalls } from '../src/apps/ai-agent/agent.js';

// The verbatim reply measured from Gemma 4 E2B: one call, then the response marker.
const SAMPLE = '<|tool_call>call:call_tool{app:<|"|>Terminal<|"|>,tool:<|"|>desktop.open_app<|"|>}<tool_call|><|tool_response>';

test('the measured sample becomes exactly one canonical call', () => {
  assert.deepEqual(parseToolCalls(gemmaToCanonical(SAMPLE)),
    [{ name: 'call_tool', arguments: { app: 'Terminal', tool: 'desktop.open_app' } }]);
});

test('two calls in one reply stay in order and the prose between is kept', () => {
  const text = 'Let me open Docs and then focus it.'
    + '<|tool_call>call:call_tool{app:<|"|>Docs<|"|>,tool:<|"|>desktop.open_app<|"|>}<tool_call|>'
    + '<|tool_call>call:call_tool{app:<|"|>Docs<|"|>,tool:<|"|>desktop.focus<|"|>}<tool_call|><turn|>';
  const out = gemmaToCanonical(text);
  assert.ok(out.startsWith('Let me open Docs and then focus it.'), 'the prose before the calls is kept');
  const calls = parseToolCalls(out);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].arguments.app, 'Docs');
  assert.equal(calls[0].arguments.tool, 'desktop.open_app');
  assert.equal(calls[1].arguments.tool, 'desktop.focus');
});

test('a string keeps commas, braces, a colon and a newline exactly', () => {
  const code = 'if (x) { print("a,b:c") }\n    end';
  const text = '<|tool_call>call:call_tool{app:<|"|>terminal<|"|>,tool:<|"|>terminal.run<|"|>,lang:<|"|>sh<|"|>,code:<|"|>' + code + '<|"|>}<tool_call|>';
  const calls = parseToolCalls(gemmaToCanonical(text));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].arguments, { app: 'terminal', tool: 'terminal.run', lang: 'sh', code });
});

test('a string keeps a fake closing call token as literal text', () => {
  const value = 'echo <|tool_call|x<tool_call|>y';
  const text = '<|tool_call>call:call_tool{code:<|"|>' + value + '<|"|>}<tool_call|>';
  const calls = parseToolCalls(gemmaToCanonical(text));
  assert.equal(calls.length, 1, 'the closing token inside the string is not the end of the call');
  assert.equal(calls[0].arguments.code, value);
});

test('numbers, booleans and null come back as their bare text', () => {
  const text = '<|tool_call>call:call_tool{n:42,f:-3.5,t:true,fl:false,z:null}<tool_call|>';
  assert.deepEqual(parseToolCalls(gemmaToCanonical(text))[0].arguments,
    { n: '42', f: '-3.5', t: 'true', fl: 'false', z: 'null' });
});

test('a nested list and object become their JSON text', () => {
  const text = '<|tool_call>call:call_tool{rows:[1,<|"|>two<|"|>],meta:{k:<|"|>v<|"|>,deep:[true,null]}}<tool_call|>';
  const args = parseToolCalls(gemmaToCanonical(text))[0].arguments;
  assert.equal(args.rows, '[1,"two"]');
  assert.equal(args.meta, '{"k":"v","deep":[true,null]}');
});

test('prose around calls is kept and control tokens are stripped from it', () => {
  assert.equal(gemmaToCanonical('Checking now.<turn|>'), 'Checking now.');
  assert.equal(gemmaToCanonical('A<eos>B<|turn>C<tool_response|>D<|"|>E'), 'ABCDE');
  const out = gemmaToCanonical('Prose<|tool_call>call:noop{}<tool_call|>tail<|tool_response>');
  assert.ok(out.startsWith('Prose'));
  assert.ok(out.endsWith('tail'));
  assert.deepEqual(parseToolCalls(out), [{ name: 'noop', arguments: {} }]);
});

test('an unterminated call tail is dropped, not half-parsed', () => {
  assert.equal(gemmaToCanonical('Hello<|tool_call>call:cut{a:<|"|>x'), 'Hello');
  assert.equal(gemmaToCanonical('Hello<|tool_call>call:cut{a:<|"|>x<|"|>}'), 'Hello');
});

test('an unparseable closed call span is dropped whole', () => {
  assert.equal(gemmaToCanonical('A<|tool_call>not-a-call<tool_call|>B'), 'AB');
});

test('plain prose without any markup is returned unchanged', () => {
  const prose = 'The kernel is 6.6.14-0-lts.\nAll good.';
  assert.equal(gemmaToCanonical(prose), prose);
  assert.equal(gemmaVisible(prose), prose);
});

test('gemmaVisible cuts at the first call', () => {
  assert.equal(gemmaVisible('Opening it.<|tool_call>call:call_tool{app:<|"|>T<|"|>}<tool_call|>and more'), 'Opening it.');
});

test('gemmaVisible holds back a trailing partial token', () => {
  assert.equal(gemmaVisible('Done <|tool'), 'Done ');
  assert.equal(gemmaVisible('Done <tur'), 'Done ');
  assert.equal(gemmaVisible('Done <|t'), 'Done ');
  assert.equal(gemmaVisible('Done <'), 'Done ');
});

test('gemmaVisible strips control tokens and holds back partials after stripping', () => {
  assert.equal(gemmaVisible('Done<turn|>'), 'Done');
  assert.equal(gemmaVisible('Done<eos><tur'), 'Done');
  assert.equal(gemmaVisible('<|"|>quoted<|"|>'), 'quoted');
});
