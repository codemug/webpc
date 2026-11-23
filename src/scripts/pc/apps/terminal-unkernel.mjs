// The Terminal app on unkernel: a real 64-bit Alpine Linux guest in a module Web
// Worker (it never blocks the page), a shell on a pty drawn by the existing
// xterm.js, and files on the persistent data disk (IndexedDB in the worker, seeded
// from the pre-baked template that carries Python and Node). The kernel, the distro
// image and the template are served from /pc/vendor/unkernel/ by prepare-terminal.mjs.
// Buddy's exec bridge stays in terminal.mjs and answers over vm.exec() from M3 on.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { setupApp } from './common.mjs';

const $ = selector => document.querySelector(selector);
const base = new URL('/pc/vendor/unkernel/', location.href).href;
// The SDK is a vendored static file, so it is loaded at run time, as linux.worker.js loads libv86
// (a static import of a public/ path fails the build: Rollup cannot resolve it).
let sdk = null;
const unkernel = () => (sdk ??= import(/* @vite-ignore */ `${base}web.mjs`));
const term = new Terminal({ cursorBlink: true, fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim(), fontSize: 13, scrollback: 1200 });
const fit = new FitAddon();
term.loadAddon(fit);
term.open($('#terminal'));
let vm = null, pty = null, meta = null, template = null, distroUrl = null, support = null, busy = false, closing = false;
const report = (text, error = false) => { $('#terminal-status').textContent = text; $('#terminal-status').dataset.error = String(error); };
function controls() {
  $('#linux-start').disabled = busy || !!vm;
  $('#linux-restart').disabled = busy || !vm;
  $('#linux-fit').disabled = busy || !vm;
  document.querySelectorAll('[data-linux-key]').forEach(button => { button.disabled = busy || !vm; });
}
async function manifest() {
  if (!meta) {
    const response = await fetch(`${base}release.json`);
    if (!response.ok) throw new Error('Linux is temporarily unavailable. Reload the page or try again later.');
    meta = await response.json();
  }
  return meta;
}
async function boot() {
  const { checkSupport, createKernel } = await unkernel();
  if (!support) {
    support = await checkSupport();
    if (!support.ok) throw new Error(`This browser cannot run the Terminal: ${support.problems.join('; ')}.`);
  }
  const m = await manifest();
  if (!template) {
    const response = await fetch(`${base}data-template.kwsparse.gz`);
    if (!response.ok) throw new Error('The Linux image is temporarily unavailable. Reload the page or try again later.');
    template = new Uint8Array(await response.arrayBuffer());
  }
  if (!distroUrl) {
    // Fetch the 4 MB image whole and hand the worker a blob: URL it reads by range. GitHub Pages
    // gzips byte-range responses for binary files (the range then applies to the compressed bytes),
    // which corrupts the SDK's lazy Range reads; a plain fetch is decompressed by the browser.
    const response = await fetch(`${base}${m.distro?.file ?? 'alpine.erofs'}`);
    if (!response.ok) throw new Error('The Linux image is temporarily unavailable. Reload the page or try again later.');
    distroUrl = URL.createObjectURL(new Blob([await response.arrayBuffer()]));
  }
  report('Booting Alpine Linux…');
  try {
    // Worker mode takes disk specs (plain structured-cloneable data). The data disk
    // store lives in IndexedDB in the worker and is seeded from the template; no net
    // option means the guest has no eth0, offline as today.
    vm = await createKernel({ distro: distroUrl, disks: [{ kind: 'data', template, name: m.disk?.name ?? 'webpc-terminal', version: m.disk?.version ?? 'v1' }], memoryMiB: m.memoryMiB ?? 512, worker: true });
  } catch (error) {
    vm = null;
    throw error;
  }
  const consoleDecoder = new TextDecoder();
  vm.onOutput(bytes => term.write(consoleDecoder.decode(bytes, { stream: true })));
  vm.exited.then(result => {
    if (closing || !vm) return;
    vm = null;
    pty = null;
    report(`Linux stopped (${result?.reason || result?.kind || 'unknown'}). Start Linux to begin again.`, true);
    controls();
  }).catch(() => {});
  await attachShell();
  report('Linux is running · offline · files are kept in this browser.');
  controls();
}
async function attachShell() {
  const shell = await vm.spawn('/bin/sh', [], { cols: term.cols, rows: term.rows });
  if (closing || !vm) { shell.close().catch(() => {}); return; }
  pty = shell;
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
    }
  })().catch(() => {});
}
term.onData(data => { if (pty && !busy) pty.write(data).catch(() => {}); });
for (const button of document.querySelectorAll('[data-linux-key]')) button.onclick = () => {
  const key = { interrupt: '\x03', tab: '\t', escape: '\x1b' }[button.dataset.linuxKey];
  if (pty && !busy) pty.write(key).catch(() => {});
  term.focus();
};
$('#linux-start').onclick = () => action(boot);
$('#linux-restart').onclick = () => action(async () => {
  if (!confirm('Restart Linux? Your files are kept; running processes end.')) return;
  closing = true;
  try {
    await shutdown();
    term.reset();
    await boot();
  } finally {
    closing = false;
  }
});
async function shutdown() {
  try { await pty?.close(); } catch { /* The session is already gone. */ }
  try { await vm?.stop(); } catch { /* The kernel is already gone. */ }
  vm = null;
  pty = null;
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
