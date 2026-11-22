// Ported from storytold/filmcraft@v0.20.1 crates/automation/src/server.rs (the #[tool] table)
// and crates/engine/src/commands.rs (the command registry, 254016000000 ticks per second).
// Tool names, descriptions and the control-method mapping follow those tables; arguments are
// flattened for small models.
// The tools run in Buddy's frame and drive the FilmCraft page API through ctx.craft, which the
// runtime wires as id => craftApi(await ctx.host.appWindow(id), id) (plan 9).
import { ToolError, callLine, closest } from '../../../src/apps/ai-agent/runtime/args.mjs';
import { filesCall, openAndAwait, saveBytesCopy } from '../../shared/craft-files.js';
import { releases } from '../../../scripts/pc/craft/releases.mjs';

const APP = 'filmcraft';
const NEEDS = ['host', 'app:filmcraft'];
// run_command/batch ids that destroy or replace data, from the engine command registry
// (crates/engine/src/commands.rs cmd! table): effectFor marks those calls destructive, so the
// policy asks. file.newProject and file.openDemoProject replace the open project (the web app
// holds one project), so they are destructive though the registry does not flag them.
const DESTRUCTIVE = [
  'file.newProject', 'file.openDemoProject', 'file.revert', 'file.discardRecovery',
  'project.delete', 'sequence.deleteTrack', 'sequence.lift', 'sequence.extract',
  'edit.rippleDeleteHead', 'markers.clearAll', 'markers.clearCurrent', 'markers.clearIn',
  'markers.clearOut', 'markers.clearInOut', 'sequence.removeTransition',
  'history.clear', 'history.deleteRedoable', 'effects.remove', 'effects.deleteKeyframe',
  'colors.removeCustom',
];

/** commands.rs pick(): copy the listed keys (when present) into a params object. */
const pick = (args, keys) => {
  const out = {};
  for (const key of keys) if (args[key] !== undefined) out[key] = args[key];
  return out;
};

// A key=value value: booleans, numbers, a [ ... ] or { ... } JSON value, else a string.
const parseValue = raw => {
  if (/^(true|false)$/i.test(raw)) return raw.toLowerCase() === 'true';
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try { return JSON.parse(raw); } catch { /* not JSON: keep as text */ }
  }
  return raw;
};

// key=value lines -> object (the generic long-tail form for params).
const parseParams = text => {
  const out = {};
  for (const line of String(text ?? '').split('\n')) {
    const row = line.trim();
    if (!row) continue;
    const eq = row.indexOf('=');
    if (eq <= 0) throw new ToolError('invalid_argument', `bad params line "${row}": use key=value`, '');
    out[row.slice(0, eq).trim()] = parseValue(row.slice(eq + 1).trim());
  }
  return out;
};

// A batch step "id k=v k2=v2": the id, then space-separated key=value tokens (no spaces in values).
const parseStep = line => {
  const text = String(line ?? '').trim();
  const out = { command: '', params: {} };
  if (!text) return null;
  const sp = text.indexOf(' ');
  out.command = sp < 0 ? text : text.slice(0, sp);
  for (const token of sp < 0 ? [] : text.slice(sp + 1).split(/\s+/)) {
    const eq = token.indexOf('=');
    if (eq <= 0) throw new ToolError('invalid_argument', `bad batch step "${text}": params are key=value tokens`, '');
    out.params[token.slice(0, eq)] = parseValue(token.slice(eq + 1));
  }
  return out;
};

// The engine's time forms (commands.rs time_p_at): a top-level seconds, frame or timecode.
// Exactly one is given, else the call runs at the playhead.
const timeArgs = args => {
  const out = pick(args, ['seconds', 'frame', 'timecode']);
  return out;
};

// Nested time forms (commands.rs tick_or_time_p): a ticks integer or a {"seconds"|"frame"|
// "timecode"} object. The pack takes seconds only and wraps it in the object form.
const nestedTime = value => (value === undefined ? undefined : { seconds: value });

export const pack = { id: APP, title: 'FilmCraft' };

