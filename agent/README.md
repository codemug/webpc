# Buddy app packs

How Buddy's tools and skills are built, and how to add a pack for an app.
Every pack is plain ES modules that run in the browser and in Node, so the
unit tests need no browser. The build reads the packs; nothing here is a page.

## Layout

- `agent/system/`, `agent/desktop/`, `agent/files/`: the core packs, always on.
  The desktop pack drives `window.pcHost` (the desktop installed by
  `src/scripts/pc/desktop.js`), the files pack the Files store.
- `agent/apps/<id>/tools.js`: the pack for one catalog app, included only when
  the app has `enabled: true` in `catalog.yaml`.
- `agent/apps/<id>/skills.md`: the skills the wiki serves for that app.
- `agent/shared/`: helpers the packs share, such as `craft.js` (the Craft page
  protocol), `inner-app.js` (digging into an app's iframe) and `craft-files.js`
  (the Files open path).

The build is `npm run catalog`, which runs `scripts/catalog/catalog.mjs` (validates
`catalog.yaml` and writes the desktop registry) and then `scripts/agent/build.mjs`
(validates the packs and writes `src/apps/ai-agent/generated/`). For each pack it
checks that `tools.js` exports `pack = { id }` matching its directory, that every
tool has a `run` function and a non-empty `purpose` and `when`, that the param
specs are flat and well-formed, that every `examples` entry passes arg checking,
and that every `call_tool` line in a skill's Steps passes `checkArgs` against the
tool's real params. It writes `catalog.json` (the tool catalog), `skills.json`,
`search-tools.json` and `search-skills.json` (the search indexes), `packs.mjs`
(lazy imports of each pack) and `INDEX.md`. The generated directory is gitignored;
commit nothing from it. Run the build after changing a pack.

## The tool spec (tools.js)

```js
{
  name: 'desktop.open_app',
  purpose: 'Start an app on the desktop.',
  when: 'Use when the user says start, launch or open, naming an app such as Files or GridCraft.',
  params: { app: APP },
  effect: 'change',
  needs: ['host'],
  examples: [{ args: { app: 'gridcraft' }, says: 'Launch GridCraft' }],
  run: async (args, ctx) => call(ctx, host => host.open(args.app)),
},
```

- `name`: `<pack>.<verb_noun>`, unique across all packs.
- `purpose`: one line, what the tool does.
- `when`: starts with "Use when", at most 120 characters: the user phrasings that
  should reach this tool.
- `params`: a flat object of param specs. Each has a `type` (one of the types in
  `src/apps/ai-agent/runtime/args.mjs` TYPES: `string`, `text`, `integer`,
  `number`, `boolean`, `enum`, `list`, `table`, `path`), a `description`, and
  optionally `required`, `values` (for `enum`, or the live `apps` list),
  `default`, `min`, `max`. In the excerpt, `APP` is the pack's shared
  `{ type: 'enum', values: 'apps', ... }` spec for an app id.
- `effect`: `read`, `change`, `destructive` or `external`. The policy allows
  every effect without asking; the only remaining guardrail is the cloud
  Files grant rule (a cloud model may only touch granted folders).
- `effectFor` (optional): a function of the args that returns the effective
  effect, for a tool whose danger depends on an argument. The GridCraft pack
  marks `file.new` and `sheet.delete` destructive this way.
- `needs` (optional): the capabilities the runtime must provide (`host`,
  `files`, `app:<id>`), so the tool is a clean not_available error outside WebPC.
- `examples`: args a user utterance would produce, with the utterance in `says`.
  The build validates them against the params.
- `run(args, ctx)`: the body. `ctx.host` is `window.pcHost`, `ctx.files` is the
  Files store behind the access policy, and `ctx.craft(id)` is the app's page
  API, opened if needed.

## Teaching errors

Wrap every failure the model can fix in a ToolError:
`new ToolError(type, message, fix)`, where `fix` is one call line the model can
copy (the signature is in `src/apps/ai-agent/runtime/args.mjs`). Small models
copy call lines. A generic error makes them guess and loop. The open_file
not_found teaching error in `agent/shared/craft-files.js`:

```js
throw new ToolError('not_found',
  `${path} is not in Files. To open ${title} itself, use desktop.open_app; to open a file, find it first with files.find.`,
  `call_tool tool=desktop.open_app app=${id}`);
```

The message says both ways out; the fix line points the model at the tool that
opens the app itself.

## skills.md

One `## ` block per skill. Before the first section come four metadata lines
(all required, and the slug must be unique, lowercase words with hyphens):

```md
## Open a file from Files
slug: open-a-file-from-files
summary: Open audio, MIDI or a session that is stored in Files in SoundCraft.
keywords: open, load, from files, audio, midi, session, scraftz, import
tools: desktop.open_app, soundcraft.open_file

When: the user wants to open audio, MIDI or a SoundCraft session that is stored in Files.
Steps:
1. call_tool tool=desktop.open_app app=soundcraft
2. call_tool tool=soundcraft.open_file path=/SoundCraft/session.scraftz
Check: soundcraft.status shows the wrapper opened the file; the session or audio appears in the editor.
Gotchas: change path= to the Files path of an audio, MIDI or .scraftz session file; SoundCraft stays silent until the wrapper's Enable audio button is clicked.
```

Then the sections: `When:` one line, the user intent. `Steps:` numbered
`call_tool` lines, the exact calls in order. The build checks every line against
the real tool, so a renamed param breaks the build. `Check:` how to verify the
end state. `Gotchas:` what the model gets wrong and how to stay out of it.
`parseSkills` and `checkSkills` in `src/apps/ai-agent/runtime/skills.mjs` are
the parsers and validators.

## Rules learned live

- Never put a realistic example value in a param description: `describe_tool` shows descriptions verbatim and the model copies them into its calls. Examples and skill steps reach the model as templates (`key=<key>`), but teaching-error fix lines are built from the first example's values, so keep those neutral too.
- Read the live app state, not a cached view.
- Most apps run in an inner iframe of their wrapper page: use the dig-in and poll from `agent/shared/inner-app.js`.
- Messages from another frame arrive in that frame's realm, so do not use `instanceof ArrayBuffer` on them.
- Wait for the app to finish (open, debounce) before you read.

## Testing

One test file per pack: `tests/agent-pack-<id>.test.mjs`, run with
`node --test tests/agent-pack-<id>.test.mjs`. The test builds a fake window
(the wrapper window, the `#editor` frame, the app's page API) and drives the
real `tools.js` against it, and it runs the real build validators
(`specErrors`, `checkArgs`, `parseSkills`, `checkSkills`) over the pack's spec
and skills. List every API name the fake assumes in a comment at the bottom of the
test, and check each tool on the real page before merging: a fake that mirrors
your own assumptions proves only the code path.

## The eval

`scripts/agent/eval.mjs` runs the task suite in `tests/agent-eval/tasks.yaml`
(60 tasks: A desktop and files, B ArtCraft, C other apps, D cross-app) against a
running preview. It starts no server: a preview must already be serving the
desktop at `--base` (default `http://127.0.0.1:4333`), and the prepared
`app.js` must carry the `?eval=1` trace hook (run the build, then restart the
preview). Usage:

```
node scripts/agent/eval.mjs --model lfm3-1.7b --set A [--limit N] [--prefetch on|off] [--base URL]
```

`--model` is the key from `src/apps/ai-agent/models.js` (default `lfm3-1.7b`);
`--set` runs one set and `--task <id>` one task; `--limit` caps the count;
`--prefetch on` loads the Buddy document with `?prefetch=1`, the eval-only
switch that puts the best skill's steps in the turn (Buddy's default is off).
Chrome runs headless with WebGPU and a persistent profile
(`/tmp/webpc-eval-profile`), so model downloads are cached across runs.
Results go to `tests/agent-eval/results/<model>-<set>-<timestamp>.json`:
per-task the tools seen, the end-state check, seconds and rounds, plus a
summary with the success rate, the tool accuracy and the median seconds.
A task passes when its end-state check holds and every expected tool was seen,
in order (a subsequence match, so extra calls in between do not fail it).
