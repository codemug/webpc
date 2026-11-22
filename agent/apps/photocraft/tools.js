// PhotoCraft pack (M4 file tier). PhotoCraft is a standalone wrapper app (scripts/pc/craft/
// releases.mjs mode:'standalone', open:'drop') with no page API: the editor page has no
// window.photocraft request/execute/commands surface, so these tools drive the WebPC wrapper's
// own mechanisms through the wrapper window (the pcHost.appWindow result) instead of a page API.
//
// Open: drive the wrapper's own #file input (scripts/pc/craft/app.mjs:38, no isTrusted check)
// with a File built from (name, bytes); the wrapper's handler (app.mjs:35-38) posts
// photocraft:open, and the standalone bootstrap opens it as a drop on the canvas
// (scripts/pc/craft/bootstrap.js:75-84, openMethod 'drop'). A .pcraft document opens, a
// Photoshop, Krita, GIMP or flat image imports (releases.mjs accept). There is no page API to
// poll, so open_file returns as soon as the file is handed to the wrapper (no opened field).
//
// Save: the user saves in the editor (the .pcraft document). The app's native download click is
// captured by the bootstrap's anchor hook (bootstrap.js:92-98, the wrapper's nativeSource for
// photocraft is .pcraft, releases.mjs) and posted to the wrapper as photocraft:save
// (app.mjs:29-33). save_copy waits on that message and writes the bytes to Files.
import { callLine } from '../../../src/apps/ai-agent/runtime/args.mjs';
import { filesCall, openFromBytes, saveBytesCopy } from '../../shared/craft-files.js';

const APP = 'photocraft';
const TITLE = 'PhotoCraft';
const NEEDS = ['host', 'app:photocraft'];

export const pack = { id: APP, title: TITLE };

export const tools = [
  {
    name: 'photocraft.open_file',
    purpose: 'Open a document or import an image from Files in PhotoCraft.',
    when: 'Use when the user wants to open a PhotoCraft document or import an image stored in Files.',
    params: { path: { type: 'path', required: true, description: 'The Files path of the file, e.g. /PhotoCraft/scene.pcraft or /PhotoCraft/photo.png' } },
    effect: 'change',
    needs: ['host', 'app:photocraft', 'files'],
    examples: [{ args: { path: '/PhotoCraft/scene.pcraft' }, says: 'Open the document from Files' }],
    // Drives the wrapper's own #file input (app.mjs:38); the wrapper posts photocraft:open and
    // the standalone bootstrap drops it on the canvas (bootstrap.js:75-84). A .pcraft opens,
    // a Photoshop, Krita, GIMP or flat image imports. No page API to confirm the load, so the
    // result has the file name and size but no opened field.
    run: async (args, ctx) => {
      const file = await filesCall(ctx, files => files.readBytes(args.path));
      const wrapper = await ctx.host.appWindow(APP);
      return openFromBytes(wrapper, APP, file.name, file.bytes);
    },
  },
  {
    name: 'photocraft.save_copy',
    purpose: 'Save a copy of the PhotoCraft document to Files.',
    when: 'Use when the user wants to keep a copy of the document in Files.',
    params: {
      path: { type: 'path', required: true, description: 'The Files path to write the copy to, e.g. /PhotoCraft/scene.pcraft' },
      overwrite: { type: 'boolean', description: 'Replace the file when the path already exists; false when omitted' },
    },
    effect: 'change',
    effectFor: args => (args.overwrite ? 'destructive' : 'change'),
    needs: ['host', 'app:photocraft', 'files'],
    examples: [{ args: { path: '/PhotoCraft/scene.pcraft' }, says: 'Save a copy of the document to Files' }],
    // No page API to start the save: the user saves in the editor (the .pcraft document) and the
    // bootstrap captures the download click (bootstrap.js:92-98; the wrapper's nativeSource for
    // photocraft is .pcraft, releases.mjs). craft is null, so saveBytesCopy uses the capture path
    // only; the target extension is checked against the captured name.
    run: async (args, ctx) => {
      const wrapper = await ctx.host.appWindow(APP);
      const save = await saveBytesCopy(null, { id: APP, title: TITLE, wrapperWindow: wrapper, target: args.path, tool: 'photocraft.save_copy' });
      const written = await filesCall(
        ctx,
        files => files.writeBytes(args.path, save.bytes, { overwrite: Boolean(args.overwrite) }),
        error => (error.code === 'exists' ? callLine('photocraft.save_copy', { path: args.path, overwrite: true }) : ''),
      );
      return { path: written.path, name: save.name, size: written.size, created: written.created, ...(save.note ? { note: save.note } : {}) };
    },
  },
  {
    name: 'photocraft.status',
    purpose: 'Show the PhotoCraft wrapper status line and error.',
    when: 'Use when the user asks what PhotoCraft is doing, or after an open or save that may have failed.',
    params: {},
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: {}, says: 'What is PhotoCraft doing?' }],
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
