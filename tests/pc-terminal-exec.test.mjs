import test from 'node:test';
import assert from 'node:assert/strict';
import { validateExecRequest, planExec, execReply, base64Encode, handleExecChannelMessage, execGate, MAX_OUTPUT, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, EXEC_ARG_LIMIT } from '../src/scripts/pc/apps/terminal-exec.mjs';

const req = { type: 'exec-request', id: 'r1', from: 'Buddy', lang: 'sh', code: 'echo hi', timeoutMs: DEFAULT_TIMEOUT_MS };

test('request validation: shape, caps, the default timeout and a NUL in the code', () => {
  assert.deepEqual(validateExecRequest({ ...req, timeoutMs: undefined }), { ok: true, id: 'r1', from: 'Buddy', lang: 'sh', code: 'echo hi', timeoutMs: DEFAULT_TIMEOUT_MS });
  assert.equal(validateExecRequest({ ...req }).ok, true);
  assert.equal(validateExecRequest({ ...req, timeoutMs: MAX_TIMEOUT_MS }).ok, true, 'the cap itself is allowed');
  for (const bad of [
    null, {}, { ...req, id: 'bad id!' }, { ...req, id: 'x'.repeat(65) }, { ...req, id: 'a.b' }, { ...req, from: '' }, { ...req, from: 7 },
    { ...req, lang: 'ruby' }, { ...req, code: 42 }, { ...req, code: 'x'.repeat(MAX_OUTPUT + 1) }, { ...req, code: 'a\u0000b' },
    { ...req, timeoutMs: MAX_TIMEOUT_MS + 1 }, { ...req, timeoutMs: 'fast' }, { ...req, timeoutMs: -5 }, { ...req, timeoutMs: NaN },
  ]) assert.equal(validateExecRequest(bad).ok, false, JSON.stringify(bad));
});

test('base64Encode matches the standard alphabet, padding and UTF-8 bytes', () => {
  assert.equal(base64Encode(''), '');
  assert.equal(base64Encode('f'), 'Zg==');
  assert.equal(base64Encode('fo'), 'Zm8=');
  assert.equal(base64Encode('foo'), 'Zm9v');
  assert.equal(base64Encode('foo bar'), 'Zm9vIGJhcg==');
  // Non-ASCII: the UTF-8 bytes, not the UTF-16 code units.
  assert.equal(base64Encode('é'), Buffer.from('é', 'utf8').toString('base64'));
  assert.equal(base64Encode('héllo →'), Buffer.from('héllo →', 'utf8').toString('base64'));
  const roundTrip = 'a\nb\tc\r\x01\x1f end';
  assert.equal(Buffer.from(base64Encode(roundTrip), 'base64').toString('utf8'), roundTrip);
});

test('planExec: small code goes straight into the interpreter -c/-e argument', () => {
  assert.deepEqual(planExec('r3', 'sh', 'echo hi'), { file: '/bin/sh', args: ['-c', 'echo hi'], input: undefined });
  assert.deepEqual(planExec('r3', 'python', 'print(2+2)'), { file: 'python3', args: ['-c', 'print(2+2)'], input: undefined });
  assert.deepEqual(planExec('r3', 'node', 'console.log(1)'), { file: 'node', args: ['-e', 'console.log(1)'], input: undefined });
  assert.equal(planExec('r3', 'sh', 'x'.repeat(EXEC_ARG_LIMIT)).input, undefined, 'the limit itself is still an argument');
});

test('planExec: over the limit the code goes base64 through stdin to a /tmp file', () => {
  const code = 'echo over\n';
  for (const [lang, ext, interpreter] of [['sh', 'sh', '/bin/sh'], ['python', 'py', 'python3'], ['node', 'js', 'node']]) {
    const big = code.repeat(7000); // 70000 UTF-8 bytes, over the 64 KiB argument line
    const plan = planExec('r3', lang, big);
    assert.equal(plan.file, '/bin/sh');
    assert.equal(plan.args[0], '-c');
    const path = `/tmp/webpc-r3.${ext}`;
    assert.equal(plan.args[1], `base64 -d > ${path} && ${interpreter} ${path}`, 'the wrapper decodes the stdin base64, then runs the file');
    assert.ok(plan.args[1].length <= 200, 'the wrapper itself stays a short argument');
    assert.equal(Buffer.from(plan.input, 'base64').toString('utf8'), big, 'the stdin base64 decodes to exactly the code');
  }
});

