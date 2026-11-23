// Unit tests for the Packets pack: agent/apps/packets/tools.js and skills.md.
// The fake inner window mirrors the Packet Viewer surface (scripts/pc/packets/main.mjs plus
// public/pc/vendor/packets/index.html): the webpcPackets ready flag (main.mjs:132), the
// #pk-progress / #pk-err / #pk-filter-err / #pk-summary lines, the static #pk-table (thead th
// rebuilt per render, tbody tr[data-num] rows, the selected row class pk-sel, main.mjs:78-96),
// #pk-tree / #pk-hex (onFrame, main.mjs:70-75), the #pk-filter input plus #pk-filter-apply
// (applyFilter, main.mjs:106; a rejected filter fills #pk-filter-err, main.mjs:98) and the
// #pk-file change handler (main.mjs:125) where the magic bytes decide the format
// (helpers.mjs detectCaptureFormat: pcap 0xd4c3b2a1, pcapng 0x0a0d0d0a).
// Run: node --test tests/agent-pack-packets.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack, tools } from '../agent/apps/packets/tools.js';
import { tools as desktopTools } from '../agent/desktop/tools.js';
import { ToolError, specErrors, checkArgs } from '../src/apps/ai-agent/runtime/args.mjs';
import { parseSkills, checkSkills } from '../src/apps/ai-agent/runtime/skills.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_MD = readFileSync(join(HERE, '..', 'agent', 'apps', 'packets', 'skills.md'), 'utf8');
// The enabled app ids scripts/agent/build.mjs resolves the live 'apps' enum with (catalog.yaml).
const APP_IDS = ['gridcraft', 'docs', 'deckcraft', 'terminal', 'sqliteviz', 'files', 'media', 'cyberchef', 'vscode', 'nettools', 'packets', 'ai-agent', 'lightcraft', 'figcraft', 'pdfcraft', 'soundcraft', 'beepbox', 'filmcraft', 'cadcraft', 'vectorcraft', 'photocraft', 'effectcraft', 'materialcraft', 'texturecraft', 'excalidraw', 'vert'];
const choices = name => (name === 'apps' || name === 'windows' ? APP_IDS : []);
const byName = name => tools.find(tool => tool.name === name) ?? desktopTools.find(tool => tool.name === name);

const PCAP_BYTES = new Uint8Array([0xd4, 0xc3, 0xb2, 0xa1, 0x02, 0x00, 0x01, 0x00]);
const PCAPNG_BYTES = new Uint8Array([0x0a, 0x0d, 0x0d, 0x0a, 0x01, 0x00, 0x00, 0x00]);
const NOT_CAPTURE_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
const COLUMNS = ['No.', 'Time', 'Source', 'Destination', 'Protocol', 'Port', 'Length'];
// The capture the fake engine "dissects": two TLS packets, one DNS packet, one more TLS.
const PACKETS = [
  { num: 1, cells: ['1', '0.000000', '10.0.0.5', '93.184.216.34', 'TCP', '443', '66'], port: 443, ip: '10.0.0.5' },
  { num: 2, cells: ['2', '0.000182', '93.184.216.34', '10.0.0.5', 'TCP', '443', '54'], port: 443, ip: '93.184.216.34' },
  { num: 3, cells: ['3', '0.000311', '10.0.0.5', '93.184.216.34', 'HTTP', '443', '342'], port: 443, ip: '10.0.0.5' },
  { num: 4, cells: ['4', '0.100000', '10.0.0.5', '1.1.1.1', 'DNS', '53', '99'], port: 53, ip: '1.1.1.1' },
];
// The display filters the fake engine accepts; anything else is a parse error.
const FILTER_RE = /^\s*(tcp\.port == \d+|ip\.addr == [\d.]+)\s*$/;

