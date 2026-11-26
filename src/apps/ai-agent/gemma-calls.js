// Gemma 4's tool-call markup to the canonical form the agent reads (parseToolCalls,
// agent.js). Measured verbatim on 2026-11-24 with the pinned Transformers.js 4.3.2
// (decoded with skip_special_tokens: false), Gemma writes a call as
//   <|tool_call>call:NAME{key:<|"|>value<|"|>,...}<tool_call|>
// and ends a plain answer with <turn|>. The value syntax is the chat template's
// format_argument macro (onnx-community/gemma-4-E2B-it-ONNX at
// 6f21c99d7e18237f8d2ce92aadfdbfeba877f63a): strings are wrapped in <|"|> ... <|"|>
// and their inner text is literal; numbers, booleans and null are bare; lists [...]
// and objects {key:value,...} nest. gemmaToCanonical turns every complete call into
// one canonical block (the tool_call open tag, function=NAME, a parameter tag per
// top-level key, the tool_call close tag), in order, and strips the control tokens
// from the rest, so the existing parseToolCalls reads the reply unchanged. A call cut
// off by the token limit is dropped whole, never half-parsed. gemmaVisible is the
// streaming view of a partial reply. Pure: no DOM, no imports.

const OPEN = '<|tool_call>';
const CLOSE = '<tool_call|>';
const QUOTE = '<|"|>';
// Control tokens stripped from the prose: both orderings of the tool_response pair,
// both turn tokens, <eos> and a leaked string quote.
const TOKEN_RE = /<turn\|>|<\|turn>|<\|tool_response>|<tool_response\|>|<eos>|<\|"\|>/g;
// For the streaming view, a suffix that is still a proper prefix of one of these is
// held back until the token is complete or ruled out.
const ALL_TOKENS = [OPEN, CLOSE, '<|tool_response>', '<tool_response|>', '<turn|>', '<|turn>', '<eos>', QUOTE];
// The canonical call tags parseToolCalls anchors on (written escaped so the raw tag
// bytes stay out of this file; at runtime each is the tag itself).
const TC_OPEN = '\u003ctool_call\u003e';
const TC_CLOSE = '\u003c/tool_call\u003e';
const clean = s => s.replace(TOKEN_RE, '');

// A parsed string value, tagged so it stays distinct from a nested object.
const STR = Symbol('gemma string value');
const isStr = node => node !== null && typeof node === 'object' && Object.hasOwn(node, STR);

/**
 * Translate a Gemma 4 reply to the canonical tool-call markup. Every complete
 * `<|tool_call>call:NAME{...}<tool_call|>` becomes one canonical block, in order;
 * each top-level key becomes a parameter whose value is the raw string (a string
 * value keeps its inner text exactly; a nested list or object becomes its JSON text;
 * a number, boolean or null its bare text). Gemma's control tokens are stripped from
 * the rest and an unterminated call tail is dropped. Plain prose is returned
 * unchanged.
 */
export function gemmaToCanonical(text) {
  const src = String(text ?? '');
  let out = '';
  let pos = 0;
  for (;;) {
    const i = src.indexOf(OPEN, pos);
    if (i === -1) { out += clean(src.slice(pos)); break; }
    const j = findClose(src, i + OPEN.length);
    if (j === -1) { out += clean(src.slice(pos, i)); break; } // unterminated tail: drop the rest
    out += clean(src.slice(pos, i));
    const parsed = parseCall(src.slice(i + OPEN.length, j));
    if (parsed) {
      out += block(parsed);
      pos = j + CLOSE.length;
    } else {
      const inner = src.indexOf(OPEN, i + OPEN.length);
      // A stray opening is dropped on its own so the real call behind it is still
      // found; an unparseable span is dropped whole.
      pos = inner !== -1 && inner < j ? i + OPEN.length : j + CLOSE.length;
    }
  }
  return out;
}

/**
 * The text a person may see of a still-streaming Gemma reply: everything before the
 * first call, with the control tokens stripped; a trailing partial token (a suffix
 * that could still grow into one) is held back, not shown.
 */
export function gemmaVisible(partial) {
  const src = String(partial ?? '');
  const i = src.indexOf(OPEN);
  const stripped = clean(i === -1 ? src : src.slice(0, i));
  let cut = 0;
  for (const token of ALL_TOKENS)
    for (let n = 1; n < token.length; n++)
      if (stripped.endsWith(token.slice(0, n))) cut = Math.max(cut, n);
  return stripped.slice(0, stripped.length - cut);
}

