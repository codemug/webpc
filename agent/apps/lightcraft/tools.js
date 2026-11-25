// Ported from storytold/lightcraft@v0.21.1: the page's automation surface (apps/lightcraft-web
// src/web.rs command(), :824, and src/automation.rs params()) plus the engine command registry
// (crates/engine/src/cmd.rs command_specs() and the cmd! specs per module).
// The page installs only window.lightcraft = { command } (vendor index.html); command(id,
// paramsText) resolves the result as JSON text and rejects with the app's error. There is no
// command list on the page, so this pack has no list_commands and run_command does not check
// the id against a list (report).
// The tools run in Buddy's frame and read the page straight off the app window (no shared
// craft adapter: the page has no request/execute/commands surface).
import { ToolError } from '../../../src/apps/ai-agent/runtime/args.mjs';
import { filesCall, openFromBytes, readOpenFile } from '../../shared/craft-files.js';

const APP = 'lightcraft';
const NEEDS = ['host', 'app:lightcraft'];
// run_command ids that destroy or replace data, from the engine command registry (grep of the
// cmd! ids in crates/engine/src/cmd): effectFor marks those calls destructive. Prefixes:
// mask.delete covers mask.deleteAll/mask.deleteEffect, develop.reset covers
// develop.resetControl.
const DESTRUCTIVE = [
  'photo.delete', 'photo.deletePermanently', 'library.emptyRecentlyDeleted',
  'library.removeFolder', 'library.forgetLocal', 'preset.delete', 'profile.deleteImported',
  'mask.delete', 'history.clear', 'keyword.deleteSet', 'label.deleteSet',
  'export.deletePreset', 'filter.deletePreset', 'metadata.deletePreset',
  'album.clearQuick', 'version.delete', 'develop.reset', 'crop.reset',
  'spot.delete', 'redeye.delete', 'pointColor.delete',
];

const PAGE_TIMEOUT_MS = 30000;
const sleep = ms => new Promise(done => setTimeout(done, ms));

// The page API: wait for window.lightcraft on the editor frame, like the shared adapter polls
// window.<id> (agent/shared/craft.js), but for this page's own command() surface.
async function pageApi(host) {
  const wrapper = await host.appWindow(APP);
  const win = wrapper?.document?.getElementById?.('editor')?.contentWindow;
  if (!win) throw new ToolError('not_available', 'the LightCraft window has no editor frame', '');
  const polls = Math.max(1, Math.ceil(PAGE_TIMEOUT_MS / 100));
  for (let i = 0; i < polls; i++) {
    const api = win[APP];
    if (api?.command) return api;
    if (i + 1 < polls) await sleep(100); // no wait after the last poll
  }
  throw new ToolError('not_available', `the lightcraft page did not finish loading (waited ${PAGE_TIMEOUT_MS} ms)`, '');
}

// One command: the page's lightcraft.command(id, JSON text) (web.rs:824). Blank params mean
// {} on the page side; here the object is always stringified, so send {} for none. The reply
// is the result as JSON text; parse it back.
async function command(host, id, params = {}) {
  const api = await pageApi(host);
  const text = await api.command(id, JSON.stringify(params));
  try {
    return JSON.parse(text);
  } catch {
    return text; // the page only sends JSON text; fall through for anything else
  }
}

// A key=value value: booleans, numbers, a [ ... ] or { ... } JSON value, else a string.
const parseValue = raw => {
  if (/^(true|false)$/i.test(raw)) return raw.toLowerCase() === 'true';
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try { return JSON.parse(raw); } catch { /* not JSON: keep as text */ }
  }
  return raw;
};

// run_command params: a JSON object (one line) or key=value lines.
const parseCommandParams = text => {
  const raw = String(text ?? '').trim();
  if (!raw) return {};
  if (raw.startsWith('{')) {
    try { return JSON.parse(raw); } catch { /* fall through to key=value lines */ }
  }
  const out = {};
  for (const line of raw.split('\n')) {
    const row = line.trim();
    if (!row) continue;
    const eq = row.indexOf('=');
    if (eq <= 0) throw new ToolError('invalid_argument', `bad params line "${row}": use key=value or a JSON object`, '');
    out[row.slice(0, eq).trim()] = parseValue(row.slice(eq + 1).trim());
  }
  return out;
};

// commands.rs pick(): copy the listed keys (when present) into a params object.
// checkArgs keeps list items as text ("3", "7"); the engine wants photo ids as whole numbers.
const pick = (args, keys) => {
  const out = {};
  for (const key of keys) if (args[key] !== undefined) out[key] = key === 'ids' ? args[key].map(Number) : args[key];
  return out;
};

// T10: the host bridge adds a dropped file to the library asynchronously, so openFromBytes
// acks the file hand-off before the catalog has the photo (measured: a catalog.stats or
// catalog.query read a call or two after an import misses the new record, and settles a
// few calls later). Read the count before the open and wait for the imported photo to be
// counted, so the tool - and any "how many photos now" right after it - never reads stale.
const IMPORT_COUNT_TIMEOUT_MS = 20000;
export async function waitUntilCounted(host, before, timeoutMs = IMPORT_COUNT_TIMEOUT_MS, pollMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let photos;
    try {
      photos = (await command(host, 'catalog.stats'))?.photos;
    } catch { /* the app is still committing the import: not counted yet */ }
    if (typeof photos === 'number' && (before === undefined || photos > before)) return;
    if (Date.now() >= deadline) throw new ToolError('app_error', `the photo was delivered but the library did not count it within ${Math.round(timeoutMs / 1000)} s`, '');
    await sleep(pollMs);
  }
}

