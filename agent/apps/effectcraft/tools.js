// Ported from storytold/effectcraft@v0.24.1 crates/automation/src/tools.rs (the tool
// catalogue and dispatch bodies). Tool names, descriptions and the control-method mapping
// follow those tables; arguments are flattened for small models.
// The tools run in Buddy's frame and drive the EffectCraft page API through ctx.craft, which
// the runtime wires as id => craftApi(await ctx.host.appWindow(id), id) (plan 9). The page
// (public/pc/vendor/effectcraft/index.html) installs request/execute/commands/inspect/
// screenshot, with inspect the page's own ui.inspect.
import { ToolError, callLine, closest } from '../../../src/apps/ai-agent/runtime/args.mjs';
import { filesCall, openAndAwait, saveBytesCopy } from '../../shared/craft-files.js';
import { releases } from '../../../scripts/pc/craft/releases.mjs';

const APP = 'effectcraft';
const NEEDS = ['host', 'app:effectcraft'];
// run_command/batch ids that destroy or replace data, from the engine command registry
// (grep of the cmd! ids in crates/engine/src/cmd): effectFor marks those calls destructive,
// so the policy asks. file.newProject and file.openDemoProject replace the open project
// (the web app holds one project), so they are destructive though the registry does not flag
// them.
const DESTRUCTIVE = [
  'file.newProject', 'file.openDemoProject', 'file.close', 'file.revert',
  'edit.clear', 'edit.purge', 'keys.delete', 'markers.delete',
  'track.delete', 'track.reset', 'effect.remove', 'effect.reset', 'essential.remove',
  'layer.mask.remove', 'layer.style.remove', 'mask.remove', 'storage.clear', 'templates.delete',
];

