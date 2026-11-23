// Unit tests for the desktop icon-space grid module (src/scripts/pc/icon-layout.mjs).
// Run: node --test tests/pc-icon-layout.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { CELL_W, CELL_H, PAD, gridSize, defaultLayout, parseSaved, resolveLayout, nearestFree, moveIcon, cellAt, cellOrigin, visualOrder } from '../src/scripts/pc/icon-layout.mjs';

test('cell constants', () => {
  assert.equal(CELL_W, 102);
  assert.equal(CELL_H, 112);
  assert.equal(PAD, 16);
});

test('gridSize: cells fit while the bottom-right corner stays inside the desktop', () => {
  // 840-16 = 824 px of span: 8*102 = 816 fits (col 8 would end at 934 > 840); 600-16 = 584: 5*112 = 560 fits.
  assert.deepEqual(gridSize(840, 600), { cols: 8, rows: 5 });
  assert.deepEqual(gridSize(118, 128), { cols: 1, rows: 1 }, 'exactly one cell: PAD + one cell dimension');
  assert.deepEqual(gridSize(220, 128), { cols: 2, rows: 1 });
  assert.deepEqual(gridSize(5, 1000), { cols: 1, rows: 8 }, 'a sliver width still clamps cols to 1');
  for (const [w, h] of [[16, 16], [0, 0]]) assert.deepEqual(gridSize(w, h), { cols: 1, rows: 1 }, `(${w}x${h}) clamps to at least 1x1`);
});

test('defaultLayout: column-major, ids i -> col floor(i/rows), row i%rows', () => {
  assert.deepEqual(defaultLayout(['a', 'b', 'c', 'd', 'e'], 2), {
    a: { col: 0, row: 0 }, b: { col: 0, row: 1 }, c: { col: 1, row: 0 }, d: { col: 1, row: 1 }, e: { col: 2, row: 0 },
  });
  assert.deepEqual(defaultLayout([], 3), {});
  assert.deepEqual(defaultLayout(['a'], 0), { a: { col: 0, row: 0 } }, 'rows clamp to at least 1');
});

test('parseSaved: garbage input never throws and yields no entries', () => {
  for (const bad of ['not json', '', '   ', null, undefined, '[1,2]', '42', '"x"', 'null', '{"a":5}', '{"a":null}']) {
    assert.deepEqual(parseSaved(bad), {}, `must handle: ${String(JSON.stringify(bad)).slice(0, 40)}`);
  }
  assert.deepEqual(parseSaved('{"a":{"col":0,"row":0},"b":"junk"}'), { a: { col: 0, row: 0 } }, 'bad entries are dropped, good ones kept');
});

test('parseSaved: drops non-integer, negative and missing cells, keeps well-formed ones', () => {
  assert.deepEqual(parseSaved('{"a":{"col":1.5,"row":0}}'), {});
  assert.deepEqual(parseSaved('{"a":{"col":0,"row":"2"}}'), {});
  assert.deepEqual(parseSaved('{"a":{"col":-1,"row":0},"b":{"col":0,"row":-1}}'), {});
  assert.deepEqual(parseSaved('{"a":{"col":0},"b":{"row":1},"c":{"col":0,"row":0}}'), { c: { col: 0, row: 0 } });
  assert.deepEqual(parseSaved('{"a":{"col":3,"row":7}}'), { a: { col: 3, row: 7 } }, 'parseSaved is syntactic: out-of-range cells are judged by resolveLayout');
});

test('parseSaved: rejects unknown-shaped keys (incl. __proto__) without prototype pollution', () => {
  const out = parseSaved('{"__proto__":{"col":0,"row":0},"constructor":{"col":0,"row":0}}');
  assert.deepEqual(out, { constructor: { col: 0, row: 0 } }, '__proto__ is rejected; a plain own "constructor" key is harmless and kept');
  assert.equal(Object.getPrototypeOf(out), Object.prototype, 'the result prototype is untouched');
  assert.equal(({}).col, undefined, 'no pollution of Object.prototype');
});

test('resolveLayout: keeps fitting saved cells and assigns the first free cell in ids order', () => {
  const layout = resolveLayout(['a', 'b', 'c'], { a: { col: 2, row: 1 }, b: { col: 0, row: 2 } }, 4, 4);
  assert.deepEqual(layout, { a: { col: 2, row: 1 }, b: { col: 0, row: 2 }, c: { col: 0, row: 0 } });
  const again = resolveLayout(['a', 'b', 'c'], { a: { col: 2, row: 1 }, b: { col: 0, row: 2 } }, 4, 4);
  assert.deepEqual(again, layout, 'deterministic');
});

