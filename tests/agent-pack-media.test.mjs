// Unit tests for the Media Player pack: agent/apps/media/tools.js and skills.md.
// The fake media page mirrors the app DOM (src/scripts/pc/apps/media.mjs + the page markup):
// #media-video (the media element), #media-title, #media-volume (0..1 range whose input event
// runs the app's setVolume) and the #media-list li[data-i] rows with a .mp-name, the selected
// row carrying class "sel". ctx.files.readBytes is the Files context from
// src/apps/ai-agent/runtime/files-ctx.mjs (bytes out, coded errors in).
// Run: node --test tests/agent-pack-media.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack, tools } from '../agent/apps/media/tools.js';
import { tools as desktopTools } from '../agent/desktop/tools.js';
import { ToolError, specErrors, checkArgs } from '../src/apps/ai-agent/runtime/args.mjs';
import { parseSkills, checkSkills } from '../src/apps/ai-agent/runtime/skills.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_MD = readFileSync(join(HERE, '..', 'agent', 'apps', 'media', 'skills.md'), 'utf8');
// The enabled app ids scripts/agent/build.mjs resolves the live 'apps' enum with (catalog.yaml).
const APP_IDS = ['gridcraft', 'docs', 'deckcraft', 'terminal', 'sqliteviz', 'files', 'media', 'cyberchef', 'vscode', 'nettools', 'packets', 'ai-agent', 'lightcraft', 'figcraft', 'pdfcraft', 'soundcraft', 'beepbox', 'filmcraft', 'cadcraft', 'vectorcraft', 'photocraft', 'effectcraft', 'materialcraft', 'texturecraft', 'excalidraw', 'vert', 'about'];
const choices = name => (name === 'apps' || name === 'windows' ? APP_IDS : []);
const byName = name => tools.find(tool => tool.name === name) ?? desktopTools.find(tool => tool.name === name);

const fakeMedia = () => {
  const state = {
    opened: 0, blobUrls: 0, played: 0, playBlocked: false,
    duration: 120.5, currentTime: 0, volume: 0.8, muted: false,
    files: { '/music/tune.mp3': { bytes: new Uint8Array([1, 2, 3]), size: 3 } },
    playlist: [{ name: 'tune.mp3', current: true }, { name: 'other.ogg', current: false }],
  };
  const video = {
    src: '',
    get paused() { return state.paused; },
    get muted() { return state.muted; },
    get duration() { return state.duration; },
    get currentTime() { return state.currentTime; },
    get volume() { return state.volume; },
    set volume(v) { state.volume = v; },
    play() {
      state.played += 1;
      if (state.playBlocked) return Promise.reject(new Error('NotAllowedError'));
      state.paused = false;
      return Promise.resolve();
    },
    pause() { state.paused = true; },
    set currentTime(v) { state.currentTime = v; },
  };
  state.paused = true;
  const title = { textContent: 'Nothing playing' };
  const vol = {
    value: '0.8',
    listeners: {},
    addEventListener: (type, fn) => { (vol.listeners[type] ??= []).push(fn); },
    dispatchEvent: event => { (vol.listeners[event.type] ?? []).forEach(fn => fn(event)); return true; },
  };
  // The app's setVolume (media.mjs:82): clamp 0..1 and store on the video element.
  vol.addEventListener('input', () => { state.volume = Math.min(1, Math.max(0, parseFloat(vol.value) || 0)); });
  const rows = () => state.playlist.map(item => ({ className: item.current ? 'sel' : '', querySelector: sel => (sel === '.mp-name' ? { textContent: item.name } : null) }));
  const document = {
    getElementById: id => ({ 'media-video': video, 'media-title': title, 'media-volume': vol }[id] ?? null),
    querySelectorAll: sel => (sel === '#media-list li[data-i]' ? rows() : []),
  };
  const Blob = class { constructor(parts) { this.parts = parts; } };
  const URL = { createObjectURL: () => `blob:fake-${++state.blobUrls}` };
  const win = { document, Blob, URL };
  const host = { appWindow: async () => { state.opened += 1; return win; } };
  const files = {
    readBytes: path => {
      const file = state.files[path];
      if (!file) { const error = new Error(`${path} is not a file.`); error.code = 'not_found'; return Promise.reject(error); }
      return Promise.resolve({ path, name: path.split('/').pop(), bytes: file.bytes, size: file.size });
    },
  };
  const runTool = (name, args, extra = {}) => byName(name).run(args, { host, files, ...extra });
  return { state, video, title, vol, win, files, runTool };
};

