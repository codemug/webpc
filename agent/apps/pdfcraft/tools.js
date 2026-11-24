// Ported from storytold/pdfcraft@v0.21.1 crates/automation/src/tools.rs (MIT OR Apache-2.0). Tool names, descriptions and the engine-command mapping follow that table; arguments are flattened for small models. Only tools with a confirmed engine command id (tools.rs .cmd()) are ported: the web page runs registry commands by id (apps/pdfcraft-web/src/api.rs ui.command), and the desktop-only session tools have no id.
// The tools run in Buddy's frame and drive the PdfCraft page API through ctx.craft,
// which the runtime wires as id => craftApi(await ctx.host.appWindow(id), id) (plan 9).
import { ToolError, callLine, closest } from '../../../src/apps/ai-agent/runtime/args.mjs';
import { teachApp } from '../../shared/craft.js';
import { filesCall, openAndAwait, readOpenFile, saveBytesCopy } from '../../shared/craft-files.js';
import { releases } from '../../../scripts/pc/craft/releases.mjs';

const APP = 'pdfcraft';
const NEEDS = ['host', 'app:pdfcraft'];
// run_command ids that destroy or close data: effectFor marks those calls destructive
// (the upstream destructive flags on doc_close and page_delete, plus the lane rule that
// closing the document is destructive).
const DESTRUCTIVE = ['file.close', 'file.save', 'page.delete'];
// With no PDF open the page's command gate refuses calls with "<id> is disabled right
// now" (control/host.rs:172) and the page rejects (the control protocol ok:false,
// craft-libs page.rs). teachApp turns that wording into the teaching error below; the
// fix is a file to open (the pack has no new-file tool; file-level open comes later).
const NO_DOC = { message: 'PDFCraft has no document open.', fix: 'Open a PDF in PDFCraft first' };

/** tools.rs pick(): copy the listed keys (when present) into a params object. */
const pick = (args, keys) => {
  const out = {};
  for (const key of keys) if (args[key] !== undefined) out[key] = args[key];
  return out;
};

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

// Every ported tool takes the optional doc id; upstream requires it, the web page holds one document.
const DOC = { type: 'integer', description: 'Document id; omit for the open document' };

export const pack = { id: APP, title: 'PdfCraft' };

