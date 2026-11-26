// Files pack: the Files area tools (list, read, write, folders, rename, move, delete, find).
// Every tool drives the Files store through ctx.files, which the runtime wires over
// src/scripts/pc/files/store.mjs behind the access policy. Paths are Files paths starting
// with "/". No module-level side effects: the build imports this file in Node.
import { ToolError, callLine } from '../../src/apps/ai-agent/runtime/args.mjs';

const NOT_HERE = 'Files are not available here.';

// Gate on ctx.files (needs: ['files']), then turn store rejections, which carry a code
// (not_found, exists, not_a_folder, not_a_file, too_large, not_allowed, invalid_name),
// into ToolError. fixFor (optional) returns a corrected call line for fixable errors.
const call = (ctx, fn, fixFor) => {
  if (!ctx.files) throw new ToolError('not_available', NOT_HERE, '');
  return Promise.resolve()
    .then(() => fn(ctx.files))
    .catch(error => {
      if (error instanceof ToolError) throw error;
      throw new ToolError(typeof error.code === 'string' ? error.code : 'app_error', error.message, fixFor ? fixFor(error) : '');
    });
};

// mv semantics (j3 files-08 triage): when `to` is an existing folder or ends in "/",
// the file moves into that folder keeping its name; otherwise `to` is the new full path.
// lfm3 sent files.rename to=/archive and the store renamed the CSV to a file called
// /archive, so the check for /archive/sales-q3.csv could never pass.
const mvTarget = async (files, path, to) => {
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (to.endsWith('/')) return to + base;
  try {
    if ((await files.stat(to)).kind === 'folder') return to + '/' + base;
  } catch { /* not a folder (or no such path): keep to as the new full path */ }
  return to;
};

// Shared by files.rename and files.move: resolve the mv target, check the target
// folder exists (naming the mkdir), then rename. files.move is a real tool, so the
// window-verb alias no longer sends a "move" call to desktop.move (j3 files-08).
const moveRun = async (args, ctx) => {
  if (!ctx.files) throw new ToolError('not_available', NOT_HERE, '');
  const to = await mvTarget(ctx.files, args.path, args.to);
  // The store refuses a rename into a missing folder with a bare not_found that names no
  // fix (lfm3-1.7b, files-08); check the target folder up front and name the mkdir.
  const targetDir = to.slice(0, to.lastIndexOf('/'));
  const sourceDir = args.path.slice(0, args.path.lastIndexOf('/'));
  if (targetDir !== '' && targetDir !== sourceDir) {
    try {
      const info = await ctx.files.stat(targetDir);
      if (info.kind !== 'folder') throw new ToolError('not_a_folder', `${targetDir} is not a folder`, '');
    } catch (error) {
      if (error instanceof ToolError) throw error;
      if (error?.code === 'not_found') throw new ToolError('not_found', `the target folder ${targetDir} does not exist; create it first`, `call_tool tool=files.mkdir path=${targetDir}`);
      throw new ToolError(error?.code ?? 'app_error', error?.message ?? String(error), '');
    }
  }
  return call(ctx, files => files.rename(args.path, to),
    error => error.code === 'exists' ? callLine('files.rename', { path: args.path, to: secondName(to) }) : '');
};

// files.move is folder-oriented: a missing folder-like target (no extension, no trailing
// slash) would otherwise fall back to rename-to-full-path and the store renames the file
// to a file called /archive, so the check for /archive/sales-q3.csv can never pass
// (sweep b16 files-08; moveRun's guard only catches missing NESTED folders, where the
// dirname is non-empty). A missing folder errors and names the mkdir. files.rename keeps
// the rename-to-full-path semantics, top level included.
const moveFolderRun = async (args, ctx) => {
  if (!ctx.files) throw new ToolError('not_available', NOT_HERE, '');
  const to = String(args.to);
  if (!to.endsWith('/') && !to.slice(to.lastIndexOf('/') + 1).includes('.')) {
    try { await ctx.files.stat(to); } catch (error) {
      if (error instanceof ToolError) throw error;
      if (error?.code === 'not_found') {
        throw new ToolError('not_found', `the target folder ${to} does not exist; create it first`, `call_tool tool=files.mkdir path=${to}`);
      }
      throw new ToolError(error?.code ?? 'app_error', error?.message ?? String(error), '');
    }
  }
  return moveRun(args, ctx);
};