const fakePackets = () => {
  const fileStore = {
    '/captures/web.pcap': PCAP_BYTES,
    '/captures/dns.pcapng': PCAPNG_BYTES,
    '/notes.txt': NOT_CAPTURE_BYTES,
  };
  const progress = { textContent: 'Engine not loaded yet. Choose a capture or click "Load engine".' };
  const err = { textContent: '' };
  const filterErr = { textContent: '' };
  const summary = { textContent: '' };
  const tree = { textContent: 'No packet selected.' };
  const hex = { textContent: '' };
  let filter = '';
  let selected = null;
  let engineStarted = false;
  const openedFiles = [];
  const rowClicks = [];

  const table = {
    ths: [],
    trs: [],
    querySelectorAll: sel => (sel === 'thead th' ? table.ths : sel === 'tbody tr[data-num]' ? table.trs : []),
    querySelector: sel => (sel === 'tbody tr.pk-sel' ? table.trs.find(tr => tr.classList.contains('pk-sel')) ?? null : null),
  };
  const matchesFilter = (expr, p) => {
    const port = /^tcp\.port == (\d+)$/.exec(expr);
    if (port) return p.port === Number(port[1]);
    const addr = /^ip\.addr == ([\d.]+)$/.exec(expr);
    return addr ? p.ip === addr[1] : false;
  };
  const currentRows = () => (filter ? PACKETS.filter(p => matchesFilter(filter, p)) : PACKETS);
  // onFrame (main.mjs:70-75): the protocol tree lines and the hex dumps.
  const onFrame = p => {
    tree.textContent = `Frame ${p.num}: ${p.cells[4]}\n  ${p.cells[2]} -> ${p.cells[3]} (port ${p.cells[5]})`;
    // Frame 4 has a long dump to exercise the tool's 20000-character cap.
    hex.textContent = p.num === 4 ? `frame ${p.num}\n` + 'ab'.repeat(15000) : `frame ${p.num}\n00000000  45 00 00 3c`;
  };
  // renderTable (main.mjs:78-96): thead from the columns, one tr[data-num] per row, the
  // selected row carries pk-sel, a row click selects and fetches the frame.
  const renderTable = rows => {
    table.ths = COLUMNS.map(name => ({ textContent: name }));
    table.trs = rows.map(p => {
      const tr = {
        dataset: { num: String(p.num) },
        classList: { contains: cls => cls === 'pk-sel' && selected === p.num },
        click() {
          rowClicks.push(p.num);
          if (selected !== p.num) { selected = p.num; renderTable(currentRows()); onFrame(p); }
        },
        querySelectorAll: sel => (sel === 'td' ? p.cells.map(c => ({ textContent: c })) : []),
      };
      return tr;
    });
  };
  // onFrames (main.mjs:57-66): re-render, fix the selection, and set the status line.
  const onFrames = expr => {
    filter = expr;
    const rows = currentRows();
    renderTable(rows);
    if (selected !== null && !rows.some(p => p.num === selected)) selected = rows.length ? rows[0].num : null;
    progress.textContent = `${rows.length} packets match filter "${expr || '(all)'}"`;
    if (selected === null) { tree.textContent = 'No packet selected.'; hex.textContent = ''; return; }
    onFrame(PACKETS.find(p => p.num === selected));
  };
  // openFile (main.mjs:114-123): the magic bytes decide; a bad file fills #pk-err, a good
  // one loads through the engine and ends in onLoaded + onFrames (one microtask later).
  const isPcap = b => b[0] === 0xd4 && b[1] === 0xc3 && b[2] === 0xb2 && b[3] === 0xa1;
  const isPcapng = b => b[0] === 0x0a && b[1] === 0x0d && b[2] === 0x0d && b[3] === 0x0a;
  const openFile = async file => {
    err.textContent = '';
    filterErr.textContent = '';
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = isPcap(bytes) ? 'pcap' : isPcapng(bytes) ? 'pcapng' : null;
    if (!kind) { err.textContent = `"${file.name}" is not a recognized capture (no pcap/pcapng magic found).`; return; }
    engineStarted = true;
    progress.textContent = engineStarted ? `Loading ${file.name}…` : `Starting the engine and loading ${file.name}…`;
    openedFiles.push(file.name);
    queueMicrotask(() => {
      summary.textContent = `${PACKETS.length} packets · ${kind} · ethernet encap · 0.4 s elapsed`;
      selected = null; // onLoaded resets the selection (main.mjs:49)
      onFrames('');
    });
  };
  const File = class {
    constructor(parts, name) { this.name = name; this._bytes = parts[0]; }
    arrayBuffer() { return Promise.resolve(this._bytes); }
  };
  const DataTransfer = class {
    constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; }
  };
  const Event = class { constructor(type) { this.type = type; } };
  const fileInput = {
    files: [], value: '', listeners: {},
    addEventListener(type, fn) { (fileInput.listeners[type] ??= []).push(fn); },
    dispatchEvent(event) { event.target = fileInput; (fileInput.listeners[event.type] ?? []).forEach(fn => fn(event)); return true; },
  };
  // main.mjs:125: the change handler feeds files[0] to openFile and clears the input.
  fileInput.addEventListener('change', e => { const f = e.target.files?.[0]; if (f) void openFile(f); e.target.value = ''; });
  const filterInput = { value: '' };
  const applyBtn = {
    click() {
      const f = filterInput.value.trim();
      if (!f) { filterErr.textContent = ''; onFrames(''); return; }
      if (!FILTER_RE.test(f)) { filterErr.textContent = `error while parsing "${f}"`; return; } // onTestFilter (main.mjs:98)
      filterErr.textContent = '';
      onFrames(f);
    },
  };
  const byId = {
    'pk-progress': progress, 'pk-err': err, 'pk-filter-err': filterErr, 'pk-summary': summary,
    'pk-table': table, 'pk-tree': tree, 'pk-hex': hex, 'pk-filter': filterInput,
    'pk-filter-apply': applyBtn, 'pk-file': fileInput,
  };
  const win = { webpcPackets: { ready: true }, File, DataTransfer, Event, document: { getElementById: id => byId[id] ?? null } };
  const wrapper = { document: { getElementById: id => (id === 'packets-frame' ? { contentWindow: win } : null) } };
  const files = {
    readBytes: path => {
      const bytes = fileStore[path];
      if (!bytes) { const error = new Error(`${path} is not a file.`); error.code = 'not_found'; return Promise.reject(error); }
      return Promise.resolve({ path, name: path.split('/').pop(), bytes, size: bytes.length });
    },
  };
  const runTool = (name, args, extra = {}) => byName(name).run(args, { host: { appWindow: async () => wrapper }, files, sleep: async () => {}, ...extra });
  return {
    win, files, runTool, progress, err, filterErr, summary, tree, hex, table,
    openedFiles, rowClicks, get selected() { return selected; }, get filter() { return filter; },
  };
};

