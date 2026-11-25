// Unit tests for the Docs pack: agent/apps/docs/tools.js and skills.md.
// A fake ctx.host.appWindow returns a fake window whose webpcDocs editor records calls; every
// tool must call the exact @casualoffice/docs DocxEditorRef method it claims to. The schema and
// skills checks reuse the real runtime validators, with the choices function the build uses.
// Run: node --test tests/agent-pack-docs.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack, tools } from '../agent/apps/docs/tools.js';
import { tools as desktopTools } from '../agent/desktop/tools.js';
import { ToolError, specErrors, checkArgs } from '../src/apps/ai-agent/runtime/args.mjs';
import { parseSkills, checkSkills } from '../src/apps/ai-agent/runtime/skills.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_MD = readFileSync(join(HERE, '..', 'agent', 'apps', 'docs', 'skills.md'), 'utf8');
// The enabled app ids scripts/agent/build.mjs resolves the live 'apps' enum with (catalog.yaml).
const APP_IDS = ['gridcraft', 'docs', 'deckcraft', 'terminal', 'sqliteviz', 'files', 'media', 'cyberchef', 'vscode', 'nettools', 'packets', 'ai-agent', 'lightcraft', 'figcraft', 'pdfcraft', 'soundcraft', 'beepbox', 'filmcraft', 'cadcraft', 'vectorcraft', 'photocraft', 'effectcraft', 'materialcraft', 'texturecraft', 'excalidraw', 'vert'];
const choices = name => (name === 'apps' || name === 'windows' ? APP_IDS : []);
const byName = name => tools.find(tool => tool.name === name) ?? desktopTools.find(tool => tool.name === name);

// The tracked-change mark types the editor's ProseMirror schema uses.
const INS = { name: 'insertion' };
const DEL = { name: 'deletion' };

