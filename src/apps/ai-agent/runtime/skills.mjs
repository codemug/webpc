// Buddy M1 part 2: parse app packs' skills.md files, check their steps against the tool
// catalog, and render a skill (or one section) capped for the read_skill meta tool.
// Pure module: runs in Node (build step, unit tests) and in the browser.
//
// skills.md shape (plan 4.2): several skills per file, each starting at a "## " line,
// followed by the required metadata lines slug:, summary:, keywords: and tools:, then the
// body sections When:, Steps:, Check: and the optional Gotchas:. A section may carry its
// content on the same line as the marker or on the following lines. Step lines use the
// exact flat call_tool form: "1. call_tool tool=<name> k=v k2=v2".

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const BODY_MAX = 1500;
const SUMMARY_MAX = 160;
const RENDER_MAX = 1800;
const SECTION_KEYS = ['when', 'steps', 'check', 'gotchas'];
const SECTION_NAMES = { when: 'When', steps: 'Steps', check: 'Check', gotchas: 'Gotchas' };

/**
 * Parse a skills.md file.
 *
 * markdown: the file text. packId: the pack id used for the skill paths.
 * Returns { skills, errors }: one skill object per "## " heading with
 * { path, slug, title, summary, keywords, tools, when, steps, check, gotchas, body },
 * where steps is [{ n, tool, args, line }] and body is the skill's raw markdown.
 * errors is a list of human-readable problems (missing metadata, bad slug, duplicate
 * slug, missing section, bad step line). Skills with problems are still returned, so a
 * caller can report them all at once.
 */
