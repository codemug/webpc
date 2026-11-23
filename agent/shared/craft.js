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
//
// Two live-gate shapes the packs rely on: commands() normalises the page reply to a plain
// array (most apps answer an array, pdfcraft answers {commands: [...]}, control/host.rs:184),
// and noDoc/noDocResult/teachApp turn the app's "no document open" wording into a
// ToolError('not_available') with the pack's new-document callLine as the fix.
import { ToolError } from '../../src/apps/ai-agent/runtime/args.mjs';

// Method-name mapping, one place per app: the unified names -> the names on window.<id>.
// The craft-web-api PageApi installs the JS names request, execute, commands, docInspect
// (only when the app's Methods table provides document.inspect), uiInspect and screenshot
// on window.<id>; the control methods behind the shortcuts are app-internal (e.g. PdfCraft
// runs execute through its ui.command control method), so most apps map to the default
// names. FilmCraft installs no docInspect (Methods { doc_inspect: None }), so its inspect is
// the page's uiInspect; EffectCraft's page installs its own inspect (ui.inspect);
// LightCraft's page has no PageApi surface (lightcraft.command only) and gets no entry.
export const METHODS = {
  cadcraft: { request: 'request', execute: 'execute', commands: 'commands', inspect: 'docInspect', screenshot: 'screenshot' },
  deckcraft: { request: 'request', execute: 'execute', commands: 'commands', inspect: 'docInspect', screenshot: 'screenshot' },
  effectcraft: { request: 'request', execute: 'execute', commands: 'commands', inspect: 'inspect', screenshot: 'screenshot' },
  figcraft: { request: 'request', execute: 'execute', commands: 'commands', inspect: 'docInspect', screenshot: 'screenshot' },
  filmcraft: { request: 'request', execute: 'execute', commands: 'commands', inspect: 'uiInspect', screenshot: 'screenshot' },
  gridcraft: { request: 'request', execute: 'execute', commands: 'commands', inspect: 'docInspect', screenshot: 'screenshot' },
  pdfcraft: { request: 'request', execute: 'execute', commands: 'commands', inspect: 'docInspect', screenshot: 'screenshot' },
  vectorcraft: { request: 'request', execute: 'execute', commands: 'commands', inspect: 'docInspect', screenshot: 'screenshot' },
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
 * Returns { id, request, execute, commands, inspect, screenshot }. commands() normalises
 * the page reply to a plain array (array, {commands: [...]} or a {id: spec} map). Rejects
 * with code 'not_available' when the frame or the API never appears; rethrows app rejections
 * with code 'app_error' and the app's own message. No retries.
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
    commands: () => (commandsCache ??= once(api[method.commands]()).then(normalizeCommands)),
    inspect: (params = {}) => once(api[method.inspect](params)),
    screenshot: (params = {}) => once(api[method.screenshot](params)),
  };
}

// The page's commands() reply, normalised to a plain array of {id, ...}: most apps answer
// an array, pdfcraft answers {commands: [...]} (control/host.rs:184), and an object map
// keyed by id is accepted too; anything else is an empty list.
function normalizeCommands(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.commands)) return value.commands;
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([id, spec]) => (spec && typeof spec === 'object' ? { id, ...spec } : { id }));
  }
  return [];
}

// The app's "no document open" wording, per engine source: cadcraft "no drawing open"
// (engine cmd.rs:168), figcraft "no open document" (engine error.rs), vectorcraft "no
// active document" / "no document open" (engine error.rs / docmenu.rs), pdfcraft
// "<id> is disabled right now" (the ui.command gate, control/host.rs:172).
export const NO_DOCUMENT = /no drawing open|no open document|no active document|no document open|is disabled right now/i;

/**
 * Run an app call; when the app rejects with the no-document wording, throw
 * ToolError('not_available', message, fix) instead (message: the teaching text,
 * fix: the pack's new-document or open-file callLine). Other rejections pass through.
 */
export async function noDoc(call, message, fix) {
  try {
    return await call();
  } catch (error) {
    if (error?.code === 'app_error' && NO_DOCUMENT.test(error.message)) throw new ToolError('not_available', message, fix);
    throw error;
  }
}

/**
 * A resolved result whose error field the app set in-band (cadcraft cmdline.input/key,
 * control.rs:335/367) becomes a ToolError: the no-document wording gets the teaching
 * error, anything else an app_error carrying the app's message.
 */
export function noDocResult(result, message, fix) {
  const error = result && typeof result === 'object' ? result.error : undefined;
  if (typeof error === 'string' && error.length > 0) {
    if (NO_DOCUMENT.test(error)) throw new ToolError('not_available', message, fix);
    throw new ToolError('app_error', error, '');
  }
  return result;
}

/**
 * Wrap a craft app API (the craftApi result) so its no-document wording becomes the
 * teaching ToolError('not_available'): every request/execute rejection matching
 * NO_DOCUMENT and the in-band error field on request results. commands, inspect and
 * screenshot pass through untouched (listing and UI reads work without a document).
 */
export const teachApp = (app, message, fix) => ({
  ...app,
  request: (name, params) => noDoc(() => app.request(name, params), message, fix).then(result => noDocResult(result, message, fix)),
  execute: (command, params) => noDoc(() => app.execute(command, params), message, fix),
  // inspect is usually a model's first call, so it teaches too (live: vectorcraft.inspect on a fresh app).
  inspect: params => noDoc(() => app.inspect(params), message, fix),
});
