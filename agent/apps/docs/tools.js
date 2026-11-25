// Docs pack: the Docs app tools (read, insert, heading, find/replace, bold, new document).
// Every tool drives the editor instance the app exposes as window.webpcDocs
// (scripts/pc/docs/editor.jsx:105), a @casualoffice/docs DocxEditorRef (dist/react-ltZBBRVr.d.ts:1215).
// The app autosaves to localStorage on every change (editor.jsx onChange -> save()), so there is
// no save tool: edits are persisted as they happen.
import { ToolError } from '../../../src/apps/ai-agent/runtime/args.mjs';
import { extOf, filesCall } from '../../shared/craft-files.js';

const APP = 'docs';
const NEEDS = ['host', 'app:docs'];
const AUTHOR = 'WebPC Agent';
const NOT_HERE = 'Docs is not available here (WebPC Agent is not running inside WebPC).';

// Gate on ctx.host (needs: ['host', 'app:docs']), then turn host rejections, which carry a code
// (unknown_app, not_open, not_iframe, timeout, invalid_argument), into a ToolError.
const call = (ctx, fn) => {
  if (!ctx.host) throw new ToolError('not_available', NOT_HERE, '');
  return Promise.resolve()
    .then(() => fn(ctx.host))
    .catch(error => {
      if (error instanceof ToolError) throw error;
      throw new ToolError(error.code || 'app_error', error.message, '');
    });
};

// window.webpcDocs is set when the DocxEditor ref mounts; appWindow only resolves once the app
// posted pc:ready (after the mount), so this guards the edge.
const editor = win => {
  const ed = win.webpcDocs;
  if (!ed) throw Object.assign(new Error('the Docs editor is not ready yet; try again shortly'), { code: 'not_available' });
  return ed;
};

// The paraId of the last text paragraph in the live ProseMirror state (the document end), or
// null. Reads the fresh state (getEditorRef().getState().doc), not the stale paged view.
const endParaId = ed => {
  const doc = ed.getEditorRef?.()?.getState?.()?.doc;
  if (!doc) return null;
  let last = null;
  doc.descendants(node => { if (node.isTextblock) last = node.attrs?.paraId ?? null; });
  return last;
};

// A fresh document is one empty paragraph with no paraId yet (live probe: size 0, paraId null),
// which insertParagraphAfter cannot address. Type the text into that paragraph on the live view
// (getEditorRef().getView(), the same view find_replace edits). False when the last paragraph has text.
const typeIntoEmpty = (ed, text) => {
  const view = ed.getEditorRef?.()?.getView?.();
  let last = null;
  view?.state?.doc?.descendants((node, pos) => { if (node.isTextblock) last = { node, pos }; });
  if (!last || last.node.content?.size !== 0) return false;
  view.dispatch(view.state.tr.insertText(text, last.pos + 1));
  return true;
};

// insertParagraphAfter and proposeChange apply the insertion mark, so the new text is a pending
// tracked suggestion, not document text. Accept every tracked change with the editor's own
// "Accept all changes" command, which the UI runs as Zf()(view.state, view.dispatch) on the
// PagedEditorRef view (getEditorRef, react-ltZBBRVr.d.ts:1225; getView, d.ts PagedEditorRef),
// where Zf() = (state, dispatch) => Xw(0, state.doc.content.size, "accept")(state, dispatch).
// Xw removes the insertion mark from marked text and deletes deletion-marked ranges (in reverse
// position order), so the edit lands as accepted text docs.get_text can read back.

