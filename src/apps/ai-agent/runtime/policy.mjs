// Buddy's safety policy: the only remaining guardrail. A cloud model may only touch the
// Files grants the user gave it (a files.* call with a path outside a grant is denied);
// every other call on every backend is allowed without asking (M3 removed the approval
// prompts, taint tracking and repeat approvals). Pure: no clock, no randomness, same
// inputs give the same decision. Removing the grant rule later is deleting the one if
// block in decide.
const GRANT_DENY = 'Grant this folder to Buddy in Settings to use it with a cloud model.';

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

/**
 * backend: 'local' | 'cloud' | 'chrome'. grants: Files paths the user granted (cloud only
 * checks them).
 * -> { decide(tool, args) -> { action: 'allow' | 'deny', reason } }
 *
 * tool is a catalog tool: { name, params } (path-typed params are checked against the grants).
 * Rule: a cloud backend denies any files.* call whose path args are not all inside a grant;
 * everything else allows.
 */
export function createPolicy({ backend, grants = [] } = {}) {
  const normGrants = (grants ?? []).map(normPath);

  function decide(tool, args) {
    if (backend === 'cloud' && String(tool?.name ?? '').startsWith('files.')) {
      for (const value of pathArgs(tool, args)) {
        if (!insideGrant(normGrants, value)) return { action: 'deny', reason: GRANT_DENY };
      }
    }
    return { action: 'allow' };
  }

  return { decide };
}
