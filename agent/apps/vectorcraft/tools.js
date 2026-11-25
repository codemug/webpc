// Ported from storytold/vectorcraft@v0.24.1 crates/mcp/src/tools/{definitions.rs,dispatch.rs,handlers.rs} (MIT OR Apache-2.0). Tool names, descriptions and the control-method mapping follow those tables; arguments are flattened for small models.
// The tools run in Buddy's frame and drive the VectorCraft page API through ctx.craft,
// which the runtime wires as id => craftApi(await ctx.host.appWindow(id), id) (plan 9).
import { ToolError, callLine, closest } from '../../../src/apps/ai-agent/runtime/args.mjs';
import { teachApp } from '../../shared/craft.js';
import { filesCall, openAndAwait, readOpenFile, saveBytesCopy, extOf } from '../../shared/craft-files.js';
import { releases } from '../../../scripts/pc/craft/releases.mjs';

const APP = 'vectorcraft';
const NEEDS = ['host', 'app:vectorcraft'];
// document.serialize's format for each saveable extension (engine cmd/fileio/formats.rs
// writable formats: vectorcraft default, svg, svgz, pdf, ai, png, jpg/jpeg, webp, gif,
// txt, dxf, eps/epsf, emf, wmf, tiff, bmp, tga, psd; png8 and template have no distinct
// saveable extension here, .ait is written by file.saveAsTemplate, and the legacy
// .drawcraft document is refused with the .vectorcraft fix).
const SERIALIZABLE_EXT = { '.svg': 'svg', '.svgz': 'svgz', '.pdf': 'pdf', '.ai': 'ai', '.png': 'png', '.jpg': 'jpg', '.jpeg': 'jpg', '.webp': 'webp', '.gif': 'gif', '.txt': 'txt', '.dxf': 'dxf', '.eps': 'eps', '.epsf': 'eps', '.emf': 'emf', '.wmf': 'wmf', '.tiff': 'tiff', '.bmp': 'bmp', '.tga': 'tga', '.psd': 'psd' };
// run_command/batch ids that destroy or replace data, from the engine command registry
// (crates/engine/src/cmd): effectFor marks those calls destructive.
// file.new is not listed: the web app holds a document list and the new document joins
// it as active while the others stay (engine cmd/edit.rs file.new spec; lead live gate).
const DESTRUCTIVE = [
  'file.close', 'document.close', 'object.delete', 'layer.delete', 'edit.clear',
  'object.pathfinder', 'object.slice.delete', 'path.removeAnchor', 'path.deleteAnchors',
];
// The web app can run with no open document: engine commands reject with "no active
// document" or "no document open" (engine error.rs / docmenu.rs) and the page rejects
// (the control protocol ok:false, craft-libs page.rs). teachApp turns that wording into
// the teaching error below. The fix offers both ways out: create the document, or open an
// existing one from Files (sweep b17 08: the new_document-only fix steered the model to a
// fresh document instead of the file the user asked it to open).
const NO_DOC = { message: 'VectorCraft has no document open.', fix: 'call_tool tool=vectorcraft.new_document name=<name>, or open an existing document from Files: call_tool tool=vectorcraft.open_file path=<path>' };

/** definitions.rs pick(): copy the listed keys (when present) into a params object. */
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