test('the pack declares its id and title', () => {
  assert.deepEqual(pack, { id: 'media', title: 'Media Player' });
});

test('the pack exposes exactly the 5 media tools', () => {
  assert.equal(tools.length, 5);
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'media.pause', 'media.play_file', 'media.seek', 'media.status', 'media.volume',
  ]);
});

test('every tool has the required text fields, effect, needs and examples', () => {
  for (const tool of tools) {
    assert.match(tool.name, /^media\.[a-z0-9_]+$/);
    assert.ok(tool.purpose.length > 0 && tool.purpose.length <= 80, `${tool.name} purpose is ${tool.purpose.length} chars`);
    assert.ok(tool.when.startsWith('Use when'), `${tool.name} when must start with "Use when"`);
    assert.ok(tool.when.length <= 120, `${tool.name} when is ${tool.when.length} chars`);
    assert.ok(['read', 'change', 'destructive', 'external'].includes(tool.effect), `${tool.name} bad effect`);
    assert.deepEqual(tool.needs, ['host', 'app:media']);
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

test('media.play_file plays the file bytes and reports the live playing state', async () => {
  const media = fakeMedia();
  const got = await media.runTool('media.play_file', { path: '/music/tune.mp3' });
  assert.deepEqual(got, { name: 'tune.mp3', kind: 'audio', playing: true });
  assert.equal(media.state.opened, 1);
  assert.equal(media.video.src, 'blob:fake-1', 'the bytes are handed to the video as an object URL');
  assert.equal(media.title.textContent, 'tune.mp3');
  assert.equal(media.state.played, 1);
});

test('media.play_file reports a blocked autoplay as playing false with a note', async () => {
  const media = fakeMedia();
  media.state.playBlocked = true;
  const got = await media.runTool('media.play_file', { path: '/music/tune.mp3' });
  assert.equal(got.playing, false);
  assert.match(got.note, /autoplay was blocked/);
  assert.equal(media.video.src, 'blob:fake-1', 'the media is still loaded, so the user can press Play');
});

test('media.play_file rejects a file that is not audio or video', async () => {
  const media = fakeMedia();
  media.state.files['/notes.txt'] = { bytes: new Uint8Array([1]), size: 1 };
  await assert.rejects(media.runTool('media.play_file', { path: '/notes.txt' }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'invalid_argument');
    assert.match(error.message, /not an audio or video file/);
    return true;
  });
  assert.equal(media.state.played, 0);
});

test('media.play_file passes the Files error code through for a missing file', async () => {
  const media = fakeMedia();
  await assert.rejects(media.runTool('media.play_file', { path: '/nope.mp3' }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_found');
    return true;
  });
});

test('media.play_file rejects with not_available when the Files tools are off', async () => {
  const media = fakeMedia();
  await assert.rejects(byName('media.play_file').run({ path: '/music/tune.mp3' }, { host: { appWindow: async () => media.win } }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    assert.match(error.message, /Files tools/);
    return true;
  });
});

test('media.pause pauses the video element', async () => {
  const media = fakeMedia();
  await media.runTool('media.play_file', { path: '/music/tune.mp3' });
  const got = await media.runTool('media.pause', {});
  assert.deepEqual(got, { paused: true });
  assert.equal(media.state.paused, true);
});

test('media.seek moves to the given second within the loaded media', async () => {
  const media = fakeMedia();
  const got = await media.runTool('media.seek', { seconds: 30 });
  assert.deepEqual(got, { time: 30 });
  assert.equal(media.state.currentTime, 30);
});

test('media.seek rejects when the position is outside the media length', async () => {
  const media = fakeMedia();
  await assert.rejects(media.runTool('media.seek', { seconds: 999 }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'invalid_argument');
    return true;
  });
  assert.equal(media.state.currentTime, 0, 'nothing was moved');
});

test('media.seek rejects when no media is loaded yet', async () => {
  const media = fakeMedia();
  media.state.duration = NaN;
  await assert.rejects(media.runTool('media.seek', { seconds: 5 }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'app_error');
    assert.match(error.message, /no media is loaded/);
    return true;
  });
});