// A fake webpcDocs editor backed by a minimal ProseMirror-like document. The live state
// (getEditorRef().getState().doc) holds paragraphs of text segments; a segment's mark is null
// (accepted), INS (a pending insertion) or DEL (a pending deletion), and dead flags text removed
// by an applied delete step. This state is FRESH: insertParagraphAfter / proposeChange mutate it
// and every transaction dispatched on getView().dispatch (the accept transaction from
// insert_text, the plain insertText steps from find_replace) applies to it, so it is what
// docs.get_text reads. By contrast getPageContent is a STALE paged view: it returns the initial
// content and never reflects edits, mirroring the real editor where the page layout lags the model.
const fakeDocs = (overrides = {}, { initial } = {}) => {
  const calls = [];
  const viewDispatches = [];
  const paragraphs = initial ?? [
    { paraId: 'p1', segs: [{ text: 'First draft', mark: null, dead: false }] },
    { paraId: 'p2', segs: [{ text: 'Second line', mark: null, dead: false }] },
  ];
  let paraSeq = 2;
  const segList = () => paragraphs.flatMap(p => p.segs);
  const starts = () => { let pos = 0; return segList().map(s => { const x = pos; pos += s.text.length; return x; }); };
  const liveText = segs => segs.filter(s => !s.dead).map(s => s.text).join('');
  // The doc node the tools walk: descendants(f) visits each paragraph as a text block carrying its
  // stable paraId in attrs and its (fresh) text in textContent, and each live segment as a text
  // node with its text and marks at its absolute position (the second callback argument); dead
  // segments stay out of the walk but still count for positions, as removed text does in a doc.
  // nodesBetween / content.size / the schema marks back the accept transaction.
  const doc = {
    descendants: f => {
      let pos = 0;
      for (const para of paragraphs) {
        // nodeSize is the content length: the tools compute the paragraph range as
        // [from.pos, to.pos + to.size), which in this fake world is the next paragraph's start.
        f({ isTextblock: true, isText: false, attrs: { paraId: para.paraId, ...(para.styleId ? { styleId: para.styleId } : {}) }, content: { size: liveText(para.segs).length }, get textContent() { return liveText(para.segs); }, get nodeSize() { return liveText(para.segs).length; } }, pos);
        for (const seg of para.segs) {
          if (!seg.dead) f({ isTextblock: false, isText: true, text: seg.text, marks: seg.mark ? [{ type: seg.mark }] : [] }, pos);
          pos += seg.text.length;
        }
      }
    },
    // The cut fragment for move_section: the paragraphs whose start sits in [from, to). Dead
    // segments still count for positions (removed text does in a doc), so the range is stable
    // after the delete step of the same transaction. Answered as a closed Slice (openStart/
    // openEnd 0) with the paragraphs under .content, like doc.slice on whole top-level lines.
    slice: (from, to) => {
      let pos = 0;
      const frag = [];
      for (const para of paragraphs) {
        if (pos >= from && pos < to) frag.push(para);
        pos += para.segs.reduce((a, s) => a + s.text.length, 0);
      }
      return { openStart: 0, openEnd: 0, content: frag };
    },
    nodesBetween: (from, to, cb) => {
      const st = starts();
      // Block nodes (paragraphs) first, with the attrs the list tool reads (numPr); then the
      // text segments, the way ProseMirror nodesBetween walks the range.
      let pos = 0;
      for (const para of paragraphs) {
        const size = para.segs.reduce((a, s) => a + s.text.length, 0);
        if (pos + size > from && pos < to) cb({ isText: false, isTextblock: true, type: { name: 'paragraph' }, nodeSize: size, attrs: { paraId: para.paraId, ...(para.styleId ? { styleId: para.styleId } : {}), ...(para.numPr != null ? { numPr: para.numPr } : {}), ...(para.listIsBullet != null ? { listIsBullet: para.listIsBullet } : {}) } }, pos);
        pos += size;
      }
      segList().forEach((seg, i) => {
        const s = st[i], e = s + seg.text.length;
        if (e <= from || s >= to) return;
        cb({ isText: true, nodeSize: seg.text.length, marks: seg.mark ? [{ type: seg.mark }] : [] }, s);
      });
    },
    get content() { return { size: segList().reduce((a, s) => a + s.text.length, 0) }; },
  };
  // A fake Transaction: insertText replaces a range with text (the find_replace path);
  // removeMark / delete back the accept-all transaction (the insert_text path); setSelection
  // records the selection the list tools set; delete + insert back the move_section cut and
  // paste (the fragment is the paragraphs object, moved in the array when dispatched).
  const newTr = () => {
    const t = {
      steps: [],
      insertText: (text, from, to) => { t.steps.push(['insertText', text, from, to]); return t; },
      removeMark: (from, to, mark) => { t.steps.push(['removeMark', from, to, mark]); return t; },
      delete: (from, to) => { t.steps.push(['delete', from, to]); return t; },
      setSelection: sel => { t.steps.push(['setSelection', sel]); return t; },
      setNodeMarkup: (pos, _type, attrs) => { t.steps.push(['setNodeMarkup', pos, attrs]); return t; },
      insert: (pos, fragment) => { t.steps.push(['insert', pos, fragment]); return t; },
    };
    return t;
  };
  // state.tr is a getter like EditorState.tr (prosemirror-state:843), so it hands out a fresh
  // transaction; getView().state and .dispatch are what the tools target on the live view.
  // selection is a live text selection whose constructor carries the app's TextSelection.create
  // (the list tools reach the class through it, realm-safe).
  const selection = { anchor: 0, head: 0, constructor: { create: (doc, from, to) => ({ anchor: from, head: to }) } };
  const state = {
    schema: { marks: { insertion: INS, deletion: DEL } },
    doc,
    selection,
    get tr() { return newTr(); },
  };
  const dispatch = t => {
    viewDispatches.push(t);
    for (const step of t.steps) {
      const segs = segList();
      const st = starts();
      if (step[0] === 'removeMark') {
        const markType = step[3];
        segs.forEach((seg, i) => { const s = st[i], e = s + seg.text.length; if (seg.mark === markType && s < step[2] && e > step[1]) seg.mark = null; });
      } else if (step[0] === 'delete') {
        segs.forEach((seg, i) => { const s = st[i], e = s + seg.text.length; if (s >= step[1] && e <= step[2]) seg.dead = true; });
      } else if (step[0] === 'insertText') {
        // A plain replace-range-with-text (tr.insertText): the match range sits inside one text
        // node (the tool only matches inside a single node), so rewrite that segment in place and
        // keep the paragraph whole, the way ProseMirror replaces the range in the doc.
        const [, text, from, to] = step;
        // Typing into an empty paragraph (a fresh document): no text node holds the position.
        const empty = paragraphs.find(p => liveText(p.segs) === '');
        if (to === undefined && empty) { empty.segs.push({ text, mark: null, dead: false }); if (!empty.paraId) empty.paraId = `p${++paraSeq}`; continue; }
        segs.forEach((seg, i) => {
          const s = st[i], e = s + seg.text.length;
          if (from < s || to > e) return;
          const before = seg.text.slice(0, from - s);
          const after = seg.text.slice(to - s);
          const next = [];
          if (before) next.push({ text: before, mark: seg.mark, dead: false });
          if (text) next.push({ text, mark: null, dead: false });
          if (after) next.push({ text: after, mark: seg.mark, dead: false });
          const para = paragraphs.find(x => x.segs.includes(seg));
          para.segs.splice(para.segs.indexOf(seg), 1, ...next);
        });
      } else if (step[0] === 'setNodeMarkup') {
        // The list toggle: the paragraph whose start sits at the step position takes the
        // numPr attrs (null attrs remove the list), like ProseMirror setNodeMarkup on a block.
        const [, pos, attrs] = step;
        let acc = 0;
        for (const para of paragraphs) {
          if (acc === pos) {
            para.numPr = attrs.numPr ?? null;
            para.listIsBullet = attrs.listIsBullet ?? null;
            break;
          }
          acc += para.segs.reduce((a, s) => a + s.text.length, 0);
        }
      } else if (step[0] === 'insert') {
        // The move_section paste: the fragment paragraphs are pulled out of the array (they were
        // marked dead by the delete step of the same transaction), un-dead and re-inserted at
        // the target, which is a position in the post-delete world (the live starts of the
        // paragraphs that remain).
        const [, pos, fragment] = step;
        const frag = Array.isArray(fragment) ? fragment : [fragment];
        for (const para of frag) {
          const i = paragraphs.indexOf(para);
          if (i >= 0) paragraphs.splice(i, 1);
        }
        frag.forEach(para => para.segs.forEach(seg => { seg.dead = false; }));
        let idx = paragraphs.length, acc = 0;
        for (let i = 0; i < paragraphs.length; i++) {
          if (acc >= pos) { idx = i; break; }
          acc += liveText(paragraphs[i].segs).length;
        }
        paragraphs.splice(idx, 0, ...frag);
      }
    }
  };
  // The STALE paged view: fixed at the initial content, never updated by edits.
  const stalePage = { pageNumber: 1, text: 'First draft\nSecond line', paragraphs: [{ paraId: 'p1', text: 'First draft', styleId: 'Normal' }, { paraId: 'p2', text: 'Second line', styleId: 'Normal' }] };
  const editor = {
    getTotalPages: () => { calls.push(['getTotalPages']); return 1; },
    getPageContent: n => { calls.push(['getPageContent', n]); return n === 1 ? stalePage : null; },
    getSelection: () => { calls.push(['getSelection']); return { paraId: 'p2', selectedText: 'Second', paragraphText: 'Second line', before: '', after: '' }; },
    insertParagraphAfter: opts => {
      calls.push(['insertParagraphAfter', opts]);
      const idx = paragraphs.findIndex(p => p.paraId === opts.paraId);
      if (idx < 0) return false;
      paragraphs.splice(idx + 1, 0, { paraId: `p${++paraSeq}`, segs: [{ text: opts.text, mark: INS, dead: false }] });
      return true;
    },
    setParagraphStyle: opts => { calls.push(['setParagraphStyle', opts]); return true; },
    findInDocument: (q, o) => {
      calls.push(['findInDocument', q, o]);
      const needle = String(q).toLowerCase();
      return paragraphs.filter(p => liveText(p.segs).toLowerCase().includes(needle)).map(p => ({ paraId: p.paraId })).slice(0, o?.limit ?? 50);
    },
    proposeChange: opts => {
      calls.push(['proposeChange', opts]);
      const para = paragraphs.find(p => p.paraId === opts.paraId);
      if (!para) return false;
      const search = String(opts.search);
      for (let i = 0; i < para.segs.length; i++) {
        const seg = para.segs[i];
        if (seg.dead || seg.mark === INS) continue;
        const at = seg.text.toLowerCase().indexOf(search.toLowerCase());
        if (at < 0) continue;
        const before = seg.text.slice(0, at);
        const matched = seg.text.slice(at, at + search.length);
        const after = seg.text.slice(at + search.length);
        const newSegs = [];
        if (before) newSegs.push({ text: before, mark: null, dead: false });
        newSegs.push({ text: matched, mark: DEL, dead: false });
        newSegs.push({ text: String(opts.replaceWith), mark: INS, dead: false });
        if (after) newSegs.push({ text: after, mark: null, dead: false });
        para.segs.splice(i, 1, ...newSegs);
        return true;
      }
      return false;
    },
    applyFormatting: opts => { calls.push(['applyFormatting', opts]); return true; },
    createDocument: opts => { calls.push(['createDocument', opts]); return true; },
    executeCommand: async (id, params) => { calls.push(['executeCommand', id, params]); return true; },
    deleteParagraphs: opts => {
      calls.push(['deleteParagraphs', opts]);
      const ids = new Set(opts.paraIds);
      for (let i = paragraphs.length - 1; i >= 0; i--) if (ids.has(paragraphs[i].paraId)) paragraphs.splice(i, 1);
      return true;
    },
    save: () => { calls.push(['save']); return new ArrayBuffer(3); },
    importDocx: bytes => { calls.push(['importDocx', bytes.length ?? bytes.byteLength]); },
    // getEditorRef (PagedEditorRef, react-ltZBBRVr.d.ts:1225): getState() is the FRESH ProseMirror
    // state the tools read; getView() exposes state (with the tr getter, like EditorState.tr) and
    // dispatch for both the accept transaction (insert_text) and plain find_replace insertText
    // steps (the editor's own accept-all runs Zf()(view.state, view.dispatch)).
    getEditorRef: () => ({
      getState: () => { calls.push(['getEditorRef.getState']); return state; },
      getView: () => { calls.push(['getEditorRef.getView']); return { state, dispatch }; },
    }),
    ...overrides,
  };
  const win = { webpcDocs: editor };
  const runTool = (name, args, ctx = { host: { appWindow: async () => win } }) => byName(name).run(args, ctx);
  return { calls, runTool, win, editor, viewDispatches, paragraphs, doc };
};

