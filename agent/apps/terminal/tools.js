// Terminal pack: drive the WebPC Linux guest (src/scripts/pc/apps/terminal-unkernel.mjs). The
// guest is unkernel in a module Worker of the app page, so there is no inner iframe to dig
// into; pcHost.appWindow('terminal') resolves the page's own window. Live DOM state:
// #linux-start (enabled only while the guest is stopped and the page is idle) and
// #linux-restart (enabled only while it is running and idle), both set by controls(), plus
// the last status line on #terminal-status (report()). There is no pause and no save: the
// guest's files live on a persistent IndexedDB data disk and are kept automatically.
// terminal.start clicks the page's own #linux-start (no trust check on that button), so the
// agent can start the guest itself and then poll with sleep and status. Code runs over the
// exec bridge (BroadcastChannel webpc-terminal, src/apps/ai-agent/exec-client.js): a valid
// request runs at once on the guest (no approval prompt), and the page's status line says
// what runs and how it ended.
import { ToolError } from '../../../src/apps/ai-agent/runtime/args.mjs';

const APP = 'terminal';
const NEEDS = ['host', 'app:terminal'];
const NOT_HERE = 'The Linux Terminal is not available here (WebPC Agent is not running inside WebPC).';
// The model-facing follow-up while the guest is not running yet: the boot takes a few seconds.
const NEXT = 'call system.sleep seconds=3, then terminal.status, until state is running';

// Gate on ctx.host (needs: ['host', 'app:terminal']), then turn host rejections, which carry a
// code (unknown_app, not_open, not_iframe, timeout, invalid_argument), into a ToolError.
const call = (ctx, fn) => {
  if (!ctx.host) throw new ToolError('not_available', NOT_HERE, '');
  return Promise.resolve()
    .then(() => fn(ctx.host))
    .catch(error => {
      if (error instanceof ToolError) throw error;
      throw new ToolError(error.code || 'app_error', error.message, '');
    });
};

// The appWindow result is the terminal page window itself (no inner iframe).
const page = host => host.appWindow(APP);

// The page exposes no state property, so the buttons are the signal: controls()
// (terminal-unkernel.mjs:35) disables #linux-start unless the guest is stopped and the page
// idle, and #linux-restart unless it is running and idle. While an action is in flight both
// are disabled, and the #terminal-status line then says which one: boot() (and the boot half
// of a restart) reports "Booting Alpine Linux…", while the shutdown half of a restart keeps
// the previous line. So "Booting" names starting, and anything else in flight stays busy.
function readState(win) {
  const start = win.document.getElementById('linux-start');
  const restart = win.document.getElementById('linux-restart');
  const line = win.document.getElementById('terminal-status')?.textContent ?? '';
  if (!start || !restart) return { state: 'unavailable', line };
  if (!restart.disabled) return { state: 'running', line };
  if (!start.disabled) return { state: 'stopped', line };
  return { state: /booting/i.test(line) ? 'starting' : 'busy', line };
}

// terminal.run starts a stopped guest itself and waits for it: small models do not follow the
// not-running hint to call terminal.start (lfm3-1.7b on eval task C16 called terminal.run 14
// times in a row, 2026-11-24). The explicit start, status and sleep tools stay for the model
// and the user to use directly.
const BOOT_WAIT_MS = 90000;
const BOOT_POLL_MS = 250;
// The boot race (sweep-terminal-b17 terminal-01): the page reports the guest running
// (the buttons) before the guest's shell actually runs commands - the first one or two
// commands answer exit 0 with empty output. So before the first command of a boot, prove
// the shell executes: echo a random sentinel and wait until its output comes back.
const READY_TIMEOUT_MS = 5000;
const READY_POLL_MS = 250;
let shellReady = false;

// Test seam: unit tests share the module's shellReady flag across fake guests.
export function resetShellReadiness() { shellReady = false; }

// The token counts only on a line that is not the echoed command line: the guest's
// vm.exec hands back clean output, but if the terminal echo ever leaks into it, the
// echoed "echo <token>" line alone must not prove the shell ready. The probe's shape
// (echo wcpc-ready-<lowercase base36>) is matched by isAgentProbeRun in
// src/scripts/pc/apps/terminal-exec.mjs to hide it from the user's xterm - keep in sync.
function sentinelInOutput(output, token) {
  return String(output).split('\n').some(line => line.includes(token) && !line.includes(`echo ${token}`));
}

