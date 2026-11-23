// Thread storage for the Buddy agent: one index row per thread under INDEX_KEY
// plus one record per thread under threadKey(id). Storage, clock and id
// generator are injected so unit tests run in Node (browser passes idb-keyval).
import { validateConversation } from './storage.js';

/** Key holding the index array of thread rows. */
export const INDEX_KEY = 'buddy:threads';
/** Key flagging that the legacy single-conversation records were migrated. */
export const MIGRATED_KEY = 'buddy:threads:migrated';
/** Maximum number of threads kept in the index. */
export const MAX_THREADS = 200;
/** Maximum thread title length, ellipsis included. */
export const TITLE_MAX = 60;
/** Every status a thread row may carry. */
export const STATUSES = ['idle', 'running', 'waiting', 'needs_you', 'done', 'failed', 'interrupted'];
/** Statuses markInterrupted flips to interrupted on startup. */
const ACTIVE_STATUSES = ['running', 'waiting', 'needs_you'];
/** Control and bidi-embedding characters a title must not contain. */
const BAD_TITLE = /[\u0000-\u001F\u007F\u00AD\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

/** Storage key for one thread's record. */
export const threadKey = id => `buddy:thread:${id}`;

/** Thrown when the index already holds MAX_THREADS threads. */
export class ThreadLimitError extends Error {}

/** Title for a history: first user message, whitespace collapsed, cut to TITLE_MAX. */
export function titleFrom(history) {
  const first = Array.isArray(history) ? history.find(m => m?.role === 'user' && typeof m.content === 'string')?.content : '';
  const text = (first ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return 'New chat';
  return text.length > TITLE_MAX ? text.slice(0, TITLE_MAX - 3) + '...' : text;
}

/** Cap a non-empty title at TITLE_MAX, appending an ellipsis when cut. */
function capTitle(title) {
  return title.length > TITLE_MAX ? title.slice(0, TITLE_MAX - 3) + '...' : title;
}

/** Trim, reject empty or control or bidi characters, cap at TITLE_MAX. */
function normalizeTitle(title) {
  const text = String(title).trim();
  if (!text) throw new Error('The thread title must not be empty');
  if (BAD_TITLE.test(text)) throw new Error('The thread title contains disallowed characters');
  return capTitle(text);
}

/** True for a well-formed index row. */
function validRow(row) {
  return row != null && typeof row === 'object' && typeof row.id === 'string' && row.id !== '' &&
    typeof row.title === 'string' && Number.isFinite(row.createdAt) && Number.isFinite(row.updatedAt) &&
    STATUSES.includes(row.status) && (row.backend == null || typeof row.backend === 'string');
}

/** True for a loadable thread record. */
function isRecord(value) {
  return value != null && typeof value === 'object' && Array.isArray(value.history);
}

/**
 * Build the thread store. kv is {get,set,del} (idb-keyval's functions in the
 * browser), now returns ms timestamps and newId returns unique thread ids.
 * No data is cached, so a second store over the same kv sees the same threads.
 * Index mutations run on one promise chain so concurrent readIndex, modify,
 * writeIndex cycles cannot drop each other's row changes.
 */
export function createThreadStore({ kv, now, newId }) {
  let queue = Promise.resolve();
  const serial = fn => (queue = queue.then(fn, fn));
  async function readIndex() {
    const stored = await kv.get(INDEX_KEY);
    return Array.isArray(stored) ? stored : [];
  }
  async function writeIndex(rows) {
    await kv.set(INDEX_KEY, rows.filter(validRow));
  }
  async function addThread({ title, backend, history = [], summary = '' }) {
    const id = newId();
    const ts = now();
    const row = { id, title, createdAt: ts, updatedAt: ts, status: 'idle', backend };
    if (backend == null) delete row.backend;
    // Record first, then the index: a reader never sees a row without its record.
    await kv.set(threadKey(id), structuredClone({ history, summary, revision: 0 }));
    const rows = await readIndex();
    rows.push(row);
    await writeIndex(rows);
    return row;
  }
  return {
    /** List index rows with a loadable record, newest updatedAt first. Corrupt data is skipped, never thrown. */
    async list() {
      const rows = (await readIndex()).filter(validRow);
      const checked = await Promise.all(rows.map(async row => [row, await kv.get(threadKey(row.id))]));
      return checked.filter(([, record]) => isRecord(record)).map(([row]) => row)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },
    /** Create a thread (status idle) and return its index row. Throws ThreadLimitError at MAX_THREADS. */
    create: ({ title, backend } = {}) => serial(async () => {
      if ((await readIndex()).filter(validRow).length >= MAX_THREADS) throw new ThreadLimitError(`Thread limit of ${MAX_THREADS} reached`);
      const trimmed = title == null ? '' : String(title).trim();
      return addThread({ title: trimmed ? normalizeTitle(trimmed) : 'New chat', backend });
    }),
    /** Load one thread's record ({id,history,summary,revision}), or null when missing or corrupt. */
    async load(id) {
      const record = await kv.get(threadKey(id));
      if (!isRecord(record)) return null;
      return structuredClone({ id, history: record.history, summary: record.summary ?? '', revision: Number.isInteger(record.revision) ? record.revision : 0 });
    },
    /** Save history and summary: validates, bumps revision and updatedAt, derives the title while it is still the default. */
    save: (id, { history, summary }) => serial(async () => {
      const clean = validateConversation({ history, summary });
      const existing = await kv.get(threadKey(id));
      const revision = (isRecord(existing) && Number.isInteger(existing.revision) ? existing.revision : 0) + 1;
      const ts = now();
      await kv.set(threadKey(id), structuredClone({ history: clean.history, summary: clean.summary, revision }));
      const rows = (await readIndex()).filter(validRow);
      let row = rows.find(r => r.id === id);
      if (!row) {
        // Self-heal a record whose index row was lost: keep it visible in list().
        row = { id, title: 'New chat', createdAt: ts, updatedAt: ts, status: 'idle' };
        rows.push(row);
      }
      row.updatedAt = ts;
      if (!row.title || row.title === 'New chat') row.title = titleFrom(history);
      await writeIndex(rows);
      return { id, history: clean.history, summary: clean.summary, revision };
    }),
    /** Rename a thread: trimmed, capped at TITLE_MAX, empty or control or bidi characters rejected. */
    rename: (id, title) => serial(async () => {
      const rows = (await readIndex()).filter(validRow);
      const row = rows.find(r => r.id === id);
      if (!row) throw new Error(`Unknown thread: ${id}`);
      row.title = normalizeTitle(title);
      row.updatedAt = now();
      await writeIndex(rows);
      return row;
    }),
    /** Set a thread's status (one of STATUSES). Only the status field changes. */
    setStatus: (id, status) => serial(async () => {
      if (!STATUSES.includes(status)) throw new Error(`Invalid thread status: ${status}`);
      const rows = (await readIndex()).filter(validRow);
      const row = rows.find(r => r.id === id);
      if (!row) throw new Error(`Unknown thread: ${id}`);
      row.status = status;
      await writeIndex(rows);
      return row;
    }),
    /** Delete a thread's record and its index row. No-op when nothing exists. */
    remove: id => serial(async () => {
      await kv.del(threadKey(id));
      const rows = (await readIndex()).filter(validRow);
      const kept = rows.filter(r => r.id !== id);
      if (kept.length !== rows.length) await writeIndex(kept);
    }),
    /** Turn every running, waiting or needs_you thread into interrupted. Returns how many changed. */
    markInterrupted: () => serial(async () => {
      const rows = (await readIndex()).filter(validRow);
      let changed = 0;
      for (const row of rows) if (ACTIVE_STATUSES.includes(row.status)) { row.status = 'interrupted'; changed += 1; }
      if (changed) await writeIndex(rows);
      return changed;
    }),
    /**
     * Copy the legacy single-conversation records into at most two threads: current
     * (titled from its history) and previous (titled "Previous chat"). Records with
     * no messages are skipped. Idempotent via MIGRATED_KEY; legacy keys are never touched.
     */
    migrateLegacy: ({ current, previous } = {}) => serial(async () => {
      if (await kv.get(MIGRATED_KEY)) return 0;
      const plans = [];
      // previous first, so an advancing clock keeps the current chat newest.
      if (previous != null && Array.isArray(previous.history) && previous.history.length > 0) plans.push({ title: 'Previous chat', record: previous });
      if (current != null && Array.isArray(current.history) && current.history.length > 0) plans.push({ title: titleFrom(current.history), record: current });
      const created = [];
      for (const { title, record } of plans) {
        const clean = validateConversation({ history: record.history, summary: record.summary });
        const id = newId();
        const ts = now();
        await kv.set(threadKey(id), structuredClone({ history: clean.history, summary: clean.summary, revision: 0 }));
        created.push({ id, title, createdAt: ts, updatedAt: ts, status: 'idle' });
      }
      if (created.length) {
        const rows = (await readIndex()).filter(validRow);
        rows.push(...created);
        await writeIndex(rows);
      }
      await kv.set(MIGRATED_KEY, true);
      return created.length;
    }),
  };
}