export const pack = { id: APP, title: 'LightCraft' };

export const tools = [
  {
    name: 'lightcraft.library_info',
    purpose: 'Show the library: photo counts, folders, space, worker state.',
    when: 'Use when the user asks what is in the library, or before planning edits.',
    params: {},
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: {}, says: 'What is in the library?' }],
    // cmd/library/specs.rs:1378 library.info (query, {} params)
    run: async (args, ctx) => command(ctx.host, 'library.info'),
  },
  {
    name: 'lightcraft.select',
    purpose: 'Select photos by id (or clear the selection).',
    when: 'Use when the user wants specific photos selected.',
    params: { ids: { type: 'list', description: 'Photo ids; the selection is cleared when omitted' } },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { ids: [3, 7] }, says: 'Select these two photos' }],
    // cmd/library/specs.rs:331 library.select {ids?}
    run: async (args, ctx) => command(ctx.host, 'library.select', pick(args, ['ids'])),
  },
  {
    name: 'lightcraft.filter',
    purpose: 'Filter the library view by rating, flag, label, keyword and more.',
    when: 'Use when the user wants to narrow the library view.',
    params: { filter: { type: 'text', description: 'JSON object of filter keys: {"rating":4,"flag":"pick","keyword":"trip"}; partial, keys from the app filter bar' } },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { filter: '{"rating":4}' }, says: 'Show only the 4-star photos' }],
    // cmd/library/specs.rs:86 library.filter: a partial Filter {text?, rating?, ratingOp?, flag?,
    // flags?, label?, kind?, merged?, edited?, date?, libraryFolder?, keyword?, person?, camera?}
    run: async (args, ctx) => {
      let filter;
      try {
        filter = JSON.parse(String(args.filter ?? '').trim() || '{}');
      } catch {
        throw new ToolError('invalid_argument', 'filter must be a JSON object, e.g. {"rating":4}', '');
      }
      return command(ctx.host, 'library.filter', filter);
    },
  },
  {
    name: 'lightcraft.sort',
    purpose: 'Sort the library view by date, name, rating, size or shuffle.',
    when: 'Use when the user wants the library sorted a different way.',
    params: {
      key: { type: 'string', description: 'captureDate, importDate, editDate, fileName, rating, fileSize or random' },
      ascending: { type: 'boolean', description: 'Sort ascending (default: the app setting)' },
      group: { type: 'string', description: 'Group by auto, none, day, month or year' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { key: 'rating', ascending: false }, says: 'Sort by rating, best first' }],
    // cmd/library/specs.rs:232 library.sort {key?, ascending?, group?, seed?}
    run: async (args, ctx) => command(ctx.host, 'library.sort', pick(args, ['key', 'ascending', 'group'])),
  },
  {
    name: 'lightcraft.rate',
    purpose: 'Rate the selection or given photos 0 to 5 stars.',
    when: 'Use when the user wants to rate photos.',
    params: {
      rating: { type: 'integer', required: true, description: '0 to 5 stars', min: 0, max: 5 },
      ids: { type: 'list', description: 'Photo ids; the selection when omitted' },
      advance: { type: 'boolean', description: 'Move the selection to the next photo when it no longer matches the view' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { rating: 4 }, says: 'Rate the selection 4 stars' }],
    // cmd/library/specs.rs:455 photo.rate {rating: 0..5, ids?, advance?}
    run: async (args, ctx) => command(ctx.host, 'photo.rate', pick(args, ['rating', 'ids', 'advance'])),
  },
  {
    name: 'lightcraft.rotate',
    purpose: 'Rotate photos 90 degrees left or right.',
    when: 'Use when the user wants to rotate photos straight.',
    params: {
      direction: { type: 'enum', values: ['left', 'right'], required: true, description: 'Rotate left (counter-clockwise) or right' },
      ids: { type: 'list', description: 'Photo ids; the selection when omitted' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { direction: 'right' }, says: 'Rotate the selection clockwise' }],
    // cmd/library/specs.rs:592 photo.rotateLeft / photo.rotateRight {ids?}
    run: async (args, ctx) => command(ctx.host, args.direction === 'left' ? 'photo.rotateLeft' : 'photo.rotateRight', pick(args, ['ids'])),
  },
  {
    name: 'lightcraft.delete',
    purpose: 'Delete photos (they move to Recently Deleted).',
    when: 'Use when the user wants to delete photos.',
    params: { ids: { type: 'list', description: 'Photo ids; the selection when omitted' } },
    effect: 'destructive',
    needs: NEEDS,
    examples: [{ args: { ids: [3] }, says: 'Delete this photo' }],
    // cmd/library/specs.rs:657 photo.delete {ids?} - moves to Recently Deleted (not permanent)
    run: async (args, ctx) => command(ctx.host, 'photo.delete', pick(args, ['ids'])),
  },
  {
    name: 'lightcraft.restore',
    purpose: 'Restore deleted photos from Recently Deleted.',
    when: 'Use when the user wants a deleted photo back.',
    params: { ids: { type: 'list', description: 'Photo ids; the selection when omitted' } },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { ids: [3] }, says: 'Restore that photo' }],
    // cmd/library/specs.rs:666 photo.restore {ids?}
    run: async (args, ctx) => command(ctx.host, 'photo.restore', pick(args, ['ids'])),
  },
  {
    name: 'lightcraft.develop_reset',
    purpose: 'Reset the develop edits on the selection or given photos.',
    when: 'Use when the user wants to undo all edits on a photo.',
    params: { ids: { type: 'list', description: 'Photo ids; the selection when omitted' } },
    effect: 'destructive',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Reset all edits on this photo' }],
    // cmd/develop.rs:395 develop.reset {ids?} - the edit history is cleared, so it is
    // destructive although the registry does not flag it
    run: async (args, ctx) => command(ctx.host, 'develop.reset', pick(args, ['ids'])),
  },
  {
    name: 'lightcraft.undo',
    purpose: 'Undo the last change in the library.',
    when: 'Use when the user wants to undo the last change.',
    params: {},
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Undo that' }],
    // cmd/edit.rs:7 edit.undo
    run: async (args, ctx) => command(ctx.host, 'edit.undo'),
  },
  {
    name: 'lightcraft.redo',
    purpose: 'Redo the last undone change.',
    when: 'Use when the user wants to redo the change they just undid.',
    params: {},
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Bring that back' }],
    // edit.redo (the mirror of edit.undo in the cmd/edit.rs specs)
    run: async (args, ctx) => command(ctx.host, 'edit.redo'),
  },
  {
    name: 'lightcraft.run_command',
    purpose: 'Run any LightCraft command by id with parameters.',
    when: `Use when a menu action is wanted by id; ${DESTRUCTIVE.join(', ')} are destructive.`,
    params: {
      command: { type: 'string', required: true, description: 'Command id, e.g. library.select, photo.rate, preset.apply, mask.invert' },
      params: { type: 'text', description: 'Parameters as key=value lines or a JSON object; omit for the defaults' },
    },
    effect: 'change',
    effectFor: args => (DESTRUCTIVE.some(prefix => String(args.command ?? '').startsWith(prefix)) ? 'destructive' : 'change'),
    needs: NEEDS,
    examples: [{ args: { command: 'preset.apply', params: 'id=9\namount=50' }, says: 'Apply preset 9 at half strength' }],
    // web.rs:824 command(id, paramsText): the page has no command list, so the id is not
    // checked against one; the page refuses bad params with its own error
    run: async (args, ctx) => command(ctx.host, args.command, parseCommandParams(args.params)),
  },
  {
    name: 'lightcraft.import_file',
    purpose: 'Import a photo from Files into the LightCraft library.',
    when: 'Use when the user wants to import a photo. Not for opening the app itself; that is desktop.open_app.',
    params: { path: { type: 'path', required: false, description: 'A Files path to a photo (an image or camera RAW)' } },
    effect: 'change',
    needs: ['host', 'app:lightcraft', 'files'],
    examples: [{ args: { path: '/Photos/trip/IMG_0001.cr2' }, says: 'Add this photo to the library' }],
    // LightCraft only imports (it has a library, not documents), so it gets import_file and no
    // save_copy. Drives the wrapper's own #file input (app.mjs:38); the wrapper posts
    // lightcraft:open, which the page's host bridge adds to the library as one dropped on the
    // window (apps/lightcraft-web/src/host.rs Incoming::Open, web.rs run_host). The page has no
    // inspect, so the result carries no opened field; a refused open (too large) posts
    // lightcraft:failed to the wrapper's #error line.
    run: async (args, ctx) => {
      const file = await readOpenFile(ctx, args.path, { id: APP, title: 'LightCraft' });
      const wrapper = await ctx.host.appWindow(APP);
      // T10: the open ack arrives before the catalog counts the photo, so pin the count
      // first and wait for the import to be counted before the tool returns.
      const before = (await command(ctx.host, 'catalog.stats'))?.photos;
      const result = await openFromBytes(wrapper, APP, file.name, file.bytes);
      await waitUntilCounted(ctx.host, before);
      return result;
    },
  },
];

// Live-check exports (brief): every engine command id the pack passes to lightcraft.command
// (the fixed ids of the thin tools; run_command passes arbitrary ids from the engine
// registry, which the page has no list for). No control methods: the page surface is
// command() only.
export const usesCommands = [
  'library.info', 'library.select', 'library.filter', 'library.sort', 'photo.rate',
  'photo.rotateLeft', 'photo.rotateRight', 'photo.delete', 'photo.restore',
  'develop.reset', 'edit.undo', 'edit.redo', 'catalog.stats',
];
export const usesMethods = []; // the page has no request() surface (no METHODS entry)
