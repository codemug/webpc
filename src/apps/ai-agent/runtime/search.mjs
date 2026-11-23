// Buddy M1 search lane: a thin wrapper around MiniSearch 7.x for the tool catalog and the
// skill index. Runs in Node (build step, unit tests) and in the browser (bundled by esbuild).
// The index is serialised as a small v1 envelope { v, index, docs } so the build step can
// ship it as a JSON file. The docs list carries the stored fields; MiniSearch itself stores
// nothing (storeFields is empty), which keeps the JSON lean.
import MiniSearch from 'minisearch';

/** Fields and boosts used for both the tool catalog and the skill index. */
export const FIELDS = ['name', 'title', 'keywords', 'purpose', 'when', 'summary', 'body'];
export const BOOST = { name: 3, title: 3, keywords: 2, purpose: 1.5, when: 1.5, summary: 1.5, body: 1 };

// Stop words dropped from queries before they reach MiniSearch (the brief list, verbatim).
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'is', 'it', 'my', 'me', 'please', 'can', 'you', 'i'
]);

// The same split the MiniSearch default tokenizer uses (whitespace plus any punctuation),
// so a cleaned query round-trips through the default tokenize and processTerm unchanged.
const SPLIT = /[\n\r\p{Z}\p{P}]+/u;

// One options object for the constructor and for loadJSON: MiniSearch wants the same
// options at load time as at build time. The OR semantics, prefix search and the field
// boosts live in searchOptions so every search applies them unless a call overrides them.
const OPTIONS = {
  idField: 'id',
  fields: FIELDS,
  storeFields: [],
  searchOptions: { combineWith: 'OR', prefix: true, boost: BOOST }
};

const REGEX_MAX_SOURCE = 200;
const LIMIT_MAX = 20;

/** Lowercase a query, split it on whitespace and punctuation, drop stop words, join with spaces. */
function cleanQuery(query) {
  const words = String(query).toLowerCase().split(SPLIT).filter(word => word && !STOP_WORDS.has(word));
  return words.join(' ');
}

/** Lowercase a query and split it on whitespace and punctuation, keeping stop words. */
function rawWords(query) {
  return String(query).toLowerCase().split(SPLIT).filter(Boolean);
}

/** Escape a plain word so it can be embedded in a RegExp source. */
function escapeRegExp(source) {
  return source.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

/** Copy the store-listed fields of a doc into a new object. */
function pickStored(doc, store) {
  const out = {};
  for (const key of store) {
    if (key in doc) out[key] = doc[key];
  }
  return out;
}

/**
 * Index the docs and return the serialised index as a JSON string (the v1 envelope).
 *
 * docs: [{ id, name?, title?, keywords?, purpose?, when?, summary?, body?, ...stored }]
 * store: the field names copied into each hit (carried in the envelope).
 * Throws on missing or duplicate ids: MiniSearch enforces both at add time.
 */
export function buildIndex(docs, { store = [] } = {}) {
  if (!Array.isArray(docs)) throw new Error('buildIndex: docs must be an array');
  const ms = new MiniSearch(OPTIONS);
  for (const doc of docs) ms.add(doc);
  const stored = docs.map(doc => ({ id: doc.id, ...pickStored(doc, store) }));
  return JSON.stringify({ v: 1, index: ms.toJSON(), docs: stored });
}

/**
 * Load the v1 envelope JSON (a string, or the parsed object) from buildIndex into a search handle.
 *
 * store: the stored fields each hit should carry, projected from the envelope docs.
 */
export function loadIndex(json, { store = [] } = {}) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  if (!data || data.v !== 1 || !data.index || !Array.isArray(data.docs)) {
    throw new Error('loadIndex: not a v1 search index envelope from buildIndex');
  }
  const ms = MiniSearch.loadJSON(JSON.stringify(data.index), OPTIONS);
  const docs = new Map();
  for (const doc of data.docs) docs.set(doc.id, { id: doc.id, ...pickStored(doc, store) });
  return { ms, docs };
}

