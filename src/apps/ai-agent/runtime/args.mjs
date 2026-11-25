// Buddy M1 args lane: flat parameter types, coercion and teaching errors.
// Local models send flat strings, cloud models send JSON values; both are coerced
// to the declared types, and every error carries a corrected callLine to copy.

const TYPES = ['string', 'text', 'integer', 'number', 'boolean', 'enum', 'list', 'table', 'path'];
const SPEC_FIELDS = ['type', 'required', 'description', 'values', 'default', 'min', 'max', 'flat'];
// Control characters (including newlines) and bidi-embedding characters that
// a Files path must not contain.
const BAD_CHARS = /[\u0000-\u001F\u007F\u00AD\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
const BOOL_TRUE = { true: 1, yes: 1, 1: 1, on: 1 };
const BOOL_FALSE = { false: 1, no: 1, 0: 1, off: 1 };
const DISPLAY_MAX = 60;

/** Trim, then strip one pair of matching wrapping quotes, then trim again. */
function unquote(value) {
  const text = String(value).trim(); return text.length >= 2 && ((text[0] === '"' && text.at(-1) === '"') || (text[0] === "'" && text.at(-1) === "'")) ? text.slice(1, -1).trim() : text;
}

/** Parse a string as a JSON array; null (never throws) when it is not one. */
function jsonArray(text) {
  try { const parsed = JSON.parse(text); return Array.isArray(parsed) ? parsed : null; }
  catch { return null; }
}

/** Show a raw value in an error message, capped so long text does not flood the context. */
function display(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value); return text.length > DISPLAY_MAX ? `${text.slice(0, DISPLAY_MAX - 3)}...` : text;
}

/** Edit distance (Levenshtein) between two strings. */
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const swap = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = swap;
    }
  }
  return row[b.length];
}

/** Edit-distance based closest matches, best first (ties by input order). */
export function closest(word, candidates, n = 3) {
  const w = String(word ?? '').toLowerCase();
  return candidates
    .map((candidate, index) => [candidate, index, distance(w, String(candidate).toLowerCase())])
    .sort((a, b) => a[2] - b[2] || a[1] - b[1])
    .slice(0, n)
    .map(row => row[0]);
}

/** `call_tool tool=<name> k=v ...`, the exact line form skills and errors use. */
export function callLine(name, args = {}) {
  const parts = [`call_tool tool=${name}`];
  for (const [key, value] of Object.entries(args)) parts.push(`${key}=${Array.isArray(value) ? value.map(lineValue).join(', ') : lineValue(value)}`);
  return parts.join(' ');
}

/**
 * A call line with a <name> placeholder for each argument and no values. Discovery surfaces
 * (find_tool, describe_tool, the prefetch note, skill steps) show this instead of an example,
 * because small models copy example values verbatim (eval M6).
 */
export function templateLine(name, keys = []) {
  return [`call_tool tool=${name}`, ...keys.map(key => `${key}=<${key}>`)].join(' ');
}

/** A skill step line with every call_tool value replaced by its placeholder; other lines unchanged. */
export function templateStep(line) {
  const text = String(line);
  const call = text.match(/call_tool tool=(\S+)/);
  if (!call) return text;
  const rest = text.slice(call.index + call[0].length);
  const keys = rest.split(/\s+(?=[A-Za-z_]\w*=)/).map(pair => pair.trim().match(/^([A-Za-z_]\w*)=/)?.[1]).filter(Boolean);
  return text.slice(0, call.index) + templateLine(call[1], keys);
}

// A16 (2026-11-25): small models paraphrase user content ("Guvf jnf" -> "Gvf jnf"). A text
// argument that carries the user's own content (input, text - never code, path, id) and is a
// near miss of a span of the user's message snaps back to that exact span. Case-sensitive on
// purpose: an uppercased or encoded form is far, not near, and never snaps.
const SNAP_PARAMS = new Set(['input', 'text']);
const SNAP_MIN = 5, SNAP_MAX = 80, SNAP_EDIT_MAX = 2;

/** Levenshtein distance with an early exit: never reports more than max + 1. */
function edWithin(a, b, max) {
  if (a === b) return 0;
  const n = a.length, m = b.length;
  if (Math.abs(n - m) > max) return max + 1;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= m; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[m];
}

