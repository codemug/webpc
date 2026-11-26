// Unit tests for the run_command/batch params glue of the craft packs (agent/apps/<app>/tools.js):
// parseParams accepts a JSON object or array value as-is (lfm3-1.7b sends engine params as JSON,
// and repairArgs serializes an unwrapped wrapper object to JSON text for the params= slot),
// while key=value lines keep working. Run: node --test tests/agent-pack-craft-params.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseParams as cadcraftParams } from '../agent/apps/cadcraft/tools.js';
import { parseParams as effectcraftParams } from '../agent/apps/effectcraft/tools.js';
import { parseParams as figcraftParams } from '../agent/apps/figcraft/tools.js';

for (const [app, parseParams] of [['cadcraft', cadcraftParams], ['effectcraft', effectcraftParams], ['figcraft', figcraftParams]]) {
  test(`${app} parseParams: a JSON object passes through with native types`, () => {
    assert.deepEqual(parseParams('{"points": [[0,0],[10,0]], "closed": true}'), { points: [[0, 0], [10, 0]], closed: true });
    assert.deepEqual(parseParams('{"name": "Pulse", "duration": 4}'), { name: 'Pulse', duration: 4 });
  });

  test(`${app} parseParams: key=value lines are unchanged`, () => {
    assert.deepEqual(parseParams('name=Fade In\nduration=2'), { name: 'Fade In', duration: 2 });
  });

  test(`${app} parseParams: non-JSON braces fall back to the key=value error`, () => {
    assert.throws(() => parseParams('{bad'), /use key=value|key=value tokens/);
  });
}

test('cadcraft parseParams: a JSON array value is kept as a list param', () => {
  assert.deepEqual(cadcraftParams('[["a","b"]]'), [['a', 'b']]);
});