async function proveShellReady(bridge, signal) {
  const token = `wcpc-ready-${Math.random().toString(36).slice(2, 10)}`;
  const code = `echo ${token}`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    let reply;
    try {
      reply = await bridge.run({ code, lang: 'sh', timeout_ms: 3000 });
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError(error?.code || 'app_error', error?.message ?? String(error), '');
    }
    if (!reply?.error && reply.exitCode === 0 && typeof reply.output === 'string' && sentinelInOutput(reply.output, token)) {
      shellReady = true;
      return;
    }
    if (signal?.aborted) throw new ToolError('aborted', 'The run was stopped before the shell proved ready.', '');
    if (Date.now() > deadline) throw new ToolError('not_running',
      `Linux reports running but its shell never echoed the readiness check (${code}) within ${READY_TIMEOUT_MS / 1000} s - its commands are not executing (a fresh boot swallows the first commands, or the exec channel went dead after an earlier run)`,
      'call system.sleep seconds=3, then terminal.status');
    await new Promise(resolve => setTimeout(resolve, READY_POLL_MS));
  }
}
async function ensureRunning(win, signal) {
  let { state, line } = readState(win);
  if (state === 'running') return;
  if (state === 'stopped') { win.document.getElementById('linux-start').click(); state = 'starting'; }
  const deadline = Date.now() + BOOT_WAIT_MS;
  while (state !== 'running') {
    if (signal?.aborted) throw new ToolError('aborted', 'The run was stopped before Linux finished starting.', '');
    if (state === 'unavailable' || Date.now() > deadline) throw new ToolError('not_running', `Linux did not start (state ${state}): ${line}`, 'call terminal.status to see why');
    await new Promise(resolve => setTimeout(resolve, BOOT_POLL_MS));
    ({ state, line } = readState(win));
    if (state === 'stopped') throw new ToolError('not_running', `Linux stopped while starting: ${line}`, 'call terminal.start, then terminal.status');
  }
}

export const pack = { id: APP, title: 'Terminal' };