/** The user-message span a near-miss argument snaps to, or null: null when the param is not
 *  user content, the value already is the user's text (verbatim), or no span is within
 *  min(2, 15% of the span length) edits. */
export function snapToUserText(userText, name, value) {
  if (!SNAP_PARAMS.has(name)) return null;
  const v = typeof value === 'string' ? value : '';
  const u = typeof userText === 'string' ? userText : '';
  if (v.length < SNAP_MIN || v.length > SNAP_MAX || u.length < v.length) return null;
  if (u.includes(v)) return null; // verbatim: it already is the user's own text
  let best = null;
  for (let len = Math.max(SNAP_MIN, v.length - SNAP_EDIT_MAX); len <= Math.min(u.length, v.length + SNAP_EDIT_MAX); len++) {
    const allowed = Math.min(SNAP_EDIT_MAX, 0.15 * len);
    for (let i = 0; i + len <= u.length; i++) {
      const span = u.slice(i, i + len);
      const d = edWithin(span, v, SNAP_EDIT_MAX);
      // Tie on distance: the longer span quotes more of the user's own text ('Guvf jnf' beats 'uvf jnf').
      if (d <= allowed && (!best || d < best.d || (d === best.d && span.length > best.span.length))) best = { d, span };
    }
  }
  return best ? best.span : null;
}

// Values in a call line stay on one line: newlines and tabs are escaped like skills.md step lines.
function lineValue(value) {
  if (value != null && typeof value === 'object') return JSON.stringify(value);
  return String(value).replace(/\n/g, '\\n').replace(/\t/g, '\\t');
}

/** ToolError carries a type and one corrected example call (fix) for the runtime. */
export class ToolError extends Error {
  constructor(type, message, fix) { super(message); this.name = 'ToolError'; this.type = type; this.fix = fix; }
}

/** A tool's params spec (tools.js `params`) -> list of problems with the spec itself ([] when fine). Used by the build. */
export function specErrors(params) {
  if (params == null || typeof params !== 'object' || Array.isArray(params)) return ['params must be a flat object of parameter specs'];
  const problems = [];
  for (const [name, spec] of Object.entries(params)) {
    const at = `params.${name}`;
    if (spec == null || typeof spec !== 'object' || Array.isArray(spec)) { problems.push(`${at}: the spec must be an object`); continue; }
    for (const field of Object.keys(spec)) if (!SPEC_FIELDS.includes(field)) problems.push(`${at}: unknown field '${field}'`);
    if (typeof spec.type !== 'string' || !TYPES.includes(spec.type)) { problems.push(['object', 'array', 'nested'].includes(spec.type) ? `${at}: the type '${spec.type}' is nested, params are flat` : `${at}: the type must be one of ${TYPES.join(', ')}`); continue; }
    if (typeof spec.description !== 'string' || !spec.description.trim()) problems.push(`${at}: a description is required`);
    if (spec.required !== undefined && typeof spec.required !== 'boolean') problems.push(`${at}: required must be a boolean`);
    if (spec.type === 'enum') {
      if (spec.values === undefined) problems.push(`${at}: an enum needs values`); else if (typeof spec.values === 'string') { if (!['apps', 'windows'].includes(spec.values)) problems.push(`${at}: live values must be 'apps' or 'windows'`); } else if (!Array.isArray(spec.values) || spec.values.some(v => typeof v !== 'string' || !v.trim())) problems.push(`${at}: values must be an array of non-empty strings or 'apps'/'windows'`);
    } else if (spec.values !== undefined) problems.push(`${at}: values is only allowed on an enum`);
    for (const bound of ['min', 'max']) if (spec[bound] !== undefined) {
      if (spec.type !== 'integer' && spec.type !== 'number') { problems.push(`${at}: ${bound} is only allowed on integer and number`); continue; }
      if (typeof spec[bound] !== 'number' || !Number.isFinite(spec[bound])) problems.push(`${at}: ${bound} must be a finite number`);
    }
    if (spec.default !== undefined && !['string', 'number', 'boolean'].includes(typeof spec.default) && !Array.isArray(spec.default)) problems.push(`${at}: default must be a string, number, boolean or array`);
  }
  return problems;
}

