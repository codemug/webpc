// Unit tests for agent/shared/craft-files.js (the M4 file-tier helpers), with fake
// wrapper windows. Node-only: the helpers are pure and take the wrapper window as an
// argument, so no browser, build or server is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolError, callLine } from '../src/apps/ai-agent/runtime/args.mjs';
import { filesCall, openFromBytes, readOpenFile, saveCopy, saveBytesCopy, openAndAwait, MAX_OPEN_BYTES } from '../agent/shared/craft-files.js';

// A fake wrapper window (the /pc/apps/<id> utility page). The #file input records the
// change dispatches (simulating that app.mjs:38 then posts <id>:open from the
// wrapper's realm); DataTransfer/File/Event are cross-realm fakes; message listeners
// are stored so a test can fire them with an origin/source/data event for saveCopy.
function fakeWrapper() {
  const changes = [];
  const fileInput = {
    files: null,
    dispatchEvent: event => { if (event?.type === 'change') changes.push({ files: fileInput.files }); },
  };
  class FakeDataTransfer {
    constructor() { this._files = []; this.items = { add: file => this._files.push(file) }; }
    get files() { return this._files; }
  }
  class FakeFile {
    constructor(parts, name) { this.parts = parts; this.name = name; }
  }
  class FakeEvent {
    constructor(type) { this.type = type; }
  }
  const editor = { contentWindow: {} };
  const listeners = new Set();
  return {
    changes,
    fileInput,
    DataTransfer: FakeDataTransfer,
    File: FakeFile,
    Event: FakeEvent,
    document: { getElementById: id => (id === 'file' ? fileInput : id === 'editor' ? editor : null) },
    location: { origin: 'https://pc.example' },
    addEventListener: (type, fn) => { if (type === 'message') listeners.add(fn); },
    removeEventListener: (type, fn) => { if (type === 'message') listeners.delete(fn); },
    listeners: () => listeners.size,
    frame: editor.contentWindow,
    fire: event => { for (const fn of [...listeners]) fn(event); },
  };
}

const fireSave = (wrapper, data) => wrapper.fire({
  origin: 'https://pc.example', source: wrapper.frame, data,
});

const toolError = async (promise, type) => {
  let error;
  try { await promise; } catch (e) { error = e; }
  assert.ok(error instanceof ToolError, `expected ToolError, got ${error instanceof Error ? error.message : error}`);
  assert.equal(error.type, type);
  return error;
};

test('filesCall maps store rejections to ToolError the way the Files pack does', async () => {
  const files = {
    readBytes: path => Promise.reject(Object.assign(new Error(`no such file ${path}`), { code: 'not_found' })),
    writeBytes: () => Promise.reject(Object.assign(new Error('taken'), { code: 'exists' })),
    ok: () => Promise.resolve('fine'),
  };
  const noFix = await toolError(filesCall({ files }, f => f.readBytes('/a'), null), 'not_found');
  assert.match(noFix.message, /no such file \/a/);
  const withFix = await toolError(filesCall({ files }, f => f.writeBytes('/b', new Uint8Array()), e => e.code === 'exists' ? 'retry' : ''), 'exists');
  assert.equal(withFix.fix, 'retry');
  assert.equal(await filesCall({ files }, f => f.ok()), 'fine');
  assert.throws(() => filesCall({}, f => f.ok()), e => e instanceof ToolError && e.type === 'not_available');
  const te = new ToolError('app_error', 'as-is', 'x');
  await assert.rejects(filesCall({ files }, async () => { throw te; }), e => e === te); // ToolError passes through
});

test('filesCall never lets a non-string store code become a ToolError type (a numeric DOMException code)', async () => {
  // A raw DOMException carries the legacy numeric code (8 = NotFoundError); files-ctx
  // maps it to 'not_found', but any other non-string code must land on 'app_error'.
  const files = { readBytes: () => Promise.reject(Object.assign(new Error('No such file or directory'), { code: 8 })) };
  const error = await toolError(filesCall({ files }, f => f.readBytes('/a'), null), 'app_error');
  assert.match(error.message, /No such file or directory/);
});

test('readOpenFile with no path (or an empty one) is the missing_argument teaching error (lead model-eval trace B16)', async () => {
  const files = { readBytes: () => Promise.reject(new Error('unreachable')) };
  const error = await toolError(readOpenFile({ files }, undefined, { id: 'pdfcraft', title: 'PDFCraft' }), 'missing_argument');
  assert.equal(error.message, 'Give the Files path of the file to open. To open PDFCraft itself, use desktop.open_app.');
  assert.equal(error.fix, 'call_tool tool=desktop.open_app app=pdfcraft');
  await toolError(readOpenFile({ files }, '', { id: 'pdfcraft', title: 'PDFCraft' }), 'missing_argument');
});