// A paragraph addressed by its exact text (trimmed), first occurrence: the anchor of the
// section tools (make_list, insert_after, delete_section, move_section). Small models name
// paragraphs by what they say; only docs.get_text reveals the paraId.
const findParagraph = (ed, text) => {
  const doc = ed.getEditorRef?.()?.getState?.()?.doc;
  if (!doc) throw new ToolError('not_available', 'the Docs editor is not ready yet; try again shortly', '');
  const needle = String(text ?? '').trim();
  let hit = null;
  doc.descendants((node, pos) => {
    if (hit || !node.isTextblock) return;
    if (needle && node.textContent.trim() === needle) hit = { pos, size: node.nodeSize, paraId: node.attrs?.paraId ?? null };
  });
  if (!hit) throw new ToolError('app_error', `no paragraph with the exact text "${text}"; read the paragraphs with docs.get_text`, 'call_tool tool=docs.get_text');
  return hit;
};

// The live document as markdown: heading styleIds become # lines, list paragraphs (numPr;
// numId 1 is the bullet list, dist chunk-QFXZKHI5) get a marker; plain text otherwise.
const markdownOf = ed => {
  const doc = ed.getEditorRef?.()?.getState?.()?.doc;
  if (!doc) throw new ToolError('not_available', 'the Docs editor is not ready yet; try again shortly', '');
  const lines = [];
  doc.descendants(node => {
    if (!node.isTextblock) return;
    const text = node.textContent;
    const heading = /^Heading([1-9])$/.exec(node.attrs?.styleId ?? '');
    if (heading) lines.push(`${'#'.repeat(heading[1].length)} ${text}`.trim());
    else if (node.attrs?.numPr?.numId != null && Number(node.attrs.numPr.numId) !== 0) lines.push(`${Number(node.attrs.numPr.numId) === 1 ? '-' : '1.'} ${text}`);
    else lines.push(text);
  });
  return lines.join('\n').trimEnd();
};

const acceptAllChanges = ed => {
  const view = ed.getEditorRef?.()?.getView?.();
  const state = view?.state;
  if (!state) return false;
  const insertion = state.schema.marks.insertion;
  const deletion = state.schema.marks.deletion;
  if (!insertion && !deletion) return false;
  const tr = state.tr;
  const doomed = [];
  state.doc.nodesBetween(0, state.doc.content.size, (node, pos) => {
    if (!node.isText) return;
    const from = pos;
    const to = pos + node.nodeSize;
    if (deletion && node.marks.some(mark => mark.type === deletion)) doomed.push({ from, to });
    if (insertion && node.marks.some(mark => mark.type === insertion)) tr.removeMark(from, to, insertion);
  });
  for (const range of doomed.reverse()) tr.delete(range.from, range.to);
  if (tr.steps.length === 0) return false;
  view.dispatch(tr);
  return true;
};

export const pack = { id: APP, title: 'Docs' };

