// Packets pack: drive the Packet Viewer (scripts/pc/packets/main.mjs), which runs in the
// #packets-frame inner iframe of the app page (pcHost.appWindow('packets') resolves the
// wrapper page; the vendor page sets window.webpcPackets = { ready: true }, main.mjs:132,
// which the wrapper polls, scripts/pc/apps/packets.mjs). All state is in the DOM: the
// #pk-progress status line, #pk-err / #pk-filter-err error lines, #pk-summary (set when a
// capture loads, main.mjs:47), #pk-table (tbody tr[data-num] rows, the selected row carrying
// class pk-sel, renderTable main.mjs:78), #pk-tree / #pk-hex (the selected packet's protocol
// tree and hex dump, onFrame main.mjs:70) and the #pk-filter input plus #pk-filter-apply
// button (applyFilter main.mjs:106). Captures are opened through the #pk-file input's change
// handler (main.mjs:125) with a DataTransfer FileList; the app's own drop path also reads
// dataTransfer.files[0] (main.mjs:129), and the magic bytes decide the format, not the
// extension (main.mjs:113-119).
import { ToolError } from '../../../src/apps/ai-agent/runtime/args.mjs';
import { innerApi } from '../../shared/inner-app.js';

const APP = 'packets';
const NEEDS = ['host', 'app:packets'];
const NOT_HERE = 'The Packet Viewer is not available here (WebPC Agent is not running inside WebPC).';

// Gate on ctx.host (needs: ['host', 'app:packets']), then turn host rejections, which carry a
// code (unknown_app, not_open, not_iframe, timeout, invalid_argument), and innerApi's
// not_available into a ToolError the model can act on.
const call = (ctx, fn) => {
  if (!ctx.host) throw new ToolError('not_available', NOT_HERE, '');
  return Promise.resolve()
    .then(() => fn(ctx.host))
    .catch(error => {
      if (error instanceof ToolError) throw error;
      throw new ToolError(error.code || 'app_error', error.message, '');
    });
};

// Dig into the #packets-frame inner window; webpcPackets is set once the page is up.
const app = async (host, ctx) => innerApi(await host.appWindow(APP), 'packets-frame', win => (win.webpcPackets ? win : null), { sleep: ctx.sleep, timeoutMs: ctx.timeoutMs });
const sleepOf = ctx => ctx.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));

// Feed a capture to the app's file input the way the drop path would: a DataTransfer
// FileList on #pk-file, then the change event the app listens for (main.mjs:125).
const openFileInApp = (win, bytes, name) => {
  const input = win.document.getElementById('pk-file');
  if (!input) throw new ToolError('app_error', 'the capture file input was not found in the app', '');
  const dt = new win.DataTransfer();
  dt.items.add(new win.File([bytes], name));
  input.files = dt.files;
  input.dispatchEvent(new win.Event('change'));
};

export const pack = { id: APP, title: 'Packet Viewer' };

