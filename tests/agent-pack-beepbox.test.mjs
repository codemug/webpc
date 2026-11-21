// Unit tests for the BeepBox pack: agent/apps/beepbox/tools.js and skills.md.
// The fake inner window mirrors the vendored BeepBox v4.2.2 surface the pack drives: the editor
// (SongEditor, public doc) read through the frame's own realm via win.eval - the vendored
// index.html declares it with a top-level `let`, which is not a window property (live-confirmed:
// win.editor is undefined, win.eval('typeof editor === "undefined" ? null : editor') returns
// it) - plus doc.song (toBase64String, tempo), doc.synth.playing,
// the File menu select with a "new" option, the tempo stepper (number input next to the range
// slider min 0 max 14), the play/pause buttons, and the SongDocument history rule that a
// hashchange with history.state null and a non-empty hash loads the song from the hash.
// Run: node --test tests/agent-pack-beepbox.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack, tools } from '../agent/apps/beepbox/tools.js';
import { tools as desktopTools } from '../agent/desktop/tools.js';
import { ToolError, specErrors, checkArgs } from '../src/apps/ai-agent/runtime/args.mjs';
import { parseSkills, checkSkills } from '../src/apps/ai-agent/runtime/skills.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_MD = readFileSync(join(HERE, '..', 'agent', 'apps', 'beepbox', 'skills.md'), 'utf8');
// The enabled app ids scripts/agent/build.mjs resolves the live 'apps' enum with (catalog.yaml).
const APP_IDS = ['gridcraft', 'docs', 'deckcraft', 'terminal', 'sqliteviz', 'files', 'media', 'cyberchef', 'vscode', 'nettools', 'packets', 'ai-agent', 'lightcraft', 'figcraft', 'pdfcraft', 'soundcraft', 'beepbox', 'filmcraft', 'cadcraft', 'vectorcraft', 'photocraft', 'effectcraft', 'materialcraft', 'texturecraft', 'excalidraw', 'vert', 'about'];
const choices = name => (name === 'apps' || name === 'windows' ? APP_IDS : []);
const byName = name => tools.find(tool => tool.name === name) ?? desktopTools.find(tool => tool.name === name);

// Songs the fake app knows, keyed by hash (the part after # in a share URL).
const SONGS = { ABC: { tempo: 120 }, XYZ: { tempo: 200 }, NEW: { tempo: 120 } };

