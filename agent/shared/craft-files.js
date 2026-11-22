// Shared file-tier helpers for the Craft app packs (M4 file tier): open a file from
// Files into an app, and take a copy of the app's active document into Files. Each
// helper takes the craft app API (the craftApi result) and, where the wrapper window
// is involved, that window (the pcHost.appWindow result, the /pc/apps/<id> utility
// page), and uses the wrapper's own mechanisms; no app file parsing is re-implemented.
//
// Open: drive the wrapper's own #file input (scripts/pc/craft/app.mjs:38, no isTrusted
// check) by assigning a File through a DataTransfer and dispatching change. The handler
// runs in the wrapper's realm, so its post('open') (app.mjs:35-36) reaches the app with
// event.source === the wrapper, as the host bridge requires (craft-libs web-host
// web.rs:106) and the standalone bootstrap requires (scripts/pc/craft/bootstrap.js:53).
// A direct postMessage from the agent frame is silently dropped by both; host-mode and
// standalone apps both consume that one message, so one code path covers both modes.
// The wrapper's 256 MB check (app.mjs:36) and unsaved-changes confirm (app.mjs:35)
// still apply. The open is async, so openAndAwait waits: it snapshots craft.inspect()
// before the open and polls it until the result differs.
//
// Save: the browser has no file system, so no path is ever passed to the app. The bytes
// come back inline when the app's save command answers with them: file.saveBytes in the
// live command list (gridcraft {name, bytes, base64}, deckcraft {bytes, data}) or an
// inlineCommand (figcraft file.saveAs {data: true}, cadcraft document.bytes, vectorcraft
// document.serialize, whose target extension picks the format). Otherwise the save is
// started with a no-path trigger (default file.save {}, or the user starts the save in
// the editor UI when craft is null, the four standalone apps) and the bytes are captured
// from the <id>:save {name, bytes} message the editor posts to the wrapper (host:
// app.mjs:29-33; standalone: the bootstrap's download-click capture, bootstrap.js:92-98);
// in host mode the wrapper also downloads that file, so the result carries a note. An
// untitled document can refuse the no-path save ("no file name yet; use saveas {path}",
// lead live check), so the default trigger retries once with file.saveAs {path:
// '<title>.<native ext>'} (live: cadcraft saveas with a bare name posted the save). A
// payload that fails the realm-safe save check (the wrapper's validSave name rule,
// releases.mjs:44, with realm-safe bytes) is noise and is ignored: event.data arrives in
// the wrapper's realm, so this realm's instanceof ArrayBuffer would drop every real save.
// The bytes are the app's native format (or the target's, for vectorcraft), so a target
// path with a different extension is refused with a fix line for the right extension;
// no export tools this round.
// Pure module: no module-level side effects; Node tests pass a fake wrapper window.
import { ToolError, callLine } from '../../src/apps/ai-agent/runtime/args.mjs';

// A realm-safe version of the wrapper's own validSave (releases.mjs:44): the name rule is
// the same, but the bytes check is realm-safe. event.data arrives in the WRAPPER's realm,
// so this (Buddy) realm's `instanceof ArrayBuffer` fails on every real save (lead live
// probe: cadcraft:save bytes instanceof ArrayBuffer === false,
// Object.prototype.toString === '[object ArrayBuffer]'); ArrayBuffer.isView is
// realm-safe, and the tag covers the ArrayBuffer itself.
const isRealSave = data => typeof data?.name === 'string' && data.name.length > 0 && data.name.length <= 255
  && (Object.prototype.toString.call(data.bytes) === '[object ArrayBuffer]' || ArrayBuffer.isView(data.bytes));

// The wrapper's own open cap (app.mjs openBytes :36).
export const MAX_OPEN_BYTES = 256 * 1024 * 1024;

