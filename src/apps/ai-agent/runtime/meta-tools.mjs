// Buddy M1 part 4: the six meta tools the model sees: lookup_skill_index, read_skill,
// find_in_skill, find_tool, describe_tool, call_tool. The catalog, the parsed skills, the
// search handles and the executor are all injected through deps, so this module stays pure
// and testable. repairCall comes from repair.mjs, which another lane is writing in
// parallel: it is an injected dependency with the identity default below, never imported.
import { closest, checkArgs, ToolError, templateLine, templateStep, snapToUserText } from './args.mjs';
import { describe, templateKeys } from './catalog.mjs';
import { renderSkill } from './skills.mjs';
import { search, excerpt, namedApps, preferNamed, cleanQuery, TIE_EPSILON } from './search.mjs';

/** The meta tool names in the order the tool table presents them. */
export const META_TOOL_NAMES = ['lookup_skill_index', 'read_skill', 'find_in_skill', 'find_tool', 'describe_tool', 'call_tool'];

const HITS_LIMIT = 5;
const LIST_LIMIT = 20;
const REGEX_MAX_SOURCE = 200;
const WORD_SPLIT = /[\n\r\p{Z}\p{P}]+/u;

// The brief's default repairCall: pass the name through and keep every other key as args.
function identityRepair(raw) {
  const args = {};
  for (const [key, value] of Object.entries(raw ?? {})) if (key !== 'tool') args[key] = value;
  return { tool: raw?.tool, args, repairs: [] };
}

/** Lowercase a query and split it on whitespace and punctuation, like search.mjs does. */
function queryWords(query) {
  return String(query ?? '').toLowerCase().split(WORD_SPLIT).filter(Boolean);
}

