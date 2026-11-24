// The Terminal app on unkernel: a real 64-bit Alpine Linux guest in a module Web Worker (it
// never blocks the page), a shell on a pty drawn by the existing xterm.js, and files on the
// persistent data disk (IndexedDB in the worker, seeded from the pre-baked template that
// carries Python and Node only on first use). One tab writes the disk at a time: this page
// holds the Web Lock kwdisk:<name>-<version> (the IndexedDB database's own name) for the
// kernel's lifetime, and a second tab boots the disk in the SDK's snapshot mode instead.
// The kernel, the distro image and the template are served from /pc/vendor/unkernel/ by
// prepare-terminal.mjs. The kernel's console (boot
// log, the console's own shell) never reaches xterm: only the pty shell does. Buddy's exec
// bridge (this file, over vm.exec()) answers BroadcastChannel('webpc-terminal'); the pure
// rules live in terminal-exec.mjs.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { setupApp } from './common.mjs';
import { validateExecRequest, planExec, execReply, handleExecChannelMessage, execGate } from './terminal-exec.mjs';

const $ = selector => document.querySelector(selector);
const base = new URL('/pc/vendor/unkernel/', location.href).href;
// The SDK is a vendored static file, so it is loaded at run time (a static import of a
// public/ path fails the build: Rollup cannot resolve it).
let sdk = null;
const unkernel = () => (sdk ??= import(/* @vite-ignore */ `${base}web.mjs`));
const term = new Terminal({ cursorBlink: true, fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim(), fontSize: 13, scrollback: 1200 });
const fit = new FitAddon();
term.loadAddon(fit);
term.open($('#terminal'));
let vm = null, pty = null, meta = null, template = null, distroUrl = null, support = null, busy = false, closing = false;
let promptSeen = false, heldInput = ''; // see attachShell() and pump()
let diskLockRelease = null; // resolves the Web Lock's hold promise: the lock ends here or when the page closes
let notSavedChip = null; // the header chip shown while this tab runs a snapshot that is not saved
let exec = null; // one run at a time: { req, controller, cancelled }
let diskOwner = false; // set from the boot's lock.held: only the tab that holds the saved disk runs exec requests
const report = (text, error = false) => { $('#terminal-status').textContent = text; $('#terminal-status').dataset.error = String(error); };
function controls() {
  $('#linux-start').disabled = busy || !!vm;
  $('#linux-restart').disabled = busy || !vm;
  $('#linux-fit').disabled = !vm;
  document.querySelectorAll('[data-linux-key]').forEach(button => { button.disabled = !vm; });
}
async function manifest() {
  if (!meta) {
    const response = await fetch(`${base}release.json`);
    if (!response.ok) throw new Error('Linux is temporarily unavailable. Reload the page or try again later.');
    meta = await response.json();
  }
  return meta;
}
// One tab writes the data disk (IndexedDB) at a time: two tabs saving the same store at
// once can corrupt the user's files. Take the one-tab lock the SDK's own page uses
// (data-disk.md:154-156; its worker-mode note at 157-161 is exactly this flow: the page
// takes the lock, then sends the disk as a spec, mode "snapshot" without the lock). The
// lock key is the IndexedDB database's own name: the SDK's IdbStore opens "kwdisk:<name>-
// <version>" (js/web/disk.ts). Held for the kernel's lifetime: released on shutdown and on
// the kernel's exit (releaseDiskLock), and by the browser when the page closes.
function acquireDiskLock(name, version) {
  if (typeof navigator === 'undefined' || !navigator.locks?.request) {
    // No Web Locks API (plain http page): there is no way to tell whether another tab has
    // the disk open, so keep the old behaviour (M1) instead of guessing.
    return Promise.resolve({ held: true, why: 'no Web Locks API here, so this page cannot tell whether another tab has the disk open' });
  }
  return new Promise(resolve => {
    try {
      navigator.locks.request(`kwdisk:${name}-${version}`, { ifAvailable: true }, lock => {
        if (!lock) { resolve({ held: false, why: 'another tab of the Terminal has the saved disk open' }); return; }
        let release;
        diskLockRelease = () => { diskLockRelease = null; release(); };
        resolve({ held: true, why: null });
        return new Promise(r => { release = r; }); // held until releaseDiskLock() or the page closes
      });
    } catch (error) {
      // Taking the lock failed: boot the snapshot, the side that cannot corrupt the disk.
      resolve({ held: false, why: `the Web Lock could not be taken (${error?.message ?? error})` });
    }
  });
}
function releaseDiskLock() { diskLockRelease?.(); }
// The chip the header shows while this tab runs a snapshot that is not saved.
function setNotSavedChip(on, title) {
  // The two chips contradict each other, so only one shows at a time.
  const saved = document.querySelector('[data-chip="saved"]');
  if (saved) saved.hidden = on;
  if (!on) { notSavedChip?.remove(); notSavedChip = null; return; }
  if (!notSavedChip) {
    notSavedChip = document.createElement('span');
    notSavedChip.className = 'linux-chip';
    notSavedChip.textContent = 'Not saved: open in another tab';
    document.querySelector('.linux-chips')?.appendChild(notSavedChip);
  }
  notSavedChip.title = title;
}
// The saved data disk, if there is one, is used unchanged: the store is keyed by name and
// format version, never reseeded (unkernel's data-disk.md, "Persistence in the browser"),
// so a seeded store ignores whatever template is passed. Peek at it read-only (identity +
// the initialized mark; no writes, no lock) and skip the 40 MB template download.
async function savedDiskReady(name, version) {
  const { dataDiskStore } = await unkernel();
  const { store } = dataDiskStore(0, { name, version });
  try {
    const saved = await store.identity();
    if (typeof saved !== 'string') return false;
    return (await store.open(saved, { write: false })).initialized;
  } catch {
    return false; // a failed peek keeps the template download; a seeded store would ignore it anyway
  } finally {
    await store.close().catch(() => {});
  }
}
async function diskTemplate(m) {
  if (template) return template; // a failed first boot may need another try without re-downloading
  if (await savedDiskReady(m.disk?.name ?? 'webpc-terminal', m.disk?.version ?? 'v1')) return 'bundled';
  const response = await fetch(`${base}data-template.kwsparse.gz`);
  if (!response.ok) throw new Error('The Linux image is temporarily unavailable. Reload the page or try again later.');
  template = new Uint8Array(await response.arrayBuffer());
  return template;
}
async function boot() {
  const { checkSupport, createKernel } = await unkernel();
  if (!support) {
    support = await checkSupport();
    if (!support.ok) throw new Error(`This browser cannot run the Terminal: ${support.problems.join('; ')}.`);
  }
  const m = await manifest();
  const diskName = m.disk?.name ?? 'webpc-terminal';
  const diskVersion = m.disk?.version ?? 'v1';
  setNotSavedChip(false);
  const lock = await acquireDiskLock(diskName, diskVersion);
  diskOwner = lock.held;
  if (!distroUrl) {
    // Fetch the 4 MB image whole and hand the worker a blob: URL it reads by range. GitHub Pages
    // gzips byte-range responses for binary files (the range then applies to the compressed bytes),
    // which corrupts the SDK's lazy Range reads; a plain fetch is decompressed by the browser.
    const response = await fetch(`${base}${m.distro?.file ?? 'alpine.erofs'}`);
    if (!response.ok) throw new Error('The Linux image is temporarily unavailable. Reload the page or try again later.');
    distroUrl = URL.createObjectURL(new Blob([await response.arrayBuffer()]));
  }
  report('Booting Alpine Linux…');
  // Worker mode takes disk specs (plain structured-cloneable data; the worker forwards
  // every field, js/web/devices.ts:34). The data disk store lives in IndexedDB in the
  // worker and is seeded from the template on first use only; no net option means the
  // guest has no eth0, offline as today. Without the one-tab lock the spec asks for the
  // SDK's snapshot mode (DataDiskSpec.mode, index.d.mts:4585-4586; openDataDisk,
  // js/web/disk.ts:399-422): an in-memory copy, started from the saved disk, the guest
  // can write but never reaches IndexedDB. The copy is bounded by snapshotLimit
  // (js/web/disk.ts:370-371, default 64 MiB): the pre-baked seed is ~107 MiB of blocks,
  // so over the default the second tab would fall back to the bare template; over the
  // raised limit it still boots, from the template, and says so.
  const disk = { kind: 'data', name: diskName, version: diskVersion };
  if (lock.held) disk.template = await diskTemplate(m); // first use: the pre-baked bytes; a saved disk: 'bundled'
  else {
    disk.mode = 'snapshot';
    disk.template = 'bundled'; // only the fallback base; the base is the copy of the saved disk
    disk.snapshotLimit = 512 * 1024 * 1024;
  }
  try {
    vm = await createKernel({ distro: distroUrl, disks: [disk], memoryMiB: m.memoryMiB ?? 512, worker: true });
  } catch (error) {
    vm = null;
    releaseDiskLock();
    throw error;
  }
  watchConsole();
  const booted = vm;
  vm.exited.then(result => {
    if (closing || vm !== booted) return; // an older kernel exiting after a restart must not clear the new one
    vm = null;
    pty = null;
    releaseDiskLock();
    report(`Linux stopped (${result?.reason || result?.kind || 'unknown'}). Start Linux to begin again.`, true);
    controls();
  }).catch(() => {});
  await attachShell();
  template = null; // the store is seeded now (or there is no IndexedDB to seed); 'bundled' covers the next boot
  if (lock.held) {
    report('Linux is running · offline · files are kept in this browser.');
  } else {
    setNotSavedChip(true, `Another tab of the Terminal has the saved disk open (the Web Lock kwdisk:${diskName}-${diskVersion} is held), so this tab runs a copy in memory: nothing written here is saved. Close the other tab and restart to keep files.`);
    report('Linux is running, but files written here are not saved: the saved disk is open in another tab. Close that tab and restart to keep files.', true);
  }
  controls();
}
// The kernel console is not drawn into xterm (its boot log and its own shell prompt would
// sit next to the pty's). It is watched for the one line the guest prints when it cannot
// use the saved data disk's upper layer (data-disk.md: "kw-overlay: SAFE MODE: <reason>"
// is what the page watches for).
function watchConsole() {
  const decoder = new TextDecoder();
  let tail = '';
  vm.onOutput(bytes => {
    tail = (tail + decoder.decode(bytes, { stream: true })).slice(-400);
    const match = tail.match(/kw-overlay: SAFE MODE: ([^\r\n]+)/);
    if (match) report(`The guest's saved file layer could not be mounted this boot (safe mode: ${match[1].trim()}). Files written this session are kept; the previous ones are untouched.`, true);
  });
}
async function attachShell() {
  const shell = await vm.spawn('/bin/sh', [], { cols: term.cols, rows: term.rows });
  if (closing || !vm) { shell.close().catch(() => {}); return; }
  pty = shell;
  promptSeen = false; heldInput = ''; clearTimeout(settleTimer); settleTimer = null; // hold typed input until this shell settles
  shell.ended.then(end => {
    if (pty !== shell || !vm || closing) return;
    report(end?.type === 'exit' ? `The shell exited (code ${end.code}). Starting a new one…` : 'The shell was lost. Starting a new one…');
    attachShell();
  }).catch(() => {});
  pump(shell);
  term.focus();
}
function pump(shell) {
  const ptyDecoder = new TextDecoder();
  (async () => {
    const reader = shell.output.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      term.write(ptyDecoder.decode(value, { stream: true }));
      if (!promptSeen && pty === shell) settleThenRelease(shell);
    }
  })().catch(() => {});
}
// busybox sh's line editor prints its first prompt and then asks the terminal for the cursor
// position (ESC[6n); xterm.js answers with a report (ESC[row;colR). busybox reads keys into a
// 16-byte buffer and drops what else arrived in the same read as that report, so keystrokes
// that land with it are lost (measured: the first 9 or 10 characters of a command typed as
// the prompt appears). The report is passed through at once; typed input is held from the
// shell's start until its output has been quiet for SETTLE_MS (at most SETTLE_CAP_MS after the
// first output), so the two never share a read.
const SETTLE_MS = 250, SETTLE_CAP_MS = 2000;
const CURSOR_REPORT = /^\x1b\[\d+;\d+R$/;
let settleTimer = null, settleStart = 0;
function settleThenRelease(shell) {
  const now = Date.now();
  if (!settleTimer) settleStart = now;
  clearTimeout(settleTimer);
  const wait = Math.max(0, Math.min(SETTLE_MS, SETTLE_CAP_MS - (now - settleStart)));
  settleTimer = setTimeout(() => {
    settleTimer = null;
    if (pty !== shell) return;
    promptSeen = true;
    if (heldInput) { const text = heldInput; heldInput = ''; shell.write(text).catch(() => {}); }
  }, wait);
}
term.onData(data => {
  if (!pty) return; // no shell yet (booting or restarting): there is nothing to type into
  if (CURSOR_REPORT.test(data)) { pty.write(data).catch(() => {}); return; } // xterm's reply, never held
  if (!promptSeen) { heldInput += data; return; }
  pty.write(data).catch(() => {});
});
for (const button of document.querySelectorAll('[data-linux-key]')) button.onclick = () => {
  const key = { interrupt: '\x03', tab: '\t', escape: '\x1b' }[button.dataset.linuxKey];
  if (pty && !busy) pty.write(key).catch(() => {});
  term.focus();
};
$('#linux-start').onclick = () => action(boot);
$('#linux-restart').onclick = () => action(async () => {
  if (!confirm('Restart Linux? Your files are kept; running processes end.')) return;
  // `closing` covers only the shutdown: the new boot's shell must attach (attachShell closes
  // a shell that arrives while closing is set).
  closing = true;
  try { await shutdown(); } finally { closing = false; }
  term.reset();
  await boot();
});
async function shutdown() {
  try { await pty?.close(); } catch { /* The session is already gone. */ }
  try { await vm?.stop(); } catch { /* The kernel is already gone. */ }
  vm = null;
  pty = null;
  releaseDiskLock();
}
$('#linux-fit').onclick = () => {
  try { fit.fit(); } catch { /* Hidden desktop window. */ }
  pty?.resize(term.cols, term.rows);
  term.focus();
};
new ResizeObserver(() => {
  try { fit.fit(); pty?.resize(term.cols, term.rows); } catch { /* Hidden desktop window. */ }
}).observe($('#terminal'));
$('#linux-help').onclick = () => {
  const hidden = !$('#linux-help-panel').hidden;
  $('#linux-help-panel').hidden = hidden;
  $('#linux-help').setAttribute('aria-expanded', String(!hidden));
};
// Exec service: other same-origin pages post {type:'exec-request', id, from, lang, code,
// timeoutMs} on BroadcastChannel('webpc-terminal'). Any same-origin page (including
// third-party bundles) can post, so a request is validated (terminal-exec.mjs) and a valid
// one runs at once on the guest: no approval prompt (M3), the status line says what runs
// and how it ended. Only the tab that holds the saved disk's lock (diskOwner) runs: a
// snapshot tab replies not-running, so with two tabs the owner wins - the client ignores a
// not-running after the owner's exec-pending ack (exec-client.js grace), and with only a
// snapshot tab up the run settles not-running after the grace. One run at a time. The run
// is a vm.exec() session (separate from the pty shell), so the shell stays usable while a
// command runs. Replies: exec-pending (the
// request was accepted and is running), exec-result, and exec-error with reason invalid,
// busy, not-running or timeout ('cancelled' when Buddy's exec-cancel stops the run first).
// Replies are never answered.
const execChannel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('webpc-terminal');
const execRespond = message => execChannel?.postMessage(message);
execChannel?.addEventListener('message', event => {
  const decision = handleExecChannelMessage(event.data, exec);
  if (decision.action === 'cancel') {
    // Buddy asked the run to stop (Stop, New chat, its wall timer): the guest gets SIGKILL
    // through the run's own abort signal.
    exec.cancelled = true;
    exec.controller?.abort();
    return;
  }
  if (decision.action !== 'request') return;
  handleExecRequest(event.data);
});
function handleExecRequest(data) {
  const check = validateExecRequest(data);
  if (!check.ok) { if (typeof data?.id === 'string' && data.id.length <= 200) execRespond({ type: 'exec-error', id: data.id, reason: 'invalid' }); return; }
  const gate = execGate({ owner: diskOwner, running: !!vm, inFlight: exec !== null });
  if (gate !== 'run') { execRespond({ type: 'exec-error', id: check.id, reason: gate }); return; }
  exec = { req: check, controller: null, cancelled: false };
  execRespond({ type: 'exec-pending', id: check.id });
  void runExec(check);
}
async function runExec(req) {
  const slot = exec;
  const startedAt = Date.now();
  const plan = planExec(req.id, req.lang, req.code);
  const controller = new AbortController();
  slot.controller = controller;
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  report(`Running ${req.lang} command from ${req.from}…`);
  try {
    const result = await vm.exec(plan.file, plan.args, { input: plan.input, encoding: 'utf8', signal: controller.signal });
    const reply = execReply(result);
    const durationMs = Date.now() - startedAt;
    report(`Command finished · exit ${reply.exitCode} · ${durationMs} ms${reply.truncated ? ' · output truncated' : ''}.`);
    execRespond({ type: 'exec-result', id: req.id, exitCode: reply.exitCode, output: reply.output, truncated: reply.truncated, durationMs });
  } catch (error) {
    if (controller.signal.aborted) {
      // The run's limit passed, or Buddy cancelled it: the guest got SIGKILL, and
      // vm.exec() carries no partial output.
      execRespond({ type: 'exec-error', id: req.id, reason: slot.cancelled ? 'cancelled' : 'timeout', output: '', truncated: false, durationMs: Date.now() - startedAt });
      report(slot.cancelled ? `Command from ${req.from} was cancelled.` : `Command from ${req.from} timed out and was interrupted.`, true);
    } else {
      execRespond({ type: 'exec-error', id: req.id, reason: error?.code ?? 'error', durationMs: Date.now() - startedAt });
      report(`The command did not finish: ${error?.message ?? error}`, true);
    }
  } finally {
    clearTimeout(timer);
    if (exec === slot) exec = null;
  }
}
async function action(callback) {
  if (busy) return;
  busy = true;
  controls();
  try { await callback(); } catch (error) { report(error.message || String(error), true); }
  finally { busy = false; controls(); }
}
setupApp('terminal', () => {
  const css = getComputedStyle(document.documentElement);
  term.options.theme = { background: css.getPropertyValue('--color-bg').trim(), foreground: css.getPropertyValue('--color-text').trim(), cursor: css.getPropertyValue('--color-accent').trim() };
});
// An unsupported engine gets a clear status line on load, not a broken window.
unkernel().then(({ checkSupport }) => checkSupport()).then(supportResult => {
  if (!supportResult.ok) report(`This browser cannot run the Terminal: ${supportResult.problems.join('; ')}.`, true);
}).catch(() => {});
requestAnimationFrame(() => { try { fit.fit(); } catch { /* Hidden desktop window. */ } });
controls();
