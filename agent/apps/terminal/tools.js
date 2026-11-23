// Terminal pack: drive the WebPC Linux guest (src/scripts/pc/apps/terminal.mjs). The guest runs
// directly in the app page (the v86 VM is a worker of that page, so there is no inner iframe to
// dig into; pcHost.appWindow('terminal') resolves the page's own window). Live DOM state:
// #linux-pause (enabled = the VM is up and idle; textContent "Pause" = running, "Resume" =
// paused; terminal.mjs controls()), the last status line on #terminal-status (report()), and the
// save action on #linux-save (disabled until the guest booted). Code runs over the AI-4 exec
// bridge (BroadcastChannel webpc-terminal, src/apps/ai-agent/exec-client.js): the page shows an
// approval prompt and #exec-run rejects programmatic clicks (event.isTrusted, terminal.mjs:167),
// so every run needs the user's own Run click in the visible window.
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
    when: 'Use when the user wants the terminal, or before running code so the approval prompt is visible.',
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
    purpose: 'Check whether the Linux guest is running, paused or unavailable.',
    when: 'Use when the user asks about the Linux guest, or before running code.',
    params: {},
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Is Linux running?' }],
    // controls() (terminal.mjs:19): #linux-pause is disabled while the VM is off or the page is
    // busy, and its textContent is "Pause" while running and "Resume" while paused. #terminal-
    // status holds the last report() line, which usually explains the state.
    run: async (args, ctx) => call(ctx, async host => {
      const win = await page(host);
      const pause = win.document.getElementById('linux-pause');
      const status = win.document.getElementById('terminal-status');
      const state = !pause?.disabled ? (pause.textContent === 'Pause' ? 'running' : 'paused') : 'unavailable';
      return { state, status: status?.textContent ?? '' };
    }),
  },
  {
    name: 'terminal.run',
    purpose: 'Run Python, Node or shell code in the Linux guest; the user approves it.',
    when: 'Use when the user wants code executed inside the WebPC Linux guest.',
    params: {
      lang: { type: 'enum', required: true, values: ['python', 'node', 'sh'], description: 'Language of the code' },
      code: { type: 'text', required: true, description: 'Code to run in the guest' },
      timeout_ms: { type: 'integer', min: 1, max: 120000, description: 'Optional run limit in milliseconds (default 30000); the run is interrupted with Ctrl+C at the limit' },
    },
    effect: 'external',
    needs: NEEDS,
    examples: [{ args: { lang: 'sh', code: 'echo hello' }, says: 'Run echo hello in Linux' }],
    // Open the window first so the user sees the approval prompt (#exec-run needs their real
    // click, terminal.mjs:167). Then delegate to the run_code bridge (ctx.legacy.run_code, wired
    // by src/apps/ai-agent/app.js over the webpc-terminal BroadcastChannel); its reply is
    // already model-facing (execReplyToToolResult): { exitCode, output, truncated } or
    // { error } for denied / not-running / busy / no-terminal / timeout.
    run: async (args, ctx) => call(ctx, async host => {
      await page(host);
      const bridge = ctx.legacy?.run_code;
      if (!bridge) throw new ToolError('not_available', 'the run_code bridge is not wired here (the Linux guest tools are unavailable)', '');
      return bridge.run({ code: args.code, lang: args.lang, timeout_ms: args.timeout_ms });
    }),
  },
  {
    name: 'terminal.save_session',
    purpose: 'Save the Linux session (files and memory) to this browser.',
    when: 'Use when the user wants to keep the Linux session for later.',
    params: {},
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Save the Linux session' }],
    // The app's own save action: #linux-save's handler (terminal.mjs:108) has no isTrusted gate
    // (unlike #exec-run), so a programmatic click runs capture(false). capture reports
    // "Saved in this browser ..." on success and "Could not save in this browser ..." on failure
    // (terminal.mjs:94, 97), so poll #terminal-status for those; capture can take several seconds
    // (it snapshots the VM memory). The pre-click status is remembered so a stale "Saved ..."
    // line from an earlier save cannot be reported as this save.
    run: async (args, ctx) => call(ctx, async host => {
      const win = await page(host);
      const save = win.document.getElementById('linux-save');
      const status = win.document.getElementById('terminal-status');
      if (!save || save.disabled) throw new ToolError('app_error', 'the guest is not ready to save yet (start Linux and wait for it to boot, or wait for the current operation to finish)', '');
      const before = status?.textContent ?? '';
      save.click();
      const sleep = ctx.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
      for (let i = 0; i < 120; i++) { // 60 s at 500 ms, injectable for tests
        const text = status?.textContent ?? '';
        if (text !== before && /^Saved in this browser/.test(text)) return { saved: true, status: text };
        if (text !== before && /^Could not save/.test(text)) return { saved: false, status: text };
        await sleep(500);
      }
      throw new ToolError('app_error', `the save did not finish within 60 s; the status says: ${status?.textContent ?? '(empty)'}`, '');
    }),
  },
];
