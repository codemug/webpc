// Ported from storytold/cadcraft@v0.20.1 crates/mcp/src/tools.rs (MIT OR Apache-2.0). Tool names, descriptions and the control-method mapping follow that table; arguments are flattened for small models (window boxes become window_x0..window_y1).
// The tools run in Buddy's frame and drive the CADCraft page API through ctx.craft,
// which the runtime wires as id => craftApi(await ctx.host.appWindow(id), id) (plan 9).
import { ToolError, callLine, closest } from '../../../src/apps/ai-agent/runtime/args.mjs';
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
const parseParams = text => {
  const out = {};
  for (const line of String(text ?? '').split('\n')) {
    const row = line.trim();
    if (!row) continue;
    const eq = row.indexOf('=');
    if (eq <= 0) throw new ToolError('invalid_argument', `bad params line "${row}": use key=value`, '');
    const raw = row.slice(eq + 1).trim();
    out[row.slice(0, eq).trim()] = /^(true|false)$/i.test(raw) ? raw.toLowerCase() === 'true' : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
  }
  return out;
};

export const pack = { id: APP, title: 'CADCraft' };

export const tools = [
  {
    name: 'cadcraft.command_line',
    purpose: 'Type one line at the command line, exactly as a user would.',
    when: 'Use when the user wants to type a command or point at the AutoCAD-style prompt.',
    params: { text: { type: 'string', required: true, description: 'The line: a command (LINE, CIRCLE, MOVE, ZOOM), a point x,y, @dx,dy, a keyword, or empty for Enter' } },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { text: 'circle 0,0 5' }, says: 'Draw a circle at the origin with radius 5' }],
    // tools.rs:119 cmdline.input (spaces act as Enter, so a full command works in one call);
    // the reply carries an in-band error field when the input is refused (control.rs:335)
    run: async (args, ctx) => teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).request('cmdline.input', pick(args, ['text'])),
  },
  {
    name: 'cadcraft.script',
    purpose: 'Run a multi-line command-line script, one input per line.',
    when: 'Use when the user wants several command-line inputs run in sequence.',
    params: { text: { type: 'string', required: true, description: 'Script text: one or more inputs per line, blank line = Enter' } },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { text: 'line\n0,0\n10,0\n' }, says: 'Draw a line from 0,0 to 10,0' }],
    // tools.rs:120 cmdline.script
    run: async (args, ctx) => teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).request('cmdline.script', pick(args, ['text'])),
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
    when: `Use when a menu action is wanted by id; ${DESTRUCTIVE.join(', ')} replaces the drawing, so ask first.`,
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
    purpose: 'Open a drawing from Files in CADCraft.',
    when: 'Use when the user wants a drawing from Files. Not for opening the app itself; that is desktop.open_app.',
    params: { path: { type: 'path', required: true, description: 'A Files path to a drawing file (.dxf, .dwg or .shx)' } },
    effect: 'change',
    needs: ['host', 'app:cadcraft', 'files'],
    examples: [{ args: { path: '/CadCraft/plan.dxf' }, says: 'Open the plan drawing from Files' }],
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
      path: { type: 'path', required: true, description: 'The Files path to write the copy to, e.g. /CadCraft/plan.dxf' },
      overwrite: { type: 'boolean', description: 'Replace the file when the path already exists; false when omitted' },
    },
    effect: 'change',
    effectFor: args => (args.overwrite ? 'destructive' : 'change'),
    needs: ['host', 'app:cadcraft', 'files'],
    examples: [{ args: { path: '/CadCraft/plan.dxf' }, says: 'Save a copy of the drawing to Files' }],
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
export const usesCommands = ['entities', 'texts', 'new', 'document.bytes'];
export const usesMethods = ['cmdline.input', 'cmdline.script', 'drawing.inspect', 'cmdline.key'];
