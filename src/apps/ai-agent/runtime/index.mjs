// Buddy's agent runtime: the generated catalog, skills and search indexes, the six meta tools,
// the executor that runs a catalog tool (needs, safety policy) and the prefetch note.
// prepare-ai-agent.mjs bundles this file with esbuild to the same relative path in the served
// app, so session.js imports it the same way in Node tests and in the browser.
import catalogJson from '../generated/catalog.json' with { type: 'json' };
import skillsJson from '../generated/skills.json' with { type: 'json' };
import toolIndexJson from '../generated/search-tools.json' with { type: 'json' };
import skillIndexJson from '../generated/search-skills.json' with { type: 'json' };
import { packs } from '../generated/packs.mjs';
import { loadIndex, search, namedApps, TIE_EPSILON } from './search.mjs';
import { createMetaTools, META_TOOL_NAMES } from './meta-tools.mjs';
import { repairCall } from './repair.mjs';
import { ToolError, templateLine, templateStep } from './args.mjs';
import { templateKeys } from './catalog.mjs';

export { META_TOOL_NAMES };
// Re-exported so app.js can reach it: the served runtime/ folder holds only the bundles.
export { createScheduler } from './scheduler.mjs';
export { craftApi } from '../../../../agent/shared/craft.js';

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

/** Every catalog call runs without a policy gate (the user's ruling, 2026-11-24: no approvals, no grant rule). */
export function createAgent({ data = { catalogJson, skillsJson, toolIndexJson, skillIndexJson, packs } } = {}) {
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
    return await impl.run(args, ctx);
  }
  const skillPathsFor = name => skills.filter(s => s.tools.includes(name)).map(s => s.path);
  const metaTools = createMetaTools({ catalog, skills, toolIndex, skillIndex, toolDocs: catalog.docs, skillDocs, run, repairCall: repair, choices, aliases, skillPathsFor, apps });

  return {
    metaTools, catalog, apps,
    /** A function name the model called directly: the catalog tool it means, or null. */
    resolveDirect(name) {
      if (META_TOOL_NAMES.includes(name)) return null;
      const fixed = repair({ tool: name }).tool;
      if (known(fixed)) return fixed;
      return known(`system.${name}`) ? `system.${name}` : null;
    },
    /** The runtime note for a turn: the best skill's steps, or the top tool examples.
     *  activeApp: the app active on screen (A22): an unnamed query - or one that names the
     *  active app - gets a TIE_EPSILON boost on the active app's skills; a query naming a
     *  rival app suppresses the boost, so the boost is a tie-breaker, never an override. */
    prefetch(text, activeApp = null) {
      const named = namedApps(text, apps);
      const boostApp = activeApp && (!named.length || named.includes(activeApp)) ? activeApp : null;
      const found = search(skillIndex, text, { limit: 8, docs: skillDocs }).hits;
      const top = found[0]?.score ?? 0;
      // B17 (excalidraw-08): with an app on screen the note suggests that app's skill - the
      // tie-break boost alone cannot outrank a rival app's higher raw score (cyberchef's
      // "pipeline" skill won an excalidraw "pipeline diagram" prompt and handed the model a
      // cyberchef.bake step list). No match in the on-screen app falls back to every app; a
      // query naming a rival app already suppresses the scope (boostApp null).
      const scoped = boostApp ? found.filter(h => h.id.split('/')[0] === boostApp) : [];
      const rows = (scoped.length ? scoped : found).map(h => ({ ...h, score: h.id.split('/')[0] === boostApp ? h.score + top * TIE_EPSILON : h.score }))
        .sort((a, b) => b.score - a.score);
      const skill = rows.slice(0, 3).map(h => skills.find(s => s.path === h.id))
        .find(s => s && sharesWord(text, `${s.title} ${s.keywords.join(' ')} ${s.summary}`)) ?? null;
      if (skill) return `Note: matching skill "${skill.title}" (${skill.path}). Steps (fill each <placeholder> with the user's own values):\n${skill.steps.map(st => templateStep(st.line)).join('\n')}`;
      const toolsHit = search(toolIndex, text, { limit: 3, docs: catalog.docs }).hits.map(h => tools.get(h.id)).filter(t => t && sharesWord(text, `${t.name.replace(/[._]/g, ' ')} ${t.purpose} ${t.when}`));
      return toolsHit.length ? `Note: possibly useful tools (fill each <placeholder> with the user's own values):\n${toolsHit.map(t => `${templateLine(t.name, templateKeys(t))} (${t.purpose})`).join('\n')}` : '';
    },
    appsLine: `Apps: ${apps.map(a => `${a.id} (${a.title})`).join(', ')}.`,
  };
}