test('resolveLayout: duplicate saved cells — the earlier id keeps the cell, the later one moves', () => {
  const layout = resolveLayout(['a', 'b'], { a: { col: 0, row: 0 }, b: { col: 0, row: 0 } }, 3, 3);
  assert.deepEqual(layout, { a: { col: 0, row: 0 }, b: { col: 0, row: 1 } });
});

test('resolveLayout: out-of-range saved cells after a resize are reassigned, fitting ones kept', () => {
  // Shrank from a 6x5 grid to 2x2: a's saved (5,5) no longer fits.
  const layout = resolveLayout(['a', 'b'], { a: { col: 5, row: 5 }, b: { col: 0, row: 1 } }, 2, 2);
  assert.deepEqual(layout, { a: { col: 0, row: 0 }, b: { col: 0, row: 1 } });
});

test('resolveLayout: a saved cell for an id that left the catalog is ignored (stale about)', () => {
  // Layouts saved before the About app became the built-in Help window carry an "about"
  // entry; the real ids keep their cells and nothing is placed for "about".
  const layout = resolveLayout(['a', 'b'], { a: { col: 0, row: 1 }, about: { col: 0, row: 0 }, b: { col: 1, row: 0 } }, 2, 2);
  assert.deepEqual(layout, { a: { col: 0, row: 1 }, b: { col: 1, row: 0 } });
});

test('resolveLayout: more apps than cells — rows grow, no app is dropped, no cell shared', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const layout = resolveLayout(ids, {}, 2, 2);
  assert.deepEqual(Object.keys(layout).sort(), ids, 'every app placed');
  assert.deepEqual(layout, {
    a: { col: 0, row: 0 }, b: { col: 0, row: 1 }, c: { col: 1, row: 0 }, d: { col: 1, row: 1 }, e: { col: 0, row: 2 },
  }, 'the extra app continues column-major past the last row');
  const cells = ids.map(id => `${layout[id].col},${layout[id].row}`);
  assert.equal(new Set(cells).size, ids.length, 'no two apps share a cell');
});

test('resolveLayout: saved cells for unknown ids are ignored; exactly `ids` come back; saved is not mutated', () => {
  const saved = { zz: { col: 0, row: 0 }, a: { col: 1, row: 1 } };
  const snapshot = JSON.stringify(saved);
  const layout = resolveLayout(['a'], saved, 3, 3);
  assert.deepEqual(layout, { a: { col: 1, row: 1 } });
  assert.equal(JSON.stringify(saved), snapshot, 'input saved object untouched');
});

test('moveIcon: places the id at the target cell and leaves the rest unchanged', () => {
  const layout = { a: { col: 0, row: 0 }, b: { col: 0, row: 1 } };
  const next = moveIcon(layout, 'a', { col: 2, row: 1 }, 3, 3);
  assert.deepEqual(next, { a: { col: 2, row: 1 }, b: { col: 0, row: 1 } });
});

test('moveIcon: a taken target falls back to nearestFree (excluding the moving id)', () => {
  const layout = { a: { col: 0, row: 0 }, b: { col: 1, row: 1 }, c: { col: 0, row: 1 } };
  // Target (1,1) is b's cell. Equidistant free cells (1,0), (1,2), (2,1): tie -> lower col then lower row -> (1,0).
  const next = moveIcon(layout, 'a', { col: 1, row: 1 }, 3, 3);
  assert.deepEqual(next.a, { col: 1, row: 0 });
  assert.deepEqual(next.b, { col: 1, row: 1 });
  assert.deepEqual(next.c, { col: 0, row: 1 });
});

test('moveIcon: the target is clamped to the grid', () => {
  const layout = { a: { col: 0, row: 0 }, b: { col: 0, row: 1 } };
  // (99,99) clamps to the bottom-right cell (1,1), which is free.
  assert.deepEqual(moveIcon(layout, 'a', { col: 99, row: 99 }, 2, 2), { a: { col: 1, row: 1 }, b: { col: 0, row: 1 } });
});

test('moveIcon: moving onto its own cell is a no-op (the cell is not "taken" by itself)', () => {
  const layout = { a: { col: 0, row: 0 }, b: { col: 1, row: 0 } };
  assert.deepEqual(moveIcon(layout, 'a', { col: 0, row: 0 }, 3, 3).a, { col: 0, row: 0 });
});

