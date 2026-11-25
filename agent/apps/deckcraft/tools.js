// Ported from storytold/deckcraft@v0.18.1 crates/mcp/src/tools.rs (MIT OR Apache-2.0). Tool names, descriptions and the control-method mapping follow that table; arguments are flattened for small models.
// The tools run in Buddy's frame and drive the DeckCraft page API through ctx.craft,
// which the runtime wires as id => craftApi(await ctx.host.appWindow(id), id) (plan 9).
import { ToolError, callLine, closest } from '../../../src/apps/ai-agent/runtime/args.mjs';
import { filesCall, openAndAwait, readOpenFile, saveBytesCopy } from '../../shared/craft-files.js';
import { releases } from '../../../scripts/pc/craft/releases.mjs';

const APP = 'deckcraft';
const NEEDS = ['host', 'app:deckcraft'];
// run_command/batch ids that destroy or replace data: effectFor marks those calls
// destructive. file.new replaces the open presentation (the web app holds one document).
const DESTRUCTIVE = ['file.new', 'file.close', 'slide.delete'];

/** tools.rs pick(): copy the listed keys (when present) into a params object. */
const pick = (args, keys) => {
  const out = {};
  for (const key of keys) if (args[key] !== undefined) out[key] = args[key];
  return out;
};

// key=value coercion: booleans and numbers, everything else a string.
const coerce = raw => (/^(true|false)$/i.test(raw) ? raw.toLowerCase() === 'true' : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw);

// run_command params: key=value lines -> object (plan 9, the generic long-tail tool).
const parseParams = text => {
  const out = {};
  // A literal backslash-n counts as a line break too: small models often write \n in the text.
  for (const line of String(text ?? '').split(/\n|\\n/)) {
    const row = line.trim();
    if (!row) continue;
    const eq = row.indexOf('=');
    if (eq <= 0) throw new ToolError('invalid_argument', `bad params line "${row}": use key=value`, '');
    out[row.slice(0, eq).trim()] = coerce(row.slice(eq + 1).trim());
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
    out.params[token.slice(0, eq)] = coerce(token.slice(eq + 1));
  }
  return out;
};

// tools.rs add_shape/add_text_box: follow-up calls that fail do not fail the tool.
const silently = promise => promise.catch(() => {});

// The engine's name-rejection texts (wasm strings): 'no layout "x"', 'unknown layout `x`',
// 'no theme `x`', 'unknown theme `x`', 'unknown preset `x`', and 'no such shape' for a bad
// shape id (lfm3 deckcraft-12 passed the slide id). Each names the bad value but not the
// valid ones (deckcraft-05: layout "first" was rejected and the model spent its remaining
// rounds hunting for valid names). Re-throw as invalid_argument that names the valid values
// the deck defines - layouts live from document.inspect (layouts[].name), shape ids live
// from slide.inspect of the current slide (shapes[].id), themes and presets from the
// engine's fixed lists - with the closest match filled into the call as the fix line.
const NAME_REJECT = { layout: /(?:no|unknown) layout/i, theme: /(?:no|unknown) theme/i, preset: /unknown preset/i, shape: /no such shape/i };
const STATIC_NAMES = {
  theme: ['DeckCraft', 'Harbor', 'Ember', 'Meadow', 'Nocturne', 'Paper', 'Coral Reef', 'Slate'],
  preset: ['rect', 'roundRect', 'ellipse', 'triangle', 'diamond', 'rightArrow', 'chevron', 'star5', 'heart', 'cloud', 'line'],
};
const namedReject = async (kind, given, tool, fixArgs, craft) => {
  const valid =
    kind === 'layout' ? ((await craft.inspect()).layouts ?? []).map(entry => entry.name)
    : kind === 'shape' ? ((await craft.execute('slide.inspect', {})).shapes ?? []).map(entry => entry.id)
    : STATIC_NAMES[kind];
  const near = closest(String(given), valid.map(String), 1)[0];
  const param = kind === 'shape' ? 'id' : kind;
  const label = kind === 'shape' ? 'shape id' : kind;
  const defined = valid.length ? `; the ${kind === 'shape' ? 'current slide has' : 'deck defines'}: ${valid.join(', ')}` : '';
  throw new ToolError('invalid_argument', `${given} is not a ${label}${defined}${near ? `; closest: ${near}` : ''}`, near ? callLine(tool, { ...fixArgs, [param]: near }) : '');
};