/** tools.rs obj(): copy the listed keys (when present and not null) into a params object. */
const pick = (args, keys) => {
  const out = {};
  for (const key of keys) if (args[key] !== undefined && args[key] !== null) out[key] = args[key];
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

// A layer tree property subtree -> [{path, type, value, ...}] (tools.rs flatten).
const flatten = node => {
  if (node?.truncated === true) return [{ path: node.path, type: 'group', name: node.name, truncated: true }];
  if (Array.isArray(node?.children)) return node.children.flatMap(flatten);
  const out = { path: node.path, type: node.type, value: node.value };
  if (Array.isArray(node?.keys)) out.keys = node.keys.length;
  if (node?.expression !== undefined) out.expression = node.expression;
  if (node?.options !== undefined) out.options = node.options;
  return [out];
};

// The `effects` group of a layer.tree reply (tools.rs effects_group).
const effectsChildren = tree => tree?.properties?.children?.find(child => child.path === 'effects')?.children ?? null;

export const pack = { id: APP, title: 'EffectCraft' };

export const tools = [
  {
    name: 'effectcraft.inspect',
    purpose: 'Show the project overview and the active composition.',
    when: 'Use when the user asks what is in the project, or before planning edits.',
    params: {},
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: {}, says: 'What is in this project?' }],
    // tools.rs:1006 doc_inspect: project.summary + comp.info (null when no comp is active)
    run: async (args, ctx) => {
      const app = await ctx.craft(APP);
      const project = await app.execute('project.summary', {});
      let activeComp = null;
      try {
        activeComp = await app.execute('comp.info', {});
      } catch { /* doc_inspect swallows this: the comp is null */ }
      return { project, activeComp };
    },
  },
  {
    name: 'effectcraft.project',
    purpose: 'Show the project summary: comps, items, paths, undo history.',
    when: 'Use when the user asks what compositions and items exist.',
    params: {},
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: {}, says: 'List the compositions' }],
    // tools.rs:280 get_project: project.summary
    run: async (args, ctx) => (await ctx.craft(APP)).execute('project.summary', {}),
  },
  {
    name: 'effectcraft.comp',
    purpose: 'Show a composition: size, duration, frame rate, layers with ids.',
    when: 'Use when the user asks about a comp, or before editing its layers.',
    params: { comp: { type: 'string', description: 'Composition id or name; the active comp when omitted' } },
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Tell me about the active comp' }],
    // tools.rs:284 get_comp: comp.info
    run: async (args, ctx) => (await ctx.craft(APP)).execute('comp.info', pick(args, ['comp'])),
  },
  {
    name: 'effectcraft.layer',
    purpose: 'Show a layer tree: properties with paths to read and set.',
    when: 'Use when the user asks what a layer has, or for property paths.',
    params: {
      layer: { type: 'string', required: true, description: 'Layer id (from effectcraft.comp), #n (1-based) or layer name' },
      comp: { type: 'string', description: 'Composition id or name; the active comp when omitted' },
      depth: { type: 'integer', description: 'Property tree depth' },
      time: { type: 'number', description: 'Comp time in seconds (values at that time)' },
    },
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: { layer: '1' }, says: 'What properties does layer 1 have?' }],
    // tools.rs:313 get_layer: layer.tree; the flat client-side list is omitted (report)
    run: async (args, ctx) => (await ctx.craft(APP)).execute('layer.tree', pick(args, ['layer', 'comp', 'depth', 'time'])),
  },
  {
    name: 'effectcraft.property_get',
    purpose: 'Read one property value at a layer and path.',
    when: 'Use when the user asks for a specific property value.',
    params: {
      layer: { type: 'string', required: true, description: 'Layer id, #n or name' },
      path: { type: 'string', required: true, description: 'Property path from effectcraft.layer, e.g. transform/opacity, effects/#1/blurriness' },
      comp: { type: 'string', description: 'Composition id or name; the active comp when omitted' },
      time: { type: 'number', description: 'Comp time in seconds' },
    },
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: { layer: '1', path: 'transform/opacity' }, says: 'What is the opacity?' }],
    // tools.rs:324 get_property: prop.get
    run: async (args, ctx) => (await ctx.craft(APP)).execute('prop.get', pick(args, ['layer', 'path', 'comp', 'time'])),
  },
  {
    name: 'effectcraft.property_set',
    purpose: 'Set a property value or expression (or keyframe it at a time).',
    when: 'Use when the user wants a property changed, e.g. opacity, position, color.',
    params: {
      layer: { type: 'string', required: true, description: 'Layer id, #n or name' },
      path: { type: 'string', required: true, description: 'Property path from effectcraft.layer' },
      value: { type: 'text', description: 'Number for 1-D properties, a [ ... ] JSON array for vectors, a #rrggbb color or [r,g,b,a]; as text' },
      expression: { type: 'string', description: 'Expression text; empty string removes the expression' },
      comp: { type: 'string', description: 'Composition id or name; the active comp when omitted' },
      time: { type: 'number', description: 'Keyframe the value at this comp time in seconds instead of setting it' },
      timeBase: { type: 'string', description: 'What time counts: layer (default) or comp' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { layer: '1', path: 'transform/opacity', value: '50' }, says: 'Set layer 1 opacity to 50' }],
    // tools.rs:329 set_property: value -> prop.set (or prop.addKey with time), expression ->
    // prop.setExpression, then prop.get to read the result back
    run: async (args, ctx) => {
      const app = await ctx.craft(APP);
      if (args.value === undefined && args.expression === undefined) {
        throw new ToolError('invalid_argument', 'give value and/or expression', '');
      }
      const base = pick(args, ['layer', 'path', 'comp']);
      const jsonValue = () => {
        if (args.value === undefined) return undefined;
        try { return JSON.parse(args.value); } catch { return args.value; }
      };
      if (args.value !== undefined) {
        const params = { ...base, value: jsonValue() };
        if (args.time !== undefined) {
          params.time = args.time;
          if (args.timeBase !== undefined) params.timeBase = args.timeBase;
          await app.execute('prop.addKey', params);
        } else {
          await app.execute('prop.set', params);
        }
      }
      if (args.expression !== undefined) {
        await app.execute('prop.setExpression', { ...base, expression: args.expression });
      }
      return app.execute('prop.get', { ...base, ...(args.time !== undefined ? { time: args.time } : {}) });
    },
  },
  {
    name: 'effectcraft.keyframe_add',
    purpose: 'Add one or more keyframes to a property.',
    when: 'Use when the user wants a property animated over time.',
    params: {
      layer: { type: 'string', required: true, description: 'Layer id, #n or name' },
      path: { type: 'string', required: true, description: 'Property path from effectcraft.layer' },
      keys: { type: 'text', description: 'JSON array of {time, value?}, one per keyframe; time in seconds (layer time)' },
      comp: { type: 'string', description: 'Composition id or name; the active comp when omitted' },
      timeBase: { type: 'string', description: 'What the key times count: layer (default) or comp' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { layer: '1', path: 'transform/opacity', keys: '[{"time":0,"value":0},{"time":1,"value":100}]' }, says: 'Fade layer 1 in over one second' }],
    // tools.rs:360 add_keyframe: one prop.addKey per key, then prop.get; the interpolation
    // follow-up (keys.select + keys.interpolation) is omitted (report)
    run: async (args, ctx) => {
      let keys;
      try {
        keys = JSON.parse(args.keys);
      } catch {
        throw new ToolError('invalid_argument', 'keys must be a JSON array of {time, value?}', '');
      }
      if (!Array.isArray(keys) || keys.length === 0) {
        throw new ToolError('invalid_argument', 'keys needs at least one {time, value?}', '');
      }
      const app = await ctx.craft(APP);
      const base = pick(args, ['layer', 'path', 'comp']);
      for (const key of keys) {
        if (key?.time === undefined) throw new ToolError('invalid_argument', 'each key needs a time', '');
        const params = { ...base, time: key.time };
        if (key.value !== undefined) params.value = key.value;
        if (args.timeBase !== undefined) params.timeBase = args.timeBase;
        await app.execute('prop.addKey', params);
      }
      return app.execute('prop.get', base);
    },
  },
  {
    name: 'effectcraft.effect_add',
    purpose: 'Add an effect to a layer, with parameter values, in one undo step.',
    when: 'Use when the user wants an effect (blur, glow, color, ...) on a layer.',
    params: {
      layer: { type: 'string', required: true, description: 'Layer id, #n or name' },
      effect: { type: 'string', required: true, description: 'Effect id or name, e.g. Gaussian Blur, Glow, ec.color.levels' },
      values: { type: 'text', description: 'JSON object of parameter id to value, e.g. {"blurriness":12}' },
      comp: { type: 'string', description: 'Composition id or name; the active comp when omitted' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { layer: '1', effect: 'Gaussian Blur', values: '{"blurriness":12}' }, says: 'Blur layer 1' }],
    // tools.rs:228 add_effect: layer.tree for the index, then ONE engine.batch of effect.apply
    // plus prop.set per value (one undo step, labelled "Apply <name>"), then layer.tree for
    // the new instance's name and params
    run: async (args, ctx) => {
      const app = await ctx.craft(APP);
      const base = pick(args, ['layer', 'comp']);
      const before = await app.execute('layer.tree', base);
      const index = (effectsChildren(before)?.length ?? 0) + 1;
      const steps = [{ command: 'effect.apply', params: { effect: args.effect, layers: [args.layer], ...(args.comp !== undefined ? { comp: args.comp } : {}) } }];
      let values = {};
      if (args.values !== undefined) {
        try {
          values = JSON.parse(args.values);
        } catch {
          throw new ToolError('invalid_argument', 'values must be a JSON object of parameter id to value', '');
        }
        const prefix = `effects/#${index}`;
        for (const [key, value] of Object.entries(values)) {
          steps.push({ command: 'prop.set', params: { layer: args.layer, ...(args.comp !== undefined ? { comp: args.comp } : {}), path: `${prefix}/${key}`, value } });
        }
      }
      await app.execute('engine.batch', { steps, label: `Apply ${args.effect}` });
      const tree = await app.execute('layer.tree', base);
      const children = effectsChildren(tree);
      const inst = children?.[index - 1];
      const out = { layer: tree?.id, index, path: `effects/#${index}`, set: Object.keys(values) };
      if (inst) {
        out.name = inst.name;
        out.params = flatten(inst);
      }
      return out;
    },
  },
  {
    name: 'effectcraft.effects_list',
    purpose: 'List the effect registry: ids, names, categories, parameters.',
    when: 'Use when the user asks what effects exist, or before adding one.',
    params: { filter: { type: 'string', description: 'Only effects whose id or name contains this text' } },
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: { filter: 'blur' }, says: 'What blur effects are there?' }],
    // tools.rs:214 list_effects: effect.list (the compact flag is omitted: the model gets the
    // full registry rows)
    run: async (args, ctx) => (await ctx.craft(APP)).execute('effect.list', pick(args, ['filter'])),
  },
  {
    name: 'effectcraft.fonts_list',
    purpose: 'List the fonts the app can use, optionally filtered.',
    when: 'Use when the user asks what fonts are available.',
    params: { query: { type: 'string', description: 'Substring of the font name' } },
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: { query: 'mono' }, says: 'List monospace fonts' }],
    // tools.rs:222 list_fonts: text.fonts (variable/rescan are omitted: web fonts are the app set)
    run: async (args, ctx) => (await ctx.craft(APP)).execute('text.fonts', pick(args, ['query'])),
  },
  {
    name: 'effectcraft.state',
    purpose: 'Show the editor state and the app capabilities.',
    when: 'Use when the user asks what the app can do right now.',
    params: {},
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: {}, says: 'What can the app do?' }],
    // tools.rs:265 get_state: editor.state + app.capabilities
    run: async (args, ctx) => {
      const app = await ctx.craft(APP);
      const [state, app2] = await Promise.all([app.execute('editor.state', {}), app.execute('app.capabilities', {})]);
      return { state, app: app2 };
    },
  },
  {
    name: 'effectcraft.script_run',
    purpose: 'Run a JavaScript script against the project.',
    when: 'Use when the user wants a scripted bulk edit.',
    params: {
      code: { type: 'text', required: true, description: 'JavaScript code (the app exposes the project API to it)' },
      name: { type: 'string', description: 'Script name used in error messages (default script)' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { code: 'comp.layers.forEach(l => l.opacity = 50)' }, says: 'Dim every layer of the active comp' }],
    // tools.rs:271 run_script: script.run
    run: async (args, ctx) => (await ctx.craft(APP)).execute('script.run', pick(args, ['code', 'name'])),
  },
  {
    name: 'effectcraft.project_open',
    purpose: 'Open the demo project, or start a new empty one (replaces the open one).',
    when: 'Use when the user wants the demo project or to start over.',
    params: {
      demo: { type: 'boolean', description: 'Open the built-in demo project' },
      new: { type: 'boolean', description: 'Start a new empty project' },
    },
    effect: 'destructive',
    needs: NEEDS,
    examples: [{ args: { demo: true }, says: 'Open the demo project' }],
    // tools.rs:426 open_project: demo -> file.openDemoProject, new -> file.newProject, then
    // project.summary; the path variant (file.open) is omitted (web has no file paths). Both
    // are destructive: the web app holds one project, so this replaces the open one
    run: async (args, ctx) => {
      const app = await ctx.craft(APP);
      if (args.demo === true) await app.execute('file.openDemoProject', {});
      else if (args.new === true) await app.execute('file.newProject', {});
      else throw new ToolError('invalid_argument', 'give demo: true or new: true', '');
      return app.execute('project.summary', {});
    },
  },
  {
    name: 'effectcraft.project_save',
    purpose: 'Save the project (in place).',
    when: 'Use when the user wants to save the work.',
    params: {},
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Save the project' }],
    // tools.rs:439 save_project: file.save (in place; the saveAs path variant is omitted), then
    // project.summary -> {path, dirty}
    run: async (args, ctx) => {
      const app = await ctx.craft(APP);
      await app.execute('file.save', {});
      const summary = await app.execute('project.summary', {});
      return { path: summary?.path, dirty: summary?.dirty };
    },
  },
  {
    name: 'effectcraft.undo',
    purpose: 'Undo one or more of the last changes.',
    when: 'Use when the user wants to undo the last change.',
    params: { steps: { type: 'integer', description: 'How many steps to undo (default 1)' } },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Undo that' }],
    // tools.rs:448 history + :462 undo: N x edit.undo, stopping when one fails, then
    // project.summary -> {steps, undoStack}
    run: async (args, ctx) => {
      const app = await ctx.craft(APP);
      const steps = Math.max(1, Math.round(args.steps ?? 1));
      let done = 0;
      for (let i = 0; i < steps; i++) {
        try {
          await app.execute('edit.undo', {});
          done += 1;
        } catch (error) {
          if (done === 0) throw new ToolError('app_error', error instanceof Error ? error.message : String(error), '');
          break;
        }
      }
      const summary = await app.execute('project.summary', {});
      return { steps: done, undoStack: summary?.undo };
    },
  },
  {
    name: 'effectcraft.redo',
    purpose: 'Redo one or more of the last undone changes.',
    when: 'Use when the user wants to redo the change they just undid.',
    params: { steps: { type: 'integer', description: 'How many steps to redo (default 1)' } },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Bring that back' }],
    // tools.rs:467 redo: N x edit.redo, same shape as undo
    run: async (args, ctx) => {
      const app = await ctx.craft(APP);
      const steps = Math.max(1, Math.round(args.steps ?? 1));
      let done = 0;
      for (let i = 0; i < steps; i++) {
        try {
          await app.execute('edit.redo', {});
          done += 1;
        } catch (error) {
          if (done === 0) throw new ToolError('app_error', error instanceof Error ? error.message : String(error), '');
          break;
        }
      }
      const summary = await app.execute('project.summary', {});
      return { steps: done, undoStack: summary?.undo };
    },
  },
  {
    name: 'effectcraft.history',
    purpose: 'List the undo/redo history, optionally jump to a state.',
    when: 'Use when the user asks what happened, or wants to jump back.',
    params: { goto: { type: 'string', description: 'State index or id to jump to (edit.history.goto)' } },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Show the edit history' }],
    // tools.rs:484 history_tool: goto -> edit.history.goto {id or index}, then
    // edit.history.list
    run: async (args, ctx) => {
      const app = await ctx.craft(APP);
      if (args.goto !== undefined) {
        const params = /^-?\d+$/.test(String(args.goto)) ? { index: Number(args.goto) } : { id: String(args.goto) };
        await app.execute('edit.history.goto', params);
      }
      return app.execute('edit.history.list', {});
    },
  },
  {
    name: 'effectcraft.batch',
    purpose: 'Run several commands as one undo step (atomic by default).',
    when: 'Use when several edits should land as a single undo step.',
    params: {
      steps: { type: 'text', required: true, description: 'JSON array of {command, params?}, e.g. [{"command":"layer.newText","params":{"name":"Title"}}]' },
      label: { type: 'string', description: 'Undo step name (default Batch)' },
      atomic: { type: 'boolean', description: 'Roll everything back when a step fails (default true)' },
    },
    effect: 'change',
    effectFor: args => {
      let steps = args.steps;
      if (typeof steps === 'string') { try { steps = JSON.parse(steps); } catch { return 'change'; } }
      return (Array.isArray(steps) ? steps : []).some(step => DESTRUCTIVE.some(id => String(step?.command ?? '').startsWith(id))) ? 'destructive' : 'change';
    },
    needs: NEEDS,
    examples: [{ args: { steps: '[{"command":"comp.new","params":{"name":"Titles","width":1920,"height":1080}}]' }, says: 'Create a Titles comp' }],
    // tools.rs:496 batch_tool: ONE engine.batch {steps, label?, atomic?} (the engine applies the
    // atomic default; engine.batch cannot nest itself, engine/cmd/batch.rs:14)
    run: async (args, ctx) => {
      let steps;
      try {
        steps = JSON.parse(args.steps);
      } catch {
        throw new ToolError('invalid_argument', 'steps must be a JSON array of {command, params?}', '');
      }
      if (!Array.isArray(steps) || steps.length === 0 || steps.some(step => typeof step?.command !== 'string')) {
        throw new ToolError('invalid_argument', 'steps must be a non-empty JSON array of {command, params?}', '');
      }
      return (await ctx.craft(APP)).execute('engine.batch', { steps, ...pick(args, ['label', 'atomic']) });
    },
  },
  {
    name: 'effectcraft.list_commands',
    purpose: 'Find commands by a word in the id, label or menu.',
    when: 'Use when the user wants an action and its command id is unknown.',
    params: { query: { type: 'string', description: 'Substring of the command id, label or menu path; omit to list the first 10' } },
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: { query: 'layer.new' }, says: 'Which commands create layers?' }],
    // tools.rs:179 list_commands runs the engine command command.list; the page's commands()
    // (the engine.commands control method, ui-egui control.rs:236) runs that same command and
    // is cached by the adapter, so the pack uses it like the other packs
    run: async (args, ctx) => {
      const all = await (await ctx.craft(APP)).commands();
      const q = String(args.query ?? '').trim().toLowerCase();
      return all.filter(command => !q || [command.id, command.label, command.menu].some(part => String(part ?? '').toLowerCase().includes(q)))
        .slice(0, 10).map(command => ({ id: command.id, label: command.label, menu: command.menu, params: command.params, enabled: command.enabled }));
    },
  },
  {
    name: 'effectcraft.run_command',
    purpose: 'Run any EffectCraft command by id with parameters.',
    when: `Use when a menu action is wanted by id; ${DESTRUCTIVE.join(', ')} are destructive, so ask first.`,
    params: {
      command: { type: 'string', required: true, description: 'Command id from effectcraft.list_commands, e.g. comp.new, layer.newText, prop.set' },
      params: { type: 'text', description: 'Parameters as key=value lines, one per line; a [ ... ] or { ... } value is JSON; omit for the defaults' },
    },
    effect: 'change',
    effectFor: args => (DESTRUCTIVE.some(prefix => String(args.command ?? '').startsWith(prefix)) ? 'destructive' : 'change'),
    needs: NEEDS,
    examples: [{ args: { command: 'time.set', params: 'seconds=5' }, says: 'Jump to 5 seconds' }],
    // tools.rs:202 execute_command: run(id, params) against the live command list; unknown ids
    // get invalid_argument with the 3 closest. The command_list/command_run aliases
    // (:937/:954) and the sequential command_batch (:986) are deduped here; describe_command
    // (:576) is the registry query command.describe, reachable as run_command
    run: async (args, ctx) => {
      const app = await ctx.craft(APP);
      const all = await app.commands();
      if (!all.some(command => command.id === args.command)) {
        const near = closest(args.command, all.map(command => command.id), 3);
        const fix = near.length > 0 ? callLine('effectcraft.run_command', { command: near[0] }) : '';
        throw new ToolError('invalid_argument', `unknown command "${args.command}"${near.length > 0 ? `; closest: ${near.join(', ')}` : ''}`, fix);
      }
      return app.execute(args.command, parseParams(args.params));
    },
  },
  {
    name: 'effectcraft.open_file',
    purpose: 'Open a project or import media from Files into EffectCraft.',
    when: 'Use when the user wants to open a project stored in Files, or import video, audio or images.',
    params: { path: { type: 'path', required: true, description: 'The Files path of the project or media, e.g. /EffectCraft/ad.ecproj' } },
    effect: 'destructive',
    needs: ['host', 'app:effectcraft', 'files'],
    examples: [{ args: { path: '/EffectCraft/ad.ecproj' }, says: 'Open the ad project from Files' }],
    // EffectCraft is a standalone wrapper (releases.mjs), so the open rides the bootstrap's
    // open path: drive the wrapper's own #file input (app.mjs:38) so the wrapper posts
    // effectcraft:open (app.mjs:35-36) and the bootstrap (bootstrap.js:52-89, openMethod
    // addFile) hands the bytes to window.effectcraft.addFile, which opens a .ecproj or
    // imports media. Opening a project replaces the open one (the web app holds one project),
    // so this is destructive. openAndAwait waits until the page's inspect changes.
    run: async (args, ctx) => {
      const file = await filesCall(ctx, files => files.readBytes(args.path));
      const wrapper = await ctx.host.appWindow(APP);
      const craft = await ctx.craft(APP);
      return openAndAwait(craft, { id: APP, title: 'EffectCraft', wrapperWindow: wrapper, name: file.name, bytes: file.bytes, accept: releases[APP].accept });
    },
  },
  {
    name: 'effectcraft.save_copy',
    purpose: 'Save the active project as a .ecproj file in Files.',
    when: 'Use when the user wants to keep a copy of the project in Files.',
    params: {
      path: { type: 'path', required: true, description: 'The Files path to write the copy to, e.g. /EffectCraft/ad.ecproj' },
      overwrite: { type: 'boolean', description: 'Replace the file when the path already exists; false when omitted' },
    },
    effect: 'change',
    effectFor: args => (args.overwrite ? 'destructive' : 'change'),
    needs: ['host', 'app:effectcraft', 'files'],
    examples: [{ args: { path: '/EffectCraft/ad.ecproj' }, says: 'Save a copy of the project to Files' }],
    // No path is ever passed (the browser has no file system). EffectCraft has no file.saveBytes,
    // so the no-path file.save {} (engine cmd/file.rs:793) is the trigger; in standalone mode the
    // app's own download is captured by the bootstrap's anchor-click hook (bootstrap.js:92-98,
    // nativeSource .ecproj) and posted to the wrapper as effectcraft:save (app.mjs:29-33), which
    // the saveCopy capture reads. The bytes are the native .ecproj format, so a target with
    // another extension is refused with a fix. A fresh project with no saved path yet makes the
    // app refuse ("no path: use file.saveAs {path}"), which surfaces as the tool error.
    run: async (args, ctx) => {
      const wrapper = await ctx.host.appWindow(APP);
      const craft = await ctx.craft(APP);
      const save = await saveBytesCopy(craft, {
        id: APP, title: 'EffectCraft', wrapperWindow: wrapper, target: args.path,
        tool: 'effectcraft.save_copy', nativeExt: '.ecproj',
      });
      const written = await filesCall(
        ctx,
        files => files.writeBytes(args.path, save.bytes, { overwrite: Boolean(args.overwrite) }),
        error => (error.code === 'exists' ? callLine('effectcraft.save_copy', { path: args.path, overwrite: true }) : ''),
      );
      return { path: written.path, name: save.name, size: written.size, created: written.created, ...(save.note ? { note: save.note } : {}) };
    },
  },
];

// Live-check exports (brief): every command id the pack passes to execute (the fixed ids of
// the effect_add batch included) and every control method passed to request. batch and
// run_command also pass arbitrary ids from the live commands() list.
export const usesCommands = [
  'project.summary', 'comp.info', 'layer.tree', 'prop.get', 'prop.set', 'prop.addKey', 'prop.setExpression',
  'engine.batch', 'effect.apply', 'effect.list', 'text.fonts', 'editor.state', 'app.capabilities',
  'script.run', 'file.openDemoProject', 'file.newProject', 'file.save',
  'edit.undo', 'edit.redo', 'edit.history.goto', 'edit.history.list',
];
export const usesMethods = []; // nothing goes through request(); the page inspect() is not used (the packs read via engine queries)
