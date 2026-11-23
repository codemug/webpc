// Unit tests for the pure helpers of the desktop host API (window.pcHost).
// Run: node --test tests/pc-host-api.test.mjs (no browser needed: the helpers are pure).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fail, distance, closestIds, checkAppId, checkNumber, checkLayout, checkTheme, checkOpenHow, tileRects } from '../src/scripts/pc/host-api.mjs';

const APPS = [
  { id: 'gridcraft', title: 'GridCraft', category: 'Office', kind: 'iframe', description: 'spreadsheets' },
  { id: 'docs', title: 'Docs', category: 'Office', kind: 'iframe', description: 'documents' },
  { id: 'files', title: 'Files', category: 'Utilities', kind: 'iframe', description: 'storage' },
];
const IDS = APPS.map(app => app.id);
const BOUNDS = { width: 1000, height: 800 };
const ROWS = (count, width = 400, height = 300) => Array.from({ length: count }, (_, i) => ({
  id: `w${i}`, minimized: false, maximized: false, rect: { x: i * 10, y: i * 10, width, height },
}));

test('fail builds a real Error carrying the machine-readable code', () => {
  const error = fail('unknown_app', 'unknown app "x"; apps: docs');
  assert.ok(error instanceof Error);
  assert.equal(error.code, 'unknown_app');
  assert.equal(error.message, 'unknown app "x"; apps: docs');
});

test('distance measures the edit distance', () => {
  assert.equal(distance('abc', 'abc'), 0);
  assert.equal(distance('gridcraf', 'gridcraft'), 1);
  assert.equal(distance('kitten', 'sitting'), 3);
});

test('closestIds suggests the nearest ids, best first', () => {
  assert.deepEqual(closestIds(IDS, 'gridcraf'), ['gridcraft']);
  assert.deepEqual(closestIds(IDS, 'filex'), ['files']);
});

test('closestIds honours the n limit, alphabetical on ties', () => {
  const ids = ['aaa', 'aab', 'aac', 'zzz'];
  assert.deepEqual(closestIds(ids, 'aa', 2), ['aaa', 'aab']);
});

test('closestIds stops at the 3-edit threshold and skips exact matches', () => {
  const ids = ['aaa', 'aab', 'aac'];
  assert.deepEqual(closestIds(ids, 'zzzz'), []); // 4 edits away: too far
  assert.deepEqual(closestIds(ids, 'zzz'), ['aaa', 'aab', 'aac']); // 3 edits: still close
  assert.deepEqual(closestIds(IDS, 'docs'), []); // exact match: nothing to suggest
});

test('closestIds rejects non-string input', () => {
  assert.deepEqual(closestIds(IDS, 42), []);
  assert.deepEqual(closestIds(IDS, ''), []);
});

test('checkAppId returns the app for a valid id', () => {
  assert.equal(checkAppId(APPS, 'docs').title, 'Docs');
});

test('checkAppId rejects unknown ids with the closest match and all valid ids', () => {
  assert.throws(() => checkAppId(APPS, 'gridcraf'), error => {
    assert.equal(error.code, 'unknown_app');
    assert.equal(error.message, 'unknown app "gridcraf"; closest: gridcraft; apps: gridcraft, docs, files');
    return true;
  });
});

test('checkAppId rejects an unknown id without a close match as well', () => {
  assert.throws(() => checkAppId(APPS, 'zzzzzzzz'), error => {
    assert.equal(error.code, 'unknown_app');
    assert.equal(error.message, 'unknown app "zzzzzzzz"; apps: gridcraft, docs, files');
    return true;
  });
});

test('checkAppId rejects non-strings as invalid_argument', () => {
  assert.throws(() => checkAppId(APPS, 7), error => {
    assert.equal(error.code, 'invalid_argument');
    assert.match(error.message, /must be a string/);
    return true;
  });
});

test('checkNumber passes valid numbers and rejects the rest as invalid_argument', () => {
  assert.equal(checkNumber('x', 0, { min: 0 }), 0);
  assert.equal(checkNumber('width', 5, { positive: true }), 5);
  const bad = (label, value, options) => {
    try { checkNumber(label, value, options); }
    catch (error) { assert.equal(error.code, 'invalid_argument'); assert.match(error.message, new RegExp(`^${label} `)); return; }
    assert.fail(`${label} accepted ${String(value)}`);
  };
  bad('x', '3', { min: 0 }); // non-number
  bad('x', NaN, { min: 0 });
  bad('x', -1, { min: 0 }); // negative
  bad('width', 0, { positive: true }); // zero where positive is required
  bad('width', -4, { positive: true });
  bad('width', Infinity, { positive: true });
});

