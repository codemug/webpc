// Buddy's Markdown renderer. Model answers are untrusted text, so Markdown becomes DOM nodes
// through a syntax tree (mdast), never through innerHTML or an HTML string. markdownTree is
// pure and DOM-free (the unit tests check it); renderMarkdown walks the same tree with
// createElement, setAttribute and createTextNode only.
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

const LANG = /^[\w+-]{1,20}$/;
const OPEN = { target: '_blank', rel: 'noopener noreferrer' };
const textNode = value => ({ text: String(value ?? '') });
const kids = node => (node?.children ?? []).flatMap(toNode);

// A URL the panel may open: http:, https: or mailto: parsed with URL; anything else is null.
function safeHref(url) {
  try {
    const href = new URL(String(url ?? ''));
    return ['http:', 'https:', 'mailto:'].includes(href.protocol) ? href.href : null;
  } catch {
    return null;
  }
}

// Map one mdast node to zero or more safe nodes ({ tag, attrs?, children? } or { text }).
// Only the node types in the allowlist produce markup; everything else becomes plain text.
function toNode(node) {
  switch (node?.type) {
    case 'paragraph': return [{ tag: 'p', children: kids(node) }];
    case 'strong': return [{ tag: 'strong', children: kids(node) }];
    case 'emphasis': return [{ tag: 'em', children: kids(node) }];
    case 'delete': return [{ tag: 'del', children: kids(node) }];
    case 'inlineCode': return [{ tag: 'code', children: [textNode(node.value)] }];
    case 'break': return [{ tag: 'br' }];
    case 'thematicBreak': return [{ tag: 'hr' }];
    case 'blockquote': return [{ tag: 'blockquote', children: kids(node) }];
    case 'code': {
      const lang = typeof node.lang === 'string' && LANG.test(node.lang) ? node.lang : null;
      const code = { tag: 'code', children: [textNode(node.value)] };
      if (lang) code.attrs = { class: `language-${lang}` };
      return [{ tag: 'pre', children: [code] }];
    }
    case 'list': {
      const list = { tag: node.ordered ? 'ol' : 'ul', children: kids(node) };
      if (node.ordered && node.start != null && node.start !== 1) list.attrs = { start: String(node.start) };
      return [list];
    }
    case 'listItem': {
      const items = kids(node);
      if (typeof node.checked === 'boolean') items.unshift(textNode(node.checked ? '☑ ' : '☐ '));
      return [{ tag: 'li', children: items }];
    }
    case 'heading': return [{ tag: node.depth <= 2 ? 'h3' : node.depth === 3 ? 'h4' : 'h5', children: kids(node) }];
    case 'link': {
      const href = safeHref(node.url);
      return href ? [{ tag: 'a', attrs: { href, ...OPEN }, children: kids(node) }] : kids(node);
    }
    case 'image': {
      const label = textNode(`[image: ${String(node.alt ?? '')}]`);
      const href = safeHref(node.url);
      const web = href && (href.startsWith('http://') || href.startsWith('https://'));
      return web ? [{ tag: 'a', attrs: { href, ...OPEN }, children: [label] }] : [label];
    }
    case 'table': {
      const rows = node.children ?? [];
      return [{ tag: 'table', children: [
        { tag: 'thead', children: rows.slice(0, 1).map(cellRow(true)) },
        { tag: 'tbody', children: rows.slice(1).map(cellRow(false)) },
      ] }];
    }
    case 'tableCell': return kids(node);
    case 'html': return [textNode(node.value)];
    case 'linkReference':
    case 'footnoteReference': return kids(node);
    case 'text': return [textNode(node.value)];
    case 'definition':
    case 'footnoteDefinition': return [];
    default:
      // Everything else: its value as plain text, or its children mapped the same way.
      return typeof node?.value === 'string' ? [textNode(node.value)] : kids(node);
  }
}
// One table row as a tr: the first row gets th cells (thead), the rest td cells (tbody).
const cellRow = head => row => ({ tag: 'tr', children: (row.children ?? []).map(cell => ({ tag: head ? 'th' : 'td', children: kids(cell) })) });

/**
 * Parse Markdown (GFM: tables, task lists, strikethrough, footnotes) to a flat, DOM-free node
 * tree of { tag, attrs?, children? } elements and { text } leaves. Partial streaming input
 * (unclosed fence, half a table) parses as text; this never throws.
 */
export function markdownTree(text) {
  const source = String(text ?? '');
  try {
    const root = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
    return (root.children ?? []).flatMap(toNode);
  } catch {
    // Hostile input (parse failure, or a walk RangeError on pathologically deep nesting): show the text.
    return [textNode(source)];
  }
}

/** Render Markdown into a DocumentFragment using createElement, setAttribute and createTextNode only. */
export function renderMarkdown(text, doc = document) {
  const fragment = doc.createDocumentFragment();
  for (const node of markdownTree(text)) appendNode(fragment, node, doc);
  return fragment;
}

function appendNode(parent, node, doc) {
  if (node.text !== undefined) { parent.append(doc.createTextNode(node.text)); return; }
  const element = doc.createElement(node.tag);
  for (const [key, value] of Object.entries(node.attrs ?? {})) element.setAttribute(key, value);
  for (const child of node.children ?? []) appendNode(element, child, doc);
  parent.append(element);
}
