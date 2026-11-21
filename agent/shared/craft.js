// Shared Craft app adapter (plan section 9). Locates the craft page API inside an app
// window's #editor frame and wraps it in one shape for the app packs: request(method,
// params), execute(command, params), commands() (cached), inspect(params) and
// screenshot(params). Pure module: it takes the wrapper window (the pcHost.appWindow
// result) and, for tests, a sleep function, so Node needs no browser.
//
// The craft-web-api (storytold/craft-libs#413) puts window.<id> on the editor page with
// request/execute shortcuts over the control protocol (storytold/gridcraft docs/
// control-protocol.md). Each call rejects if the app does not answer within 30 s, and a
// call the app already took still finishes, so a retry after a timeout can apply a
// command twice. This adapter therefore never retries a rejected call.

// Method-name mapping, one place per app: the unified names -> the names on window.<id>.
// GridCraft uses the craft-web-api default names; PDFCraft (ui.commands, ui.command,
// ui.state) and EffectCraft get their own entries here later.
export const METHODS = {
  gridcraft: { request: 'request', execute: 'execute', commands: 'commands', inspect: 'docInspect', screenshot: 'screenshot' },
};

const notAvailable = message => {
  const error = new Error(message);
  error.code = 'not_available';
  return error;
};

/**
 * Wrap the craft page API of an app window.
 *
 * wrapperWindow: the app's window from pcHost.appWindow(id). id: the craft app id (must
 * have a METHODS entry). options.timeoutMs: how long to wait for window.<id> to appear
 * (default 30 s, polled every 100 ms); options.sleep: the wait, injectable for tests.
 * Returns { id, request, execute, commands, inspect, screenshot }. Rejects with code
 * 'not_available' when the frame or the API never appears; rethrows app rejections with
 * code 'app_error' and the app's own message. No retries.
 */
export async function craftApi(wrapperWindow, id, { timeoutMs = 30000, sleep = ms => new Promise(done => setTimeout(done, ms)) } = {}) {
  const method = METHODS[id];
  if (!method) throw notAvailable(`no craft method mapping for app "${id}" yet`);
  const frame = wrapperWindow?.document?.getElementById?.('editor');
  const win = frame?.contentWindow;
  if (!win) throw notAvailable('the app window has no editor frame');
  const polls = Math.max(1, Math.ceil(timeoutMs / 100));
  let api = null;
  for (let i = 0; i < polls; i++) {
    api = win[id];
    if (api) break;
    if (i + 1 < polls) await sleep(100); // no wait after the last poll
  }
  if (!api) throw notAvailable(`the ${id} page did not finish loading (waited ${timeoutMs} ms)`);
  // One rejection per call, never a retry: the app may have applied a timed-out command.
  const once = promise => Promise.resolve(promise).catch(error => {
    const failed = new Error(error instanceof Error ? error.message : String(error));
    failed.code = 'app_error';
    throw failed;
  });
  let commandsCache = null; // commands() is cached per api object
  return {
    id,
    request: (name, params = {}) => once(api[method.request](name, params)),
    execute: (command, params = {}) => once(api[method.execute](command, params)),
    commands: () => (commandsCache ??= once(api[method.commands]())),
    inspect: (params = {}) => once(api[method.inspect](params)),
    screenshot: (params = {}) => once(api[method.screenshot](params)),
  };
}
