// SoundCraft pack (M4 file tier). SoundCraft is a standalone wrapper app (scripts/pc/craft/
// releases.mjs mode:'standalone', open:'drop') with no page API: the editor page has no
// window.soundcraft request/execute/commands surface, so these tools drive the WebPC wrapper's
// own mechanisms through the wrapper window (the pcHost.appWindow result) instead of a page API.
//
// Open: drive the wrapper's own #file input (scripts/pc/craft/app.mjs:38, no isTrusted check)
// with a File built from (name, bytes); the wrapper's handler (app.mjs:35-38) posts
// soundcraft:open, and the standalone bootstrap opens it as a drop on the canvas
// (scripts/pc/craft/bootstrap.js:75-84, openMethod 'drop'). There is no page API to poll, so
// open_file returns as soon as the file is handed to the wrapper (no opened field).
//
// Save: the user saves in the editor (Save Session, the .scraftz bundle). The app's native
// download click is captured by the bootstrap's anchor hook (bootstrap.js:92-98, the wrapper's
// nativeSource for soundcraft is .scraftz) and posted to the wrapper as soundcraft:save
// (app.mjs:29-33). save_copy waits on that message and writes the bytes to Files. A plain
// .scraft save is not captured (releases.mjs native pattern is .scraftz only), so this tool
// takes the .scraftz bundle save.
import { callLine } from '../../../src/apps/ai-agent/runtime/args.mjs';
import { filesCall, openFromBytes, readOpenFile, saveBytesCopy } from '../../shared/craft-files.js';

const APP = 'soundcraft';
const TITLE = 'SoundCraft';
const NEEDS = ['host', 'app:soundcraft'];

export const pack = { id: APP, title: TITLE };

export const tools = [
  {
    name: 'soundcraft.open_file',
    purpose: 'Open audio, MIDI or a session from Files in SoundCraft.',
    when: 'Use when the user wants media in SoundCraft. Not for opening the app itself; that is desktop.open_app.',
    params: { path: { type: 'path', required: false, description: 'A Files path to an audio, MIDI or .scraftz session file' } },
    effect: 'change',
    needs: ['host', 'app:soundcraft', 'files'],
    examples: [{ args: { path: '/SoundCraft/session.scraftz' }, says: 'Open the saved session from Files' }],
    // Drives the wrapper's own #file input (app.mjs:38); the wrapper posts soundcraft:open and
    // the standalone bootstrap drops it on the canvas (bootstrap.js:75-84). No page API to
    // confirm the load, so the result has the file name and size but no opened field.
    run: async (args, ctx) => {
      const file = await readOpenFile(ctx, args.path, { id: APP, title: 'SoundCraft' });
      const wrapper = await ctx.host.appWindow(APP);
      return openFromBytes(wrapper, APP, file.name, file.bytes);
    },
  },
  {
    name: 'soundcraft.save_copy',
    purpose: 'Save a copy of the SoundCraft session to Files.',
    when: 'Use when the user wants to keep a copy of the session in Files.',
    params: {
      path: { type: 'path', required: true, description: 'The Files path to write the copy to, e.g. /SoundCraft/session.scraftz' },
      overwrite: { type: 'boolean', description: 'Replace the file when the path already exists; false when omitted' },
    },
    effect: 'change',
    effectFor: args => (args.overwrite ? 'destructive' : 'change'),
    needs: ['host', 'app:soundcraft', 'files'],
    examples: [{ args: { path: '/SoundCraft/session.scraftz' }, says: 'Save a copy of the session to Files' }],
    // No page API to start the save: the user saves in the editor (Save Session, the .scraftz
    // bundle) and the bootstrap captures the download click (bootstrap.js:92-98; the wrapper's
    // nativeSource for soundcraft is .scraftz, releases.mjs). craft is null, so saveBytesCopy
    // uses the capture path only; the target extension is checked against the captured name.
    run: async (args, ctx) => {
      const wrapper = await ctx.host.appWindow(APP);
      const save = await saveBytesCopy(null, { id: APP, title: TITLE, wrapperWindow: wrapper, target: args.path, tool: 'soundcraft.save_copy' });
      const written = await filesCall(
        ctx,
        files => files.writeBytes(args.path, save.bytes, { overwrite: Boolean(args.overwrite) }),
        error => (error.code === 'exists' ? callLine('soundcraft.save_copy', { path: args.path, overwrite: true }) : ''),
      );
      return { path: written.path, name: save.name, size: written.size, created: written.created, ...(save.note ? { note: save.note } : {}) };
    },
  },
  {
    name: 'soundcraft.status',
    purpose: 'Show the SoundCraft wrapper status line and error.',
    when: 'Use when the user asks what SoundCraft is doing, or after an open or save that may have failed.',
    params: {},
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: {}, says: 'What is SoundCraft doing?' }],
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
