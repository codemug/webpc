// A4: find_tool must rank a tool first when the query names its inner vocabulary - the
// CyberChef operation names (generated from the vendored release into
// agent/apps/cyberchef/operations.js), the common spreadsheet functions, and the common
// guest programs. Builds the real packs (buildAgent, no write) so the test tracks the packs,
// and guards the pre-A4 ranking of the representative queries that already worked.
// Run: node --test tests/agent-find-tool-keywords.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgent } from '../scripts/agent/build.mjs';
import { buildIndex, loadIndex, search } from '../src/apps/ai-agent/runtime/search.mjs';

const { out } = await buildAgent(undefined, { write: false });
const docs = JSON.parse(out['catalog.json']).docs;
const handle = loadIndex(buildIndex(docs, { store: ['name', 'purpose'] }), { store: ['name', 'purpose'] });
const top = (query, { limit = 5 } = {}) => search(handle, query, { limit, docs }).hits.map(hit => hit.id);

test('inner vocabulary: an inner name returns the owning tool first', () => {
  // CyberChef operation names (find_tool "sha256" found nothing before A4: the names live in
  // the recipe, not the tool text).
  assert.equal(top('sha256')[0], 'cyberchef.bake');
  assert.equal(top('SHA-256')[0], 'cyberchef.bake');
  assert.equal(top('vigenère decode')[0], 'cyberchef.bake', 'the non-ASCII op name is decoded from the vendor string form');
  assert.equal(top('md5')[0], 'cyberchef.bake');
  // The spreadsheet function names (the query used to rank nettools.dns_lookup first on fuzzy "lookup").
  assert.equal(top('vlookup')[0], 'gridcraft.list_functions');
  assert.equal(top('xlookup')[0], 'gridcraft.list_functions');
  // The guest program names ("grep" and "install git" found nothing / ranked junk before A4).
  assert.equal(top('grep')[0], 'terminal.run');
  assert.equal(top('install git')[0], 'terminal.run');
  // The packet protocol names (the display filter's inner vocabulary: "icmp" found nothing).
  assert.equal(top('icmp')[0], 'packets.filter');
  assert.equal(top('arp')[0], 'packets.filter');
});

test('A4 does not move the ranking of the representative queries that already worked', () => {
  assert.equal(top('base64')[0], 'cyberchef.bake');
  assert.equal(top('cipher')[0], 'cyberchef.bake');
  assert.equal(top('terminal command')[0], 'terminal.run');
  assert.equal(top('evaluate formula')[0], 'gridcraft.evaluate_formula');
});

test('the generated operation list is sound: the vendor bump guard and a known sample', () => {
  const ops = docs.find(doc => doc.id === 'cyberchef.bake').keywords;
  assert.ok(ops.length > 300, `${ops.length} op names - the vendor layout changed`);
  for (const known of ['SHA2', 'To Base64', 'From Hex', 'Atbash Cipher', 'Vigenère Decode', 'From Morse Code']) {
    assert.ok(ops.includes(known), `missing known operation ${known}`);
  }
  for (const alias of ['sha256', 'sha-256', 'sha224', 'sha-224', 'sha384', 'sha-384', 'sha512', 'sha-512']) assert.ok(ops.includes(alias), `missing SHA alias ${alias}`);
});

/** Bare numbers and question words are not search words ("What is 6 times 7?" ranked a FigCraft
 *  skill and media.status above the sum skill on "6", "7" and "what"). */
test('a question with numbers finds the tool by its content words, and an all-number query still searches', () => {
  const docs = [
    { id: 'system.calculate', name: 'system.calculate', keywords: 'calculate times multiply', purpose: 'Work out a sum.' },
    { id: 'media.status', name: 'media.status', purpose: 'What is playing now.' },
    { id: 'figcraft.grid', name: 'figcraft.grid', purpose: 'Set a 6 by 7 grid of 60 px cells.' },
  ];
  const index = loadIndex(buildIndex(docs));
  assert.equal(search(index, 'What is 6 times 7?').hits[0].id, 'system.calculate');
  assert.equal(search(index, '60').hits[0].id, 'figcraft.grid', 'a query of only numbers still matches numbers');
});