/**
 * Turn a ctx.files store rejection (which carries a code: not_found, not_a_file,
 * too_large, exists, invalid_name, not_a_folder) into a ToolError, the way the Files
 * pack does (agent/files/tools.js). Gates on ctx.files. fixFor (optional) returns a
 * corrected call line for fixable errors.
 */
export const filesCall = (ctx, fn, fixFor) => {
  if (!ctx.files) throw new ToolError('not_available', 'Files are not available here.', '');
  return Promise.resolve()
    .then(() => fn(ctx.files))
    .catch(error => {
      if (error instanceof ToolError) throw error;
      throw new ToolError(error.code || 'app_error', error.message, fixFor ? fixFor(error) : '');
    });
};

/**
 * Open a file from Files in a Craft app by driving the wrapper's own #file input
 * (app.mjs:38): assign a File built from (name, bytes) through a DataTransfer and
 * dispatch change, so the wrapper's handler posts <id>:open with the wrapper as the
 * message source, the way its own Open buttons do. Host-mode and standalone apps both
 * consume that message (web-host web.rs:106; bootstrap.js:53,75-88).
 *
 * wrapperWindow: the window from pcHost.appWindow(id). id: the app id (for error
 * messages). name: the file name (1 to 255 characters, as the wrapper's validSave
 * rule). bytes: an ArrayBuffer or a typed array (readBytes hands a Uint8Array over).
 * Returns { name, bytes: <size> } once the file is handed to the wrapper's handler.
 * Throws ToolError('invalid_argument') for a bad name or non-binary bytes,
 * ('not_available') when the wrapper has no #file input, ('app_error') above 256 MB.
 * The wrapper's handler still applies its own 256 MB check and, while the document is
 * dirty, its own unsaved-changes confirm dialog (app.mjs:35).
 */
export async function openFromBytes(wrapperWindow, id, name, bytes) {
  if (typeof name !== 'string' || name.length < 1 || name.length > 255) {
    throw new ToolError('invalid_argument', `bad file name ${JSON.stringify(name)}: a string of 1 to 255 characters`, '');
  }
  if (!(bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(bytes)) {
    throw new ToolError('invalid_argument', 'bytes must be an ArrayBuffer or a typed array', '');
  }
  const input = wrapperWindow?.document?.getElementById?.('file');
  if (!input) throw new ToolError('not_available', `the ${id} window has no file input; open the app first`, '');
  if (bytes.byteLength > MAX_OPEN_BYTES) {
    throw new ToolError('app_error', `Open files up to ${MAX_OPEN_BYTES / 1048576} MB.`, '');
  }
  // Cross-realm constructors: the File and the event must belong to the wrapper's realm
  // so the wrapper's own handler (app.mjs:38) processes them as its own UI would.
  const data = new wrapperWindow.DataTransfer();
  data.items.add(new wrapperWindow.File([bytes], name));
  input.files = data.files;
  input.dispatchEvent(new wrapperWindow.Event('change'));
  return { name, bytes: bytes.byteLength };
}

/**
 * Capture the app's save as { name, bytes }: wait on the wrapper window for the
 * <id>:save message the editor posts (host: app.mjs:29-33; standalone: the
 * bootstrap's download-click capture, bootstrap.js:92-98), check it with the
 * realm-safe save check (isRealSave: the wrapper's validSave name rule, releases.mjs:44,
 * but the bytes arrive in the wrapper's realm, so they are checked by tag/isView and
 * copied with new Uint8Array), and resolve with the copy.
 *
 * wrapperWindow: the window from pcHost.appWindow(id). id: the app id.
 * options: timeoutMs (default 60000), title (the app's display name, for errors),
 * trigger (an async function that starts the app's save once the listener is armed;
 * the pack's own save command through the page API, or null when the user triggers the
 * save in the editor UI). A trigger rejection rejects this promise right away (the
 * save could not be started). Timeout rejects with ToolError('app_error').
 */
export function saveCopy(wrapperWindow, id, { timeoutMs = 60000, title = id, trigger = null } = {}) {
  const win = wrapperWindow?.document?.getElementById?.('editor')?.contentWindow;
  const origin = wrapperWindow?.location?.origin;
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(() => reject(new ToolError('app_error',
        `${title} produced no save within ${Math.round(timeoutMs / 1000)}s. Start the save in the ${title} editor (or its save command) and retry.`, '')));
    }, timeoutMs);
    const onMessage = event => {
      if (event.origin !== origin) return;
      if (win && event.source !== win) return;
      if (event.data?.type !== `${id}:save`) return;
      if (!isRealSave(event.data)) return; // an invalid save is noise: keep waiting for a real one
      // A same-realm copy: event.data.bytes is the wrapper's realm, and the Files store
      // (this realm) takes its bytes straight through.
      finish(() => resolve({ name: event.data.name, bytes: new Uint8Array(event.data.bytes) }));
    };
    const finish = fn => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      wrapperWindow.removeEventListener('message', onMessage);
      fn();
    };
    wrapperWindow.addEventListener('message', onMessage);
    // Arm the listener before the trigger fires, so an immediate save cannot race it. A
    // ToolError from the trigger (e.g. the pack's no-document teaching error) passes through
    // with its fix; anything else becomes "could not start the save".
    Promise.resolve().then(() => (trigger ? trigger() : null)).then(
      () => {},
      error => finish(() => reject(error instanceof ToolError ? error
        : new ToolError('app_error', `Could not start the ${title} save: ${error?.message ?? error}`, ''))),
    );
  });
}