// The index of the call's closing token, or -1 when the span does not close. A closing
// token inside a <|"|> string is the value's literal text, not the end of the call.
function findClose(s, from) {
  let p = from;
  while (p < s.length) {
    if (s.startsWith(QUOTE, p)) {
      const end = s.indexOf(QUOTE, p + QUOTE.length);
      if (end === -1) return -1; // an unterminated string: the call cannot be complete
      p = end + QUOTE.length;
      continue;
    }
    if (s.startsWith(CLOSE, p)) return p;
    p += 1;
  }
  return -1;
}

// `call:NAME{...}` -> { name, params: [[key, value text], ...] } or null when the span
// is not a well-formed call.
function parseCall(content) {
  const c = content.trim();
  if (!c.startsWith('call:')) return null;
  const brace = c.indexOf('{');
  if (brace === -1) return null;
  const name = c.slice(5, brace).trim();
  if (!/^[\w.-]+$/.test(name)) return null;
  const v = parseValue(c, brace);
  if (!v || c.slice(v[1]).trim() !== '') return null;
  const root = v[0];
  if (root === null || typeof root !== 'object' || Array.isArray(root) || isStr(root)) return null;
  return { name, params: Object.entries(root).map(([k, val]) => [k, renderValue(val)]) };
}

// One value at s[p] (the span start is a '{', a '[' or a string quote). Returns
// [node, end index] or null.
function parseValue(s, p) {
  p = skipWs(s, p);
  if (s.startsWith(QUOTE, p)) {
    const end = s.indexOf(QUOTE, p + QUOTE.length);
    if (end === -1) return null;
    return [{ [STR]: s.slice(p + QUOTE.length, end) }, end + QUOTE.length];
  }
  if (s[p] === '[') {
    const items = [];
    p += 1;
    for (;;) {
      p = skipWs(s, p);
      if (s[p] === ']') return [items, p + 1];
      const v = parseValue(s, p);
      if (!v) return null;
      items.push(v[0]);
      p = skipWs(s, v[1]);
      if (s[p] === ',') { p += 1; continue; }
      if (s[p] === ']') return [items, p + 1]; // a trailing comma
      return null;
    }
  }
  if (s[p] === '{') {
    const obj = {};
    p += 1;
    for (;;) {
      p = skipWs(s, p);
      if (s[p] === '}') return [obj, p + 1];
      const colon = s.indexOf(':', p);
      if (colon === -1) return null;
      const key = s.slice(p, colon).trim();
      if (!key) return null;
      const v = parseValue(s, colon + 1);
      if (!v) return null;
      obj[key] = v[0];
      p = skipWs(s, v[1]);
      if (s[p] === ',') { p += 1; continue; }
      if (s[p] === '}') return [obj, p + 1];
      return null;
    }
  }
  // Bare: a number, true, false or null, up to the next delimiter.
  let end = p;
  while (end < s.length && !',}]'.includes(s[end])) end += 1;
  const raw = s.slice(p, end).trim();
  if (raw === 'true') return [true, end];
  if (raw === 'false') return [false, end];
  if (raw === 'null') return [null, end];
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(raw)) return [Number(raw), end];
  return null;
}

function skipWs(s, p) { while (p < s.length && /\s/.test(s[p])) p += 1; return p; }

// A node to its parameter text: a string keeps its inner text exactly; a number,
// boolean or null is its bare text; a list or object its JSON text.
function renderValue(node) {
  if (isStr(node)) return node[STR];
  if (node === null || typeof node !== 'object') return String(node);
  return JSON.stringify(toJS(node));
}

// A node to a plain JSON-compatible value (nested strings included).
function toJS(node) {
  if (isStr(node)) return node[STR];
  if (Array.isArray(node)) return node.map(toJS);
  if (node !== null && typeof node === 'object')
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, toJS(v)]));
  return node;
}

function block({ name, params }) {
  let out = `${TC_OPEN}<function=${name}>
`;
  for (const [key, value] of params) out += `<parameter=${key}>
${value}
</parameter>
`;
  return out + TC_CLOSE;
}