test('readOpenFile turns a wrong path into a files.find teaching error (lead model-eval trace A01; soundcraft-05 dead-end fix)', async () => {
  const files = { readBytes: () => Promise.reject(Object.assign(new Error('no such file /GridCraft/budget.xlsx'), { code: 'not_found' })) };
  const error = await toolError(readOpenFile({ files }, '/GridCraft/budget.xlsx', { id: 'gridcraft', title: 'GridCraft' }), 'not_found');
  assert.equal(error.message, '/GridCraft/budget.xlsx is not in Files. The path may be wrong - find the file with files.find, then open that path.');
  assert.equal(error.fix, 'call_tool tool=files.find query=budget.xlsx');
  // Other store codes keep the filesCall mapping (not remapped to the open teaching error).
  const taken = { readBytes: () => Promise.reject(Object.assign(new Error('taken'), { code: 'exists' })) };
  await toolError(readOpenFile({ files: taken }, '/a.xlsx', { id: 'gridcraft', title: 'GridCraft' }), 'exists');
});

test('openFromBytes hands the file to the wrapper own #file input like its Open buttons do', async () => {
  const wrapper = fakeWrapper();
  const bytes = new Uint8Array([1, 2, 3]);
  const result = await openFromBytes(wrapper, 'gridcraft', 'sheet.xlsx', bytes);
  assert.deepEqual(result, { name: 'sheet.xlsx', bytes: 3 });
  assert.equal(wrapper.changes.length, 1); // one change dispatch for the wrapper handler (app.mjs:38)
  const file = wrapper.changes[0].files[0];
  assert.equal(file.name, 'sheet.xlsx');
  assert.equal(file.parts[0], bytes); // the same bytes, which the wrapper handler reads as an ArrayBuffer
});

test('openFromBytes rejects a bad name or non-binary bytes without touching the input', async () => {
  const wrapper = fakeWrapper();
  for (const name of ['', 'x'.repeat(256), 42]) {
    const error = await toolError(openFromBytes(wrapper, 'gridcraft', name, new Uint8Array(1)), 'invalid_argument');
    assert.match(error.message, /file name/);
  }
  await assert.rejects(openFromBytes(wrapper, 'gridcraft', 'a.xlsx', { bytes: 1 }), e => e instanceof ToolError && e.type === 'invalid_argument');
  assert.equal(wrapper.changes.length, 0);
});

test('openFromBytes without a #file input says to open the app first', async () => {
  const wrapper = { document: { getElementById: () => null }, location: { origin: 'https://pc.example' } };
  await assert.rejects(openFromBytes(wrapper, 'cadcraft', 'a.dxf', new Uint8Array(1)), e => e instanceof ToolError && e.type === 'not_available');
});

test('openFromBytes above the 256 MB wrapper cap is an app_error', async () => {
  const wrapper = fakeWrapper();
  const bytes = new Uint8Array(4);
  Object.defineProperty(bytes, 'byteLength', { value: MAX_OPEN_BYTES + 1 });
  const error = await toolError(openFromBytes(wrapper, 'gridcraft', 'big.xlsx', bytes), 'app_error');
  assert.match(error.message, /up to 256 MB/);
  assert.equal(wrapper.changes.length, 0);
});

test('saveCopy resolves with the first valid <id>:save the wrapper receives', async () => {
  const wrapper = fakeWrapper();
  const promise = saveCopy(wrapper, 'gridcraft', { timeoutMs: 5000, title: 'GridCraft' });
  fireSave(wrapper, { type: 'gridcraft:save', name: 'out.xlsx', bytes: new Uint8Array([9]) });
  assert.deepEqual(await promise, { name: 'out.xlsx', bytes: new Uint8Array([9]) });
  assert.equal(wrapper.listeners(), 0); // the listener is removed once settled
});

test('saveCopy ignores messages of the wrong type, origin or source, then times out', async () => {
  const wrapper = fakeWrapper();
  const promise = saveCopy(wrapper, 'gridcraft', { timeoutMs: 60, title: 'GridCraft' });
  fireSave(wrapper, { type: 'gridcraft:dirty', name: 'x', bytes: new Uint8Array(1) }); // wrong type
  wrapper.fire({ origin: 'https://evil.example', source: wrapper.frame, data: { type: 'gridcraft:save', name: 'x', bytes: new Uint8Array(1) } }); // wrong origin
  wrapper.fire({ origin: 'https://pc.example', source: {}, data: { type: 'gridcraft:save', name: 'x', bytes: new Uint8Array(1) } }); // wrong source
  const error = await toolError(promise, 'app_error');
  assert.match(error.message, /produced no save within/);
});

