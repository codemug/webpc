// Ported from storytold/cadcraft@v0.20.1 crates/mcp/src/tools.rs (MIT OR Apache-2.0). Tool names, descriptions and the control-method mapping follow that table; arguments are flattened for small models (window boxes become window_x0..window_y1).
// The tools run in Buddy's frame and drive the CADCraft page API through ctx.craft,
// which the runtime wires as id => craftApi(await ctx.host.appWindow(id), id) (plan 9).
import { ToolError, callLine, closest, looseObject, looseValue } from '../../../src/apps/ai-agent/runtime/args.mjs';
import { teachApp } from '../../shared/craft.js';
import { filesCall, openAndAwait, readOpenFile, saveBytesCopy } from '../../shared/craft-files.js';
import { releases } from '../../../scripts/pc/craft/releases.mjs';

const APP = 'cadcraft';
const NEEDS = ['host', 'app:cadcraft'];
// run_command ids that replace the open drawing: the web app holds one drawing, so
// `new` replaces it (the lead probe confirms `new` as the only data-destroying id).
const DESTRUCTIVE = ['new'];
// The web app holds one drawing; with none open the app says "no drawing open"
// (engine cmd.rs:168) in a rejection (the control protocol ok:false, craft-libs
// page.rs request_promise_outcome) or in the result error field (control.rs:335/367,
// cmdline.input/key). teachApp turns that wording into the teaching error below.
const NO_DOC = { message: 'CadCraft has no drawing open.', fix: callLine('cadcraft.new_drawing') };

/** tools.rs pick(): copy the listed keys (when present) into a params object. */
const pick = (args, keys) => {
  const out = {};
  for (const key of keys) if (args[key] !== undefined) out[key] = args[key];
  return out;
};

// The window [[x0, y0], [x1, y1]] of query_entities and find_text as flat params.
const windowOf = args => ([args.window_x0, args.window_y0, args.window_x1, args.window_y1].every(value => value !== undefined) ? [[args.window_x0, args.window_y0], [args.window_x1, args.window_y1]] : undefined);

// key=value lines -> object, with number and boolean coercion (the generic long-tail tool).
// A JSON object or array value passes through as-is (lfm3-1.7b sends the engine params as
// JSON; repairArgs serializes an unwrapped wrapper object to JSON text for this slot).
export const parseParams = text => {
  const source = String(text ?? '').trim();
  if (source.startsWith('{') || source.startsWith('[')) {
    try {
      const parsed = JSON.parse(source);
      if (parsed !== null && typeof parsed === 'object') return parsed;
    } catch { /* not JSON: fall through to the loose-object and key=value parsing */ }
    // Loose single-line object the small models type instead of JSON (cadcraft-06:
    // "{handles: line, from: [0, 0]}"): the shared parser (args.mjs looseObject) handles the
    // unquoted keys and values.
    const loose = looseObject(source);
    if (loose) return loose;
  }
  // The model also nests the whole params text under a params= prefix INSIDE the params
  // argument (cadcraft-06: "command=move params=handles=line from=[0,0]" after the
  // command id is lifted out): unwrap when the value itself looks like params text.
  const wrap = source.match(/^params=(.*)$/s);
  if (wrap && (/(^|\s)[A-Za-z_][A-Za-z0-9_-]*=/.test(wrap[1]) || wrap[1].trimStart().startsWith('{'))) {
    return parseParams(wrap[1]);
  }
  const out = {};
  // A literal backslash-n counts as a line break too: small models often write \n in the text.
  // A value runs to the next " <key>=" or the end of the line (same shape as inlinePairs),
  // so "handles=line from=[0,0] to=[5,5]" on one line reads as three pairs.
  for (const line of String(text ?? '').split(/\n|\\n/)) {
    const row = line.trim();
    if (!row) continue;
    const re = /(^|\s)([A-Za-z_][A-Za-z0-9_-]*)=((?:"(?:[^"]*)"|\S+(?:\s+(?![A-Za-z_][A-Za-z0-9_-]*=)\S+)*))/g;
    let match, found = false;
    while ((match = re.exec(row)) !== null) {
      found = true;
      let value = match[3];
      if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
      else value = value.trim();
      out[match[2]] = looseValue(value);
    }
    if (!found) throw new ToolError('invalid_argument', `bad params line "${row}": use key=value`, '');
  }
  return out;
};