test('the pack declares its id and title', () => {
  assert.deepEqual(pack, { id: 'packets', title: 'Packet Viewer' });
});

test('the pack exposes exactly the 4 packets tools', () => {
  assert.equal(tools.length, 4);
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'packets.detail', 'packets.filter', 'packets.list', 'packets.open_capture',
  ]);
});

test('every tool has the required text fields, effect, needs and examples', () => {
  for (const tool of tools) {
    assert.match(tool.name, /^packets\.[a-z0-9_]+$/);
    assert.ok(tool.purpose.length > 0 && tool.purpose.length <= 80, `${tool.name} purpose is ${tool.purpose.length} chars`);
    assert.ok(tool.when.startsWith('Use when'), `${tool.name} when must start with "Use when"`);
    assert.ok(tool.when.length <= 120, `${tool.name} when is ${tool.when.length} chars`);
    assert.ok(['read', 'change', 'destructive', 'external'].includes(tool.effect), `${tool.name} bad effect`);
    assert.deepEqual(tool.needs, ['host', 'app:packets']);
    assert.equal(typeof tool.run, 'function');
    assert.ok(tool.examples.length >= 1, `${tool.name} has examples`);
    for (const example of tool.examples) {
      assert.ok(example.args && typeof example.args === 'object' && !Array.isArray(example.args));
      assert.equal(typeof example.says, 'string');
    }
  }
});

test('every parameter spec passes the runtime specErrors check', () => {
  for (const tool of tools) assert.deepEqual(specErrors(tool.params), [], `${tool.name} params`);
});

test('every example passes the runtime checkArgs the way the build runs it', () => {
  for (const tool of tools) {
    for (const [n, example] of tool.examples.entries()) {
      const out = checkArgs(tool, example.args, { choices });
      assert.ok(out.ok, `${tool.name} example ${n}: ${out.error?.message}`);
    }
  }
});

test('packets.open_capture opens a pcap and returns the app summary line', async () => {
  const pk = fakePackets();
  const got = await pk.runTool('packets.open_capture', { path: '/captures/web.pcap' });
  assert.deepEqual(got, { summary: '4 packets · pcap · ethernet encap · 0.4 s elapsed' });
  assert.deepEqual(pk.openedFiles, ['web.pcap'], 'the file input change was dispatched with the capture');
  assert.equal(pk.progress.textContent, '4 packets match filter "(all)"');
});

test('packets.open_capture accepts a pcapng capture', async () => {
  const pk = fakePackets();
  const got = await pk.runTool('packets.open_capture', { path: '/captures/dns.pcapng' });
  assert.match(got.summary, /pcapng/);
});