test('saveCopy treats a payload validSave rejects as no save at all (keeps waiting)', async () => {
  const wrapper = fakeWrapper();
  const promise = saveCopy(wrapper, 'gridcraft', { timeoutMs: 60, title: 'GridCraft' });
  fireSave(wrapper, { type: 'gridcraft:save', name: '', bytes: new Uint8Array(1) }); // empty name fails validSave
  fireSave(wrapper, { type: 'gridcraft:save', name: 'ok.xlsx', bytes: 'nope' }); // non-binary fails validSave
  fireSave(wrapper, { type: 'gridcraft:save', name: 'ok.xlsx', bytes: new Uint8Array([7]) }); // the good one wins
  assert.equal((await promise).name, 'ok.xlsx');
});

test('saveCopy calls the trigger after the listener is armed, and its value is ignored', async () => {
  const wrapper = fakeWrapper();
  const order = [];
  const promise = saveCopy(wrapper, 'gridcraft', {
    timeoutMs: 5000,
    title: 'GridCraft',
    trigger: async () => { order.push('trigger'); fireSave(wrapper, { type: 'gridcraft:save', name: 't.xlsx', bytes: new Uint8Array(1) }); return { irrelevant: true }; },
  });
  order.push('armed');
  assert.equal(wrapper.listeners(), 1); // armed before the trigger ran
  assert.deepEqual(await promise, { name: 't.xlsx', bytes: new Uint8Array(1) });
  assert.deepEqual(order, ['armed', 'trigger']);
});

test('saveCopy with a failing trigger rejects right away with the app error', async () => {
  const wrapper = fakeWrapper();
  const error = await toolError(saveCopy(wrapper, 'gridcraft', {
    timeoutMs: 5000,
    title: 'GridCraft',
    trigger: () => Promise.reject(Object.assign(new Error('file.save unavailable'), { code: 'app_error' })),
  }), 'app_error');
  assert.match(error.message, /Could not start the GridCraft save: file\.save unavailable/);
  assert.equal(wrapper.listeners(), 0);
});

test('saveCopy accepts save bytes from a different realm (the wrapper realm, cross-realm fix)', async () => {
  // event.data arrives in the wrapper's realm, so the bytes are a foreign-realm
  // ArrayBuffer that this realm's `instanceof ArrayBuffer` (the old validSave check)
  // drops; the tag/isView check accepts it and the result is a same-realm copy.
  const vm = await import('node:vm');
  const foreignBytes = vm.runInNewContext('new ArrayBuffer(4)');
  assert.ok(!(foreignBytes instanceof ArrayBuffer), 'precondition: the bytes fail this realm instanceof');
  const wrapper = fakeWrapper();
  const promise = saveCopy(wrapper, 'cadcraft', { timeoutMs: 500, title: 'CadCraft' });
  fireSave(wrapper, { type: 'cadcraft:save', name: 'plan.dxf', bytes: foreignBytes });
  const out = await promise;
  assert.equal(out.name, 'plan.dxf');
  assert.ok(out.bytes instanceof Uint8Array, 'the result bytes are a same-realm copy');
  assert.equal(out.bytes.byteLength, 4);
});

// A fake craft app API for the saveBytesCopy and openAndAwait tests: commands() returns
// the given live list; inspect/execute/request resolve through the given functions.
const fakeCraft = (commands, { inspect = () => ({}), execute = async () => ({}), request = async () => ({}) } = {}) => ({
  commands: async () => commands,
  inspect: params => inspect(params),
  execute: (command, params) => execute(command, params),
  request: (method, params) => request(method, params),
});

// Flips the fake wrapper's open state when the #file input is dispatched, the way the
// app's load would change its inspect after the wrapper posts <id>:open.
const loadOnOpen = (wrapper, state, loaded) => {
  const input = wrapper.document.getElementById('file');
  const original = input.dispatchEvent;
  input.dispatchEvent = event => { if (event?.type === 'change') Object.assign(state, loaded); return original(event); };
};

const SAVE_BYTES = new Uint8Array([1, 2, 3, 4]);
const SAVE_B64 = Buffer.from(SAVE_BYTES).toString('base64');

test('saveBytesCopy decodes the gridcraft base64 shape when the live list has file.saveBytes', async () => {
  const wrapper = fakeWrapper();
  const craft = fakeCraft([{ id: 'file.saveBytes' }], {
    inspect: () => ({ title: 'Budget', path: null }),
    execute: async command => (command === 'file.saveBytes' ? { name: 'Book1.xlsx', bytes: 4, base64: SAVE_B64 } : {}),
  });
  const out = await saveBytesCopy(craft, { id: 'gridcraft', title: 'GridCraft', wrapperWindow: wrapper, target: '/GridCraft/budget.xlsx', tool: 'gridcraft.save_copy', nativeExt: '.xlsx' });
  assert.deepEqual(out, { name: 'Book1.xlsx', bytes: SAVE_BYTES, note: '' });
  assert.equal(wrapper.listeners(), 0); // no capture listener: saveBytes needs no wrapper message
});

