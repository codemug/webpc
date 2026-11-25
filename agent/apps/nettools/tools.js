// Nettools pack: drive the Network and Security Tools app (scripts/pc/nettools/*.mjs), which
// runs in the #nettools-frame inner iframe of the app page (pcHost.appWindow('nettools')
// resolves the wrapper page; the vendor page sets window.webpcNettools = { ready: true } once
// the tab shell is mounted, main.mjs:29, which the wrapper polls, scripts/pc/apps/nettools.mjs).
// Tabs lazy-load on first click (ui.mjs mountTabs:60-77): the tab button is a
// nav.nt-tabs button.nt-tab with dataset.id, the active panel is the .nt-content that is not
// hidden, and before its module mounts the panel holds the "Loading <label>" placeholder.
// Every tool is a .nt-card with an h3 title, a .nt-input, a .nt-btn and a .nt-out / .nt-err pair;
// the button is the only trigger (ui.mjs queryCard:28-39): on click it validates the value,
// shows "Querying <service>" in .nt-out, then fills .nt-out with the answer or un-hides .nt-err.
// The DNS tab adds two select.nt-select pickers (provider, then type; dns.mjs:33-34) and the
// security tab uses the ids #nt-password / #nt-password-check / #nt-password-out and
// #nt-age-{encrypt,decrypt}-{file,pass,btn,out} (security.mjs:31-33, 61-64).
import { ToolError } from '../../../src/apps/ai-agent/runtime/args.mjs';
import { innerApi } from '../../shared/inner-app.js';

const APP = 'nettools';
const NEEDS = ['host', 'app:nettools'];
const NOT_HERE = 'Network Tools is not available here (WebPC Agent is not running inside WebPC).';

// Gate on ctx.host (needs: ['host', 'app:nettools']), then turn host rejections, which carry a
// code (unknown_app, not_open, not_iframe, timeout), innerApi's not_available and Files
// readBytes rejections (not_found, not_a_file, too_large) into a ToolError.
const call = (ctx, fn) => {
  if (!ctx.host) throw new ToolError('not_available', NOT_HERE, '');
  return Promise.resolve()
    .then(() => fn(ctx.host))
    .catch(error => {
      if (error instanceof ToolError) throw error;
      throw new ToolError(error.code || 'app_error', error.message, '');
    });
};

// Dig into the #nettools-frame inner window; webpcNettools is set once the tab shell is up.
const app = async (host, ctx) => innerApi(await host.appWindow(APP), 'nettools-frame', win => (win.webpcNettools ? win : null), { sleep: ctx.sleep, timeoutMs: ctx.timeoutMs });
const sleepOf = ctx => ctx.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));

// Click the tab button, then wait for the panel to mount: the active panel is the .nt-content
// that is not hidden, and before its module mounts it holds the "Loading <label>" placeholder
// (ui.mjs:68); a failed load marks the panel with dataset.failed (ui.mjs:74).
const activateTab = async (win, tabId, ctx) => {
  const bar = win.document.querySelector('nav.nt-tabs');
  const btn = [...(bar?.querySelectorAll('button.nt-tab') ?? [])].find(b => b.dataset?.id === tabId);
  if (!btn) throw new ToolError('app_error', `the ${tabId} tab was not found in the app`, '');
  btn.click();
  const sleep = sleepOf(ctx);
  for (let i = 0; i < 100; i++) { // 10 s
    const active = [...win.document.querySelectorAll('section .nt-content')].find(p => p.hidden === false);
    if (active?.dataset?.failed) throw new ToolError('app_error', `the ${tabId} tab failed to load: ${(active.textContent ?? '').trim()}`, '');
    if (active && !/Loading /.test(active.textContent ?? '')) return active;
    await sleep(100);
  }
  throw new ToolError('app_error', `the ${tabId} tab did not finish loading within 10 s; wait a moment and try again`, '');
};

// The card in a mounted panel whose h3 starts with the given title prefix.
const cardByTitle = (panel, prefix) => {
  const card = [...panel.querySelectorAll('.nt-card')].find(c => (c.querySelector('h3')?.textContent ?? '').startsWith(prefix));
  if (!card) throw new ToolError('app_error', `no card titled "${prefix}" is mounted in the app`, '');
  return card;
};