export const tools = [
  {
    name: 'filmcraft.inspect',
    purpose: 'Show the project tree and the active sequence with ids for commands.',
    when: 'Use when the user asks what is in the project, or before planning edits.',
    params: {},
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: {}, says: 'What is in this project?' }],
    // server.rs:402 + document() :305-313: project.inspect, then sequence.inspect of the
    // activeSequence item; a sequence that fails to read comes back as null (errors swallowed)
    run: async (args, ctx) => {
      const app = await ctx.craft(APP);
      const project = await app.execute('project.inspect', {});
      const active = project?.activeSequence;
      let sequence = null;
      if (active !== undefined && active !== null) {
        try {
          sequence = await app.execute('sequence.inspect', { item: active });
        } catch { /* document() swallows this: the sequence is null */ }
      }
      return { project, sequence };
    },
  },
  {
    name: 'filmcraft.project_inspect',
    purpose: 'Show the project tree: bins and items with ids, types, durations.',
    when: 'Use when the user asks what media is in the bins.',
    params: {},
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: {}, says: 'List the bins and media' }],
    // server.rs:420 project.inspect
    run: async (args, ctx) => (await ctx.craft(APP)).execute('project.inspect', {}),
  },
  {
    name: 'filmcraft.sequence_inspect',
    purpose: 'Show the active sequence: tracks, clips, markers, playhead, selection.',
    when: 'Use when the user asks what is on the timeline.',
    params: { item: { type: 'integer', description: 'Sequence item id; the active sequence when omitted' } },
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: {}, says: 'What is on the timeline?' }],
    // server.rs:429 sequence.inspect (the engine reads the active sequence when item is absent)
    run: async (args, ctx) => (await ctx.craft(APP)).execute('sequence.inspect', pick(args, ['item'])),
  },
  {
    name: 'filmcraft.ui_inspect',
    purpose: 'Show the editor UI state: panels, monitors, transport.',
    when: 'Use when the user asks what the app is showing.',
    params: {},
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: {}, says: 'What does the app look like right now?' }],
    // server.rs:506 ui.inspect; the page installs it as uiInspect (Methods { doc_inspect:
    // None, ..default() }, apps/filmcraft-web/src/api.rs:124-125), so the adapter inspect()
    // maps to it via the METHODS entry
    run: async (args, ctx) => (await ctx.craft(APP)).inspect({}),
  },
  {
    name: 'filmcraft.playhead',
    purpose: 'Move the playhead to a second, frame or timecode.',
    when: 'Use when the user wants the playhead at a specific time.',
    params: {
      seconds: { type: 'number', description: 'Seconds from sequence start (254016000000 ticks per second upstream)' },
      frame: { type: 'integer', description: 'Frame number from sequence start' },
      timecode: { type: 'string', description: 'Timecode string, e.g. 00:01:00:00' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { seconds: 3.5 }, says: 'Jump to 3.5 seconds' }],
    // commands.rs:3228 playhead.set {time ticks | frame | seconds | timecode}; the pack takes
    // seconds, frame or timecode (raw ticks are not exposed)
    run: async (args, ctx) => {
      if (args.seconds === undefined && args.frame === undefined && args.timecode === undefined) {
        throw new ToolError('invalid_argument', 'give one of seconds, frame or timecode', '');
      }
      return (await ctx.craft(APP)).execute('playhead.set', timeArgs(args));
    },
  },
  {
    name: 'filmcraft.razor',
    purpose: 'Cut a clip or a track at the playhead (or a given time).',
    when: 'Use when the user wants a cut at the playhead or at a time.',
    params: {
      seconds: { type: 'number', description: 'Cut time in seconds; the playhead when omitted' },
      frame: { type: 'integer', description: 'Cut frame; the playhead when omitted' },
      timecode: { type: 'string', description: 'Cut timecode; the playhead when omitted' },
      track: { type: 'string', description: 'Track to cut, e.g. V1; the playhead\'s tracks when a clip is named' },
      clip: { type: 'integer', description: 'Cut this one clip instead of whole tracks' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Cut at the playhead' }],
    // commands.rs:3604 timeline.razor {time (default: playhead), track?, clip?}; the clip wins
    // over the track when both are given (upstream run body)
    run: async (args, ctx) => (await ctx.craft(APP)).execute('timeline.razor', { ...timeArgs(args), ...pick(args, ['track', 'clip']) }),
  },
  {
    name: 'filmcraft.add_edit',
    purpose: 'Add an edit point (marker) at the playhead or a given time.',
    when: 'Use when the user wants an edit marked on the timeline.',
    params: {
      seconds: { type: 'number', description: 'Edit time in seconds; the playhead when omitted' },
      frame: { type: 'integer', description: 'Edit frame; the playhead when omitted' },
      timecode: { type: 'string', description: 'Edit timecode; the playhead when omitted' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Mark an edit here' }],
    // commands.rs:2708 sequence.addEdit {time (default: playhead)}
    run: async (args, ctx) => (await ctx.craft(APP)).execute('sequence.addEdit', timeArgs(args)),
  },
  {
    name: 'filmcraft.place',
    purpose: 'Place a media item from the project onto a track at a time.',
    when: 'Use when the user wants a clip from a bin put on the timeline.',
    params: {
      item: { type: 'integer', required: true, description: 'Project item id (from filmcraft.project_inspect)' },
      track: { type: 'string', description: 'Video track, e.g. V1, or new to add one' },
      audioTrack: { type: 'string', description: 'Audio track for the sound, e.g. A1, or new' },
      seconds: { type: 'number', description: 'Placement time in seconds; the playhead when omitted' },
      frame: { type: 'integer', description: 'Placement frame; the playhead when omitted' },
      timecode: { type: 'string', description: 'Placement timecode; the playhead when omitted' },
      source_in: { type: 'number', description: 'Source in point in seconds (skip media at the start)' },
      duration: { type: 'number', description: 'How many seconds to place' },
      video: { type: 'boolean', description: 'Place the picture (default true)' },
      audio: { type: 'boolean', description: 'Place the sound (default true)' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { item: 3, track: 'V1', seconds: 5 }, says: 'Put item 3 on V1 at 5 seconds' }],
    // commands.rs place_one :1230+: timeline.place {item, track?, audioTrack?, time?, sourceIn?,
    // duration?, video?, audio?}. timeline.place is an internal command: it is not in the
    // command.list registry, so this tool runs it directly (run_command cannot reach it)
    run: async (args, ctx) => {
      const params = { item: args.item, ...timeArgs(args), ...pick(args, ['track', 'audioTrack', 'video', 'audio']) };
      if (args.source_in !== undefined) params.sourceIn = { seconds: args.source_in };
      if (args.duration !== undefined) params.duration = { seconds: args.duration };
      return (await ctx.craft(APP)).execute('timeline.place', params);
    },
  },
  {
    name: 'filmcraft.move',
    purpose: 'Move clips to new track and time positions on the timeline.',
    when: 'Use when the user wants clips rearranged on the timeline.',
    params: {
      moves: { type: 'text', required: true, description: 'JSON array, one object per move: {"clip": id, "track": "V1"|"A1"|"new", "seconds": n?}' },
      copy: { type: 'boolean', description: 'Move copies instead of the clips (option-drag)' },
      linked: { type: 'boolean', description: 'Bring linked partners along (default: the Linked Selection setting)' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { moves: '[{"clip":5,"track":"V2","seconds":10}]' }, says: 'Move clip 5 to V2 at 10 seconds' }],
    // commands.rs move_clips :534+: timeline.move {moves: [{clip, track, time?}], copy?, linked?}.
    // Internal command (not in the command.list registry): run directly, not via run_command
    run: async (args, ctx) => {
      let moves;
      try {
        moves = JSON.parse(args.moves);
      } catch {
        throw new ToolError('invalid_argument', 'moves must be a JSON array of {clip, track, seconds?} objects', '');
      }
      if (!Array.isArray(moves) || moves.length === 0) {
        throw new ToolError('invalid_argument', 'moves needs at least one {clip, track} item', '');
      }
      moves = moves.map(entry => {
        if (entry?.clip === undefined || entry?.track === undefined) {
          throw new ToolError('invalid_argument', 'each move needs a clip and a track', '');
        }
        const out = { clip: entry.clip, track: entry.track };
        if (entry.seconds !== undefined) out.time = { seconds: entry.seconds };
        return out;
      });
      const params = { moves, ...pick(args, ['copy', 'linked']) };
      return (await ctx.craft(APP)).execute('timeline.move', params);
    },
  },
  {
    name: 'filmcraft.apply_effect',
    purpose: 'Apply an effect (blur, color, transition, ...) to clips.',
    when: 'Use when the user wants an effect on a clip, or the list of effects.',
    params: {
      effect: { type: 'string', description: 'Effect id or display name, e.g. gaussian_blur or Gaussian Blur; omit for the catalogue' },
      clips: { type: 'list', description: 'Clip ids; the selection when omitted' },
      kind: { type: 'string', description: 'Catalogue filter: Video, Audio, VideoTransition or AudioTransition' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { effect: 'Gaussian Blur' }, says: 'Blur the selected clip' }],
    // commands.rs:3693 effects.apply {clips?, effect} and :4199 effects.list {kind?}; the
    // upstream MCP table has no effect tool, so the catalogue is folded in here (report)
    run: async (args, ctx) => {
      const app = await ctx.craft(APP);
      if (args.effect === undefined) return app.execute('effects.list', pick(args, ['kind']));
      const params = { effect: args.effect, ...pick(args, ['clips']) };
      return app.execute('effects.apply', params);
    },
  },
  {
    name: 'filmcraft.new_bin',
    purpose: 'Create a bin in the project.',
    when: 'Use when the user wants media organised into a bin.',
    params: { name: { type: 'string', required: true, description: 'Bin name' } },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { name: 'Interviews' }, says: 'Make an Interviews bin' }],
    // commands.rs:1727 file.newBin {name, parent?}
    run: async (args, ctx) => (await ctx.craft(APP)).execute('file.newBin', { name: args.name }),
  },
  {
    name: 'filmcraft.new_project',
    purpose: 'Start a new (empty) project, replacing the open one.',
    when: 'Use when the user wants to start a new project.',
    params: { name: { type: 'string', description: 'Project name (required upstream)' } },
    effect: 'destructive',
    needs: NEEDS,
    examples: [{ args: { name: 'Reel' }, says: 'Start a new project called Reel' }],
    // commands.rs:1593 file.newProject {name}; destructive: the web app holds one project, so
    // this replaces the open one
    run: async (args, ctx) => {
      if (args.name === undefined) throw new ToolError('invalid_argument', 'a new project needs a name', '');
      return (await ctx.craft(APP)).execute('file.newProject', { name: args.name });
    },
  },
  {
    name: 'filmcraft.open_demo',
    purpose: 'Open the built-in demo project, replacing the open one.',
    when: 'Use when the user wants to see the app with sample media.',
    params: {},
    effect: 'destructive',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Show me the demo project' }],
    // commands.rs:1611 file.openDemoProject {}; destructive: replaces the open project
    run: async (args, ctx) => (await ctx.craft(APP)).execute('file.openDemoProject', {}),
  },
  {
    name: 'filmcraft.undo',
    purpose: 'Undo the last edit in the project.',
    when: 'Use when the user wants to undo the last edit.',
    params: {},
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Undo that cut' }],
    // commands.rs:2113 edit.undo
    run: async (args, ctx) => (await ctx.craft(APP)).execute('edit.undo', {}),
  },
  {
    name: 'filmcraft.redo',
    purpose: 'Redo the last undone edit.',
    when: 'Use when the user wants to redo the change they just undid.',
    params: {},
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Bring that cut back' }],
    run: async (args, ctx) => (await ctx.craft(APP)).execute('edit.redo', {}), // commands.rs:2114 edit.redo
  },
  {
    name: 'filmcraft.batch',
    purpose: 'Run several commands in order; stops at the first error.',
    when: 'Use when several timeline edits should happen in one go.',
    params: {
      commands: { type: 'list', required: true, description: 'One command per item: the id then key=value params, e.g. playhead.set seconds=3.5' },
      stop_on_error: { type: 'boolean', description: 'Stop at the first error (default true)' },
    },
    effect: 'change',
    effectFor: args => (DESTRUCTIVE.some(id => (args.commands ?? []).some(line => String(line ?? '').trim().startsWith(id))) ? 'destructive' : 'change'),
    needs: NEEDS,
    examples: [{ args: { commands: ['playhead.set seconds=3.5', 'timeline.razor track=V1'] }, says: 'Cut at 3.5 seconds on V1' }],
    // server.rs:375-398: N sequential runs, stop on error by default; each edit is its own
    // undo step; returns {completed, failed, results: [{ok, result | error}]}
    run: async (args, ctx) => {
      const app = await ctx.craft(APP);
      let completed = 0;
      let failed = 0;
      const results = [];
      for (const line of args.commands) {
        const step = parseStep(line);
        if (!step) continue;
        try {
          const result = await app.execute(step.command, step.params);
          completed += 1;
          results.push({ ok: true, result });
        } catch (error) {
          failed += 1;
          results.push({ ok: false, error: error instanceof Error ? error.message : String(error) });
          if (args.stop_on_error ?? true) break;
        }
      }
      return { completed, failed, results };
    },
  },
  {
    name: 'filmcraft.list_commands',
    purpose: 'Find editing commands by a word in the id, label or menu.',
    when: 'Use when the user wants an action and its command id is unknown.',
    params: { query: { type: 'string', description: 'Substring of the command id, label or menu path; omit to list the first 10' } },
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: { query: 'razor' }, says: 'Which command cuts a clip?' }],
    // server.rs:341-359 upstream runs the engine command command.list; the page's commands()
    // (the engine.commands control method, ui-egui control.rs:504) runs that same command and
    // is cached by the adapter, so the pack uses it like the other packs
    run: async (args, ctx) => {
      const all = await (await ctx.craft(APP)).commands();
      const q = String(args.query ?? '').trim().toLowerCase();
      return all.filter(command => !q || [command.id, command.label, command.menu].some(part => String(part ?? '').toLowerCase().includes(q)))
        .slice(0, 10).map(command => ({ id: command.id, label: command.label, menu: command.menu, params: command.params, enabled: command.enabled }));
    },
  },
  {
    name: 'filmcraft.run_command',
    purpose: 'Run any FilmCraft command by id with parameters.',
    when: `Use when a menu action is wanted by id; ${DESTRUCTIVE.join(', ')} are destructive, so ask first.`,
    params: {
      command: { type: 'string', required: true, description: 'Command id from filmcraft.list_commands, e.g. timeline.razor, effects.apply, playhead.set' },
      params: { type: 'text', description: 'Parameters as key=value lines, one per line; a [ ... ] or { ... } value is JSON; omit for the defaults' },
    },
    effect: 'change',
    effectFor: args => (DESTRUCTIVE.some(prefix => String(args.command ?? '').startsWith(prefix)) ? 'destructive' : 'change'),
    needs: NEEDS,
    examples: [{ args: { command: 'playhead.set', params: 'seconds=2' }, says: 'Jump the playhead to 2 seconds' }],
    // server.rs:366 command_run: run(id, params) against the live command list; unknown ids get
    // invalid_argument with the 3 closest
    run: async (args, ctx) => {
      const app = await ctx.craft(APP);
      const all = await app.commands();
      if (!all.some(command => command.id === args.command)) {
        const near = closest(args.command, all.map(command => command.id), 3);
        const fix = near.length > 0 ? callLine('filmcraft.run_command', { command: near[0] }) : '';
        throw new ToolError('invalid_argument', `unknown command "${args.command}"${near.length > 0 ? `; closest: ${near.join(', ')}` : ''}`, fix);
      }
      return app.execute(args.command, parseParams(args.params));
    },
  },
  {
    name: 'filmcraft.open_file',
    purpose: 'Open a project or import media from Files into FilmCraft.',
    when: 'Use when the user wants to open a project stored in Files, or import video, audio or stills.',
    params: { path: { type: 'path', required: true, description: 'The Files path of the project or media, e.g. /FilmCraft/talk.fcproj' } },
    effect: 'destructive',
    needs: ['host', 'app:filmcraft', 'files'],
    examples: [{ args: { path: '/FilmCraft/talk.fcproj' }, says: 'Open the talk project from Files' }],
    // Drives the wrapper's own #file input (app.mjs:38), so the open posts from the wrapper
    // realm, as the page's host bridge requires. A .fcproj is opened as the project, which
    // replaces the open one (the web app holds a single project; engine commands.rs
    // install_project clean=true), so this is destructive; media is imported like a dropped
    // file. The wrapper's own unsaved-changes confirm still applies (app.mjs:35).
    // openAndAwait waits until the page's inspect changes, so the result confirms the load.
    run: async (args, ctx) => {
      const file = await filesCall(ctx, files => files.readBytes(args.path));
      const wrapper = await ctx.host.appWindow(APP);
      const craft = await ctx.craft(APP);
      return openAndAwait(craft, { id: APP, title: 'FilmCraft', wrapperWindow: wrapper, name: file.name, bytes: file.bytes, accept: releases[APP].accept });
    },
  },
  {
    name: 'filmcraft.save_copy',
    purpose: 'Save the active project as a .fcproj file in Files.',
    when: 'Use when the user wants to keep a copy of the project in Files.',
    params: {
      path: { type: 'path', required: true, description: 'The Files path to write the copy to, e.g. /FilmCraft/talk.fcproj' },
      overwrite: { type: 'boolean', description: 'Replace the file when the path already exists; false when omitted' },
    },
    effect: 'change',
    effectFor: args => (args.overwrite ? 'destructive' : 'change'),
    needs: ['host', 'app:filmcraft', 'files'],
    examples: [{ args: { path: '/FilmCraft/talk.fcproj' }, says: 'Save a copy of the project to Files' }],
    // No path is ever passed (the browser has no file system). FilmCraft has no file.saveBytes,
    // so the no-path file.save {} (engine commands.rs:1981) is the trigger: it saves the
    // project under its own name, and in host mode the page hands the bytes to the wrapper
    // (filmcraft-web host.rs wrote/flush_saves), which the saveCopy capture reads as
    // filmcraft:save (app.mjs:29-33) and also downloads in the browser, so the result says so.
    // A fresh project with no saved path yet makes the app refuse ("no path (use Save As)"),
    // which surfaces as the tool error. The bytes are the native .fcproj format, so a target
    // with another extension is refused with a fix.
    run: async (args, ctx) => {
      const wrapper = await ctx.host.appWindow(APP);
      const craft = await ctx.craft(APP);
      const save = await saveBytesCopy(craft, {
        id: APP, title: 'FilmCraft', wrapperWindow: wrapper, target: args.path,
        tool: 'filmcraft.save_copy', nativeExt: '.fcproj',
      });
      const written = await filesCall(
        ctx,
        files => files.writeBytes(args.path, save.bytes, { overwrite: Boolean(args.overwrite) }),
        error => (error.code === 'exists' ? callLine('filmcraft.save_copy', { path: args.path, overwrite: true }) : ''),
      );
      return { path: written.path, name: save.name, size: written.size, created: written.created, ...(save.note ? { note: save.note } : {}) };
    },
  },
];

// Live-check exports (brief): every command id the pack passes to execute (timeline.place and
// timeline.move are internal commands outside the command.list registry, run by their
// dedicated tools only) and every control method passed to request. batch and run_command also
// pass arbitrary ids from the live commands() list.
export const usesCommands = [
  'project.inspect', 'sequence.inspect', 'playhead.set', 'timeline.razor', 'sequence.addEdit',
  'timeline.place', 'timeline.move', 'effects.apply', 'effects.list', 'file.newBin',
  'file.newProject', 'file.openDemoProject', 'file.save', 'edit.undo', 'edit.redo',
];
export const usesMethods = []; // nothing goes through request(); ui_inspect uses the adapter inspect()
