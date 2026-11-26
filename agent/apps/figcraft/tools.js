// Ported from storytold/figcraft@v0.18.1 crates/mcp/src/tools.rs (MIT OR Apache-2.0). Tool names, descriptions and the control-method mapping follow that table; arguments are flattened for small models (props and params are key=value lines).
// The tools run in Buddy's frame and drive the FigCraft page API through ctx.craft,
// which the runtime wires as id => craftApi(await ctx.host.appWindow(id), id) (plan 9).
import { ToolError, callLine, closest } from '../../../src/apps/ai-agent/runtime/args.mjs';
import { teachApp } from '../../shared/craft.js';
import { filesCall, openAndAwait, readOpenFile, saveBytesCopy } from '../../shared/craft-files.js';
import { releases } from '../../../scripts/pc/craft/releases.mjs';

const APP = 'figcraft';
const NEEDS = ['host', 'app:figcraft'];
// run_command/batch ids that destroy or replace data, from the engine command registry
// (crates/engine/src/cmd): effectFor marks those calls destructive.
// file.new is not listed: the web app holds a document list (session docs/active) and the
// new document becomes active while the others stay (lead live gate, destructive=false).
const DESTRUCTIVE = ['file.close', 'edit.delete', 'page.delete', 'style.delete', 'variable.delete', 'comment.delete', 'version.delete'];
// The web app can run with no open document (engine error.rs: "no open document"); with
// none open the engine commands reject with that wording and the page rejects the call
// (the control protocol ok:false, craft-libs page.rs). teachApp turns it into the
// teaching error below, whose fix creates the document.
const NO_DOC = { message: 'FigCraft has no document open.', fix: callLine('figcraft.new_document') };

/** tools.rs pick(): copy the listed keys (when present) into a params object. */
const pick = (args, keys) => {
  const out = {};
  for (const key of keys) if (args[key] !== undefined) out[key] = args[key];
  return out;
};

// A key=value value: booleans, numbers, a [ ... ] or { ... } JSON value, else a string.
const parseValue = raw => {
  if (/^(true|false)$/i.test(raw)) return raw.toLowerCase() === 'true';
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try { return JSON.parse(raw); } catch { /* not JSON: keep as text */ }
  }
  return raw;
};

// key=value lines -> object (the generic long-tail form for params and props). A JSON object
// or array value passes through as-is (lfm3-1.7b sends engine params as JSON; repairArgs
// serializes an unwrapped wrapper object to JSON text for this slot).
export const parseParams = text => {
  const source = String(text ?? '').trim();
  if (source.startsWith('{') || source.startsWith('[')) {
    try {
      const parsed = JSON.parse(source);
      if (parsed !== null && typeof parsed === 'object') return parsed;
    } catch { /* not JSON: fall through to key=value lines */ }
  }
  const out = {};
  // A literal backslash-n counts as a line break too: small models often write \n in the text.
  for (const line of String(text ?? '').split(/\n|\\n/)) {
    const row = line.trim();
    if (!row) continue;
    const eq = row.indexOf('=');
    if (eq <= 0) throw new ToolError('invalid_argument', `bad params line "${row}": use key=value`, '');
    out[row.slice(0, eq).trim()] = parseValue(row.slice(eq + 1).trim());
  }
  return out;
};

// A batch step "id k=v k2=v2": the id, then space-separated key=value tokens (no spaces in values).
const parseStep = line => {
  const text = String(line ?? '').trim();
  const out = { command: '', params: {} };
  if (!text) return null;
  const sp = text.indexOf(' ');
  out.command = sp < 0 ? text : text.slice(0, sp);
  for (const token of sp < 0 ? [] : text.slice(sp + 1).split(/\s+/)) {
    const eq = token.indexOf('=');
    if (eq <= 0) throw new ToolError('invalid_argument', `bad batch step "${text}": params are key=value tokens`, '');
    out.params[token.slice(0, eq)] = parseValue(token.slice(eq + 1));
  }
  return out;
};

export const pack = { id: APP, title: 'FigCraft' };