/** Normalise a skill path: lowercase, strip a leading / and a trailing .md, accept pack:slug. */
function normalisePath(path) {
  return String(path ?? '').trim().toLowerCase().replace(/^\//, '').replace(/\.md$/, '').replace(':', '/');
}

function unknownSkillError(path, skills) {
  const close = closest(path, skills.map(skill => skill.path), 3);
  const best = close[0];
  return {
    ok: false,
    error: {
      type: 'unknown_skill',
      message: `unknown skill path '${path}'${close.length > 0 ? `; closest: ${close.join(', ')}` : ''}`,
      ...(best ? { fix: `read_skill path=${best}` } : {})
    }
  };
}

// The model reaches for the app name as the skill path (lfm3-1.7b loops on find_in_skill
// path="effectcraft" / "figcraft", J2 effectcraft 0/12, figcraft 3 of 6 train journeys).
// The app is not a skill, but its skills are what the model wants.
function appSkills(path, skills) {
  return skills.filter(skill => skill.path.startsWith(`${path}/`));
}

// A15 (2026-11-25): lfm3 searches by the bare app name (gridcraft-01 on build 10: the query
// "gridcraft" never surfaced build-a-budget-with-formula-columns), and a MiniSearch for the
// app name can only match generic words. Filler words a query may carry around the name.
const APP_FILLER = new Set(['skill', 'skills', 'help', 'how', 'tool', 'tools']);

/** The app a query names, when the query is only that app's id or title plus filler words.
 *  Pure: a task word anywhere keeps the query normal ("gridcraft budget" is not bare). */
export function bareApp(query, apps) {
  const words = cleanQuery(query).split(' ').filter(word => word && !APP_FILLER.has(word));
  if (!words.length) return null;
  for (const app of apps ?? []) {
    for (const name of [app?.id, app?.title]) {
      const nameWords = String(name ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      if (nameWords.length && words.length === nameWords.length && nameWords.every(word => words.includes(word))) return app;
    }
  }
  return null;
}

// The three closest names/paths: search hits over the query first, then edit distance over
// the names the search missed, best first overall.
function closestNames(query, all, index, docs) {
  const fromSearch = search(index, query, { mode: 'auto', limit: HITS_LIMIT, docs }).hits.map(hit => hit.id);
  const rest = closest(query, all.filter(name => !fromSearch.includes(name)), 3);
  return [...fromSearch, ...rest].slice(0, 3);
}

// The closest tool names for an unknown tool, with the best one and its call template for
// the fix: describe_tool fixes with its own call, call_tool with the best tool's template.
function closestTools(name, catalog, index, docs) {
  const close = closestNames(String(name ?? ''), [...catalog.tools.keys()], index, docs);
  const best = close[0];
  const bestTool = best ? catalog.tools.get(best) : null;
  return {
    message: `unknown tool '${String(name ?? '')}'${close.length > 0 ? `; closest: ${close.join(', ')}` : ''}`,
    best,
    exampleFix: best ? templateLine(best, templateKeys(bestTool)) : undefined
  };
}

// The skill's rendered text as { section, text } lines. Lines before the first section
// header (the title and summary block) are attributed to the summary section.
function skillLines(skill) {
  const out = [];
  let section = 'summary';
  for (const raw of renderSkill(skill).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const header = line.match(/^(When|Steps|Check|Gotchas):(?:\s|$)/);
    if (header) section = header[1];
    out.push({ section, text: line });
  }
  return out;
}

function strParam(description) {
  return { type: 'string', description };
}

/**
 * deps = {
 *   catalog,                 // buildCatalog(...) result: { tools: Map, docs }
 *   skills,                  // parsed skills list (parseSkills output .skills, all packs)
 *   toolIndex, skillIndex,   // search handles (search.mjs loadIndex) over catalog.docs and skill docs
 *   toolDocs, skillDocs,     // the doc arrays (needed for regex mode)
 *   run: async (tool, args, ctx) => result,   // executes a catalog tool (the lead wires the policy and leases)
 *   repairCall,              // raw -> { tool, args, repairs } (repair.mjs, injected)
 *   choices, aliases,        // passed to checkArgs
 *   skillPathsFor: name => [], // skills whose tools: list names this tool
 * }
 * -> the six meta tools, each { description, parameters (JSON schema), run: async (args, ctx) }.
 * Every result is deterministic for the same inputs: no clock, no randomness.
 */
export function createMetaTools(deps) {
  const { catalog, skills } = deps;
  const toolIndex = deps.toolIndex, skillIndex = deps.skillIndex;
  const toolDocs = deps.toolDocs ?? catalog.docs, skillDocs = deps.skillDocs ?? [];
  const run = deps.run;
  const repairCall = deps.repairCall ?? identityRepair;
  const choices = deps.choices ?? (() => []);
  const aliases = deps.aliases ?? {};
  const skillPathsFor = deps.skillPathsFor ?? (() => []);
  const apps = deps.apps ?? []; // [{ id, title }]: lookup_skill_index ranks the apps a query names first

  return {
    lookup_skill_index: {
      description: 'Search the skill index for how to do a task. Use this first, before find_tool or call_tool.',
      parameters: {
        type: 'object',
        properties: {
          query: strParam('What the user wants done, in a few words.'),
          mode: strParam('auto (default), text or regex.')
        },
        required: ['query']
      },
      run: async (args, ctx) => {
        const query = String(args?.query ?? '');
        // A bare app name lists the app's whole skills (compact rows) instead of a search:
        // the app id matches no skill field, so a search only surfaces generic words.
        const bare = bareApp(query, apps);
        if (bare) {
          const all = appSkills(bare.id, skills);
          return { hits: all.slice(0, LIST_LIMIT).map(skill => ({ path: skill.path, title: skill.title })), note: `the ${bare.id} skills - read_skill the one that fits the task`, more: all.length > LIST_LIMIT };
        }
        // Search wider, then rank the apps the query names first, so a common word ("open")
        // cannot put another app's skill on top; nothing is dropped.
        const named = namedApps(query, apps);
        // A24: the user's message names one app and the query names none: that app's skills
        // lead the list as a partition (the figcraft/filmcraft runs searched "import a still"
        // with no app in the query and read the rival app's skill). A query that names an
        // app itself, or two or more apps named in the message: the existing ranking stands.
        const userNamed = namedApps(ctx?.userText ?? '', apps);
        const leadApp = named.length === 0 && userNamed.length === 1 ? userNamed[0] : null;
        // b17 (excalidraw-08, the prefetch-off path): the query scopes no app and the user
        // names none - the active on-screen app's skills lead the list when the search found
        // some: the same scoping the prefetch note applies, but eval runs never see the note,
        // so this is the measured path (a "pipeline diagram" query with excalidraw on screen
        // must not hand the model a cyberchef skill). One or two apps named in the message
        // keep the existing ranking (A24's partition / cross-app journeys).
        const activeLead = leadApp === null && named.length === 0 && userNamed.length === 0 && ctx?.activeApp ? ctx.activeApp : null;
        // A22: the active app's skills get the tie-break boost unless the query names a
        // rival app (the prefetch note has the same rule); applied before the named reorder.
        const boostApp = ctx?.activeApp && (!named.length || named.includes(ctx.activeApp)) ? ctx.activeApp : null;
        const { hits: wide, more } = search(skillIndex, query, {
          mode: args?.mode ?? 'auto', limit: named.length || leadApp || activeLead ? HITS_LIMIT * 4 : HITS_LIMIT, docs: skillDocs
        });
        if (wide.length === 0) return { hits: [], note: 'No skill matches. Try find_tool.' };
        const top = wide[0]?.score ?? 0;
        const ranked = wide.map(hit => ({ ...hit, score: boostApp && hit.id.startsWith(`${boostApp}/`) ? hit.score + top * TIE_EPSILON : hit.score }))
          .sort((a, b) => b.score - a.score);
        const order = preferNamed(ranked.map(hit => hit.id), named);
        const lead = leadApp ?? activeLead;
        const ordered = lead
          ? [...order.filter(id => id.startsWith(`${lead}/`)), ...order.filter(id => !id.startsWith(`${lead}/`))]
          : order;
        const hits = ordered.slice(0, HITS_LIMIT).map(id => ranked.find(hit => hit.id === id));
        return { hits: hits.map(hit => ({ path: hit.id, title: hit.title, summary: hit.summary })), more: more || wide.length > HITS_LIMIT };
      }
    },
    read_skill: {
      description: 'Read one skill by path, or one of its sections (When, Steps, Check, Gotchas). Use after lookup_skill_index picks a skill.',
      parameters: {
        type: 'object',
        properties: {
          path: strParam('The skill path, like gridcraft/chart-from-range.'),
          section: strParam('Optional: When, Steps, Check or Gotchas; omit for the whole skill.')
        },
        required: ['path']
      },
      run: async (args) => {
        const path = normalisePath(args?.path);
        const skill = skills.find(candidate => candidate.path === path);
        if (!skill) {
          const app = appSkills(path, skills);
          if (app.length) {
            return { ok: false, error: { type: 'unknown_skill', message: `'${path}' is an app, not a skill; its skills: ${app.slice(0, 10).map(candidate => candidate.path).join(', ')}`, fix: `read_skill path=${app[0].path}` } };
          }
          return unknownSkillError(path, skills);
        }
        return { path: skill.path, text: renderSkill(skill, args?.section).split('\n').map(templateStep).join('\n') };
      }
    },
    find_in_skill: {
      description: 'Find lines inside one skill that match a query (words, or a regex with mode regex). Use to locate a detail without reading the whole skill.',
      parameters: {
        type: 'object',
        properties: {
          path: strParam('The skill path to search inside.'),
          query: strParam('The words to find, or a RegExp source when mode is regex.'),
          mode: strParam('auto (default), text or regex.')
        },
        required: ['path', 'query']
      },
      run: async (args) => {
        const path = normalisePath(args?.path);
        const query = String(args?.query ?? '');
        const mode = args?.mode ?? 'auto';
        // B17 (cyberchef-09): a dotted query is a tool name, not skill text - the model made ten
        // such searches inside the cyberchef skills (files.read, desktop.open_app) and found
        // nothing there. Point it at the tool index; a name that is in the catalog gets the
        // tool's purpose straight away, so the model can act without another search.
        if (mode !== 'regex' && /^[a-z0-9_-]{2,}(?:\.[a-z0-9_-]{2,})+$/i.test(query)) {
          const tool = catalog.tools.get(query);
          return {
            hits: [],
            note: tool
              ? `"${query}" is a tool, not skill text: ${tool.purpose} describe_tool tool=${query} for its arguments, call_tool tool=${query} to run it.`
              : `"${query}" looks like a tool name, not skill text - find_tool query=${query} to look it up in the tool index.`,
          };
        }
        const skill = skills.find(candidate => candidate.path === path);
        if (!skill) {
          const app = appSkills(path, skills);
          if (app.length) {
            // Rank the app's skills by how many of their lines carry a query word, so the
            // model's bare-app search becomes a scoped skill index in one round.
            const words = queryWords(args?.query);
            const ranked = app.map(candidate => [candidate, skillLines(candidate).filter(line => words.some(word => line.text.toLowerCase().includes(word))).length]);
            ranked.sort((a, b) => b[1] - a[1] || a[0].path.localeCompare(b[0].path));
            const hits = ranked.slice(0, HITS_LIMIT).map(([candidate]) => ({ path: candidate.path, title: candidate.title, summary: candidate.summary }));
            return { hits, note: `'${path}' is an app, not a skill: matching skills listed.` };
          }
          return unknownSkillError(path, skills);
        }
        const lines = skillLines(skill);
        let matched;
        if (mode === 'regex') {
          if (query.length > REGEX_MAX_SOURCE) return { ok: false, error: { type: 'invalid_regex', message: 'regex too long' } };
          let pattern;
          try { pattern = new RegExp(query, 'gi'); }
          catch (err) { return { ok: false, error: { type: 'invalid_regex', message: `invalid regex: ${err.message}` } }; }
          matched = lines.filter(line => line.text.match(pattern));
        } else {
          const words = queryWords(query);
          matched = lines.filter(line => {
            const lower = line.text.toLowerCase();
            return words.some(word => lower.includes(word));
          });
          if (matched.length === 0 && mode === 'auto') {
            // Same fallback as search.mjs: the longest word, escaped, as a regex.
            const longest = words.reduce((best, word) => (word.length > best.length ? word : best), '');
            if (longest) {
              const byRegex = lines.filter(line => line.text.match(new RegExp(longest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')));
              if (byRegex.length > 0) matched = byRegex;
            }
          }
        }
        return {
          hits: matched.slice(0, HITS_LIMIT).map(line => ({
            section: line.section,
            line: templateStep(line.text),
            excerpt: templateStep(excerpt(line.text, query, 200))
          }))
        };
      }
    },
    find_tool: {
      description: 'Search the tool catalog for what a tool does. Use when no skill fits the task.',
      parameters: {
        type: 'object',
        properties: {
          query: strParam('What the tool should do, in a few words.'),
          app: strParam('Optional app id; keeps that app tools plus desktop tools that take an app parameter.'),
          mode: strParam('auto (default), text or regex.')
        },
        required: ['query']
      },
      run: async (args, ctx) => {
        const app = String(args?.app ?? '').trim();
        // A bare app name lists the app's tools by purpose (same reason as lookup_skill_index).
        const bare = bareApp(String(args?.query ?? ''), apps);
        if (bare) {
          const ids = [...catalog.tools.keys()].filter(id => id.startsWith(`${bare.id}.`)).slice(0, LIST_LIMIT);
          return { hits: ids.map(id => ({ tool: id, does: catalog.tools.get(id)?.purpose ?? '' })), note: `the ${bare.id} tools - call_tool the one that fits` };
        }
        const hasAppParam = (id) => {
          const tool = catalog.tools.get(id);
          return Boolean(tool && tool.params && 'app' in tool.params);
        };
        const filter = app
          ? (hit) => hit.id.startsWith(`${app}.`) || (hit.id.startsWith('desktop.') && hasAppParam(hit.id))
          : undefined;
        // A24: the user's message names one app and the call scopes none (no app=, and the
        // query names no app of its own): that app's tools lead the list as a partition, not
        // an epsilon - the A22 boost (0.15 x top) lost to lightcraft.import_file for the
        // figcraft/filmcraft "import a still" queries (b16). Two or more named apps: a
        // cross-app journey, the raw ranking stands.
        const named = namedApps(String(args?.query ?? ''), apps);
        const userNamed = namedApps(ctx?.userText ?? '', apps);
        const leadApp = !app && named.length === 0 && userNamed.length === 1 ? userNamed[0] : null;
        // b17 (excalidraw-08 path, the find_tool half): the same on-screen scoping as
        // lookup_skill_index - eval runs never see the prefetch note, and 08's model searched
        // with find_tool. Unscoped call, query names no app, the user names none: the active
        // app's tools lead when it has a matching hit (an empty partition is the identity);
        // A24's user-named partition wins, two or more named apps keep the raw ranking.
        const activeLead = leadApp === null && !app && named.length === 0 && userNamed.length === 0 && ctx?.activeApp ? ctx.activeApp : null;
        const { hits } = search(toolIndex, String(args?.query ?? ''), {
          mode: args?.mode ?? 'auto', limit: leadApp || activeLead ? HITS_LIMIT * 4 : HITS_LIMIT, docs: toolDocs, filter
        });
        if (hits.length === 0) return { hits: [], note: 'No tool matches. Try lookup_skill_index.' };
        // A22: the active app's tools get the tie-break boost - unless the query names a
        // rival app, or the call scoped the search with app= (that scope is the answer).
        const boostApp = !app && ctx?.activeApp && (!named.length || named.includes(ctx.activeApp)) ? ctx.activeApp : null;
        const top = hits[0]?.score ?? 0;
        const ranked = hits.map(hit => ({ ...hit, score: boostApp && hit.id.startsWith(`${boostApp}.`) ? hit.score + top * TIE_EPSILON : hit.score }))
          .sort((a, b) => b.score - a.score);
        const lead = leadApp ?? activeLead;
        const ordered = lead
          ? [...ranked.filter(hit => hit.id.startsWith(`${lead}.`)), ...ranked.filter(hit => !hit.id.startsWith(`${lead}.`))]
          : ranked;
        return {
          hits: ordered.slice(0, HITS_LIMIT).map(hit => {
            const tool = catalog.tools.get(hit.id);
            // A template, not the example: small models copy example values verbatim (eval M6).
            return { tool: hit.id, does: hit.purpose ?? tool?.purpose ?? '', call: templateLine(hit.id, templateKeys(tool)) };
          })
        };
      }
    },
    describe_tool: {
      description: "Show a tool's full parameter list, effect, its call template and the related skills. Use before call_tool.",
      parameters: {
        type: 'object',
        properties: {
          tool: strParam('The tool name, like gridcraft.set_cells.')
        },
        required: ['tool']
      },
      run: async (args) => {
        const { tool: name } = repairCall({ tool: args?.tool ?? '' });
        const tool = catalog.tools.get(name);
        if (!tool) {
          const close = closestTools(name, catalog, toolIndex, toolDocs);
          return { ok: false, error: { type: 'unknown_tool', message: close.message, ...(close.best ? { fix: `describe_tool tool=${close.best}` } : {}) } };
        }
        return { tool: name, text: describe(tool, skillPathsFor(name)) };
      }
    },
    call_tool: {
      description: "Call a catalog tool: pass tool plus the tool's own parameters. Use after describe_tool or a skill's steps.",
      parameters: {
        type: 'object',
        properties: {
          tool: strParam('The exact tool name to call, like gridcraft.set_cells.')
        },
        required: ['tool'],
        additionalProperties: true
      },
      run: async (rawArgs, ctx) => {
        const { tool: name, args, repairs } = repairCall(rawArgs ?? {});
        const tool = catalog.tools.get(name);
        if (!tool) {
          const close = closestTools(name, catalog, toolIndex, toolDocs);
          return { ok: false, error: { type: 'unknown_tool', message: close.message, ...(close.exampleFix ? { fix: close.exampleFix } : {}) } };
        }
        // A16: snap a near-miss text argument (input/text carrying the user's own content) back
        // to the exact span of the user's message; the note says which text ran.
        let snapNote = null;
        const userText = ctx?.userText;
        if (typeof userText === 'string' && userText) {
          for (const key of Object.keys(args ?? {})) {
            const span = snapToUserText(userText, key, args[key]);
            if (span !== null) { args[key] = span; snapNote = `used your exact text '${span}'`; }
          }
        }
        // B17: the missing-arg fix example for a live app enum is context-aware - the active
        // window's app, else the app of the last skill read this turn, else the placeholder
        // (the pack's example app lured 09 into opening gridcraft).
        const checked = checkArgs(tool, args, { choices, aliases, liveApp: ctx?.activeApp ?? ctx?.lastSkillApp ?? null });
        if (!checked.ok) return { ok: false, error: checked.error };
        try {
          const result = await run(tool.name, checked.args, ctx);
          return { ok: true, tool: tool.name, result, ...(snapNote ? { note: snapNote } : {}), ...(repairs.length > 0 ? { repaired: repairs } : {}) };
        } catch (err) {
          // By name too: a pack bundled on its own has its own copy of the ToolError class.
          if (err instanceof ToolError || err?.name === 'ToolError') {
            return { ok: false, error: { type: err.type, message: err.message, ...(err.fix !== undefined ? { fix: err.fix } : {}) } };
          }
          return { ok: false, error: { type: 'app_error', message: err?.message ?? String(err) } };
        }
      }
    }
  };
}
