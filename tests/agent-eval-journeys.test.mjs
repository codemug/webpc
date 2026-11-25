// Schema test for the journey files (tests/agent-eval/journeys/<app>.yaml). Every journey file
// has a real app and well-formed journeys: ids are unique across all files and prefixed
// <app>-NN-slug; the split is train/holdout (every file of 4+ journeys keeps at least one
// holdout); the prompt is a verbose ask of at least 120 characters and never the literal text
// ">-"; setup steps use the known kinds; checks are a non-empty list of well-formed kinds the
// runner itself validates (validateCheck, shared with scripts/agent/eval.mjs); every oracle
// step names a real catalog tool whose args pass the runtime validator (checkArgs); every
// journey has an oracle or a needs note; covers names real tools; regex checks never carry a
// doubled backslash before a letter (the single-quoted YAML mistake). Passes with zero files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CHECK_KINDS, validateCheck, STEP_REF } from '../scripts/agent/eval.mjs';
import { checkArgs } from '../src/apps/ai-agent/runtime/args.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const JOURNEYS_DIR = join(ROOT, 'tests/agent-eval/journeys');
const FIXTURES_DIR = join(ROOT, 'tests/agent-eval/fixtures');

const catalog = JSON.parse(readFileSync(join(ROOT, 'src/apps/ai-agent/generated/catalog.json'), 'utf8'));
const catalogApps = catalog.apps; // [{ id, title }]
const toolNames = new Set(catalog.tools.map((t) => t.name));
const catalogTools = new Map(catalog.tools.map((t) => [t.name, t]));
const realAppIds = new Set(catalogApps.map((a) => a.id));
// The same live-enum choices and title aliases the runtime wires into checkArgs
// (runtime/index.mjs createAgent), so a journey's oracle args are validated exactly as a call.
const aliases = Object.fromEntries(catalogApps.flatMap((a) => [[a.title.toLowerCase(), a.id], [a.title.toLowerCase().replace(/\s+/g, ''), a.id]]));
const choices = name => (name === 'apps' || name === 'windows' ? [...realAppIds] : []);
const check = (tool, args) => checkArgs(tool, args, { choices, aliases });

const files = existsSync(JOURNEYS_DIR)
  ? readdirSync(JOURNEYS_DIR, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith('.yaml')).map((d) => d.name).sort()
  : [];

// One pass over every journey, collecting the problems for each concern.
const problems = { app: [], id: [], split: [], prompt: [], setup: [], checks: [], oracle: [], needs: [], covers: [], regex: [] };
const seenIds = new Set();

