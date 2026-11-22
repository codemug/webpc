// TextureCraft pack (M4 file tier). TextureCraft is a standalone wrapper app (scripts/pc/craft/
// releases.mjs mode:'standalone', open:'drop') with no page API: the editor page has no
// window.texturecraft request/execute/commands surface, so these tools drive the WebPC wrapper's
// own mechanisms through the wrapper window (the pcHost.appWindow result) instead of a page API.
//
// Open: drive the wrapper's own #file input (scripts/pc/craft/app.mjs:38, no isTrusted check)
// with a File built from (name, bytes); the wrapper's handler (app.mjs:35-38) posts
// texturecraft:open, and the standalone bootstrap opens it as a drop on the canvas
// (scripts/pc/craft/bootstrap.js:75-84, openMethod 'drop'). A .tcraft project opens, a mesh
// (glb, gltf, fbx, dae, obj, stl, ply) imports (releases.mjs accept). There is no page API to
// poll, so open_file returns as soon as the file is handed to the wrapper (no opened field).
//
// Save: the user saves in the editor (the .tcraft project). The app's native download click is
// captured by the bootstrap's anchor hook (bootstrap.js:92-98, the wrapper's nativeSource for
// texturecraft is .tcraft, releases.mjs) and posted to the wrapper as texturecraft:save
// (app.mjs:29-33). save_copy waits on that message and writes the bytes to Files.
import { callLine } from '../../../src/apps/ai-agent/runtime/args.mjs';
import { filesCall, openFromBytes, readOpenFile, saveBytesCopy } from '../../shared/craft-files.js';

const APP = 'texturecraft';
const TITLE = 'TextureCraft';
const NEEDS = ['host', 'app:texturecraft'];

export const pack = { id: APP, title: TITLE };

export const tools = [
  {
    name: 'texturecraft.open_file',
    purpose: 'Open a project or import a mesh from Files in TextureCraft.',
    when: 'Use when the user wants a project or mesh. Not for opening the app itself; that is desktop.open_app.',
    params: { path: { type: 'path', required: true, description: 'A Files path to a .tcraft project or a mesh file (.glb, .fbx or .obj)' } },
    effect: 'change',
    needs: ['host', 'app:texturecraft', 'files'],
    examples: [{ args: { path: '/TextureCraft/car.tcraft' }, says: 'Open the texture project from Files' }],
    // Drives the wrapper's own #file input (app.mjs:38); the wrapper posts texturecraft:open and
    // the standalone bootstrap drops it on the canvas (bootstrap.js:75-84). A .tcraft project
    // opens, a mesh imports. No page API to confirm the load, so the result has the file name
    // and size but no opened field.
    run: async (args, ctx) => {
      const file = await readOpenFile(ctx, args.path, { id: APP, title: 'TextureCraft' });
      const wrapper = await ctx.host.appWindow(APP);
      return openFromBytes(wrapper, APP, file.name, file.bytes);
    },
  },
  {
    name: 'texturecraft.save_copy',
    purpose: 'Save a copy of the TextureCraft project to Files.',
    when: 'Use when the user wants to keep a copy of the project in Files.',
    params: {
      path: { type: 'path', required: true, description: 'The Files path to write the copy to, e.g. /TextureCraft/car.tcraft' },
      overwrite: { type: 'boolean', description: 'Replace the file when the path already exists; false when omitted' },
    },
    effect: 'change',
    effectFor: args => (args.overwrite ? 'destructive' : 'change'),
    needs: ['host', 'app:texturecraft', 'files'],
    examples: [{ args: { path: '/TextureCraft/car.tcraft' }, says: 'Save a copy of the project to Files' }],
    // No page API to start the save: the user saves in the editor (the .tcraft project) and the
    // bootstrap captures the download click (bootstrap.js:92-98; the wrapper's nativeSource for
    // texturecraft is .tcraft, releases.mjs). craft is null, so saveBytesCopy uses the capture
    // path only; the target extension is checked against the captured name.
    run: async (args, ctx) => {
      const wrapper = await ctx.host.appWindow(APP);
      const save = await saveBytesCopy(null, { id: APP, title: TITLE, wrapperWindow: wrapper, target: args.path, tool: 'texturecraft.save_copy' });
      const written = await filesCall(
        ctx,
        files => files.writeBytes(args.path, save.bytes, { overwrite: Boolean(args.overwrite) }),
        error => (error.code === 'exists' ? callLine('texturecraft.save_copy', { path: args.path, overwrite: true }) : ''),
      );
      return { path: written.path, name: save.name, size: written.size, created: written.created, ...(save.note ? { note: save.note } : {}) };
    },
  },
  {
    name: 'texturecraft.status',
    purpose: 'Show the TextureCraft wrapper status line and error.',
    when: 'Use when the user asks what TextureCraft is doing, or after an open or save that may have failed.',
    params: {},
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: {}, says: 'What is TextureCraft doing?' }],
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
