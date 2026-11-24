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
    // result). Then delegate to the run_code bridge (ctx.legacy.run_code, wired
    // by src/apps/ai-agent/app.js over the webpc-terminal BroadcastChannel); its reply is
    // already model-facing: { exitCode, output, truncated } or
    // { error } for not-running / busy / no-terminal / timeout / cancelled.
    run: async (args, ctx) => call(ctx, async host => {
      await ensureRunning(await page(host), ctx.signal);
      const bridge = ctx.legacy?.run_code;
      if (!bridge) throw new ToolError('not_available', 'the run_code bridge is not wired here (the Linux guest tools are unavailable)', '');
      return bridge.run({ code: args.code, lang: args.lang, timeout_ms: args.timeout_ms });
    }),
  },
];