test('the pack declares its id and title', () => {
  assert.deepEqual(pack, { id: 'docs', title: 'Docs' });
});

test('the pack exposes exactly the 12 docs tools', () => {
  assert.equal(tools.length, 12);
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'docs.bold_selection', 'docs.delete_section', 'docs.find_replace', 'docs.get_text',
    'docs.insert_after', 'docs.insert_text', 'docs.make_list', 'docs.move_section',
    'docs.new', 'docs.open', 'docs.save', 'docs.set_heading',
  ]);
});

test('every tool has the required text fields, effect, needs and examples', () => {
  for (const tool of tools) {
    assert.match(tool.name, /^docs\.[a-z0-9_]+$/);
    assert.ok(tool.purpose.length > 0 && tool.purpose.length <= 80, `${tool.name} purpose is ${tool.purpose.length} chars`);
    assert.ok(tool.when.startsWith('Use when'), `${tool.name} when must start with "Use when"`);
    assert.ok(tool.when.length <= 120, `${tool.name} when is ${tool.when.length} chars`);
    assert.ok(['read', 'change', 'destructive', 'external'].includes(tool.effect), `${tool.name} bad effect`);
    assert.deepEqual(tool.needs, ['docs.save', 'docs.open'].includes(tool.name) ? ['host', 'app:docs', 'files'] : ['host', 'app:docs']);
    assert.equal(typeof tool.run, 'function');
    assert.ok(tool.examples.length >= 1, `${tool.name} has examples`);
    for (const example of tool.examples) {
      assert.ok(example.args && typeof example.args === 'object' && !Array.isArray(example.args));
      assert.equal(typeof example.says, 'string');
    }
  }
});