test('saveBytesCopy decodes the deckcraft data shape and names the copy from the inspect title', async () => {
  const wrapper = fakeWrapper();
  const craft = fakeCraft([{ id: 'file.saveBytes' }], {
    inspect: () => ({ title: 'Q1 Plan', path: null, slides: [1, 2, 3] }),
    execute: async () => ({ bytes: 4, data: SAVE_B64 }),
  });
  const out = await saveBytesCopy(craft, { id: 'deckcraft', title: 'DeckCraft', wrapperWindow: wrapper, target: '/DeckCraft/q1.deckcraft', tool: 'deckcraft.save_copy', nativeExt: '.deckcraft' });
  assert.equal(out.name, 'Q1 Plan.deckcraft'); // the title has no extension: the native one is appended
  assert.deepEqual(out.bytes, SAVE_BYTES);
});

test('saveBytesCopy bounds a save execute that never settles (T18 follow-up)', async () => {
  // The same mechanism as the open path: while the app's event loop is blocked the
  // save execute's promise (and its 30 s page-side reject) never settle. The bound
  // must answer with the honest app_error, not let the save outlive the turn timer.
  const wrapper = fakeWrapper();
  const craft = fakeCraft([{ id: 'file.saveBytes' }], {
    execute: () => new Promise(() => {}),
  });
  const started = Date.now();
  const error = await toolError(saveBytesCopy(craft, { id: 'deckcraft', title: 'DeckCraft', wrapperWindow: wrapper, target: '/DeckCraft/q1.deckcraft', tool: 'deckcraft.save_copy', nativeExt: '.deckcraft', saveTimeoutMs: 500 }), 'app_error');
  assert.ok(Date.now() - started < 15000, 'the save bound held, not the turn timer');
  assert.match(error.message, /DeckCraft stopped answering during the save/);
});

test('saveBytesCopy rejects when the reported byte count does not match the decoded length', async () => {
  const craft = fakeCraft([{ id: 'file.saveBytes' }], {
    execute: async () => ({ name: 'x.xlsx', bytes: 99, base64: SAVE_B64 }),
  });
  const error = await toolError(saveBytesCopy(craft, { id: 'gridcraft', title: 'GridCraft', wrapperWindow: fakeWrapper(), target: '/GridCraft/x.xlsx', tool: 'gridcraft.save_copy', nativeExt: '.xlsx' }), 'app_error');
  assert.match(error.message, /reported 99 bytes but returned 4/);
});

test('saveBytesCopy refuses a foreign target extension with a fix for the produced one', async () => {
  const craft = fakeCraft([{ id: 'file.saveBytes' }], {
    execute: async () => ({ name: 'Presentation1.deckcraft', bytes: 4, base64: SAVE_B64 }),
  });
  const error = await toolError(saveBytesCopy(craft, { id: 'deckcraft', title: 'DeckCraft', wrapperWindow: fakeWrapper(), target: '/DeckCraft/talk.pptx', tool: 'deckcraft.save_copy', nativeExt: '.deckcraft' }), 'invalid_argument');
  assert.match(error.message, /DeckCraft saves \.deckcraft files; it cannot write \.pptx here\./);
  assert.equal(error.fix, callLine('deckcraft.save_copy', { path: '/DeckCraft/talk.deckcraft' }));
});

test('saveBytesCopy without file.saveBytes falls back to the no-path capture and notes the download', async () => {
  const wrapper = fakeWrapper();
  const calls = [];
  const craft = fakeCraft([{ id: 'file.save' }], {
    execute: async (command, params) => {
      calls.push([command, params]);
      wrapper.fire({ origin: 'https://pc.example', source: wrapper.frame, data: { type: 'gridcraft:save', name: 'Book1.xlsx', bytes: new Uint8Array([5]) } });
      return {};
    },
  });
  const out = await saveBytesCopy(craft, { id: 'gridcraft', title: 'GridCraft', wrapperWindow: wrapper, target: '/GridCraft/budget.xlsx', tool: 'gridcraft.save_copy', nativeExt: '.xlsx' });
  assert.deepEqual(calls, [['file.save', {}]]); // the default fallback trigger, no path
  assert.equal(out.name, 'Book1.xlsx');
  assert.deepEqual(out.bytes, new Uint8Array([5]));
  assert.match(out.note, /also downloaded/);
});