test('moveIcon: returns a new layout and never mutates the input', () => {
  const layout = { a: { col: 0, row: 0 }, b: { col: 2, row: 2 } };
  const snapshot = JSON.parse(JSON.stringify(layout));
  const next = moveIcon(layout, 'b', { col: 0, row: 1 }, 3, 3);
  assert.notEqual(next, layout);
  assert.deepEqual(layout, snapshot, 'input layout unchanged, cell objects included');
  assert.deepEqual(next.b, { col: 0, row: 1 });
});

test('nearestFree: closest free cell, ties broken by lower col then lower row', () => {
  const layout = { a: { col: 1, row: 0 }, b: { col: 1, row: 2 }, t: { col: 1, row: 1 } };
  // (1,1) is taken by t; (0,1) and (2,1) are both distance 1 -> (0,1) wins (lower col).
  assert.deepEqual(nearestFree(layout, { col: 1, row: 1 }, 3, 3, 'z'), { col: 0, row: 1 });
  assert.deepEqual(nearestFree(layout, { col: 2, row: 2 }, 3, 3, 'z'), { col: 2, row: 2 }, 'the target itself when it is free');
});

test('nearestFree: except counts as free; null when every cell is taken by others', () => {
  assert.deepEqual(nearestFree({ a: { col: 0, row: 0 }, b: { col: 0, row: 1 } }, { col: 0, row: 0 }, 1, 2, 'a'), { col: 0, row: 0 });
  assert.equal(nearestFree({ a: { col: 0, row: 0 } }, { col: 0, row: 0 }, 1, 1, 'b'), null);
});

test('cellAt: nearest cell by rounding to cell centres', () => {
  assert.deepEqual(cellAt(PAD + CELL_W / 2, PAD + CELL_H / 2), { col: 0, row: 0 }, 'centre of cell (0,0)');
  assert.deepEqual(cellAt(PAD + CELL_W / 2 + CELL_W, PAD + CELL_H / 2), { col: 1, row: 0 }, 'centre of cell (1,0)');
  assert.deepEqual(cellAt(PAD + CELL_W / 2 - 1, PAD + CELL_H / 2), { col: 0, row: 0 }, 'just left of a centre stays in the cell');
  assert.deepEqual(cellAt(PAD + CELL_W / 2 + CELL_W + 1, PAD + CELL_H / 2), { col: 1, row: 0 });
  assert.deepEqual(cellAt((PAD + CELL_W / 2) + (PAD + CELL_W / 2 + CELL_W) / 2, PAD + CELL_H / 2), { col: 1, row: 0 }, 'exactly midway rounds up (Math.round)');
  assert.deepEqual(cellAt(0, 0), { col: 0, row: 0 }, 'clamped to >= 0 at the corner');
  assert.deepEqual(cellAt(1000, 1000), { col: 9, row: 8 }, 'no upper clamp: the grid is applied by moveIcon');
});

test('cellOrigin: top-left pixel of the cell, and cellAt(cellOrigin + half cell) round-trips', () => {
  assert.deepEqual(cellOrigin({ col: 0, row: 0 }), { x: PAD, y: PAD });
  assert.deepEqual(cellOrigin({ col: 2, row: 3 }), { x: PAD + 2 * CELL_W, y: PAD + 3 * CELL_H });
  for (const [col, row] of [[0, 0], [1, 2], [5, 4]]) {
    const o = cellOrigin({ col, row });
    assert.deepEqual(cellAt(o.x + CELL_W / 2, o.y + CELL_H / 2), { col, row });
  }
});

test('visualOrder: column-major Tab order (col, then row; id as final tie-break)', () => {
  assert.deepEqual(visualOrder({ a: { col: 1, row: 0 }, b: { col: 0, row: 1 }, c: { col: 0, row: 0 } }), ['c', 'b', 'a']);
  assert.deepEqual(visualOrder({}), []);
  assert.deepEqual(visualOrder({ b: { col: 0, row: 0 }, a: { col: 0, row: 0 } }), ['a', 'b']);
});

test('parseSaved keeps desktop folder ids (folder:<name>) but still rejects other shapes', () => {
  const saved = parseSaved(JSON.stringify({ 'folder:games': { col: 2, row: 1 }, 'folder:': { col: 0, row: 0 }, 'Folder:X': { col: 0, row: 0 } }));
  assert.deepEqual(saved, { 'folder:games': { col: 2, row: 1 } });
});