test('every parameter spec passes the runtime specErrors check', () => {
  for (const tool of tools) assert.deepEqual(specErrors(tool.params), [], `${tool.name} params`);
});

test('every example passes the runtime checkArgs the way the build runs it', () => {
  for (const tool of tools) {
    for (const [n, example] of tool.examples.entries()) {
      const out = checkArgs(tool, example.args, { choices });
      assert.ok(out.ok, `${tool.name} example ${n}: ${out.error?.message}`);
    }
  }
});

test('the effects are read for reads, change for edits, and docs.new is destructive', () => {
  assert.equal(byName('docs.get_text').effect, 'read', 'get_text');
  for (const name of ['docs.insert_text', 'docs.set_heading', 'docs.find_replace', 'docs.bold_selection', 'docs.make_list', 'docs.insert_after', 'docs.move_section']) assert.equal(byName(name).effect, 'change', name);
  for (const name of ['docs.new', 'docs.delete_section', 'docs.open']) assert.equal(byName(name).effect, 'destructive', name);
  assert.equal(byName('docs.save').effect, 'change', 'save');
  assert.equal(byName('docs.save').effectFor({ overwrite: true }), 'destructive', 'save overwrite');
  assert.equal(byName('docs.save').effectFor({}), 'change', 'save default');
});

test('docs.get_text reads the live document with a paraId per paragraph', async () => {
  const docs = fakeDocs();
  const got = await docs.runTool('docs.get_text', {});
  assert.deepEqual(got, {
    text: 'First draft\nSecond line',
    paragraphs: [{ paraId: 'p1', text: 'First draft' }, { paraId: 'p2', text: 'Second line' }],
  });
  assert.deepEqual(docs.calls, [['getEditorRef.getState']], 'reads the ProseMirror state, not the paged view');
});

test('docs.get_text reads the fresh state, not the stale paged view', async () => {
  const docs = fakeDocs();
  await docs.runTool('docs.insert_text', { text: 'Fresh para', para_id: 'p1' });
  // getPageContent is the stale paged view (still the initial content), but get_text reads the
  // live ProseMirror state, so it includes the accepted insert.
  const stale = docs.editor.getPageContent(1);
  assert.ok(!stale.text.includes('Fresh para'), 'the paged view lags the model');
  const got = await docs.runTool('docs.get_text', {});
  assert.ok(got.text.includes('Fresh para'), `get_text should read the fresh state, got: ${got.text}`);
  assert.ok(got.paragraphs.some(p => p.text === 'Fresh para'), 'the new paragraph is listed with its paraId');
});

