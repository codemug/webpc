// Unit tests for the Nettools pack: agent/apps/nettools/tools.js and skills.md.
// The fake inner window mirrors the Network and Security Tools surface
// (scripts/pc/nettools/*.mjs): the webpcNettools ready flag (main.mjs:29), the tab shell
// (ui.mjs mountTabs: buttons nav.nt-tabs button.nt-tab with dataset.id, one .nt-content panel
// per tab, the active panel not hidden, "Loading <label>" before the module mounts, main.mjs:85
// auto-mounts the first tab), the queryCard card surface (ui.mjs:16-44: h3, .nt-input, .nt-btn,
// .nt-out, .nt-err hidden by default, "Querying <service>" pending line), the DNS selects
// (dns.mjs:33-34), the subnet card's local maths (subnet.mjs:67-81), the validators' error
// strings (net.mjs validateDomain / validateIPv4) and the security tab ids plus its fully
// local age flow (security.mjs:27-99). The dash characters of the real h3 titles are left out
// of the fakes; the pack only prefix-matches the titles.
// Run: node --test tests/agent-pack-nettools.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack, tools } from '../agent/apps/nettools/tools.js';
import { tools as desktopTools } from '../agent/desktop/tools.js';
import { ToolError, specErrors, checkArgs } from '../src/apps/ai-agent/runtime/args.mjs';
import { parseSkills, checkSkills } from '../src/apps/ai-agent/runtime/skills.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_MD = readFileSync(join(HERE, '..', 'agent', 'apps', 'nettools', 'skills.md'), 'utf8');
// The enabled app ids scripts/agent/build.mjs resolves the live 'apps' enum with (catalog.yaml).
const APP_IDS = ['gridcraft', 'docs', 'deckcraft', 'terminal', 'sqliteviz', 'files', 'media', 'cyberchef', 'vscode', 'nettools', 'packets', 'ai-agent', 'lightcraft', 'figcraft', 'pdfcraft', 'soundcraft', 'beepbox', 'filmcraft', 'cadcraft', 'vectorcraft', 'photocraft', 'effectcraft', 'materialcraft', 'texturecraft', 'excalidraw', 'vert'];
const choices = name => (name === 'apps' || name === 'windows' ? APP_IDS : []);
const byName = name => tools.find(tool => tool.name === name) ?? desktopTools.find(tool => tool.name === name);