const fakeBeepbox = (options = {}) => {
  const state = { historyState: { canUndo: true }, loaded: 0, news: 0, played: 0, stopped: 0, tempoSets: [], suspendAudio: options.suspendAudio ?? false };
  const makeSong = hash => ({ hash, tempo: SONGS[hash].tempo, toBase64String: () => hash });
  const doc = { song: makeSong('ABC'), synth: { playing: false }, prefs: { displayBrowserUrl: false } };
  const editor = { doc };
  // SongDocument._whenHistoryStateChanged (SongDocument.ts:211): history.state null plus a
  // non-empty hash loads the song from the hash; an unknown hash keeps the current song
  // (the app's error path), and a load restores the app's own history state.
  const applyHash = () => {
    if (state.historyState != null || location.hash === '') return;
    const raw = location.hash.slice(1);
    if (!SONGS[raw]) return;
    doc.song = makeSong(raw);
    doc.synth.playing = false;
    state.loaded += 1;
    state.historyState = { canUndo: true };
  };
  const location = {
    _hash: '#ABC',
    get hash() { return this._hash; },
    set hash(value) {
      this._hash = String(value).startsWith('#') ? String(value) : (value ? `#${value}` : '');
      queueMicrotask(applyHash);
    },
  };
  const history = {
    get state() { return state.historyState; },
    replaceState: value => { state.historyState = value; },
    pushState: value => { state.historyState = value; },
  };
  // The File menu: the select in .beepboxEditor whose options include value "new"; the app's
  // _fileMenuHandler case "new" resets the song through the change and undo machinery.
  const listeners = {};
  const element = (name, extra = {}) => ({
    ...extra,
    addEventListener: (type, fn) => { (listeners[name + type] ??= []).push(fn); },
    dispatchEvent: event => { (listeners[name + event.type] ?? []).forEach(fn => fn(event)); return true; },
  });
  const fileMenu = element('fileMenu', { value: 'new', options: [{ value: 'new' }, { value: 'export' }, { value: 'copyUrl' }] });
  const otherMenu = element('otherMenu', { value: 'chips', options: [{ value: 'chips' }] });
  fileMenu.addEventListener('change', () => {
    if (fileMenu.value !== 'new') return;
    doc.song = makeSong('NEW');
    doc.synth.playing = false;
    state.news += 1;
    state.historyState = { canUndo: false };
  });
  // The tempo stepper: number input next to the range slider (min 0 max 14); its change
  // listener records ChangeTempo with the exact BPM (SongEditor _whenSetTempo).
  const stepper = element('stepper', { value: '120' });
  const row = { querySelector: sel => (sel === 'input[type="number"]' ? stepper : null) };
  const slider = { closest: sel => (sel === '.selectRow' ? row : null) };
  stepper.addEventListener('change', () => {
    doc.song.tempo = parseInt(stepper.value) | 0;
    state.tempoSets.push(stepper.value);
  });
  // Play/pause buttons: the app shows exactly one at a time (updatePlayButton).
  const playButton = element('play', { style: { display: '' }, click: () => playButton.dispatchEvent(new Event('click')) });
  const pauseButton = element('pause', { style: { display: 'none' }, click: () => pauseButton.dispatchEvent(new Event('click')) });
  playButton.addEventListener('click', () => {
    if (doc.synth.playing) return;
    if (state.suspendAudio) return; // the audio context is suspended, so the handler cannot start playback
    doc.synth.playing = true; state.played += 1;
    playButton.style.display = 'none'; pauseButton.style.display = '';
  });
  pauseButton.addEventListener('click', () => {
    if (!doc.synth.playing) return;
    doc.synth.playing = false; state.stopped += 1;
    playButton.style.display = ''; pauseButton.style.display = 'none';
  });
  const document = {
    getElementById: () => null,
    querySelector: sel => ({
      'input[type="range"][min="0"][max="14"]': slider,
      'input[type="number"]': stepper,
      'button.playButton': playButton,
      'button.pauseButton': pauseButton,
    }[sel] ?? null),
    querySelectorAll: sel => (sel === '.beepboxEditor select' ? [otherMenu, fileMenu] : []),
  };
  // The pack reads the editor through the frame's own realm (win.eval), because the vendored
  // index.html top-level `let editor` is not a window property. The probe string is
  // 'typeof editor === "undefined" ? null : editor'; the fake answers with the lexical binding.
  const win = { eval: code => (String(code).includes('editor') ? editor : null), document, history, location };
  const wrapper = { document: { getElementById: id => (id === 'beepbox-frame' ? { contentWindow: win } : null) } };
  const runTool = (name, args, extra = {}) => byName(name).run(args, { host: { appWindow: async () => wrapper }, sleep: async () => {}, ...extra });
  return { win, doc, state, fileMenu, stepper, playButton, pauseButton, runTool };
};

test('the pack declares its id and title', () => {
  assert.deepEqual(pack, { id: 'beepbox', title: 'BeepBox' });
});

test('the pack exposes exactly the 6 beepbox tools', () => {
  assert.equal(tools.length, 6);
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'beepbox.get_song', 'beepbox.load_song', 'beepbox.new_song', 'beepbox.play', 'beepbox.set_tempo', 'beepbox.stop',
  ]);
});