test('docs.insert_text inserts, accepts the change, so get_text shows the new text', async () => {
  const docs = fakeDocs();
  const before = await docs.runTool('docs.get_text', {});
  assert.ok(!before.text.includes('New para'), 'the new text is not in the document yet');
  const atEnd = await docs.runTool('docs.insert_text', { text: 'New para' });
  assert.deepEqual(atEnd, { insertedAfter: 'p2', text: 'New para' });
  assert.deepEqual(docs.calls.find(c => c[0] === 'insertParagraphAfter'), ['insertParagraphAfter', { paraId: 'p2', text: 'New para', author: 'WebPC Agent' }]);
  assert.equal(docs.viewDispatches.length, 1, 'the accept transaction is dispatched on the view');
  // insertParagraphAfter applies the insertion mark (a pending tracked suggestion); the tool
  // accepts it on getView().dispatch, so the paragraph becomes accepted text get_text reads back.
  const after = await docs.runTool('docs.get_text', {});
  assert.ok(after.text.includes('New para'), `get_text should include the accepted insert, got: ${after.text}`);
});

test('docs.insert_text without para_id appends at the document end, not the cursor, so a run of inserts lands in order', async () => {
  // Live (docs-05, oracle run): the cursor sits in the first paragraph after the first line,
  // insertParagraphAfter leaves the selection where it was, and cursor-anchored inserts stack
  // in REVERSE after the anchor. The document-end anchor appends in order instead.
  const docs = fakeDocs({ getSelection: () => ({ paraId: 'p1', selectedText: 'First', paragraphText: 'First draft', before: '', after: '' }) });
  await docs.runTool('docs.insert_text', { text: 'line A' });
  await docs.runTool('docs.insert_text', { text: 'line B' });
  await docs.runTool('docs.insert_text', { text: 'line C' });
  assert.deepEqual((await docs.runTool('docs.get_text', {})).paragraphs.map(p => p.text), ['First draft', 'Second line', 'line A', 'line B', 'line C'], 'inserts append in call order');
});

test('docs.insert_text types into the empty paragraph of a fresh document (no paraId yet)', async () => {
  // Live probe of a fresh Docs window: one paragraph, content size 0, paraId null.
  const docs = fakeDocs({ getSelection: () => null }, { initial: [{ paraId: null, segs: [] }] });
  const result = await docs.runTool('docs.insert_text', { text: 'Meeting notes' });
  assert.deepEqual(result, { insertedAfter: null, text: 'Meeting notes' });
  assert.ok(!docs.calls.some(c => c[0] === 'insertParagraphAfter'), 'no paraId to insert after');
  assert.deepEqual(docs.viewDispatches[0].steps[0], ['insertText', 'Meeting notes', 1, undefined], 'typed at the start of the empty paragraph');
  assert.ok((await docs.runTool('docs.get_text', {})).text.includes('Meeting notes'));
});

test('docs.insert_text without a paraId and without an empty paragraph still teaches', async () => {
  const docs = fakeDocs({ getSelection: () => null }, { initial: [{ paraId: null, segs: [{ text: 'Old', mark: null, dead: false }] }] });
  await assert.rejects(docs.runTool('docs.insert_text', { text: 'x' }), e => e instanceof ToolError && /no paragraph to add after/.test(e.message));
});

test('docs.insert_text inserts after a given paragraph id and accepts it too', async () => {
  const docs = fakeDocs();
  const atPara = await docs.runTool('docs.insert_text', { text: 'After p1', para_id: 'p1' });
  assert.deepEqual(atPara, { insertedAfter: 'p1', text: 'After p1' });
  assert.deepEqual(docs.calls[0], ['insertParagraphAfter', { paraId: 'p1', text: 'After p1', author: 'WebPC Agent' }]);
  const after = await docs.runTool('docs.get_text', {});
  assert.ok(after.text.includes('After p1'), `get_text should include the accepted insert, got: ${after.text}`);
});

test('docs.set_heading targets the given paragraph or the cursor', async () => {
  const docs = fakeDocs();
  assert.deepEqual(await docs.runTool('docs.set_heading', { level: 2 }), { paraId: 'p2', styleId: 'Heading2' });
  assert.deepEqual(docs.calls.at(-1), ['setParagraphStyle', { paraId: 'p2', styleId: 'Heading2' }]);
  await docs.runTool('docs.set_heading', { level: 1, para_id: 'p1' });
  assert.deepEqual(docs.calls.at(-1), ['setParagraphStyle', { paraId: 'p1', styleId: 'Heading1' }]);
});

test('docs.find_replace replaces in place on the live view, keeping the paragraphs whole', async () => {
  const docs = fakeDocs();
  const out = await docs.runTool('docs.find_replace', { find: 'draft', replace: 'final' });
  assert.deepEqual(out, { replaced: 1 });
  assert.deepEqual(docs.calls[0], ['getEditorRef.getView'], 'targets the live view, not the tracked-change API');
  assert.equal(docs.viewDispatches.length, 1, 'one plain transaction, no accept');
  // The replacement lands inside the original paragraph: the count is unchanged and the text is
  // one paragraph, "First final" (the old proposeChange-then-accept path split it into three).
  assert.equal(docs.paragraphs.length, 2, 'no paragraph was split or created');
  const after = await docs.runTool('docs.get_text', {});
  assert.deepEqual(after.paragraphs, [
    { paraId: 'p1', text: 'First final' },
    { paraId: 'p2', text: 'Second line' },
  ]);
});