// Poll a card's .nt-out / .nt-err after the button click (queryCard, ui.mjs:28-39). An un-hidden
// .nt-err means the app rejected the input (when it appeared before the "Querying" pending line)
// or the request failed (after it). The answer is a non-empty .nt-out that is not the pending
// line; the DNS header line can land before the record lines (dns.mjs:24-26), so the text is
// only returned once it has stopped changing - the same non-pending text on five consecutive
// 100 ms polls (about 500 ms, within the 30 s cap).
const awaitResult = async (out, err, pendingRe, ctx) => {
  const sleep = sleepOf(ctx);
  let sawPending = false;
  let lastText = null;
  let stable = 0;
  for (let i = 0; i < 300; i++) { // 30 s: DoH and RDAP are external services
    if (!err.hasAttribute('hidden')) {
      const message = (err.textContent ?? '').trim();
      throw new ToolError(sawPending ? 'app_error' : 'invalid_argument', `the app rejected the request: ${message}`, '');
    }
    const text = (out.textContent ?? '').trim();
    if (pendingRe.test(text) || !text) {
      if (pendingRe.test(text)) sawPending = true;
      lastText = null;
      stable = 0;
      await sleep(100);
      continue;
    }
    if (text === lastText) {
      stable += 1;
      if (stable >= 5) return text;
    } else {
      lastText = text;
      stable = 1;
    }
    await sleep(100);
  }
  throw new ToolError('app_error', 'the lookup did not finish within 30 s; the service may be slow or unreachable, so wait and try again', '');
};

// Feed the Files bytes to the app's age file input the way a picker would (a DataTransfer
// FileList); security.mjs:72 reads file.files[0] and its arrayBuffer.
const feedFile = (win, inputId, file) => {
  const input = win.document.getElementById(inputId);
  if (!input) throw new ToolError('app_error', 'the age file input was not found in the app', '');
  const dt = new win.DataTransfer();
  dt.items.add(new win.File([file.bytes], file.name));
  input.files = dt.files;
};

export const pack = { id: APP, title: 'Network Tools' };

export const tools = [
  {
    name: 'nettools.dns_lookup',
    purpose: 'Look up a DNS record over HTTPS (A, AAAA, MX, TXT, NS, PTR, ...).',
    when: 'Use when the user wants to resolve a domain or check a DNS record.',
    params: {
      name: { type: 'string', required: true, description: 'The domain to look up, or an IP address for PTR' },
      type: { type: 'enum', values: ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'CAA', 'PTR'], default: 'A', description: 'The record type (the app builds the reverse name for PTR)' },
    },
    effect: 'external',
    needs: NEEDS,
    examples: [{ args: { name: 'example.com', type: 'A' }, says: 'What is the A record for example.com?' }],
    // The DNS card (dns.mjs:29-60): the two selects are the provider then the type, the input is
    // .nt-input and the button is .nt-btn; the answer is written to the pre.nt-out of the card.
    // The provider header line can be visible before the record lines, so awaitResult returns
    // only once the output text has stopped changing (five stable 100 ms polls).
    run: async (args, ctx) => call(ctx, async host => {
      const win = await app(host, ctx);
      const panel = await activateTab(win, 'dns', ctx);
      const card = cardByTitle(panel, 'DNS over HTTPS');
      const selects = card.querySelectorAll('select.nt-select');
      if (selects.length < 2) throw new ToolError('app_error', 'the DNS form was not found in the app', '');
      selects[1].value = args.type;
      card.querySelector('.nt-input').value = args.name;
      card.querySelector('.nt-btn').click();
      return { result: await awaitResult(card.querySelector('.nt-out'), card.querySelector('.nt-err'), /^Querying /, ctx) };
    }),
  },
  {
    name: 'nettools.rdap',
    purpose: 'Fetch the RDAP record for a domain or IP (registry data).',
    when: 'Use when the user wants registration data: nameservers, dates, status.',
    params: { query: { type: 'string', required: true, description: 'A domain name or an IP address' } },
    effect: 'external',
    needs: NEEDS,
    examples: [{ args: { query: 'example.com' }, says: 'Who registered example.com?' }],
    // The RDAP card is built by queryCard (domain.mjs:91-101), so the generic card surface:
    // .nt-input, .nt-btn, .nt-out, .nt-err; rdap.org redirects to the responsible registry.
    run: async (args, ctx) => call(ctx, async host => {
      const win = await app(host, ctx);
      const panel = await activateTab(win, 'domain', ctx);
      const card = cardByTitle(panel, 'Domain or IP record');
      card.querySelector('.nt-input').value = args.query;
      card.querySelector('.nt-btn').click();
      return { result: await awaitResult(card.querySelector('.nt-out'), card.querySelector('.nt-err'), /^Querying /, ctx) };
    }),
  },
  {
    name: 'nettools.subnet',
    purpose: 'Compute subnet details (network, mask, range, count) locally.',
    when: 'Use when the user asks about a CIDR block or IP range.',
    params: { cidr: { type: 'string', required: true, description: 'The CIDR block, e.g. 10.0.0.0/24 or 2001:db8::/64' } },
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: { cidr: '10.0.0.0/24' }, says: 'What are the hosts in 10.0.0.0/24?' }],
    // The subnet card (subnet.mjs:57-85) is fully local and synchronous: the click writes the
    // result straight to .nt-out, or the error to .nt-err, with no "Querying" pending line.
    run: async (args, ctx) => call(ctx, async host => {
      const win = await app(host, ctx);
      const panel = await activateTab(win, 'subnet', ctx);
      const card = cardByTitle(panel, 'Subnet calculator');
      card.querySelector('.nt-input').value = args.cidr;
      card.querySelector('.nt-btn').click();
      return { result: await awaitResult(card.querySelector('.nt-out'), card.querySelector('.nt-err'), /^Querying /, ctx) };
    }),
  },
  {
    name: 'nettools.password_strength',
    purpose: 'Check a password strength score, fully local.',
    when: 'Use when the user wants a password checked or rated.',
    params: { text: { type: 'string', required: true, description: 'The password to check (it is evaluated in the app and not stored or sent)' } },
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: { text: 'sunny-meadow-42' }, says: 'How strong is this password?' }],
    // The password card (security.mjs:27-54) is fully local and synchronous: zxcvbn-ts scores the
    // value on click and the result lands in #nt-password-out (or the error in .nt-err).
    run: async (args, ctx) => call(ctx, async host => {
      const win = await app(host, ctx);
      const panel = await activateTab(win, 'security', ctx);
      const card = cardByTitle(panel, 'Password strength');
      card.querySelector('.nt-input').value = args.text;
      card.querySelector('.nt-btn').click();
      return { result: await awaitResult(card.querySelector('.nt-out'), card.querySelector('.nt-err'), /^Querying /, ctx) };
    }),
  },
];

