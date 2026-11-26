// The eval runner's trace-based checks (scripts/agent/eval.mjs): pure, so they run without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkTerminalOutput } from '../scripts/agent/eval.mjs';

const run = output => ({ name: 'call_tool', arguments: { tool: 'terminal.run', lang: 'sh', code: 'uname -a' }, result: { ok: true, tool: 'terminal.run', result: { exitCode: 0, output } } });

test('terminal_output passes when the last terminal.run output contains the text', () => {
  assert.equal(checkTerminalOutput([run('Linux webpc 7.3.4 aarch64\n')], 'Linux').ok, true);
});

test('terminal_output reads the last run, and fails with no run or no match', () => {
  assert.equal(checkTerminalOutput([run('Linux x\n'), run('nothing here\n')], 'Linux').ok, false, 'the last run decides');
  assert.equal(checkTerminalOutput([], 'Linux').ok, false);
  assert.equal(checkTerminalOutput([{ name: 'call_tool', arguments: { tool: 'terminal.status' }, result: { result: { state: 'running' } } }], 'Linux').ok, false);
});