// base64 to bytes: atob in the browser and in Node 16+; Buffer as a fallback.
const base64ToBytes = encoded => {
  if (typeof atob === 'function') {
    const text = atob(encoded);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
    return bytes;
  }
  return new Uint8Array(Buffer.from(encoded, 'base64'));
};

// The extension of a name or path ('.xlsx', lowercase); '' when there is none.
export const extOf = name => {
  const base = String(name ?? '').split('/').filter(Boolean).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  const ext = base.slice(dot);
  return ext.includes(' ') ? '' : ext.toLowerCase();
};

// The open result's opened field: a short confirmation the model can read.
const COUNT_WORDS = { sheets: 'sheet', slides: 'slide', tabs: 'tab', documents: 'document', pages: 'page' };
const openedSummary = info => {
  const parts = [];
  if (info && typeof info === 'object' && !Array.isArray(info)) {
    if (typeof info.title === 'string' && info.title.length > 0) parts.push(`"${info.title}"`);
    if (typeof info.path === 'string' && info.path.length > 0) parts.push(info.path);
    for (const [key, word] of Object.entries(COUNT_WORDS)) {
      if (Array.isArray(info[key])) parts.push(`${info[key].length} ${word}${info[key].length === 1 ? '' : 's'}`);
    }
  }
  return parts.length > 0 ? parts.join(' ') : 'the app state changed';
};

// The produced save name when the saveBytes result carries none: the inspect path's
// base name when it has an extension, else the inspect title, else the display name.
const producedName = async (craft, title) => {
  try {
    const info = await craft.inspect({});
    if (typeof info?.path === 'string') {
      const base = info.path.split('/').filter(Boolean).pop();
      if (base && extOf(base) !== '') return base;
    }
    if (typeof info?.title === 'string' && info.title.length > 0) return info.title;
  } catch {
    // the app saved but does not answer inspect: the display name still names the copy
  }
  return title;
};