// key=value lines -> object (the generic long-tail form for params).
const parseParams = text => {
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
// Exported for the pack test that checks the batch and run_command examples against the
// live command list's param names (small models copy examples verbatim).
export const parseStep = line => {
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

// handlers.rs paint_params: a paint value as the engine wants it ({none}, {color}, or an
// object with color/none/swatch/gradient keys).
const paintOf = value => {
  if (value === null || value === undefined || (typeof value === 'string' && value.toLowerCase() === 'none')) return { none: true };
  if (value && typeof value === 'object' && !Array.isArray(value) && ['color', 'none', 'swatch', 'gradient'].some(key => key in value)) return value;
  return { color: value };
};

// definitions.rs with_draw_options: the paint steps a draw tool appends after the creating
// command, each on the new object's whole appearance (item: null).
const paintSteps = (args, { withItem }) => {
  const steps = [];
  const item = withItem ? { item: null } : {};
  if (args.fill !== undefined) steps.push({ command: 'paint.setFill', params: { ...paintOf(args.fill), ...item } });
  if (args.stroke !== undefined) steps.push({ command: 'paint.setStroke', params: { ...paintOf(args.stroke), ...item } });
  if (args.strokeWidth !== undefined) steps.push({ command: 'stroke.set', params: { weight: args.strokeWidth, ...item } });
  return steps;
};

// Raster export formats take scale (pixels per point); the others ignore it (dispatch.rs:284-291).
const RASTER = new Set(['png', 'jpg', 'webp', 'gif', 'png8', 'tiff', 'bmp', 'tga', 'psd']);

// draw_shape shape id -> engine command (handlers.rs:223-231).
const SHAPE_CMD = { rectangle: 'shape.rectangle', rect: 'shape.rectangle', ellipse: 'shape.ellipse', circle: 'shape.ellipse', polygon: 'shape.polygon', star: 'shape.star', line: 'shape.line' };

export const pack = { id: APP, title: 'VectorCraft' };

export const tools = [
  {
    name: 'vectorcraft.inspect',
    purpose: 'Show the open document: artboards, layer tree, selection, history.',
    when: 'Use when the user asks what is in the drawing, or before planning changes.',
    params: {
      depth: { type: 'integer', description: 'Layer tree depth; 0 is the skeleton' },
      kind: { type: 'string', description: 'Only nodes of one kind' },
      limit: { type: 'integer', description: 'Most nodes to report' },
      offset: { type: 'integer', description: 'First node to report' },
    },
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: {}, says: 'What is in this drawing?' }],
    // dispatch.rs:108-112 document.inspect, sliced to the scope keys (definitions.rs:19)
    run: async (args, ctx) => teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).request('document.inspect', pick(args, ['depth', 'kind', 'limit', 'offset'])),
  },
  {
    name: 'vectorcraft.ui_inspect',
    purpose: 'Show the UI state: tool, panels, dialogs, view, documents.',
    when: 'Use when the user asks what tool is active or the current view.',
    params: {},
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Which tool is selected?' }],
    // dispatch.rs:114-116 ui.inspect
    run: async (args, ctx) => (await ctx.craft(APP)).request('ui.inspect', {}),
  },
  {
    name: 'vectorcraft.select_tool',
    purpose: 'Switch the active tool: selection, pen, rectangle, ellipse, line, ...',
    when: 'Use when the user wants the app to switch to a drawing or editing tool.',
    params: { tool: { type: 'string', required: true, description: 'Tool id: selection, directSelection, pen, rectangle, roundedRectangle, ellipse, polygon, star, lineSegment' } },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { tool: 'pen' }, says: 'Switch to the pen tool' }],
    // dispatch.rs:118 ui.tool.select
    run: async (args, ctx) => (await ctx.craft(APP)).request('ui.tool.select', { tool: args.tool }),
  },
  {
    name: 'vectorcraft.draw_path',
    purpose: 'Create a path from points or SVG data, with paint and stroke.',
    when: 'Use when the user wants a freeform or Bézier path drawn.',
    params: {
      points: { type: 'list', description: 'Anchors: [x,y] pairs or {x,y,in?,out?} objects' },
      d: { type: 'string', description: 'SVG path data instead of points, e.g. M0 0 L100 0 L50 80 Z' },
      closed: { type: 'boolean', description: 'Close the path (points only)' },
      fill: { type: 'string', description: 'Fill color #RRGGBB, or none' },
      stroke: { type: 'string', description: 'Stroke color #RRGGBB, or none' },
      strokeWidth: { type: 'number', description: 'Stroke weight in pt' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { d: 'M0 0 L100 0 L50 80 Z', fill: '#0CA678' }, says: 'Draw a green triangle path' }],
    // handlers.rs:196-218: path.create {anchors or d, closed} plus the paint steps as ONE
    // engine command.batch (handlers.rs:151-194), the new id from the first result
    run: async (args, ctx) => {
      const app = teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix);
      let params;
      if (args.d !== undefined) {
        params = { d: args.d };
      } else if (Array.isArray(args.points) && args.points.length > 0) {
        const anchors = args.points.map(point => (Array.isArray(point) && point.length >= 2 ? { x: Number(point[0]), y: Number(point[1]) } : point));
        params = { anchors, closed: args.closed ?? false };
      } else {
        throw new ToolError('invalid_argument', 'give points or d', '');
      }
      const commands = [{ command: 'path.create', params }, ...paintSteps(args, { withItem: true })];
      const result = await app.execute('command.batch', { label: 'Pen', commands });
      return { id: result?.results?.[0]?.id ?? null };
    },
  },
  {
    name: 'vectorcraft.draw_shape',
    purpose: 'Create a live shape: rectangle, ellipse, polygon, star or line.',
    when: 'Use when the user wants a basic shape drawn.',
    params: {
      shape: { type: 'enum', required: true, values: ['rectangle', 'ellipse', 'polygon', 'star', 'line'], description: 'Shape kind' },
      x: { type: 'number', description: 'Left (rectangle/ellipse)' },
      y: { type: 'number', description: 'Top (rectangle/ellipse)' },
      width: { type: 'number', description: 'Width (rectangle/ellipse)' },
      height: { type: 'number', description: 'Height (rectangle/ellipse)' },
      radius: { type: 'number', description: 'Corner radius (rectangle) or radius (polygon)' },
      cx: { type: 'number', description: 'Centre x (polygon/star)' },
      cy: { type: 'number', description: 'Centre y (polygon/star)' },
      sides: { type: 'integer', description: 'Polygon sides (default 6)' },
      radius1: { type: 'number', description: 'Star outer radius' },
      radius2: { type: 'number', description: 'Star inner radius' },
      points: { type: 'integer', description: 'Star points (default 5)' },
      rotation: { type: 'number', description: 'Rotation in degrees clockwise (polygon/star)' },
      x1: { type: 'number', description: 'Line start x' },
      y1: { type: 'number', description: 'Line start y' },
      x2: { type: 'number', description: 'Line end x' },
      y2: { type: 'number', description: 'Line end y' },
      fill: { type: 'string', description: 'Fill color #RRGGBB, or none' },
      stroke: { type: 'string', description: 'Stroke color #RRGGBB, or none' },
      strokeWidth: { type: 'number', description: 'Stroke weight in pt' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { shape: 'rectangle', x: 20, y: 60, width: 200, height: 120, radius: 12, fill: '#7048E8' }, says: 'Draw a rounded purple box' }],
    // handlers.rs:220-237: the shape command with the geometry params plus the paint steps as
    // ONE engine command.batch (handlers.rs:151-194)
    run: async (args, ctx) => {
      const app = teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix);
      const command = SHAPE_CMD[args.shape];
      if (!command) throw new ToolError('invalid_argument', `unknown shape "${args.shape}" (rectangle, ellipse, polygon, star, line)`, '');
      const label = args.shape === 'rectangle' && Number(args.radius) > 0 ? 'Rounded Rectangle' : args.shape[0].toUpperCase() + args.shape.slice(1);
      const geometry = pick(args, ['x', 'y', 'width', 'height', 'radius', 'cx', 'cy', 'sides', 'radius1', 'radius2', 'points', 'rotation', 'x1', 'y1', 'x2', 'y2']);
      const commands = [{ command, params: geometry }, ...paintSteps(args, { withItem: true })];
      const result = await app.execute('command.batch', { label, commands });
      return { id: result?.results?.[0]?.id ?? null, shape: args.shape };
    },
  },
  {
    name: 'vectorcraft.set_paint',
    purpose: 'Set fill, stroke and/or stroke weight on the selection.',
    when: 'Use when the user wants the selected objects painted a new color.',
    params: {
      fill: { type: 'string', description: 'Fill color #RRGGBB, or none' },
      stroke: { type: 'string', description: 'Stroke color #RRGGBB, or none' },
      strokeWidth: { type: 'number', description: 'Stroke weight in pt' },
      ids: { type: 'list', description: 'Object ids; the selection when omitted' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { fill: '#7048E8', ids: [3, 4] }, says: 'Paint both objects purple' }],
    // dispatch.rs:158-170 + handlers.rs:85-96: one paint command per given paint arg, with
    // ids when given, then {applied, objects} (a note when nothing was painted)
    run: async (args, ctx) => {
      const app = teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix);
      const steps = paintSteps(args, { withItem: false });
      if (steps.length === 0) throw new ToolError('invalid_argument', 'give at least one of fill, stroke, strokeWidth', '');
      if (args.ids !== undefined) for (const step of steps) step.params.ids = args.ids;
      let objects = 0;
      const applied = {};
      for (const step of steps) {
        const result = await app.execute(step.command, step.params);
        if (step.command === 'paint.setFill') applied.fill = args.fill;
        if (step.command === 'paint.setStroke') applied.stroke = args.stroke;
        if (step.command === 'stroke.set') applied.strokeWidth = args.strokeWidth;
        objects = Math.max(objects, Number(result?.objects ?? 0));
      }
      const out = { applied, objects };
      if (objects === 0) out.note = 'no object was painted (nothing selected): only the paint for new art changed';
      return out;
    },
  },
  {
    name: 'vectorcraft.press_key',
    purpose: 'Press a key or shortcut: undo, delete, Escape, a nudge.',
    when: 'Use when the user wants a keyboard shortcut in the drawing.',
    params: {
      key: { type: 'string', required: true, description: 'Key: A-Z, 0-9, Enter, Escape, Delete, Backspace, Tab, Space, Left/Right/Up/Down' },
      shift: { type: 'boolean', description: 'Shift held' },
      alt: { type: 'boolean', description: 'Alt/Option held' },
      cmd: { type: 'boolean', description: 'Cmd/Ctrl held' },
      ctrl: { type: 'boolean', description: 'Ctrl held (the Control key on macOS)' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { key: 'Z', cmd: true }, says: 'Undo with the shortcut' }],
    // dispatch.rs:171-178 ui.key with the mods flattened onto the key
    run: async (args, ctx) => teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).request('ui.key', { key: args.key, ...pick(args, ['shift', 'alt', 'cmd', 'ctrl']) }),
  },
  {
    name: 'vectorcraft.type_text',
    purpose: 'Type text into the focused widget.',
    when: 'Use when the user wants to type into a dialog field or the text tool.',
    params: { text: { type: 'string', required: true, description: 'Text to type' } },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { text: 'Hello' }, says: 'Type Hello into the focused field' }],
    // dispatch.rs:180-182 ui.text
    run: async (args, ctx) => teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).request('ui.text', { text: args.text }),
  },
  {
    name: 'vectorcraft.open_panel',
    purpose: 'Open a panel in the dock: layers, swatches, stroke, transform, ...',
    when: 'Use when the user wants a panel open.',
    params: { panel: { type: 'string', required: true, description: 'Panel id or display label, e.g. layers, swatches, stroke, align, pathfinder, transform' } },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { panel: 'layers' }, says: 'Open the layers panel' }],
    // dispatch.rs:188-190 ui.set with the panel
    run: async (args, ctx) => (await ctx.craft(APP)).request('ui.set', { panel: args.panel }),
  },
  {
    name: 'vectorcraft.export',
    purpose: 'Export the document as svg, pdf, png or another format, as data.',
    when: 'Use when the user wants an svg, pdf or image of the drawing.',
    params: {
      format: { type: 'enum', values: ['svg', 'svgz', 'eps', 'dxf', 'emf', 'wmf', 'pdf', 'ai', 'png', 'jpg', 'webp', 'gif', 'png8', 'tiff', 'bmp', 'tga', 'psd', 'txt', 'vectorcraft', 'template'], description: 'Format; from the default document export when omitted' },
      scale: { type: 'number', description: 'Raster pixels per point (raster formats only)' },
      artboard: { type: 'integer', description: '0-based artboard; the document default when omitted' },
      selection: { type: 'boolean', description: 'Export only the selection, cropped to it' },
    },
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: { format: 'svg' }, says: 'Export the drawing as SVG' }],
    // dispatch.rs:217-237 document.export / document.exportSelection; without a path the bytes
    // come back as dataBase64. The web port cannot write a file, so it is a read.
    run: async (args, ctx) => {
      const params = pick(args, ['format', 'artboard']);
      if (args.format !== undefined && RASTER.has(String(args.format).toLowerCase()) && args.scale !== undefined) params.scale = args.scale;
      const command = args.selection ? 'document.exportSelection' : 'document.export';
      return teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).execute(command, params);
    },
  },
  {
    name: 'vectorcraft.add_text',
    purpose: 'Create point or area text, optionally on a path.',
    when: 'Use when the user wants text added to the drawing.',
    params: {
      text: { type: 'string', required: true, description: 'The text' },
      x: { type: 'number', description: 'Baseline origin x (area type: left)' },
      y: { type: 'number', description: 'First baseline y (area type: top)' },
      width: { type: 'number', description: 'Area type frame width (with height)' },
      height: { type: 'number', description: 'Area type frame height (with width)' },
      size: { type: 'number', description: 'Font size in pt' },
      font: { type: 'string', description: 'Font family' },
      color: { type: 'string', description: 'Text color #RRGGBB' },
      justify: { type: 'enum', values: ['auto', 'left', 'center', 'right', 'justifyAll'], description: 'Paragraph alignment' },
      path: { type: 'integer', description: 'Existing path id to flow the text in (area) or along (onPath)' },
      mode: { type: 'enum', values: ['area', 'onPath'], description: 'With path: how the text flows' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { text: 'Title', x: 60, y: 120, size: 18 }, says: 'Add a title at the top left' }],
    // handlers.rs:247-291: text.createInPath {path, mode (default onPath)} or text.create
    // {x, y, area?}; overflow reported from the reply, or re-read via document.node
    run: async (args, ctx) => {
      const app = teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix);
      const style = pick(args, ['size', 'font', 'color', 'justify', 'vertical']);
      let result;
      if (args.path !== undefined) {
        result = await app.execute('text.createInPath', { ...style, path: args.path, mode: args.mode ?? 'onPath', text: args.text });
      } else if (args.x !== undefined && args.y !== undefined) {
        const params = { ...style, x: args.x, y: args.y, text: args.text };
        if (args.width !== undefined && args.height !== undefined) {
          params.area = { width: args.width, height: args.height, ...pick(args, ['fit', 'fitMinPercent']) };
        }
        result = await app.execute('text.create', params);
      } else {
        // j3 b14 (02): the model crams "Quarterly report\nx=40\ny=80\nsize=24\ncolor=#E8590C"
        // into the text parameter - split the crammed key=value pairs back out and echo
        // them as their own arguments in the fix line, so the retry is spelled for it.
        const [words, ...pairs] = String(args.text).split(/\s+(?=[A-Za-z]+=)/);
        const extra = pairs.join(' ');
        throw new ToolError('invalid_argument',
          `x= and y= are their own arguments - text= is only the words, not the position or style`,
          `call_tool tool=vectorcraft.add_text text=${words || '<the words>'}${extra ? ` ${extra}` : ' x=<x> y=<y>'}`);
      }
      const out = { id: result?.id ?? null };
      if (result?.overflow) out.overflow = true;
      return out;
    },
  },
  {
    name: 'vectorcraft.apply_effect',
    purpose: 'Apply a live effect (drop shadow, warp, blur, ...), or list them.',
    when: 'Use when the user wants an effect on the selection, or the list of effects.',
    params: {
      effect: { type: 'string', description: 'Effect id, e.g. stylize.dropShadow, warp.arc; omit for the catalogue' },
      params: { type: 'text', description: 'Effect parameters as key=value lines; defaults when omitted' },
      ids: { type: 'list', description: 'Object ids; the selection when omitted' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { effect: 'stylize.dropShadow', params: 'x=4\ny=4\nblur=6\nopacity=60' }, says: 'Add a drop shadow to the selection' }],
    // dispatch.rs:239-249: effect.list for the catalogue, else effect.apply {effect, params, ids?}
    run: async (args, ctx) => {
      const app = teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix);
      if (args.effect === undefined) {
        const r = await app.execute('effect.list', {});
        return { catalog: r?.catalog ?? r };
      }
      const params = { effect: args.effect, params: parseParams(args.params) };
      if (args.ids !== undefined) params.ids = args.ids;
      return app.execute('effect.apply', params);
    },
  },
  {
    name: 'vectorcraft.pathfinder',
    purpose: 'Combine objects destructively: unite, intersect, exclude, divide, ...',
    when: 'Use when the user wants shapes boolean-combined.',
    params: {
      operation: { type: 'enum', required: true, values: ['unite', 'minusFront', 'intersect', 'exclude', 'divide', 'trim', 'merge', 'crop', 'outline', 'minusBack'], description: 'Pathfinder operation' },
      ids: { type: 'list', description: 'Object ids; the selection when omitted' },
    },
    effect: 'destructive',
    needs: NEEDS,
    examples: [{ args: { operation: 'unite', ids: [3, 4] }, says: 'Merge the two shapes into one' }],
    // dispatch.rs:250-253: select.set {ids} when given, then object.pathfinder.<operation>
    run: async (args, ctx) => {
      const app = teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix);
      if (args.ids !== undefined) await app.execute('select.set', { ids: args.ids });
      return app.execute(`object.pathfinder.${args.operation}`, {});
    },
  },
  {
    name: 'vectorcraft.transform',
    purpose: 'Move, rotate, scale, reflect or shear the selection.',
    when: 'Use when the user wants objects moved, rotated or resized.',
    params: {
      ids: { type: 'list', description: 'Object ids; the selection when omitted' },
      dx: { type: 'number', description: 'Move right (pt)' },
      dy: { type: 'number', description: 'Move down (pt)' },
      rotate: { type: 'number', description: 'Rotation in degrees counter-clockwise' },
      scale: { type: 'number', description: 'Uniform scale in %' },
      scaleX: { type: 'number', description: 'Horizontal scale in %' },
      scaleY: { type: 'number', description: 'Vertical scale in %' },
      reflect: { type: 'enum', values: ['vertical', 'horizontal'], description: 'Reflect over an axis' },
      shear: { type: 'number', description: 'Shear angle in degrees' },
      origin: { type: 'list', description: 'Transform origin [x, y]; the selection centre when omitted' },
      copy: { type: 'boolean', description: 'Transform a copy instead' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { dx: 0, dy: 24 }, says: 'Move the selection down 24 pt' }],
    // handlers.rs:293-332: select.set {ids} when given, then object.move / object.rotate /
    // object.scale / object.reflect / object.shear in that order; copy on the first op only
    run: async (args, ctx) => {
      const app = teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix);
      if (args.ids !== undefined) await app.execute('select.set', { ids: args.ids });
      const origin = args.origin !== undefined ? { origin: args.origin } : {};
      let copy = args.copy === true;
      const withCopy = params => {
        const out = { ...origin, ...params, copy };
        copy = false;
        return out;
      };
      const done = [];
      if (args.dx !== undefined || args.dy !== undefined) {
        await app.execute('object.move', withCopy({ dx: args.dx ?? 0, dy: args.dy ?? 0 }));
        done.push('move');
      }
      if (args.rotate !== undefined) { await app.execute('object.rotate', withCopy({ angle: args.rotate })); done.push('rotate'); }
      if (args.scale !== undefined || args.scaleX !== undefined || args.scaleY !== undefined) {
        const s = args.scale;
        await app.execute('object.scale', withCopy({ sx: args.scaleX ?? s ?? 100, sy: args.scaleY ?? s ?? 100 }));
        done.push('scale');
      }
      if (args.reflect !== undefined) { await app.execute('object.reflect', withCopy({ axis: args.reflect })); done.push('reflect'); }
      if (args.shear !== undefined) { await app.execute('object.shear', withCopy({ angle: args.shear })); done.push('shear'); }
      if (done.length === 0) throw new ToolError('invalid_argument', 'give at least one of dx/dy, rotate, scale/scaleX/scaleY, reflect, shear', '');
      return { applied: done };
    },
  },
  {
    name: 'vectorcraft.create_graph',
    purpose: 'Create a graph: column, bar, line, area, scatter, pie or radar.',
    when: 'Use when the user wants a chart of some numbers in the drawing.',
    params: {
      type: { type: 'enum', values: ['column', 'stackedColumn', 'bar', 'stackedBar', 'line', 'area', 'scatter', 'pie', 'radar'], description: 'Graph type (default column)' },
      x: { type: 'number', required: true, description: 'Plot left' },
      y: { type: 'number', required: true, description: 'Plot top' },
      width: { type: 'number', required: true, description: 'Plot width' },
      height: { type: 'number', required: true, description: 'Plot height' },
      series: { type: 'list', description: 'Series names' },
      categories: { type: 'list', description: 'Category names' },
      rows: { type: 'table', description: 'Rows of values: [value per series, ...]' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { x: 24, y: 60, width: 400, height: 300, series: ['Sales'], categories: ['Q1', 'Q2'], rows: [[12], [18]] }, says: 'Add a column chart of sales' }],
    // dispatch.rs:255-261 graph.create with all params, type defaulting to column
    run: async (args, ctx) => teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).execute('graph.create', { type: args.type ?? 'column', ...pick(args, ['x', 'y', 'width', 'height', 'series', 'categories', 'rows']) }),
  },
  {
    name: 'vectorcraft.text_wrap',
    purpose: 'Make objects wrap: text flows around them. Release removes it.',
    when: 'Use when the user wants text to flow around a shape.',
    params: {
      ids: { type: 'list', description: 'Object ids; the selection when omitted' },
      offset: { type: 'number', description: 'Gap between text and object in pt (default 6)' },
      invert: { type: 'boolean', description: 'Flow inside the object' },
      release: { type: 'boolean', description: 'Remove the wrap instead' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { offset: 12 }, says: 'Wrap the text around the selection with a 12 pt gap' }],
    // dispatch.rs:262-274: select.set {ids} when given, then object.textWrap.release or
    // object.textWrap.make {offset?, invert?}
    run: async (args, ctx) => {
      const app = teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix);
      if (args.ids !== undefined) await app.execute('select.set', { ids: args.ids });
      if (args.release) return app.execute('object.textWrap.release', {});
      return app.execute('object.textWrap.make', pick(args, ['offset', 'invert']));
    },
  },
  {
    name: 'vectorcraft.undo',
    purpose: 'Undo the last change in the drawing.',
    when: 'Use when the user wants to undo the last edit.',
    params: {},
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Undo that' }],
    // dispatch.rs:275 edit.undo
    run: async (args, ctx) => teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).execute('edit.undo', {}),
  },
  {
    name: 'vectorcraft.redo',
    purpose: 'Redo the last undone change.',
    when: 'Use when the user wants to redo the change they just undid.',
    params: {},
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Bring that back' }],
    // dispatch.rs:276 edit.redo
    run: async (args, ctx) => teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).execute('edit.redo', {}),
  },
  {
    name: 'vectorcraft.batch',
    purpose: 'Run several commands in order; stops at the first error.',
    when: 'Use when several drawing edits should happen in one go.',
    params: {
      commands: { type: 'list', required: true, description: 'One command per item: the id then key=value params, e.g. shape.rectangle x=0 y=0 width=100 height=100' },
      keepGoing: { type: 'boolean', description: 'Continue after errors' },
    },
    effect: 'change',
    effectFor: args => (DESTRUCTIVE.some(id => (args.commands ?? []).some(line => String(line ?? '').trim().startsWith(id))) ? 'destructive' : 'change'),
    needs: NEEDS,
    examples: [{ args: { commands: ['shape.ellipse x=100 y=100 width=100 height=100', 'paint.setFill color=#0CA678'] }, says: 'Draw a circle and paint it green' }],
    // dispatch.rs:327-410: one engine.execute per step, in order, stop on error by default;
    // the atomic/label undo grouping and the $N / $last result references are dropped (report)
    run: async (args, ctx) => {
      const app = teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix);
      const out = [];
      for (const line of args.commands) {
        const step = parseStep(line);
        if (!step) continue;
        const entry = { command: step.command, ok: true, result: null, error: null };
        try {
          entry.result = await app.execute(step.command, step.params);
        } catch (error) {
          entry.ok = false;
          entry.error = error instanceof Error ? error.message : String(error);
        }
        out.push(entry);
        if (!entry.ok && !args.keepGoing) break;
      }
      return out;
    },
  },
  {
    name: 'vectorcraft.list_commands',
    purpose: 'Find drawing commands by a word in the id, label or menu.',
    when: 'Use when the user wants an action and its command id is unknown.',
    params: { query: { type: 'string', description: 'Substring of the command id, label or menu path; omit to list the first 10' } },
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: { query: 'align' }, says: 'Which commands align objects?' }],
    // Generic tool (plan 9): the top 10 of the live commands() filtered as dispatch.rs:93-97
    // (filter on id, label and menu path); trimmed like the pilot. command_list (:99) lists
    // the same commands as a bare array and is deduped here.
    run: async (args, ctx) => {
      const all = await (await ctx.craft(APP)).commands();
      const q = String(args.query ?? '').trim().toLowerCase();
      return all.filter(command => !q || [command.id, command.label, command.menu].some(part => String(part ?? '').toLowerCase().includes(q)))
        .slice(0, 10).map(command => ({ id: command.id, label: command.label, menu: command.menu, params: command.params }));
    },
  },
  {
    name: 'vectorcraft.run_command',
    purpose: 'Run any VectorCraft command by id with parameters.',
    when: `Use when a menu action is wanted by id; ${DESTRUCTIVE.join(', ')} are destructive.`,
    params: {
      command: { type: 'string', required: true, description: 'Command id from vectorcraft.list_commands, e.g. shape.rectangle, object.group, paint.setFill' },
      params: { type: 'text', description: 'Parameters as key=value lines, one per line; a [ ... ] or { ... } value is JSON; omit for the defaults' },
    },
    effect: 'change',
    effectFor: args => (DESTRUCTIVE.some(prefix => String(args.command ?? '').startsWith(prefix)) ? 'destructive' : 'change'),
    needs: NEEDS,
    examples: [{ args: { command: 'shape.rectangle', params: 'x=0\ny=0\nwidth=100\nheight=50' }, says: 'Draw a 100 by 50 rectangle' }],
    // dispatch.rs:98-107 engine.execute; unknown ids get invalid_argument with the 3 closest.
    // command_run (:109) and invoke_menu (:326) run the same way and are deduped here.
    run: async (args, ctx) => {
      const app = teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix);
      const all = await app.commands();
      if (!all.some(command => command.id === args.command)) {
        const near = closest(args.command, all.map(command => command.id), 3);
        const fix = near.length > 0 ? callLine('vectorcraft.run_command', { command: near[0] }) : '';
        throw new ToolError('invalid_argument', `unknown command "${args.command}"${near.length > 0 ? `; closest: ${near.join(', ')}` : ''}`, fix);
      }
      return app.execute(args.command, parseParams(args.params));
    },
  },
  {
    name: 'vectorcraft.new_document',
    purpose: 'Create a new document (name and size optional) and switch to it.',
    when: 'Use when the user wants a new drawing, or when no document is open.',
    params: {
      name: { type: 'string', description: 'Document name (default Untitled-N)' },
      width: { type: 'number', description: 'Artboard width in points (default 612)' },
      height: { type: 'number', description: 'Artboard height in points (default 792)' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { name: 'Draft', width: 612, height: 792 }, says: 'Start a new drawing called Draft on a 612 by 792 artboard' }],
    // file.new {preset?, name?|title?, width? pt=612, height? pt=792, ...} -> {index,
    // previewMode} (engine cmd/edit.rs:22): the web app holds a document list and the new
    // document becomes active while the others stay, so it is not destructive (lead
    // live gate); the name and the two sizes are the params a small model needs. The
    // example carries the default sizes so the describe_tool call template shows all
    // three slots (sweep b17 01: with name-only the template hid width=/height= and the
    // model drew the requested 595 by 842 artboard as a rectangle instead); the defaults
    // are harmless to copy into a fix line.
    run: async (args, ctx) => (await ctx.craft(APP)).execute('file.new', pick(args, ['name', 'width', 'height'])),
  },
  {
    name: 'vectorcraft.open_file',
    purpose: 'Open a VectorCraft document or import vector art from Files.',
    when: 'Use when the user wants to open or import files. Not for opening the app itself; that is desktop.open_app.',
    params: { path: { type: 'path', required: false, description: 'A Files path to a .vectorcraft document or an import format (.svg, .pdf, .ai or image)' } },
    effect: 'change',
    needs: ['host', 'app:vectorcraft', 'files'],
    examples: [{ args: { path: '/VectorCraft/draft.vectorcraft' }, says: 'Open the draft from Files' }],
    // VectorCraft is a standalone wrapper (releases.mjs), so the open rides the bootstrap's
    // download/open path rather than the host bridge: drive the wrapper's own #file input
    // (app.mjs:38) so the wrapper posts vectorcraft:open (app.mjs:35-36) and the bootstrap
    // (bootstrap.js:52-89) hands the bytes to window.vectorcraft.openFile. openAndAwait waits
    // until the page's docInspect changes, so the result confirms the document loaded.
    // checkAlreadyOpen: false: this tool also imports (.svg, .pdf, .ai or image), so a
    // name already in the state is not proof this file is the open document.
    run: async (args, ctx) => {
      const file = await readOpenFile(ctx, args.path, { id: APP, title: 'VectorCraft' });
      const wrapper = await ctx.host.appWindow(APP);
      const craft = await ctx.craft(APP);
      return openAndAwait(craft, { id: APP, title: 'VectorCraft', wrapperWindow: wrapper, name: file.name, bytes: file.bytes, accept: releases[APP].accept, checkAlreadyOpen: false });
    },
  },
  {
    name: 'vectorcraft.save_copy',
    purpose: 'Save the active document to Files as a document or export format.',
    when: 'Use when the user wants to keep a copy of the drawing in Files, as .vectorcraft or an export format.',
    params: {
      path: { type: 'path', required: true, description: 'The Files path to write the copy to; the extension picks the format, e.g. /VectorCraft/draft.vectorcraft or /VectorCraft/draft.svg' },
      overwrite: { type: 'boolean', description: 'Replace the file when the path already exists; false when omitted' },
    },
    effect: 'change',
    effectFor: args => (args.overwrite ? 'destructive' : 'change'),
    needs: ['host', 'app:vectorcraft', 'files'],
    examples: [{ args: { path: '/VectorCraft/draft.vectorcraft' }, says: 'Save a copy of the drawing to Files' }],
    // No path is ever passed (the browser has no file system). document.serialize answers
    // with the bytes inline as {dataBase64, warnings} (svg answers {text} instead; txt
    // an empty dataBase64 when the document has no text; engine cmd/fileio/export.rs
    // serialize), so nothing downloads. The TARGET extension picks
    // the format (lead live check: /logo.svg -> format svg; .vectorcraft or no extension
    // keeps the default), so a target with an extension the app cannot serialize is
    // refused here with the .vectorcraft fix. guard: false: the bytes match the target
    // extension by construction. The result name is the target base: the page's
    // document.inspect carries no top-level title to derive a name from.
    run: async (args, ctx) => {
      const wrapper = await ctx.host.appWindow(APP);
      const app = teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix);
      const ext = extOf(args.path);
      if (ext !== '' && ext !== '.vectorcraft' && !(ext in SERIALIZABLE_EXT)) {
        const base = args.path.split('/').filter(Boolean).pop();
        const fixPath = `${args.path.slice(0, args.path.length - base.length)}${base.replace(/\.[^.]+$/, '')}.vectorcraft`;
        throw new ToolError('invalid_argument', `VectorCraft saves .vectorcraft and its export formats (svg, svgz, pdf, ai, png, jpg, webp, gif, txt, dxf, eps, emf, wmf, tiff, bmp, tga, psd); it cannot write ${ext}.`, callLine('vectorcraft.save_copy', { path: fixPath }));
      }
      const save = await saveBytesCopy(app, {
        id: APP, title: 'VectorCraft', wrapperWindow: wrapper, target: args.path,
        tool: 'vectorcraft.save_copy', nativeExt: '', guard: false,
        inlineCommand: { command: 'document.serialize', params: ext in SERIALIZABLE_EXT ? { format: SERIALIZABLE_EXT[ext] } : {} },
      });
      const base = args.path.split('/').filter(Boolean).pop();
      const name = extOf(base) !== '' ? base : `${base}.vectorcraft`;
      const written = await filesCall(
        ctx,
        files => files.writeBytes(args.path, save.bytes, { overwrite: Boolean(args.overwrite) }),
        error => (error.code === 'exists' ? callLine('vectorcraft.save_copy', { path: args.path, overwrite: true }) : ''),
      );
      return { path: written.path, name, size: written.size, created: written.created, ...(save.note ? { note: save.note } : {}) };
    },
  },
];