// The app validators (net.mjs:11-36), reduced to the branches the tests exercise.
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const domainError = s => {
  const t = String(s ?? '').trim().toLowerCase();
  if (!t || /\s/.test(t)) return 'Enter a valid domain or hostname (no spaces, 253 chars max).';
  const labels = t.split('.');
  if (labels.length < 2) return 'Enter a full domain, e.g. example.com.';
  for (const l of labels) if (!LABEL_RE.test(l)) return `Invalid label "${l}".`;
  return null;
};
const IPV4_RE = /^((25[0-5]|2[0-4]\d|1\d\d|\d\d|\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|\d\d|\d)$/;
const TABS = [
  { id: 'subnet', label: 'Subnet' }, { id: 'dns', label: 'DNS' }, { id: 'domain', label: 'Domain & IP' },
  { id: 'global', label: 'Global Ping' }, { id: 'latency', label: 'Latency' }, { id: 'security', label: 'Security' },
];
const AGE_PASS = 'right-pass';

const fakeNettools = () => {
  const state = { downloads: [], dnsHeaderFirst: false };
  const fileStore = {
    '/docs/report.pdf': { bytes: new Uint8Array([10, 20, 30]), name: 'report.pdf' },
    '/docs/report.pdf.age': { bytes: new Uint8Array([1, 0, 42]), name: 'report.pdf.age' },
  };
  const ageFiles = { 'report.pdf.age': { passphrase: AGE_PASS, plaintext: new Uint8Array([1, 2, 3]) } };

  const makeCard = title => {
    const card = { h3: { textContent: title }, input: { value: '' }, btn: { disabled: false, click: () => {} }, selects: [], out: { textContent: '' }, err: { textContent: '', _hidden: true } };
    card.err.hasAttribute = () => card.err._hidden;
    card.err.setAttribute = () => { card.err._hidden = true; };
    card.err.removeAttribute = () => { card.err._hidden = false; };
    card.querySelector = sel => ({ h3: card.h3, '.nt-input': card.input, '.nt-btn': card.btn, '.nt-out': card.out, '.nt-err': card.err }[sel] ?? null);
    card.querySelectorAll = sel => (sel === 'select.nt-select' ? card.selects : []);
    return card;
  };
  const showErr = (card, msg) => { card.out.textContent = ''; card.err.textContent = msg; card.err.removeAttribute('hidden'); };

  // Subnet tab (subnet.mjs:57-85): fully local and synchronous.
  const subnetModule = () => {
    const c = makeCard('Subnet calculator - fully local (no request sent)');
    c.btn.click = () => {
      const raw = c.input.value.trim();
      const slash = raw.lastIndexOf('/');
      if (slash < 0) { showErr(c, 'Use the form <address>/<prefix>, e.g. 10.0.0.0/24.'); return; }
      const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(raw.slice(0, slash));
      const prefix = Number(raw.slice(slash + 1));
      if (!m || m.slice(1).some(o => Number(o) > 255) || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
        showErr(c, prefix > 32 && Number.isInteger(prefix) ? 'IPv4 prefix is 0-32.' : 'The address part is not a valid IPv4 or IPv6 address.');
        return;
      }
      const value = BigInt(m[1]) << 24n | BigInt(m[2]) << 16n | BigInt(m[3]) << 8n | BigInt(m[4]);
      const mask = (0xffffffffn << BigInt(32 - prefix)) & 0xffffffffn;
      const net = value & mask;
      const str = v => [24n, 16n, 8n, 0n].map(s => Number((v >> s) & 0xffn)).join('.');
      c.err.setAttribute('hidden', 'true');
      c.out.textContent = `IPv4 · /${prefix}\nNetwork:  ${str(net)}\nMask:     ${str(mask)}\nBroadcast: ${str(net | ~mask & 0xffffffffn)}\nFirst host:  ${str(net + 1n)}\nLast host:   ${str(net | ~mask & 0xffffffffn - 1n)}\nAddresses: ${String(1n << BigInt(32 - prefix))}`;
    };
    return [c];
  };

  // DNS tab (dns.mjs:29-60): two selects (provider, type), then the input and the button.
  const dnsModule = () => {
    const c = makeCard('DNS over HTTPS');
    c.selects = [{ value: 'cloudflare' }, { value: 'A' }];
    c.btn.click = () => {
      const t = c.selects[1].value;
      const v = c.input.value.trim();
      const service = c.selects[0].value === 'google' ? 'Google DNS-over-HTTPS' : 'Cloudflare DNS-over-HTTPS';
      if (t === 'PTR') { if (!IPV4_RE.test(v)) { showErr(c, 'PTR needs a valid IP address.'); return; } }
      else { const bad = domainError(v); if (bad) { showErr(c, bad); return; } }
      c.btn.disabled = true; c.err.setAttribute('hidden', 'true');
      c.out.textContent = `Querying ${service}…`;
      queueMicrotask(() => {
        c.btn.disabled = false;
        if (v === 'offline.example') { showErr(c, `${service}: request failed (network error).`); return; }
        const qname = t === 'PTR' ? `${v.split('.').reverse().join('.')}.in-addr.arpa` : v;
        if (v === 'nx.example') { c.out.textContent = `${service} → NXDOMAIN (no ${t} records for ${qname}).`; return; }
        // The provider header line can be visible before the record lines (live behavior seen
        // in the lead's check): the header lands first, the records follow in a later pass.
        c.out.textContent = `${service} → NOERROR:`;
        state.dnsHeaderFirst = true;
        queueMicrotask(() => { c.out.textContent = `${service} → NOERROR:\n${qname}. 300 IN ${t} 93.184.216.34`; });
      });
    };
    return [c];
  };

  // Domain tab (domain.mjs:90-122): three queryCard cards; only RDAP is wired here.
  const domainModule = () => {
    const rdap = makeCard('Domain or IP record - via RDAP (rdap.org)');
    const crtsh = makeCard('Certificate transparency - via crt.sh');
    const shodan = makeCard('Open ports and vulnerabilities - via Shodan InternetDB');
    rdap.btn.click = () => {
      const v = rdap.input.value.trim();
      const bad = IPV4_RE.test(v) ? null : domainError(v);
      if (bad) { showErr(rdap, bad); return; }
      rdap.btn.disabled = true; rdap.err.setAttribute('hidden', 'true');
      rdap.out.textContent = 'Querying RDAP (rdap.org)…';
      queueMicrotask(() => {
        rdap.btn.disabled = false;
        rdap.out.textContent = `Nameservers: ns1.example-dns.com, ns2.example-dns.com\nStatus: clientTransferProhibited\nRegistrar: Example Registrar`;
      });
    };
    return [rdap, crtsh, shodan];
  };

  // Security tab (security.mjs:27-99): password card, then the two age cards.
  const securityModule = () => {
    const pw = makeCard('Password strength - checked locally, never stored or sent');
    pw.btn.click = () => {
      const value = pw.input.value;
      if (!value) { showErr(pw, 'Enter a password to check.'); return; }
      const score = value.length >= 12 && /[A-Z]/.test(value) && /\d/.test(value) ? 3 : value.length >= 8 ? 2 : 1;
      pw.err.setAttribute('hidden', 'true');
      pw.out.textContent = `Score: ${score}/4\nOffline attack (fast hash): 21.9 minutes\nOnline attack (no throttling): 5 hours 14 minutes`;
    };
    const makeAge = title => {
      const c = makeCard(title);
      c.fileInput = { files: [] };
      c.pass = { value: '' };
      return c;
    };
    const enc = makeAge('Encrypt a file with age - fully local');
    const dec = makeAge('Decrypt an age file - fully local');
    enc.btn.click = () => {
      const f = enc.fileInput.files?.[0];
      if (!f) { showErr(enc, 'Choose a file first.'); return; }
      if (!enc.pass.value) { showErr(enc, 'Enter a passphrase.'); return; }
      enc.btn.disabled = true; enc.err.setAttribute('hidden', 'true');
      enc.out.textContent = `Encrypting ${f.name} with age…`;
      queueMicrotask(() => {
        enc.btn.disabled = false;
        state.downloads.push(`${f.name}.age`);
        enc.out.textContent = `Encrypted ${f.name} (${f.bytes.length} bytes) - downloaded ${f.name}.age (${f.bytes.length + 32} bytes). The passphrase and file were not sent anywhere.`;
      });
    };
    dec.btn.click = () => {
      const f = dec.fileInput.files?.[0];
      if (!f) { showErr(dec, 'Choose a file first.'); return; }
      if (!dec.pass.value) { showErr(dec, 'Enter a passphrase.'); return; }
      dec.btn.disabled = true; dec.err.setAttribute('hidden', 'true');
      dec.out.textContent = `Decrypting ${f.name} with age…`;
      queueMicrotask(() => {
        dec.btn.disabled = false;
        const entry = ageFiles[f.name];
        if (!entry || entry.passphrase !== dec.pass.value) {
          showErr(dec, 'Decryption failed: the passphrase does not match this age file. (no identity matched the message recipients)');
          return;
        }
        state.downloads.push(f.name.replace(/\.age$/i, '') || 'decrypted');
        dec.out.textContent = `Decrypted ${f.name} (${f.bytes.length} bytes) - downloaded ${f.name.replace(/\.age$/i, '')} (${entry.plaintext.length} bytes). Nothing was sent anywhere.`;
      });
    };
    return { pw, enc, dec, cards: [pw, enc, dec] };
  };

  // The tab shell (ui.mjs:55-86): one panel per tab, the active panel not hidden, a
  // "Loading <label>" placeholder until the module mounts; the first tab mounts on load.
  const panels = new Map();
  const mounted = new Map();
  const activate = id => {
    if (!panels.has(id)) {
      const label = TABS.find(t => t.id === id).label;
      const panel = { hidden: false, dataset: {}, textContent: `Loading ${label}…`, querySelectorAll: sel => (sel === '.nt-card' ? (mounted.get(id)?.cards ?? mounted.get(id) ?? []) : []) };
      panels.set(id, panel);
      queueMicrotask(() => {
        mounted.set(id, id === 'security' ? securityModule() : id === 'dns' ? dnsModule() : id === 'domain' ? domainModule() : subnetModule());
        panel.textContent = '';
      });
    }
    for (const [key, p] of panels) p.hidden = key !== id;
  };
  const bar = { querySelectorAll: sel => (sel === 'button.nt-tab' ? TABS.map(t => ({ dataset: { id: t.id }, click: () => activate(t.id) })) : []) };
  const byId = id => {
    const sec = mounted.get('security');
    if (!sec) return null;
    return {
      'nt-password': sec.pw.input, 'nt-password-check': sec.pw.btn, 'nt-password-out': sec.pw.out,
      'nt-age-encrypt-file': sec.enc.fileInput, 'nt-age-encrypt-pass': sec.enc.pass,
      'nt-age-decrypt-file': sec.dec.fileInput, 'nt-age-decrypt-pass': sec.dec.pass,
    }[id] ?? null;
  };
  const document = {
    querySelector: sel => (sel === 'nav.nt-tabs' ? bar : null),
    querySelectorAll: sel => (sel === 'section .nt-content' ? [...panels.values()] : []),
    getElementById: byId,
  };
  const File = class { constructor(parts, name) { this.name = name; this.bytes = parts[0]; } };
  const DataTransfer = class { constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; } };
  const win = { File, DataTransfer, document };
  activate('subnet'); // main.mjs:85 auto-mounts the first tab
  queueMicrotask(() => { win.webpcNettools = { ready: true }; }); // main.mjs:29
  const wrapper = { document: { getElementById: id => (id === 'nettools-frame' ? { contentWindow: win } : null) } };
  const files = {
    readBytes: path => {
      const file = fileStore[path];
      if (!file) { const error = new Error(`${path} is not a file.`); error.code = 'not_found'; return Promise.reject(error); }
      return Promise.resolve({ path, name: file.name, bytes: file.bytes, size: file.bytes.length });
    },
  };
  const runTool = (name, args, extra = {}) => byName(name).run(args, { host: { appWindow: async () => wrapper }, files, sleep: async () => {}, ...extra });
  return { win, files, runTool, state };
};