// The free target suggested when a rename target is taken: insert " (2)" before the
// extension (/a/b.txt -> /a/b (2).txt); a name without an extension just gains " (2)".
const secondName = path => {
  const slash = path.lastIndexOf('/');
  const base = path.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return `${path} (2)`;
  return `${path.slice(0, slash + 1 + dot)} (2)${base.slice(dot)}`;
};

// Files is the browser's own store; a path under a Linux system root is the Terminal's
// world (lfm3, j3-terminal-1 A13 and terminal-08: asked for /home/user/sales-mini.csv and
// the write silently created /home/user in Files). Refuse the path before it touches the
// store and hand back the terminal.run command that does the same job in Linux.
const LINUX_ROOT = /^\/(home|root|etc|usr|var|tmp|bin|opt)(\/|$)/;
const LINUX_MSG = 'That is a Linux path; files in the Linux home directory live in the Terminal, not in Files';
const shq = text => `'${String(text).replace(/'/g, `'\\''`)}'`;
const parentOf = path => path.slice(0, path.lastIndexOf('/')) || '/';
// code is a builder, so the shell line is only composed when the path actually matches.
const linuxRefuse = (path, code) => {
  if (LINUX_ROOT.test(String(path))) throw new ToolError('invalid_argument', LINUX_MSG, callLine('terminal.run', { code: code() }));
};

export const pack = { id: 'files', title: 'Files' };

export const tools = [
  {
    name: 'files.list',
    purpose: 'List the files and folders in a Files folder.',
    when: 'Use when the user asks what is in a folder or which files are saved.',
    params: { path: { type: 'path', default: '/', description: 'The folder to look in; the Files root when omitted' } },
    effect: 'read',
    needs: ['files'],
    examples: [{ args: { path: '/notes' }, says: 'What is in my notes folder?' }, { args: {}, says: 'Show me my files' }],
    run: async (args, ctx) => call(ctx, files => files.list(args.path ?? '/')),
  },
  {
    name: 'files.info',
    purpose: 'Show the size and kind of one file or folder.',
    when: 'Use when the user asks how big a file is, or whether a path is a file or a folder.',
    params: { path: { type: 'path', required: true, description: 'The file or folder to inspect' } },
    effect: 'read',
    needs: ['files'],
    examples: [{ args: { path: '/notes/todo.txt' }, says: 'How big is my todo file?' }],
    run: async (args, ctx) => call(ctx, files => files.stat(args.path)),
  },
  {
    name: 'files.read',
    purpose: 'Read the text of a file, up to a character limit.',
    when: 'Use when the user asks to read, show or open the contents of a text file.',
    params: {
      path: { type: 'path', required: true, description: 'The file to read' },
      max_chars: { type: 'integer', min: 100, max: 100000, default: 20000, description: 'At most this many characters to read' },
    },
    effect: 'read',
    needs: ['files'],
    examples: [{ args: { path: '/notes/todo.txt' }, says: 'Read my todo file' }, { args: { path: '/notes/ideas.md', max_chars: 500 }, says: 'Show me just the start of ideas.md' }],
    run: async (args, ctx) => call(ctx, files => files.readText(args.path, { maxChars: args.max_chars ?? 20000 })),
  },
  {
    name: 'files.write',
    purpose: 'Save a new file with the given text; never overwrites.',
    when: 'Use when the user asks to write, save or create a new note or text file.',
    params: {
      path: { type: 'path', required: true, description: 'The new file to save' },
      text: { type: 'text', required: true, description: 'The content to save into the new file' },
    },
    effect: 'change',
    needs: ['files'],
    examples: [{ args: { path: '/notes/todo.txt', text: 'Buy milk\nCall Ana' }, says: 'Save a new todo note' }],
    run: async (args, ctx) => {
      linuxRefuse(args.path, () => `mkdir -p ${parentOf(args.path)} && printf '%s' ${shq(args.text)} > ${args.path}`);
      return call(ctx, files => files.writeText(args.path, args.text, { overwrite: false }),
        error => error.code === 'exists' ? callLine('files.overwrite', { path: args.path, text: args.text }) : '');
    },
  },
  {
    name: 'files.overwrite',
    purpose: 'Replace all content of a file; the old content is lost.',
    when: 'Use when the user wants to replace a whole file and agreed to lose the old text.',
    params: {
      path: { type: 'path', required: true, description: 'The file to replace' },
      text: { type: 'text', required: true, description: 'The new content for the file' },
    },
    effect: 'destructive',
    needs: ['files'],
    examples: [{ args: { path: '/notes/todo.txt', text: 'Updated list' }, says: 'Replace the todo file with this text' }],
    // Overwrite writes through the same store as write (missing folders are created), so it
    // carries the Linux-root guard too, though it replaces rather than creates.
    run: async (args, ctx) => {
      linuxRefuse(args.path, () => `mkdir -p ${parentOf(args.path)} && printf '%s' ${shq(args.text)} > ${args.path}`);
      return call(ctx, files => files.writeText(args.path, args.text, { overwrite: true }));
    },
  },
  {
    name: 'files.append',
    purpose: 'Add text to the end of a file, keeping what is there.',
    when: 'Use when the user asks to add a line, extend or append to a file.',
    params: {
      path: { type: 'path', required: true, description: 'The file to add text to' },
      text: { type: 'text', required: true, description: 'The text to add at the end of the file' },
    },
    effect: 'change',
    needs: ['files'],
    examples: [{ args: { path: '/notes/todo.txt', text: '\nCall Ana' }, says: 'Add a line to my todo' }],
    run: async (args, ctx) => {
      linuxRefuse(args.path, () => `mkdir -p ${parentOf(args.path)} && printf '%s' ${shq(args.text)} >> ${args.path}`);
      return call(ctx, files => files.appendText(args.path, args.text));
    },
  },
  {
    name: 'files.mkdir',
    purpose: 'Make a new folder, and any missing folders above it.',
    when: 'Use when the user asks to make, create or add a new folder.',
    params: { path: { type: 'path', required: true, description: 'The folder path to create; missing parents are created too' } },
    effect: 'change',
    needs: ['files'],
    examples: [{ args: { path: '/notes/2026' }, says: 'Make a 2026 folder inside notes' }],
    run: async (args, ctx) => {
      linuxRefuse(args.path, () => `mkdir -p ${args.path}`);
      return call(ctx, files => files.mkdir(args.path));
    },
  },
  {
    name: 'files.rename',
    purpose: 'Rename a file or move it to another folder.',
    when: 'Use when the user asks to rename, move or save a file under a new name or place.',
    params: {
      path: { type: 'path', required: true, description: 'The current path of the file' },
      to: { type: 'path', required: true, description: 'The new path, or the folder to move the file into; when to is a folder (or ends in /) the file keeps its name' },
    },
    effect: 'change',
    needs: ['files'],
    examples: [{ args: { path: '/notes/todo.txt', to: '/notes/todo-2026.txt' }, says: 'Rename my todo file' }, { args: { path: '/inbox/report.txt', to: '/archive' }, says: 'Move the report into the archive folder' }],
    run: moveRun,
  },
  {
    name: 'files.move',
    purpose: 'Move a file into another folder, keeping its name.',
    when: 'Use when the user asks to move a file into or to a folder.',
    params: {
      path: { type: 'path', required: true, description: 'The current path of the file' },
      to: { type: 'path', required: true, description: 'The folder to move the file into; a missing folder is an error (create it first with files.mkdir). Renaming to a new full path is files.rename' },
    },
    effect: 'change',
    needs: ['files'],
    examples: [{ args: { path: '/inbox/report.txt', to: '/archive' }, says: 'Move the report into the archive folder' }],
    run: moveFolderRun,
  },
  {
    name: 'files.delete',
    purpose: 'Delete a file, or an empty folder; the delete is permanent.',
    when: 'Use when the user asks to delete, trash, remove or get rid of a file or folder.',
    params: {
      path: { type: 'path', required: true, description: 'The file or folder to delete' },
      recursive: { type: 'boolean', default: false, description: 'Also delete the contents of a folder; without it only an empty folder is removed' },
    },
    effect: 'destructive',
    needs: ['files'],
    examples: [{ args: { path: '/notes/old.txt' }, says: 'Delete the old note' }, { args: { path: '/notes/2025', recursive: true }, says: 'Delete the whole 2025 folder' }],
    run: async (args, ctx) => call(ctx, files => files.remove(args.path, { recursive: Boolean(args.recursive) })),
  },
  {
    name: 'files.find',
    purpose: 'Find files by a part of their name.',
    when: 'Use when the user asks to find or search for a file by part of its name.',
    params: {
      query: { type: 'string', required: true, description: 'Part of the file name to search for, matched anywhere in the name' },
      under: { type: 'path', default: '/', description: 'Only search folders under this path' },
    },
    effect: 'read',
    needs: ['files'],
    examples: [{ args: { query: 'todo' }, says: 'Find my todo file' }, { args: { query: 'report', under: '/inbox' }, says: 'Find report files in the inbox' }],
    run: async (args, ctx) => call(ctx, files => files.find(args.query, { under: args.under ?? '/' })),
  },
];