// MiniSearch already sorts results by score, but its tie order is not guaranteed; re-sort
// with id as the tie-break so identical inputs always give identical order (determinism).
function sortResults(results) {
  return [...results].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// Turn sorted MiniSearch results into hits: { id, score, ...stored }, applying the optional
// filter before the limit and setting more when filtered results run past the limit.
function toHits(handle, results, filter, cap) {
  const hits = [];
  let more = false;
  for (const result of sortResults(results)) {
    const hit = { id: result.id, score: result.score, ...(handle.docs.get(result.id) || {}) };
    if (filter && !filter(hit)) continue;
    if (hits.length < cap) hits.push(hit);
    else { more = true; break; }
  }
  return { hits, more };
}

// The raw field values, the same fields MiniSearch indexes, joined for a single RegExp pass.
function textOf(doc) {
  return FIELDS.map(field => {
    const value = doc[field];
    if (value == null) return '';
    return Array.isArray(value) ? value.join(' ') : String(value);
  }).join('\n');
}

// Regex mode: the query is a RegExp source. Case-insensitive, global (so the score counts
// every match), at most 200 characters. Never throws: failures come back as error objects
// that keep the same shape as a normal result.
function regexStep(handle, source, docs, filter, cap) {
  if (source.length > REGEX_MAX_SOURCE) {
    return { hits: [], more: false, mode_used: 'regex', error: 'regex too long' };
  }
  let pattern;
  try {
    pattern = new RegExp(source, 'gi');
  } catch (err) {
    return { hits: [], more: false, mode_used: 'regex', error: 'invalid regex: ' + err.message };
  }
  if (!Array.isArray(docs)) {
    return { hits: [], more: false, mode_used: 'regex', error: 'docs option is required for regex mode' };
  }
  const rows = [];
  for (const doc of docs) {
    if (!doc || typeof doc.id !== 'string' || !handle.docs.has(doc.id)) continue;
    const matches = textOf(doc).match(pattern) || [];
    if (matches.length > 0) rows.push({ id: doc.id, score: matches.length });
  }
  rows.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  const hits = [];
  let more = false;
  for (const row of rows) {
    const hit = { id: row.id, score: row.score, ...(handle.docs.get(row.id) || {}) };
    if (filter && !filter(hit)) continue;
    if (hits.length < cap) hits.push(hit);
    else { more = true; break; }
  }
  return { hits, more, mode_used: 'regex' };
}

/**
 * Search a handle built by loadIndex.
 *
 * mode 'text' runs MiniSearch with OR, prefix and fuzzy 0.2. Mode 'regex' treats the query
 * as a RegExp source over the FIELDS values of the docs option. Mode 'auto' (the default)
 * tries text with fuzzy off, then text with fuzzy on, then an escaped regex of the longest
 * raw query word. limit: 1 to 20, default 5. filter: (hit) => boolean, applied before the
 * limit, and receives the stored fields plus id.
 *
 * Returns { hits: [{ id, score, ...stored }], mode_used, more }. A failed regex mode adds
 * an error string (hits stays an empty array and no exception is thrown).
 */
export function search(handle, query, { mode = 'auto', limit = 5, filter, docs } = {}) {
  const cap = Math.min(LIMIT_MAX, Math.max(1, Math.trunc(limit) || 1));
  if (mode === 'regex') {
    return regexStep(handle, String(query), docs, filter, cap);
  }
  const clean = cleanQuery(query);
  if (mode === 'text') {
    const results = clean ? handle.ms.search(clean, { fuzzy: 0.2 }) : [];
    return { ...toHits(handle, results, filter, cap), mode_used: 'text' };
  }
  // auto: exact text first, then fuzzy text, then escaped regex of the longest raw word.
  if (clean) {
    const exact = handle.ms.search(clean, { fuzzy: false });
    if (exact.length > 0) return { ...toHits(handle, exact, filter, cap), mode_used: 'text' };
    const fuzzy = handle.ms.search(clean, { fuzzy: 0.2 });
    if (fuzzy.length > 0) return { ...toHits(handle, fuzzy, filter, cap), mode_used: 'fuzzy' };
  }
  const longest = rawWords(query).reduce((best, word) => (word.length > best.length ? word : best), '');
  if (longest && Array.isArray(docs)) {
    const result = regexStep(handle, escapeRegExp(longest), docs, filter, cap);
    if (result.hits.length > 0) return result;
  }
  return { hits: [], more: false, mode_used: null };
}

/**
 * Return at most max characters of text around the first occurrence of any query term
 * (stop words dropped), or the first max characters when no term matches.
 */
export function excerpt(text, query, max = 200) {
  const source = String(text);
  const cap = Math.max(1, Math.trunc(max) || 1);
  if (source.length <= cap) return source;
  const clean = cleanQuery(query);
  if (!clean) return source.slice(0, cap);
  const lower = source.toLowerCase();
  const seen = new Set();
  let at = -1;
  for (const token of clean.split(' ')) {
    if (seen.has(token)) continue;
    seen.add(token);
    const index = lower.indexOf(token);
    if (index >= 0 && (at === -1 || index < at)) at = index;
  }
  if (at === -1) return source.slice(0, cap);
  const start = Math.max(0, Math.min(at - Math.floor(cap / 2), source.length - cap));
  return source.slice(start, start + cap);
}

// The packs every request may use; anything else is one app's own pack.
const GENERAL_PACKS = new Set(['system', 'desktop', 'files']);
const words = text => ` ${String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

/** App ids the text names by id or title as whole words: "Open LightCraft" -> ['lightcraft']. */
export function namedApps(text, apps = []) {
  const hay = words(text);
  return apps.filter(app => [app.id, app.title].some(name => name && hay.includes(words(name)))).map(app => app.id);
}

/**
 * Hit ids ("<pack>/<slug>" or "<pack>.<tool>") reordered for a request that names apps: other
 * apps' hits move after the named apps' and the general packs' hits; each group keeps its order.
 * Eval M6: "open LightCraft" ranked terminal/open-the-terminal first and the model opened the Terminal.
 */
export function preferNamed(ids, named = []) {
  if (!named.length) return ids;
  const rank = id => { const pack = String(id).split(/[/.]/)[0]; return named.includes(pack) || GENERAL_PACKS.has(pack) ? 0 : 1; };
  return ids.map((id, i) => [id, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([id]) => id);
}