export const tools = [
  {
    name: 'figcraft.list_commands',
    purpose: 'Find design commands by a word in the id, label or menu.',
    when: 'Use when the user wants a menu, panel or shortcut action and its id is unknown.',
    params: { query: { type: 'string', description: 'Substring of the id, label, menu path or parameter doc; omit to list the first 10' } },
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: { query: 'align' }, says: 'Which commands align layers?' }],
    // Generic tool (plan 9): the top 10 of the live commands() filtered as tools.rs:584-625
    run: async (args, ctx) => {
      const all = await (await ctx.craft(APP)).commands();
      const q = String(args.query ?? '').trim().toLowerCase();
      return all.filter(command => !q || ['id', 'label', 'menu', 'params'].some(key => String(command[key] ?? '').toLowerCase().includes(q)))
        .slice(0, 10).map(command => ({ id: command.id, label: command.label, menu: command.menu, params: command.params }));
    },
  },
  {
    name: 'figcraft.run_command',
    purpose: 'Run any FigCraft command by id with parameters.',
    when: `Use when a menu, panel or shortcut action is wanted by id; ${DESTRUCTIVE.join(', ')} are destructive.`,
    params: {
      command: { type: 'string', required: true, description: 'Command id from figcraft.list_commands, e.g. node.create, align.left, file.export' },
      params: { type: 'text', description: 'Parameters as key=value lines, one per line; a [ ... ] or { ... } value is JSON; omit for the defaults' },
    },
    effect: 'change',
    effectFor: args => (DESTRUCTIVE.some(prefix => String(args.command ?? '').startsWith(prefix)) ? 'destructive' : 'change'),
    needs: NEEDS,
    examples: [{ args: { command: 'align.left', params: 'ids=3,4' }, says: 'Left-align the selected layers' }],
    // tools.rs:627-637 engine.execute; unknown ids get invalid_argument with the 3 closest
    run: async (args, ctx) => {
      const app = teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix);
      const all = await app.commands();
      if (!all.some(command => command.id === args.command)) {
        const near = closest(args.command, all.map(command => command.id), 3);
        const fix = near.length > 0 ? callLine('figcraft.run_command', { command: near[0] }) : '';
        throw new ToolError('invalid_argument', `unknown command "${args.command}"${near.length > 0 ? `; closest: ${near.join(', ')}` : ''}`, fix);
      }
      return app.execute(args.command, parseParams(args.params));
    },
  },
  {
    name: 'figcraft.new_document',
    purpose: 'Create a new blank document and switch to it.',
    when: 'Use when the user wants a blank design, or when no document is open.',
    params: { name: { type: 'string', description: 'Document name' } },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { name: 'App' }, says: 'Start a blank document called App' }],
    // file.new {name?} (engine command registry, edit.rs): the web app holds a document
    // list (session docs/active; engine error.rs NoDocument) and the new document becomes
    // active while the others stay, so it is not destructive (lead live gate)
    run: async (args, ctx) => (await ctx.craft(APP)).execute('file.new', pick(args, ['name'])),
  },
  {
    name: 'figcraft.batch',
    purpose: 'Run several commands in order as one undo step.',
    when: 'Use when several edits should be one undo step, or build from earlier results is not needed.',
    params: {
      commands: { type: 'list', required: true, description: 'One step per item: the command id then key=value tokens, e.g. node.create type=text text=Hi' },
      label: { type: 'string', description: 'Undo history label (default Batch)' },
      on_error: { type: 'enum', values: ['abort', 'continue'], description: 'abort (default) rolls back the whole batch on the first failure; continue runs the rest' },
    },
    effect: 'change',
    effectFor: args => (DESTRUCTIVE.some(id => (args.commands ?? []).some(line => String(line ?? '').trim().startsWith(id))) ? 'destructive' : 'change'),
    needs: NEEDS,
    examples: [{ args: { commands: ['node.create type=frame width=480 height=852 name=Shell', 'node.create type=text text=Hi'], label: 'Shell screen' }, says: 'Create a frame and a text as one undo step' }],
    // tools.rs:639-666 one engine command.batch (one undo step); the as/$ref step
    // references are dropped: later steps cannot use earlier results (note in report).
    run: async (args, ctx) => {
      const steps = (args.commands ?? []).map(parseStep).filter(step => step !== null);
      if (steps.length === 0) throw new ToolError('invalid_argument', 'commands needs at least one step', '');
      const params = { label: args.label ?? 'Batch', commands: steps };
      if (args.on_error !== undefined) params.onError = args.on_error;
      return teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).execute('command.batch', params);
    },
  },
  {
    name: 'figcraft.create_node',
    purpose: 'Create a layer: frame, shape, text, section or component.',
    when: 'Use when the user wants a new layer added to the design.',
    params: {
      type: { type: 'enum', required: true, values: ['frame', 'rectangle', 'ellipse', 'polygon', 'star', 'line', 'arrow', 'text', 'vector', 'section', 'component', 'slice'], description: 'Layer type: the kind of layer the user asks for - a shape, text, or a container for other layers' },
      x: { type: 'number', description: 'Left, relative to the parent frame (default 0)' },
      y: { type: 'number', description: 'Top, relative to the parent frame (default 0)' },
      width: { type: 'number', description: 'Width (default 100)' },
      height: { type: 'number', description: 'Height (default 100)' },
      parent: { type: 'integer', description: 'Parent frame or group id; the current page when omitted' },
      index: { type: 'integer', description: 'Z-index among the parent children; on top when omitted' },
      name: { type: 'string', description: 'Layer name' },
      text: { type: 'string', description: 'Characters, for type text' },
      select: { type: 'boolean', description: 'Select the new layer (default true)' },
      props: { type: 'text', description: 'Properties as key=value lines, e.g. fill=#3366FF cornerRadius=12 fontSize=24 layout=vertical gap=8' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { type: 'polygon', width: 170, height: 170, name: 'Glyph', props: 'fill=#7048E8' }, says: 'Add a polygon' }],
    // tools.rs:668-693 node.create, then node.get {id, depth:0} for the new layer
    run: async (args, ctx) => {
      const app = teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix);
      const params = pick(args, ['type', 'x', 'y', 'width', 'height', 'parent', 'index', 'name', 'text', 'select']);
      const props = parseParams(args.props);
      if (Object.keys(props).length > 0) params.props = props;
      const result = await app.execute('node.create', params);
      const id = result.id;
      if (id === undefined) throw new ToolError('app_error', 'node.create returned no id', '');
      const node = await app.request('node.get', { id, depth: 0 });
      return { id, node };
    },
  },
  {
    name: 'figcraft.set_properties',
    purpose: 'Set properties on one or more layers: fill, layout, text, effects.',
    when: 'Use when the user wants to style, move or resize layers.',
    params: {
      ids: { type: 'list', description: 'Layer ids; the selection when omitted' },
      props: { type: 'text', required: true, description: 'Properties as key=value lines, e.g. fill=#3366FF cornerRadius=12 x=10 y=20 fontSize=24 layout=vertical gap=8' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { ids: [3, 4], props: 'fill=#3B5BDB\nopacity=0.9' }, says: 'Make both layers blue' }],
    // tools.rs:694-720 node.set; ids arrive as strings from flat calls, the engine wants numbers
    run: async (args, ctx) => {
      const params = { props: parseParams(args.props) };
      if (args.ids !== undefined) params.ids = args.ids.map(value => Number(value));
      return teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).execute('node.set', params);
    },
  },
  {
    name: 'figcraft.inspect_document',
    purpose: 'Show the document: pages, selection, layer tree, styles, undo.',
    when: 'Use when the user asks what is in the design, or to verify a change.',
    params: {
      depth: { type: 'integer', description: 'Layer tree depth for the current page (default 4)' },
      all_pages: { type: 'boolean', description: 'Expand every page, not only the current one' },
    },
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: {}, says: 'What is in this design?' }, { args: { depth: 2 }, says: 'Show the top two levels of layers' }],
    // tools.rs:794-814 document.inspect; upstream always sends depth (default 4) and allPages
    run: async (args, ctx) => (await ctx.craft(APP)).request('document.inspect', { depth: args.depth ?? 4, allPages: args.all_pages ?? false }),
  },
  {
    name: 'figcraft.get_node',
    purpose: 'Show one layer as JSON with its children to a depth.',
    when: 'Use when the user asks about one layer, or the document tree was too deep.',
    params: {
      id: { type: 'integer', required: true, description: 'Layer id' },
      depth: { type: 'integer', description: 'Child depth (default 1)' },
    },
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: { id: 4 }, says: 'Show layer 4 and its children' }],
    // tools.rs:867 node.get; upstream always sends id and depth (default 1); offset is
    // client-side pagination (tools.rs node_at), never sent on the wire
    run: async (args, ctx) => teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).request('node.get', { id: args.id, depth: args.depth ?? 1 }),
  },
  {
    name: 'figcraft.select',
    purpose: 'Replace the selection with the given layer ids.',
    when: 'Use when the user wants to select layers before styling or deleting them.',
    params: { ids: { type: 'list', required: true, description: 'Layer ids to select; empty deselects everything' } },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { ids: [3, 4] }, says: 'Select layers 3 and 4' }],
    // tools.rs:1020-1029 select.set (or select.none), then document.inspect {depth:0} for the selection
    run: async (args, ctx) => {
      const app = teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix);
      const ids = (args.ids ?? []).map(value => Number(value));
      if (ids.length === 0) await app.execute('select.none', {});
      else await app.execute('select.set', { ids });
      const doc = await app.request('document.inspect', { depth: 0 });
      return { selection: doc.selection ?? null };
    },
  },
  {
    name: 'figcraft.export',
    purpose: 'Export layers as png, svg, pdf or the whole file as fig.',
    when: 'Use when the user wants an image or svg of the design.',
    params: {
      ids: { type: 'list', description: 'Layers to export; the selection, then the page, when omitted' },
      format: { type: 'enum', values: ['png', 'jpg', 'svg', 'webp', 'pdf', 'xml', 'fig'], description: 'Format (default png)' },
      scale: { type: 'number', description: 'Pixel scale for raster formats (default 1)' },
      size: { type: 'string', description: 'Instead of scale: 2x, or a width or height like 512w' },
    },
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: { format: 'svg' }, says: 'Export the selection as SVG' }],
    // tools.rs:1031-1075 file.export. Upstream marks it read-only; without a path the
    // result comes back as data (raster base64, svg as text) instead of a file.
    run: async (args, ctx) => teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).execute('file.export', { ...pick(args, ['format', 'scale', 'size']), ...(args.ids !== undefined ? { ids: args.ids.map(value => Number(value)) } : {}) }),
  },
  {
    name: 'figcraft.undo',
    purpose: 'Undo the last change in the design.',
    when: 'Use when the user wants to undo, or take back the last edit.',
    params: {},
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Undo that' }],
    // tools.rs:572 edit.undo
    run: async (args, ctx) => teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).execute('edit.undo', {}),
  },
  {
    name: 'figcraft.redo',
    purpose: 'Redo the last undone change.',
    when: 'Use when the user wants to redo, or bring back the change they just undid.',
    params: {},
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Bring that back' }],
    // tools.rs:573 edit.redo
    run: async (args, ctx) => teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).execute('edit.redo', {}),
  },
  {
    name: 'figcraft.key',
    purpose: 'Press a key or shortcut as if typed on the canvas.',
    when: 'Use when the user wants a menu shortcut, a tool key or a nudge.',
    params: {
      key: { type: 'string', required: true, description: 'Key: a letter/digit, Escape, Delete, Backspace, Enter, ArrowLeft...' },
      shift: { type: 'boolean', description: 'Shift held' },
      alt: { type: 'boolean', description: 'Alt/Option held' },
      cmd: { type: 'boolean', description: 'Cmd/Ctrl held' },
      ctrl: { type: 'boolean', description: 'Ctrl held (the Control key on macOS)' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { key: 'G', cmd: true }, says: 'Group the selection with the shortcut' }],
    // tools.rs:1209-1215 ui.key with the key plus the mods
    run: async (args, ctx) => teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).request('ui.key', { key: args.key, ...pick(args, ['shift', 'alt', 'cmd', 'ctrl']) }),
  },
  {
    name: 'figcraft.type_text',
    purpose: 'Type into a text layer, replacing its contents when id is given.',
    when: 'Use when the user wants to set or append text on a text layer.',
    params: {
      text: { type: 'string', required: true, description: 'Text to type (\\n for a new line)' },
      id: { type: 'integer', description: 'Text layer to replace the contents of; the active editor when omitted' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { id: 4, text: 'New title' }, says: 'Replace the text in layer 4' }],
    // tools.rs:1217-1233: with id, text.edit.begin, ui.type, text.edit.end (always) and node.get;
    // without id, ui.type at the caret
    run: async (args, ctx) => {
      const app = teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix);
      if (args.id === undefined) return app.request('ui.type', { text: args.text });
      const id = Number(args.id);
      await app.execute('text.edit.begin', { id });
      let typed;
      try {
        typed = await app.request('ui.type', { text: args.text });
      } finally {
        await app.execute('text.edit.end', {}).catch(() => {});
      }
      const node = await app.request('node.get', { id, depth: 0 });
      return { ok: true, node, typed };
    },
  },
  {
    name: 'figcraft.inspect_ui',
    purpose: 'Show the UI state: tool, view, panels, status.',
    when: 'Use when the user asks what tool is active or the current zoom.',
    params: {},
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: {}, says: 'What tool is selected?' }],
    // tools.rs:577 ui.inspect
    run: async (args, ctx) => (await ctx.craft(APP)).request('ui.inspect', {}),
  },
  {
    name: 'figcraft.open_file',
    purpose: 'Open a FigCraft document from Files.',
    when: 'Use when the user wants a FigCraft file from Files. Not for opening the app itself; that is desktop.open_app.',
    params: { path: { type: 'path', required: false, description: 'A Files path to a .figcraft document or an import format (.fig, .json, .svg or image)' } },
    effect: 'change',
    needs: ['host', 'app:figcraft', 'files'],
    examples: [{ args: { path: '/FigCraft/app.figcraft' }, says: 'Open the app design from Files' }],
    // Drives the wrapper's own #file input (app.mjs:38), so the open posts from the wrapper
    // realm, as the page's host bridge requires (craft-libs web-host web.rs:106). The
    // document opens alongside the open ones (the engine holds a document list), so a
    // change. openAndAwait waits until the page's docInspect changes, so the result
    // confirms the document loaded. checkAlreadyOpen: false: this tool also imports
    // (.fig, .json, .svg or image), so a name already in the state is not proof this
    // file is the open document.
    run: async (args, ctx) => {
      const file = await readOpenFile(ctx, args.path, { id: APP, title: 'FigCraft' });
      const wrapper = await ctx.host.appWindow(APP);
      const craft = await ctx.craft(APP);
      return openAndAwait(craft, { id: APP, title: 'FigCraft', wrapperWindow: wrapper, name: file.name, bytes: file.bytes, accept: releases[APP].accept, checkAlreadyOpen: false });
    },
  },
  {
    name: 'figcraft.save_copy',
    purpose: 'Save the active FigCraft document as a file in Files.',
    when: 'Use when the user wants to keep a copy of the design in Files.',
    params: {
      path: { type: 'path', required: true, description: 'The Files path to write the copy to, e.g. /FigCraft/app.figcraft' },
      overwrite: { type: 'boolean', description: 'Replace the file when the path already exists; false when omitted' },
    },
    effect: 'change',
    effectFor: args => (args.overwrite ? 'destructive' : 'change'),
    needs: ['host', 'app:figcraft', 'files'],
    examples: [{ args: { path: '/FigCraft/app.figcraft' }, says: 'Save a copy of the design to Files' }],
    // No path is ever passed (the browser has no file system). file.saveAs {data: true}
    // answers with the bytes inline (engine cmd/file/save.rs save_to None: {name, bytes,
    // data}); the channel returns that result, and the page's download path (ui-egui
    // app/files.rs:42-49) is a UI-only route, so nothing downloads. The bytes are the
    // native .figcraft format, so a target with another extension is refused with a fix.
    run: async (args, ctx) => {
      const wrapper = await ctx.host.appWindow(APP);
      const app = teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix);
      const save = await saveBytesCopy(app, {
        id: APP, title: 'FigCraft', wrapperWindow: wrapper, target: args.path,
        tool: 'figcraft.save_copy', nativeExt: '.figcraft', inlineCommand: { command: 'file.saveAs', params: { data: true } },
      });
      const written = await filesCall(
        ctx,
        files => files.writeBytes(args.path, save.bytes, { overwrite: Boolean(args.overwrite) }),
        error => (error.code === 'exists' ? callLine('figcraft.save_copy', { path: args.path, overwrite: true }) : ''),
      );
      return { path: written.path, name: save.name, size: written.size, created: written.created, ...(save.note ? { note: save.note } : {}) };
    },
  },
];

// Live-check exports (brief): every command id the curated tools pass to execute,
// and every control method passed to request. run_command and batch also pass
// arbitrary ids from the live commands() list.
export const usesCommands = [
  'command.batch', 'file.new', 'node.create', 'node.set', 'file.export', 'edit.undo', 'edit.redo',
  'text.edit.begin', 'text.edit.end', 'select.set', 'select.none', 'file.saveAs',
];
export const usesMethods = ['node.get', 'document.inspect', 'ui.key', 'ui.type', 'ui.inspect'];
