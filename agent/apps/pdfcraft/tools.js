// Ported from storytold/pdfcraft@v0.21.1 crates/automation/src/tools.rs (MIT OR Apache-2.0). Tool names, descriptions and the engine-command mapping follow that table; arguments are flattened for small models. Only tools with a confirmed engine command id (tools.rs .cmd()) are ported: the web page runs registry commands by id (apps/pdfcraft-web/src/api.rs ui.command), and the desktop-only session tools have no id.
// The tools run in Buddy's frame and drive the PdfCraft page API through ctx.craft,
// which the runtime wires as id => craftApi(await ctx.host.appWindow(id), id) (plan 9).
import { ToolError, callLine, closest } from '../../../src/apps/ai-agent/runtime/args.mjs';
import { teachApp } from '../../shared/craft.js';
import { filesCall, openAndAwait, readOpenFile, saveBytesCopy, saveCopy } from '../../shared/craft-files.js';
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
// fix is a copyable open_file call (b14 pdfcraft-08: six "no document open" refusals
// with prose advice and the file never opened before the round cap).
const NO_DOC = { message: 'PDFCraft has no document open.', fix: 'call_tool tool=pdfcraft.open_file path=<path>' };
// b17 pdfcraft-08: after doc_close and a reopen answered "already open as document 2",
// every tool said "no document open" and the run dead-ended at the round cap. A
// no-document refusal while the app still lists a document names that document's id
// so the model can pass doc=N (or open the file again).
const noDocDetail = async (craft, error) => {
  const docs = (await (typeof craft.inspect === 'function' ? craft.inspect().catch(() => null) : null))?.documents;
  const held = Array.isArray(docs) ? docs.filter(doc => doc && !doc.active) : [];
  if (held.length === 0) return error;
  const list = held.map(doc => `document ${doc.doc} (${doc.name ?? 'unnamed'})`).join(', ');
  return new ToolError('not_available', `PDFCraft has no active document, but ${list} ${held.length === 1 ? 'is' : 'are'} still in the app: pass doc=${held[0].doc} to the tool, or open the file again`, error.fix);
};
// teachApp plus the richer no-document error above, on the two paths that can hit it.
const gate = craft => {
  const taught = teachApp(craft, NO_DOC.message, NO_DOC.fix);
  const wrap = fn => async (...params) => {
    try { return await fn(...params); }
    catch (error) {
      if (error instanceof ToolError && error.type === 'not_available' && error.message === NO_DOC.message) throw await noDocDetail(craft, error);
      throw error;
    }
  };
  return { ...taught, execute: wrap(taught.execute), request: wrap(taught.request) };
};

/** tools.rs pick(): copy the listed keys (when present) into a params object. */
const pick = (args, keys) => {
  const out = {};
  for (const key of keys) if (args[key] !== undefined) out[key] = args[key];
  return out;
};