export const pack = { id: APP, title: 'DeckCraft' };

export const tools = [
  {
    name: 'deckcraft.inspect',
    purpose: 'Show the open presentation: slides, sections, theme, selection.',
    when: 'Use when the user asks what is in the deck, or before planning slide changes.',
    params: {},
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: {}, says: 'What does this presentation contain?' }],
    // tools.rs:399 document.inspect
    run: async (args, ctx) => (await ctx.craft(APP)).inspect(),
  },
  {
    name: 'deckcraft.inspect_slide',
    purpose: 'Show one slide: shapes with ids, text, tables, charts, notes.',
    when: 'Use when the user asks about one slide, or before changing its shapes.',
    params: { index: { type: 'integer', description: 'Slide index; the current slide when omitted' } },
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: { index: 1 }, says: 'What is on the second slide?' }],
    // tools.rs:400 slide.inspect
    run: async (args, ctx) => (await ctx.craft(APP)).execute('slide.inspect', pick(args, ['index'])),
  },
  {
    name: 'deckcraft.new_presentation',
    purpose: 'Start a new presentation with one title slide.',
    when: 'Use when the user wants a blank or themed deck to start from.',
    params: {
      theme: { type: 'string', description: 'Theme name: DeckCraft, Harbor, Ember, Meadow, Nocturne, Paper, Coral Reef or Slate' },
      blank: { type: 'boolean', description: 'No first slide' },
    },
    effect: 'destructive',
    needs: NEEDS,
    examples: [{ args: { theme: 'Harbor' }, says: 'Start a new deck with the Harbor theme' }],
    // tools.rs:395 file.new. Destructive: the web app holds one presentation, so this replaces the open one.
    run: async (args, ctx) => {
      const app = await ctx.craft(APP);
      try {
        return await app.execute('file.new', pick(args, ['theme', 'blank']));
      } catch (error) {
        if (args.theme !== undefined && NAME_REJECT.theme.test(String(error?.message ?? error))) await namedReject('theme', args.theme, 'deckcraft.new_presentation', pick(args, ['blank']), app);
        throw error;
      }
    },
  },
  {
    name: 'deckcraft.add_slide',
    purpose: 'Add a slide after the current one with a layout and text.',
    when: 'Use when the user wants a new slide in the deck.',
    params: {
      layout: { type: 'string', description: 'Layout name or kind, e.g. title, titleAndContent, sectionHeader, blank' },
      title: { type: 'string', description: 'Title text' },
      body: { type: 'string', description: 'Body text, one paragraph per line; leading tabs indent' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { layout: 'titleAndContent', title: 'Q1 Plan' }, says: 'Add a slide titled Q1 Plan' }],
    // tools.rs:410 slide.new
    run: async (args, ctx) => {
      const app = await ctx.craft(APP);
      try {
        return await app.execute('slide.new', pick(args, ['layout', 'title', 'body']));
      } catch (error) {
        if (args.layout !== undefined && NAME_REJECT.layout.test(String(error?.message ?? error))) await namedReject('layout', args.layout, 'deckcraft.add_slide', pick(args, ['title', 'body']), app);
        throw error;
      }
    },
  },
  {
    name: 'deckcraft.go_to_slide',
    purpose: 'Make a slide current; shape commands act on the current slide.',
    when: 'Use when the user wants to jump to or work on a specific slide.',
    params: { index: { type: 'integer', required: true, description: 'Slide index' } },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { index: 2 }, says: 'Go to the third slide' }],
    // tools.rs:411 slide.go
    run: async (args, ctx) => (await ctx.craft(APP)).execute('slide.go', pick(args, ['index'])),
  },
  {
    name: 'deckcraft.add_shape',
    purpose: 'Insert a preset shape with size, text and colors.',
    when: 'Use when the user wants a shape: rectangle, ellipse, arrow, star, line.',
    params: {
      preset: { type: 'string', required: true, description: 'Preset name: rect, roundRect, ellipse, triangle, diamond, rightArrow, chevron, star5, heart, cloud, line' },
      x: { type: 'number', required: true, description: 'Left, in points' },
      y: { type: 'number', required: true, description: 'Top, in points' },
      w: { type: 'number', required: true, description: 'Width, in points' },
      h: { type: 'number', required: true, description: 'Height, in points' },
      text: { type: 'string', description: 'Text inside the shape' },
      fill: { type: 'string', description: 'Fill color #RRGGBB or accent1..6' },
      line: { type: 'string', description: 'Outline color #RRGGBB, or none' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { preset: 'rect', x: 40, y: 100, w: 300, h: 120, fill: '#3B5BDB' }, says: 'Add a blue box near the top left' }],
    // tools.rs:412-432 shape.insert, then optional shape.fill and shape.line on the new id
    run: async (args, ctx) => {
      const app = await ctx.craft(APP);
      let result;
      try {
        result = await app.execute('shape.insert', pick({ preset: args.preset, rect: [args.x, args.y, args.w, args.h], text: args.text }, ['preset', 'rect', 'text']));
      } catch (error) {
        if (NAME_REJECT.preset.test(String(error?.message ?? error))) await namedReject('preset', args.preset, 'deckcraft.add_shape', { x: args.x, y: args.y, w: args.w, h: args.h }, app);
        throw error;
      }
      if (args.fill !== undefined) await app.execute('shape.fill', { id: result.id, color: args.fill });
      if (args.line !== undefined) await app.execute('shape.line', args.line === 'none' ? { id: result.id, none: true } : { id: result.id, color: args.line });
      return result;
    },
  },
  {
    name: 'deckcraft.add_text_box',
    purpose: 'Insert a text box with optional size, color and alignment.',
    when: 'Use when the user wants free text on a slide.',
    params: {
      x: { type: 'number', required: true, description: 'Left, in points' },
      y: { type: 'number', required: true, description: 'Top, in points' },
      w: { type: 'number', required: true, description: 'Width, in points' },
      text: { type: 'string', required: true, description: 'Text, one paragraph per line' },
      h: { type: 'number', description: 'Height in points; 30 when omitted' },
      size: { type: 'number', description: 'Font size, in points' },
      color: { type: 'string', description: 'Text color #RRGGBB or a name' },
      align: { type: 'enum', values: ['left', 'center', 'right', 'justify'], description: 'Alignment' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { x: 40, y: 260, w: 500, text: 'Key numbers', size: 24, align: 'left' }, says: 'Add a heading text box' }],
    // tools.rs:433-450 insert.textBox, then text.exit, edit.select and the format.* calls
    run: async (args, ctx) => {
      const app = await ctx.craft(APP);
      const result = await app.execute('insert.textBox', { rect: [args.x, args.y, args.w, args.h ?? 30], text: args.text });
      const id = result.id;
      await silently(app.execute('text.exit', {}));
      await silently(app.execute('edit.select', { ids: [id] }));
      if (args.size !== undefined) await silently(app.execute('format.size', { size: args.size }));
      if (args.color !== undefined) await silently(app.execute('format.color', { color: args.color }));
      if (args.align !== undefined) await silently(app.execute('format.align', { align: args.align }));
      return result;
    },
  },
  {
    name: 'deckcraft.set_text',
    purpose: "Replace a shape's text, keeping its first run's formatting.",
    when: 'Use when the user wants to change the text of a shape on the current slide.',
    params: {
      id: { type: 'integer', required: true, description: 'Shape id from deckcraft.inspect_slide (not the slide id; the slide id from add_slide or inspect is not a shape)' },
      text: { type: 'string', required: true, description: 'New text; leading tabs set bullet levels' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { id: 7, text: 'Updated title' }, says: 'Change the title text' }],
    // tools.rs:451 text.set
    run: async (args, ctx) => {
      const app = await ctx.craft(APP);
      try {
        return await app.execute('text.set', pick(args, ['id', 'text']));
      } catch (error) {
        if (NAME_REJECT.shape.test(String(error?.message ?? error))) await namedReject('shape', args.id, 'deckcraft.set_text', { text: args.text }, app);
        throw error;
      }
    },
  },
  {
    name: 'deckcraft.insert_table',
    purpose: 'Insert a table with rows and columns, optionally filled.',
    when: 'Use when the user wants a table on the slide.',
    params: {
      rows: { type: 'integer', required: true, description: 'Rows' },
      cols: { type: 'integer', required: true, description: 'Columns' },
      data: { type: 'table', description: 'Rows of cell text' },
      x: { type: 'number', description: 'Left (pt); all four set the box' },
      y: { type: 'number', description: 'Top (pt)' },
      w: { type: 'number', description: 'Width (pt)' },
      h: { type: 'number', description: 'Height (pt)' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { rows: 3, cols: 2, data: [['Item', 'Cost'], ['Rent', '1200'], ['Food', '400']] }, says: 'Add a small cost table' }],
    // tools.rs:459-465 insert.table; rect is sent only when all four box values are given
    run: async (args, ctx) => {
      const params = pick(args, ['rows', 'cols', 'data']);
      if ([args.x, args.y, args.w, args.h].every(value => value !== undefined)) params.rect = [args.x, args.y, args.w, args.h];
      return (await ctx.craft(APP)).execute('insert.table', params);
    },
  },
  {
    name: 'deckcraft.insert_chart',
    purpose: 'Insert a chart with categories and series.',
    when: 'Use when the user wants a chart, graph or plot on the slide.',
    params: {
      type: { type: 'string', description: 'Chart type: column, bar, line, pie, doughnut, area, scatter, stackedColumn' },
      title: { type: 'string', description: 'Chart title' },
      categories: { type: 'list', description: 'Category names, e.g. Q1, Q2' },
      series: { type: 'table', description: 'Series as rows: [name, value, value, ...]' },
      x: { type: 'number', description: 'Left (pt); all four set the box' },
      y: { type: 'number', description: 'Top (pt)' },
      w: { type: 'number', description: 'Width (pt)' },
      h: { type: 'number', description: 'Height (pt)' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { type: 'column', title: 'Sales', categories: ['Q1', 'Q2'], series: [['Sales', 12, 18]] }, says: 'Add a column chart of sales' }],
    // tools.rs:466-472 insert.chart; series rows [name, values...] become {name, values}
    run: async (args, ctx) => {
      const params = pick(args, ['type', 'title', 'categories']);
      if (args.series !== undefined) params.series = args.series.map(row => ({ name: row[0], values: row.slice(1) }));
      if ([args.x, args.y, args.w, args.h].every(value => value !== undefined)) params.rect = [args.x, args.y, args.w, args.h];
      return (await ctx.craft(APP)).execute('insert.chart', params);
    },
  },
  {
    name: 'deckcraft.select',
    purpose: 'Select shapes by id; formatting commands then act on them.',
    when: 'Use when the user wants to select shapes before formatting or moving them.',
    params: { ids: { type: 'list', required: true, description: 'Shape ids from deckcraft.inspect_slide' } },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { ids: [3, 4] }, says: 'Select those two shapes' }],
    // tools.rs:473 edit.select; ids arrive as strings from flat calls, the engine wants numbers
    run: async (args, ctx) => {
      const ids = args.ids.map(value => {
        const n = Number(value);
        if (!Number.isFinite(n)) throw new ToolError('invalid_argument', `ids must be numbers, got "${value}"`, '');
        return n;
      });
      return (await ctx.craft(APP)).execute('edit.select', { ids });
    },  },
  {
    name: 'deckcraft.select_tool',
    purpose: 'Pick the pointer tool: select, textBox, shape, pen, highlighter, eraser.',
    when: 'Use when the user wants the app to switch to a drawing or editing tool.',
    params: {
      tool: { type: 'string', required: true, description: 'Tool name: select, textBox, shape, pen, highlighter, eraser, or a preset name' },
      preset: { type: 'string', description: 'Shape preset for the shape tool' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { tool: 'shape', preset: 'ellipse' }, says: 'Switch to the shape tool for ellipses' }],
    // tools.rs:475 ui.tool.select
    run: async (args, ctx) => (await ctx.craft(APP)).request('ui.tool.select', pick(args, ['tool', 'preset'])),
  },
  {
    name: 'deckcraft.key',
    purpose: 'Press a key: editing keys, nudges and shortcuts like cmd+b.',
    when: 'Use when the user wants a keyboard shortcut or nudge in the deck.',
    params: {
      key: { type: 'string', required: true, description: 'Key name or character, e.g. Enter, Backspace, B' },
      shift: { type: 'boolean', description: 'Shift held' },
      alt: { type: 'boolean', description: 'Alt/Option held' },
      cmd: { type: 'boolean', description: 'Cmd/Ctrl held' },
      ctrl: { type: 'boolean', description: 'Ctrl held (the Control key on macOS)' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { key: 'B', cmd: true }, says: 'Bold the selection with the shortcut' }],
    // tools.rs:476-480 ui.key with the mods object plus key
    run: async (args, ctx) => (await ctx.craft(APP)).request('ui.key', { key: args.key, ...pick(args, ['shift', 'alt', 'cmd', 'ctrl']) }),
  },
  {
    name: 'deckcraft.type_text',
    purpose: 'Type text into the text being edited or the selected shape.',
    when: 'Use when the user wants to type into an active text box.',
    params: { text: { type: 'string', required: true, description: 'Text to type' } },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { text: 'Hello' }, says: 'Type Hello into the text box' }],
    // tools.rs:481 ui.text
    run: async (args, ctx) => (await ctx.craft(APP)).request('ui.text', pick(args, ['text'])),
  },
  {
    name: 'deckcraft.batch',
    purpose: 'Run several commands in order; stops at the first error.',
    when: 'Use when several slide edits should happen in one go.',
    params: {
      commands: { type: 'list', required: true, description: 'One command per item: the id then key=value params, e.g. slide.new layout=title title=Q1' },
      keepGoing: { type: 'boolean', description: 'Continue after errors' },
    },
    effect: 'change',
    effectFor: args => (DESTRUCTIVE.some(id => (args.commands ?? []).some(line => String(line ?? '').trim().startsWith(id))) ? 'destructive' : 'change'),
    needs: NEEDS,
    examples: [{ args: { commands: ['slide.new layout=title title=Q1', 'go_to_slide index=1'] }, says: 'Add a slide and jump to it' }],
    // tools.rs:359-394: one engine.execute per step, in order, stop on error unless keepGoing
    run: async (args, ctx) => {
      const app = await ctx.craft(APP);
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
    name: 'deckcraft.list_commands',
    purpose: 'Find deck menu commands by a word in their name.',
    when: 'Use when the user wants a ribbon or menu action and its command id is unknown.',
    params: { query: { type: 'string', description: 'Substring of the command id or label; omit to list the first 10' } },
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: { query: 'transition' }, says: 'Which commands set transitions?' }],
    // Generic tool (plan 9): the top 10 of the live commands() by case-insensitive match
    run: async (args, ctx) => {
      const all = await (await ctx.craft(APP)).commands();
      const q = String(args.query ?? '').trim().toLowerCase();
      return all.filter(command => !q || [command.id, command.label].some(part => String(part ?? '').toLowerCase().includes(q)))
        .slice(0, 10).map(command => ({ id: command.id, label: command.label, menu: command.menu, params: command.params }));
    },
  },
  {
    name: 'deckcraft.run_command',
    purpose: 'Run any DeckCraft menu command by id with parameters.',
    when: `Use when a menu action is wanted by id; ${DESTRUCTIVE.join(', ')} are destructive.`,
    params: {
      command: { type: 'string', required: true, description: 'Command id from deckcraft.list_commands, e.g. slide.new or format.bold' },
      params: { type: 'text', description: 'Parameters as key=value lines, one per line; omit for the defaults' },
    },
    effect: 'change',
    effectFor: args => (DESTRUCTIVE.some(prefix => String(args.command ?? '').startsWith(prefix)) ? 'destructive' : 'change'),
    needs: NEEDS,
    examples: [{ args: { command: 'format.bold', params: 'ids=3' }, says: 'Bold the selected shape' }],
    // Generic tool (plan 9): unknown ids get invalid_argument with the 3 closest ids
    run: async (args, ctx) => {
      const app = await ctx.craft(APP);
      const all = await app.commands();
      if (!all.some(command => command.id === args.command)) {
        const near = closest(args.command, all.map(command => command.id), 3);
        const fix = near.length > 0 ? callLine('deckcraft.run_command', { command: near[0] }) : '';
        throw new ToolError('invalid_argument', `unknown command "${args.command}"${near.length > 0 ? `; closest: ${near.join(', ')}` : ''}`, fix);
      }
      return app.execute(args.command, parseParams(args.params));
    },
  },
  {
    name: 'deckcraft.open_file',
    purpose: 'Open a presentation from Files in DeckCraft.',
    when: 'Use when the user wants to open a deck stored in Files. Not for opening the app itself; that is desktop.open_app.',
    params: { path: { type: 'path', required: false, description: 'A Files path to a deck file (.deckcraft or a .txt/.md outline)' } },
    effect: 'change',
    needs: ['host', 'app:deckcraft', 'files'],
    examples: [{ args: { path: '/DeckCraft/talk.pptx' }, says: 'Open the talk deck from Files' }],
    // Drives the wrapper's own #file input (app.mjs:38), so the open posts from the wrapper
    // realm, as the app's host bridge requires (craft-libs web-host web.rs:106). The deck opens
    // via file.adopt alongside the open ones (engine cmd/file.rs add_opened), so a change; the
    // wrapper's own unsaved-changes confirm still applies (app.mjs:35). openAndAwait waits
    // until the app's inspect changes, so the result confirms the deck actually loaded.
    run: async (args, ctx) => {
      const file = await readOpenFile(ctx, args.path, { id: APP, title: 'DeckCraft' });
      const wrapper = await ctx.host.appWindow(APP);
      const craft = await ctx.craft(APP);
      return openAndAwait(craft, { id: APP, title: 'DeckCraft', wrapperWindow: wrapper, name: file.name, bytes: file.bytes, accept: releases[APP].accept });
    },
  },
  {
    name: 'deckcraft.save_copy',
    purpose: 'Save the active presentation as a file in Files.',
    when: 'Use when the user wants to keep a copy of the presentation in Files.',
    params: {
      path: { type: 'path', required: true, description: 'The Files path to write the copy to, e.g. /DeckCraft/talk.pptx' },
      overwrite: { type: 'boolean', description: 'Replace the file when the path already exists; false when omitted' },
    },
    effect: 'change',
    effectFor: args => (args.overwrite ? 'destructive' : 'change'),
    needs: ['host', 'app:deckcraft', 'files'],
    examples: [{ args: { path: '/DeckCraft/talk.pptx' }, says: 'Save a copy of the deck to Files' }],
    // No path is ever passed (the browser has no file system). saveBytesCopy takes the bytes
    // inline from file.saveBytes when the live command list has it (no download), else from
    // the no-path file.save the wrapper captures as deckcraft:save (app.mjs:29-33); in that
    // case the wrapper also downloads the file, and the result says so. The bytes are the
    // deck in its own .deckcraft format, so a .pptx (or other) target is refused with a fix.
    run: async (args, ctx) => {
      const wrapper = await ctx.host.appWindow(APP);
      const craft = await ctx.craft(APP);
      const save = await saveBytesCopy(craft, {
        id: APP, title: 'DeckCraft', wrapperWindow: wrapper, target: args.path,
        tool: 'deckcraft.save_copy', nativeExt: '.deckcraft',
      });
      const written = await filesCall(
        ctx,
        files => files.writeBytes(args.path, save.bytes, { overwrite: Boolean(args.overwrite) }),
        error => (error.code === 'exists' ? callLine('deckcraft.save_copy', { path: args.path, overwrite: true }) : ''),
      );
      return { path: written.path, name: save.name, size: written.size, created: written.created, ...(save.note ? { note: save.note } : {}) };
    },
  },
];

// Live-check exports (brief): every command id the curated tools pass to execute,
// and every control method passed to request. batch and run_command also pass
// arbitrary ids from the live commands() list.
export const usesCommands = [
  'file.new', 'file.save', 'file.saveBytes', 'slide.inspect', 'slide.new', 'slide.go', 'shape.insert', 'shape.fill', 'shape.line',
  'insert.textBox', 'text.exit', 'edit.select', 'format.size', 'format.color', 'format.align',
  'text.set', 'insert.table', 'insert.chart',
];
export const usesMethods = ['ui.tool.select', 'ui.key', 'ui.text'];
