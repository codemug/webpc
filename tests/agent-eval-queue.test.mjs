// Unit tests for the eval queue runner's pure parts (scripts/agent/eval-queue.mjs): request
// validation, the grouping order (oldest first, model-switch avoided) and the state-file
// names - plus the shared results helpers from scripts/agent/eval.mjs. No browser, no queue
// directory on disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateRequest, nextRequest, requestFileNames } from '../scripts/agent/eval-queue.mjs';
import { journeySummary, resultsFileName, loadJourneys } from '../scripts/agent/eval.mjs';

/** A minimal valid request. */
const goodRequest = { id: 'gridcraft-fix-1', requester: 'gridcraft-lane', journeys: 'gridcraft', models: ['lfm3-1.7b'] };

/** The state-file names around one request id. */
test('requestFileNames names the state files', () => {
  assert.deepEqual(requestFileNames('abc'), {
    request: 'abc.json', running: 'abc.running', result: 'abc.result.json', done: 'abc.done', error: 'abc.error'
  });
});

/** validateRequest accepts a good request and fills the defaults. */
test('validateRequest accepts a good request with defaults', () => {
  const res = validateRequest(goodRequest);
  assert.ok(res.ok, JSON.stringify(res.errors ?? []));
  assert.deepEqual(res.request, { ...goodRequest, split: 'train', repeat: 1, oracle: false });
});

/** validateRequest accepts the explicit option shapes. */
test('validateRequest accepts explicit options', () => {
  const res = validateRequest({
    id: 'a.b-c_1', requester: 'x', journeys: ['terminal-01-a', 'terminal-02-b'],
    split: 'holdout', models: ['qwen3.5-0.8b', 'gemma4-e2b'], repeat: 3, oracle: true
  });
  assert.ok(res.ok, JSON.stringify(res.errors ?? []));
  assert.equal(res.request.journeys.length, 2);
  assert.equal(res.request.repeat, 3);
});

/** Lanes never run a model on holdout rows: a non-lead model request on a non-train split is
 * rejected; the lead and oracle requests are exempt. */
test('validateRequest rejects a lane model request on a non-train split, oracle and lead exempt', () => {
  const lane = validateRequest({ id: 'a', requester: 'opencode', journeys: 'terminal', models: ['m'], split: 'all' });
  assert.ok(!lane.ok, JSON.stringify(lane.errors));
  assert.ok(lane.errors.includes("lanes run split train only; holdout model runs are the lead's"), JSON.stringify(lane.errors));
  const lead = validateRequest({ id: 'a', requester: 'lead', journeys: 'terminal', models: ['m'], split: 'all' });
  assert.ok(lead.ok, JSON.stringify(lead.errors));
  const oracle = validateRequest({ id: 'a', requester: 'opencode', journeys: 'terminal', models: ['m'], split: 'holdout', oracle: true });
  assert.ok(oracle.ok, JSON.stringify(oracle.errors));
});

/** validateRequest rejects the broken shapes, one error at a time. */
test('validateRequest rejects broken requests', () => {
  const bad = [
    [{ id: '', requester: 'x', journeys: 'terminal', models: ['m'] }, 'id'],
    [{ id: 'a/b', requester: 'x', journeys: 'terminal', models: ['m'] }, 'id'],
    [{ id: 'a b', requester: 'x', journeys: 'terminal', models: ['m'] }, 'id'],
    [{ requester: 'x', journeys: 'terminal', models: ['m'] }, 'id'],
    [{ id: 'a', journeys: 'terminal', models: ['m'] }, 'requester'],
    [{ id: 'a', requester: 'x', journeys: 3, models: ['m'] }, 'journeys'],
    [{ id: 'a', requester: 'x', journeys: [], models: ['m'] }, 'journeys'],
    [{ id: 'a', requester: 'x', journeys: ['terminal-01-a', 7], models: ['m'] }, 'journeys'],
    [{ id: 'a', requester: 'x', journeys: 'terminal', models: ['m'], split: 'sometimes' }, 'split'],
    [{ id: 'a', requester: 'x', journeys: 'terminal', models: [] }, 'models'],
    [{ id: 'a', requester: 'x', journeys: 'terminal', models: 'lfm3-1.7b' }, 'models'],
    [{ id: 'a', requester: 'x', journeys: 'terminal', models: ['m'], repeat: 0 }, 'repeat'],
    [{ id: 'a', requester: 'x', journeys: 'terminal', models: ['m'], repeat: 2.5 }, 'repeat'],
    [{ id: 'a', requester: 'x', journeys: 'terminal', models: ['m'], oracle: 'yes' }, 'oracle']
  ];
  for (const [raw, what] of bad) {
    const res = validateRequest(raw);
    assert.ok(!res.ok, `${what}: ${JSON.stringify(raw)} should be rejected`);
    assert.ok(res.errors.some((e) => e.includes(what) || (what === 'journeys' && e.includes('journeys'))), `${what}: errors ${JSON.stringify(res.errors)}`);
  }
});