test('the pack declares its id and title', () => {
  assert.deepEqual(pack, { id: 'nettools', title: 'Network Tools' });
});

test('the pack exposes exactly the 6 nettools tools', () => {
  assert.equal(tools.length, 6);
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'nettools.age_decrypt', 'nettools.age_encrypt', 'nettools.dns_lookup',
    'nettools.password_strength', 'nettools.rdap', 'nettools.subnet',
  ]);
});

test('every tool has the required text fields, effect, needs and examples', () => {
  for (const tool of tools) {
    assert.match(tool.name, /^nettools\.[a-z0-9_]+$/);
    assert.ok(tool.purpose.length > 0 && tool.purpose.length <= 80, `${tool.name} purpose is ${tool.purpose.length} chars`);
    assert.ok(tool.when.startsWith('Use when'), `${tool.name} when must start with "Use when"`);
    assert.ok(tool.when.length <= 120, `${tool.name} when is ${tool.when.length} chars`);
    assert.ok(['read', 'change', 'destructive', 'external'].includes(tool.effect), `${tool.name} bad effect`);
    assert.deepEqual(tool.needs, ['host', 'app:nettools']);
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

test('every example passes the runtime checkArgs, and dns_lookup defaults type to A', () => {
  for (const tool of tools) {
    for (const [n, example] of tool.examples.entries()) {
      const out = checkArgs(tool, example.args, { choices });
      assert.ok(out.ok, `${tool.name} example ${n}: ${out.error?.message}`);
    }
  }
  assert.equal(checkArgs(byName('nettools.dns_lookup'), { name: 'example.com' }, { choices }).args.type, 'A');
});

test('nettools.dns_lookup waits for the record lines after the header and returns the full answer', async () => {
  const nt = fakeNettools();
  let got = await nt.runTool('nettools.dns_lookup', { name: 'example.com', type: 'A' });
  assert.equal(nt.state.dnsHeaderFirst, true, 'the fake went through the header-only phase like the live app');
  assert.match(got.result, /^Cloudflare DNS-over-HTTPS → NOERROR:\nexample\.com\. 300 IN A 93\.184\.216\.34$/, 'the result is the whole output, not just the header line');
  got = await nt.runTool('nettools.dns_lookup', { name: 'example.com', type: 'MX' });
  assert.match(got.result, /IN MX/);
});

test('nettools.dns_lookup builds the reverse name for PTR from an IP', async () => {
  const nt = fakeNettools();
  const got = await nt.runTool('nettools.dns_lookup', { name: '1.2.3.4', type: 'PTR' });
  assert.match(got.result, /4\.3\.2\.1\.in-addr\.arpa/);
});

test('nettools.dns_lookup rejects a bad domain before querying', async () => {
  const nt = fakeNettools();
  await assert.rejects(nt.runTool('nettools.dns_lookup', { name: 'no-dots' }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'invalid_argument');
    assert.match(error.message, /the app rejected the request: Enter a full domain, e\.g\. example\.com\./);
    return true;
  });
});

test('nettools.dns_lookup rejects a PTR value that is not an IP', async () => {
  const nt = fakeNettools();
  await assert.rejects(nt.runTool('nettools.dns_lookup', { name: 'example.com', type: 'PTR' }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'invalid_argument');
    assert.match(error.message, /PTR needs a valid IP address/);
    return true;
  });
});

test('nettools.dns_lookup reports a failed request as an app error', async () => {
  const nt = fakeNettools();
  await assert.rejects(nt.runTool('nettools.dns_lookup', { name: 'offline.example' }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'app_error');
    assert.match(error.message, /request failed \(network error\)/);
    return true;
  });
});

