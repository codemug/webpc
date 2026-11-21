// Buddy M1 part 4: the six meta tools the model sees: lookup_skill_index, read_skill,
// find_in_skill, find_tool, describe_tool, call_tool. The catalog, the parsed skills, the
// search handles and the executor are all injected through deps, so this module stays pure
// and testable. repairCall comes from repair.mjs, which another lane is writing in
// parallel: it is an injected dependency with the identity default below, never imported.
import { closest, callLine, checkArgs, ToolError } from './args.mjs';
import { describe } from './catalog.mjs';
import { renderSkill } from './skills.mjs';
import { search, excerpt } from './search.mjs';

/** The meta tool names in the order the tool table presents them. */
export const META_TOOL_NAMES = ['lookup_skill_index', 'read_skill', 'find_in_skill', 'find_tool', 'describe_tool', 'call_tool'];

const HITS_LIMIT = 5;
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

// The three closest names/paths: search hits over the query first, then edit distance over
// the names the search missed, best first overall.
function closestNames(query, all, index, docs) {
  const fromSearch = search(index, query, { mode: 'auto', limit: HITS_LIMIT, docs }).hits.map(hit => hit.id);
  const rest = closest(query, all.filter(name => !fromSearch.includes(name)), 3);
  return [...fromSearch, ...rest].slice(0, 3);
}

// The closest tool names for an unknown tool, with the best one and its example line for
// the fix: describe_tool fixes with its own call, call_tool with the best tool's example.
function closestTools(name, catalog, index, docs) {
  const close = closestNames(String(name ?? ''), [...catalog.tools.keys()], index, docs);
  const best = close[0];
  const bestTool = best ? catalog.tools.get(best) : null;
  const exampleArgs = bestTool?.examples?.[0]?.args;
  return {
    message: `unknown tool '${String(name ?? '')}'${close.length > 0 ? `; closest: ${close.join(', ')}` : ''}`,
    best,
    exampleFix: best ? (exampleArgs !== undefined ? callLine(best, exampleArgs) : `call_tool tool=${best}`) : undefined
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
 *   run: async (tool, args, ctx) => result,   // executes a catalog tool (the lead wires effects, approvals, leases)
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
      run: async (args) => {
        const { hits, more } = search(skillIndex, String(args?.query ?? ''), {
          mode: args?.mode ?? 'auto', limit: HITS_LIMIT, docs: skillDocs
        });
        if (hits.length === 0) return { hits: [], note: 'No skill matches. Try find_tool.' };
        return { hits: hits.map(hit => ({ path: hit.id, title: hit.title, summary: hit.summary })), more };
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
        if (!skill) return unknownSkillError(path, skills);
        return { path: skill.path, text: renderSkill(skill, args?.section) };
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
        const skill = skills.find(candidate => candidate.path === path);
        if (!skill) return unknownSkillError(path, skills);
        const query = String(args?.query ?? '');
        const mode = args?.mode ?? 'auto';
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
            line: line.text,
            excerpt: excerpt(line.text, query, 200)
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
      run: async (args) => {
        const app = String(args?.app ?? '').trim();
        const hasAppParam = (id) => {
          const tool = catalog.tools.get(id);
          return Boolean(tool && tool.params && 'app' in tool.params);
        };
        const filter = app
          ? (hit) => hit.id.startsWith(`${app}.`) || (hit.id.startsWith('desktop.') && hasAppParam(hit.id))
          : undefined;
        const { hits } = search(toolIndex, String(args?.query ?? ''), {
          mode: args?.mode ?? 'auto', limit: HITS_LIMIT, docs: toolDocs, filter
        });
        if (hits.length === 0) return { hits: [], note: 'No tool matches. Try lookup_skill_index.' };
        return {
          hits: hits.map(hit => {
            const tool = catalog.tools.get(hit.id);
            const exampleArgs = tool?.examples?.[0]?.args;
            return {
              tool: hit.id,
              does: hit.purpose ?? tool?.purpose ?? '',
              ...(exampleArgs !== undefined ? { example: callLine(hit.id, exampleArgs) } : {})
            };
          })
        };
      }
    },
    describe_tool: {
      description: "Show a tool's full parameter list, effect, one example call and the related skills. Use before call_tool.",
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
        const checked = checkArgs(tool, args, { choices, aliases });
        if (!checked.ok) return { ok: false, error: checked.error };
        try {
          const result = await run(tool.name, checked.args, ctx);
          return { ok: true, tool: tool.name, result, ...(repairs.length > 0 ? { repaired: repairs } : {}) };
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