// The bytes of an inline save result: base64 from r.base64 or r.data (gridcraft
// {name, bytes, base64}, deckcraft {bytes, data}) or r.dataBase64 (vectorcraft), or the
// r.text field verbatim (vectorcraft document.serialize answers {text} instead of
// {dataBase64} for svg, lead live check). An empty payload is a text export of a
// document with no text (vectorcraft .txt, lead live check): a teaching error, not a
// corrupt save. When r.bytes is a number the decoded length must equal it. The produced
// name is r.name, else the inspect title/path; a name without an extension gets the
// app's native extension appended.
const inlineSave = async (r, craft, title, nativeExt, source) => {
  const encoded = r?.base64 ?? r?.data ?? r?.dataBase64;
  const bytes = typeof encoded === 'string' ? base64ToBytes(encoded)
    : typeof r?.text === 'string' ? new TextEncoder().encode(r.text)
    : null;
  if (bytes === null) throw new ToolError('app_error', `${title} returned no bytes from ${source}.`, '');
  if (bytes.byteLength === 0) throw new ToolError('not_available', `${title} has no text to export: the document has no text.`, 'Add text to the document first');
  if (typeof r.bytes === 'number' && bytes.byteLength !== r.bytes) {
    throw new ToolError('app_error', `${title} reported ${r.bytes} bytes but returned ${bytes.byteLength}; the save is corrupt.`, '');
  }
  let name = r.name;
  if (typeof name !== 'string' || name.length === 0) name = await producedName(craft, title);
  if (extOf(name) === '') name += nativeExt;
  return { name, bytes };
};

/**
 * Take a copy of the app's active document without passing a path (the browser has no
 * file system). Three ways to get the bytes, in order: inlineCommand (the app's save
 * command answers with the bytes inline: figcraft file.saveAs {data: true}, cadcraft
 * document.bytes, vectorcraft document.serialize); file.saveBytes in the app's live
 * command list (gridcraft, deckcraft); the saveCopy capture (a no-path trigger starts
 * the save, the wrapper captures the <id>:save message; note the app also downloaded
 * the file). The base64 comes from r.base64 ?? r.data ?? r.dataBase64, or the r.text
 * field verbatim (vectorcraft svg export); an empty payload is the no-text teaching
 * error; when r.bytes is a number the decoded length must equal it. The produced name is r.name, else the
 * inspect title/path; a name without an extension gets the app's native extension
 * appended. The bytes are the app's native format (vectorcraft's are the target
 * format, so pass guard: false): a target path with a different extension is refused
 * with ToolError('invalid_argument') and a fix line for the produced extension.
 *
 * craft: the craftApi result (or the teachApp-wrapped api), or null when the app has no
 * page API (then only the capture path is available and the save is started in the
 * editor UI). options: id (app id), title (display name), wrapperWindow (the appWindow
 * result, for the capture), target (the Files path the copy is written to, for the
 * extension guard), tool (the calling tool name, for the guard's fix line), nativeExt
 * (the app's native save extension, e.g. '.xlsx'), inlineCommand ({command, params} of
 * the inline save command), fallbackTrigger (optional no-path trigger override for the
 * capture; the default is execute('file.save', {}), which retries once with
 * execute('file.saveAs', { path: '<title><native ext>' }) when the app refuses the
 * no-path save for a missing file name), guard (false skips the extension guard),
 * timeoutMs (capture timeout, default 60000).
 * Returns { name, bytes, note }; note is '' except on the capture path, which says the
 * app also downloaded the file in the browser.
 */