test('packets.open_capture rejects a non-capture with the app error', async () => {
  const pk = fakePackets();
  await assert.rejects(pk.runTool('packets.open_capture', { path: '/notes.txt' }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'app_error');
    assert.match(error.message, /not a recognized capture/);
    return true;
  });
  assert.equal(pk.openedFiles.length, 0, 'nothing was fed to the engine');
});

test('packets.open_capture passes the Files error code through for a missing file', async () => {
  const pk = fakePackets();
  await assert.rejects(pk.runTool('packets.open_capture', { path: '/nope.pcap' }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_found');
    return true;
  });
});

test('packets.open_capture rejects with not_available when the Files tools are off', async () => {
  await assert.rejects(byName('packets.open_capture').run({ path: '/captures/web.pcap' }, { host: { appWindow: async () => null }, sleep: async () => {} }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    assert.match(error.message, /Files tools/);
    return true;
  });
});

test('packets.filter applies a valid filter and reports the match count', async () => {
  const pk = fakePackets();
  await pk.runTool('packets.open_capture', { path: '/captures/web.pcap' });
  const got = await pk.runTool('packets.filter', { expr: ' tcp.port == 443 ' });
  assert.deepEqual(got, { matched: 3, filter: 'tcp.port == 443' });
  assert.equal(pk.filter, 'tcp.port == 443', 'the app remembered the filter (main.mjs:109)');
  assert.equal(pk.table.trs.length, 3, 'the table now lists only the matching rows');
});

test('packets.filter rejects a filter the engine cannot parse', async () => {
  const pk = fakePackets();
  await pk.runTool('packets.open_capture', { path: '/captures/web.pcap' });
  await assert.rejects(pk.runTool('packets.filter', { expr: 'udp port 999' }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'invalid_argument');
    assert.match(error.message, /the filter was rejected: error while parsing "udp port 999"/);
    return true;
  });
});

test('packets.filter clears the filter when expr is empty', async () => {
  const pk = fakePackets();
  await pk.runTool('packets.open_capture', { path: '/captures/web.pcap' });
  await pk.runTool('packets.filter', { expr: 'tcp.port == 443' });
  const got = await pk.runTool('packets.filter', { expr: '' });
  assert.deepEqual(got, { matched: 4, filter: '' });
  assert.equal(pk.table.trs.length, 4);
});

test('packets.filter does not report a stale status line as the new result', async () => {
  const pk = fakePackets();
  // The status already holds the exact line clearing the filter would set: only a change
  // counts, so the tool times out instead of a false positive (same guard as terminal save).
  pk.progress.textContent = '4 packets match filter "(all)"';
  await assert.rejects(pk.runTool('packets.filter', { expr: '' }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'app_error');
    assert.match(error.message, /did not finish within 15 s/);
    return true;
  });
});

test('packets.list returns the columns, the rows and the selected frame', async () => {
  const pk = fakePackets();
  await pk.runTool('packets.open_capture', { path: '/captures/web.pcap' });
  const got = await pk.runTool('packets.list', {});
  assert.deepEqual(got.columns, COLUMNS);
  assert.equal(got.rows.length, 4);
  assert.deepEqual(got.rows[0], { num: 1, cells: ['1', '0.000000', '10.0.0.5', '93.184.216.34', 'TCP', '443', '66'] });
  assert.equal(got.selected, null, 'onLoaded resets the selection (main.mjs:49)');
});

test('packets.list caps the rows at the limit and rejects a bad limit', async () => {
  const pk = fakePackets();
  await pk.runTool('packets.open_capture', { path: '/captures/web.pcap' });
  const got = await pk.runTool('packets.list', { limit: 2 });
  assert.equal(got.rows.length, 2);
  assert.equal(checkArgs(byName('packets.list'), { limit: 0 }, { choices }).ok, false, 'limit is at least 1');
  assert.equal(checkArgs(byName('packets.list'), { limit: 501 }, { choices }).ok, false, 'limit is at most 500');
});

test('packets.list returns empty columns and rows before a capture is open', async () => {
  const pk = fakePackets();
  const got = await pk.runTool('packets.list', {});
  assert.deepEqual(got, { columns: [], rows: [], selected: null });
});