// The age cards (security.mjs:56-99): a file input, a passphrase input and a button; the app
// processes the file fully locally and the result is a browser download ("<name>.age" for
// encrypt, the original name for decrypt). Both tools share the same flow, differing only in
// the element id prefix and the pending line.
const ageTool = mode => ({
  name: `nettools.age_${mode}`,
  purpose: mode === 'encrypt'
    ? 'Encrypt a file from the Files app with age; the result downloads.'
    : 'Decrypt an age file from the Files app; the result downloads.',
  when: mode === 'encrypt'
    ? 'Use when the user wants a file encrypted with an age passphrase.'
    : 'Use when the user wants an age file decrypted with a passphrase.',
  params: {
    path: { type: 'path', required: true, description: 'The file path in the Files app' },
    passphrase: { type: 'text', required: true, description: 'The age passphrase (kept only in the app window)' },
  },
  effect: 'change',
  needs: NEEDS,
  examples: [{ args: { path: '/docs/report.pdf', passphrase: 's3cret-passphrase' }, says: mode === 'encrypt' ? 'Encrypt this file with age' : 'Decrypt this age file' }],
  run: async (args, ctx) => call(ctx, async host => {
    const read = ctx.files?.readBytes;
    if (typeof read !== 'function') throw new ToolError('not_available', 'the Files tools are not enabled here, so no file can be processed', '');
    const file = await read(args.path);
    const win = await app(host, ctx);
    const panel = await activateTab(win, 'security', ctx);
    const card = cardByTitle(panel, mode === 'encrypt' ? 'Encrypt a file with age' : 'Decrypt an age file');
    feedFile(win, mode === 'encrypt' ? 'nt-age-encrypt-file' : 'nt-age-decrypt-file', file);
    win.document.getElementById(mode === 'encrypt' ? 'nt-age-encrypt-pass' : 'nt-age-decrypt-pass').value = args.passphrase;
    card.querySelector('.nt-btn').click();
    const pending = mode === 'encrypt' ? /^Encrypting / : /^Decrypting /;
    return { result: await awaitResult(card.querySelector('.nt-out'), card.querySelector('.nt-err'), pending, ctx) };
  }),
});
tools.push(ageTool('encrypt'), ageTool('decrypt'));
