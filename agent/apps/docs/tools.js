// Docs pack: the Docs app tools (read, insert, heading, find/replace, bold, new document).
// Every tool drives the editor instance the app exposes as window.webpcDocs
// (scripts/pc/docs/editor.jsx:105), a @casualoffice/docs DocxEditorRef (dist/react-ltZBBRVr.d.ts:1215).
// The app autosaves to localStorage on every change (editor.jsx onChange -> save()), so there is
// no save tool: edits are persisted as they happen.
import { ToolError } from '../../../src/apps/ai-agent/runtime/args.mjs';

const APP = 'docs';
const NEEDS = ['host', 'app:docs'];
const AUTHOR = 'Buddy';
const NOT_HERE = 'Docs is not available here (Buddy is not running inside WebPC).';

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

// insertParagraphAfter and proposeChange apply the insertion mark, so the new text is a pending
// tracked suggestion, not document text. Accept every tracked change with the editor's own
// "Accept all changes" command, which the UI runs as Zf()(view.state, view.dispatch) on the
// PagedEditorRef view (getEditorRef, react-ltZBBRVr.d.ts:1225; getView, d.ts PagedEditorRef),
// where Zf() = (state, dispatch) => Xw(0, state.doc.content.size, "accept")(state, dispatch).
// Xw removes the insertion mark from marked text and deletes deletion-marked ranges (in reverse
// position order), so the edit lands as accepted text docs.get_text can read back.
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
      if (!paraId) throw new ToolError('app_error', 'the document has no paragraphs yet; open it and type something first', '');
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
];