export const tools = [
  {
    name: 'packets.open_capture',
    purpose: 'Open a pcap or pcapng capture from the Files app.',
    when: 'Use when the user has a network capture to inspect.',
    params: { path: { type: 'path', required: true, description: 'The capture file path in the Files app, e.g. /captures/web.pcapng' } },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { path: '/captures/web.pcapng' }, says: 'Open this capture' }],
    // openFile (main.mjs:114): the magic bytes decide the format. On success #pk-summary is
    // set ("N packets · type · encap · X s elapsed", main.mjs:47); on a bad file #pk-err.
    run: async (args, ctx) => call(ctx, async host => {
      const read = ctx.files?.readBytes;
      if (typeof read !== 'function') throw new ToolError('not_available', 'the Files tools are not enabled here, so no capture can be opened', '');
      const file = await read(args.path);
      const win = await app(host, ctx);
      openFileInApp(win, file.bytes, file.name);
      const sleep = sleepOf(ctx);
      for (let i = 0; i < 120; i++) { // 60 s: the engine (about 21 MB) loads on first use
        const error = win.document.getElementById('pk-err')?.textContent?.trim();
        if (error) throw new ToolError('app_error', `the capture could not be opened: ${error}`, '');
        const summary = win.document.getElementById('pk-summary')?.textContent?.trim();
        if (summary) return { summary };
        await sleep(500);
      }
      throw new ToolError('app_error', 'the capture did not finish loading within 60 s; the engine may still be starting, so wait and try again', '');
    }),
  },
  {
    name: 'packets.filter',
    purpose: 'Apply a display filter, e.g. tcp.port == 443.',
    when: 'Use when the user wants to see only certain packets.',
    // A4: protocol names are the filter's inner vocabulary (find_tool "icmp" found nothing -
    // the names live in display filters, not the tool text).
    keywords: ['tcp', 'icmp', 'udp', 'arp', 'dns', 'http', 'https', 'ssh', 'smtp', 'tls'],
    params: { expr: { type: 'string', description: 'The display filter expression; empty or omitted clears the filter' } },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { expr: 'tcp.port == 443' }, says: 'Only the TLS traffic' }],
    // applyFilter (main.mjs:106): an invalid filter fills #pk-filter-err (onTestFilter,
    // main.mjs:98); a good one ends in the "N packets match filter" status line (main.mjs:63).
    // The pre-click status is remembered so a stale line cannot be reported as this filter.
    run: async (args, ctx) => call(ctx, async host => {
      const win = await app(host, ctx);
      const filter = win.document.getElementById('pk-filter');
      const apply = win.document.getElementById('pk-filter-apply');
      if (!filter || !apply) throw new ToolError('app_error', 'the filter form was not found in the app', '');
      const before = win.document.getElementById('pk-progress')?.textContent ?? '';
      const expr = String(args.expr ?? '').trim();
      filter.value = expr;
      apply.click();
      const sleep = sleepOf(ctx);
      for (let i = 0; i < 150; i++) { // 15 s
        const error = win.document.getElementById('pk-filter-err')?.textContent?.trim();
        if (error) throw new ToolError('invalid_argument', `the filter was rejected: ${error}`, '');
        const status = win.document.getElementById('pk-progress')?.textContent ?? '';
        const match = status !== before && status.match(/^(\d+) packets match filter/);
        if (match) return { matched: Number(match[1]), filter: expr };
        await sleep(100);
      }
      throw new ToolError('app_error', 'the filter did not finish within 15 s; the capture may still be loading', '');
    }),
  },
  {
    name: 'packets.list',
    purpose: 'List the visible packet rows, up to a limit.',
    when: 'Use when the user wants to see the packets, or before picking one to inspect.',
    params: { limit: { type: 'integer', min: 1, max: 500, description: 'How many rows to return (default 50; the app renders at most 1000)' } },
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Show the packets' }],
    // The table rows are tr[data-num] with one td per column (renderTable, main.mjs:87-92);
    // the selected row carries class pk-sel.
    run: async (args, ctx) => call(ctx, async host => {
      const win = await app(host, ctx);
      const table = win.document.getElementById('pk-table');
      if (!table) throw new ToolError('app_error', 'the packet table was not found in the app (open a capture first)', '');
      const columns = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
      const limit = Math.min(Math.max(args.limit ?? 50, 1), 500);
      const rows = [...table.querySelectorAll('tbody tr[data-num]')].slice(0, limit)
        .map(tr => ({ num: Number(tr.dataset.num), cells: [...tr.querySelectorAll('td')].map(td => td.textContent.trim()) }));
      const selected = table.querySelector('tbody tr.pk-sel')?.dataset.num;
      return { columns, rows, selected: selected == null ? null : Number(selected) };
    }),
  },
  {
    name: 'packets.detail',
    purpose: 'Show one packet: its protocol tree and hex dump.',
    when: 'Use when the user wants to inspect a specific packet.',
    params: { number: { type: 'integer', required: true, min: 1, description: 'The frame number from packets.list' } },
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: { number: 5 }, says: 'Show packet 5' }],
    // Clicking the row selects it and fetches the frame (main.mjs:93); the protocol tree and
    // hex dump land in #pk-tree / #pk-hex when the frame arrives (onFrame, main.mjs:70-75).
    // If the row is already selected the data is already in those elements, so no polling.
    run: async (args, ctx) => call(ctx, async host => {
      const win = await app(host, ctx);
      const table = win.document.getElementById('pk-table');
      if (!table) throw new ToolError('app_error', 'the packet table was not found in the app (open a capture first)', '');
      const row = [...table.querySelectorAll('tbody tr[data-num]')].find(tr => Number(tr.dataset.num) === args.number);
      if (!row) throw new ToolError('invalid_argument', `frame ${args.number} is not in the current view (open the capture, adjust the filter or raise the packets.list limit)`, '');
      const before = win.document.getElementById('pk-tree')?.textContent ?? '';
      if (row.classList?.contains?.('pk-sel')) return readDetail(win, args.number);
      row.click();
      const sleep = sleepOf(ctx);
      for (let i = 0; i < 300; i++) { // 30 s
        const tree = win.document.getElementById('pk-tree')?.textContent ?? '';
        if (tree && tree !== before) return readDetail(win, args.number);
        await sleep(100);
      }
      throw new ToolError('app_error', 'the packet detail did not finish within 30 s', '');
    }),
  },
];

// #pk-tree holds the indented protocol tree, #pk-hex the hex dumps (main.mjs:73-75). The hex
// dump of a large frame can be long, so it is capped for the model.
const readDetail = (win, number) => {
  const tree = win.document.getElementById('pk-tree')?.textContent ?? '';
  let hex = win.document.getElementById('pk-hex')?.textContent ?? '';
  const hexTruncated = hex.length > 20000;
  if (hexTruncated) hex = hex.slice(0, 20000);
  return { number, tree, hex, hexTruncated };
};