test('every tool has the required text fields, effect, needs and examples', () => {
  for (const tool of tools) {
    assert.match(tool.name, /^beepbox\.[a-z0-9_]+$/);
    assert.ok(tool.purpose.length > 0 && tool.purpose.length <= 80, `${tool.name} purpose is ${tool.purpose.length} chars`);
    assert.ok(tool.when.startsWith('Use when'), `${tool.name} when must start with "Use when"`);
    assert.ok(tool.when.length <= 120, `${tool.name} when is ${tool.name.length} chars`);
    assert.ok(['read', 'change', 'destructive', 'external'].includes(tool.effect), `${tool.name} bad effect`);
    assert.deepEqual(tool.needs, ['host', 'app:beepbox']);
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

test('the effects are read for get_song, destructive for new_song, change for the rest', () => {
  assert.equal(byName('beepbox.get_song').effect, 'read', 'get_song');
  assert.equal(byName('beepbox.new_song').effect, 'destructive', 'new_song');
  for (const name of ['beepbox.load_song', 'beepbox.set_tempo', 'beepbox.play', 'beepbox.stop']) assert.equal(byName(name).effect, 'change', name);
});

test('beepbox.get_song reads the live song hash and tempo', async () => {
  const box = fakeBeepbox();
  const got = await box.runTool('beepbox.get_song', {});
  assert.deepEqual(got, { hash: 'ABC', tempo: 120 });
});

test('beepbox.load_song loads a bare hash and a full share URL', async () => {
  const box = fakeBeepbox();
  let got = await box.runTool('beepbox.load_song', { hash: 'XYZ' });
  assert.deepEqual(got, { hash: 'XYZ' });
  assert.equal(box.state.loaded, 1, 'the app loaded the song from the hashchange');
  assert.equal(box.doc.song.hash, 'XYZ');
  got = await box.runTool('beepbox.load_song', { hash: 'https://beepbox.co/editor/#ABC' });
  assert.deepEqual(got, { hash: 'ABC' });
  assert.equal(box.state.loaded, 2);
  assert.equal(box.doc.song.hash, 'ABC');
  assert.deepEqual(box.state.historyState, { canUndo: true }, 'the app restored its history state after the load');
});

test('beepbox.load_song round trips through an empty hash when the same song is loaded', async () => {
  const box = fakeBeepbox();
  const got = await box.runTool('beepbox.load_song', { hash: 'ABC' });
  assert.deepEqual(got, { hash: 'ABC' });
  assert.equal(box.state.loaded, 1, 'the empty-hash step lets the hashchange that loads fire');
  assert.equal(box.doc.song.hash, 'ABC');
});

test('beepbox.load_song rejects a value without a hash', async () => {
  const box = fakeBeepbox();
  for (const value of ['https://beepbox.co/editor', '#', '   ']) {
    await assert.rejects(box.runTool('beepbox.load_song', { hash: value }), error => {
      assert.ok(error instanceof ToolError);
      assert.equal(error.type, 'invalid_argument');
      return true;
    });
  }
  assert.equal(box.state.loaded, 0, 'nothing was loaded');
});

test('beepbox.load_song keeps the current song when the hash is unknown', async () => {
  const box = fakeBeepbox();
  const got = await box.runTool('beepbox.load_song', { hash: 'QQQ' });
  assert.deepEqual(got, { hash: 'QQQ' });
  assert.equal(box.doc.song.hash, 'ABC', 'the app error path keeps the old song');
  assert.equal(box.state.loaded, 0);
});

test('beepbox.new_song resets the editor to the blank song', async () => {
  const box = fakeBeepbox();
  await box.runTool('beepbox.load_song', { hash: 'XYZ' });
  const got = await box.runTool('beepbox.new_song', {});
  assert.deepEqual(got, { hash: 'NEW' });
  assert.equal(box.state.news, 1, 'the file menu change was dispatched with value new');
  assert.equal(box.doc.song.tempo, 120);
});

test('beepbox.set_tempo sets the exact BPM through the app tempo stepper', async () => {
  const box = fakeBeepbox();
  const got = await box.runTool('beepbox.set_tempo', { bpm: 180 });
  assert.deepEqual(got, { tempo: 180 });
  assert.deepEqual(box.state.tempoSets, ['180'], 'the stepper change listener recorded the exact BPM');
  const live = await box.runTool('beepbox.get_song', {});
  assert.equal(live.tempo, 180);
});

test('beepbox.set_tempo rejects BPM outside the app range 30 to 300', () => {
  const tool = byName('beepbox.set_tempo');
  assert.equal(checkArgs(tool, { bpm: 10 }, { choices }).ok, false, 'below the app minimum');
  assert.equal(checkArgs(tool, { bpm: 400 }, { choices }).ok, false, 'above the app maximum');
  assert.equal(checkArgs(tool, { bpm: 180.5 }, { choices }).ok, false, 'an integer is required');
});

test('beepbox.play clicks the app play button and reports the live state', async () => {
  const box = fakeBeepbox();
  let got = await box.runTool('beepbox.play', {});
  assert.deepEqual(got, { playing: true });
  assert.equal(box.state.played, 1);
  assert.equal(box.playButton.style.display, 'none', 'the app swaps the visible button');
  got = await box.runTool('beepbox.play', {});
  assert.deepEqual(got, { playing: true }, 'playing again is a no-op');
  assert.equal(box.state.played, 1);
});

test('beepbox.play reports a suspended audio context when the click does not start playback', async () => {
  const box = fakeBeepbox({ suspendAudio: true });
  const got = await box.runTool('beepbox.play', {});
  assert.equal(got.playing, false);
  assert.match(got.note, /audio context may be suspended/);
  assert.match(got.note, /click Play once in the app window/);
});

test('beepbox.stop on a stopped song returns playing false as a success', async () => {
  const box = fakeBeepbox();
  const got = await box.runTool('beepbox.stop', {});
  assert.deepEqual(got, { playing: false });
  assert.equal(box.state.stopped, 0, 'no click was needed');
});

test('beepbox.stop stops playback from the live state even when the pause button is not visible', async () => {
  const box = fakeBeepbox();
  await box.runTool('beepbox.play', {});
  assert.equal(box.doc.synth.playing, true);
  box.pauseButton.style.display = 'none'; // the live check state: not visible right after play
  const got = await box.runTool('beepbox.stop', {});
  assert.deepEqual(got, { playing: false });
  assert.equal(box.state.stopped, 1, 'the app pause control was clicked without gating on visibility');
});

test('beepbox.stop clicks the app pause button and reports the live state', async () => {
  const box = fakeBeepbox();
  await box.runTool('beepbox.play', {});
  const got = await box.runTool('beepbox.stop', {});
  assert.deepEqual(got, { playing: false });
  assert.equal(box.state.stopped, 1);
  assert.equal(box.pauseButton.style.display, 'none');
  const again = await box.runTool('beepbox.stop', {});
  assert.deepEqual(again, { playing: false }, 'stopping again is a no-op');
  assert.equal(box.state.stopped, 1);
});

test('a tool rejects with not_available when ctx.host is absent', async () => {
  await assert.rejects(byName('beepbox.get_song').run({}, { host: null }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    return true;
  });
});

test('a tool rejects with not_available when the editor never appears', async () => {
  const box = fakeBeepbox();
  const bare = { document: { getElementById: () => ({ contentWindow: { document: {} } }) } };
  await assert.rejects(byName('beepbox.get_song').run({}, { host: { appWindow: async () => bare }, sleep: async () => {}, timeoutMs: 300 }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    assert.match(error.message, /did not finish loading/);
    return true;
  });
  const noFrame = { host: { appWindow: async () => ({}) } };
  await assert.rejects(byName('beepbox.play').run({}, noFrame), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    assert.match(error.message, /no beepbox-frame frame/);
    return true;
  });
});

test('a host rejection code is passed through as the ToolError type', async () => {
  const boom = () => { const error = new Error('window "beepbox" is not open'); error.code = 'not_open'; throw error; };
  await assert.rejects(byName('beepbox.get_song').run({}, { host: { appWindow: boom } }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_open');
    return true;
  });
});

const { skills, errors: skillErrors } = parseSkills(SKILLS_MD, 'beepbox');

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

test('every skill opens by launching BeepBox, then uses numbered beepbox steps', () => {
  for (const skill of skills) {
    assert.equal(skill.steps[0].line, '1. call_tool tool=desktop.open_app app=beepbox', `skill ${skill.slug}`);
    skill.steps.forEach((step, i) => {
      assert.equal(step.n, i + 1, `skill ${skill.slug} step numbering`);
      assert.ok(step.tool.startsWith('desktop.') || step.tool.startsWith('beepbox.'), `skill ${skill.slug} step ${step.n}: ${step.line}`);
    });
  }
});

test('skill steps and tools lines validate against the runtime checkArgs', () => {
  const errors = checkSkills(skills, byName, { checkArgs: (tool, args) => checkArgs(tool, args, { choices }) });
  assert.deepEqual(errors, []);
});