test('nettools.rdap fetches the registry record and rejects a bad query', async () => {
  const nt = fakeNettools();
  const got = await nt.runTool('nettools.rdap', { query: 'example.com' });
  assert.match(got.result, /Nameservers: ns1\.example-dns\.com/);
  await assert.rejects(nt.runTool('nettools.rdap', { query: 'not a domain' }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'invalid_argument');
    assert.match(error.message, /no spaces, 253 chars max/);
    return true;
  });
});

test('nettools.subnet computes a v4 block locally and rejects a bad cidr', async () => {
  const nt = fakeNettools();
  const got = await nt.runTool('nettools.subnet', { cidr: '192.168.10.0/24' });
  assert.match(got.result, /Network:  192\.168\.10\.0/);
  assert.match(got.result, /First host:  192\.168\.10\.1/);
  assert.match(got.result, /Addresses: 256/);
  await assert.rejects(nt.runTool('nettools.subnet', { cidr: '192.168.10.0' }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'invalid_argument');
    assert.match(error.message, /Use the form <address>\/<prefix>/);
    return true;
  });
});

test('nettools.password_strength scores a password locally', async () => {
  const nt = fakeNettools();
  const got = await nt.runTool('nettools.password_strength', { text: 'Correct-Horse-Battery-1' });
  assert.match(got.result, /^Score: [0-4]\/4/);
  assert.equal(checkArgs(byName('nettools.password_strength'), { text: '  ' }, { choices }).ok, false, 'a blank password is a missing argument');
});

