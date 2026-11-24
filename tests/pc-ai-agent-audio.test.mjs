// Unit tests for M2 audio input: the marker, persistence stripping, the worker message builder
// (audio part) and the send validation. Run: node --test tests/pc-ai-agent-audio.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioMarker, stripAudio } from '../src/apps/ai-agent/agent.js';
import { AgentSession } from '../src/apps/ai-agent/session.js';
import { MODELS } from '../src/apps/ai-agent/models.js';

const rec = (seconds, count = Math.round(seconds * 16000)) => ({ name: 'recording', seconds, sampleRate: 16000, samples: new Float32Array(count) });

test('the audio marker is plain text with the duration', () => {
  assert.equal(audioMarker(rec(4.9)), '[audio 4.9 s]');
  assert.equal(audioMarker(rec(1)), '[audio 1 s]');
});

test('stripAudio removes payloads but leaves the marker and history intact', () => {
  const hist = [
    { role: 'user', content: '[audio 1 s] hi', audio: rec(1, 16000) },
    { role: 'assistant', content: 'yo' },
  ];
  const stripped = stripAudio(hist);
  assert.ok(!('audio' in stripped[0]));
  assert.equal(stripped[0].content, '[audio 1 s] hi');
  assert.deepEqual(stripped[1], hist[1]);
  assert.ok('audio' in hist[0]); // the in-memory history keeps the samples until the turn ends
});

function setup() {
  const saved = [];
  let generateArgs = null;
  const client = {
    ready: true, stop() {},
    count: async () => 100,
    generate: async (messages) => (generateArgs = messages, 'Heard you.'),
  };
  const store = { save: async (value) => saved.push(structuredClone(value)) };
  const session = new AgentSession({ client, store, webSearch: async () => ({ results: [] }), httpGet: async () => ({}), runJavaScript: async () => ({ result: 1 }), emit: () => {} });
  return { session, saved, getArgs: () => generateArgs };
}

test('the worker message for an audio turn carries the audio part with the samples, then the marker text', async () => {
  const { session, getArgs } = setup();
  const audio = rec(1, 16000);
  await session.send('what did I say?', null, audio);
  const messages = getArgs();
  assert.equal(messages[0].role, 'system');
  const user = messages.findLast((m) => m.role === 'user');
  assert.equal(user.content[0].type, 'audio');
  assert.equal(user.content[0].audio.sampleRate, 16000);
  assert.equal(user.content[0].audio.samples.length, 16000);
  assert.equal(user.content[1].type, 'text');
  assert.ok(user.content[1].text.includes('[audio 1 s]'));
  assert.ok(user.content[1].text.endsWith('what did I say?'));
  // After the turn the audio payload is dropped from the stored history: the marker text stays,
  // and the next prompt no longer re-sends the samples.
  const inMemory = session.history.find((m) => m.role === 'user');
  assert.equal(inMemory.audio, undefined, 'no audio payload after the turn');
  assert.ok(inMemory.content.includes('[audio 1 s]'), 'the marker text stays');
  const reprompted = session.prompt().findLast((m) => m.role === 'user');
  assert.equal(typeof reprompted.content, 'string', 'the next prompt has no audio part');
});

test('an audio turn next to an image carries the audio part first, then the image part, then the text', async () => {
  const { session, getArgs } = setup();
  await session.send('describe both', { name: 'a.png', width: 4, height: 4, data: new Uint8Array(64) }, rec(0.5, 8000));
  const user = getArgs().findLast((m) => m.role === 'user');
  assert.equal(user.content[0].type, 'audio');
  assert.equal(user.content[1].type, 'image');
  assert.equal(user.content[1].image.width, 4);
  assert.equal(user.content[2].type, 'text');
  assert.ok(user.content[2].text.includes('[audio 0.5 s] [image: a.png, 4×4]'));
  assert.ok(user.content[2].text.endsWith('describe both'));
});

test('audio with no typed text sends; empty without audio still fails; the 8,000 cap still applies with audio', async () => {
  const { session } = setup();
  await session.send('', null, rec(1, 16000));
  assert.equal(session.history.findLast((m) => m.role === 'user').content, '[audio 1 s]');
  await assert.rejects(session.send('', null, null), /between 1 and 8,000/);
  await assert.rejects(session.send('x'.repeat(8001), null, rec(1, 16000)), /between 1 and 8,000/);
});

test('the stored snapshot after an audio turn has no payload, only the marker', async () => {
  const { session, saved } = setup();
  await session.send('hi there', null, rec(2, 32000));
  const user = saved.at(-1).history.find((m) => m.role === 'user');
  assert.ok(!('audio' in user), 'no audio payload in the saved record');
  assert.equal(user.content, '[audio 2 s] hi there');
  // Export (same snapshot path) is also payload-free.
  assert.ok(!('audio' in session.snapshot().history.find((m) => m.role === 'user')));
});

test('only the Gemma 4 model carries audio metadata; LFM3 and Qwen do not', () => {
  assert.equal(MODELS['gemma4-e2b'].audio.size, '~171 MB');
  assert.equal(MODELS['lfm3-1.7b'].audio, undefined);
  assert.equal(MODELS['qwen3.5-0.8b'].audio, undefined);
});