export async function saveBytesCopy(craft, { id, title = id, wrapperWindow, target = '', tool, nativeExt = '', fallbackTrigger = null, inlineCommand = null, guard = true, timeoutMs = 60000 } = {}) {
  // The extension guard, before the save starts when the native extension is known: a
  // rejected target must not start a save (the capture would wait out its timeout, and in
  // host mode the wrapper would download a file nobody asked for). With nativeExt '' (the
  // four standalone packs) the produced name is only known after the capture, so the guard
  // re-runs against it. vectorcraft passes guard: false (the target picks the format).
  const targetExt = extOf(target);
  const refuse = producedExt => {
    if (targetExt !== '' && producedExt !== '' && producedExt !== targetExt) {
      const base = target.split('/').filter(Boolean).pop();
      const fixPath = `${target.slice(0, target.length - base.length)}${base.replace(/\.[^.]+$/, '')}${producedExt}`;
      throw new ToolError('invalid_argument', `${title} saves ${producedExt} files; it cannot write ${targetExt} here.`, callLine(tool, { path: fixPath }));
    }
  };
  if (guard && nativeExt !== '') refuse(nativeExt);
  let save;
  let note = '';
  if (inlineCommand) {
    save = await inlineSave(await craft.execute(inlineCommand.command, inlineCommand.params ?? {}), craft, title, nativeExt, inlineCommand.command);
  } else {
    const ids = craft ? (await craft.commands()).map(command => command.id ?? command) : [];
    if (ids.includes('file.saveBytes')) {
      save = await inlineSave(await craft.execute('file.saveBytes', {}), craft, title, nativeExt, 'file.saveBytes');
    } else {
      // The default no-path trigger with the untitled-document retry (lead live check): a
      // fresh document can refuse file.save {} ("no file name yet; use saveas {path}"),
      // so retry once with file.saveAs under the bare name (live: cadcraft saveas
      // {path: 'Drawing1.dxf'} posted the save). UNVERIFIED live for filmcraft and
      // effectcraft (the packs that still use the capture path).
      const startSave = async () => {
        try {
          await craft.execute('file.save', {});
        } catch (error) {
          if (error instanceof Error && /no (file )?(name|path)/i.test(String(error.message))) {
            let name = await producedName(craft, title);
            if (extOf(name) === '') name += nativeExt;
            return craft.execute('file.saveAs', { path: name });
          }
          throw error;
        }
      };
      save = await saveCopy(wrapperWindow, id, { timeoutMs, title, trigger: fallbackTrigger ?? (craft ? startSave : null) });
      note = 'the app also downloaded the file in the browser';
    }
  }
  if (guard) refuse(extOf(save.name) || nativeExt);
  return { name: save.name, bytes: save.bytes, note };
}

/**
 * Open a file from Files in the app and wait until the app has actually loaded it.
 * Snapshots craft.inspect() before the open, drives the wrapper's own #file input
 * (openFromBytes), then polls craft.inspect() every intervalMs (default 250 ms,
 * timeoutMs cap, default 30 s) until the result JSON differs from the snapshot; an
 * inspect that threw before and succeeds after also counts as changed (cadcraft:
 * "no drawing open" while no drawing is open).
 *
 * craft: the craftApi result (or teachApp-wrapped; an inspect rejection is read as
 * "not loaded yet" and swallowed). options: id (app id), title (display name, for the
 * timeout error), wrapperWindow (the appWindow result), name and bytes (the file from
 * files.readBytes), accept (the releases accept list, quoted in the timeout error),
 * timeoutMs, intervalMs, sleep (injectable for tests).
 * Returns { name, bytes: <size>, opened }, opened a short summary of the post-open
 * inspect (title, path, sheet/slide/tab count).
 * Throws ToolError('invalid_argument') for a bad name or non-binary bytes,
 * ('not_available') when the wrapper has no #file input, ('app_error') above 256 MB or
 * when the app state never changes within the cap.
 */
export async function openAndAwait(craft, { id, title = id, wrapperWindow, name, bytes, accept = '', timeoutMs = 30000, intervalMs = 250, sleep = ms => new Promise(done => setTimeout(done, ms)) } = {}) {
  let before = null;
  let beforeThrew = false;
  try { before = JSON.stringify(await craft.inspect({})); } catch { beforeThrew = true; }
  const driven = await openFromBytes(wrapperWindow, id, name, bytes);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let after = null;
    let afterThrew = false;
    try { after = JSON.stringify(await craft.inspect({})); } catch { afterThrew = true; }
    if (!afterThrew && (beforeThrew || after !== before)) return { ...driven, opened: openedSummary(JSON.parse(after)) };
    if (Date.now() >= deadline) throw new ToolError('app_error', `${title} did not open ${name}. It accepts: ${accept}.`, '');
    await sleep(intervalMs);
  }
}