test('nettools.age_encrypt encrypts the file and reports the download', async () => {
  const nt = fakeNettools();
  const got = await nt.runTool('nettools.age_encrypt', { path: '/docs/report.pdf', passphrase: AGE_PASS });
  assert.match(got.result, /Encrypted report\.pdf \(3 bytes\)/);
  assert.match(got.result, /downloaded report\.pdf\.age/);
  assert.deepEqual(nt.state.downloads, ['report.pdf.age'], 'the app downloaded the encrypted file');
});

test('nettools.age_encrypt passes the Files error code through for a missing file', async () => {
  const nt = fakeNettools();
  await assert.rejects(nt.runTool('nettools.age_encrypt', { path: '/nope.pdf', passphrase: 'x' }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_found');
    return true;
  });
});

test('nettools.age_decrypt decrypts with the right passphrase and rejects a wrong one', async () => {
  const nt = fakeNettools();
  const got = await nt.runTool('nettools.age_decrypt', { path: '/docs/report.pdf.age', passphrase: AGE_PASS });
  assert.match(got.result, /Decrypted report\.pdf\.age \(3 bytes\)/);
  assert.match(got.result, /downloaded report\.pdf/);
  assert.deepEqual(nt.state.downloads, ['report.pdf']);
  const wrong = fakeNettools();
  await assert.rejects(wrong.runTool('nettools.age_decrypt', { path: '/docs/report.pdf.age', passphrase: 'wrong' }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'app_error');
    assert.match(error.message, /the passphrase does not match this age file/);
    return true;
  });
});

