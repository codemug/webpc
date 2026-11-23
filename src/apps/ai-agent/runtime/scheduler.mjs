// Round-robin generation queue across chat threads, for the single local model
// worker. Pure apart from the job promises: no timers, no clock. A job is
// (signal) => Promise; cancel() aborts the signal of a thread's running job and
// rejects its queued jobs, so a job can observe the abort and clean up.
/** A fresh AbortError for a cancelled job. */
function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * concurrency: how many jobs run at once (1 for the single local model worker).
 *
 * run(threadId, job): enqueue job (signal) => Promise and return a promise for its
 * result. Round-robin across threads, FIFO within a thread.
 * cancel(threadId): abort the thread's running job (its signal) and reject its
 * queued jobs with an AbortError; a no-op when the thread has no work.
 * pending(threadId): the queued plus running count for that thread.
 * activeThreads(): the ids of threads with queued or running work, in rotation
 * order (first-seen).
 */
export function createScheduler({ concurrency = 1 } = {}) {
  let free = concurrency;
  const threads = new Map(); // id -> { queue: [entry], running: Set of entries }
  const order = []; // thread ids in first-seen order; the rotation sequence
  let cursor = -1; // index in order of the last started thread

  function thread(id) {
    let entry = threads.get(id);
    if (!entry) {
      entry = { queue: [], running: new Set() };
      threads.set(id, entry);
      order.push(id);
    }
    return entry;
  }

  // The next thread after cursor (wrapping) with queued work; null when none.
  function pick() {
    const n = order.length;
    for (let i = 1; i <= n; i++) {
      const index = (cursor + i) % n;
      if (threads.get(order[index]).queue.length > 0) {
        cursor = index;
        return order[index];
      }
    }
    return null;
  }

  function schedule() {
    while (free > 0) {
      const id = pick();
      if (!id) return;
      start(id);
    }
  }

  function start(id) {
    const t = threads.get(id);
    const entry = t.queue.shift();
    entry.state = 'running';
    t.running.add(entry);
    free -= 1;
    const controller = new AbortController();
    entry.controller = controller;
    let promise;
    try {
      promise = entry.job(controller.signal);
    } catch (error) {
      finish(entry, error);
      return;
    }
    promise.then(value => finish(entry, undefined, value), error => finish(entry, error));
  }

  // Settle a job exactly once and hand the slot back.
  function finish(entry, error, value) {
    if (entry.state === 'done') return;
    entry.state = 'done';
    threads.get(entry.id).running.delete(entry);
    free += 1;
    if (error !== undefined) entry.reject(error);
    else entry.resolve(value);
    schedule();
  }

  function run(id, job) {
    const t = thread(id);
    const entry = { id, job, state: 'queued' };
    const promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    t.queue.push(entry);
    schedule();
    return promise;
  }

  function cancel(id) {
    const t = threads.get(id);
    if (!t) return;
    // Snapshot: finish() may start new jobs on this thread, which must not be aborted.
    const running = [...t.running];
    for (const entry of running) {
      entry.controller.abort();
      finish(entry, abortError());
    }
    while (t.queue.length > 0) {
      const entry = t.queue.shift();
      entry.state = 'done';
      entry.reject(abortError());
    }
  }

  function pending(id) {
    const t = threads.get(id);
    return t ? t.queue.length + t.running.size : 0;
  }

  function activeThreads() {
    return order.filter(id => {
      const t = threads.get(id);
      return t.queue.length > 0 || t.running.size > 0;
    });
  }

  return { run, cancel, pending, activeThreads };
}
