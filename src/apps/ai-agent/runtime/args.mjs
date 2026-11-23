// Buddy M1 args lane: flat parameter types, coercion and teaching errors.
// Local models send flat strings, cloud models send JSON values; both are coerced
// to the declared types, and every error carries a corrected callLine to copy.

const TYPES = ['string', 'text', 'integer', 'number', 'boolean', 'enum', 'list', 'table', 'path'];
const SPEC_FIELDS = ['type', 'required', 'description', 'values', 'default', 'min', 'max'];
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

function coerce(spec, value, values, aliases) {
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
        rows = [];
        for (const row of source) {
          if (typeof row === 'string') rows.push(splitRow(row.trim(), row.includes('\t') ? '\t' : ','));
          else if (Array.isArray(row)) {
            if (row.some(cell => typeof cell !== 'string' && typeof cell !== 'number' && typeof cell !== 'boolean')) return { ok: false };
            rows.push(row.map(cell => (typeof cell === 'string' ? cell.trim() : String(cell))));
          } else return { ok: false };
        }
      } else if (typeof source === 'string') {
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
function fixLine(tool, param, replacement) {
  const example = tool?.examples?.[0]?.args ?? {};
  // A path in a fix line is always a placeholder: the model copies fix lines, and an example
  // path ("/PDFCraft/contract.pdf") sent it to a file that does not exist (eval M6, B16).
  const isPath = key => tool.params?.[key]?.type === 'path';
  const args = Object.fromEntries(Object.entries(example).map(([key, value]) => [key, isPath(key) ? `<${key}>` : value]));
  if (param) {
    const spec = tool.params?.[param];
    const placeholder = spec?.type === 'enum' ? (enumValues(spec, () => []))[0] ?? '' : spec?.type === 'boolean' ? 'true' : spec && ['integer', 'number'].includes(spec.type) ? (spec.min ?? 0) : spec?.type === 'path' ? '/' : spec && ['list', 'table'].includes(spec.type) ? 'a' : '';
    args[param] = replacement !== undefined ? replacement : isPath(param) ? `<${param}>` : example[param] ?? placeholder;
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

/**
 * Raw args (strings from local models, or JSON values from cloud) -> { ok: true, args } | { ok: false, error }
 * tool: { name, params }. choices: (name) => string[] for live enums ('apps', 'windows').
 * aliases: { [enumValueLower]: canonical } extra matches, e.g. { 'grid craft': 'gridcraft', 'dark mode': 'dark' }.
 */
export function checkArgs(tool, raw, { choices = () => [], aliases = {} } = {}) {
  const params = tool?.params ?? {};
  const given = raw != null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const args = {};
  const absent = key => given[key] == null || (typeof given[key] === 'string' && unquote(given[key]) === '');
  for (const [key, value] of Object.entries(given)) {
    const spec = params[key];
    if (!spec) return { ok: false, error: { type: 'unknown_argument', message: `${tool.name} has no parameter ${key}; it takes: ${Object.keys(params).join(', ')}`, fix: fixLine(tool) } };
    if (absent(key)) continue; // an empty or null slot counts as absent: required params error, optional params get their default
    if (typeof value === 'string' && unquote(value) === `<${key}>`) return { ok: false, error: { type: 'placeholder', message: `${key}=<${key}> is a placeholder: put the user's own ${key} there (${spec.description ?? spec.type}).`, fix: '' } };
    const values = spec.type === 'enum' ? enumValues(spec, choices) : [];
    const out = coerce(spec, value, values, aliases);
    if (!out.ok) {
      const message = out.bounds ? `${key} must be ${out.article} ${out.bounds.join(' and ')}; got "${display(value)}"` : `${key} must be ${expected(spec, values)}; got "${display(value)}"${out.closest ? `; did you mean ${out.closest}?` : ''}`;
      return { ok: false, error: { type: 'invalid_argument', message, fix: fixLine(tool, key, out.closest) } };
    }
    args[key] = out.value;
  }
  for (const [key, spec] of Object.entries(params)) {
    if (spec.required && absent(key)) return { ok: false, error: { type: 'missing_argument', message: `${tool.name} needs ${key} (${spec.description})`, fix: fixLine(tool, key) } };
  }
  for (const [key, spec] of Object.entries(params)) if (absent(key) && spec.default !== undefined) args[key] = spec.default;
  return { ok: true, args };
}