test('a tool rejects with not_available when ctx.host is absent', async () => {
  await assert.rejects(byName('nettools.subnet').run({ cidr: '10.0.0.0/24' }, { host: null }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    return true;
  });
});

test('a tool rejects with not_available when the app never becomes ready', async () => {
  const bare = { document: { getElementById: () => ({ contentWindow: { document: {} } }) } };
  await assert.rejects(byName('nettools.subnet').run({ cidr: '10.0.0.0/24' }, { host: { appWindow: async () => bare }, sleep: async () => {}, timeoutMs: 300 }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    assert.match(error.message, /did not finish loading/);
    return true;
  });
});

test('a host rejection code is passed through as the ToolError type', async () => {
  const boom = () => { const error = new Error('window "nettools" is not open'); error.code = 'not_open'; throw error; };
  await assert.rejects(byName('nettools.rdap').run({ query: 'example.com' }, { host: { appWindow: boom } }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_open');
    return true;
  });
});

const { skills, errors: skillErrors } = parseSkills(SKILLS_MD, 'nettools');

test('skills.md parses with the runtime parser without errors and has 6 skills', () => {
  assert.deepEqual(skillErrors, []);
  assert.equal(skills.length, 6);
  for (const skill of skills) {
    assert.ok(skill.slug && skill.summary, `skill ${skill.slug} slug/summary`);
    assert.ok(skill.summary.length <= 160, `skill ${skill.slug} summary is ${skill.summary.length} chars`);
    assert.ok(skill.keywords.length >= 5, `skill ${skill.slug} keywords: ${skill.keywords.join(', ')}`);
    assert.ok(skill.tools.length >= 1, `skill ${skill.slug} tools`);
    assert.ok(skill.when && skill.steps.length >= 1 && skill.check, `skill ${skill.slug} body sections`);
  }
});

test('the password-strength skill scores the exact password string (lfm3-1.7b nettools-05 scored the phrase)', () => {
  const check = skills.find(skill => skill.slug === 'check-a-password-strength');
  assert.ok(check.gotchas.includes('exact password string'), 'the skill says to score the exact string');
  assert.ok(check.gotchas.includes('the password is falcon'), 'the skill shows the old-password phrasing');
});

test('every skill opens by launching the nettools app, then uses numbered nettools steps', () => {
  for (const skill of skills) {
    assert.equal(skill.steps[0].line, '1. call_tool tool=desktop.open_app app=nettools', `skill ${skill.slug}`);
    skill.steps.forEach((step, i) => {
      assert.equal(step.n, i + 1, `skill ${skill.slug} step numbering`);
      assert.ok(step.tool.startsWith('desktop.') || step.tool.startsWith('nettools.'), `skill ${skill.slug} step ${step.n}: ${step.line}`);
    });
  }
});

test('skill steps and tools lines validate against the runtime checkArgs', () => {
  const errors = checkSkills(skills, byName, { checkArgs: (tool, args) => checkArgs(tool, args, { choices }) });
  assert.deepEqual(errors, []);
});