// key=value lines -> object, with number and boolean coercion (the generic long-tail tool).
const parseParams = text => {
  const out = {};
  // A literal backslash-n counts as a line break too: small models often write \n in the text.
  for (const line of String(text ?? '').split(/\n|\\n/)) {
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

// The web command channel carries no data (probe r7: export.text, edit.column_select and
// file.word_count answer {ran} only), so a real read runs the app's export and captures
// its download the way save_copy does. export.text opens the Export(Text) dialog (probe
// r7: the ui.state dialog field), which is confirmed with Enter (the egui default button);
// when Enter leaves the dialog open, its Export button is clicked from the a11y tree.
const waitDialog = async (craft, name, timeoutMs = 10000, intervalMs = 100) => {
  const start = Date.now();
  for (;;) {
    const state = await craft.inspect();
    if (state?.dialog === name) return;
    if (Date.now() - start >= timeoutMs) throw new ToolError('app_error', `the ${name} dialog did not open`, '');
    await new Promise(done => setTimeout(done, intervalMs));
  }
};

// The a11y tree (the page ui.inspect method) is the only read that reaches the dialog
// content, and its shape is not fixed, so the confirm click tries, in order: the widget id
// read from the tree, the channel's own label lookup (ui.click {label}, resolved through
// AccessKit in the app), and a raw click at the widget rect. The Export(Text) dialog's
// confirm is the "Export" pill button (upstream export_ui.rs); Enter alone does not reach
// it (live probe r9: the dialog stayed open after ui.key Enter).
const collectWidgets = (tree, out = [], seen = new Set()) => {
  if (Array.isArray(tree)) { for (const node of tree) collectWidgets(node, out, seen); return out; }
  if (!tree || typeof tree !== 'object' || seen.has(tree)) return out;
  seen.add(tree);
  if (Array.isArray(tree.rect) && (tree.id != null || tree.label != null)) out.push({ id: tree.id, label: tree.label, rect: tree.rect });
  for (const value of Object.values(tree)) collectWidgets(value, out, seen);
  return out;
};
const clickDialogButton = async (craft, dialogName) => {
  const buttons = collectWidgets(await craft.request('ui.inspect', {}).catch(() => null));
  const hit = buttons.find(b => /export|save|^ok$/i.test(String(b.label ?? '')));
  const errors = [];
  if (hit?.id != null) {
    try { await craft.request('ui.click', { id: hit.id }); return; } catch (error) { errors.push(String(error?.message ?? error)); }
  }
  for (const label of ['Export', 'Save', 'OK']) {
    try { await craft.request('ui.click', { label }); return; } catch (error) { errors.push(`${label}: ${String(error?.message ?? error)}`); }
  }
  const rect = hit?.rect;
  if (Array.isArray(rect) && rect.length >= 2) {
    const [x, y, w = 0, h = 0] = rect.map(Number);
    await craft.request('ui.click', { x: x + w / 2, y: y + h / 2 });
    return;
  }
  throw new ToolError('app_error', `the ${dialogName} dialog has no clickable button in its tree (labels: ${buttons.map(b => b.label).filter(Boolean).slice(0, 8).join('; ') || 'none'}${errors.length ? `; ${errors.join('; ')}` : ''})`, '');
};

// The only text read on the web channel (probe r7): run the app's export and capture its
// download the way save_copy does. export.text opens the Export(Text) dialog (probe r7:
// the ui.state dialog field), which is confirmed with Enter (the egui default button);
// when Enter leaves the dialog open, its Export button is clicked from the a11y tree.
// read_text and the edit tools' read-after-write checks (probe r2: edit commands answer
// {ran} without changing the document in this build) share this read.
const exportText = async (ctx, doc) => {
  const wrapper = await ctx.host.appWindow(APP);
  const craft = gate(await ctx.craft(APP));
  return saveCopy(wrapper, APP, {
    title: 'PDFCraft',
    trigger: async () => {
      await craft.execute('export.text', doc !== undefined ? { doc } : {});
      await waitDialog(craft, 'Export(Text)');
      await craft.request('ui.key', { key: 'Enter' });
      await new Promise(done => setTimeout(done, 500)); // let the dialog close and the export start
      const state = await craft.inspect();
      if (state?.dialog) await clickDialogButton(craft, state.dialog);
    },
  });
};
const exportTextUtf8 = (ctx, doc) => exportText(ctx, doc).then(save => new TextDecoder('utf-8').decode(save.bytes));
// b17 pdfcraft-01: the raw source export carries no page markers, so a small model cannot
// say which page a line is on (lfm3 answered "page 4", counting PDF object numbers). The
// fixtures and small PDFs are simple - a catalog, a pages tree, one content stream per
// page, uncompressed - so cut the source at those streams and prefix each page's text
// lines with "=== page N of M ===". Any PDF the parser cannot place (a compressed
// stream, a missing ref, no catalog) falls back to the raw source via a null return.
const unescapePdfString = s => s
  .replace(/\\([nrtbf()\\])/g, (all, c) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[c]))
  .replace(/\\([0-7]{1,3})/g, (all, oct) => String.fromCharCode(parseInt(oct, 8)));
export const labelPdfPages = raw => {
  try {
    if (typeof raw !== 'string' || !raw.startsWith('%PDF-')) return null;
    const objects = new Map();
    for (const match of raw.matchAll(/\b(\d+) 0 obj\b([\s\S]*?)endobj/g)) objects.set(Number(match[1]), match[2]);
    const ref = (body, key) => body?.match(new RegExp(`/${key}\\s+(\\d+)\\s+0\\s+R`))?.[1];
    const catalog = [...objects.entries()].find(([, body]) => /\/Type\s*\/Catalog/.test(body))?.[0];
    const pagesRoot = ref(objects.get(catalog), 'Pages');
    if (catalog == null || pagesRoot == null) return null;
    // The page objects in the tree's Kids order (one level of nesting, as in the fixtures).
    const pageRefs = [];
    const walk = node => {
      const body = objects.get(Number(node));
      if (body == null) return false;
      if (/\/Type\s*\/Pages/.test(body)) {
        // Whole "N 0 R" refs: \d+ alone would also grab the 0 of each generation part.
        const kids = (body.match(/\/Kids\s*\[([^\]]*)\]/)?.[1] ?? '').match(/\b\d+ 0 R\b/g) ?? [];
        return kids.every(kid => walk(kid.split(' ')[0]));
      }
      if (/\/Type\s*\/Page\b/.test(body)) { pageRefs.push(node); return true; }
      return false;
    };
    if (!walk(pagesRoot) || pageRefs.length === 0) return null;
    const linesOf = streamObj => {
      const body = objects.get(Number(streamObj));
      if (body == null || /FlateDecode/.test(body)) return null; // compressed: keep the raw source
      const data = body.match(/stream\r?\n([\s\S]*?)\r?\nendstream/)?.[1];
      if (data == null) return null;
      // A whole-string Tj, and the strings of a TJ array (the kerning numbers are ignored).
      const lines = [];
      for (const match of data.matchAll(/(?:\(((?:\\.|[^\\()])*)\)\s*Tj|\[((?:\\.|[^\\\]])*)\]\s*TJ)/g)) {
        const parts = [match[1] ?? '', ...[...String(match[2] ?? '').matchAll(/\(((?:\\.|[^\\()])*)\)/g)].map(m => m[1])];
        const line = parts.map(unescapePdfString).filter(part => part.length > 0).join('');
        if (line.length > 0) lines.push(line);
      }
      return lines;
    };
    const pages = pageRefs.map(page => linesOf(ref(objects.get(Number(page)), 'Contents')));
    if (pages.some(lines => lines == null)) return null;
    return pages.map((lines, i) => `=== page ${i + 1} of ${pages.length} ===\n${lines.length > 0 ? lines.join('\n') : '(no text)'}`).join('\n');
  } catch { return null; }
};

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
    name: 'pdfcraft.ui_inspect',
    purpose: 'Read the on-screen accessibility tree: controls, dialog, labels.',
    when: 'Use when the document state is not enough, such as for an open dialog.',
    params: {},
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: {}, says: 'What dialog is open?' }],
    // The page ui.inspect control method (apps/pdfcraft-web/src/api.rs): the accessibility
    // tree, id, role, label, value and rect per element. The only read that reaches
    // open-dialog content on the web build, where every engine command answers {ran}
    // only (probe r7).
    run: async (args, ctx) => (await ctx.craft(APP)).request('ui.inspect', {}),
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
    name: 'pdfcraft.read_text',
    purpose: 'Read the open PDF text, page by page, via the app text export.',
    when: 'Use when the user asks what the document or a page says.',
    params: { doc: DOC },
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: {}, says: 'What does page 1 say?' }],
    // No command answers with text on the web channel (probe r7), so the read runs the
    // app's export (exportText): dialog, Enter or button click, and the captured download.
    run: async (args, ctx) => {
      const save = await exportText(ctx, args.doc);
      if (save.bytes.byteLength === 0) throw new ToolError('not_available', 'PDFCraft has no text to export: the document has no extractable text.', 'Check that the PDF is not a scan');
      // b17 pdfcraft-01: label the pages the model can name (raw source when unparseable).
      const raw = new TextDecoder('utf-8').decode(save.bytes);
      return { name: save.name, text: labelPdfPages(raw) ?? raw };
    },
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
    run: async (args, ctx) => gate(await ctx.craft(APP)).execute('file.word_count', pick(args, ['doc', 'pages'])),
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
    run: async (args, ctx) => gate(await ctx.craft(APP)).execute('edit.find', pick(args, ['doc', 'query', 'limit'])),
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
    // tools.rs:279-289 text_replace, engine command edit.replace. Read-after-write (probe
    // r2, build 12): the web build answers {ran} without changing the document, so the
    // exported text before and after the edit must differ; a silent no-op becomes a
    // teaching error the model can stop retrying on.
    run: async (args, ctx) => {
      const craft = gate(await ctx.craft(APP));
      const before = await exportTextUtf8(ctx, args.doc);
      const ran = await craft.execute('edit.replace', pick(args, ['doc', 'find', 'replace', 'all']));
      const after = await exportTextUtf8(ctx, args.doc);
      if (before === after) throw new ToolError('app_error', `the app answered ${JSON.stringify(ran)} but the exported text is unchanged: this PDFCraft build does not apply find-and-replace to the document, so nothing was replaced. Tell the user the replacement is not possible in this build instead of retrying.`, '');
      return ran;
    },
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
    run: async (args, ctx) => gate(await ctx.craft(APP)).execute('page.rotate', pick(args, ['doc', 'degrees'])),
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
    run: async (args, ctx) => gate(await ctx.craft(APP)).execute('page.reverse', pick(args, ['doc', 'pages'])),
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
    run: async (args, ctx) => {
      // b17 pdfcraft-05: lfm3 read "at the end" as a big position (at=17 on a 2-page
      // document) and the app accepted it: refuse past-the-end positions up front.
      const craft = await ctx.craft(APP);
      const docs = (await craft.inspect().catch(() => null))?.documents;
      const doc = Array.isArray(docs) ? (args.doc != null ? docs.find(d => d && d.doc === args.doc) : docs.find(d => d && d.active) ?? docs[0]) : null;
      if (doc?.pages != null && args.at > doc.pages + 1) {
        throw new ToolError('invalid_argument', `position ${args.at} is past the end: the document has ${doc.pages} page${doc.pages === 1 ? '' : 's'}, so at is 1..${doc.pages + 1} (${doc.pages + 1} appends the page at the end)`, '');
      }
      const result = await gate(craft).execute('page.insert_blank', pick(args, ['doc', 'at']));
      // The new page count in the result tells the model when the document reached the
      // size the user asked for (b17 pdfcraft-09: six inserts at the same position).
      const after = (await craft.inspect().catch(() => null))?.documents;
      const docAfter = Array.isArray(after) ? (args.doc != null ? after.find(d => d && d.doc === args.doc) : after.find(d => d && d.active) ?? after[0]) : null;
      return { ...result, ...(docAfter?.pages != null ? { pages: docAfter.pages } : {}) };
    },
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
    run: async (args, ctx) => gate(await ctx.craft(APP)).execute('page.duplicate', pick(args, ['doc', 'pages', 'at'])),
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
    examples: [{ args: { page: 1, text: 'INTERNAL', x: 50, y: 50, font: 'helvetica', size: 24, bold: true }, says: 'Stamp INTERNAL on the first page' }],
    // tools.rs:808-828 page_add_text, engine command edit.text; x/y become the at point.
    // Read-after-write as in text_replace (probe r2: the edit is a silent no-op in this
    // build), so the exported text must differ after the call.
    run: async (args, ctx) => {
      const craft = gate(await ctx.craft(APP));
      const before = await exportTextUtf8(ctx, args.doc);
      const params = pick(args, ['doc', 'page', 'text', 'width', 'font', 'size', 'bold', 'italic', 'color', 'align']);
      if (args.x !== undefined && args.y !== undefined) params.at = [args.x, args.y];
      const ran = await craft.execute('edit.text', params);
      const after = await exportTextUtf8(ctx, args.doc);
      if (before === after) throw new ToolError('app_error', `the app answered ${JSON.stringify(ran)} but the exported text is unchanged: this PDFCraft build does not apply added page text to the document, so nothing was added. Tell the user the text was not added instead of retrying.`, '');
      return ran;
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
      return gate(await ctx.craft(APP)).execute('edit.link', { ...pick(args, ['doc', 'page', 'url', 'to_page']), rect });
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
    run: async (args, ctx) => gate(await ctx.craft(APP)).execute('edit.undo', pick(args, ['doc'])),
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
    run: async (args, ctx) => gate(await ctx.craft(APP)).execute('edit.redo', pick(args, ['doc'])),
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
    run: async (args, ctx) => gate(await ctx.craft(APP)).execute('page.delete', pick(args, ['doc', 'pages'])),
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
    // b14 live (pdfcraft-09, both reps): file.close answers ok but the document stays
    // active - doc_info keeps showing it and page ops keep working. The engine is a
    // prebuilt wasm (file.close and file.close_all are its only close commands), so the
    // close cannot be made real from the pack; verify the post-condition instead and
    // fail honestly rather than report a close that did not happen (lead ruling).
    run: async (args, ctx) => {
      const craft = gate(await ctx.craft(APP));
      const result = await craft.execute('file.close', pick(args, ['doc', 'discard_changes']));
      const left = await craft.inspect().catch(() => null);
      const docs = Array.isArray(left?.documents) ? left.documents : [];
      const target = args.doc != null ? docs.find(d => d && d.doc === args.doc) : docs.find(d => d && d.active) || docs[0];
      if (target) {
        throw new ToolError('app_error', `the app answered ok but the document is still open${target.name ? ` ("${target.name}")` : ''}: this PDFCraft build does not close documents, so the document stays open. Do not retry doc_close; keep working on it, or save a copy first.`, '');
      }
      // b17 pdfcraft-08: a close mid-task dead-ends the run (the reopen answers "already
      // open as document N" and nothing is active), so say up front what closing costs.
      return { ...result, note: 'the document is now closed and pdfcraft tools need an open one: save a copy with pdfcraft.save_copy before closing, and open the file again before any further pdfcraft call' };
    },
  },
  {
    name: 'pdfcraft.doc_save',
    purpose: 'Save the document to its own file.',
    when: 'Use when the user wants to save the changes in place; for a new name or path use save_copy',
    params: {
      doc: DOC,
      flatten_fill_sign: { type: 'boolean', description: 'Bake Fill & Sign marks into the page first (default false)' },
    },
    effect: 'destructive',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Save the document' }],
    // tools.rs:197-212 doc_save, destructive, engine command file.save. The path, full
    // and out-file variants need a file path, so the web port saves in place only.
    run: async (args, ctx) => gate(await ctx.craft(APP)).execute('file.save', pick(args, ['doc', 'flatten_fill_sign'])),
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
      const app = gate(await ctx.craft(APP));
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
    when: 'Use when the user wants a copy of the open PDF in Files, or to save the work under a new name or path',
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
      const craft = gate(await ctx.craft(APP));
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
// ui_inspect and read_text drive the dialog through the page's ui.* control methods.
export const usesCommands = [
  'file.word_count', 'edit.find', 'edit.replace', 'page.rotate', 'page.reverse',
  'page.insert_blank', 'page.duplicate', 'edit.text', 'edit.link', 'edit.undo', 'edit.redo',
  'page.delete', 'file.close', 'file.save', 'export.text',
];
export const usesMethods = ['ui.click', 'ui.inspect', 'ui.key'];