export const tools = [
  {
    name: 'terminal.open',
    purpose: 'Open the Linux Terminal app window.',
    when: 'Use when the user wants the terminal, or before running code so the run is visible in the window.',
    params: {},
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Open the terminal' }],
    // appWindow opens the app if it is not open and resolves once it posted pc:ready (desktop.js:626).
    run: async (args, ctx) => call(ctx, async host => {
      await page(host);
      return { opened: true };
    }),
  },
  {
    name: 'terminal.start',
    purpose: 'Start the Linux guest; opens the Terminal window if it is not open.',
    when: 'Use when Linux must be running: before running code, or when the user asks to start Linux.',
    params: {},
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Start Linux' }],
    // Clicks the page's own start button (#linux-start has no trust check: onclick is
    // () => action(boot), terminal-unkernel.mjs:253). The click flips both buttons disabled
    // synchronously (action() sets busy before the boot), and the "Booting Alpine Linux…"
    // status line arrives a few awaits later, so right after the click the state is named
    // starting directly; if the guest already ran, the read-back says running.
    run: async (args, ctx) => call(ctx, async host => {
      const win = await page(host);
      const start = win.document.getElementById('linux-start');
      const clicked = Boolean(start) && !start.disabled;
      if (clicked) start.click();
      const state = clicked ? 'starting' : readState(win).state;
      return { state, next: NEXT };
    }),
  },
  {
    name: 'terminal.status',
    purpose: 'Check whether the Linux guest is running, stopped, starting or busy.',
    when: 'Use when the user asks about the Linux guest, or before running code.',
    params: {},
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Is Linux running?' }],
    // readState() names the state from the two button states and the status line (the
    // line usually explains an unusual state, for example that the browser cannot run
    // the Terminal). While the state is not running, the next hint tells the model how
    // to wait for the boot.
    run: async (args, ctx) => call(ctx, async host => {
      const { state, line } = readState(await page(host));
      return { state, status: line, ...(state === 'running' ? {} : { next: NEXT }) };
    }),
  },
  {
    name: 'terminal.run',
    purpose: 'Run a shell command (uname, ls, pip) or Python/Node code in the Linux terminal.',
    when: 'Use when the user wants any command, script or code run in Linux or the terminal.',
    // A4: program names live in the guest, not the tool text, so an inner name (find_tool
    // "grep") or an install intent would not match. Common guest programs index this tool;
    // generic words (date, echo, test) are deliberately left out - they would pull shell runs
    // into unrelated queries.
    keywords: ['ls', 'cat', 'grep', 'sed', 'awk', 'wc', 'head', 'tail', 'sort', 'uniq', 'find', 'which', 'whoami', 'uname', 'df', 'du', 'free', 'top', 'ps', 'kill', 'mkdir', 'cp', 'mv', 'rm', 'touch', 'chmod', 'chown', 'tar', 'gzip', 'zip', 'curl', 'wget', 'ssh', 'scp', 'git', 'python', 'python3', 'node', 'npm', 'pip', 'pip3', 'nano', 'vim', 'less', 'basename', 'dirname', 'realpath', 'ping', 'traceroute', 'ifconfig', 'netstat', 'jq', 'base64', 'od', 'xxd', 'file', 'diff', 'make', 'apk', 'apt', 'busybox', 'strace', 'gdb'],
    params: {
      lang: { type: 'enum', values: ['python', 'node', 'sh'], default: 'sh', description: 'Language of the code (default sh)' },
      code: { type: 'text', required: true, description: 'Code to run in the guest' },
      timeout_ms: { type: 'integer', min: 1, max: 120000, description: 'Optional run limit in milliseconds (default 30000); the run is killed at the limit' },
    },
    effect: 'external',
    needs: NEEDS,
    examples: [
      { args: { lang: 'sh', code: 'uname -a' }, says: 'Run uname -a in the Linux terminal' },
      { args: { lang: 'sh', code: 'ls -la' }, says: 'Run a shell command in the terminal' },
      { args: { lang: 'sh', code: 'ls /bin /sbin /usr/bin /usr/sbin' }, says: 'Which commands, CLI tools or network inspection tools does the Linux terminal have' },
      { args: { lang: 'python', code: 'print(6 * 7)' }, says: 'Run this Python code' },
    ],
    // Open the window first so the user sees the run (the status line says what runs and its
    // result). Then prove the shell is actually executing (a fresh boot's first commands are
    // swallowed - boot race) and delegate to the run_code bridge (ctx.legacy.run_code, wired
    // by src/apps/ai-agent/app.js over the webpc-terminal BroadcastChannel); its reply is
    // already model-facing: { exitCode, output, truncated } or
    // { error } for not-running / busy / no-terminal / timeout / cancelled.
    run: async (args, ctx) => call(ctx, async host => {
      const win = await page(host);
      const wasRunning = readState(win).state === 'running';
      await ensureRunning(win, ctx.signal);
      if (!wasRunning) resetShellReadiness(); // a fresh boot is a fresh shell
      const bridge = ctx.legacy?.run_code;
      if (!bridge) throw new ToolError('not_available', 'the run_code bridge is not wired here (the Linux guest tools are unavailable)', '');
      if (!shellReady) await proveShellReady(bridge, ctx.signal);
      const reply = await bridge.run({ code: args.code, lang: args.lang, timeout_ms: args.timeout_ms });
      // sweep-terminal-b19 (terminal-01: 27 rounds of {exitCode:0, output:""}): after the
      // oracle phase the guest's exec session went silent - well-formed success replies
      // with empty output - and the boot proof never re-ran on an already-running guest.
      // Re-prove once on that shape: if the sentinel answers, the shell is live and an
      // empty output is a legitimate answer, so the original reply stands; if it does not,
      // proveShellReady throws the honest not_running within READY_TIMEOUT_MS instead of
      // the model burning rounds on empty successes.
      if (!reply?.error && reply?.exitCode === 0 && !reply.output) {
        resetShellReadiness();
        await proveShellReady(bridge, ctx.signal);
      }
      return reply;
    }),
  },
];
