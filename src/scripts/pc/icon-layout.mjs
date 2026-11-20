// Desktop icon-space grid math (pure, DOM-free). Column-major order everywhere:
// a cell sequence is ordered by col first, then row. The grid origin sits PAD px
// from the desktop's top-left; a cell still "fits" while its bottom-right corner
// is inside the desktop, so a width W holds floor((W - PAD) / CELL_W) columns.
export const CELL_W = 102, CELL_H = 112, PAD = 16;

// App ids, or a desktop folder's id (folder:<lowercase name>); both reject __proto__ and friends.
const APP_ID = /^(?:folder:)?[a-z0-9][a-z0-9-]*$/;
const cellKey = (col, row) => col + ',' + row;
const isCell = c => c !== null && typeof c === 'object' && Number.isInteger(c.col) && Number.isInteger(c.row);

export function gridSize(width, height) {
  return {
    cols: Math.max(1, Math.floor((width - PAD) / CELL_W)),
    rows: Math.max(1, Math.floor((height - PAD) / CELL_H)),
  };
}

export function defaultLayout(ids, rows) {
  const perCol = Math.max(1, Math.floor(rows));
  const layout = {};
  ids.forEach((id, i) => { layout[id] = { col: Math.floor(i / perCol), row: i % perCol }; });
  return layout;
}

// Untrusted localStorage text -> { [id]: {col,row} }. Drops bad entries; never throws.
// Keys are validated against the app-id shape (this also rejects `__proto__`).
export function parseSaved(text) {
  let data;
  try { data = typeof text === 'string' && text.trim() !== '' ? JSON.parse(text) : null; } catch { return {}; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const out = {};
  for (const [id, cell] of Object.entries(data)) {
    if (APP_ID.test(id) && isCell(cell) && cell.col >= 0 && cell.row >= 0) out[id] = { col: cell.col, row: cell.row };
  }
  return out;
}

// Assign every id a cell: well-formed saved cells inside 0..cols-1 x 0..rows-1 are kept
// (ids order; a second app claiming the same saved cell loses it), and the rest take
// the first free cell in column-major order, in ids order. With more apps than
// cols*rows cells the assignment continues past the last row (rows grows, restarting
// each new row-band at column 0) — an app is never dropped. Deterministic; `saved` is
// not mutated. With no saved cells this equals defaultLayout(ids, rows).
export function resolveLayout(ids, saved, cols, rows) {
  const cMax = Math.max(1, Math.floor(cols));
  const rMax = Math.max(1, Math.floor(rows));
  const layout = {};
  const occupied = new Set();
  const pending = [];
  for (const id of ids) {
    const cell = saved?.[id];
    if (isCell(cell) && cell.col >= 0 && cell.row >= 0 && cell.col < cMax && cell.row < rMax && !occupied.has(cellKey(cell.col, cell.row))) {
      layout[id] = { col: cell.col, row: cell.row };
      occupied.add(cellKey(cell.col, cell.row));
    } else {
      pending.push(id);
    }
  }
  // Column-major enumeration by position p: inside the nominal cMax x rMax grid it is
  // (floor(p / rMax), p % rMax); once past the last row, rows grow and each new
  // row-band restarts at column 0: (q % cMax, rMax + floor(q / cMax)), q = p - cMax*rMax.
  const nominal = cMax * rMax;
  const cellAtP = p => p < nominal
    ? { col: Math.floor(p / rMax), row: p % rMax }
    : { col: (p - nominal) % cMax, row: rMax + Math.floor((p - nominal) / cMax) };
  for (const id of pending) {
    // All other ids.length - 1 ids already own distinct cells, so the lowest free p
    // is at most ids.length - 1; this scan always terminates inside the bound.
    for (let p = 0; p <= ids.length; p++) {
      const cell = cellAtP(p);
      if (!occupied.has(cellKey(cell.col, cell.row))) {
        layout[id] = { col: cell.col, row: cell.row };
        occupied.add(cellKey(cell.col, cell.row));
        break;
      }
    }
  }
  return layout;
}

// The free cell closest to `cell` (squared Euclidean distance in cell units; ties keep
// the lower col, then lower row, by scan order). `except`'s cell counts as free.
// null when every grid cell is occupied by another id.
export function nearestFree(layout, cell, cols, rows, except) {
  const cMax = Math.max(1, Math.floor(cols));
  const rMax = Math.max(1, Math.floor(rows));
  const occupied = new Set();
  for (const [id, c] of Object.entries(layout)) if (id !== except && isCell(c)) occupied.add(cellKey(c.col, c.row));
  const target = { col: cell?.col ?? 0, row: cell?.row ?? 0 };
  let best = null, bestDist = Infinity;
  for (let c = 0; c < cMax; c++) {
    for (let r = 0; r < rMax; r++) {
      if (occupied.has(cellKey(c, r))) continue;
      const dist = (c - target.col) ** 2 + (r - target.row) ** 2;
      if (dist < bestDist) { bestDist = dist; best = { col: c, row: r }; }
    }
  }
  return best;
}

// New layout (the input is not mutated): id goes to `cell` clamped to the grid, or to
// nearestFree when another id occupies that cell.
export function moveIcon(layout, id, cell, cols, rows) {
  const cMax = Math.max(1, Math.floor(cols));
  const rMax = Math.max(1, Math.floor(rows));
  const target = {
    col: Math.min(Math.max(Math.floor(cell?.col ?? 0), 0), cMax - 1),
    row: Math.min(Math.max(Math.floor(cell?.row ?? 0), 0), rMax - 1),
  };
  let dest = target;
  const occupied = new Set();
  for (const [i, c] of Object.entries(layout)) if (i !== id && isCell(c)) occupied.add(cellKey(c.col, c.row));
  if (occupied.has(cellKey(target.col, target.row))) dest = nearestFree(layout, target, cols, rows, id);
  const next = {};
  for (const [i, c] of Object.entries(layout)) next[i] = { ...c };
  if (dest) next[id] = dest;
  return next;
}

// Desktop-relative pixel point -> nearest cell (round to the cell centre). Results are
// clamped to >= 0 but not to the grid; moveIcon clamps to the grid.
export function cellAt(x, y) {
  return {
    col: Math.max(0, Math.round((x - PAD - CELL_W / 2) / CELL_W)),
    row: Math.max(0, Math.round((y - PAD - CELL_H / 2) / CELL_H)),
  };
}

export function cellOrigin(cell) {
  return { x: PAD + cell.col * CELL_W, y: PAD + cell.row * CELL_H };
}

// Tab order: ids sorted column-major (col, then row; id as the final tie-break).
export function visualOrder(layout) {
  return Object.keys(layout).sort((a, b) => {
    const ca = layout[a], cb = layout[b];
    return (ca?.col ?? 0) - (cb?.col ?? 0) || (ca?.row ?? 0) - (cb?.row ?? 0) || (a < b ? -1 : a > b ? 1 : 0);
  });
}
