// Unit tests for the shared model facades (shared-model.js): one client behind every chat thread,
// with per-thread generate queues, per-request worker interrupt and per-request cloud abort.
// Run: node --test tests/pc-ai-agent-shared-model.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedModel } from '../src/apps/ai-agent/shared-model.js';
import { ModelClient } from '../src/apps/ai-agent/model-client.js';
import { CloudClient } from '../src/apps/ai-agent/cloud-client.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const genIds = (posted) => posted.filter((m) => m.type === 'generate').map((m) => m.id);
const userMsg = (t) => [{ role: 'user', content: t }];

// A scripted stand-in for worker.js: serialized generate jobs, token/done/error messages and the
// per-request interrupt (a running id stops early with its partial text; a queued id is dropped).
function fakeWorker({ autoReady = true } = {}) {
  const posted = [];
  const started = [];
  const jobs = new Map();
  let runningId = null;
  let chain = Promise.resolve();
  const worker = {
    onmessage: null, onerror: null, terminated: false,
    dispatch(msg) { queueMicrotask(() => { if (this.onmessage) this.onmessage({ data: msg }); }); },
    postMessage(data) {
      posted.push(data);
      if (data.type === 'load') { if (autoReady) this.dispatch({ type: 'ready', key: data.key, vision: false }); return; }
      if (data.type === 'count') { this.dispatch({ type: 'counted', id: data.id, tokens: 7 }); return; }
      if (data.type === 'interrupt' || data.type === 'stop') {
        const handle = jobs.get(data.type === 'interrupt' ? data.id : runningId) ?? null;
        if (handle?.state === 'running') handle.interrupt();
        else if (data.type === 'interrupt' && handle?.state === 'queued') { handle.state = 'dropped'; this.dispatch({ type: 'error', id: handle.id, message: 'aborted' }); }
        return;
      }
      if (data.type === 'generate') {
        const handle = { id: data.id, state: 'queued', partial: '' };
        jobs.set(handle.id, handle);
        chain = chain.then(() => new Promise((resolve) => {
          if (handle.state !== 'queued') return resolve();
          handle.state = 'running';
          runningId = handle.id;
          started.push(handle.id);
          const end = (msg) => { if (handle.state !== 'running') return; runningId = null; handle.state = 'done'; this.dispatch(msg); resolve(); };
          handle.token = (text) => { handle.partial += text; this.dispatch({ type: 'token', id: handle.id, text }); };
          handle.finish = (text) => end({ type: 'done', id: handle.id, text });
          handle.fail = (message) => end({ type: 'error', id: handle.id, message });
          handle.interrupt = () => end({ type: 'done', id: handle.id, text: handle.partial });
        }));
      }
    },
    terminate() { this.terminated = true; },
  };
  return { worker, posted, started, jobs };
}

// A shared model over the fake worker (local model, concurrency 1) with one facade per thread id.
const localShared = async (harness, ids) => {
  const client = new ModelClient({ createWorker: () => harness.worker });
  await client.load('m');
  const shared = createSharedModel(client, { concurrency: 1 });
  return { harness, shared, facades: ids.map((id) => shared.forThread(id)) };
};