test('saveBytesCopy uses the pack fallback trigger (cadcraft control app.save) with no path', async () => {
  const wrapper = fakeWrapper();
  const calls = [];
  const api = fakeCraft([], {
    request: (method, params) => {
      calls.push([method, params]);
      wrapper.fire({ origin: 'https://pc.example', source: wrapper.frame, data: { type: 'cadcraft:save', name: 'plan.dxf', bytes: new Uint8Array([5]) } });
      return {};
    },
  });
  const out = await saveBytesCopy(api, {
    id: 'cadcraft', title: 'CadCraft', wrapperWindow: wrapper, target: '/CadCraft/plan.dxf',
    tool: 'cadcraft.save_copy', nativeExt: '.dxf', fallbackTrigger: () => api.request('app.save', {}),
  });
  assert.deepEqual(calls, [['app.save', {}]]);
  assert.equal(out.name, 'plan.dxf');
});

test('saveBytesCopy with craft null uses the capture only, for the user-triggered save', async () => {
  const wrapper = fakeWrapper();
  const promise = saveBytesCopy(null, { id: 'soundcraft', title: 'SoundCraft', wrapperWindow: wrapper, target: '/SoundCraft/session.scraftz', tool: 'soundcraft.save_copy' });
  // the user's save in the editor becomes the wrapper's <id>:save (bootstrap.js:92-98)
  fireSave(wrapper, { type: 'soundcraft:save', name: 'session.scraftz', bytes: new Uint8Array([1, 2]) });
  const out = await promise;
  assert.deepEqual(out, { name: 'session.scraftz', bytes: new Uint8Array([1, 2]), note: 'the app also downloaded the file in the browser' });
  assert.equal(wrapper.listeners(), 0);
});

test('saveBytesCopy inlineCommand decodes figcraft file.saveAs {data: true} with no capture or download note', async () => {
  const wrapper = fakeWrapper();
  const craft = fakeCraft([], {
    execute: async (command, params) => {
      assert.deepEqual([command, params], ['file.saveAs', { data: true }]);
      return { name: 'Untitled.figcraft', bytes: 4, data: SAVE_B64 };
    },
  });
  const out = await saveBytesCopy(craft, {
    id: 'figcraft', title: 'FigCraft', wrapperWindow: wrapper, target: '/FigCraft/app.figcraft',
    tool: 'figcraft.save_copy', nativeExt: '.figcraft', inlineCommand: { command: 'file.saveAs', params: { data: true } },
  });
  assert.deepEqual(out, { name: 'Untitled.figcraft', bytes: SAVE_BYTES, note: '' });
  assert.equal(wrapper.listeners(), 0); // the call itself carried the bytes
});

test('saveBytesCopy inlineCommand decodes the vectorcraft document.serialize shape (dataBase64 + warnings, name from inspect)', async () => {
  const wrapper = fakeWrapper();
  const craft = fakeCraft([], {
    inspect: () => ({ title: 'Poster' }),
    execute: async command => (command === 'document.serialize' ? { dataBase64: SAVE_B64, warnings: [] } : {}),
  });
  const out = await saveBytesCopy(craft, {
    id: 'vectorcraft', title: 'VectorCraft', wrapperWindow: wrapper, target: '/VectorCraft/poster.svg',
    tool: 'vectorcraft.save_copy', nativeExt: '', guard: false,
    inlineCommand: { command: 'document.serialize', params: { format: 'svg' } },
  });
  assert.deepEqual(out, { name: 'Poster', bytes: SAVE_BYTES, note: '' }); // guard off: the target picks the format
});

test('saveBytesCopy inlineCommand takes the bytes from the text field when dataBase64 is absent (vectorcraft svg)', async () => {
  const wrapper = fakeWrapper();
  const svg = '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
  const craft = fakeCraft([], {
    inspect: () => ({ title: 'Logo' }),
    execute: async command => (command === 'document.serialize' ? { text: svg, warnings: [] } : {}),
  });
  const out = await saveBytesCopy(craft, {
    id: 'vectorcraft', title: 'VectorCraft', wrapperWindow: wrapper, target: '/VectorCraft/logo.svg',
    tool: 'vectorcraft.save_copy', nativeExt: '', guard: false,
    inlineCommand: { command: 'document.serialize', params: { format: 'svg' } },
  });
  assert.deepEqual(out.name, 'Logo');
  assert.deepEqual(out.bytes, new Uint8Array(new TextEncoder().encode(svg)));
  assert.equal(out.note, '');
});