test('docs.find_replace applies multiple matches last-to-first and an empty replace deletes', async () => {
  const docs = fakeDocs();
  const out = await docs.runTool('docs.find_replace', { find: 'e', replace: 'E' });
  assert.deepEqual(out, { replaced: 2 }, 'the two e letters in "Second line"');
  const steps = docs.viewDispatches[0].steps;
  assert.deepEqual(steps.map(s => s[0]), ['insertText', 'insertText']);
  assert.ok(steps[0][2] > steps[1][2], 'the later match is replaced first so positions stay valid');
  const mid = await docs.runTool('docs.get_text', {});
  assert.deepEqual(mid.paragraphs[1], { paraId: 'p2', text: 'SEcond linE' }, 'both replacements in one paragraph');
  // An empty replace is a delete: the whole word "draft" is removed from its paragraph.
  const del = fakeDocs();
  assert.deepEqual(await del.runTool('docs.find_replace', { find: 'draft', replace: '' }), { replaced: 1 });
  const end = await del.runTool('docs.get_text', {});
  assert.equal(end.paragraphs.length, 2, 'the delete keeps the paragraph');
  assert.deepEqual(end.paragraphs[0], { paraId: 'p1', text: 'First ' });
  await assert.rejects(del.runTool('docs.find_replace', { find: 'zzz', replace: 'x' }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'app_error');
    assert.match(error.message, /no occurrences/);
    return true;
  });
});

test('docs.bold_selection bolds the selection or the whole paragraph', async () => {
  const docs = fakeDocs();
  const out = await docs.runTool('docs.bold_selection', {});
  assert.deepEqual(out, { bolded: 'Second' });
  assert.deepEqual(docs.calls.at(-1), ['applyFormatting', { paraId: 'p2', search: 'Second', marks: { bold: true } }]);
});

test('docs.new creates a fresh document with the default title', async () => {
  const docs = fakeDocs();
  assert.deepEqual(await docs.runTool('docs.new', {}), { title: 'Untitled document' });
  assert.deepEqual(docs.calls, [['createDocument', { title: 'Untitled document', sections: [] }]]);
  await docs.runTool('docs.new', { title: 'Weekly report' });
  assert.deepEqual(docs.calls.at(-1), ['createDocument', { title: 'Weekly report', sections: [] }]);
});

// The embedded chrome (features.menuBar false) blocks the app's string commands, so make_list
// dispatches the app's own list setNodeMarkup (numPr attr) on the live view: every paragraph
// already in the list removes it, anything else applies it to the range.
test('docs.make_list applies the list to the range by setting numPr on the view, without the string command', async () => {
  const docs = fakeDocs();
  const out = await docs.runTool('docs.make_list', { kind: 'bullet', from_text: 'First draft', to_text: 'Second line' });
  assert.deepEqual(out, { kind: 'bullet', action: 'applied', from: 'First draft', to: 'Second line' });
  const [p1, p2] = docs.paragraphs;
  assert.deepEqual(p1.numPr, { numId: 1, ilvl: 0 }, 'first line becomes a bullet paragraph');
  assert.deepEqual(p2.numPr, { numId: 1, ilvl: 0 }, 'last line becomes a bullet paragraph');
  assert.equal(p1.listIsBullet, true);
  assert.deepEqual(docs.calls.filter(c => c[0] === 'executeCommand'), [], 'the blocked string command is not called');
  assert.ok(!docs.viewDispatches[0].steps.some(s => s[0] === 'setSelection'), 'no selection is set; the range is walked directly');
  // A second call with the same kind removes the list again (the app toggle semantics).
  const again = await docs.runTool('docs.make_list', { kind: 'bullet', from_text: 'First draft', to_text: 'Second line' });
  assert.equal(again.action, 'removed');
  assert.equal(p1.numPr, null);
  assert.equal(p2.numPr, null);
});

test('docs.make_list numbered writes the numbered numId and decimal format', async () => {
  const docs = fakeDocs();
  await docs.runTool('docs.make_list', { kind: 'numbered', from_text: 'Second line' });
  const [p1, p2] = docs.paragraphs;
  assert.ok(p1.numPr == null, 'the line before the range stays unlisted');
  assert.deepEqual(p2.numPr, { numId: 2, ilvl: 0 });
  assert.equal(p2.listIsBullet, false);
});

