// Buddy M1 part 3: the tool catalog. Validates each pack's tools.js entries (name shape,
// effect, needs, the params spec, and every example against checkArgs), and builds the
// search docs plus the one-line signatures the meta tools show.
// args.mjs belongs to another lane: imported here, never edited.
import { checkArgs, specErrors, callLine } from './args.mjs';

const EFFECTS = ['read', 'change', 'destructive', 'external'];
const DESCRIBE_MAX = 1200;

function escapeRegExp(source) {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// How a param is shown in a signature: the type, or the enum's values, or the live list
// kind ('apps' -> 'app id', 'windows' -> 'window id').
function paramDisplay(spec) {
  if (spec.type !== 'enum') return spec.type;
  if (spec.values === 'apps') return 'app id';
  if (spec.values === 'windows') return 'window id';
  return (spec.values ?? []).join('|');
}

/**
 * One-line signature for the meta tools:
 * 'gridcraft.set_cells(start: string, values: table) - Write values or formulas into a block of cells.'
 * Optional params get '?'; an enum shows its values ('theme: light|dark'); a live enum shows
 * the list kind ('app: app id', 'window: window id').
 */
export function signature(tool) {
  const inner = Object.entries(tool?.params ?? {})
    .map(([key, spec]) => `${key}${spec.required ? '' : '?'}: ${paramDisplay(spec)}`)
    .join(', ');
  return `${tool.name}(${inner}) - ${tool.purpose ?? ''}`;
}

/**
 * packs: [{ pack: { id, title }, tools: [...] }] -> { tools: Map(name -> tool), docs, errors }.
 * A tool that fails any check is left out of both tools and docs; every problem goes into
 * errors so the build can report them all at once. docs are the search docs for the valid
 * tools: { id, name, title: pack.title, keywords (the name split on dots and underscores),
 * purpose, when, body (param descriptions plus the example says), signature }.
 *
 * opts: { choices, aliases } are passed through to checkArgs when validating examples;
 * without a choices provider a live-enum example ('apps'/'windows') cannot pass, because
 * the live list is unknown at build time.
 */
export function buildCatalog(packs, { choices = () => [], aliases = {} } = {}) {
  const tools = new Map();
  const docs = [];
  const errors = [];
  for (const entry of packs ?? []) {
    const pack = entry?.pack;
    const toolList = entry?.tools;
    if (!pack || typeof pack.id !== 'string' || !Array.isArray(toolList)) {
      errors.push(`pack ${pack?.id ?? '(missing)'}: the entry needs a pack with an id and a tools array`);
      continue;
    }
    const nameRe = new RegExp(`^${escapeRegExp(pack.id)}\\.[a-z0-9_]+$`);
    for (const tool of toolList) {
      const name = tool?.name;
      const problems = [];
      const label = typeof name === 'string' ? name : '(missing name)';
      if (typeof name !== 'string' || !nameRe.test(name)) {
        problems.push(`tool ${label}: the name must be '${pack.id}.<verb_object>' in lowercase [a-z0-9_]`);
      } else if (tools.has(name)) {
        problems.push(`tool ${label}: the name is already used by another pack`);
      }
      if (!EFFECTS.includes(tool?.effect)) problems.push(`tool ${label}: the effect must be one of ${EFFECTS.join(', ')}`);
      if (tool?.needs !== undefined && (!Array.isArray(tool.needs) || tool.needs.some(item => typeof item !== 'string'))) {
        problems.push(`tool ${label}: needs must be an array of strings`);
      }
      for (const problem of specErrors(tool?.params)) problems.push(`tool ${label}: ${problem}`);
      const examples = tool?.examples;
      if (examples !== undefined) {
        if (!Array.isArray(examples)) problems.push(`tool ${label}: examples must be an array`);
        else examples.forEach((example, index) => {
          const result = checkArgs(tool, example?.args, { choices, aliases });
          if (!result.ok) problems.push(`tool ${label}: example ${index + 1}: ${result.error.message}`);
        });
      }
      if (problems.length > 0) { errors.push(...problems); continue; }
      tools.set(name, tool);
      docs.push(searchDoc(pack, tool));
    }
  }
  return { tools, docs, errors };
}

// The search doc for one valid tool (search.mjs indexes exactly these fields).
function searchDoc(pack, tool) {
  const body = [
    ...Object.entries(tool.params ?? {}).map(([key, spec]) => `${key}: ${spec.description ?? ''}`),
    ...(tool.examples ?? []).map(example => `Example: ${example?.says ?? ''}`)
  ].join('\n');
  const seen = new Set();
  const keywords = [];
  for (const word of tool.name.split(/[._]+/).filter(Boolean)) {
    if (!seen.has(word)) { seen.add(word); keywords.push(word); }
  }
  return {
    id: tool.name,
    name: tool.name,
    title: pack.title ?? '',
    keywords,
    purpose: tool.purpose ?? '',
    when: tool.when ?? '',
    body,
    signature: signature(tool)
  };
}

/**
 * describe_tool text for a tool, at most 1200 characters: the name and purpose, the params
 * with types, choices and descriptions, the effect, one example callLine (the first
 * example) and the related skill paths. When the text is too long it is cut at a line
 * boundary (or hard at 1200 when a single line is longer).
 */
export function describe(tool, skillPaths = []) {
  const lines = [`${tool.name} - ${tool.purpose ?? ''}`];
  const entries = Object.entries(tool?.params ?? {});
  if (entries.length > 0) {
    lines.push('Params:');
    for (const [key, spec] of entries) {
      lines.push(`${key}: ${paramDisplay(spec)}${spec.required ? '' : ' (optional)'} - ${spec.description ?? ''}`);
    }
  }
  lines.push(`Effect: ${tool.effect}`);
  const exampleArgs = (tool.examples ?? [])[0]?.args;
  if (exampleArgs !== undefined) lines.push(`Example: ${callLine(tool.name, exampleArgs)}`);
  if (skillPaths.length > 0) lines.push(`Skills: ${skillPaths.join(', ')}`);
  const text = lines.join('\n');
  if (text.length <= DESCRIBE_MAX) return text;
  const cut = text.slice(0, DESCRIBE_MAX);
  const at = cut.lastIndexOf('\n');
  return at > 0 ? cut.slice(0, at) : cut;
}
