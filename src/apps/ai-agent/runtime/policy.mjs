// Buddy M1: the safety policy. Decides allow/ask/deny for each tool call (cloud Files
// grants first, then the effect table, then repeat approvals) and taints a turn when
// untrusted content enters it. Pure: no clock, no randomness, same inputs give the same
// decision. callLine comes from args.mjs (another lane's file: imported, never edited).
import { callLine } from './args.mjs';

const PREVIEW_MAX = 300;
const GRANT_DENY = 'Grant this folder to Buddy in Settings to use it with a cloud model.';
const TAINT_REASON = 'This chat read web or file content this turn; confirm before changing things.';
const DESTRUCTIVE_REASON = 'This can delete or overwrite data; confirm before running it.';
const EXTERNAL_REASON = 'This reaches outside the PC; confirm before running it.';

/** Resolve the . and .. segments of a path so an escape like /notes/../etc cannot match a grant. */
function normPath(path) {
  const absolute = String(path).startsWith('/');
  const parts = [];
  for (const part of String(path).split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { parts.pop(); continue; }
    parts.push(part);
  }
  return (absolute ? '/' : '') + parts.join('/');
}

/** true when the path is the grant folder itself or anywhere below it (both normalised). */
function insideGrant(grants, path) {
  const p = normPath(path);
  return grants.some(grant => p === grant || p.startsWith(grant + '/'));
}

/** The values of the tool's path-typed params that are present in args. */
function pathArgs(tool, args) {
  const out = [];
  for (const [key, spec] of Object.entries(tool?.params ?? {})) {
    if (spec?.type !== 'path') continue;
    const value = args?.[key];
    if (typeof value === 'string' && value !== '') out.push(value);
  }
  return out;
}

/** The file's name (last path segment) appears in the user text, case-insensitively. */
function mentioned(value, userText) {
  const name = String(value).split('/').filter(Boolean).at(-1) ?? '';
  if (name === '') return true;
  return String(userText ?? '').toLowerCase().includes(name.toLowerCase());
}

/** The approval-card text: the human line, then the exact call line, cut at 300 characters. */
function makePreview(tool, args) {
  const text = `${tool?.purpose ?? tool?.name ?? ''} (${tool?.effect ?? ''})\n${callLine(String(tool?.name ?? ''), args)}`;
  return text.length > PREVIEW_MAX ? text.slice(0, PREVIEW_MAX) : text;
}

/**
 * backend: 'local' | 'cloud' | 'chrome'. grants: Files paths the user granted (cloud only needs them).
 * -> { decide(tool, args, turn) -> { action: 'allow' | 'ask' | 'deny', reason, preview },
 *      noteResult(tool, args, turn),    // call after a tool ran; may taint the turn
 *      newTurn(userText) -> turn }      // a fresh turn state: { userText, tainted: false, approvedOnce: Set }
 *
 * tool is a catalog tool: { name, effect, untrusted?, params } (plus purpose, shown in the preview).
 * Rules, in order: (1) cloud backends deny any files.* call with a path outside a grant;
 * (2) read allows, destructive and external always ask, change asks when the turn is tainted;
 * (3) an approval already given this turn for the identical call (callLine in turn.approvedOnce)
 * is not asked again.
 */
export function createPolicy({ backend, grants = [] } = {}) {
  const normGrants = (grants ?? []).map(normPath);

  function newTurn(userText) {
    return { userText: String(userText ?? ''), tainted: false, approvedOnce: new Set() };
  }

  function decide(tool, args, turn) {
    const t = turn ?? newTurn('');
    const name = String(tool?.name ?? '');
    const preview = makePreview(tool, args);
    if (backend === 'cloud' && name.startsWith('files.')) {
      for (const value of pathArgs(tool, args)) {
        if (!insideGrant(normGrants, value)) return { action: 'deny', reason: GRANT_DENY, preview };
      }
    }
    let action = 'allow';
    let reason;
    if (tool?.effect === 'destructive') { action = 'ask'; reason = DESTRUCTIVE_REASON; }
    else if (tool?.effect === 'external') { action = 'ask'; reason = EXTERNAL_REASON; }
    else if (tool?.effect === 'change' && t.tainted) { action = 'ask'; reason = TAINT_REASON; }
    // Rule 3: an approval already given this turn for this exact call is not asked again.
    if (action === 'ask' && t.approvedOnce?.has(callLine(name, args))) { action = 'allow'; reason = undefined; }
    return { action, reason, preview };
  }

  function noteResult(tool, args, turn) {
    const t = turn ?? newTurn('');
    const name = String(tool?.name ?? '');
    // Record only calls that actually asked and the user approved: destructive and external
    // always ask, change asks while the turn is tainted. A call that ran unapproved does not
    // silence a later ask (the taint may arrive after it ran).
    const asked = tool?.effect === 'destructive'
      || tool?.effect === 'external'
      || (tool?.effect === 'change' && t.tainted);
    if (asked && t.approvedOnce) t.approvedOnce.add(callLine(name, args));
    if (tool?.untrusted
      || (name === 'files.read' && pathArgs(tool, args).some(value => !mentioned(value, t.userText)))) {
      t.tainted = true;
    }
  }

  return { decide, noteResult, newTurn };
}