test('planExec: the limit is UTF-8 bytes, not code units', () => {
  // é is 2 UTF-8 bytes: 32735 of them plus one ASCII byte are exactly EXEC_ARG_LIMIT (65471).
  const at = 'x' + 'é'.repeat(32735);
  assert.equal(planExec('r3', 'sh', at).input, undefined, '65471 bytes fit the argument');
  const over = 'x' + 'é'.repeat(32736); // 65473 bytes, and only 32737 code units (under MAX_CODE)
  const plan = planExec('r3', 'sh', over);
  assert.ok(plan.input, '65473 bytes go to the file');
  assert.equal(Buffer.from(plan.input, 'base64').toString('utf8'), over, 'the base64 is of the UTF-8 bytes');
});

test('execReply: the exit code a shell would report, merged streams, the 64 KB tail', () => {
  assert.deepEqual(execReply({ stdout: 'hello\n', stderr: '', exitCode: 0, signal: null }), { exitCode: 0, output: 'hello\n', truncated: false });
  assert.equal(execReply({ stdout: '', stderr: '', exitCode: null, signal: 13 }).exitCode, 141, 'a signal kill reports 128 + signal, as $? would');
  assert.equal(execReply({ stdout: 'partial', stderr: '', exitCode: null, signal: 9 }).exitCode, 137);
  assert.equal(execReply({ stdout: 'out\n', stderr: 'err\n', exitCode: 0, signal: null }).output, 'out\nerr\n', 'stdout and stderr are joined, the v86 path read one merged stream');
  const big = execReply({ stdout: 'A'.repeat(70000) + 'Z'.repeat(70000), stderr: '', exitCode: 0, signal: null });
  assert.equal(big.output.length, MAX_OUTPUT);
  assert.equal(big.truncated, true);
  assert.ok(!big.output.includes('A') && big.output.startsWith('Z') && big.output.endsWith('Z'), 'the tail is kept, the head dropped');
  const atCap = execReply({ stdout: 'x'.repeat(MAX_OUTPUT), stderr: '', exitCode: 0, signal: null });
  assert.equal(atCap.truncated, false, 'exactly the cap is not truncated');
});

test('execGate: in flight is busy; a stopped guest or a non-owner (snapshot) tab is not-running; the owner with a running guest runs', () => {
  assert.equal(execGate({ owner: true, running: true, inFlight: true }), 'busy');
  assert.equal(execGate({ owner: true, running: false, inFlight: false }), 'not-running', 'a stopped guest runs nothing');
  assert.equal(execGate({ owner: false, running: true, inFlight: false }), 'not-running', 'a snapshot tab (no disk lock) runs nothing');
  assert.equal(execGate({ owner: false, running: false, inFlight: false }), 'not-running');
  assert.equal(execGate({ owner: true, running: true, inFlight: false }), 'run');
});

test('channel triage: exec-request runs at once; exec-cancel matches only the running id; replies and foreign traffic are ignored', () => {
  const runSlot = { req: { id: 'r1' } };
  assert.deepEqual(handleExecChannelMessage({ type: 'exec-request', id: 'r1' }, null), { action: 'request' });
  assert.deepEqual(handleExecChannelMessage({ type: 'exec-request' }, runSlot), { action: 'request' }, 'a request is a request even while a run is in flight');
  assert.deepEqual(handleExecChannelMessage({ type: 'exec-cancel', id: 'r1' }, runSlot), { action: 'cancel' });
  assert.deepEqual(handleExecChannelMessage({ type: 'exec-cancel', id: 'other' }, runSlot), { action: 'ignore' }, 'a different id does not cancel the run');
  assert.deepEqual(handleExecChannelMessage({ type: 'exec-cancel', id: 'r1' }, null), { action: 'ignore' }, 'nothing running, nothing to cancel');
  for (const foreign of [
    { type: 'exec-started', id: 'r1' }, // no longer posted: the run starts with the exec-pending ack
    { type: 'exec-error', id: 'r1', reason: 'invalid' },
    { type: 'exec-error', id: 'r1', reason: 'busy' },
    { type: 'exec-result', id: 'r1', exitCode: 0, output: '' },
    { type: 'exec-pending', id: 'r1' },
    { type: 'pc:theme', theme: 'dark' },
    { type: 'something-else' },
    null, undefined, 'a string', 42,
  ]) assert.deepEqual(handleExecChannelMessage(foreign, runSlot), { action: 'ignore' }, `must ignore: ${JSON.stringify(foreign)}`);
});
