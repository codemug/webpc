// Ported from storytold/gridcraft@v0.19.1 crates/mcp/src/tools.rs (MIT OR Apache-2.0). Tool names, descriptions and the control-method mapping follow that table; arguments are flattened for small models.
// The tools run in Buddy's frame and drive the GridCraft page API through ctx.craft,
// which the runtime wires as id => craftApi(await ctx.host.appWindow(id), id) (plan 9).
import { ToolError, callLine, closest } from '../../../src/apps/ai-agent/runtime/args.mjs';
import { filesCall, openAndAwait, saveBytesCopy } from '../../shared/craft-files.js';
import { releases } from '../../../scripts/pc/craft/releases.mjs';

const APP = 'gridcraft';
const NEEDS = ['host', 'app:gridcraft'];
// gridcraft.run_command ids that destroy or close data: the when text warns the model to
// ask the user first: effectFor marks those calls destructive, so the policy asks.
const DESTRUCTIVE = ['file.new', 'file.close', 'sheet.delete', 'edit.clear'];
// tools.rs format_range: horizontalAlign -> command (tools.rs:539-546).
const ALIGN = { left: 'home.alignLeft', center: 'home.alignCenter', right: 'home.alignRight', justify: 'home.justify' };

/** tools.rs pick(): copy the listed keys (when present) into a params object. */
const pick = (args, keys) => {
  const out = {};
  for (const key of keys) if (args[key] !== undefined) out[key] = args[key];
  return out;
};

// gridcraft.run_command params: key=value lines -> object, with number and boolean
// coercion (plan 9, the generic long-tail tool).
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

export const pack = { id: APP, title: 'GridCraft' };