test('docs.make_list refuses a range that runs backwards', async () => {
  const docs = fakeDocs();
  await assert.rejects(docs.runTool('docs.make_list', { kind: 'numbered', from_text: 'Second line', to_text: 'First draft' }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'invalid_argument');
    return true;
  });
});

test('docs.insert_after inserts after the paragraph with the exact text and accepts it', async () => {
  const docs = fakeDocs();
  const out = await docs.runTool('docs.insert_after', { text: 'Mid line', after: 'First draft' });
  assert.deepEqual(out, { insertedAfter: 'p1', text: 'Mid line' });
  const after = await docs.runTool('docs.get_text', {});
  assert.deepEqual(after.paragraphs.map(p => p.text), ['First draft', 'Mid line', 'Second line']);
  await assert.rejects(docs.runTool('docs.insert_after', { text: 'x', after: 'No such line' }), error => {
    assert.ok(error instanceof ToolError);
    assert.match(error.message, /no paragraph with the exact text/);
    return true;
  });
});

test('docs.delete_section removes the paragraph range and keeps the rest', async () => {
  const docs = fakeDocs({}, { initial: [
    { paraId: 'p1', segs: [{ text: 'Old ideas', mark: null, dead: false }] },
    { paraId: 'p2', segs: [{ text: 'Red wiring', mark: null, dead: false }] },
    { paraId: 'p3', segs: [{ text: 'Current plan', mark: null, dead: false }] },
  ]});
  const out = await docs.runTool('docs.delete_section', { from_text: 'Old ideas', to_text: 'Red wiring' });
  assert.deepEqual(out, { deleted: 2, from: 'Old ideas', to: 'Red wiring' });
  assert.deepEqual(docs.calls.find(c => c[0] === 'deleteParagraphs')[1].paraIds, ['p1', 'p2']);
  const after = await docs.runTool('docs.get_text', {});
  assert.deepEqual(after.paragraphs.map(p => p.text), ['Current plan']);
});

test('docs.move_section moves the range above the anchor line and keeps every line', async () => {
  const initial = [
    { paraId: 'p1', segs: [{ text: 'Current plan', mark: null, dead: false }] },
    { paraId: 'p2', segs: [{ text: 'Ship it.', mark: null, dead: false }] },
    { paraId: 'p3', segs: [{ text: 'Next steps', mark: null, dead: false }] },
    { paraId: 'p4', segs: [{ text: 'Open the beta.', mark: null, dead: false }] },
  ];
  const docs = fakeDocs({}, { initial });
  const out = await docs.runTool('docs.move_section', { from_text: 'Next steps', to_text: 'Open the beta.', before_text: 'Current plan' });
  assert.equal(out.before, 'Current plan');
  assert.deepEqual((await docs.runTool('docs.get_text', {})).paragraphs.map(p => p.text), ['Next steps', 'Open the beta.', 'Current plan', 'Ship it.']);
  // A target after the range: the target shifts up by the removed range in the cut world.
  const docs2 = fakeDocs({}, { initial });
  await docs2.runTool('docs.move_section', { from_text: 'Current plan', to_text: 'Ship it.', before_text: 'Open the beta.' });
  assert.deepEqual((await docs2.runTool('docs.get_text', {})).paragraphs.map(p => p.text), ['Next steps', 'Current plan', 'Ship it.', 'Open the beta.']);
});

// A fake ctx.files for the save/open tools: the writes are recorded, the reads return the
// given markdown or docx payload.
const filesFake = (markdown = '') => {
  const writes = [];
  return {
    writes,
    // readText answers { path, text, truncated } - no name (src/apps/ai-agent/runtime/files-ctx.mjs);
    // docs.open derives the file name from the path.
    readText: path => Promise.resolve({ path, text: markdown, truncated: false }),
    readBytes: path => Promise.resolve({ path, name: 'plan.docx', bytes: new Uint8Array([1, 2]), size: 2 }),
    writeText: (path, text, { overwrite } = {}) => { writes.push({ path, text, overwrite }); return Promise.resolve({ path, size: text.length, created: true }); },
    writeBytes: (path, bytes, { overwrite } = {}) => { writes.push({ path, size: bytes.length, overwrite }); return Promise.resolve({ path, size: bytes.length, created: true }); },
  };
};

test('docs.save writes the document as markdown or docx bytes to Files', async () => {
  const docs = fakeDocs({}, { initial: [
    { paraId: 'p1', styleId: 'Heading1', segs: [{ text: 'Quarterly plan', mark: null, dead: false }] },
    { paraId: 'p2', segs: [{ text: 'Ship the billing redesign in September.', mark: null, dead: false }] },
  ]});
  const files = filesFake();
  const ctx = { host: { appWindow: async () => docs.win }, files };
  const md = await byName('docs.save').run({ path: '/docs/plan.md' }, ctx);
  assert.deepEqual(md, { path: '/docs/plan.md', size: 56, created: true, format: 'markdown' });
  assert.equal(files.writes[0].text, '# Quarterly plan\nShip the billing redesign in September.');
  const docx = await byName('docs.save').run({ path: '/docs/plan.docx' }, ctx);
  assert.equal(docx.format, 'docx');
  assert.equal(files.writes[1].size, 3);
  await assert.rejects(byName('docs.save').run({ path: '/docs/plan.txt' }, ctx), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'invalid_argument');
    assert.match(error.message, /\.md \(markdown\) or \.docx/);
    return true;
  });
});

