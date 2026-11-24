// Terminal pack: drive the WebPC Linux guest (src/scripts/pc/apps/terminal-unkernel.mjs). The
// guest is unkernel in a module Worker of the app page, so there is no inner iframe to dig
// into; pcHost.appWindow('terminal') resolves the page's own window. Live DOM state:
// #linux-start (enabled only while the guest is stopped and the page is idle) and
// #linux-restart (enabled only while it is running and idle), both set by controls(), plus
// the last status line on #terminal-status (report()). There is no pause and no save: the
// guest's files live on a persistent IndexedDB data disk and are kept automatically. Code
// runs over the exec bridge (BroadcastChannel webpc-terminal, src/apps/ai-agent/exec-client.js):
// a valid request runs at once on the guest (no approval prompt), and the page's status line
// says what runs and how it ended.
import { ToolError } from '../../../src/apps/ai-agent/runtime/args.mjs';

const APP = 'terminal';
const NEEDS = ['host', 'app:terminal'];
const NOT_HERE = 'The Linux Terminal is not available here (Buddy is not running inside WebPC).';

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
    name: 'terminal.status',
    purpose: 'Check whether the Linux guest is running, stopped or busy.',
    when: 'Use when the user asks about the Linux guest, or before running code.',
    params: {},
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Is Linux running?' }],
    // controls() (terminal-unkernel.mjs:28): #linux-start is enabled only while the guest is
    // stopped and the page idle, #linux-restart only while it is running and idle, and both
    // are disabled while a start/restart/shutdown is in flight. #terminal-status holds the
    // last report() line, which usually explains the state (for example that the browser
    // cannot run the Terminal).
    run: async (args, ctx) => call(ctx, async host => {
      const win = await page(host);
      const start = win.document.getElementById('linux-start');
      const restart = win.document.getElementById('linux-restart');
      const status = win.document.getElementById('terminal-status');
      const state = !start || !restart ? 'unavailable'
        : !restart.disabled ? 'running'
        : !start.disabled ? 'stopped'
        : 'busy';
      return { state, status: status?.textContent ?? '' };
    }),
  },
  {
    name: 'terminal.run',
    purpose: 'Run Python, Node or shell code in the Linux guest; it runs at once.',
    when: 'Use when the user wants code executed inside the WebPC Linux guest.',
    params: {
      lang: { type: 'enum', required: true, values: ['python', 'node', 'sh'], description: 'Language of the code' },
      code: { type: 'text', required: true, description: 'Code to run in the guest' },
      timeout_ms: { type: 'integer', min: 1, max: 120000, description: 'Optional run limit in milliseconds (default 30000); the run is killed at the limit' },
    },
    effect: 'external',
    needs: NEEDS,
    examples: [{ args: { lang: 'sh', code: 'echo hello' }, says: 'Run echo hello in Linux' }],
    // Open the window first so the user sees the run (the status line says what runs and its
    // result). Then delegate to the run_code bridge (ctx.legacy.run_code, wired
    // by src/apps/ai-agent/app.js over the webpc-terminal BroadcastChannel); its reply is
    // already model-facing: { exitCode, output, truncated } or
    // { error } for not-running / busy / no-terminal / timeout / cancelled.
    run: async (args, ctx) => call(ctx, async host => {
      await page(host);
      const bridge = ctx.legacy?.run_code;
      if (!bridge) throw new ToolError('not_available', 'the run_code bridge is not wired here (the Linux guest tools are unavailable)', '');
      return bridge.run({ code: args.code, lang: args.lang, timeout_ms: args.timeout_ms });
    }),
  },
];