test('saveBytesCopy inlineCommand on an empty text export is the no-text teaching error, not no bytes', async () => {
  const wrapper = fakeWrapper();
  // A document with a rectangle but no text: document.serialize {format: txt} answers an
  // empty dataBase64 (lead live check), not a missing payload.
  const craft = fakeCraft([], {
    execute: async command => (command === 'document.serialize' ? { dataBase64: '', warnings: [] } : {}),
  });
  const error = await toolError(saveBytesCopy(craft, {
    id: 'vectorcraft', title: 'VectorCraft', wrapperWindow: wrapper, target: '/VectorCraft/logo.txt',
    tool: 'vectorcraft.save_copy', nativeExt: '', guard: false,
    inlineCommand: { command: 'document.serialize', params: { format: 'txt' } },
  }), 'not_available');
  assert.equal(error.message, 'VectorCraft has no text to export: the document has no text.');
  assert.equal(error.fix, 'Add text to the document first');
});

test('saveBytesCopy inlineCommand without an inline payload is an app_error, not a capture hang', async () => {
  const wrapper = fakeWrapper();
  const craft = fakeCraft([], { execute: async () => ({ path: '/x.figcraft' }) });
  const error = await toolError(saveBytesCopy(craft, {
    id: 'figcraft', title: 'FigCraft', wrapperWindow: wrapper, target: '/FigCraft/x.figcraft',
    tool: 'figcraft.save_copy', nativeExt: '.figcraft', inlineCommand: { command: 'file.saveAs', params: { data: true } },
  }), 'app_error');
  assert.match(error.message, /returned no bytes from file\.saveAs/);
  assert.equal(wrapper.listeners(), 0);
});

test('saveBytesCopy capture retries the no-path save with saveAs when the app says it has no file name', async () => {
  const wrapper = fakeWrapper();
  const calls = [];
  const craft = fakeCraft([], {
    inspect: () => ({ title: 'Untitled' }),
    execute: async (command, params) => {
      calls.push([command, params]);
      if (command === 'file.saveAs') {
        wrapper.fire({ origin: 'https://pc.example', source: wrapper.frame, data: { type: 'filmcraft:save', name: 'Untitled.fcproj', bytes: new Uint8Array([1, 2]) } });
        return {};
      }
      throw new Error('no path: the project has no file name yet; use saveas');
    },
  });
  const out = await saveBytesCopy(craft, { id: 'filmcraft', title: 'FilmCraft', wrapperWindow: wrapper, target: '/FilmCraft/untitled.fcproj', tool: 'filmcraft.save_copy', nativeExt: '.fcproj' });
  assert.deepEqual(calls, [['file.save', {}], ['file.saveAs', { path: 'Untitled.fcproj' }]]);
  assert.deepEqual(out, { name: 'Untitled.fcproj', bytes: new Uint8Array([1, 2]), note: 'the app also downloaded the file in the browser' });
});

test('saveBytesCopy capture passes through a non-untitled trigger error without retrying', async () => {
  const wrapper = fakeWrapper();
  const calls = [];
  const craft = fakeCraft([], { execute: async command => { calls.push(command); throw new Error('no document open'); } });
  const error = await toolError(saveBytesCopy(craft, {
    id: 'filmcraft', title: 'FilmCraft', wrapperWindow: wrapper, target: '/FilmCraft/x.fcproj',
    tool: 'filmcraft.save_copy', nativeExt: '.fcproj',
  }), 'app_error');
  assert.match(error.message, /Could not start the FilmCraft save: no document open/);
  assert.deepEqual(calls, ['file.save']); // no saveAs retry for an unrelated refusal
});

test('openAndAwait drives the wrapper file input and returns once the inspect differs', async () => {
  const wrapper = fakeWrapper();
  const state = { sheets: [] };
  loadOnOpen(wrapper, state, { sheets: ['data'] });
  const craft = fakeCraft([], { inspect: () => ({ ...state, title: 'data' }) });
  const out = await openAndAwait(craft, { id: 'gridcraft', title: 'GridCraft', wrapperWindow: wrapper, name: 'data.csv', bytes: new Uint8Array([1, 2]), accept: '.xlsx,.csv' });
  assert.equal(wrapper.changes.length, 1);
  assert.deepEqual(out, { name: 'data.csv', bytes: 2, opened: '"data" 1 sheet', next: 'data.csv is open. To check it, call gridcraft.inspect. Opening it again shows a dialog and blocks the app.' });
});

test('openAndAwait counts an inspect that threw before and succeeds after, polling until it does', async () => {
  const wrapper = fakeWrapper();
  const state = { loaded: false };
  loadOnOpen(wrapper, state, { loaded: true });
  let polls = 0;
  const craft = fakeCraft([], {
    inspect: () => {
      polls += 1;
      if (state.loaded && polls >= 3) return { entities: 3 };
      throw Object.assign(new Error('no drawing open'), { code: 'app_error' });
    },
  });
  const out = await openAndAwait(craft, { id: 'cadcraft', title: 'CadCraft', wrapperWindow: wrapper, name: 'plan.dxf', bytes: new Uint8Array([1]), accept: '.dxf,.dwg,.shx', intervalMs: 1 });
  assert.equal(polls, 3); // the pre-open snapshot threw; the first poll after the open still threw
  assert.deepEqual(out, { name: 'plan.dxf', bytes: 1, opened: 'the app state changed', next: 'plan.dxf is open. To check it, call cadcraft.inspect. Opening it again shows a dialog and blocks the app.' });
});

