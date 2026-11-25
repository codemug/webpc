import test from 'node:test';
import assert from 'node:assert/strict';
import { validateExecRequest, planExec, execReply, base64Encode, handleExecChannelMessage, execGate, formatAgentRun, redrawAbovePrompt, isAgentProbeRun, MAX_OUTPUT, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, EXEC_ARG_LIMIT } from '../src/scripts/pc/apps/terminal-exec.mjs';

const req = { type: 'exec-request', id: 'r1', from: 'WebPC Agent', lang: 'sh', code: 'echo hi', timeoutMs: DEFAULT_TIMEOUT_MS };

test('request validation: shape, caps, the default timeout and a NUL in the code', () => {
  assert.deepEqual(validateExecRequest({ ...req, timeoutMs: undefined }), { ok: true, id: 'r1', from: 'WebPC Agent', lang: 'sh', code: 'echo hi', timeoutMs: DEFAULT_TIMEOUT_MS });
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

test('formatAgentRun: the sh header is the code as typed (its newlines become header lines), the output, and a dim exit footer', () => {
  assert.deepEqual(formatAgentRun({ from: 'WebPC Agent', lang: 'sh', code: 'uname -a', exitCode: 0, output: 'Linux unkernel 7.3.4+ aarch64\n', truncated: false, durationMs: 7 }), [
    '\x1b[36mWebPC Agent $ uname -a\x1b[0m',
    'Linux unkernel 7.3.4+ aarch64',
    '\x1b[2m[exit 0 · 7 ms]\x1b[0m',
  ]);
  assert.deepEqual(formatAgentRun({ from: 'W', lang: 'sh', code: 'echo a\necho b', exitCode: 0, output: 'x\n', truncated: false, durationMs: 1 }).slice(0, 3), [
    '\x1b[36mW $ echo a\x1b[0m',
    '\x1b[36mecho b\x1b[0m',
    'x',
  ]);
});

test('formatAgentRun: python and node name the interpreter -c/-e, then the code lines, at most 6 with the note', () => {
  assert.deepEqual(formatAgentRun({ from: 'WebPC Agent', lang: 'python', code: 'a\nb\nc\nd\ne\nf\ng\nh', exitCode: 0, output: 'out\n', truncated: false, durationMs: 2 }), [
    '\x1b[36mWebPC Agent $ python3 -c\x1b[0m',
    '\x1b[36ma\x1b[0m', '\x1b[36mb\x1b[0m', '\x1b[36mc\x1b[0m', '\x1b[36md\x1b[0m', '\x1b[36me\x1b[0m', '\x1b[36mf\x1b[0m',
    '… (2 more lines)',
    'out',
    '\x1b[2m[exit 0 · 2 ms]\x1b[0m',
  ]);
  const node = formatAgentRun({ from: 'WebPC Agent', lang: 'node', code: 'console.log(1)', exitCode: 1, output: '', truncated: false, durationMs: 3 });
  assert.deepEqual(node.slice(0, 2), ['\x1b[36mWebPC Agent $ node -e\x1b[0m', '\x1b[36mconsole.log(1)\x1b[0m']);
  assert.equal(node.at(-1), '\x1b[2m[exit 1 · 3 ms]\x1b[0m');
  const six = formatAgentRun({ from: 'W', lang: 'python', code: 'a\nb\nc\nd\ne\nf', exitCode: 0, output: '', truncated: false, durationMs: 1 });
  assert.equal(six.length, 8, 'one header line + exactly 6 code lines + the footer: no note');
});

test('formatAgentRun: the output shows at most 200 lines, then the note, with no blank line before the footer', () => {
  const many = formatAgentRun({ from: 'W', lang: 'sh', code: 'seq 205', exitCode: 0, output: Array.from({ length: 205 }, (_, i) => `line ${i}`).join('\n') + '\n', truncated: false, durationMs: 1 });
  assert.equal(many.length, 203, 'one header line, 200 output lines, the note, the footer');
  assert.equal(many[1], 'line 0');
  assert.equal(many[200], 'line 199');
  assert.equal(many[201], '… (5 more lines; the agent got the full output)');
  assert.equal(many[202], '\x1b[2m[exit 0 · 1 ms]\x1b[0m');
  const exact = formatAgentRun({ from: 'W', lang: 'sh', code: 'seq 200', exitCode: 0, output: Array.from({ length: 200 }, (_, i) => `l${i}`).join('\n'), truncated: false, durationMs: 1 });
  assert.equal(exact.length, 202, 'exactly 200 lines: no note');
  const empty = formatAgentRun({ from: 'W', lang: 'sh', code: 'true', exitCode: 0, output: '', truncated: false, durationMs: 1 });
  assert.deepEqual(empty, ['\x1b[36mW $ true\x1b[0m', '\x1b[2m[exit 0 · 1 ms]\x1b[0m'], 'no output line at all, no blank line before the footer');
});

test('formatAgentRun: the footer names the ending - exit with ms, timed out, cancelled, error', () => {
  const foot = args => formatAgentRun({ from: 'W', lang: 'sh', code: 'x', exitCode: 0, output: '', truncated: false, durationMs: 9, ...args }).at(-1);
  assert.equal(foot({}), '\x1b[2m[exit 0 · 9 ms]\x1b[0m');
  assert.equal(foot({ exitCode: 3 }), '\x1b[2m[exit 3 · 9 ms]\x1b[0m');
  assert.equal(foot({ reason: 'timeout' }), '\x1b[2m[timed out]\x1b[0m');
  assert.equal(foot({ reason: 'cancelled' }), '\x1b[2m[cancelled]\x1b[0m');
  assert.equal(foot({ reason: 'the guest pty was lost' }), '\x1b[2m[error: the guest pty was lost]\x1b[0m');
});

test('isAgentProbeRun: the readiness sentinel is hidden from the xterm, real commands are not', () => {
  assert.equal(isAgentProbeRun({ lang: 'sh', code: 'echo wcpc-ready-abc123' }), true);
  assert.equal(isAgentProbeRun({ lang: 'sh', code: 'echo wcpc-ready-z9' }), true, 'the token is 1-8 base36 chars');
  assert.equal(isAgentProbeRun({ lang: 'sh', code: 'echo wcpc-ready-' }), false, 'no token is not a probe');
  assert.equal(isAgentProbeRun({ lang: 'sh', code: 'echo wcpc-ready-abc extra' }), false, 'the probe is the single echo line');
  assert.equal(isAgentProbeRun({ lang: 'sh', code: 'echo wcpc-ready-abc; ls' }), false, 'anything after the token is not a probe');
  assert.equal(isAgentProbeRun({ lang: 'python', code: 'echo wcpc-ready-abc' }), false, 'only sh probes run');
  assert.equal(isAgentProbeRun({ lang: 'sh', code: 'echo wcpc-ready-ABC' }), false, 'the token is lowercase base36');
  assert.equal(isAgentProbeRun({ lang: 'sh', code: 'echo hi' }), false, 'a normal echo is not a probe');
});

test('redrawAbovePrompt: erases the prompt line, the block above it, the row restored, the cursor back at its column; every break is \\r\\n', () => {
  const block = ['H', 'O', 'F'];
  assert.equal(redrawAbovePrompt(block, '', 0), '\r\x1b[2KH\r\nO\r\nF\r\n\r', 'an empty row with the cursor at column 0');
  assert.equal(redrawAbovePrompt(block, 'echo hi', 5), '\r\x1b[2KH\r\nO\r\nF\r\necho hi\r\x1b[5C', 'typed text with the cursor mid-line: the column is restored');
  assert.equal(redrawAbovePrompt(block, '', 3), '\r\x1b[2KH\r\nO\r\nF\r\n\r\x1b[3C', 'an empty row with the cursor away from column 0');
  const written = redrawAbovePrompt(formatAgentRun({ from: 'W', lang: 'sh', code: 'echo a\necho b', exitCode: 0, output: 'x\ny\n', truncated: false, durationMs: 1 }), '~ $', 4);
  assert.ok(written.startsWith('\r\x1b[2K'));
  assert.ok(written.endsWith('\r\x1b[4C'));
  assert.ok(written.includes('\r\n'));
  assert.equal(written.replaceAll('\r\n', '').includes('\n'), false, 'the output and the line breaks all reach the terminal as \\r\\n, never a bare \\n');
});
