// One shared model behind every chat thread. Each thread gets a facade whose generates are queued
// in a round-robin scheduler: a request is issued only when the scheduler gives the thread its
// turn (so `concurrency` holds for the worker and the network alike), tokens stream only to that
// thread, and stopping one thread interrupts only its own in-flight request - never another
// thread's work, and never the worker.
import { createScheduler } from './runtime/scheduler.mjs';

/**
 * client: a ModelClient, CloudClient or ChromeModelClient.
 * -> { forThread(threadId) -> facade, cancelThread(threadId) }
 * Local and Chrome models run one generation at a time (pass concurrency 1); the cloud allows 3.
 * facade = { get ready(), get supportsTools(), get host(), count(messages, tools),
 *            generate(messages, tools, onToken), stop() }
 */
export function createSharedModel(client, { concurrency = 1 } = {}) {
  const scheduler = createScheduler({ concurrency });
  const facades = new Map();

  function forThread(threadId) {
    if (!facades.has(threadId)) facades.set(threadId, makeFacade(threadId));
    return facades.get(threadId);
  }

  function cancelThread(threadId) {
    const facade = facades.get(threadId);
    if (facade) facade.stop();
    else scheduler.cancel(threadId); // unknown or never-facaded thread: a no-op
  }

  function makeFacade(threadId) {
    const live = new Map(); // running job: request id -> idempotent interrupt callback
    const facade = {
      get ready() { return client.ready; },
      get supportsTools() { return client.supportsTools; },
      get host() { return client.host; },
      // Tokenising is fast: straight to the client, which refuses it while a model loads.
      count(messages, tools) { return client.count(messages, tools); },
      generate(messages, tools, onToken = () => {}) {
        // The request is issued inside the job: only when the scheduler gives this thread its turn.
        return scheduler.run(threadId, (signal) => {
          if (!client.generateRequest) {
            // Chrome shape: the client issues the request inside the job, so a scheduler
            // cancel must still reach it; at concurrency 1 only this thread's request
            // can be in flight.
            signal.addEventListener('abort', () => client.stop?.(), { once: true });
            return client.generate(messages, tools, onToken);
          }
          const request = client.generateRequest(messages, tools, onToken);
          if (request.id == null) return request.promise; // refused (e.g. model not loaded): nothing to interrupt
          let once = true;
          const interruptRequest = () => {
            if (!once) return; // stop() and the signal listener both call this; interrupt once
            once = false;
            if (client.interrupt) client.interrupt(request.id);
            else client.abort?.(request.id);
          };
          live.set(request.id, interruptRequest);
          // A scheduler-side cancel aborts the job signal; interrupt the request by id too.
          signal.addEventListener('abort', interruptRequest, { once: true });
          return request.promise.finally(() => { live.delete(request.id); });
        });
      },
      // Cancel only this thread: queued jobs were never issued and are dropped by the
      // scheduler; running jobs are interrupted by their request id, plus the cancel.
      stop() {
        for (const interrupt of [...live.values()]) interrupt();
        scheduler.cancel(threadId);
      },
    };
    return facade;
  }

  return { forThread, cancelThread };
}