test('openAndAwait times out with the accept list when the app state never changes', async () => {
  const wrapper = fakeWrapper();
  const craft = fakeCraft([], { inspect: () => ({ sheets: ['Sheet1'] }) });
  const error = await toolError(openAndAwait(craft, { id: 'cadcraft', title: 'CadCraft', wrapperWindow: wrapper, name: 'plan.dxf', bytes: new Uint8Array([1]), accept: '.dxf,.dwg,.shx', timeoutMs: 50, intervalMs: 10 }), 'app_error');
  assert.match(error.message, /CadCraft did not open plan\.dxf\. It accepts: \.dxf,\.dwg,\.shx\./);
  assert.doesNotMatch(error.message, /stopped answering/); // the inspect answered; only the state never changed
});

// deckcraft b19: the model's first open_file died at the 240 s turn timer with an empty
// trace - the page API's inspect promise can stay unsettled while the app's event loop is
// busy (a conversion or a dialog). The poll must bound every inspect, so the cap holds
// and the tool answers with the honest error instead of outliving the turn.
test('openAndAwait bounds an inspect that never settles and reports the silence', async () => {
  const wrapper = fakeWrapper();
  const never = () => new Promise(() => {});
  const craft = fakeCraft([], { inspect: never });
  const started = Date.now();
  const error = await toolError(openAndAwait(craft, { id: 'deckcraft', title: 'DeckCraft', wrapperWindow: wrapper, name: 'outline.md', bytes: new Uint8Array([1]), accept: '.deckcraft,.md', timeoutMs: 120, intervalMs: 10 }), 'app_error');
  assert.ok(Date.now() - started < 15000, 'the bounded inspect kept the wait near the cap, not the turn timer');
  assert.match(error.message, /DeckCraft did not open outline\.md\. Its inspect stopped answering during the wait/);
  assert.match(error.message, /after the dialog is cleared, call deckcraft\.inspect/);
  assert.match(error.message, /It accepts: \.deckcraft,\.md\./);
});

// deckcraft-10 (b19/b20): the open path's last unbounded await. A Files-store read that
// never settles must not push the open past the turn timer either - the read is bounded
// with the honest error, and a healthy read is untouched (the default 30 s timer is
// cleared on the fast path).
test('readOpenFile bounds a Files read that never settles', async () => {
  const ctx = { files: { readBytes: () => new Promise(() => {}) } };
  const started = Date.now();
  const error = await toolError(readOpenFile(ctx, '/Decks/outline.md', { id: 'deckcraft', title: 'DeckCraft', readTimeoutMs: 500 }), 'app_error');
  assert.ok(Date.now() - started < 15000, 'the read bound held, not the turn timer');
  assert.match(error.message, /DeckCraft did not answer the Files read within 1 s/);
});

test('readOpenFile still hands a healthy read straight through and keeps the teaching not_found', async () => {
  const ctx = { files: { readBytes: path => Promise.resolve({ path, name: 'outline.md', bytes: new Uint8Array([1]), size: 1 }) } };
  const out = await readOpenFile(ctx, '/Decks/outline.md', { id: 'deckcraft', title: 'DeckCraft', readTimeoutMs: 500 });
  assert.equal(out.name, 'outline.md');
  const missing = { files: { readBytes: () => Promise.reject(Object.assign(new Error('/missing.md is not a file.'), { code: 'not_found' })) } };
  const error = await toolError(readOpenFile(missing, '/Decks/missing.md', { id: 'deckcraft', title: 'DeckCraft', readTimeoutMs: 500 }), 'not_found');
  assert.match(error.fix, /files\.find query=missing\.md/);
});

// The b14 trap (pdfcraft-05, gridcraft-12, desktop-13): a re-open of an open file
// changed no state, burned the timeout and misreported "did not open ... It accepts".
test('openAndAwait returns already open without driving the input when the state names the file', async () => {
  const wrapper = fakeWrapper();
  const craft = fakeCraft([], { inspect: () => ({ documents: [{ active: true, doc: 1, name: 'report-q3.pdf', pages: 2 }] }) });
  const out = await openAndAwait(craft, { id: 'pdfcraft', title: 'PDFCraft', wrapperWindow: wrapper, name: 'report-q3.pdf', bytes: new Uint8Array([1, 2, 3]), accept: '.pdf' });
  assert.deepEqual(out, { name: 'report-q3.pdf', bytes: 3, opened: 'already open as document 1', next: 'report-q3.pdf is open. To check it, call pdfcraft.inspect. Opening it again shows a dialog and blocks the app.' });
  assert.equal(wrapper.changes.length, 0, 'the file input is never driven for a re-open');
});

