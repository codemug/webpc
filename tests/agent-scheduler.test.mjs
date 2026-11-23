import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from '../src/apps/ai-agent/runtime/scheduler.mjs';

// A gated promise: the job stays running until a test resolves or rejects it.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Flush the microtask queue so scheduled starts and settles have run. No timers.
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

// A job factory that records its start and returns a gated promise.
function gated(started, gates, tag) {
  return () => {
    const d = deferred();
    gates.push(d);
    started.push(tag);
    return d.promise;
  };
}

test('two threads alternate job by job (round-robin)', async () => {
  const s = createScheduler();
  const started = [];
  const gates = [];
  s.run('a', gated(started, gates, 'a1'));
  s.run('a', gated(started, gates, 'a2'));
  s.run('b', gated(started, gates, 'b1'));
  s.run('b', gated(started, gates, 'b2'));
  await tick();
  assert.deepEqual(started, ['a1'], 'the first thread starts first');
  gates.at(-1).resolve();
  await tick();
  assert.deepEqual(started, ['a1', 'b1'], 'the other thread gets the freed slot');
  gates.at(-1).resolve();
  await tick();
  assert.deepEqual(started, ['a1', 'b1', 'a2']);
  gates.at(-1).resolve();
  await tick();
  assert.deepEqual(started, ['a1', 'b1', 'a2', 'b2']);
});

test('concurrency 2 runs two jobs at once, and a queued job waits for a slot', async () => {
  const s = createScheduler({ concurrency: 2 });
  const started = [];
  const g1 = deferred();
  const g2 = deferred();
  const g3 = deferred();
  s.run('a', () => { started.push('a1'); return g1.promise; });
  s.run('b', () => { started.push('b1'); return g3.promise; });
  s.run('a', () => { started.push('a2'); return g2.promise; });
  await tick();
  assert.deepEqual(started, ['a1', 'b1'], 'both slots fill; a2 waits');
  assert.equal(s.pending('a'), 2);
  assert.equal(s.pending('b'), 1);
  g1.resolve();
  await tick();
  assert.deepEqual(started, ['a1', 'b1', 'a2']);
  g2.resolve();
  g3.resolve();
  await tick();
  assert.equal(s.pending('a') + s.pending('b'), 0);
});

test('jobs of one thread run in FIFO order', async () => {
  const s = createScheduler();
  const started = [];
  const gates = [];
  s.run('a', gated(started, gates, 'a1'));
  s.run('a', gated(started, gates, 'a2'));
  s.run('a', gated(started, gates, 'a3'));
  await tick();
  assert.deepEqual(started, ['a1']);
  gates.at(-1).resolve();
  await tick();
  assert.deepEqual(started, ['a1', 'a2']);
  gates.at(-1).resolve();
  await tick();
  assert.deepEqual(started, ['a1', 'a2', 'a3']);
  gates.at(-1).resolve();
  await tick();
  assert.equal(s.pending('a'), 0);
});

test('a thread with 5 jobs does not starve a thread with 1', async () => {
  const s = createScheduler();
  const started = [];
  const gates = [];
  for (let i = 1; i <= 5; i++) s.run('a', gated(started, gates, `a${i}`));
  s.run('b', gated(started, gates, 'b1'));
  await tick();
  assert.deepEqual(started, ['a1']);
  gates.at(-1).resolve();
  await tick();
  assert.equal(started[1], 'b1', 'the single job starts second, not sixth');
  while (started.length < 6) {
    gates.at(-1).resolve();
    await tick();
  }
  assert.deepEqual(started, ['a1', 'b1', 'a2', 'a3', 'a4', 'a5']);
});

test('cancel aborts the running job and rejects it with an AbortError', async () => {
  const s = createScheduler();
  let signal;
  const d = deferred();
  const p = s.run('a', sig => { signal = sig; return d.promise; });
  await tick();
  assert.equal(signal.aborted, false);
  s.cancel('a');
  assert.equal(signal.aborted, true);
  await assert.rejects(p, error => error.name === 'AbortError');
  assert.equal(s.pending('a'), 0);
});

test('cancel rejects the queued jobs of a waiting thread and leaves others alone', async () => {
  const s = createScheduler();
  const hold = deferred();
  s.run('a', () => hold.promise);
  const q1 = s.run('b', () => Promise.resolve(1));
  const q2 = s.run('b', () => Promise.resolve(2));
  await tick();
  assert.equal(s.pending('b'), 2);
  s.cancel('b');
  const r1 = assert.rejects(q1, error => error.name === 'AbortError');
  const r2 = assert.rejects(q2, error => error.name === 'AbortError');
  await Promise.all([r1, r2]);
  assert.equal(s.pending('b'), 0);
  assert.equal(s.pending('a'), 1);
  hold.resolve();
  await tick();
  assert.deepEqual(s.activeThreads(), []);
});

