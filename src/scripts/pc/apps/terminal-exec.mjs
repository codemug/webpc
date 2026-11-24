// Pure helpers for the terminal exec service (BroadcastChannel('webpc-terminal'), wired up in
// terminal-unkernel.mjs on top of the unkernel guest's vm.exec()). No DOM and no guest here,
// so every rule is unit-tested in tests/pc-terminal-exec.test.mjs.

export const MAX_OUTPUT = 64 * 1024;
export const MAX_CODE = 64 * 1024;
export const MAX_TIMEOUT_MS = 120000;
export const DEFAULT_TIMEOUT_MS = 30000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/; // shell-safe: it lands in command text and /tmp file names
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// kwtty's OPEN frame is one TLV list: every option value is length-prefixed with 2 bytes
// (kwtty.c OPEN, tag 3 ARG) and the whole frame is at most 65535 bytes, so a code argument
// must leave headroom for the frame around it.
export const EXEC_ARG_LIMIT = 65471; // 65535 minus the frame's fixed and per-argument bytes

export function validateExecRequest(data) {
  if (!data || typeof data !== 'object') return { ok: false };
  const { id, from, lang, code, timeoutMs } = data;
  if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false };
  if (typeof from !== 'string' || from.length === 0 || from.length > 200) return { ok: false };
  if (lang !== 'sh' && lang !== 'python' && lang !== 'node') return { ok: false };
  if (typeof code !== 'string' || code.length > MAX_CODE) return { ok: false };
  if (code.includes('\u0000')) return { ok: false }; // a NUL would break the guest's exec (kwtty refuses it)
  let timeout = DEFAULT_TIMEOUT_MS;
  if (timeoutMs !== undefined) {
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) return { ok: false };
    timeout = Math.round(timeoutMs);
  }
  return { ok: true, id, from, lang, code, timeoutMs: timeout };
}

// Platform-independent base64 (TextEncoder bytes + the standard alphabet): the code's UTF-8
// bytes as [A-Za-z0-9+/=] only, so no control, quote or shell metacharacter can reach the
// guest inside a wrapper line.
export function base64Encode(text) {
  const bytes = new TextEncoder().encode(text);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1] ?? 0, c = bytes[i + 2] ?? 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)] + (i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '=') + (i + 2 < bytes.length ? B64[c & 63] : '=');
  }
  return out;
}

// What vm.exec() runs for a request. Under EXEC_ARG_LIMIT UTF-8 bytes the code goes straight
// into the interpreter's own -c/-e argument; over it (the 64 KiB cap allows it) the code's
// base64 goes through stdin to a /tmp file the interpreter runs, the way the v86 path did,
// because the argument would overflow kwtty's 2-byte option lengths. The wrapper is short;
// the id is shell-safe by construction (ID_RE).
const INTERPRETERS = { sh: '/bin/sh', python: 'python3', node: 'node' };
const EXTENSIONS = { sh: 'sh', python: 'py', node: 'js' };
export function planExec(id, lang, code) {
  const arg = new TextEncoder().encode(code).length <= EXEC_ARG_LIMIT;
  if (arg) return { file: INTERPRETERS[lang], args: [lang === 'node' ? '-e' : '-c', code], input: undefined };
  const path = `/tmp/webpc-${id}.${EXTENSIONS[lang]}`;
  return { file: '/bin/sh', args: ['-c', `base64 -d > ${path} && ${INTERPRETERS[lang]} ${path}`], input: base64Encode(code) };
}

// The reply for a finished vm.exec() run, in the old protocol's shape: the exit code a shell
// would report (128 + signal when a signal ended the program), stdout and stderr joined (the
// v86 path read one merged tty stream), and the tail beyond MAX_OUTPUT kept.
export function execReply(result) {
  const exitCode = result.exitCode !== null ? result.exitCode : 128 + (result.signal ?? 0);
  let output = result.stdout + result.stderr;
  let truncated = false;
  if (output.length > MAX_OUTPUT) { output = output.slice(-MAX_OUTPUT); truncated = true; }
  return { exitCode, output, truncated };
}

// Whether this tab may run the request: one run at a time (busy), the guest must be running,
// and only the tab that holds the saved disk's Web Lock (owner, the boot's lock.held) runs -
// a snapshot tab replies not-running so the owner tab wins (its exec-pending ack cancels the
// client's grace) and, with only a snapshot tab up, the run settles not-running after the grace.
export function execGate({ owner, running, inFlight }) {
  if (inFlight) return 'busy';
  if (!running || !owner) return 'not-running';
  return 'run';
}

// Channel-message triage for the exec protocol: an 'exec-request' runs at once (no approval
// prompt, M3); an 'exec-cancel' for the id this Terminal is running - Buddy's Stop, New chat
// or its wall timer - aborts that run. Everything else, including the replies this Terminal
// posts itself and other apps' traffic, must be ignored: answering a non-request message is
// what made two Terminals bounce exec-error replies forever.
export function handleExecChannelMessage(data, slot) {
  if (data?.type === 'exec-request') return { action: 'request' };
  if (data?.type === 'exec-cancel' && typeof data.id === 'string' && slot && slot.req?.id === data.id) {
    return { action: 'cancel' };
  }
  return { action: 'ignore' };
}