test('openAndAwait matches the stem when the app names the document after the sheet', async () => {
  const wrapper = fakeWrapper();
  const craft = fakeCraft([], { inspect: () => ({ path: null, sheets: [{ name: 'sales-q3', cells: 45 }] }) });
  const out = await openAndAwait(craft, { id: 'gridcraft', title: 'GridCraft', wrapperWindow: wrapper, name: 'sales-q3.csv', bytes: new Uint8Array([1]), accept: '.xlsx,.csv' });
  assert.deepEqual(out, { name: 'sales-q3.csv', bytes: 1, opened: 'already open as sales-q3.csv', next: 'sales-q3.csv is open. To check it, call gridcraft.inspect. Opening it again shows a dialog and blocks the app.' });
  assert.equal(wrapper.changes.length, 0);
});

// Lead ruling: the name only counts in the identity fields. A photo catalog row or a
// recent list naming the file does not mean the file is open, and the open still runs.
test('openAndAwait does not treat a name in a non-identity field as already open', async () => {
  const wrapper = fakeWrapper();
  const state = { photos: [{ file: 'beach.jpg', size: 900 }], library: ['beach.jpg'], title: 'beach.jpg' };
  loadOnOpen(wrapper, state, { current: 1 });
  const craft = fakeCraft([], { inspect: () => state });
  const out = await openAndAwait(craft, { id: 'lightcraft', title: 'LightCraft', wrapperWindow: wrapper, name: 'beach.jpg', bytes: new Uint8Array([1, 2]), accept: '.jpg,.png,.cr2' });
  assert.equal(wrapper.changes.length, 1, 'the catalog listing (and a title named after it) did not stop the open');
  assert.equal(out.name, 'beach.jpg');
  assert.equal(out.bytes, 2);
});

// deckcraft-10 (b21): the open succeeded in round 2, then the model re-opened the same
// file ~10 times to "check it loaded"; each re-open tripped the app's dialog and the
// turn died at the 240 s timer. The deck's title of a file-opened deck is the file's
// stem (live: opening outline.md reports "outline"), so an exact stem match is the
// already-open proof.
test('openAndAwait treats a deck titled after the opened stem as already open (deckcraft re-open)', async () => {
  const wrapper = fakeWrapper();
  const craft = fakeCraft([], { inspect: () => ({ title: 'outline', slides: [1] }) });
  const out = await openAndAwait(craft, { id: 'deckcraft', title: 'DeckCraft', wrapperWindow: wrapper, name: 'outline.md', bytes: new Uint8Array([1]), accept: '.deckcraft,.md' });
  assert.deepEqual(out, {
    name: 'outline.md',
    bytes: 1,
    opened: 'already open as outline.md',
    next: 'outline.md is open. To check it, call deckcraft.inspect. Opening it again shows a dialog and blocks the app.',
  });
  assert.equal(wrapper.changes.length, 0, 'no input driven: no dialog, no bounded wait');
});

test('openAndAwait does not treat a partly matching deck title as already open', async () => {
  const wrapper = fakeWrapper();
  const state = { title: 'outlines', slides: [] };
  loadOnOpen(wrapper, state, { slides: [1] });
  const craft = fakeCraft([], { inspect: () => state });
  const out = await openAndAwait(craft, { id: 'deckcraft', title: 'DeckCraft', wrapperWindow: wrapper, name: 'outline.md', bytes: new Uint8Array([1]), accept: '.deckcraft,.md' });
  assert.equal(wrapper.changes.length, 1, 'the partial title (outlines vs. outline) did not stop the open');
  assert.equal(out.opened, '"outlines" 1 slide');
});

test('openAndAwait with checkAlreadyOpen false runs the open even when the name is already open', async () => {
  const wrapper = fakeWrapper();
  const state = { documents: [{ doc: 1, name: 'report-q3.pdf' }] };
  loadOnOpen(wrapper, state, { documents: [{ doc: 1, name: 'report-q3.pdf' }, { doc: 2, name: 'extra.pdf' }] });
  const craft = fakeCraft([], { inspect: () => state });
  const out = await openAndAwait(craft, { id: 'vectorcraft', title: 'VectorCraft', wrapperWindow: wrapper, name: 'report-q3.pdf', bytes: new Uint8Array([1]), accept: '.vectorcraft,.svg', checkAlreadyOpen: false });
  assert.equal(wrapper.changes.length, 1, 'the import opt-out drives the input even for an open name');
  assert.equal(out.name, 'report-q3.pdf');
});
