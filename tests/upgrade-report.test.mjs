import test from 'node:test';
import assert from 'node:assert/strict';
import { reportMarkdown } from '../scripts/upgrade/report.mjs';

test('the same manual upgrade pinned in several files is listed once', () => {
  const entry = index => ({ app: 'ai-agent', index, type: 'cdn-file', name: 'onnxruntime-web', from: '1.31.0-dev', to: '1.31.1', auto: false });
  const report = reportMarkdown([entry(2), entry(3)]);
  assert.equal(report.split('\n').filter(line => line.includes('onnxruntime-web')).length, 1);
});

test('automatic results, manual notes and errors each get their section', () => {
  const plan = [
    { app: 'gridcraft', index: 0, name: 'storytold/gridcraft', from: 'v1', to: 'v2', auto: true },
    { app: 'terminal', index: 1, name: '@xterm/xterm', from: '5.5.0', to: '6.0.0', auto: false, note: 'new major: review and bump by hand' },
    { app: 'files', index: 0, name: 'x', auto: false, error: 'HTTP 500' },
  ];
  const report = reportMarkdown(plan, new Map([['gridcraft#0#storytold/gridcraft', { ok: false, reason: 'smoke check failed' }]]));
  assert.match(report, /### Automatic[\s\S]*reverted: smoke check failed/);
  assert.match(report, /### Needs a human[\s\S]*new major: review and bump by hand/);
  assert.match(report, /### Could not check[\s\S]*HTTP 500/);
});
