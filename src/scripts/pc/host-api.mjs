// Pure helpers for the desktop host API (window.pcHost, installed by desktop.js).
// No DOM access: every function takes its data as an argument so the Node unit
// tests need no browser. Host API failures are Errors with a `code`:
// unknown_app, not_open, not_iframe, timeout, invalid_argument.
import { clampRect } from './window-state.mjs';

/** Build a host API error: a real Error carrying a stable machine-readable code. */
export function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Levenshtein edit distance between two short strings. */
export function distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Up to n ids closest to `wrong` by edit distance (3 or less), best first, ties alphabetical. */
export function closestIds(ids, wrong, n = 3) {
  if (typeof wrong !== 'string' || !wrong) return [];
  return ids
    .map(id => ({ id, d: distance(id, wrong) }))
    .filter(entry => entry.id !== wrong && entry.d <= 3)
    .sort((a, b) => a.d - b.d || a.id.localeCompare(b.id))
    .slice(0, n)
    .map(entry => entry.id);
}

/** Return the app with id `id`, or throw unknown_app naming the closest and all valid ids. */
export function checkAppId(apps, id) {
  if (typeof id !== 'string') throw fail('invalid_argument', 'app id must be a string');
  const app = apps.find(entry => entry.id === id);
  if (app) return app;
  const ids = apps.map(entry => entry.id);
  const close = closestIds(ids, id);
  throw fail('unknown_app', `unknown app "${id}"${close.length ? `; closest: ${close.join(', ')}` : ''}; apps: ${ids.join(', ')}`);
}

/** Validate a numeric geometry argument; throws invalid_argument for non-numbers or out-of-range values. */
export function checkNumber(label, value, { min = 0, positive = false } = {}) {
  const ok = typeof value === 'number' && Number.isFinite(value) && (positive ? value > 0 : value >= min);
  if (!ok) throw fail('invalid_argument', positive
    ? `${label} must be a number greater than 0 (got ${String(value)})`
    : `${label} must be a number of ${min} or more (got ${String(value)})`);
  return value;
}

/** Validate a tile layout name; throws invalid_argument listing the valid names. */
export function checkLayout(layout) {
  if (layout !== 'left-right' && layout !== 'grid' && layout !== 'cascade') {
    throw fail('invalid_argument', `layout must be one of: left-right, grid, cascade (got ${String(layout)})`);
  }
  return layout;
}

/** Validate a theme name; throws invalid_argument listing the valid names. */
export function checkTheme(theme) {
  if (theme !== 'light' && theme !== 'dark') throw fail('invalid_argument', `theme must be 'light' or 'dark' (got ${String(theme)})`);
  return theme;
}

/** Validate openExternal's `how`; throws invalid_argument listing the valid values. */
export function checkOpenHow(how) {
  if (how !== 'tab' && how !== 'window') throw fail('invalid_argument', `how must be 'tab' or 'window' (got ${String(how)})`);
  return how;
}

// Tile geometry. `rows` are window rows ({ id, minimized, maximized, rect });
// minimized and maximized windows are skipped. `bounds` is the workspace size.
// Returns one rect per visible window in input (z) order:
// - left-right: the first half fills the left half of the workspace, the second
//   half the right half, each group stacked vertically.
// - grid: a near-square grid of equal cells (2 windows: 2 across, 4: 2 by 2).
// - cascade: each window keeps its current size, offset 32 px down and right,
//   clamped to the workspace with the same clampRect the window manager uses.
export function tileRects(layout, rows, bounds) {
  const visible = rows.filter(win => !win.minimized && !win.maximized);
  if (!visible.length) return [];
  if (layout === 'cascade') {
    return visible.map((win, i) => ({
      id: win.id,
      ...clampRect({ x: i * 32, y: i * 32, width: win.rect.width, height: win.rect.height }, bounds),
    }));
  }
  if (layout === 'left-right') {
    const half = Math.ceil(visible.length / 2);
    const rects = [];
    [visible.slice(0, half), visible.slice(half)].forEach((group, side) => group.forEach((win, i) => rects.push({
      id: win.id,
      x: side * (bounds.width / 2),
      y: (bounds.height / group.length) * i,
      width: bounds.width / 2,
      height: bounds.height / group.length,
    })));
    return rects;
  }
  const cols = Math.ceil(Math.sqrt(visible.length));
  const rowCount = Math.ceil(visible.length / cols);
  return visible.map((win, i) => ({
    id: win.id,
    x: (i % cols) * (bounds.width / cols),
    y: Math.floor(i / cols) * (bounds.height / rowCount),
    width: bounds.width / cols,
    height: bounds.height / rowCount,
  }));
}