export const tools = [
  {
    name: 'pdfcraft.doc_inspect',
    purpose: 'Inspect the open PDF: its editor state.',
    when: 'Use when the user asks about the open document, or before planning edits.',
    params: {},
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: {}, says: 'What document is open?' }],
    // mcp.rs doc_inspect -> the page ui.state control method (apps/pdfcraft-web/src/api.rs)
    run: async (args, ctx) => (await ctx.craft(APP)).inspect(),
  },
  {
    name: 'pdfcraft.doc_info',
    purpose: 'Show the open document: its state, page, zoom and mode.',
    when: 'Use when the user asks what is in the open document or which page it shows.',
    params: {},
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: {}, says: 'How many pages does this PDF have?' }],
    // The live file.properties opens the Properties dialog and returns only
    // {"ran":"file.properties"} (lead live check), so the info comes from the page's
    // docInspect (ui.state, the same source as doc_inspect) instead.
    run: async (args, ctx) => (await ctx.craft(APP)).inspect(),
  },
  {
    name: 'pdfcraft.text_word_count',
    purpose: 'Count words and characters, per page or in total.',
    when: 'Use when the user asks for a word count of the document or pages.',
    params: {
      doc: DOC,
      pages: { type: 'string', description: 'Pages to count, e.g. 3 or 1-3, 6; all when omitted' },
    },
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: {}, says: 'How many words in this document?' }],
    // tools.rs:255-260 text_word_count, ro, engine command file.word_count
    run: async (args, ctx) => teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).execute('file.word_count', pick(args, ['doc', 'pages'])),
  },
  {
    name: 'pdfcraft.text_find',
    purpose: 'Find a phrase and get the matching pages and line positions.',
    when: 'Use when the user wants to find where a phrase occurs in the document.',
    params: {
      doc: DOC,
      query: { type: 'string', required: true, description: 'The phrase to find (case-insensitive)' },
      limit: { type: 'integer', min: 1, description: 'Maximum matches (default 500)' },
    },
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: { query: 'invoice' }, says: 'Where does the word invoice appear?' }],
    // tools.rs:272-278 text_find, ro, engine command edit.find
    run: async (args, ctx) => teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).execute('edit.find', pick(args, ['doc', 'query', 'limit'])),
  },
  {
    name: 'pdfcraft.text_replace',
    purpose: 'Find and replace text, keeping the paragraph formatting.',
    when: 'Use when the user wants to replace a phrase throughout the document.',
    params: {
      doc: DOC,
      find: { type: 'string', required: true, description: 'The text to find' },
      replace: { type: 'string', required: true, description: 'The replacement text; empty deletes the match' },
      all: { type: 'boolean', description: 'Every match (default) or only the first' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { find: '2025', replace: '2026' }, says: 'Replace the old year everywhere' }],
    // tools.rs:279-289 text_replace, engine command edit.replace
    run: async (args, ctx) => teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).execute('edit.replace', pick(args, ['doc', 'find', 'replace', 'all'])),
  },
  {
    name: 'pdfcraft.page_rotate',
    purpose: 'Rotate pages by a multiple of 90 degrees.',
    when: 'Use when the user wants pages rotated to portrait or landscape.',
    params: {
      doc: DOC,
      degrees: { type: 'integer', required: true, description: 'Rotation in degrees, a multiple of 90; positive is clockwise' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { degrees: 90 }, says: 'Rotate all pages 90 degrees clockwise' }],
    // tools.rs:290-299 page_rotate, engine command page.rotate
    run: async (args, ctx) => teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).execute('page.rotate', pick(args, ['doc', 'degrees'])),
  },
  {
    name: 'pdfcraft.page_reverse',
    purpose: 'Reverse the order of pages among the positions they occupy.',
    when: 'Use when the user wants the page order flipped.',
    params: {
      doc: DOC,
      pages: { type: 'string', description: 'Pages to reverse, e.g. 1-5; all when omitted' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Reverse the page order' }],
    // tools.rs:332-334 page_reverse, engine command page.reverse
    run: async (args, ctx) => teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).execute('page.reverse', pick(args, ['doc', 'pages'])),
  },
  {
    name: 'pdfcraft.page_insert_blank',
    purpose: 'Insert a blank page at a position.',
    when: 'Use when the user wants an empty page added.',
    params: {
      doc: DOC,
      at: { type: 'integer', min: 1, required: true, description: 'Position the blank page takes (1-based)' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { at: 2 }, says: 'Insert a blank page before page 2' }],
    // tools.rs:335-340 page_insert_blank, engine command page.insert_blank
    run: async (args, ctx) => teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).execute('page.insert_blank', pick(args, ['doc', 'at'])),
  },
  {
    name: 'pdfcraft.page_duplicate',
    purpose: 'Insert copies of pages after or at a position.',
    when: 'Use when the user wants pages copied inside the document.',
    params: {
      doc: DOC,
      pages: { type: 'string', required: true, description: 'Pages to duplicate, e.g. 1 or 2-4' },
      at: { type: 'integer', min: 1, description: 'Position of the first copy; after the last page when omitted' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { pages: '1' }, says: 'Duplicate the first page' }],
    // tools.rs:1174-1176 page_duplicate, engine command page.duplicate
    run: async (args, ctx) => teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).execute('page.duplicate', pick(args, ['doc', 'pages', 'at'])),
  },
  {
    name: 'pdfcraft.page_add_text',
    purpose: 'Add text to a page as page content, with font and style.',
    when: 'Use when the user wants text written onto a page.',
    params: {
      doc: DOC,
      page: { type: 'integer', min: 1, required: true, description: 'Page (1-based)' },
      text: { type: 'string', required: true, description: 'The text; newlines start new lines' },
      x: { type: 'number', description: 'Left, points from the top-left of the page' },
      y: { type: 'number', description: 'Top, points from the top-left of the page' },
      width: { type: 'number', description: 'Wrap width in points (default 200)' },
      font: { type: 'enum', values: ['helvetica', 'times', 'courier'], description: 'Font' },
      size: { type: 'number', min: 1, description: 'Font size in points' },
      bold: { type: 'boolean', description: 'Bold' },
      italic: { type: 'boolean', description: 'Italic' },
      color: { type: 'string', description: 'Color #RRGGBB or a name' },
      align: { type: 'enum', values: ['left', 'center', 'right', 'justify'], description: 'Alignment' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { page: 1, text: 'CONFIDENTIAL', x: 50, y: 50, font: 'helvetica', size: 24, bold: true }, says: 'Stamp CONFIDENTIAL on the first page' }],
    // tools.rs:808-828 page_add_text, engine command edit.text; x/y become the at point
    run: async (args, ctx) => {
      const params = pick(args, ['doc', 'page', 'text', 'width', 'font', 'size', 'bold', 'italic', 'color', 'align']);
      if (args.x !== undefined && args.y !== undefined) params.at = [args.x, args.y];
      return teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).execute('edit.text', params);
    },
  },
  {
    name: 'pdfcraft.link_add',
    purpose: 'Add a link over a page rect to a URL or a page.',
    when: 'Use when the user wants a clickable link on a page.',
    params: {
      doc: DOC,
      page: { type: 'integer', min: 1, required: true, description: 'Page (1-based)' },
      rect: { type: 'list', required: true, description: 'Link box [x0, y0, x1, y1] in points from the top-left' },
      url: { type: 'string', description: 'URL to open' },
      to_page: { type: 'integer', min: 1, description: 'Page to go to instead of a URL' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { page: 1, rect: [50, 50, 200, 70], url: 'https://example.com' }, says: 'Add a link to example.com on page 1' }],
    // tools.rs:882-892 link_add, engine command edit.link; rect arrives as strings from flat calls
    run: async (args, ctx) => {
      const rect = args.rect.map(value => Number(value));
      if (rect.some(value => !Number.isFinite(value))) throw new ToolError('invalid_argument', 'rect must be 4 numbers: x0, y0, x1, y1', '');
      return teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).execute('edit.link', { ...pick(args, ['doc', 'page', 'url', 'to_page']), rect });
    },
  },
  {
    name: 'pdfcraft.edit_undo',
    purpose: 'Undo the last edit of the document.',
    when: 'Use when the user wants to undo the last change.',
    params: { doc: DOC },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Undo that' }],
    // tools.rs:1802 edit_undo, engine command edit.undo
    run: async (args, ctx) => teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).execute('edit.undo', pick(args, ['doc'])),
  },
  {
    name: 'pdfcraft.edit_redo',
    purpose: 'Redo the last undone edit of the document.',
    when: 'Use when the user wants to redo the change they just undid.',
    params: { doc: DOC },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Bring that back' }],
    // tools.rs:1803 edit_redo, engine command edit.redo
    run: async (args, ctx) => teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).execute('edit.redo', pick(args, ['doc'])),
  },
  {
    name: 'pdfcraft.page_delete',
    purpose: 'Delete pages from the document.',
    when: 'Use when the user wants to remove pages.',
    params: {
      doc: DOC,
      pages: { type: 'string', required: true, description: 'Pages to delete, e.g. 3 or 2-4' },
    },
    effect: 'destructive',
    needs: NEEDS,
    examples: [{ args: { pages: '3' }, says: 'Delete the third page' }],
    // tools.rs:324-327 page_delete, destructive, engine command page.delete
    run: async (args, ctx) => teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).execute('page.delete', pick(args, ['doc', 'pages'])),
  },
  {
    name: 'pdfcraft.doc_close',
    purpose: 'Close the document; fails with unsaved changes unless discard_changes.',
    when: 'Use when the user wants to close the document.',
    params: {
      doc: DOC,
      discard_changes: { type: 'boolean', description: 'Close even with unsaved changes' },
    },
    effect: 'destructive',
    needs: NEEDS,
    examples: [{ args: { discard_changes: true }, says: 'Close the document and discard changes' }],
    // tools.rs:194-196 doc_close, engine command file.close. Destructive by the lane
    // rule (it closes the document) although upstream does not flag it.
    run: async (args, ctx) => teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).execute('file.close', pick(args, ['doc', 'discard_changes'])),
  },
  {
    name: 'pdfcraft.doc_save',
    purpose: 'Save the document to its own file.',
    when: 'Use when the user wants to save the changes.',
    params: {
      doc: DOC,
      flatten_fill_sign: { type: 'boolean', description: 'Bake Fill & Sign marks into the page first (default false)' },
    },
    effect: 'destructive',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Save the document' }],
    // tools.rs:197-212 doc_save, destructive, engine command file.save. The path, full
    // and out-file variants need a file path, so the web port saves in place only.
    run: async (args, ctx) => teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix).execute('file.save', pick(args, ['doc', 'flatten_fill_sign'])),
  },
  {
    name: 'pdfcraft.command_list',
    purpose: 'Find PDF menu commands by a word in their name.',
    when: 'Use when the user wants a menu action and its command id is unknown.',
    params: { query: { type: 'string', description: 'Substring of the command id or label; omit to list the first 10' } },
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: { query: 'page' }, says: 'Which commands work on pages?' }],
    // Generic tool (plan 9): the top 10 of the live commands() by case-insensitive match,
    // trimmed like the pilot (the upstream mcp.rs command_list lists every command).
    run: async (args, ctx) => {
      const all = await (await ctx.craft(APP)).commands();
      const q = String(args.query ?? '').trim().toLowerCase();
      return all.filter(command => !q || [command.id, command.label].some(part => String(part ?? '').toLowerCase().includes(q)))
        .slice(0, 10).map(command => ({ id: command.id, label: command.label, menu: command.menu, params: command.params }));
    },
  },
  {
    name: 'pdfcraft.run_command',
    purpose: 'Run any PdfCraft registry command by id with parameters.',
    when: `Use when a menu action is wanted by id; ${DESTRUCTIVE.join(', ')} are destructive.`,
    params: {
      command: { type: 'string', required: true, description: 'Command id from pdfcraft.command_list, e.g. page.rotate or edit.find' },
      params: { type: 'text', description: 'Parameters as key=value lines, one per line; omit for the defaults' },
    },
    effect: 'change',
    effectFor: args => (DESTRUCTIVE.some(prefix => String(args.command ?? '').startsWith(prefix)) ? 'destructive' : 'change'),
    needs: NEEDS,
    examples: [{ args: { command: 'page.rotate', params: 'degrees=180' }, says: 'Rotate all pages 180 degrees' }],
    // Generic tool (plan 9): unknown ids get invalid_argument with the 3 closest ids
    run: async (args, ctx) => {
      const app = teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix);
      const all = await app.commands();
      if (!all.some(command => command.id === args.command)) {
        const near = closest(args.command, all.map(command => command.id), 3);
        const fix = near.length > 0 ? callLine('pdfcraft.run_command', { command: near[0] }) : '';
        throw new ToolError('invalid_argument', `unknown command "${args.command}"${near.length > 0 ? `; closest: ${near.join(', ')}` : ''}`, fix);
      }
      return app.execute(args.command, parseParams(args.params));
    },
  },
  {
    name: 'pdfcraft.open_file',
    purpose: 'Open a PDF from Files in PdfCraft.',
    when: 'Use when the user wants a PDF from Files. Not for opening the app itself; that is desktop.open_app.',
    params: { path: { type: 'path', required: false, description: 'A Files path to a .pdf file' } },
    effect: 'change',
    needs: ['host', 'app:pdfcraft', 'files'],
    examples: [{ args: { path: '/PDFCraft/contract.pdf' }, says: 'Open the contract PDF from Files' }],
    // Drives the wrapper's own #file input (app.mjs:38), so the open posts from the wrapper
    // realm, as the app's host bridge requires (craft-libs web-host web.rs:106). The PDF opens
    // as a new tab alongside the open ones (ui-egui app tabs), so a change; the wrapper's own
    // unsaved-changes confirm still applies (app.mjs:35). openAndAwait waits until the app's
    // inspect changes, so the result confirms the PDF actually loaded.
    run: async (args, ctx) => {
      const file = await readOpenFile(ctx, args.path, { id: APP, title: 'PDFCraft' });
      const wrapper = await ctx.host.appWindow(APP);
      const craft = await ctx.craft(APP);
      return openAndAwait(craft, { id: APP, title: 'PDFCraft', wrapperWindow: wrapper, name: file.name, bytes: file.bytes, accept: releases[APP].accept });
    },
  },
  {
    name: 'pdfcraft.save_copy',
    purpose: 'Save the open PDF as a file in Files.',
    when: 'Use when the user wants to keep a copy of the open PDF in Files.',
    params: {
      path: { type: 'path', required: true, description: 'The Files path to write the copy to, e.g. /PDFCraft/contract.pdf' },
      overwrite: { type: 'boolean', description: 'Replace the file when the path already exists; false when omitted' },
    },
    effect: 'change',
    effectFor: args => (args.overwrite ? 'destructive' : 'change'),
    needs: ['host', 'app:pdfcraft', 'files'],
    examples: [{ args: { path: '/PDFCraft/contract.pdf' }, says: 'Save a copy of the PDF to Files' }],
    // No path is ever passed (the browser has no file system). PDFCraft has no file.saveBytes,
    // so saveBytesCopy starts file.save with no path (InPlace, ui-egui commands.rs) and
    // captures the bytes from the pdfcraft:save message the wrapper receives (app.mjs:29-33);
    // the wrapper also downloads the file, and the result says so. InPlace saves under the
    // name the PDF was opened with (native .pdf), so a target with another extension is
    // refused with a fix. teachApp turns a no-document rejection into the teaching error.
    run: async (args, ctx) => {
      const wrapper = await ctx.host.appWindow(APP);
      const craft = teachApp(await ctx.craft(APP), NO_DOC.message, NO_DOC.fix);
      const save = await saveBytesCopy(craft, {
        id: APP, title: 'PDFCraft', wrapperWindow: wrapper, target: args.path,
        tool: 'pdfcraft.save_copy', nativeExt: '.pdf',
      });
      const written = await filesCall(
        ctx,
        files => files.writeBytes(args.path, save.bytes, { overwrite: Boolean(args.overwrite) }),
        error => (error.code === 'exists' ? callLine('pdfcraft.save_copy', { path: args.path, overwrite: true }) : ''),
      );
      return { path: written.path, name: save.name, size: written.size, created: written.created, ...(save.note ? { note: save.note } : {}) };
    },
  },
];

// Live-check exports (brief): every command id the curated tools pass to execute.
// Nothing passes through the request() path (doc_inspect uses inspect()), so
// usesMethods is empty. run_command also passes arbitrary ids from the live list.
export const usesCommands = [
  'file.word_count', 'edit.find', 'edit.replace', 'page.rotate', 'page.reverse',
  'page.insert_blank', 'page.duplicate', 'edit.text', 'edit.link', 'edit.undo', 'edit.redo',
  'page.delete', 'file.close', 'file.save',
];
export const usesMethods = [];