test('media.volume drives the app volume input and reports the live volume', async () => {
  const media = fakeMedia();
  const got = await media.runTool('media.volume', { percent: 50 });
  assert.deepEqual(got, { volume: 0.5 });
  assert.equal(media.vol.value, '0.5', 'the app input carries the 0..1 value its handler reads');
});

test('media.volume rejects a percent outside 0 to 100', () => {
  const tool = byName('media.volume');
  assert.equal(checkArgs(tool, { percent: 101 }, { choices }).ok, false);
  assert.equal(checkArgs(tool, { percent: -1 }, { choices }).ok, false);
  assert.equal(checkArgs(tool, { percent: 50.5 }, { choices }).ok, false, 'an integer is required');
});

test('media.status reports the live title, position, volume and playlist', async () => {
  const media = fakeMedia();
  media.title.textContent = 'tune.mp3';
  media.state.paused = false;
  media.state.currentTime = 30;
  media.state.muted = true;
  const got = await media.runTool('media.status', {});
  assert.deepEqual(got, {
    title: 'tune.mp3',
    playing: true,
    time: 30,
    duration: 120.5,
    volume: 0.8,
    muted: true,
    playlist: [{ name: 'tune.mp3', current: true }, { name: 'other.ogg', current: false }],
  });
});

test('media.status reports a null duration when nothing is loaded', async () => {
  const media = fakeMedia();
  media.state.duration = NaN;
  media.state.playlist = [];
  const got = await media.runTool('media.status', {});
  assert.equal(got.duration, null);
  assert.deepEqual(got.playlist, []);
  assert.equal(got.title, 'Nothing playing');
});

test('a tool rejects with not_available when ctx.host is absent', async () => {
  await assert.rejects(byName('media.status').run({}, { host: null }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_available');
    return true;
  });
});

test('a host rejection code is passed through as the ToolError type', async () => {
  const boom = () => { const error = new Error('window "media" is not open'); error.code = 'not_open'; throw error; };
  await assert.rejects(byName('media.pause').run({}, { host: { appWindow: boom } }), error => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.type, 'not_open');
    return true;
  });
});

const { skills, errors: skillErrors } = parseSkills(SKILLS_MD, 'media');

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

test('every skill opens by launching the media app, then uses numbered media steps', () => {
  for (const skill of skills) {
    assert.equal(skill.steps[0].line, '1. call_tool tool=desktop.open_app app=media', `skill ${skill.slug}`);
    skill.steps.forEach((step, i) => {
      assert.equal(step.n, i + 1, `skill ${skill.slug} step numbering`);
      assert.ok(step.tool.startsWith('desktop.') || step.tool.startsWith('media.'), `skill ${skill.slug} step ${step.n}: ${step.line}`);
    });
  }
});

test('skill steps and tools lines validate against the runtime checkArgs', () => {
  const errors = checkSkills(skills, byName, { checkArgs: (tool, args) => checkArgs(tool, args, { choices }) });
  assert.deepEqual(errors, []);
});
