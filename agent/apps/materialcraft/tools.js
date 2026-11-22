// MaterialCraft pack (M4 file tier). MaterialCraft is a standalone wrapper app (scripts/pc/craft/
// releases.mjs mode:'standalone', open:'drop') with no page API: the editor page has no
// window.materialcraft request/execute/commands surface, so these tools drive the WebPC wrapper's
// own mechanisms through the wrapper window (the pcHost.appWindow result) instead of a page API.
//
// Open: drive the wrapper's own #file input (scripts/pc/craft/app.mjs:38, no isTrusted check)
// with a File built from (name, bytes); the wrapper's handler (app.mjs:35-38) posts
// materialcraft:open, and the standalone bootstrap opens it as a drop on the canvas
// (scripts/pc/craft/bootstrap.js:75-84, openMethod 'drop'). A .sbs or .mcraft package opens, an
// image drops in as a bitmap (releases.mjs accept). There is no page API to poll, so open_file
// returns as soon as the file is handed to the wrapper (no opened field).
//
// Save: the user saves in the editor (the package). The app's native download click is captured
// by the bootstrap's anchor hook (bootstrap.js:92-98, the wrapper's nativeSource for materialcraft
// is .sbs / .mcraft / _sbs.zip, releases.mjs) and posted to the wrapper as materialcraft:save
// (app.mjs:29-33). save_copy waits on that message and writes the bytes to Files; the target
// extension is checked against the captured name, so the save matches whatever the package
// produced (.sbs, .mcraft or a _sbs.zip web transport).
import { callLine } from '../../../src/apps/ai-agent/runtime/args.mjs';
import { filesCall, openFromBytes, saveBytesCopy } from '../../shared/craft-files.js';

const APP = 'materialcraft';
const TITLE = 'MaterialCraft';
const NEEDS = ['host', 'app:materialcraft'];

export const pack = { id: APP, title: TITLE };

export const tools = [
  {
    name: 'materialcraft.open_file',
    purpose: 'Open a package or drop in a bitmap from Files in MaterialCraft.',
    when: 'Use when the user wants to open a MaterialCraft package or add a bitmap stored in Files.',
    params: { path: { type: 'path', required: true, description: 'The Files path of the file, e.g. /MaterialCraft/wood.sbs or /MaterialCraft/diffuse.png' } },
    effect: 'change',
    needs: ['host', 'app:materialcraft', 'files'],
    examples: [{ args: { path: '/MaterialCraft/wood.sbs' }, says: 'Open the material package from Files' }],
    // Drives the wrapper's own #file input (app.mjs:38); the wrapper posts materialcraft:open and
    // the standalone bootstrap drops it on the canvas (bootstrap.js:75-84). A .sbs or .mcraft
    // package opens, an image drops in as a bitmap. No page API to confirm the load, so the
    // result has the file name and size but no opened field.
    run: async (args, ctx) => {
      const file = await filesCall(ctx, files => files.readBytes(args.path));
      const wrapper = await ctx.host.appWindow(APP);
      return openFromBytes(wrapper, APP, file.name, file.bytes);
    },
  },
  {
    name: 'materialcraft.save_copy',
    purpose: 'Save a copy of the MaterialCraft package to Files.',
    when: 'Use when the user wants to keep a copy of the package in Files.',
    params: {
      path: { type: 'path', required: true, description: 'The Files path to write the copy to, e.g. /MaterialCraft/wood.sbs' },
      overwrite: { type: 'boolean', description: 'Replace the file when the path already exists; false when omitted' },
    },
    effect: 'change',
    effectFor: args => (args.overwrite ? 'destructive' : 'change'),
    needs: ['host', 'app:materialcraft', 'files'],
    examples: [{ args: { path: '/MaterialCraft/wood.sbs' }, says: 'Save a copy of the package to Files' }],
    // No page API to start the save: the user saves in the editor (the package) and the bootstrap
    // captures the download click (bootstrap.js:92-98; the wrapper's nativeSource for materialcraft
    // is .sbs / .mcraft / _sbs.zip, releases.mjs). craft is null, so saveBytesCopy uses the
    // capture path only; the target extension is checked against the captured name.
    run: async (args, ctx) => {
      const wrapper = await ctx.host.appWindow(APP);
      const save = await saveBytesCopy(null, { id: APP, title: TITLE, wrapperWindow: wrapper, target: args.path, tool: 'materialcraft.save_copy' });
      const written = await filesCall(
        ctx,
        files => files.writeBytes(args.path, save.bytes, { overwrite: Boolean(args.overwrite) }),
        error => (error.code === 'exists' ? callLine('materialcraft.save_copy', { path: args.path, overwrite: true }) : ''),
      );
      return { path: written.path, name: save.name, size: written.size, created: written.created, ...(save.note ? { note: save.note } : {}) };
    },
  },
  {
    name: 'materialcraft.status',
    purpose: 'Show the MaterialCraft wrapper status line and error.',
    when: 'Use when the user asks what MaterialCraft is doing, or after an open or save that may have failed.',
    params: {},
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: {}, says: 'What is MaterialCraft doing?' }],
    // The app has no page API to read, so this reads the wrapper's own state: the #status line
    // and the #error line (hidden when empty) that the wrapper keeps (app.mjs:7-8).
    run: async (args, ctx) => {
      const wrapper = await ctx.host.appWindow(APP);
      const status = wrapper?.document?.getElementById?.('status')?.textContent ?? '';
      const err = wrapper?.document?.getElementById?.('error');
      const error = (err && !err.hidden && err.textContent) || '';
      return { status, ...(error ? { error } : {}) };
    },
  },
];