test('cancelling one thread leaves the other running and the thread usable again', async () => {
  const s = createScheduler();
  const started = [];
  const hold = deferred();
  s.run('a', () => { started.push('a1'); return hold.promise; });
  const cancelled = s.run('b', () => { started.push('b1'); return Promise.resolve('b1'); });
  await tick();
  s.cancel('b');
  await assert.rejects(cancelled, error => error.name === 'AbortError');
  assert.deepEqual(started, ['a1'], 'the cancelled job never started');
  hold.resolve();
  await tick();
  const again = s.run('b', () => { started.push('b2'); return Promise.resolve('b2'); });
  await tick();
  assert.deepEqual(started, ['a1', 'b2']);
  assert.equal(await again, 'b2');
});

test('a rejection settles only its own promise and the queue keeps going', async () => {
  const s = createScheduler();
  const started = [];
  const d1 = deferred();
  const d3 = deferred();
  const p1 = s.run('a', () => { started.push(1); return d1.promise; });
  const p2 = s.run('a', () => { started.push(2); return Promise.resolve('two'); });
  const p3 = s.run('b', () => { started.push(3); return d3.promise; });
  await tick();
  assert.deepEqual(started, [1]);
  d1.reject(new Error('boom'));
  await assert.rejects(p1, /boom/);
  await tick();
  assert.deepEqual(started, [1, 3], 'the other thread gets the freed slot first (round-robin)');
  assert.equal(s.pending('a'), 1, 'a2 is still queued while b runs');
  d3.resolve('three');
  await tick();
  assert.deepEqual(started, [1, 3, 2], 'a2 runs when the rotation comes back to a');
  assert.equal(await p2, 'two');
  assert.equal(await p3, 'three');
  assert.equal(s.pending('a') + s.pending('b'), 0);
});

test('pending counts queued plus running, and zero for unknown threads', async () => {
  const s = createScheduler({ concurrency: 2 });
  const g1 = deferred();
  const g2 = deferred();
  s.run('a', () => g1.promise);
  s.run('a', () => g2.promise);
  s.run('b', () => Promise.resolve());
  assert.equal(s.pending('a'), 2, 'a1 and a2 start synchronously inside run');
  assert.equal(s.pending('b'), 1, 'b1 waits for a slot');
  assert.equal(s.pending('ghost'), 0);
  g1.resolve();
  g2.resolve();
  await tick();
  assert.equal(s.pending('a'), 0);
  assert.equal(s.pending('b'), 0);
});

test('activeThreads lists only threads with work, in rotation order', async () => {
  const s = createScheduler();
  const hold = deferred();
  s.run('a', () => hold.promise);
  s.run('b', () => Promise.resolve());
  s.run('a', () => Promise.resolve());
  await tick();
  assert.deepEqual(s.activeThreads(), ['a', 'b']);
  hold.resolve();
  await tick();
  assert.deepEqual(s.activeThreads(), []);
});

test('cancel is a no-op for unknown or empty threads', async () => {
  const s = createScheduler();
  s.cancel('ghost');
  const hold = deferred();
  const p = s.run('a', () => hold.promise);
  await tick();
  s.cancel('b');
  assert.equal(s.pending('a'), 1);
  hold.resolve('done');
  assert.equal(await p, 'done');
});

test('cancelling a running job frees the slot for the waiting thread at once', async () => {
  const s = createScheduler();
  const started = [];
  const d = deferred();
  const pa = s.run('a', () => { started.push('a1'); return d.promise; });
  const p = s.run('b', () => { started.push('b1'); return Promise.resolve('b1'); });
  await tick();
  assert.deepEqual(started, ['a1']);
  s.cancel('a');
  const ra = assert.rejects(pa, error => error.name === 'AbortError');
  await tick();
  assert.deepEqual(started, ['a1', 'b1'], 'b1 starts right after the cancel');
  assert.equal(await p, 'b1');
  await ra;
});

test('a job that throws synchronously rejects only itself and frees the slot', async () => {
  const s = createScheduler();
  const p1 = s.run('a', () => { throw new Error('sync'); });
  const p2 = s.run('a', () => Promise.resolve('after'));
  await assert.rejects(p1, /sync/);
  assert.equal(await p2, 'after');
  assert.equal(s.pending('a'), 0);
});