test('docs.save rejects when Files are not available', async () => {
  const docs = fakeDocs();
  await assert.rejects(byName('docs.save').run({ path: '/docs/plan.md' }, { host: { appWindow: async () => docs.win } }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    return true;
  });
});

test('docs.open builds a new document from a markdown file in Files', async () => {
  const docs = fakeDocs({ getSelection: () => null }, { initial: [{ paraId: null, segs: [] }] });
  const files = filesFake('# Quarterly plan\nShip it.\n\nOpen the beta.');
  const out = await byName('docs.open').run({ path: '/docs/plan.md' }, { host: { appWindow: async () => docs.win }, files });
  assert.deepEqual(out, { path: '/docs/plan.md', opened: 'plan' });
  assert.deepEqual(docs.calls[0], ['createDocument', { title: 'plan', sections: [] }]);
  // The # line becomes a heading paragraph; blank lines are skipped; the lines land in order.
  assert.deepEqual(docs.calls.find(c => c[0] === 'setParagraphStyle'), ['setParagraphStyle', { paraId: 'p3', styleId: 'Heading1' }]);
  assert.deepEqual((await docs.runTool('docs.get_text', {})).paragraphs.map(p => p.text), ['Quarterly plan', 'Ship it.', 'Open the beta.']);
});

test('docs.open loads a docx file through the editor import', async () => {
  const docs = fakeDocs({ getSelection: () => null }, { initial: [{ paraId: null, segs: [] }] });
  const out = await byName('docs.open').run({ path: '/docs/plan.docx' }, { host: { appWindow: async () => docs.win }, files: filesFake() });
  assert.deepEqual(out, { path: '/docs/plan.docx', opened: 'plan' });
  assert.ok(docs.calls.some(c => c[0] === 'importDocx'), 'the docx bytes go through importDocx');
  await assert.rejects(byName('docs.open').run({ path: '/docs/plan.txt' }, { host: { appWindow: async () => docs.win }, files: filesFake() }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'invalid_argument');
    return true;
  });
});

test('a tool rejects with not_available when ctx.host is absent', async () => {
  await assert.rejects(byName('docs.get_text').run({}, { host: null }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    return true;
  });
});

test('a tool rejects with not_available when the editor is not ready yet', async () => {
  await assert.rejects(byName('docs.get_text').run({}, { host: { appWindow: async () => ({}) } }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    assert.match(error.message, /not ready/);
    return true;
  });
});

test('a host rejection code is passed through as the ToolError type', async () => {
  const boom = () => { const error = new Error('window "docs" is not open'); error.code = 'not_open'; throw error; };
  await assert.rejects(byName('docs.get_text').run({}, { host: { appWindow: boom } }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_open');
    return true;
  });
});

const { skills, errors: skillErrors } = parseSkills(SKILLS_MD, 'docs');

test('skills.md parses with the runtime parser without errors and has 12 skills', () => {
  assert.deepEqual(skillErrors, []);
  assert.equal(skills.length, 12);
  for (const skill of skills) {
    assert.ok(skill.slug && skill.summary, `skill ${skill.slug} slug/summary`);
    assert.ok(skill.summary.length <= 160, `skill ${skill.slug} summary is ${skill.summary.length} chars`);
    assert.ok(skill.keywords.length >= 5, `skill ${skill.slug} keywords: ${skill.keywords.join(', ')}`);
    assert.ok(skill.tools.length >= 1, `skill ${skill.slug} tools`);
    assert.ok(skill.when && skill.steps.length >= 1 && skill.check, `skill ${skill.slug} body sections`);
  }
});

test('every skill opens by launching Docs, then uses numbered docs steps', () => {
  for (const skill of skills) {
    assert.equal(skill.steps[0].line, '1. call_tool tool=desktop.open_app app=docs', `skill ${skill.slug}`);
    skill.steps.forEach((step, i) => {
      assert.equal(step.n, i + 1, `skill ${skill.slug} step numbering`);
      assert.ok(step.tool.startsWith('desktop.') || step.tool.startsWith('docs.'), `skill ${skill.slug} step ${step.n}: ${step.line}`);
    });
  }
});

test('skill steps and tools lines validate against the runtime checkArgs', () => {
  const errors = checkSkills(skills, byName, { checkArgs: (tool, args) => checkArgs(tool, args, { choices }) });
  assert.deepEqual(errors, []);
});
