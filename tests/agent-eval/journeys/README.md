# Journey files

One file per app: `<app>.yaml` with a top-level `app:` and a `journeys:` list. Each journey:

- `id` - `<app>-NN-slug`, unique across all files (for example `terminal-01-list-files`)
- `split` - `train` or `holdout`; about 1 in 4 journeys is holdout. Holdout journeys and their
  failures are never shown to the skills work, so the score measures general skill, not fitted prompts
- `title`, `prompt` - a realistic ask of at least 120 characters, two or more sentences, varied
  phrasing (goal-first and layout-dictating). The prompt is `>-` folded and unquoted; a prompt
  that is the literal text `>-` is a YAML mistake
- `setup` (optional) - the state the prompt assumes, created before the prompt:
  - `close_all:` - close every window
  - `open_app: <app>` - open an app window (stateful apps are reset first)
  - `reset_app: <app>` - the same fresh open; gridcraft, docs, excalidraw and lightcraft
    additionally get an in-app model reset (file.new, new document, empty scene, vendor reset
    reload). A fresh open also drops the app's own localStorage keys
  - `seed_file: { path, text }` - write a text file into the Files area
  - `seed_fixture: { path, fixture }` - copy `tests/agent-eval/fixtures/<fixture>` byte for byte
    (photos, a WAV, a CSV, a text PDF; see the fixtures README)
  - `run: { tool, ...args }` - run a catalog tool through the oracle hook before the prompt;
    the trace is cleared after, so setup calls never count as the agent's work
- `oracle` (optional) - the exact catalog tool calls that achieve the journey, in order; each
  step is `{ tool, ...args }` with the values a model would send (strings, unquoted).
  Run it first: `node scripts/agent/eval.mjs --journeys <app> --oracle` must pass before the
  agent ever sees the journey
- `needs` (required when there is no oracle) - what is missing; the runner lists it as NEEDS
- `checks` - the end-state checks; every check must pass. Checks read the state themselves:
  `read_tool` calls the app's own read tool after the run (the checker calls it, so it does not
  depend on which tools the agent used), `craft_request` reads through the app's page API
  (request, then execute, then `command(id, JSON text)`), `file_*` reads the Files area, and so
  on. `tool_result` is only for a command whose output is the deliverable (terminal, a bake);
  an answer goal checks the answer. `window_open` alone never checks work. Kinds: `CHECK_KINDS`
  in `scripts/agent/eval.mjs`. Text `contains` checks (and the `contains` inside `tool_result`,
  `read_tool`, `craft_request`) ignore case and repeated whitespace unless the check sets
  `exact: true`; the regex kinds (`answer_matches`, `file_matches`, `matches`) stay as written
- `covers` (optional) - the catalog tools the journey exercises
- `notes` (optional)

Run:

```
node scripts/agent/eval.mjs --journeys terminal --oracle
node scripts/agent/eval.mjs --journeys terminal --split train --repeat 2
node scripts/agent/eval.mjs --journeys all --split train --repeat 2 --models lfm3-1.7b,qwen3.5-0.8b,qwen3.5-2b,gemma4-e2b
```

`--models` runs every model in one browser session (select, load - up to 30 min for a first
download, run, switch). A journey is solved when it passes every check on all `--repeat` runs
(fresh chat each); the per-journey cap is 240 s. Results:
`tests/agent-eval/results/journeys-<app>-<split>-<model>-<stamp>.json` (per-run id, split,
pass, checks with detail, seconds, rounds, final answer, full trace with results cut at 4000
chars).

Queue runner (one shared session for all lanes): the lead starts `scripts/agent/eval-queue.mjs`
(`--queue <dir>`, default `.lanes/scratch/journeys/queue` relative to where it is started); it
keeps the one browser open and processes one request at a time, oldest first, preferring a
request that reuses the last model. A request file `<id>.json` is:

```json
{
  "id": "terminal-fix-1",
  "requester": "terminal-lane",
  "journeys": "terminal",
  "split": "train",
  "models": ["lfm3-1.7b"],
  "repeat": 2,
  "oracle": false
}
```

`journeys` is an app id (`"terminal"`, or `"all"`) or a list of journey ids; `split` defaults
to `train`, `repeat` to 1, `oracle` to false. The runner writes `<id>.running`, then
`<id>.result.json` (the same shape as a results file) and `<id>.done`; a request that fails to
parse or validate gets `<id>.error` with the reason. Teammates write request files only; Ctrl+C
stops the runner after the current journey.

Schema: `node --test tests/agent-eval-journeys.test.mjs` (passes with zero files).