// A point param as the engine wants it, [x, y]: from x,y text (the small models type
// "20,0"), a space-separated pair, or an array straight through (cadcraft-02/04/06).
const pointOf = (value, name) => {
  const parts = Array.isArray(value) ? value.map(String) : String(value ?? '').split(/[,;\s]+/).filter(part => part !== '');
  const point = parts.map(Number);
  if (parts.length < 2 || point.some(n => Number.isNaN(n))) {
    throw new ToolError('invalid_argument', `${name} is a point: two numbers, x,y`, '');
  }
  return [point[0], point[1]];
};

// cadcraft-02/04 (build 14): the model typed prose ("circle center 20,0 radius 5",
// "draw a circle at point (20,0) with radius 5") and looped on the interactive prompts.
// A sentence-shaped line - a flat-tool command word plus at least two prose words -
// names the flat tool in the first result; exact command shapes (a word plus points and
// keywords) never note.
const FLAT_NOTE = {
  circle: "use cadcraft.circle center=x,y radius=n with the user's own values",
  line: "use cadcraft.line p1=x,y p2=x,y with the user's own values",
  move: "use cadcraft.move dx=n dy=n with the user's own values",
  text: "use cadcraft.text at=x,y text=the label with the user's own values",
};
const PROSE_WORDS = new Set(['center', 'centre', 'radius', 'point', 'with', 'draw', 'the', 'a', 'an', 'at', 'to', 'from', 'and', 'of', 'in', 'by', 'for']);
const proseNote = text => {
  const words = String(text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const hits = words.filter(word => word in FLAT_NOTE);
  if (!hits.length) return null;
  return words.filter(word => PROSE_WORDS.has(word)).length >= 2
    ? `That line looks like a sentence, not a CADCraft command: ${FLAT_NOTE[hits[0]]}.` : null;
};

export const pack = { id: APP, title: 'CADCraft' };

export const tools = [
  {
    name: 'cadcraft.command_line',
    purpose: 'Type one line at the command line, exactly as a user would.',
    when: 'Use when the user wants to type a command or point at the AutoCAD-style prompt.',
    params: { text: { type: 'string', required: false, default: ' ', description: 'The line: a command (LINE, CIRCLE, MOVE, ZOOM), a point x,y, @dx,dy, a keyword; empty or omitted is a bare Enter that finishes the open command' } },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { text: 'circle 30,15 8' }, says: 'Draw a circle at 30,15 with radius 8' }, { args: {}, says: 'Press Enter to finish the open command' }],
    // tools.rs:119 cmdline.input (spaces act as Enter, so a full command works in one call);
    // the reply carries an in-band error field when the input is refused (control.rs:335).
    // T6: empty or omitted text is a bare Enter (a space input, which the web build treats
    // as Enter), the reliable finish for a continuing command like LINE.
    run: async (args, ctx) => {
      const text = args.text == null || String(args.text).trim() === '' ? ' ' : String(args.text);
      const result = await teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).request('cmdline.input', { text });
      const note = proseNote(text);
      return note ? { ...result, note } : result;
    },
  },
  {
    name: 'cadcraft.script',
    purpose: 'Run a multi-line command-line script, one input per line.',
    when: 'Use when the user wants several command-line inputs run in sequence.',
    params: { text: { type: 'string', required: true, description: 'Script text: one or more inputs per line, blank line = Enter; the pack appends the terminating blank line when it is missing' } },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { text: 'line\n30,15\n40,15' }, says: 'Draw a line from 30,15 to 40,15' }],
    // tools.rs:120 cmdline.script. T6: a literal \n from small models is a line break, and
    // the pack appends the terminating blank line when missing: LINE and TEXT keep asking
    // for points, the blank line is the only reliable terminating Enter, and a model that
    // omits it leaks the next call's inputs into the still-open command.
    run: async (args, ctx) => {
      let text = String(args.text ?? '').replace(/\\n/g, '\n');
      if (text.split('\n').pop().trim() !== '') text += '\n';
      return teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).request('cmdline.script', { text });
    },
  },
  // Flat draw/move/text tools (cadcraft-02/04/06 on build 14): the small models type prose into
  // the interactive command line, or spell the engine's [x,y] arrays as text inside
  // run_command. These spell the engine params directly (wasm help, read from the vendored
  // build: circle {center, radius} | {p1, p2} | {p1, p2, p3}; line {points: [[x,y],...],
  // closed?}; move {handles?, from?: [x,y], to?: [x,y] | delta: [dx,dy]}; text
  // {at, text, height?, rotation?, justify?}); the command line and run_command stay for
  // the long tail.
  {
    name: 'cadcraft.circle',
    purpose: 'Draw a circle at a centre point with a radius.',
    when: 'Use when the user wants a circle: a door swing, a hole, a round feature.',
    params: {
      center: { type: 'string', required: true, description: 'Centre point x,y, e.g. 30,15' },
      radius: { type: 'number', required: true, description: 'Radius' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { center: '30,15', radius: 8 }, says: 'Circle at 30,15 with radius 8' }],
    // Engine "circle" {center, radius}; one execute call instead of the CIRCLE prompt flow
    // that kept the model on "Point or option keyword required".
    run: async (args, ctx) => teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).execute('circle', { center: pointOf(args.center, 'center'), radius: args.radius }),
  },
  {
    name: 'cadcraft.line',
    purpose: 'Draw a line between two points.',
    when: 'Use when the user wants a straight line or wall segment between two points.',
    params: {
      p1: { type: 'string', required: true, description: 'First point x,y, e.g. 30,15' },
      p2: { type: 'string', required: true, description: 'Second point x,y, e.g. 40,15' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { p1: '30,15', p2: '40,15' }, says: 'Line from 30,15 to 40,15' }],
    // Engine "line" {points: [[x,y],...], closed?: bool} (wasm help; the build 15 live run
    // refused {p1, p2} with "`points` [[x,y],...] (2 or more) is required").
    run: async (args, ctx) => teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).execute('line', { points: [pointOf(args.p1, 'p1'), pointOf(args.p2, 'p2')] }),
  },
  {
    name: 'cadcraft.move',
    purpose: 'Move every entity, or the given handles, by an offset.',
    when: 'Use when the user wants to move the drawing content (or some entities) by dx, dy.',
    params: {
      dx: { type: 'number', required: true, description: 'Offset x' },
      dy: { type: 'number', required: true, description: 'Offset y' },
      handles: { type: 'string', description: 'Handles to move, comma-separated; every entity when omitted' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { dx: 7, dy: 9 }, says: 'Move everything 7 right and 9 up' }],
    // Engine "move" {handles?, from?: [x,y], to?: [x,y] | delta: [dx,dy]}: the delta form
    // needs no base point (the command-line MOVE flow asks for one and the model looped).
    // Omitted handles move the current selection - live {moved: 0} on the empty selection
    // (cadcraft-06 on build 15) - so "move everything" selects all first.
    run: async (args, ctx) => {
      const app = teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix);
      const params = { delta: [args.dx, args.dy] };
      const handles = String(args.handles ?? '').trim();
      if (handles) params.handles = handles;
      else await app.execute('selectall', {});
      return app.execute('move', params);
    },
  },
  {
    name: 'cadcraft.text',
    purpose: 'Add a single-line text label at a point with a height.',
    when: 'Use when the user wants a text label, room name or note added to the drawing.',
    params: {
      at: { type: 'string', required: true, description: 'Insertion point x,y, e.g. 30,15' },
      text: { type: 'string', required: true, description: 'The label text, e.g. Lab 7' },
      height: { type: 'number', description: 'Text height in drawing units' },
      rotation: { type: 'number', description: 'Rotation in degrees (default 0)' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { at: '30,15', text: 'Lab 7', height: 60 }, says: 'Label "Lab 7" at 30,15 with height 60' }],
    // Engine "text" {at, text, height?, rotation?, justify?} (wasm help); one execute call
    // instead of the TEXT prompt flow (point, height, rotation, text) the model looped on.
    run: async (args, ctx) => {
      const params = { at: pointOf(args.at, 'at'), text: String(args.text) };
      if (args.height !== undefined) params.height = args.height;
      if (args.rotation !== undefined) params.rotation = args.rotation;
      return teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).execute('text', params);
    },
  },
  {
    name: 'cadcraft.inspect',
    purpose: 'Summarize the drawing: entities, extents, layers, selection.',
    when: 'Use when the user asks what is in the drawing, or before planning changes.',
    params: {
      entities: { type: 'boolean', description: 'Also list entities with handles and geometry' },
      limit: { type: 'integer', description: 'Most entities to list when entities=true' },
    },
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: {}, says: 'What is in this drawing?' }, { args: { entities: true, limit: 50 }, says: 'List the first 50 entities' }],
    // tools.rs:132 drawing.inspect
    run: async (args, ctx) => teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).request('drawing.inspect', pick(args, ['entities', 'limit'])),
  },
  {
    name: 'cadcraft.query_entities',
    purpose: 'List entities filtered by type, layer, selection or a window.',
    when: 'Use when the user wants to find geometry, e.g. all circles on a layer.',
    params: {
      type: { type: 'string', description: 'Entity type: Line, Circle, Polyline, Text, ...' },
      layer: { type: 'string', description: 'Layer name' },
      selected: { type: 'boolean', description: 'Only the current selection' },
      window_x0: { type: 'number', description: 'Window corner x0 (all four set the window)' },
      window_y0: { type: 'number', description: 'Window corner y0' },
      window_x1: { type: 'number', description: 'Window corner x1' },
      window_y1: { type: 'number', description: 'Window corner y1' },
      crossing: { type: 'boolean', description: 'false = only entities entirely inside the window' },
      limit: { type: 'integer', min: 0, description: 'Page size (default 500)' },
      offset: { type: 'integer', min: 0, description: 'Page offset' },
    },
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: { type: 'Circle', limit: 10 }, says: 'Show me the circles' }],
    // tools.rs:133 engine.execute entities; the window box is rebuilt from the flat params
    run: async (args, ctx) => {
      const params = pick(args, ['type', 'layer', 'selected', 'crossing', 'limit', 'offset']);
      const window = windowOf(args);
      if (window !== undefined) params.window = window;
      return teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).execute('entities', params);
    },
  },
  {
    name: 'cadcraft.find_text',
    purpose: "Read the drawing's texts: labels, notes, block attributes.",
    when: 'Use when the user wants to find room names, sheet titles or notes in the drawing.',
    params: {
      contains: { type: 'string', description: 'Substring of the text (any case)' },
      layer: { type: 'string', description: 'Layer name' },
      window_x0: { type: 'number', description: 'Window corner x0 around the insertion points' },
      window_y0: { type: 'number', description: 'Window corner y0' },
      window_x1: { type: 'number', description: 'Window corner x1' },
      window_y1: { type: 'number', description: 'Window corner y1' },
      limit: { type: 'integer', min: 0, description: 'Page size (default 200)' },
      offset: { type: 'integer', min: 0, description: 'Page offset' },
    },
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: { contains: 'Room' }, says: 'Find the room name labels' }],
    // tools.rs:134 engine.execute texts
    run: async (args, ctx) => {
      const params = pick(args, ['contains', 'layer', 'limit', 'offset']);
      const window = windowOf(args);
      if (window !== undefined) params.window = window;
      return teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).execute('texts', params);
    },
  },
  {
    name: 'cadcraft.new_drawing',
    purpose: 'Create a new drawing (imperial by default, or metric).',
    when: 'Use when the user wants a blank drawing to start from.',
    params: { metric: { type: 'boolean', description: 'Metric units instead of imperial' } },
    effect: 'destructive',
    needs: NEEDS,
    examples: [{ args: { metric: true }, says: 'Start a new metric drawing' }],
    // tools.rs:135 engine.execute new. Destructive: the web app holds one drawing, so
    // this replaces the open one (upstream desktop drawings coexist).
    run: async (args, ctx) => (await ctx.craft(APP)).execute('new', pick(args, ['metric'])),
  },
  {
    name: 'cadcraft.cancel',
    purpose: 'Press Escape: cancel the running command or clear the selection.',
    when: 'Use when a command is stuck or the user wants to stop entering values.',
    params: {},
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Cancel the running command' }],
    // tools.rs:138 cmdline.key with key escape; a refused Enter echoes an in-band error
    run: async (args, ctx) => teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).request('cmdline.key', { key: 'escape' }),
  },
  {
    name: 'cadcraft.list_commands',
    purpose: 'Find drawing commands by a word in the id, label or alias.',
    when: 'Use when the user wants a command and its id or parameter doc is unknown.',
    params: { query: { type: 'string', description: 'Substring of a command id, label or alias, e.g. zoom or layer' } },
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: { query: 'layer' }, says: 'Which commands manage layers?' }],
    // Generic tool (plan 9): the top 10 of the live commands() filtered as tools.rs:125-131
    // (id, label or any alias, case-insensitive); trimmed like the pilot.
    run: async (args, ctx) => {
      const all = await (await ctx.craft(APP)).commands();
      const q = String(args.query ?? '').trim().toLowerCase();
      return all.filter(command => !q || [command.id, command.label, ...(command.aliases ?? [])].some(part => String(part ?? '').toLowerCase().includes(q)))
        .slice(0, 10).map(command => ({ id: command.id, label: command.label, params: command.params }));
    },
  },
  {
    name: 'cadcraft.run_command',
    purpose: 'Run any CADCraft command by id with JSON parameters.',
    when: `Use when a menu action is wanted by id; ${DESTRUCTIVE.join(', ')} replaces the drawing.`,
    params: {
      command: { type: 'string', required: true, description: 'Command id from cadcraft.list_commands, e.g. line, circle, layer.new, move, zoom' },
      params: { type: 'text', description: 'Parameters as key=value lines, one per line; omit for the defaults' },
    },
    effect: 'change',
    effectFor: args => (DESTRUCTIVE.includes(String(args.command ?? '')) ? 'destructive' : 'change'),
    needs: NEEDS,
    examples: [{ args: { command: 'zoom', params: 'mode=extents' }, says: 'Zoom to extents' }],
    // Generic tool (plan 9): unknown ids get invalid_argument with the 3 closest ids
    run: async (args, ctx) => {
      const app = teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix);
      const all = await app.commands();
      if (!all.some(command => command.id === args.command)) {
        const near = closest(args.command, all.map(command => command.id), 3);
        const fix = near.length > 0 ? callLine('cadcraft.run_command', { command: near[0] }) : '';
        throw new ToolError('invalid_argument', `unknown command "${args.command}"${near.length > 0 ? `; closest: ${near.join(', ')}` : ''}`, fix);
      }
      return app.execute(args.command, parseParams(args.params));
    },
  },
  {
    name: 'cadcraft.open_file',
    purpose: 'Open a drawing from Files in CADCraft. Not for one already open on screen.',
    when: 'Use when the user wants a drawing from Files. Not for opening the app itself; that is desktop.open_app.',
    params: { path: { type: 'path', required: false, description: 'A Files path to a drawing file (.dxf, .dwg or .shx)' } },
    effect: 'change',
    needs: ['host', 'app:cadcraft', 'files'],
    examples: [{ args: { path: '/CadCraft/base.dxf' }, says: 'Open the plan drawing from Files' }],
    // Drives the wrapper's own #file input (app.mjs:38), so the open posts from the wrapper
    // realm, as the app's host bridge requires (craft-libs web-host web.rs:106). The drawing
    // opens alongside the open ones (engine session/files.rs open_drawing appends + activates),
    // so a change; the wrapper's own unsaved-changes confirm still applies (app.mjs:35).
    // openAndAwait waits until the app's inspect stops saying "no drawing open", so the
    // result confirms the drawing actually loaded.
    run: async (args, ctx) => {
      const file = await readOpenFile(ctx, args.path, { id: APP, title: 'CadCraft' });
      const wrapper = await ctx.host.appWindow(APP);
      const craft = await ctx.craft(APP);
      return openAndAwait(craft, { id: APP, title: 'CadCraft', wrapperWindow: wrapper, name: file.name, bytes: file.bytes, accept: releases[APP].accept });
    },
  },
  {
    name: 'cadcraft.save_copy',
    purpose: 'Save the active drawing as a file in Files.',
    when: 'Use when the user wants to keep a copy of the drawing in Files.',
    params: {
      path: { type: 'path', required: true, description: 'The Files path to write the copy to, e.g. /CadCraft/base.dxf' },
      overwrite: { type: 'boolean', description: 'Replace the file when the path already exists; false when omitted' },
    },
    effect: 'change',
    effectFor: args => (args.overwrite ? 'destructive' : 'change'),
    needs: ['host', 'app:cadcraft', 'files'],
    examples: [{ args: { path: '/CadCraft/base.dxf' }, says: 'Save a copy of the drawing to Files' }],
    // No path is ever passed (the browser has no file system). CADCraft has no
    // file.saveBytes, so the bytes come inline from document.bytes (lead live check:
    // execute('document.bytes', {}) -> { bytes: <count>, data: <base64> }; the web build
    // refuses DWG, so .dxf is the only native format and a .dwg target is refused by the
    // guard with the .dxf fix). The result name is the inspect title + .dxf (a new
    // drawing is Drawing1). teachApp turns a "no drawing open" rejection into the
    // new_drawing teaching error.
    run: async (args, ctx) => {
      const wrapper = await ctx.host.appWindow(APP);
      const craft = teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix);
      const save = await saveBytesCopy(craft, {
        id: APP, title: 'CadCraft', wrapperWindow: wrapper, target: args.path,
        tool: 'cadcraft.save_copy', nativeExt: '.dxf', inlineCommand: { command: 'document.bytes', params: {} },
      });
      const written = await filesCall(
        ctx,
        files => files.writeBytes(args.path, save.bytes, { overwrite: Boolean(args.overwrite) }),
        error => (error.code === 'exists' ? callLine('cadcraft.save_copy', { path: args.path, overwrite: true }) : ''),
      );
      return { path: written.path, name: save.name, size: written.size, created: written.created, ...(save.note ? { note: save.note } : {}) };
    },
  },
];

// Live-check exports (brief): every command id the curated tools pass to execute,
// and every control method passed to request. run_command also passes arbitrary
// ids from the live commands() list.
export const usesCommands = ['circle', 'line', 'move', 'selectall', 'text', 'entities', 'texts', 'new', 'document.bytes'];
export const usesMethods = ['cmdline.input', 'cmdline.script', 'drawing.inspect', 'cmdline.key'];