// A shared model over a CloudClient whose SSE bodies stay open until the test releases them
// (or the request signal aborts); gates are in request order.
const cloudShared = () => {
  const gates = [];
  const fetcher = (url, init) => {
    const n = gates.length + 1;
    let finish;
    const gate = new Promise((resolve) => { finish = resolve; });
    gates.push({ signal: init.signal, finish, n });
    init.signal.addEventListener('abort', () => finish(), { once: true });
    const body = new ReadableStream({
      async start(controller) {
        await gate;
        if (init.signal.aborted) { controller.error(new DOMException('Aborted', 'AbortError')); return; }
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: `done ${n}` } }] })}\n\ndata: [DONE]\n\n`));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const client = new CloudClient({ fetch: fetcher });
  client.configure({ provider: 'openai', model: 'm', baseUrl: 'https://llm.example.test', key: 'k' });
  return { client, gates, shared: createSharedModel(client, { concurrency: 3 }) };
};

// A client stand-in that records generateRequest calls; the test settles each request.
function recordingClient() {
  const issued = [];
  const interrupted = [];
  let id = 0;
  const client = {
    ready: true, supportsTools: true, host: 'fake.example.test',
    generateRequest() {
      const request = { id: ++id, resolve: null, done: false, promise: null };
      request.promise = new Promise((resolve) => { request.resolve = (value) => { request.done = true; resolve(value); }; });
      issued.push(request);
      return { id: request.id, promise: request.promise };
    },
    interrupt(requestId) { interrupted.push(requestId); },
    count() { return Promise.resolve(42); },
  };
  return { client, issued, interrupted };
}

test('concurrency 1: the second thread request is not issued until the first finishes', async () => {
  const { client, issued } = recordingClient();
  const shared = createSharedModel(client, { concurrency: 1 });
  const a = shared.forThread('a');
  const b = shared.forThread('b');
  const pa = a.generate([], []);
  const pb = b.generate([], []);
  await sleep(20);
  assert.equal(issued.length, 1, 'only the first request reaches the client');
  issued[0].resolve('a done');
  await pa;
  await sleep(20);
  assert.equal(issued.length, 2, 'b is issued only after a finished');
  issued[1].resolve('b done');
  assert.equal(await pb, 'b done');
});

test('concurrency 3 with 5 threads: at most 3 requests are in flight at once', async () => {
  const { client, issued } = recordingClient();
  const shared = createSharedModel(client, { concurrency: 3 });
  const promises = ['a', 'b', 'c', 'd', 'e'].map((id) => shared.forThread(id).generate([], []));
  await sleep(20);
  assert.equal(issued.length, 3, 'the first 3 slots issue exactly 3 requests');
  for (let step = 0; step < 5; step++) {
    const inFlight = issued.filter((r) => !r.done);
    assert.ok(inFlight.length >= 1 && inFlight.length <= 3, `at most 3 requests in flight (step ${step + 1})`);
    const before = issued.length;
    inFlight[0].resolve(`done ${step + 1}`);
    await sleep(20);
    if (step < 4) assert.equal(issued.length, Math.min(before + 1, 5), 'a freed slot is filled by the next waiting thread');
  }
  assert.deepEqual(await Promise.all(promises), ['done 1', 'done 2', 'done 3', 'done 4', 'done 5']);
});

test('stopping a queued job never calls the client at all', async () => {
  const { client, issued, interrupted } = recordingClient();
  const shared = createSharedModel(client, { concurrency: 1 });
  const a = shared.forThread('a');
  const b = shared.forThread('b');
  const pa = a.generate([], []);
  const pb = b.generate([], []);
  await sleep(20);
  assert.equal(issued.length, 1, 'a is issued; b is still queued');
  b.stop();
  await assert.rejects(pb, (e) => e.name === 'AbortError');
  assert.deepEqual(interrupted, [], 'b was never issued, so the client is never called for it');
  assert.equal(issued.length, 1);
  issued[0].resolve('a done');
  assert.equal(await pa, 'a done');
  assert.equal(issued.length, 1, 'the freed slot does not resurrect the cancelled job');
});

test('two threads alternate: the worker runs their jobs one at a time in round-robin order', async () => {
  const { harness, facades: [a, b] } = await localShared(fakeWorker(), ['a', 'b']);
  const pa1 = a.generate([], []);
  const pb1 = b.generate([], []);
  const pa2 = a.generate([], []);
  const pb2 = b.generate([], []);
  await sleep(20);
  let ids = genIds(harness.posted);
  assert.equal(ids.length, 1, 'the second job is not issued while the slot is busy');
  assert.deepEqual(harness.started, [ids[0]], 'only the first job runs');
  for (let i = 0; i < 4; i++) {
    harness.jobs.get(ids[i]).finish(`done ${i}`);
    await sleep(20);
    if (i < 3) {
      ids = genIds(harness.posted);
      assert.equal(ids.length, i + 2, `job ${i + 2} is issued once job ${i + 1} settles`);
      assert.deepEqual(harness.started, ids, `job ${i + 2} goes to the next thread in rotation`);
    }
  }
  assert.equal(await pa1, 'done 0');
  assert.equal(await pb1, 'done 1');
  assert.equal(await pa2, 'done 2');
  assert.equal(await pb2, 'done 3');
});

test('stop on one thread interrupts only its running job and never kills the worker', async () => {
  const { harness, facades: [a, b] } = await localShared(fakeWorker(), ['a', 'b']);
  const pa = a.generate([], []);
  const pb = b.generate([], []);
  await sleep(20);
  const [idA] = genIds(harness.posted);
  harness.jobs.get(idA).token('part ');
  harness.jobs.get(idA).token('ial');
  a.stop();
  await assert.rejects(pa, (e) => e.name === 'AbortError');
  assert.deepEqual(harness.posted.filter((m) => m.type === 'interrupt'), [{ type: 'interrupt', id: idA }], 'exactly one interrupt, carrying only the stopped thread id');
  await sleep(20);
  const [idA2, idB] = genIds(harness.posted);
  assert.equal(idA2, idA, 'a was the only job issued before the stop');
  assert.deepEqual(harness.started, [idA, idB], 'b starts right after a was interrupted');
  harness.jobs.get(idB).finish('full b');
  assert.equal(await pb, 'full b', 'the other thread keeps its full result');
  assert.equal(harness.worker.terminated, false, 'the worker is never killed by a thread stop');
});

test('stop on a thread with only queued jobs drops them without starting them', async () => {
  const { harness, facades: [a, b] } = await localShared(fakeWorker(), ['a', 'b']);
  const pa = a.generate([], []);
  const pb = b.generate([], []);
  await sleep(20);
  const [idA] = genIds(harness.posted);
  b.stop();
  await assert.rejects(pb, (e) => e.name === 'AbortError');
  assert.equal(harness.posted.find((m) => m.type === 'interrupt'), undefined, 'the queued job was never issued: nothing to interrupt');
  harness.jobs.get(idA).finish('a done');
  await sleep(20);
  assert.deepEqual(genIds(harness.posted), [idA], 'b was never posted to the worker');
  assert.deepEqual(harness.started, [idA], 'b never ran in the worker');
  assert.equal(await pa, 'a done', 'the running thread is untouched');
});

test('cloud: a thread stop aborts only its own in-flight request', async () => {
  const { gates, shared } = cloudShared();
  const a = shared.forThread('a');
  const b = shared.forThread('b');
  const pa = a.generate(userMsg('a'), []);
  const pb = b.generate(userMsg('b'), []);
  await sleep(20);
  assert.equal(gates.length, 2, 'both requests are in flight at once');
  a.stop();
  assert.equal(gates[0].signal.aborted, true, 'only the stopped request is aborted');
  assert.equal(gates[1].signal.aborted, false);
  await assert.rejects(pa, (e) => e.name === 'AbortError');
  gates[1].finish();
  assert.equal((await pb).text, 'done 2');
});

test('cloud: three concurrent requests, stop the middle one', async () => {
  const { gates, shared } = cloudShared();
  const a = shared.forThread('a');
  const b = shared.forThread('b');
  const c = shared.forThread('c');
  const pa = a.generate(userMsg('a'), []);
  const pb = b.generate(userMsg('b'), []);
  const pc = c.generate(userMsg('c'), []);
  await sleep(20);
  assert.equal(gates.length, 3);
  b.stop();
  await assert.rejects(pb, (e) => e.name === 'AbortError');
  assert.deepEqual(gates.map((g) => g.signal.aborted), [false, true, false], 'only the middle request is aborted');
  gates[0].finish();
  gates[2].finish();
  assert.equal((await pa).text, 'done 1');
  assert.equal((await pc).text, 'done 3');
});

test('ready, supportsTools and host pass through the facade', () => {
  const client = { ready: true, supportsTools: true, host: 'fake.example.test' };
  const facade = createSharedModel(client).forThread('t');
  assert.equal(facade.ready, true);
  assert.equal(facade.supportsTools, true);
  assert.equal(facade.host, 'fake.example.test');
  client.ready = false;
  client.supportsTools = false;
  client.host = 'other.example.test';
  assert.equal(facade.ready, false);
  assert.equal(facade.supportsTools, false);
  assert.equal(facade.host, 'other.example.test');
});

test('tokens stream only to the thread that generated them', async () => {
  const { harness, facades: [a, b] } = await localShared(fakeWorker(), ['a', 'b']);
  const gotA = [];
  const gotB = [];
  const pa = a.generate([], [], (t) => gotA.push(t));
  const pb = b.generate([], [], (t) => gotB.push(t));
  await sleep(20);
  harness.jobs.get(harness.started[0]).token('a1 ');
  harness.jobs.get(harness.started[0]).token('a2');
  await sleep(10);
  assert.deepEqual(gotA, ['a1 ', 'a2']);
  assert.deepEqual(gotB, [], 'b gets nothing while a runs');
  harness.jobs.get(harness.started[0]).finish('a1 a2');
  await sleep(20);
  assert.equal(harness.started.length, 2, 'b is issued once a settles');
  harness.jobs.get(harness.started[1]).token('b1');
  harness.jobs.get(harness.started[1]).finish('b1');
  await sleep(10);
  assert.deepEqual(gotB, ['b1']);
  assert.equal(await pa, 'a1 a2');
  assert.equal(await pb, 'b1');
});

test('a failed generation rejects only its own thread and the queue keeps going', async () => {
  const { harness, facades: [a, b] } = await localShared(fakeWorker(), ['a', 'b']);
  const pa = a.generate([], []);
  const pb = b.generate([], []);
  await sleep(20);
  const [idA] = genIds(harness.posted);
  harness.jobs.get(idA).fail('boom');
  await assert.rejects(pa, /boom/);
  await sleep(20);
  const [, idB] = genIds(harness.posted);
  assert.deepEqual(harness.started, [idA, idB], 'b is issued and starts after a failed');
  harness.jobs.get(idB).finish('b ok');
  assert.equal(await pb, 'b ok');
});

test('stop with no work and cancelThread on an unknown thread are no-ops', async () => {
  const interrupted = [];
  let id = 0;
  const client = {
    ready: true, supportsTools: true, host: 'fake.example.test',
    generateRequest() {
      const request = { id: ++id, promise: new Promise(() => {}) };
      return { id: request.id, promise: request.promise };
    },
    interrupt(requestId) { interrupted.push(requestId); },
    count() { return Promise.resolve(42); },
  };
  const shared = createSharedModel(client, { concurrency: 1 });
  const facade = shared.forThread('t');
  facade.stop();
  shared.cancelThread('ghost');
  assert.deepEqual(interrupted, []);
  const gen = facade.generate([], []);
  shared.cancelThread('t');
  await assert.rejects(gen, (e) => e.name === 'AbortError');
  assert.deepEqual(interrupted, [1], 'cancelThread stops the thread like facade.stop');
});

test('before the model is loaded, generate and count reject without touching the worker', async () => {
  const harness = fakeWorker({ autoReady: false });
  const client = new ModelClient({ createWorker: () => harness.worker });
  const facade = createSharedModel(client, { concurrency: 1 }).forThread('t');
  const loading = client.load('m');
  await assert.rejects(facade.generate([], []), /Load a model first/);
  await assert.rejects(facade.count([], []), /Load a model first/);
  assert.equal(harness.posted.filter((m) => m.type === 'generate').length, 0);
  harness.worker.dispatch({ type: 'ready', key: 'm', vision: false });
  await loading;
  assert.equal(await facade.count([], []), 7, 'count bypasses the queue and answers from the worker');
});

test('cancelThread interrupts the thread running job', async () => {
  const { harness, shared } = await localShared(fakeWorker(), ['a']);
  const a = shared.forThread('a');
  const pa = a.generate([], []);
  await sleep(20);
  const [idA] = genIds(harness.posted);
  shared.cancelThread('a');
  await assert.rejects(pa, (e) => e.name === 'AbortError');
  assert.deepEqual(harness.posted.find((m) => m.type === 'interrupt'), { type: 'interrupt', id: idA });
  assert.equal(harness.worker.terminated, false);
});

test('a client without generateRequest (chrome shape): a queued job is dropped without touching the client', async () => {
  const issued = [];
  let id = 0;
  const jobs = new Map();
  const client = {
    ready: true, supportsTools: false,
    generate() {
      const request = { id: ++id, promise: null };
      request.promise = new Promise((resolve) => { request.resolve = resolve; });
      jobs.set(request.id, request);
      issued.push(request.id);
      return request.promise;
    },
    stop() { jobs.get(issued.at(-1))?.resolve('stopped'); },
    count() { return Promise.resolve(1); },
  };
  const shared = createSharedModel(client, { concurrency: 1 });
  const a = shared.forThread('a');
  const b = shared.forThread('b');
  const pa = a.generate([], []);
  const pb = b.generate([], []);
  await sleep(20);
  assert.equal(issued.length, 1, 'only the running job issued a request');
  b.stop();
  await assert.rejects(pb, (e) => e.name === 'AbortError');
  assert.equal(issued.length, 1, 'dropping a queued job never starts its request');
  a.stop();
  await assert.rejects(pa, (e) => e.name === 'AbortError');
});