// Live-check exports (brief): every command id the pack passes to execute (the fixed ids of
// the draw batches included) and every control method passed to request. batch and
// run_command also pass arbitrary ids from the live commands() list.
export const usesCommands = [
  'command.batch', 'file.new', 'path.create', 'shape.rectangle', 'shape.ellipse', 'shape.polygon', 'shape.star', 'shape.line',
  'paint.setFill', 'paint.setStroke', 'stroke.set', 'select.set', 'text.create', 'text.createInPath',
  'document.node', 'effect.list', 'effect.apply',
  'object.pathfinder.unite', 'object.pathfinder.minusFront', 'object.pathfinder.intersect', 'object.pathfinder.exclude',
  'object.pathfinder.divide', 'object.pathfinder.trim', 'object.pathfinder.merge', 'object.pathfinder.crop',
  'object.pathfinder.outline', 'object.pathfinder.minusBack',
  'object.move', 'object.rotate', 'object.scale', 'object.reflect', 'object.shear',
  'graph.create', 'object.textWrap.make', 'object.textWrap.release', 'document.export', 'document.exportSelection',
  'edit.undo', 'edit.redo', 'document.serialize',
];
export const usesMethods = ['document.inspect', 'ui.inspect', 'ui.tool.select', 'ui.key', 'ui.text', 'ui.set'];