for (const name of files) {
  const doc = parse(readFileSync(join(JOURNEYS_DIR, name), 'utf8'));
  const app = doc?.app;
  const appOk = typeof app === 'string' && (realAppIds.has(app) || app === 'desktop');
  if (!appOk) problems.app.push(`${name}: app must be a desktop app id (got ${JSON.stringify(app)})`);
  if (!Array.isArray(doc?.journeys) || !doc.journeys.length) { problems.app.push(`${name}: journeys must be a non-empty list`); continue; }

  const holdout = (j) => j.split === 'holdout';
  if (doc.journeys.length >= 4 && !doc.journeys.some(holdout)) problems.split.push(`${name}: ${doc.journeys.length} journeys but no holdout split`);

  doc.journeys.forEach((j, index) => {
    const label = typeof j?.id === 'string' && j.id ? j.id : `${name}#${index + 1}`;
    // id: unique everywhere, prefixed <app>-NN-slug.
    if (typeof j?.id !== 'string' || !j.id) problems.id.push(`${label}: id must be a non-empty string`);
    else {
      if (seenIds.has(j.id)) problems.id.push(`${j.id}: duplicate id (also ${[...seenIds].join(', ')})`);
      seenIds.add(j.id);
      if (appOk && app !== 'desktop' && !new RegExp(`^${app.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{2}-[a-z0-9][a-z0-9-]*$`).test(j.id)) problems.id.push(`${j.id}: id must be <${app}>-NN-slug`);
    }
    // split.
    if (j.split !== 'train' && j.split !== 'holdout') problems.split.push(`${label}: split must be train or holdout (got ${JSON.stringify(j.split)})`);
    // prompt: verbose, and never the literal ">-" (an unquoted folded-block marker).
    if (typeof j?.prompt !== 'string' || j.prompt.length < 120) problems.prompt.push(`${label}: prompt must be at least 120 characters (got ${typeof j?.prompt === 'string' ? j.prompt.length : typeof j?.prompt})`);
    else if (j.prompt === '>-') problems.prompt.push(`${label}: prompt is the literal text ">-" (a YAML marker, not a request)`);
    // setup: the known kinds, well-formed.
    if (j.setup !== undefined) {
      if (!Array.isArray(j.setup)) { problems.setup.push(`${label}: setup must be a list`); }
      else for (const step of j.setup) {
        const keys = step && typeof step === 'object' ? Object.keys(step) : [];
        if (keys.length !== 1) { problems.setup.push(`${label}: setup step must have exactly one key (got ${keys.join(',') || 'none'})`); continue; }
        const kind = keys[0];
        if (kind === 'close_all') continue;
        if (kind === 'open_app' || kind === 'reset_app') {
          if (typeof step[kind] !== 'string' || !realAppIds.has(step[kind])) problems.setup.push(`${label}: setup ${kind} must be a real app id (got ${JSON.stringify(step[kind])})`);
        } else if (kind === 'seed_file') {
          if (typeof step.seed_file?.path !== 'string' || !step.seed_file.path || typeof step.seed_file?.text !== 'string') problems.setup.push(`${label}: setup seed_file must be { path, text }`);
        } else if (kind === 'seed_fixture') {
          const s = step.seed_fixture;
          if (typeof s?.path !== 'string' || !s.path || typeof s?.fixture !== 'string' || !s.fixture) problems.setup.push(`${label}: setup seed_fixture must be { path, fixture }`);
          else if (!existsSync(join(FIXTURES_DIR, s.fixture))) problems.setup.push(`${label}: fixture ${s.fixture} is not in tests/agent-eval/fixtures`);
        } else if (kind === 'run') {
          const r = step.run ?? {};
          if (typeof r?.tool !== 'string' || !toolNames.has(r.tool)) problems.setup.push(`${label}: setup run must name a real catalog tool (got ${JSON.stringify(r?.tool)})`);
          else { const args = { ...r }; delete args.tool; if (!check(catalogTools.get(r.tool), args).ok) problems.setup.push(`${label}: setup run args fail checkArgs on ${r.tool}`); }
        } else problems.setup.push(`${label}: unknown setup step ${kind}`);
      }
    }
    // checks: a non-empty list of well-formed kinds (the runner's own validator).
    if (!Array.isArray(j.checks) || !j.checks.length) problems.checks.push(`${label}: checks must be a non-empty list`);
    else for (const entry of j.checks) {
      const keys = entry && typeof entry === 'object' ? Object.keys(entry) : [];
      if (keys.length !== 1) { problems.checks.push(`${label}: check must have exactly one kind (got ${keys.join(',') || 'none'})`); continue; }
      const [kind, value] = Object.entries(entry)[0];
      if (!CHECK_KINDS.includes(kind)) { problems.checks.push(`${label}: unsupported check kind ${kind}`); continue; }
      const res = validateCheck(kind, value);
      if (!res.ok) { problems.checks.push(`${label}: ${kind}: ${res.detail}`); continue; }
      if (kind === 'read_tool') {
        if (!toolNames.has(value.tool)) problems.checks.push(`${label}: read_tool names an unknown tool ${value.tool}`);
        else { const args = check(catalogTools.get(value.tool), value.args ?? {}); if (!args.ok) problems.checks.push(`${label}: read_tool ${value.tool} args fail checkArgs (${args.error?.message ?? args.error})`); }
      }
      // A doubled backslash before a letter in a regex check is almost always the single-quoted
      // YAML mistake: the string is taken as written, so the regex sees a literal backslash.
      const rx = (kind === 'answer_matches' || kind === 'file_matches') ? (typeof value === 'string' ? value : null)
        : (typeof value?.matches === 'string' ? value.matches : null);
      if (rx) { const m = rx.match(/\\\\[a-zA-Z]/); if (m) problems.regex.push(`${label}: ${kind} regex carries a doubled backslash (${m[0]}) - single-quoted YAML keeps backslashes as written, so write a single backslash in the regex`); }
    }
    // oracle: real tools, args (inlined under the step) that pass the runtime validator.
    if (j.oracle !== undefined) {
      if (!Array.isArray(j.oracle)) { problems.oracle.push(`${label}: oracle must be a list of steps`); }
      else for (const step of j.oracle) {
        const tool = step?.tool;
        if (typeof tool !== 'string' || !toolNames.has(tool)) { problems.oracle.push(`${label}: oracle step must name a real catalog tool (got ${JSON.stringify(tool)})`); continue; }
        const rest = { ...step }; delete rest.tool;
        // A "${N.path}" step reference is filled at run time: validate it as a value of the param's type.
        const spec = catalogTools.get(tool).params ?? {};
        for (const [key, value] of Object.entries(rest)) {
          if (typeof value !== 'string' || !STEP_REF.test(value)) continue;
          const type = spec[key]?.type;
          rest[key] = type === 'integer' || type === 'number' ? String(spec[key].min ?? 1) : type === 'boolean' ? 'true' : type === 'enum' ? String((spec[key].values ?? [])[0] ?? 'x') : type === 'path' ? '/x' : 'x';
        }
        const res = check(catalogTools.get(tool), rest);
        if (!res.ok) problems.oracle.push(`${label}: oracle ${tool} args fail checkArgs (${res.error?.message ?? res.error})`);
      }
    }
    // oracle or needs.
    const hasOracle = Array.isArray(j.oracle) && j.oracle.length > 0;
    const hasNeeds = typeof j.needs === 'string' && j.needs.trim() !== '';
    if (!hasOracle && !hasNeeds) problems.needs.push(`${label}: has neither oracle steps nor a needs note`);
    // covers: real tools only.
    if (j.covers !== undefined) {
      if (!Array.isArray(j.covers)) problems.covers.push(`${label}: covers must be a list of tool names`);
      else for (const name2 of j.covers) if (!toolNames.has(name2)) problems.covers.push(`${label}: covers names an unknown tool ${name2}`);
    }
  });
}

const none = (what, list) => assert.deepEqual(list, [], `${what} problems: ` + list.join('; '));

test('journey files name real apps and carry a journeys list', () => none('app', problems.app));
test('journey ids are unique and prefixed <app>-NN-slug', () => none('id', problems.id));
test('splits are train/holdout with a holdout in every file of 4+ journeys', () => none('split', problems.split));
test('prompts are at least 120 characters and never the literal ">-"', () => none('prompt', problems.prompt));
test('setup steps use the known kinds and are well-formed', () => none('setup', problems.setup));
test('checks are a non-empty list of well-formed kinds', () => none('checks', problems.checks));
test('oracle steps name real tools and their args pass checkArgs', () => none('oracle', problems.oracle));
test('every journey has an oracle or a needs note', () => none('needs', problems.needs));
test('covers names real tools', () => none('covers', problems.covers));
test('regex checks do not carry doubled backslashes (the single-quoted YAML mistake)', () => none('regex', problems.regex));
