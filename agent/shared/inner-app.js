// Shared helper for packs that drive an app running inside an iframe of the WebPC wrapper page.
// pcHost.appWindow(id) resolves to the wrapper window (the /pc/apps/<id> utility page); the real
// app window is the iframe's contentWindow. This dig-in + poll mirrors agent/shared/craft.js but
// for apps that expose a plain API on the inner window (Excalidraw webpcExcalidraw.api, CyberChef
// app) rather than a craft protocol. Pure module: it takes the wrapper window, the frame id, the
// pick function and (for tests) a sleep function, so Node needs no browser.
//
// Rejects with code 'not_available' when the frame is missing or the API never appears, so a pack's
// call() gate turns it into a ToolError the model can act on ("try again shortly").
const notAvailable = message => {
  const error = new Error(message);
  error.code = 'not_available';
  return error;
};

/**
 * Find the app API inside an iframe of a WebPC wrapper window.
 *
 * wrapperWindow: the window from pcHost.appWindow(id). frameId: the iframe element id
 * (e.g. "excalidraw-frame"). pick: (innerWindow) => the API, or a falsy value when not ready.
 * options.timeoutMs: how long to wait for pick to return the API (default 30 s, polled every 100 ms);
 * options.sleep: the wait, injectable for tests. Returns the API. Rejects with code 'not_available'
 * when the frame or the API never appears. A pick that throws (frame mid-navigation) counts as not
 * ready and is retried on the next poll.
 */
export async function innerApi(wrapperWindow, frameId, pick, { timeoutMs = 30000, sleep = ms => new Promise(done => setTimeout(done, ms)) } = {}) {
  const frame = wrapperWindow?.document?.getElementById?.(frameId);
  const win = frame?.contentWindow;
  if (!win) throw notAvailable(`the window has no ${frameId} frame`);
  const polls = Math.max(1, Math.ceil(timeoutMs / 100));
  let api = null;
  for (let i = 0; i < polls; i++) {
    try { api = pick(win); } catch { api = null; }
    if (api) break;
    if (i + 1 < polls) await sleep(100); // no wait after the last poll
  }
  if (!api) throw notAvailable(`the app in ${frameId} did not finish loading (waited ${timeoutMs} ms)`);
  return api;
}