export const tools = [
  {
    name: 'gridcraft.inspect',
    purpose: 'Show the open spreadsheet: sheets, ranges, tables, charts, selection.',
    when: 'Use when the user asks what is in the workbook, or before planning cell changes.',
    params: {},
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: {}, says: 'What does this spreadsheet contain?' }],
    // tools.rs:640 document.inspect
    run: async (args, ctx) => (await ctx.craft(APP)).inspect(),
  },
  {
    name: 'gridcraft.read_range',
    purpose: 'Read cell values from a range as rows.',
    when: 'Use when the user asks what is in some cells or a range of the spreadsheet.',
    params: {
      range: { type: 'string', description: 'A1-style range, e.g. A1:D10; the used range when omitted' },
      sheet: { type: 'string', description: 'Sheet name; the active sheet when omitted' },
      formulas: { type: 'boolean', description: 'Return formula text instead of computed values' },
      formatted: { type: 'boolean', description: 'Return display text with number formats applied' },
    },
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: { range: 'A1:D4' }, says: 'What is in the first block of numbers?' }, { args: { range: 'B2', formulas: true }, says: 'What formula is in B2?' }],
    // tools.rs:641 sheet.read
    run: async (args, ctx) => (await ctx.craft(APP)).request('sheet.read', pick(args, ['range', 'sheet', 'formulas', 'formatted'])),
  },
  {
    name: 'gridcraft.set_cells',
    purpose: 'Write rows of values into the spreadsheet starting at a cell.',
    when: 'Use when the user wants to type or paste a table of values into cells.',
    params: {
      start: { type: 'string', required: true, description: 'Top-left cell or range, e.g. A1 or Sheet2!B3' },
      values: { type: 'table', required: true, description: 'Rows of cell values, e.g. [["Item","Cost"],["Rent",1200]]' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { start: 'A1', values: [['Item', 'Cost'], ['Rent', 1200]] }, says: 'Type this table into the sheet' }],
    // tools.rs:642 range.setValues; the wire field is range, so start maps onto it
    run: async (args, ctx) => (await ctx.craft(APP)).execute('range.setValues', { range: args.start, values: args.values }),
  },
  {
    name: 'gridcraft.set_cell',
    purpose: 'Enter one cell exactly as if typed: number, text or formula.',
    when: 'Use when the user wants to set the value of a single cell, or type a formula.',
    params: {
      cell: { type: 'string', required: true, description: 'Cell, e.g. B7 or Sheet2!C3' },
      input: { type: 'string', required: true, description: 'Typed input: a number, text or a =formula' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { cell: 'A1', input: 'Total' }, says: 'Put the word Total in A1' }, { args: { cell: 'B10', input: '=SUM(B2:B9)' }, says: 'Total column B in B10' }],
    // tools.rs:643 cell.set
    run: async (args, ctx) => (await ctx.craft(APP)).execute('cell.set', { cell: args.cell, input: args.input }),
  },
  {
    name: 'gridcraft.get_cell',
    purpose: 'Show one cell: value, formula, display text, style, comment.',
    when: 'Use when the user asks what is in one cell, or whether it holds a formula.',
    params: { cell: { type: 'string', required: true, description: 'Cell, e.g. B7 or Sheet2!C3' } },
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: { cell: 'B7' }, says: 'What is in cell B7?' }],
    // tools.rs:644 cell.get
    run: async (args, ctx) => (await ctx.craft(APP)).execute('cell.get', { cell: args.cell }),
  },
  {
    name: 'gridcraft.evaluate_formula',
    purpose: 'Evaluate a formula against the sheet without changing any cell.',
    when: 'Use when the user wants to check a formula result before typing it in.',
    params: {
      formula: { type: 'string', required: true, description: 'Formula text, with or without the leading =, e.g. =SUM(B2:B10)' },
      cell: { type: 'string', description: 'Evaluate as if in this cell; the active cell when omitted' },
    },
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: { formula: '=SUM(B2:B10)/COUNT(B2:B10)' }, says: 'What is the average of B2 to B10?' }],
    // tools.rs:645-652 formulas.evaluate; a leading = is added when missing
    run: async (args, ctx) => {
      const formula = String(args.formula).startsWith('=') ? args.formula : `=${args.formula}`;
      const result = await (await ctx.craft(APP)).execute('formulas.evaluate', pick({ formula, cell: args.cell }, ['formula', 'cell']));
      return { formula, result };
    },
  },
  {
    name: 'gridcraft.select',
    purpose: 'Set the spreadsheet selection.',
    when: 'Use when the user wants to select cells, or aim the next action at a range.',
    params: {
      range: { type: 'string', required: true, description: 'A1-style range; multiple areas with commas, e.g. A1:B2,D4' },
      active: { type: 'string', description: 'Active cell inside the selection; the top-left when omitted' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { range: 'A1:D10' }, says: 'Select the data block' }],
    // tools.rs:653 selection.set
    run: async (args, ctx) => (await ctx.craft(APP)).execute('selection.set', pick(args, ['range', 'active'])),
  },
  {
    name: 'gridcraft.format_range',
    purpose: 'Bold, color, align or number-format a range in one call.',
    when: 'Use when the user wants cells bold, italic, colored, aligned or currency-formatted.',
    params: {
      range: { type: 'string', required: true, description: 'A1-style range to format, e.g. A1:C1' },
      bold: { type: 'boolean', description: 'Bold on or off' },
      italic: { type: 'boolean', description: 'Italic on or off' },
      font_color: { type: 'string', description: 'Text color "#RRGGBB" or auto' },
      fill: { type: 'string', description: 'Background color "#RRGGBB" or none' },
      number_format: { type: 'string', description: 'Number format name or code, e.g. Currency, Percentage, #,##0.00' },
      align: { type: 'enum', values: ['left', 'center', 'right', 'justify'], description: 'Horizontal alignment' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [
      { args: { range: 'A1:C1', bold: true }, says: 'Make the header row bold' },
      { args: { range: 'B2:B9', number_format: 'Currency' }, says: 'Format column B as money' },
    ],
    // tools.rs:654 format_range (tools.rs:510): one home.* command per style, tools.rs order
    run: async (args, ctx) => {
      const app = await ctx.craft(APP);
      const steps = [];
      if (args.bold !== undefined) steps.push(['home.bold', { on: args.bold }]);
      if (args.italic !== undefined) steps.push(['home.italic', { on: args.italic }]);
      if (args.font_color !== undefined) steps.push(['home.fontColor', { color: args.font_color }]);
      if (args.fill !== undefined) steps.push(['home.fillColor', { color: args.fill }]);
      if (args.number_format !== undefined) steps.push(['home.numberFormat', { format: args.number_format }]);
      if (args.align !== undefined) steps.push([ALIGN[args.align], {}]);
      if (steps.length === 0) throw new ToolError('invalid_argument', 'give at least one of bold, italic, font_color, fill, number_format or align', '');
      const applied = [];
      for (const [id, extra] of steps) {
        await app.execute(id, { range: args.range, ...extra });
        applied.push(id);
      }
      return { range: args.range, applied };
    },
  },
  {
    name: 'gridcraft.insert_chart',
    purpose: 'Insert a chart from a data range, headers as names.',
    when: 'Use when the user wants a chart, graph or plot made from a range of cells.',
    params: {
      range: { type: 'string', required: true, description: 'Source data range including headers, e.g. A1:C6' },
      type: { type: 'enum', required: true, values: ['column', 'bar', 'line', 'pie', 'doughnut', 'area', 'scatter', 'bubble', 'radar', 'combo', 'histogram', 'waterfall', 'funnel', 'treemap', 'sunburst', 'boxWhisker', 'stock'], description: 'Chart type' },
      subtype: { type: 'enum', values: ['clustered', 'stacked', 'stacked100', 'markers'], description: 'Chart variant' },
      title: { type: 'string', description: 'Chart title' },
      at: { type: 'string', description: 'Top-left anchor cell; right of the data when omitted' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { range: 'A1:C6', type: 'column', title: 'Sales' }, says: 'Make a column chart of the sales data' }],
    // tools.rs:655 insert.chart
    run: async (args, ctx) => (await ctx.craft(APP)).execute('insert.chart', pick(args, ['range', 'type', 'subtype', 'title', 'at'])),
  },
  {
    name: 'gridcraft.create_table',
    purpose: 'Format a range as a table with banded rows and filters.',
    when: 'Use when the user wants to turn a range into a table, with header row and filters.',
    params: {
      range: { type: 'string', required: true, description: 'Range including the header row, e.g. A1:D20' },
      style: { type: 'string', description: 'Table style, e.g. TableStyleMedium2; the default when omitted' },
      header: { type: 'boolean', description: 'First row holds headers; true when omitted' },
      name: { type: 'string', description: 'Table name, e.g. Table1; auto-numbered when omitted' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { range: 'A1:D20' }, says: 'Turn the range into a table' }],
    // tools.rs:656 insert.table
    run: async (args, ctx) => (await ctx.craft(APP)).execute('insert.table', pick(args, ['range', 'style', 'header', 'name'])),
  },
  {
    name: 'gridcraft.sort_range',
    purpose: 'Sort a range of rows by one or more columns.',
    when: 'Use when the user wants to sort rows, or put a column in ascending or descending order.',
    params: {
      keys: { type: 'list', required: true, description: 'Sort levels, most significant first: a column letter, or a letter plus desc, e.g. B, A desc' },
      range: { type: 'string', description: 'A1-style range to sort; the region around the selection when omitted' },
      header: { type: 'boolean', description: 'The first row is a header kept in place' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { keys: 'B, A desc', range: 'A1:D20', header: true }, says: 'Sort the table by column B' }],
    // tools.rs:657 sort_range (tools.rs:572): keys normalize to {column, order}, then data.sort
    run: async (args, ctx) => {
      const params = { keys: (args.keys ?? []).map(level => { const [column, order] = String(level).split(/\s+/); return { column, order: /desc/i.test(order ?? '') ? 'desc' : 'asc' }; }) };
      if (args.range !== undefined) params.range = args.range;
      if (args.header !== undefined) params.header = args.header;
      return (await ctx.craft(APP)).execute('data.sort', params);
    },
  },
  {
    name: 'gridcraft.filter',
    purpose: 'Keep only the rows matching a column filter.',
    when: 'Use when the user wants to filter rows, hide non-matching rows or clear a filter.',
    params: {
      column: { type: 'string', required: true, description: 'Column letter to filter on, e.g. C' },
      range: { type: 'string', description: 'Data range to filter; the region around the selection when omitted' },
      values: { type: 'list', description: 'Values to keep, e.g. North, South' },
      custom_op: { type: 'string', description: 'Custom operator: =, <>, >, >=, <, <=, beginsWith, contains' },
      custom_value: { type: 'string', description: 'Value the custom operator compares against' },
      custom_op2: { type: 'string', description: 'Second operator, for a pair of criteria' },
      custom_value2: { type: 'string', description: 'Value for the second operator' },
      custom_and: { type: 'boolean', description: 'Match both criteria (true) or either (false)' },
      top_count: { type: 'integer', min: 1, description: 'Keep the top N rows by this column' },
      top_bottom: { type: 'boolean', description: 'Keep the bottom N instead of the top' },
      top_percent: { type: 'boolean', description: 'Treat N as a percentage of the rows' },
      blanks: { type: 'boolean', description: 'Also keep blank cells' },
      clear: { type: 'boolean', description: 'Clear this column filter' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [
      { args: { column: 'C', values: 'North, South' }, says: 'Show only the North and South rows' },
      { args: { column: 'B', custom_op: '>', custom_value: '100' }, says: 'Keep the rows over 100' },
    ],
    // tools.rs:658 filter (tools.rs:603): selection.set for range, then data.filterBy
    run: async (args, ctx) => {
      const app = await ctx.craft(APP);
      if (args.range !== undefined) await app.execute('selection.set', { range: args.range });
      const params = { column: args.column };
      const put = (key, value) => { if (value !== undefined) params[key] = value; };
      put('values', args.values);
      const custom = {};
      if (args.custom_op !== undefined) custom.op = args.custom_op;
      if (args.custom_value !== undefined) custom.value = args.custom_value;
      if (args.custom_op2 !== undefined) custom.op2 = args.custom_op2;
      if (args.custom_value2 !== undefined) custom.value2 = args.custom_value2;
      if (args.custom_and !== undefined) custom.and = args.custom_and;
      if (Object.keys(custom).length > 0) params.custom = custom;
      const top = {};
      if (args.top_count !== undefined) top.count = args.top_count;
      if (args.top_bottom !== undefined) top.bottom = args.top_bottom;
      if (args.top_percent !== undefined) top.percent = args.top_percent;
      if (Object.keys(top).length > 0) params.top = top;
      put('blanks', args.blanks);
      put('clear', args.clear);
      return app.execute('data.filterBy', params);
    },
  },
  {
    name: 'gridcraft.new_workbook',
    purpose: 'Create a new workbook and make it active.',
    when: 'Use when the user wants a blank spreadsheet, or one of the sample workbooks.',
    params: { sample: { type: 'enum', values: ['budget', 'sales', 'grades'], description: 'Built-in sample workbook; blank when omitted' } },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Start a fresh spreadsheet' }, { args: { sample: 'budget' }, says: 'Start from the budget sample' }],
    // tools.rs:661 file.new. Not destructive: it opens a new workbook alongside the open
    // one (tools.rs:110 UNTARGETED; control-protocol.md Windows: workbooks coexist).
    run: async (args, ctx) => (await ctx.craft(APP)).execute('file.new', pick(args, ['sample'])),
  },
  {
    name: 'gridcraft.undo',
    purpose: 'Undo the last changes in the spreadsheet.',
    when: 'Use when the user wants to undo, or take back the last edit or few edits.',
    params: { steps: { type: 'integer', min: 0, description: 'Number of steps to undo; 1 when omitted' } },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Undo that' }, { args: { steps: 2 }, says: 'Undo the last two changes' }],
    // tools.rs:662 edit.undo
    run: async (args, ctx) => (await ctx.craft(APP)).execute('edit.undo', pick(args, ['steps'])),
  },
  {
    name: 'gridcraft.redo',
    purpose: 'Redo the last undone changes.',
    when: 'Use when the user wants to redo, or bring back the change they just undid.',
    params: { steps: { type: 'integer', min: 0, description: 'Number of steps to redo; 1 when omitted' } },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Bring that back' }],
    // tools.rs:663 edit.redo
    run: async (args, ctx) => (await ctx.craft(APP)).execute('edit.redo', pick(args, ['steps'])),
  },
  {
    name: 'gridcraft.list_functions',
    purpose: 'List spreadsheet functions with signature and description.',
    when: 'Use when the user asks which formula function to use, e.g. for a lookup or a date.',
    params: {
      search: { type: 'string', description: 'Substring of the function name or description' },
      category: { type: 'string', description: 'Category, e.g. Math & Trig, Lookup & Reference' },
    },
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: { search: 'vlookup' }, says: 'Which function looks a value up?' }],
    // tools.rs:665 formulas.functions
    run: async (args, ctx) => (await ctx.craft(APP)).execute('formulas.functions', pick(args, ['search', 'category'])),
  },
  {
    name: 'gridcraft.list_commands',
    purpose: 'Find spreadsheet menu commands by a word in their name.',
    when: 'Use when the user wants a ribbon or menu action and its command id is unknown.',
    params: { query: { type: 'string', description: 'Part of a command id, label or menu path; omit to list the first 10 commands' } },
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: { query: 'border' }, says: 'Which commands add borders?' }],
    // Generic tool (plan 9): the top 10 of the live commands() by case-insensitive match
    run: async (args, ctx) => {
      const all = await (await ctx.craft(APP)).commands();
      const q = String(args.query ?? '').trim().toLowerCase();
      return all.filter(command => !q || [command.id, command.label, command.menu].some(part => String(part ?? '').toLowerCase().includes(q)))
        .slice(0, 10).map(command => ({ id: command.id, label: command.label, params: command.params }));
    },
  },
  {
    name: 'gridcraft.run_command',
    purpose: 'Run any GridCraft menu command by id with parameters.',
    when: `Use when a menu action is wanted by id; ${DESTRUCTIVE.join(', ')} are destructive, so ask first.`,
    params: {
      command: { type: 'string', required: true, description: 'Command id from gridcraft.list_commands, e.g. cell.set or home.bold' },
      params: { type: 'text', description: 'Parameters as key=value lines, one per line; omit for the defaults' },
    },
    effect: 'change',
    effectFor: args => (DESTRUCTIVE.some(prefix => String(args.command ?? '').startsWith(prefix)) ? 'destructive' : 'change'),
    needs: NEEDS,
    examples: [{ args: { command: 'cell.set', params: 'cell=B2\ninput=Hello' }, says: 'Set B2 to Hello' }],
    // Generic tool (plan 9): unknown ids get invalid_argument with the 3 closest ids
    run: async (args, ctx) => {
      const app = await ctx.craft(APP);
      const all = await app.commands();
      if (!all.some(command => command.id === args.command)) {
        const near = closest(args.command, all.map(command => command.id), 3);
        const fix = near.length > 0 ? callLine('gridcraft.run_command', { command: near[0] }) : '';
        throw new ToolError('invalid_argument', `unknown command "${args.command}"${near.length > 0 ? `; closest: ${near.join(', ')}` : ''}`, fix);
      }
      return app.execute(args.command, parseParams(args.params));
    },
  },
  {
    name: 'gridcraft.open_file',
    purpose: 'Open a workbook from Files in GridCraft.',
    when: 'Use when the user wants to open a workbook that is stored in Files.',
    params: { path: { type: 'path', required: true, description: 'The Files path of the workbook, e.g. /GridCraft/budget.xlsx' } },
    effect: 'change',
    needs: ['host', 'app:gridcraft', 'files'],
    examples: [{ args: { path: '/GridCraft/budget.xlsx' }, says: 'Open the budget workbook from Files' }],
    // Drives the wrapper's own #file input (app.mjs:38), so the open posts from the wrapper
    // realm, as the app's host bridge requires (craft-libs web-host web.rs:106). The workbook
    // opens alongside the open ones (engine cmd/file.rs add_document), so a change; the
    // wrapper's own unsaved-changes confirm still applies (app.mjs:35). openAndAwait waits
    // until the app's inspect changes, so the result confirms the workbook actually loaded.
    run: async (args, ctx) => {
      const file = await filesCall(ctx, files => files.readBytes(args.path));
      const wrapper = await ctx.host.appWindow(APP);
      const craft = await ctx.craft(APP);
      return openAndAwait(craft, { id: APP, title: 'GridCraft', wrapperWindow: wrapper, name: file.name, bytes: file.bytes, accept: releases[APP].accept });
    },
  },
  {
    name: 'gridcraft.save_copy',
    purpose: 'Save the active workbook as a file in Files.',
    when: 'Use when the user wants to keep a copy of the workbook in Files.',
    params: {
      path: { type: 'path', required: true, description: 'The Files path to write the copy to, e.g. /GridCraft/budget.xlsx' },
      overwrite: { type: 'boolean', description: 'Replace the file when the path already exists; false when omitted' },
    },
    effect: 'change',
    effectFor: args => (args.overwrite ? 'destructive' : 'change'),
    needs: ['host', 'app:gridcraft', 'files'],
    examples: [{ args: { path: '/GridCraft/budget.xlsx' }, says: 'Save a copy of the workbook to Files' }],
    // No path is ever passed (the browser has no file system). saveBytesCopy takes the bytes
    // inline from file.saveBytes when the live command list has it (no download), else from
    // the no-path file.save the wrapper captures as gridcraft:save (app.mjs:29-33); in that
    // case the wrapper also downloads the file, and the result says so. The bytes are the
    // native .xlsx format, so a target with another extension is refused with a fix.
    run: async (args, ctx) => {
      const wrapper = await ctx.host.appWindow(APP);
      const craft = await ctx.craft(APP);
      const save = await saveBytesCopy(craft, {
        id: APP, title: 'GridCraft', wrapperWindow: wrapper, target: args.path,
        tool: 'gridcraft.save_copy', nativeExt: '.xlsx',
      });
      const written = await filesCall(
        ctx,
        files => files.writeBytes(args.path, save.bytes, { overwrite: Boolean(args.overwrite) }),
        error => (error.code === 'exists' ? callLine('gridcraft.save_copy', { path: args.path, overwrite: true }) : ''),
      );
      return { path: written.path, name: save.name, size: written.size, created: written.created, ...(save.note ? { note: save.note } : {}) };
    },
  },
];