export const tools = [
  {
    name: 'docs.get_text',
    purpose: 'Read the document text with a stable paraId per paragraph.',
    when: 'Use when the user asks what is in the document, or before planning edits.',
    params: {},
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: {}, says: 'What is in my document?' }],
    // getPageContent (the paged view) lags behind edits and getDocument/getContent return a stale
    // model, so read the live ProseMirror state: getEditorRef().getState().doc (react-ltZBBRVr.d.ts
    // :1225/:662). Walk the text blocks and take each paragraph's stable paraId from the node attrs
    // (Word w14:paraId) so the edit tools can target it.
    run: async (args, ctx) => call(ctx, async host => {
      const ed = editor(await host.appWindow(APP));
      const doc = ed.getEditorRef?.()?.getState?.()?.doc;
      if (!doc) throw new ToolError('not_available', 'the Docs editor is not ready yet; try again shortly', '');
      const paragraphs = [];
      doc.descendants(node => { if (node.isTextblock) paragraphs.push({ paraId: node.attrs?.paraId ?? null, text: node.textContent }); });
      return { text: paragraphs.map(p => p.text).join('\n'), paragraphs };
    }),
  },
  {
    name: 'docs.insert_text',
    purpose: 'Insert a new paragraph after the cursor, after a paragraph, or at the end.',
    when: 'Use when the user wants to add or type a paragraph of text into the document.',
    params: {
      text: { type: 'text', required: true, description: 'The paragraph text to insert' },
      para_id: { type: 'string', description: 'Insert after this paragraph (a paraId from docs.get_text); at the cursor or the document end when omitted' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { text: 'Second draft notes' }, says: 'Add a paragraph at the end' }, { args: { text: 'Intro', para_id: '1A2B3C4D' }, says: 'Put this after that paragraph' }],
    // insertParagraphAfter (react-ltZBBRVr.d.ts:1407) applies the insertion mark, so the new
    // paragraph is a pending tracked suggestion. Accept it right after (acceptAllChanges) so it
    // lands as accepted document text that docs.get_text and docs.find_replace can read back.
    run: async (args, ctx) => call(ctx, async host => {
      const ed = editor(await host.appWindow(APP));
      const paraId = args.para_id ?? (ed.getSelection()?.paraId ?? await endParaId(ed));
      if (!paraId) {
        if (!typeIntoEmpty(ed, args.text)) throw new ToolError('app_error', 'there is no paragraph to add after; read the paragraphs with docs.get_text and pass one as para_id', 'call_tool tool=docs.get_text');
        acceptAllChanges(ed);
        return { insertedAfter: null, text: args.text };
      }
      if (!ed.insertParagraphAfter({ paraId, text: args.text, author: AUTHOR })) throw new ToolError('app_error', `could not insert after paragraph ${paraId}`, '');
      acceptAllChanges(ed);
      return { insertedAfter: paraId, text: args.text };
    }),
  },
  {
    name: 'docs.set_heading',
    purpose: 'Turn a paragraph into a heading of a given level.',
    when: 'Use when the user wants a line to become a heading, or to change its heading level.',
    params: {
      level: { type: 'integer', required: true, min: 1, max: 9, description: 'Heading level, 1 (largest) to 9' },
      para_id: { type: 'string', description: 'The paragraph (a paraId from docs.get_text); the paragraph at the cursor when omitted' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { level: 1 }, says: 'Make this line a top heading' }, { args: { level: 2, para_id: '1A2B3C4D' }, says: 'Make that paragraph a level-2 heading' }],
    // DocxEditorRef.setParagraphStyle: styleId "HeadingN" (react-ltZBBRVr.d.ts:1341)
    run: async (args, ctx) => call(ctx, async host => {
      const ed = editor(await host.appWindow(APP));
      const paraId = args.para_id ?? ed.getSelection()?.paraId;
      if (!paraId) throw new ToolError('invalid_argument', 'give para_id or put the cursor in the paragraph first', '');
      const styleId = `Heading${args.level}`;
      if (!ed.setParagraphStyle({ paraId, styleId })) throw new ToolError('app_error', `could not set ${styleId} on paragraph ${paraId} (unknown paraId or missing style)`, '');
      return { paraId, styleId };
    }),
  },
  {
    name: 'docs.find_replace',
    purpose: 'Replace occurrences of a phrase; the replacements are applied.',
    when: 'Use when the user wants find and replace across the document.',
    params: {
      find: { type: 'string', required: true, description: 'The phrase to find (case-insensitive)' },
      replace: { type: 'string', required: true, description: 'The replacement text; empty deletes the phrase' },
      limit: { type: 'integer', min: 1, default: 50, description: 'At most this many matches' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { find: 'draft', replace: 'final' }, says: 'Replace draft with final everywhere' }],
    // proposeChange plus accept-all inserts at the paragraph level and splits the paragraph, so
    // replace directly on the live view instead. Walk the text nodes of view.state.doc for each
    // match's from/to (Node.descendants, prosemirror-model:110, the callback carries the absolute
    // position), then one tr.insertText(replace, from, to) per match from the last match back to
    // the first so the earlier positions stay valid, and view.dispatch(tr) (getEditorRef,
    // react-ltZBBRVr.d.ts:1225; getView, d.ts:664; state.tr, prosemirror-state:843; insertText,
    // prosemirror-state:627). No tracked change and no accept; an empty replace is a deleteRange.
    // A match must sit inside one text node: a phrase split across adjacent nodes (for example by
    // a formatting mark) is not matched.
    run: async (args, ctx) => call(ctx, async host => {
      const ed = editor(await host.appWindow(APP));
      const view = ed.getEditorRef?.()?.getView?.();
      const doc = view?.state?.doc;
      if (!doc) throw new ToolError('not_available', 'the Docs editor is not ready yet; try again shortly', '');
      const needle = String(args.find).toLowerCase();
      if (!needle) throw new ToolError('invalid_argument', 'find= must not be empty', '');
      const limit = args.limit ?? 50;
      const matches = [];
      doc.descendants((node, pos) => {
        if (matches.length >= limit || !node.isText) return;
        const lower = String(node.text ?? '').toLowerCase();
        let at = lower.indexOf(needle);
        while (at >= 0 && matches.length < limit) {
          matches.push({ from: pos + at, to: pos + at + needle.length });
          at = lower.indexOf(needle, at + needle.length);
        }
      });
      if (matches.length === 0) throw new ToolError('app_error', `no occurrences of "${args.find}" in the document`, '');
      const tr = view.state.tr;
      for (let i = matches.length - 1; i >= 0; i--) tr.insertText(String(args.replace), matches[i].from, matches[i].to);
      view.dispatch(tr);
      return { replaced: matches.length };
    }),
  },
  {
    name: 'docs.bold_selection',
    purpose: 'Bold the current selection, or the whole paragraph at the cursor.',
    when: 'Use when the user wants the selected text, or the line under the cursor, made bold.',
    params: {},
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Bold this' }],
    // DocxEditorRef.getSelection + applyFormatting (react-ltZBBRVr.d.ts:1290): a direct edit;
    // search is the selected phrase when there is one, the whole paragraph when not
    run: async (args, ctx) => call(ctx, async host => {
      const ed = editor(await host.appWindow(APP));
      const selection = ed.getSelection();
      if (!selection?.paraId) throw new ToolError('invalid_argument', 'there is no cursor or selection in Docs; open it and click into the text first', '');
      if (!ed.applyFormatting({ paraId: selection.paraId, search: selection.selectedText || undefined, marks: { bold: true } })) throw new ToolError('app_error', 'could not apply bold (the selection is not unique in its paragraph?)', '');
      return { bolded: selection.selectedText || 'the whole paragraph' };
    }),
  },
  {
    name: 'docs.new',
    purpose: 'Replace the document with a fresh one; the current content is lost.',
    when: 'Use when the user wants to start over with a new document and agreed to lose the current one.',
    params: { title: { type: 'string', description: 'Title of the new document; Untitled document when omitted' } },
    effect: 'destructive',
    needs: NEEDS,
    examples: [{ args: { title: 'Weekly report' }, says: 'Start a new document' }],
    // DocxEditorRef.createDocument (react-ltZBBRVr.d.ts:1420): "DESTRUCTIVE" per its doc comment;
    // unlike the app's New button it keeps no recover-previous copy
    run: async (args, ctx) => call(ctx, async host => {
      const ed = editor(await host.appWindow(APP));
      const title = String(args.title ?? 'Untitled document');
      if (!ed.createDocument({ title, sections: [] })) throw new ToolError('app_error', 'the editor is not ready; try again shortly', '');
      return { title };
    }),
  },
  {
    name: 'docs.make_list',
    purpose: 'Make a range of lines a bulleted or numbered list.',
    when: 'Use when the user wants lines formatted as a bullet or numbered list.',
    params: {
      kind: { type: 'enum', required: true, values: ['bullet', 'numbered'], description: 'bullet for bullets, numbered for 1. 2. 3.' },
      from_text: { type: 'string', required: true, description: 'The first line of the list (its exact text)' },
      to_text: { type: 'string', description: 'The last line, inclusive (the first line when omitted)' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { kind: 'bullet', from_text: 'freeze the build', to_text: 'have the rollback ready' }, says: 'Make these lines a bulleted list' }],
    // The list plugin's commands (dist chunk-L6A7PAX6: commands {toggleBulletList,
    // toggleNumberedList}) act on the view selection, so set a text selection over the range
    // first, through the app's own TextSelection (the live selection's constructor; a
    // cross-realm import would not match the app's prosemirror instances).
    run: async (args, ctx) => call(ctx, async host => {
      const ed = editor(await host.appWindow(APP));
      const view = ed.getEditorRef?.()?.getView?.();
      const state = view?.state;
      if (!state?.doc) throw new ToolError('not_available', 'the Docs editor is not ready yet; try again shortly', '');
      const from = findParagraph(ed, args.from_text);
      const to = args.to_text === undefined ? from : findParagraph(ed, args.to_text);
      if (to.pos < from.pos) throw new ToolError('invalid_argument', 'to_text comes before from_text in the document', '');
      const TextSelection = state.selection?.constructor;
      if (typeof TextSelection?.create !== 'function') throw new ToolError('app_error', 'the cursor is not in the text; click into a line first', '');
      view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, from.pos, to.pos + to.size)));
      if (!(await ed.executeCommand(args.kind === 'bullet' ? 'toggleBulletList' : 'toggleNumberedList'))) throw new ToolError('app_error', `could not make the lines a ${args.kind} list`, '');
      return { kind: args.kind, from: String(args.from_text), to: args.to_text === undefined ? String(args.from_text) : String(args.to_text) };
    }),
  },
  {
    name: 'docs.insert_after',
    purpose: 'Insert a new line after the paragraph that has a given text.',
    when: 'Use when the user wants a line after a specific paragraph, named by its text.',
    params: {
      text: { type: 'text', required: true, description: 'The line to insert' },
      after: { type: 'string', required: true, description: 'The anchor: exact text of the paragraph to insert after' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { text: 'Sent to the client', after: 'First draft done' }, says: 'Add this line after that paragraph' }],
    // insertParagraphAfter (like docs.insert_text) applies a tracked insertion; accept it so
    // the line lands as document text docs.get_text can read back.
    run: async (args, ctx) => call(ctx, async host => {
      const ed = editor(await host.appWindow(APP));
      const anchor = findParagraph(ed, args.after);
      if (anchor.paraId === null) throw new ToolError('app_error', `the paragraph "${args.after}" has no id yet; read it with docs.get_text and retry`, '');
      if (!ed.insertParagraphAfter({ paraId: anchor.paraId, text: String(args.text), author: AUTHOR })) throw new ToolError('app_error', `could not insert after the paragraph "${args.after}"`, '');
      acceptAllChanges(ed);
      return { insertedAfter: anchor.paraId, text: String(args.text) };
    }),
  },
  {
    name: 'docs.delete_section',
    purpose: 'Delete the paragraphs from one line to another, inclusive.',
    when: 'Use when the user wants a section (a heading and its lines) removed.',
    params: {
      from_text: { type: 'string', required: true, description: 'The first line to delete (its exact text)' },
      to_text: { type: 'string', description: 'The last line to delete, inclusive (the first line when omitted)' },
    },
    effect: 'destructive',
    needs: NEEDS,
    examples: [{ args: { from_text: 'Old ideas', to_text: 'Try the red wiring first' }, says: 'Delete that section' }],
    // DocxEditorRef.deleteParagraphs ({paraIds, author}) applies a tracked deletion; accept it
    // afterwards so docs.get_text reads the document after.
    run: async (args, ctx) => call(ctx, async host => {
      const ed = editor(await host.appWindow(APP));
      const from = findParagraph(ed, args.from_text);
      const to = args.to_text === undefined ? from : findParagraph(ed, args.to_text);
      if (to.pos < from.pos) throw new ToolError('invalid_argument', 'to_text comes before from_text in the document', '');
      const end = to.pos + to.size;
      const paraIds = [];
      ed.getEditorRef?.()?.getState?.()?.doc.descendants((node, pos) => {
        if (node.isTextblock && pos >= from.pos && pos < end) paraIds.push(node.attrs?.paraId ?? null);
      });
      if (paraIds.length === 0 || paraIds.some(id => id === null)) throw new ToolError('app_error', 'a paragraph in the section has no id yet; read it with docs.get_text and retry', '');
      if (!ed.deleteParagraphs({ paraIds, author: AUTHOR })) throw new ToolError('app_error', 'could not delete the section', '');
      acceptAllChanges(ed);
      return { deleted: paraIds.length, from: String(args.from_text), to: args.to_text === undefined ? String(args.from_text) : String(args.to_text) };
    }),
  },
  {
    name: 'docs.move_section',
    purpose: 'Move the paragraphs from one line to another above a line, or to the top.',
    when: 'Use when the user wants a section (a heading and its lines) reordered.',
    params: {
      from_text: { type: 'string', required: true, description: 'The first line of the section (its exact text)' },
      to_text: { type: 'string', description: 'The last line, inclusive (the first line when omitted)' },
      before_text: { type: 'string', description: 'The section goes above the paragraph with this exact text; to the top of the document when omitted' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { from_text: 'Next steps', to_text: 'Open the beta to 500 users.', before_text: 'Current plan' }, says: 'Move that section to the top' }],
    // A cut-and-paste on the live view (the same view find_replace edits): the fragment of the
    // range is inserted at the target, shifted up by the removed range when the target sits
    // after it. One transaction, one undo step, no tracked change.
    run: async (args, ctx) => call(ctx, async host => {
      const ed = editor(await host.appWindow(APP));
      const view = ed.getEditorRef?.()?.getView?.();
      const state = view?.state;
      if (!state?.doc) throw new ToolError('not_available', 'the Docs editor is not ready yet; try again shortly', '');
      const from = findParagraph(ed, args.from_text);
      const to = args.to_text === undefined ? from : findParagraph(ed, args.to_text);
      if (to.pos < from.pos) throw new ToolError('invalid_argument', 'to_text comes before from_text in the document', '');
      const end = to.pos + to.size;
      let target = 0;
      if (args.before_text !== undefined) {
        const before = findParagraph(ed, args.before_text);
        target = before.pos;
        if (target >= from.pos && target < end) throw new ToolError('invalid_argument', 'before_text is inside the section being moved', '');
      }
      const shifted = target >= from.pos ? target - (end - from.pos) : target;
      view.dispatch(state.tr.delete(from.pos, end).insert(shifted, state.doc.slice(from.pos, end)));
      return { moved: args.to_text === undefined ? String(args.from_text) : `${args.from_text}..${args.to_text}`, before: args.before_text === undefined ? 'the top of the document' : String(args.before_text) };
    }),
  },
  {
    name: 'docs.save',
    purpose: 'Save the open document to Files as markdown or docx.',
    when: 'Use when the user wants a copy of the open document in Files.',
    params: {
      path: { type: 'path', required: true, description: 'The Files path to write, e.g. /docs/plan.md or /docs/plan.docx' },
      overwrite: { type: 'boolean', description: 'Replace the file when the path already exists; false when omitted' },
    },
    effect: 'change',
    effectFor: args => (args.overwrite ? 'destructive' : 'change'),
    needs: ['host', 'app:docs', 'files'],
    examples: [{ args: { path: '/docs/plan.md' }, says: 'Save the document as markdown in Files' }],
    // Markdown serializes the live document (markdownOf: headings from the styleId attr,
    // bullets from numPr); docx uses the editor's own save, which the app's Export button
    // calls (editor.jsx:69). filesCall turns the store's exists rejection into the fix.
    run: async (args, ctx) => call(ctx, async host => {
      const ext = extOf(args.path);
      if (ext !== '.md' && ext !== '.docx') throw new ToolError('invalid_argument', 'save to a .md (markdown) or .docx path', `call_tool tool=docs.save path=${String(args.path).replace(/\.[^.]+$/, '.md')}`);
      const ed = editor(await host.appWindow(APP));
      const fix = () => (error => (error.code === 'exists' ? `call_tool tool=docs.save path=${args.path} overwrite=true` : ''));
      if (ext === '.docx') {
        const bytes = await ed.save?.() ?? await ed.export?.();
        if (!bytes) throw new ToolError('app_error', 'the document could not be serialized to docx', '');
        const written = await filesCall(ctx, files => files.writeBytes(args.path, new Uint8Array(bytes), { overwrite: Boolean(args.overwrite) }), fix());
        return { path: written.path, size: written.size, created: written.created, format: 'docx' };
      }
      const written = await filesCall(ctx, files => files.writeText(args.path, markdownOf(ed), { overwrite: Boolean(args.overwrite) }), fix());
      return { path: written.path, size: written.size, created: written.created, format: 'markdown' };
    }),
  },
  {
    name: 'docs.open',
    purpose: 'Open a .md or .docx file from Files; the open document is replaced.',
    when: 'Use when the user wants to open a saved document; the open document is replaced.',
    params: {
      path: { type: 'path', required: true, description: 'The Files path of the .md or .docx file to open' },
    },
    effect: 'destructive',
    needs: ['host', 'app:docs', 'files'],
    examples: [{ args: { path: '/docs/plan.md' }, says: 'Open the plan from Files' }],
    // Replaces the open document (like docs.new, the replacement is the point): createDocument
    // plus the proven insert-and-accept path for .md (headings from # lines, list markers
    // dropped, one paragraph per non-empty line), importDocx (the ref's canonical import,
    // react-ltZBBRVr.d.ts:1466) for .docx.
    run: async (args, ctx) => call(ctx, async host => {
      const ext = extOf(args.path);
      if (ext !== '.md' && ext !== '.docx') throw new ToolError('invalid_argument', 'open a .md (markdown) or .docx path', '');
      const file = await filesCall(ctx, files => (ext === '.md' ? files.readText(args.path, { maxChars: 200000 }) : files.readBytes(args.path)), () => '');
      const ed = editor(await host.appWindow(APP));
      if (ext === '.docx') {
        const docxImport = ed.importDocx ?? ed.import;
        if (typeof docxImport !== 'function') throw new ToolError('app_error', 'the editor has no docx import; save the file as .md and open that', '');
        await docxImport.call(ed, file.bytes);
        return { path: args.path, opened: file.name.replace(/\.docx$/i, '') };
      }
      const title = file.name.replace(/\.md$/i, '');
      if (!ed.createDocument({ title, sections: [] })) throw new ToolError('app_error', 'the editor is not ready; try again shortly', '');
      for (const line of String(file.text ?? '').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const heading = /^(#{1,9})\s+(.*)$/.exec(trimmed);
        const body = heading ? heading[2] : trimmed;
        const paraId = endParaId(ed);
        if (paraId === null) {
          if (!typeIntoEmpty(ed, body)) throw new ToolError('app_error', 'could not add the first line to the new document', '');
        } else {
          if (!ed.insertParagraphAfter({ paraId, text: body, author: AUTHOR })) throw new ToolError('app_error', 'could not add a line to the new document', '');
          acceptAllChanges(ed);
        }
        if (heading) {
          const id = endParaId(ed);
          if (id) ed.setParagraphStyle({ paraId: id, styleId: `Heading${heading[1].length}` });
        }
      }
      return { path: args.path, opened: title };
    }),
  },
];