test('packets.detail selects the row and returns the tree and the hex dump', async () => {
  const pk = fakePackets();
  await pk.runTool('packets.open_capture', { path: '/captures/web.pcap' });
  const got = await pk.runTool('packets.detail', { number: 2 });
  assert.equal(got.number, 2);
  assert.match(got.tree, /^Frame 2: TCP/);
  assert.match(got.hex, /^frame 2/);
  assert.equal(got.hexTruncated, false);
  assert.equal(pk.selected, 2, 'the row click selected the frame (main.mjs:93)');
  assert.deepEqual(pk.rowClicks, [2]);
  assert.equal((await pk.runTool('packets.list', {})).selected, 2, 'the selected row now carries pk-sel');
});

test('packets.detail returns immediately when the frame is already selected', async () => {
  const pk = fakePackets();
  await pk.runTool('packets.open_capture', { path: '/captures/web.pcap' });
  await pk.runTool('packets.detail', { number: 2 });
  const again = await pk.runTool('packets.detail', { number: 2 });
  assert.match(again.tree, /^Frame 2: TCP/);
  assert.deepEqual(pk.rowClicks, [2], 'the already-selected row is not clicked again');
});

test('packets.detail truncates a long hex dump and flags it', async () => {
  const pk = fakePackets();
  await pk.runTool('packets.open_capture', { path: '/captures/web.pcap' });
  const got = await pk.runTool('packets.detail', { number: 4 });
  assert.equal(got.hexTruncated, true);
  assert.equal(got.hex.length, 20000, 'the dump is capped for the model');
});

test('packets.detail rejects a frame number that is not in the current view', async () => {
  const pk = fakePackets();
  await pk.runTool('packets.open_capture', { path: '/captures/web.pcap' });
  await pk.runTool('packets.filter', { expr: 'tcp.port == 443' });
  await assert.rejects(pk.runTool('packets.detail', { number: 4 }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'invalid_argument');
    assert.match(error.message, /not in the current view/);
    return true;
  });
});

test('a tool rejects with not_available when ctx.host is absent', async () => {
  await assert.rejects(byName('packets.list').run({}, { host: null }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    return true;
  });
});

test('a tool rejects with not_available when the app never becomes ready', async () => {
  const bare = { document: { getElementById: () => ({ contentWindow: { document: {} } }) } };
  await assert.rejects(byName('packets.list').run({}, { host: { appWindow: async () => bare }, sleep: async () => {}, timeoutMs: 300 }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    assert.match(error.message, /did not finish loading/);
    return true;
  });
  await assert.rejects(byName('packets.list').run({}, { host: { appWindow: async () => ({}) }, sleep: async () => {}, timeoutMs: 300 }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    assert.match(error.message, /no packets-frame frame/);
    return true;
  });
});

test('a host rejection code is passed through as the ToolError type', async () => {
  const boom = () => { const error = new Error('window "packets" is not open'); error.code = 'not_open'; throw error; };
  await assert.rejects(byName('packets.open_capture').run({ path: '/captures/web.pcap' }, { host: { appWindow: boom }, files: { readBytes: () => Promise.resolve({}) } }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_open');
    return true;
  });
});

const { skills, errors: skillErrors } = parseSkills(SKILLS_MD, 'packets');

test('skills.md parses with the runtime parser without errors and has 5 skills', () => {
  assert.deepEqual(skillErrors, []);
  assert.equal(skills.length, 5);
  for (const skill of skills) {
    assert.ok(skill.slug && skill.summary, `skill ${skill.slug} slug/summary`);
    assert.ok(skill.summary.length <= 160, `skill ${skill.slug} summary is ${skill.summary.length} chars`);
    assert.ok(skill.keywords.length >= 5, `skill ${skill.slug} keywords: ${skill.keywords.join(', ')}`);
    assert.ok(skill.tools.length >= 1, `skill ${skill.slug} tools`);
    assert.ok(skill.when && skill.steps.length >= 1 && skill.check, `skill ${skill.slug} body sections`);
  }
});

test('every skill opens by launching the packets app, then uses numbered packets steps', () => {
  for (const skill of skills) {
    assert.equal(skill.steps[0].line, '1. call_tool tool=desktop.open_app app=packets', `skill ${skill.slug}`);
    skill.steps.forEach((step, i) => {
      assert.equal(step.n, i + 1, `skill ${skill.slug} step numbering`);
      assert.ok(step.tool.startsWith('desktop.') || step.tool.startsWith('packets.'), `skill ${skill.slug} step ${step.n}: ${step.line}`);
    });
  }
});

test('skill steps and tools lines validate against the runtime checkArgs', () => {
  const errors = checkSkills(skills, byName, { checkArgs: (tool, args) => checkArgs(tool, args, { choices }) });
  assert.deepEqual(errors, []);
});