/** nextRequest takes the oldest, and prefers a request that reuses the last model. */
test('nextRequest groups by model to avoid a switch', () => {
  const a = { id: 'a', models: ['lfm3-1.7b'], queueTime: 1 };
  const b = { id: 'b', models: ['qwen3.5-0.8b'], queueTime: 2 };
  const c = { id: 'c', models: ['lfm3-1.7b'], queueTime: 3 };
  assert.equal(nextRequest([a, b, c], null).id, 'a'); // oldest, no last model
  assert.equal(nextRequest([a, b, c], 'qwen3.5-0.8b').id, 'b'); // reuses the last model even though it is not the oldest
  assert.equal(nextRequest([a, b, c], 'lfm3-1.7b').id, 'a'); // the oldest already reuses it
  assert.equal(nextRequest([b, c], 'no-such-model').id, 'b'); // no match: fall back to the oldest
  const tie1 = { id: 'z', models: ['m'], queueTime: 5 };
  const tie2 = { id: 'y', models: ['m'], queueTime: 5 };
  assert.equal(nextRequest([tie1, tie2], null).id, 'y'); // equal times: id order
  assert.equal(nextRequest([], null), null);
});

/** journeySummary counts solved journeys (all repeats pass) and NEEDS. */
test('journeySummary counts solved and needs', () => {
  const rows = [
    { id: 't-01-a', pass: true }, { id: 't-01-a', pass: true }, // solved: both repeats pass
    { id: 't-02-b', pass: true }, { id: 't-02-b', pass: false } // not solved
  ];
  const s = journeySummary({ model: 'm', scope: 'terminal', split: 'train', repeat: 2, oracle: false, app: 'terminal', journeyList: [1, 2], rows, needList: [{ id: 't-03-c' }], base: 'http://x' });
  assert.equal(s.total, 2);
  assert.equal(s.solved, 1);
  assert.equal(s.runs, 4);
  assert.equal(s.pass, 3);
  assert.deepEqual(s.needs, ['t-03-c']);
  assert.equal(s.oracle, false);
});

/** The results file name. */
test('resultsFileName', () => {
  assert.equal(resultsFileName('terminal', 'train', 'lfm3-1.7b', 42), 'journeys-terminal-train-lfm3-1.7b-42.json');
});

/** An oracle request jumps the queue: it uses no model and frees a lane quickly. */
test('nextRequest takes an oracle request before older model requests', () => {
  const reqs = [
    { id: 'b', models: ['lfm3-1.7b'], oracle: false, queueTime: 1 },
    { id: 'o', models: ['lfm3-1.7b'], oracle: true, queueTime: 5 },
  ];
  assert.equal(nextRequest(reqs, 'lfm3-1.7b').id, 'o');
  assert.equal(nextRequest([reqs[0]], 'lfm3-1.7b').id, 'b');
});

/** One unparseable journey file must not reject requests that do not need it (the 20 sweep
 *  requests killed by a mid-edit effectcraft.yaml): a request fails only when a file it
 *  needs - its app's file, every file for an all-apps request, or a file that may hold a
 *  requested id - does not parse, and the error names the file. */
test('loadJourneys: a broken file fails only the requests that need it, naming the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'journeys-'));
  writeFileSync(join(dir, 'effectcraft.yaml'), 'app: effectcraft\njourneys: [\n  - id: effectcraft-01-x\n');
  writeFileSync(join(dir, 'terminal.yaml'), 'app: terminal\njourneys:\n  - id: terminal-01-x\n    split: train\n    prompt: p\n');
  // The good app's request loads and runs; the broken app's request errors naming the file.
  assert.deepEqual([...loadJourneys('terminal', null, dir).keys()], ['terminal']);
  assert.throws(() => loadJourneys('effectcraft', null, dir), /effectcraft\.yaml does not parse/);
  // A journey-ids request whose ids all sit in parseable files proceeds despite the broken file.
  assert.deepEqual([...loadJourneys('all', ['terminal-01-x'], dir).keys()], ['terminal']);
  // ...but an id that is not in any parseable file names the broken file, and an all-apps
  // request (every file needed) fails on the broken one.
  assert.throws(() => loadJourneys('all', ['effectcraft-01-x'], dir), /effectcraft\.yaml/);
  assert.throws(() => loadJourneys('all', null, dir), /effectcraft\.yaml/);
});