test('checkLayout accepts the three layouts and rejects the rest', () => {
  assert.equal(checkLayout('grid'), 'grid');
  assert.equal(checkLayout('left-right'), 'left-right');
  assert.equal(checkLayout('cascade'), 'cascade');
  assert.throws(() => checkLayout('tiles'), error => {
    assert.equal(error.code, 'invalid_argument');
    assert.match(error.message, /left-right, grid, cascade/);
    return true;
  });
});

test('checkTheme accepts light and dark only', () => {
  assert.equal(checkTheme('dark'), 'dark');
  assert.equal(checkTheme('light'), 'light');
  assert.throws(() => checkTheme('sepia'), error => {
    assert.equal(error.code, 'invalid_argument');
    assert.match(error.message, /'light' or 'dark'/);
    return true;
  });
});

test('checkOpenHow accepts tab and window only', () => {
  assert.equal(checkOpenHow('tab'), 'tab');
  assert.equal(checkOpenHow('window'), 'window');
  assert.throws(() => checkOpenHow('popup'), error => {
    assert.equal(error.code, 'invalid_argument');
    assert.match(error.message, /'tab' or 'window'/);
    return true;
  });
});

test('tileRects: left-right splits the workspace in half, stacked per side', () => {
  assert.deepEqual(tileRects('left-right', ROWS(4), BOUNDS), [
    { id: 'w0', x: 0, y: 0, width: 500, height: 400 },
    { id: 'w1', x: 0, y: 400, width: 500, height: 400 },
    { id: 'w2', x: 500, y: 0, width: 500, height: 400 },
    { id: 'w3', x: 500, y: 400, width: 500, height: 400 },
  ]);
  assert.deepEqual(tileRects('left-right', ROWS(2), BOUNDS), [
    { id: 'w0', x: 0, y: 0, width: 500, height: 800 },
    { id: 'w1', x: 500, y: 0, width: 500, height: 800 },
  ]);
});

test('tileRects: grid is a near-square of equal cells', () => {
  assert.deepEqual(tileRects('grid', ROWS(2), BOUNDS), [
    { id: 'w0', x: 0, y: 0, width: 500, height: 800 },
    { id: 'w1', x: 500, y: 0, width: 500, height: 800 },
  ]);
  assert.deepEqual(tileRects('grid', ROWS(4), BOUNDS), [
    { id: 'w0', x: 0, y: 0, width: 500, height: 400 },
    { id: 'w1', x: 500, y: 0, width: 500, height: 400 },
    { id: 'w2', x: 0, y: 400, width: 500, height: 400 },
    { id: 'w3', x: 500, y: 400, width: 500, height: 400 },
  ]);
});

test('tileRects: cascade keeps sizes, offsets 32 px, clamps with clampRect', () => {
  const rows = [
    { id: 'a', minimized: false, maximized: false, rect: { x: 10, y: 20, width: 400, height: 300 } },
    { id: 'b', minimized: false, maximized: false, rect: { x: 1500, y: 900, width: 400, height: 300 } },
  ];
  assert.deepEqual(tileRects('cascade', rows, BOUNDS), [
    { id: 'a', x: 0, y: 0, width: 400, height: 300 },
    { id: 'b', x: 32, y: 32, width: 400, height: 300 },
  ]);
  // A workspace narrower than the cascade offset clamps both windows to the corner.
  assert.deepEqual(tileRects('cascade', rows, { width: 400, height: 300 }), [
    { id: 'a', x: 0, y: 0, width: 400, height: 300 },
    { id: 'b', x: 0, y: 0, width: 400, height: 300 },
  ]);
});

test('tileRects skips minimized and maximized windows, and returns none when no window is left', () => {
  const rows = [
    { id: 'a', minimized: true, maximized: false, rect: { x: 0, y: 0, width: 400, height: 300 } },
    { id: 'b', minimized: false, maximized: true, rect: { x: 0, y: 0, width: 400, height: 300 } },
    { id: 'c', minimized: false, maximized: false, rect: { x: 0, y: 0, width: 400, height: 300 } },
  ];
  assert.deepEqual(tileRects('grid', rows, BOUNDS), [
    { id: 'c', x: 0, y: 0, width: 1000, height: 800 },
  ]);
  assert.deepEqual(tileRects('left-right', rows.slice(0, 2), BOUNDS), []);
});
