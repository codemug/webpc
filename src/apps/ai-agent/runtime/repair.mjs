// Repair of the mechanical call_tool mistakes the M0 spike models make, applied
// before args validation. Pure and total: any raw shape comes back as
// { tool, args, repairs } and the function never throws.
export const WINDOW_VERBS = ['open', 'close', 'minimize', 'maximize', 'focus', 'move', 'resize', 'restore'];
const TOOL_KEYS = ['tool', 'Tool', 'tool_name', 'name'];

// k=v pairs from the tail of a tool value; a value may be double-quoted to hold spaces.
function inlinePairs(text) {
  const pairs = {};
  const re = /(^|\s)([A-Za-z_][A-Za-z0-9_-]*)=("(?:[^"]*)"|\S+)/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    let value = match[3];
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    pairs[match[2]] = value;
  }
  return Object.keys(pairs).length ? pairs : null;
}

// An `arguments` value carrying a JSON object: a plain object or a JSON object string.
function cloudObject(value) {
  if (value != null && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // not a JSON object; the key is dropped like any consumed meta key
    }
  }
  return null;
}

/**
 * Raw call_tool arguments from a model -> { tool, args, repairs: [string] }
 * known(name) -> boolean: is this a catalog tool name. apps: catalog app ids. verbs: window verbs.
 */
export function repairCall(raw, { known, apps = [], verbs = WINDOW_VERBS } = {}) {
  const repairs = [];
  const isKnown = typeof known === 'function' ? known : () => false;
  const src = raw != null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const args = {};
  for (const [key, value] of Object.entries(src)) if (key !== 'tool' && key !== 'arguments') args[key] = value;
  let tool = '';
  let name = '';
  try {
    // 1. Key casing: Tool, tool_name and name are read as tool when tool is missing.
    let toolKey = null;
    for (const key of TOOL_KEYS) {
      const value = src[key];
      if (typeof value === 'string' && value.trim() !== '') { tool = value; toolKey = key; break; }
    }
    if (toolKey !== null && toolKey !== 'tool') { delete args[toolKey]; repairs.push(`read tool from ${toolKey}`); }
    // 2. Cloud arguments: an object or a JSON object string, merged under the explicit keys.
    const cloud = cloudObject(src.arguments);
    if (cloud) {
      for (const [key, value] of Object.entries(cloud)) if (!(key in args)) args[key] = value;
      repairs.push('merged arguments into args');
    }
    // 3. Inline pairs: a tool value like "<name> k=v k2=v2". Only split when the tail has pairs,
    // so a bare name with spaces ("Desktop Open-App") stays whole for the separator rule.
    const firstSpace = tool.search(/\s/);
    let head = tool;
    if (firstSpace !== -1) {
      const pairs = inlinePairs(tool.slice(firstSpace + 1));
      if (pairs) {
        head = tool.slice(0, firstSpace);
        for (const [key, value] of Object.entries(pairs)) if (!(key in args)) args[key] = value;
        repairs.push('parsed inline pairs from tool');
      }
    }
    name = head;
    // 4. Signature text: surrounding quotes or backticks, everything from the first (, a trailing " - purpose".
    let stripped = name.trim();
    if (stripped.length >= 2 && (stripped[0] === '"' || stripped[0] === "'" || stripped[0] === '`') && stripped.at(-1) === stripped[0]) stripped = stripped.slice(1, -1).trim();
    const paren = stripped.indexOf('(');
    if (paren !== -1) stripped = stripped.slice(0, paren);
    const dash = stripped.indexOf(' - ');
    if (dash !== -1) stripped = stripped.slice(0, dash);
    if (stripped !== name) { name = stripped; repairs.push('stripped signature text from tool'); }
    // 5. Case and separators: lowercase, spaces and / become ., - becomes _.
    const normalized = name.toLowerCase().replace(/[\s/]+/g, '.').replace(/-+/g, '_');
    if (normalized !== name) { name = normalized; repairs.push('normalised tool name'); }
    // 6b. Names built from skill paths: try known variants (drop _app/_window, add _app)
    // before the window-verb alias below.
    if (!isKnown(name)) {
      const candidates = [name.endsWith('_app') ? name.slice(0, -4) : null, name.endsWith('_window') ? name.slice(0, -7) : null, `${name}_app`].filter(Boolean);
      for (const candidate of candidates) if (isKnown(candidate)) { name = candidate; repairs.push(`matched ${candidate}`); break; }
    }
    // 6. Window-verb aliases for the app packs, only when the rewritten name is known.
    if (!isKnown(name)) {
      const dot = name.indexOf('.');
      const app = dot > 0 ? name.slice(0, dot) : '';
      const rest = dot > 0 ? name.slice(dot + 1) : '';
      for (const verb of verbs) {
        if (apps.includes(app) && (rest === verb || rest === `${verb}_app` || rest === `${verb}_window`)) {
          const rewritten = verb === 'open' ? 'desktop.open_app' : `desktop.${verb}`;
          if (isKnown(rewritten)) {
            if (args.app == null || args.app === '') args.app = app;
            repairs.push(`aliased ${name} to ${rewritten}`);
            name = rewritten;
          }
          break;
        }
      }
    }
    // 7. Unknown names stay as they are, for the caller to report unknown_tool.
  } catch {
    return { tool: '', args: {}, repairs: [] };
  }
  return { tool: name, args, repairs };
}
