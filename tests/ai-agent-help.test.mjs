// Unit tests for src/apps/ai-agent/help.js (the pure helpers: place and stripApps).
// Run: node --test tests/ai-agent-help.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { licenseNotice, modelKindLine, place, stripApps } from '../src/apps/ai-agent/help.js';

const pop = { width: 200, height: 60 };
const viewport = { width: 390, height: 700 };

test('place: below the trigger when there is room', () => {
  const p = place({ top: 100, left: 100, width: 80, height: 30 }, pop, viewport);
  assert.equal(p.side, 'below');
  assert.equal(p.top, 138); // 100 + 30 + the 8 px gap
  assert.equal(p.left, 40); // centred on the trigger (100 + 40 - 100)
});

test('place: flips above when there is no room below', () => {
  const p = place({ top: 600, left: 100, width: 80, height: 30 }, pop, viewport); // 600+30+8+60 = 698 > 700-8
  assert.equal(p.side, 'above');
  assert.equal(p.top, 532); // 600 - 8 - 60
  assert.equal(p.left, 40);
});

test('place: clamps left inside the viewport', () => {
  const p = place({ top: 100, left: 4, width: 80, height: 30 }, pop, viewport);
  assert.equal(p.left, 8); // centred would be -56, so it is pulled in to the margin
});

test('place: clamps right inside the viewport', () => {
  const p = place({ top: 100, left: 350, width: 80, height: 30 }, pop, viewport);
  assert.equal(p.left, 182); // 390 - 8 - 200
});

test('stripApps: catalog order, first 8 shown and the rest in the +N chip', () => {
  const apps = Array.from({ length: 10 }, (_, i) => ({ id: `app${i}`, title: `App ${i}` }));
  const tools = apps.map(app => `${app.id}.open`);
  const { shown, hidden } = stripApps(apps, tools);
  assert.equal(shown.length, 8);
  assert.deepEqual(shown.map(a => a.id), apps.slice(0, 8).map(a => a.id));
  assert.deepEqual(hidden.map(a => a.id), ['app8', 'app9']);
});

test('modelKindLine: LFM3 points at the apps, Qwen at chat and images, no line for cloud and Chrome', () => {
  assert.equal(modelKindLine('lfm3-1.7b'), 'Best for working in your apps.');
  assert.equal(modelKindLine('qwen3.5-0.8b'), 'Good for chat and images. For working in apps, pick LFM3.');
  assert.equal(modelKindLine('qwen3.5-2b'), 'Good for chat and images. For working in apps, pick LFM3.');
  assert.equal(modelKindLine('cloud:anthropic'), null);
  assert.equal(modelKindLine('chrome:builtin'), null);
  assert.equal(modelKindLine(null), null);
});

test('licenseNotice: the About card line and help per backend', () => {
  assert.deepEqual(licenseNotice('cloud'), { line: 'Provider terms apply', help: 'The provider sets its own terms and pricing; the key is used only in this browser session.' });
  assert.equal(licenseNotice('chrome').line, 'On-device, nothing sent');
  assert.match(licenseNotice('chrome').help, /no data is sent to Google/);
  assert.equal(licenseNotice('local').line, '', 'local shows the license link only');
  assert.match(licenseNotice('local').help, /Model weights have their own license/);
});

test('stripApps: drops apps with no tools and honours a custom limit', () => {
  const apps = [{ id: 'gridcraft', title: 'GridCraft' }, { id: 'vscode', title: 'VS Code' }, { id: 'docs', title: 'Docs' }];
  const tools = ['gridcraft.open', 'gridcraft.cells', 'docs.open'];
  const { shown, hidden } = stripApps(apps, tools, { limit: 1 });
  assert.deepEqual(shown.map(a => a.id), ['gridcraft']);
  assert.deepEqual(hidden.map(a => a.id), ['docs']);
});