/** Canonical enum values: a static array, or the live list behind 'apps'/'windows'. */
function enumValues(spec, choices) {
  if (typeof spec.values === 'string') { const live = choices(spec.values); return Array.isArray(live) ? live.filter(v => typeof v === 'string' && v.trim()) : []; }
  return spec.values ?? [];
}

/** Split one table row into cells on tabs (when any tab is present) or on commas outside double quotes. */
function splitRow(line, separator) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; current += ch; }
    else if (ch === separator && !inQuotes) { cells.push(current); current = ''; }
    else current += ch;
  }
  cells.push(current);
  return cells.map(cell => { const text = cell.trim(); return text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text; });
}

function coerce(spec, value, values, aliases, key = 'value') {
  switch (spec.type) {
    case 'string': // single line: inner whitespace runs collapse to one space
      return typeof value === 'string' ? { ok: true, value: unquote(value).replace(/\s+/g, ' ') } : { ok: false };
    case 'text': // long free text: inner newlines kept
      return typeof value === 'string' ? { ok: true, value: unquote(value) } : { ok: false };
    case 'integer':
    case 'number': {
      let num;
      if (typeof value === 'number') num = value;
      else if (typeof value === 'string') {
        const text = unquote(value);
        if (spec.type === 'integer') { if (!/^-?\d+$/.test(text)) return { ok: false }; num = Number(text); }
        else { if (!text) return { ok: false }; num = Number(text); }
      } else return { ok: false };
      if (!Number.isFinite(num) || (spec.type === 'integer' && !Number.isInteger(num))) return { ok: false };
      const parts = [];
      if (spec.min !== undefined) parts.push(`at least ${spec.min}`);
      if (spec.max !== undefined) parts.push(`at most ${spec.max}`);
      const article = spec.type === 'integer' ? 'an integer' : 'a number';
      // The corrected value is the nearest bound: the closest valid one.
      if (spec.min !== undefined && num < spec.min || spec.max !== undefined && num > spec.max) return { ok: false, article, bounds: parts, closest: num < spec.min ? spec.min : spec.max };
      return { ok: true, value: num };
    }
    case 'boolean': {
      if (typeof value === 'boolean') return { ok: true, value };
      if (value === 1 || value === 0) return { ok: true, value: value === 1 };
      if (typeof value === 'string') { const text = unquote(value).toLowerCase(); if (text in BOOL_TRUE) return { ok: true, value: true }; if (text in BOOL_FALSE) return { ok: true, value: false }; }
      return { ok: false };
    }
    case 'enum': {
      const text = unquote(String(value));
      const hit = values.find(candidate => candidate.toLowerCase() === text.toLowerCase() || aliases[text.toLowerCase()]?.toLowerCase() === candidate.toLowerCase());
      return hit ? { ok: true, value: hit } : { ok: false, closest: closest(text, values, 1)[0] };
    }
    case 'list': {
      // A string that parses as a JSON array (cloud models) wins over text splitting.
      const source = typeof value === 'string' ? (jsonArray(unquote(value)) ?? value) : value;
      let items;
      if (Array.isArray(source)) {
        items = [];
        for (const item of source) {
          if (typeof item === 'string') { const text = item.trim(); if (text) items.push(text); }
          else if (typeof item === 'number' || typeof item === 'boolean') items.push(String(item));
          else return { ok: false };
        }
      } else if (typeof source === 'string') {
        const text = unquote(source);
        items = (text.includes('\n') ? text.split('\n') : text.split(',')).map(part => part.trim()).filter(part => part !== '');
      } else return { ok: false };
      return { ok: true, value: items };
    }
    case 'table': {
      const source = typeof value === 'string' ? (jsonArray(unquote(value)) ?? value) : value;
      let rows;
      if (Array.isArray(source)) {
        // A flat list of several scalars is ambiguous: one row or a column of one-cell
        // rows, and the engine writes it silently either way. Specs with `flat: false`
        // refuse it and show both forms with the given values (gridcraft.set_cells,
        // 2026-11-25 A/B: lfm3 sent the budget header row flat and it wrote one column).
        if (spec.flat === false && source.length > 1 && source.every(cell => cell != null && (typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean'))) {
          // A27 (build 18, from WAB's gridcraft-12): the refusal carries a copyable rows-form fix
          // line built from the given values - lfm3 retried the identical flat list three times
          // when the error only showed both JSON forms. callLine renders the flat list as the
          // rows-form call line (grid=Date, Income), which the table coercion parses as one row;
          // shortcut: a cell containing a comma would re-parse ambiguously - the message's
          // nested JSON form is the unambiguous copy for that case.
          return { ok: false, message: `a flat list of ${source.length} values is ambiguous: ${key}=${JSON.stringify([source])} writes a row; ${key}=${JSON.stringify(source.map(cell => [cell]))} writes a column`, fixRows: source };
        }
        rows = [];
        for (const row of source) {
          if (typeof row === 'string') rows.push(splitRow(row.trim(), row.includes('\t') ? '\t' : ','));
          else if (Array.isArray(row)) {
            if (row.some(cell => typeof cell !== 'string' && typeof cell !== 'number' && typeof cell !== 'boolean')) return { ok: false };
            rows.push(row.map(cell => (typeof cell === 'string' ? cell.trim() : String(cell))));
          } else return { ok: false };
        }
      } else if (typeof source === 'string') {
        // A29 (build 20, from gridcraft-05): a single-line comma string is ambiguous in exactly
        // the same way as a flat list - the model re-sent the refused flat list as one CSV
        // string and it was accepted as one row of six cells (silent wrong success). Strings
        // with newlines keep the string form: one row per line, cells by comma/tab.
        if (spec.flat === false && !source.includes('\n')) {
          const cells = splitRow(source.trim(), source.includes('\t') ? '\t' : ',');
          if (cells.length > 1) {
            return { ok: false, message: `a single-line comma string is ambiguous: ${key}=${JSON.stringify([cells])} writes a row; ${key}=${JSON.stringify(cells.map(cell => [cell]))} writes a column`, fixRows: cells };
          }
        }
        rows = source.split('\n').map(line => line.trim()).filter(line => line !== '').map(line => splitRow(line, line.includes('\t') ? '\t' : ','));
      } else return { ok: false };
      return { ok: true, value: rows };
    }
    case 'path': {
      if (typeof value !== 'string') return { ok: false };
      const text = unquote(value);
      if (!text || BAD_CHARS.test(text)) return { ok: false };
      const path = text.startsWith('/') ? text : `/${text}`;
      if (path.split('/').some(segment => segment === '..')) return { ok: false };
      return { ok: true, value: path };
    }
    default:
      return { ok: false };
  }
}

/** One corrected callLine from the tool's first example, with the bad value replaced. */
function fixLine(tool, param, replacement, liveApp) {
  const example = tool?.examples?.[0]?.args ?? {};
  // A path in a fix line is always a placeholder: the model copies fix lines, and an example
  // path ("/PDFCraft/contract.pdf") sent it to a file that does not exist (eval M6, B16).
  const isPath = key => tool.params?.[key]?.type === 'path';
  const args = Object.fromEntries(Object.entries(example).map(([key, value]) => [key, isPath(key) ? `<${key}>` : value]));
  if (param) {
    const spec = tool.params?.[param];
    // B17: a live app/window enum never shows a fixed example app - a small model copies fix
    // lines verbatim, and desktop.open_app's example (gridcraft) opened the wrong app (09).
    // The context app wins; with none, the placeholder, which the guard refuses cleanly.
    const isLiveEnum = spec?.type === 'enum' && ['apps', 'windows'].includes(spec?.values);
    const placeholder = spec?.type === 'enum' ? (enumValues(spec, () => []))[0] ?? '' : spec?.type === 'boolean' ? 'true' : spec && ['integer', 'number'].includes(spec.type) ? (spec.min ?? 0) : spec?.type === 'path' ? '/' : spec && ['list', 'table'].includes(spec.type) ? 'a' : '';
    // A29: for a flat:false table the copyable retry must be the JSON rows form - a single-line
    // CSV string is refused by the table coercion as ambiguous (it is the flat list's twin).
    const isStrictTable = spec?.type === 'table' && spec.flat === false;
    args[param] = replacement !== undefined ? (isStrictTable && Array.isArray(replacement) ? JSON.stringify([replacement]) : replacement) : isPath(param) ? `<${param}>` : isLiveEnum ? (liveApp ?? `<${param}>`) : example[param] ?? placeholder;
  }
  return callLine(tool.name, args);
}

/** Expected-value phrase for an invalid_argument message; long enum lists are capped. */
function expected(spec, values) {
  if (spec.type !== 'enum') return spec.type;
  if (!values.length) return 'one of the available choices';
  const shown = values.length > 12 ? `${values.slice(0, 12).join('|')}, ... (${values.length - 12} more)` : values.join('|');
  return `one of ${shown}`;
}

// Schema-aware fixes for the argument mistakes small models make (lfm3-1.7b on eval task C16,
// 2026-11-24: `query=uname -a`, then `arg=lang=sh code=uname -a`, for terminal.run). Pure; the
// raw object comes back unchanged when no rule applies.
// 1. An unknown key whose string value spells the tool's own key=value pairs is split into them
//    (the last value runs to the end, so `code=uname -a` keeps its spaces). `key: value` colons
//    count as separators too (lfm3-1.7b sent tool_param="new: true", J2 effectcraft 0/12).
// 2. Then, if exactly one unknown key is left and exactly one required string or text parameter
//    is missing, the value moves to that parameter.
const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function ownPairs(text, names) {
  if (!names.length) return null;
  // Pairs also separate on a comma or semicolon (lfm3-1.7b sweep b17 cyberchef-01/02 sent
  // tool_param "recipe=SHA256,input=4865"; the comma form used to swallow the second pair
  // into the first value - "unknown operation(s) input=4865..."). A multi-op recipe like
  // "From_Hex,To_Upper_case,To_Base64" keeps its commas: only a declared param name splits.
  // The boundary eats the whole separator run, so ", input=" leaves no trailing comma.
  const marks = [...text.matchAll(new RegExp(`(?:^|[\\s,;]+)(${names.map(escapeRe).join('|')})[:=]`, 'g'))];
  if (!marks.length || text.slice(0, marks[0].index).trim()) return null;
  const out = {};
  marks.forEach((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    out[mark[1]] = unquote(text.slice(mark.index + mark[0].length, end).trim());
  });
  return out;
}
/** A JSON object (or its JSON text) sent under a key the tool does not have, else null. Its keys
 *  are unwrapped even when some are wrong: the error then names the wrong inner key, and one stray
 *  key can still fill the one missing required param (lfm3-1.7b sent parameters="{\"layout\": ...}"). */
function ownObject(value) {
  let obj = value;
  if (typeof value === 'string' && value.trim().startsWith('{')) { try { obj = JSON.parse(value); } catch { return null; } }
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  return Object.keys(obj).length ? obj : null;
}
/** A loose single-line object the small models type instead of JSON (cadcraft-06: "{handles:
 *  line, from: [0, 0]}"; filmcraft-03: "{ item: beach-sunset.jpg, track: V1, seconds: 0 }"):
 *  unquoted keys and values, top-level "key: value" pairs, top-level commas only (an [x,y]
 *  list keeps its own). Null when the text is not a loose object. */
export function looseObject(text) {
  const source = String(text ?? '').trim();
  if (!source.startsWith('{') || !source.endsWith('}') || source.includes('\n')) return null;
  const out = {};
  let depth = 0, pair = '';
  for (const ch of source.slice(1, -1)) {
    if (ch === '[') depth += 1;
    else if (ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) { addLoosePair(out, pair); pair = ''; continue; }
    pair += ch;
  }
  addLoosePair(out, pair);
  return Object.keys(out).length ? out : null;
}
// One "key: value" pair of a loose object, in place; a pair without a colon is skipped.
function addLoosePair(out, pair) {
  const sep = pair.indexOf(':');
  if (sep <= 0) return;
  out[pair.slice(0, sep).trim().replace(/^['"]|['"]$/g, '')] = looseValue(pair.slice(sep + 1));
}
// A param value of a loose object or key=value line: an [a,b] point or list, true/false, a
// number, or the string itself.
export const looseValue = raw => {
  const value = String(raw).trim();
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('[') && value.endsWith(']')) {
    const parts = value.slice(1, -1).split(',').map(part => part.trim()).filter(part => part !== '');
    const nums = parts.map(Number);
    if (parts.length && nums.every(n => !Number.isNaN(n))) return nums;
  }
  return value;
};

export function repairArgs(tool, raw) {
  const params = tool?.params ?? {};
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const names = Object.keys(params);
  let args = { ...raw };
  for (const key of Object.keys(args)) {
    // The model wraps the whole call in a parameter the tool already declares (the run_command
    // family declares params=): params="{\"command\": ..., \"params\": {...}}" (lfm3-1.7b, J2
    // cadcraft 0/2, effectcraft 0/12). Unwrap only when the object carries a missing required
    // param, so a legitimate params={"center": ...} next to a present command= is never touched.
    if (!params[key]) continue;
    const inner = ownObject(args[key]);
    if (!inner) continue;
    const lacking = names.filter(name => params[name].required && (args[name] == null || args[name] === ''));
    if (!lacking.length || !Object.keys(inner).some(name => lacking.includes(name))) continue;
    const { [key]: _spent, ...rest } = args;
    const merged = { ...rest };
    for (const [innerKey, value] of Object.entries(inner)) {
      const slot = params[innerKey];
      merged[innerKey] = (slot?.type === 'text' || slot?.type === 'string') && value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
    }
    args = merged;
  }
  for (const key of Object.keys(args).filter(k => !params[k])) {
    // lfm3-1.7b wrapped its args as params="{\"text\": \"line 0,0 10,0\"}" (journey cadcraft-01).
    // A25: the same wrap as a LOOSE object (unquoted keys, filmcraft-03: args="{ item: beach-
    // sunset.jpg, track: V1, seconds: 0 }") - unwrap it here; left to the rule below it would
    // hand the whole blob to the one required param and loop on "item <blob> not in the project".
    const value = args[key];
    const pairs = ownObject(value) ?? (typeof value === 'string' ? looseObject(value) ?? ownPairs(value, names) : null);
    if (!pairs) continue;
    const { [key]: _spent, ...rest } = args;
    args = { ...pairs, ...rest };
  }
  // lfm3-1.7b passed the owning app as an argument (files.list app=files, carried over from
  // find_tool's own app parameter): it is redundant, so an unknown app key spelling the
  // tool's own app prefix is dropped instead of costing rounds on unknown_argument.
  const appPrefix = String(tool?.name ?? '').split('.')[0];
  if (appPrefix && args.app != null && !params.app && String(args.app).toLowerCase() === appPrefix) delete args.app;
  // lfm3-1.7b sent the run_command tools' params as a JSON object, {"cell": "B2", "input":
  // "Hello"} (gridcraft-08). A parameter named params that is text or string, given an object
  // or its JSON text, becomes key=value lines; the object's shape is the call, not content.
  for (const [key, spec] of Object.entries(params)) {
    if (key !== 'params' || !['text', 'string'].includes(spec.type)) continue;
    const obj = ownObject(args[key]);
    if (obj) args[key] = Object.entries(obj).map(([name, value]) => `${name}=${typeof value === 'object' && value !== null ? JSON.stringify(value) : value}`).join('\n');
  }
  // lfm3-1.7b spelled the command id inside the params text, "command=cell.set cell=A2
  // input=100" (gridcraft-09). A missing required string parameter spelled as the first pair
  // of a given string parameter moves out.
  for (const name of names) {
    if (!params[name].required || params[name].type !== 'string' || (args[name] != null && args[name] !== '')) continue;
    for (const key of Object.keys(args)) {
      if (key === name || typeof args[key] !== 'string') continue;
      const match = new RegExp(`^\\s*${name}=(?:"([^"]*)"|(\\S+))`).exec(args[key]);
      if (!match) continue;
      args[name] = match[1] ?? match[2];
      args[key] = args[key].slice(match[0].length).trim();
      break;
    }
  }
  const unknown = Object.keys(args).filter(k => !params[k]);
  const missing = names.filter(k => params[k].required && (args[k] == null || args[k] === ''));
  if (unknown.length === 1 && missing.length === 1 && ['string', 'text'].includes(params[missing[0]].type) && typeof args[unknown[0]] === 'string') {
    const { [unknown[0]]: value, ...rest } = args;
    args = { ...rest, [missing[0]]: value };
  }
  return args;
}

// A copied template slot: <key> itself, or a generic slot word (lfm3-1.7b sent input=<text> to
// cyberchef.bake). Real angle-bracket input such as <b> or <div> is not a slot word, so it passes.
const SLOT_WORDS = new Set(['text', 'value', 'input', 'string', 'number', 'name', 'path', 'query', 'your text', 'user text']);
function isPlaceholder(text, key, spec) {
  const slot = /^<([a-z_ ]+)>$/i.exec(text)?.[1]?.toLowerCase();
  return Boolean(slot) && (slot === key.toLowerCase() || slot === spec?.type || SLOT_WORDS.has(slot));
}

/**
 * Raw args (strings from local models, or JSON values from cloud) -> { ok: true, args } | { ok: false, error }
 * tool: { name, params }. choices: (name) => string[] for live enums ('apps', 'windows').
 * aliases: { [enumValueLower]: canonical } extra matches, e.g. { 'grid craft': 'gridcraft', 'dark mode': 'dark' }.
 */
export function checkArgs(tool, raw, { choices = () => [], aliases = {}, liveApp = null } = {}) {
  const params = tool?.params ?? {};
  // Zero-parameter tools ignore whatever the model sends (vectorcraft undo/redo, j3 b14: the
  // model wrapped every call in an args= blob and "has no parameter args; it takes: " dead-ended
  // the journey). There is nothing to validate, so there is nothing to refuse.
  if (Object.keys(params).length === 0) return { ok: true, args: {} };
  const given = raw != null && typeof raw === 'object' && !Array.isArray(raw) ? repairArgs(tool, raw) : {};
  const args = {};
  const absent = key => given[key] == null || (typeof given[key] === 'string' && unquote(given[key]) === '');
  for (const [key, value] of Object.entries(given)) {
    const spec = params[key];
    if (!spec) return { ok: false, error: { type: 'unknown_argument', message: `${tool.name} has no parameter ${key}; it takes: ${Object.keys(params).join(', ')}`, fix: fixLine(tool) } };
    if (absent(key)) continue; // an empty or null slot counts as absent: required params error, optional params get their default
    // A copied <key> placeholder on a parameter with a default means the default (lfm3-1.7b sent
    // lang=<lang> to terminal.run on eval task C17); without a default it is an error.
    if (typeof value === 'string' && isPlaceholder(unquote(value), key, spec) && spec.default !== undefined) { args[key] = spec.default; continue; }
    if (typeof value === 'string' && isPlaceholder(unquote(value), key, spec)) return { ok: false, error: { type: 'placeholder', message: `${key}=<${key}> is a placeholder: put the user's own ${key} there (${spec.description ?? spec.type}).`, fix: '' } };
    const values = spec.type === 'enum' ? enumValues(spec, choices) : [];
    const out = coerce(spec, value, values, aliases, key);
    if (!out.ok) {
      // A coerce failure can carry its own teaching message (the flat table refusal); it
      // wins over the generic "must be a table" line.
      if (out.message) return { ok: false, error: { type: 'invalid_argument', message: `${key}: ${out.message}`, fix: out.fix ?? (out.fixRows ? fixLine(tool, key, out.fixRows) : '') } };
      const message = out.bounds ? `${key} must be ${out.article} ${out.bounds.join(' and ')}; got "${display(value)}"` : `${key} must be ${expected(spec, values)}; got "${display(value)}"${out.closest ? `; did you mean ${out.closest}?` : ''}`;
      return { ok: false, error: { type: 'invalid_argument', message, fix: fixLine(tool, key, out.closest) } };
    }
    args[key] = out.value;
  }
  for (const [key, spec] of Object.entries(params)) {
    if (spec.required && absent(key)) return { ok: false, error: { type: 'missing_argument', message: `${tool.name} needs ${key} (${spec.description})`, fix: fixLine(tool, key, undefined, liveApp) } };
  }
  for (const [key, spec] of Object.entries(params)) if (absent(key) && spec.default !== undefined) args[key] = spec.default;
  return { ok: true, args };
}
