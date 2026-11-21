// Buddy's agent runtime: the generated catalog, skills and search indexes, the six meta tools,
// the executor that runs a catalog tool (needs, safety policy, approvals) and the prefetch note.
// prepare-ai-agent.mjs bundles this file with esbuild to the same relative path in the served
// app, so session.js imports it the same way in Node tests and in the browser.
import catalogJson from '../generated/catalog.json' with { type: 'json' };
import skillsJson from '../generated/skills.json' with { type: 'json' };
import toolIndexJson from '../generated/search-tools.json' with { type: 'json' };
import skillIndexJson from '../generated/search-skills.json' with { type: 'json' };
import { packs } from '../generated/packs.mjs';
import { loadIndex, search } from './search.mjs';
import { createMetaTools, META_TOOL_NAMES } from './meta-tools.mjs';
import { repairCall } from './repair.mjs';
import { ToolError, callLine } from './args.mjs';

export { META_TOOL_NAMES };
// Re-exported so app.js can reach it: the served runtime/ folder holds only the bundles.
export { createPolicy } from './policy.mjs';
export { createScheduler } from './scheduler.mjs';

/** The simple default policy; createPolicy (policy.mjs) replaces it when passed in. */
export function defaultPolicy() {
  return {
    newTurn: userText => ({ userText, tainted: false, approvedOnce: new Set() }),
    decide: (tool, args, turn) => {
      const line = callLine(tool.name, args);
      if (turn?.approvedOnce?.has(line)) return { action: 'allow' };
      const ask = tool.effect === 'destructive' || tool.effect === 'external' || (tool.effect === 'change' && turn?.tainted);
      return ask ? { action: 'ask', reason: `${tool.purpose} (${tool.effect})`, preview: line } : { action: 'allow' };
    },
    noteResult: (tool, args, turn) => { if (tool.untrusted && turn) turn.tainted = true; },
  };
}

const NEED_CHECKS = {
  host: ctx => Boolean(ctx.host), files: ctx => Boolean(ctx.files),
};

// Prefetch only shows a skill or tool that shares a meaningful word with the request, so a question
// like "what is 6 times 7" never pulls in "See what is open" through the word "what".
const FILLER = new Set('a an the to of in on for and or is it my me please can you i what how why who when where which are was does do did could would should will with about this that there here some any just'.split(' '));
const meaningful = text => String(text).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1 && !FILLER.has(w));
function sharesWord(query, text) {
  const words = meaningful(text);
  return meaningful(query).some(q => words.some(w => w.startsWith(q) || q.startsWith(w)));
}

/** policy: { newTurn, decide, noteResult } (defaultPolicy when omitted). */
export function createAgent({ policy = defaultPolicy(), data = { catalogJson, skillsJson, toolIndexJson, skillIndexJson, packs } } = {}) {
  const tools = new Map(data.catalogJson.tools.map(t => [t.name, t]));
  const catalog = { tools, docs: data.catalogJson.docs };
  const apps = data.catalogJson.apps ?? [];
  const appIds = apps.map(a => a.id);
  const aliases = Object.fromEntries(apps.flatMap(a => [[a.title.toLowerCase(), a.id], [a.title.toLowerCase().replace(/\s+/g, ''), a.id]]));
  const choices = name => (name === 'apps' || name === 'windows' ? appIds : []);
  const skills = data.skillsJson;
  const skillDocs = skills.map(s => ({ id: s.path, path: s.path, title: s.title, summary: s.summary, keywords: s.keywords, body: [s.when, ...s.steps.map(st => st.line), s.check, s.gotchas].filter(Boolean).join('\n') }));
  const toolIndex = loadIndex(data.toolIndexJson, { store: ['name', 'purpose'] });
  const skillIndex = loadIndex(data.skillIndexJson, { store: ['path', 'title', 'summary'] });
  const known = name => tools.has(name);
  const repair = raw => repairCall(raw, { known, apps: appIds });
  const modules = new Map();
  const load = async packId => { if (!modules.has(packId)) modules.set(packId, await data.packs[packId]()); return modules.get(packId); };

  async function run(name, args, ctx) {
    const meta = tools.get(name);
    const impl = (await load(meta.pack)).tools.find(t => t.name === name);
    for (const need of meta.needs ?? []) {
      const [kind, value] = need.split(':');
      const ok = kind === 'legacy' ? Boolean(ctx.legacy?.[value]) : kind === 'app' ? appIds.includes(value) && Boolean(ctx.host) : NEED_CHECKS[kind] ? NEED_CHECKS[kind](ctx) : true;
      if (!ok) throw new ToolError('not_available', `${name} is not available here (it needs ${need}).`, '');
    }
    const decision = policy.decide(meta, args, ctx.turn);
    if (decision.action === 'deny') throw new ToolError('not_allowed', decision.reason, '');
    if (decision.action === 'ask') {
      const yes = await (ctx.approve?.({ tool: name, preview: decision.preview, reason: decision.reason }) ?? false);
      if (!yes) throw new ToolError('needs_approval_denied', 'The user did not approve this. Ask what they want instead.', '');
      ctx.turn?.approvedOnce?.add(decision.preview);
    }
    const result = await impl.run(args, ctx);
    policy.noteResult(meta, args, ctx.turn);
    return result;
  }
  const skillPathsFor = name => skills.filter(s => s.tools.includes(name)).map(s => s.path);
  const metaTools = createMetaTools({ catalog, skills, toolIndex, skillIndex, toolDocs: catalog.docs, skillDocs, run, repairCall: repair, choices, aliases, skillPathsFor });

  return {
    metaTools, catalog, apps, policy,
    /** A function name the model called directly: the catalog tool it means, or null. */
    resolveDirect(name) {
      if (META_TOOL_NAMES.includes(name)) return null;
      const fixed = repair({ tool: name }).tool;
      if (known(fixed)) return fixed;
      return known(`system.${name}`) ? `system.${name}` : null;
    },
    /** The runtime note for a turn: the best skill's steps, or the top tool examples. */
    prefetch(text) {
      const skill = search(skillIndex, text, { limit: 3, docs: skillDocs }).hits.map(h => skills.find(s => s.path === h.id))
        .find(s => s && sharesWord(text, `${s.title} ${s.keywords.join(' ')} ${s.summary}`)) ?? null;
      if (skill) return `Note: matching skill "${skill.title}" (${skill.path}). Steps:\n${skill.steps.map(st => st.line).join('\n')}`;
      const toolsHit = search(toolIndex, text, { limit: 3, docs: catalog.docs }).hits.map(h => tools.get(h.id)).filter(t => t && sharesWord(text, `${t.name.replace(/[._]/g, ' ')} ${t.purpose} ${t.when}`));
      return toolsHit.length ? `Note: possibly useful tools:\n${toolsHit.map(t => `${callLine(t.name, t.examples?.[0]?.args ?? {})} (${t.purpose})`).join('\n')}` : '';
    },
    appsLine: `Apps: ${apps.map(a => `${a.id} (${a.title})`).join(', ')}.`,
  };
}