export function parseSkills(markdown, packId) {
  const lines = String(markdown).split(/\r?\n/);
  const skills = [];
  const errors = [];
  const seenSlugs = new Set();
  let i = 0;
  while (i < lines.length) {
    const heading = lines[i].match(/^##\s+(.*)$/);
    if (!heading) { i++; continue; }
    let end = i + 1;
    while (end < lines.length && !/^##\s+/.test(lines[end])) end++;
    const block = lines.slice(i + 1, end);
    skills.push(parseBlock(block, heading[1].trim(), packId, seenSlugs, errors));
    i = end;
  }
  return { skills, errors };
}

// One "## " block: the metadata lines before the first body section, then the sections.
function parseBlock(block, title, packId, seenSlugs, errors) {
  const label = title || '(untitled)';
  const fail = (message) => errors.push(`skill "${label}": ${message}`);
  if (!title) fail('missing title');
  const meta = {};
  const sections = { when: [], steps: [], check: [], gotchas: [] };
  const present = { when: false, steps: false, check: false, gotchas: false };
  let section = null;
  for (const raw of block) {
    const line = raw.trim();
    const sectionMatch = line.match(/^(When|Steps|Check|Gotchas):\s*(.*)$/);
    if (sectionMatch) {
      section = sectionMatch[1].toLowerCase();
      present[section] = true;
      if (sectionMatch[2]) sections[section].push(sectionMatch[2]);
      continue;
    }
    if (section === null) {
      const metaMatch = line.match(/^(slug|summary|keywords|tools):\s*(.*)$/);
      if (metaMatch) meta[metaMatch[1]] = metaMatch[2].trim();
      // anything else before the first section is ignored (it stays in body)
      continue;
    }
    if (line) sections[section].push(line);
  }
  const slug = meta.slug || '';
  if (!slug) fail("missing metadata 'slug'");
  if (!meta.summary) fail("missing metadata 'summary'");
  if (!meta.keywords) fail("missing metadata 'keywords'");
  if (!meta.tools) fail("missing metadata 'tools'");
  if (slug && !SLUG_RE.test(slug)) fail(`invalid slug "${slug}"`);
  if (slug && seenSlugs.has(slug)) fail(`duplicate slug "${slug}"`);
  if (slug) seenSlugs.add(slug);
  for (const key of ['when', 'steps', 'check']) {
    if (!present[key]) fail(`missing section '${SECTION_NAMES[key]}'`);
  }
  const steps = [];
  for (const line of sections.steps) {
    const parsed = parseStepLine(line);
    if (!parsed) fail(`bad step line: ${line}`);
    else steps.push(parsed);
  }
  return {
    path: slug ? `${packId}/${slug}` : null,
    slug,
    title,
    summary: meta.summary || '',
    keywords: splitList(meta.keywords),
    tools: splitList(meta.tools),
    when: sections.when.join('\n'),
    steps,
    check: sections.check.join('\n'),
    gotchas: sections.gotchas.join('\n'),
    body: block.join('\n').trim()
  };
}

// Comma-separated metadata values: trim each item, drop the empty ones.
function splitList(value) {
  if (!value) return [];
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

// "1. call_tool tool=<name> k=v k2=v2" -> { n, tool, args, line } or null when the line
// is not a well-formed step (bad numbering, missing tool=, unclosed quote).
function parseStepLine(line) {
  const head = line.match(/^(\d+)\.\s+call_tool\s+(.*)$/);
  if (!head) return null;
  const pairs = parsePairs(head[2]);
  if (!pairs || !pairs.tool) return null;
  const { tool, ...args } = pairs;
  return { n: parseInt(head[1], 10), tool, args, line };
}

// key=value pairs. A value runs until the next " <word>=" or the end of the line; a value
// wrapped in double quotes may hold " x=" text. The two-character sequence backslash-n
// inside a value becomes a newline. Returns null on an unclosed quote.
function parsePairs(source) {
  const out = {};
  let i = 0;
  while (true) {
    while (i < source.length && source[i] === ' ') i++;
    if (i >= source.length) break;
    let j = i;
    while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j++;
    const key = source.slice(i, j);
    if (!key || source[j] !== '=') return null;
    j++;
    let value;
    if (source[j] === '"') {
      let k = j + 1;
      while (k < source.length && source[k] !== '"') k++;
      if (k >= source.length) return null;
      value = source.slice(j + 1, k);
      i = k + 1;
    } else {
      let k = j;
      while (k < source.length && !(source[k] === ' ' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(source.slice(k + 1)))) k++;
      value = source.slice(j, k);
      i = k;
    }
    out[key] = value.replace(/\\n/g, '\n');
  }
  return out;
}

/**
 * Check parsed skills against the tool catalog.
 *
 * skills: the skills list from parseSkills. toolByName: (name) => tool or undefined.
 * opts.checkArgs: (tool, args) => { ok, args } | { ok: false, error }, the same contract
 * as args.mjs checkArgs, injected so this module does not import the args lane.
 * Returns an error list: unknown tools in steps or in the tools: metadata, step args
 * failing the injected checkArgs, a body over 1500 characters, a summary over 160.
 */
export function checkSkills(skills, toolByName, opts = {}) {
  const errors = [];
  for (const skill of skills) {
    const label = skill.path || skill.slug || skill.title || '(untitled)';
    for (const name of skill.tools) {
      if (!toolByName(name)) errors.push(`skill ${label}: unknown tool ${name} in tools`);
    }
    for (const step of skill.steps) {
      const tool = toolByName(step.tool);
      if (!tool) {
        errors.push(`skill ${label}: unknown tool ${step.tool} in step ${step.n}`);
        continue;
      }
      if (opts.checkArgs) {
        const result = opts.checkArgs(tool, step.args);
        if (!result.ok) errors.push(`skill ${label}: step ${step.n} ${step.tool}: ${result.error}`);
      }
    }
    if (skill.body.length > BODY_MAX) errors.push(`skill ${label}: body is ${skill.body.length} characters, max ${BODY_MAX}`);
    if (skill.summary.length > SUMMARY_MAX) errors.push(`skill ${label}: summary is ${skill.summary.length} characters, max ${SUMMARY_MAX}`);
  }
  return errors;
}

// The renderable blocks of a skill, in display order. The gotchas block is skipped when
// the skill has none, and an empty steps block is skipped too.
function blocksOf(skill) {
  const blocks = [{ name: null, text: `${skill.title}\n${skill.summary}` }];
  for (const key of SECTION_KEYS) {
    if (key === 'gotchas' && !skill.gotchas) continue;
    if (key === 'steps' && skill.steps.length === 0) continue;
    const text = key === 'steps'
      ? `${SECTION_NAMES.steps}:\n${skill.steps.map(step => step.line).join('\n')}`
      : `${SECTION_NAMES[key]}:\n${skill[key]}`;
    blocks.push({ name: SECTION_NAMES[key], text });
  }
  return blocks;
}

/**
 * Render a skill, or one section of it, as text for the read_skill meta tool.
 *
 * section: optional 'When', 'Steps', 'Check' or 'Gotchas' (case-insensitive); when given,
 * only that section is rendered. Unknown sections render as an empty string. max: the
 * total length cap, default 1800; when the text is cut, a trailing note
 * "(more: sections X, Y; or find_in_skill)" names the sections that were cut (a single
 * section cut only says "or find_in_skill").
 */
export function renderSkill(skill, section, max = RENDER_MAX) {
  const cap = Math.max(1, Math.trunc(max) || 1);
  const blocks = blocksOf(skill);
  let chosen = blocks;
  let sectionOnly = false;
  if (section) {
    const wanted = String(section).toLowerCase();
    const block = blocks.find(b => b.name !== null && b.name.toLowerCase() === wanted);
    if (!block) return '';
    chosen = [block];
    sectionOnly = true;
  }
  const full = chosen.map(block => block.text).join('\n\n');
  if (full.length <= cap) return full;
  // The note names the blocks the cut leaves out, or the block it slices; the note itself
  // counts against the cap, so cut, name the remainder, and re-cut until stable.
  let note = '\n(more: or find_in_skill)';
  for (let pass = 0; pass < 4; pass++) {
    const budget = Math.max(0, cap - note.length);
    const remaining = [];
    let offset = 0;
    for (const block of chosen) {
      if (offset >= budget || offset + block.text.length > budget) {
        if (block.name) remaining.push(block.name);
      }
      offset += block.text.length + 2;
    }
    const next = sectionOnly
      ? '\n(more: or find_in_skill)'
      : `\n(more: sections ${remaining.join(', ')}; or find_in_skill)`;
    if (next === note) break;
    note = next;
  }
  return full.slice(0, Math.max(0, cap - note.length)) + note;
}
