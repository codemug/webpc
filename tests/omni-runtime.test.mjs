// Unit tests for the LFM3-Omni decode runtime (src/apps/ai-agent/omni/runtime.js) with a fake
// ort and fake decoder/encoder sessions: cache feeds from inputNames, chunked prefill, audio
// rows only on the chunks that hold the placeholders, greedy/stop/cap/abort, dispose.
// Run: node --test tests/omni-runtime.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOmniRuntime, halfToFloat } from '../src/apps/ai-agent/omni/runtime.js';
import { initialCaches, audioTokenCount } from '../src/apps/ai-agent/omni/plan.js';
import { logMelFeatures } from '../src/apps/ai-agent/omni/mel.js';

// The pinned ONNX export's text_config (config.json:133-174) and the token keys the runtime
// reads (config.json:80 audio_token_id, :128 num_codebooks).
const TEXT_CONFIG = {
  layer_types: [
    'conv', 'conv', 'full_attention', 'conv', 'sliding_attention', 'conv', 'full_attention',
    'conv', 'sliding_attention', 'conv', 'full_attention', 'conv', 'sliding_attention',
    'conv', 'full_attention', 'conv', 'sliding_attention', 'conv', 'full_attention',
    'conv', 'sliding_attention', 'conv', 'full_attention', 'conv',
  ],
  hidden_size: 2048,
  conv_L_cache: 7,
  num_key_value_heads: 4,
  head_dim: 128,
};
const CONFIG = { audio_token_id: 125031, num_codebooks: 12, text_config: TEXT_CONFIG };
const AUDIO = 125031;
const VOCAB = 64;

class FakeTensor {
  constructor(type, data, dims) {
    this.type = type;
    this.data = data;
    this.dims = dims;
  }
}
const fakeOrt = { Tensor: FakeTensor };

const presentOf = (name) =>
  name.startsWith('past_conv.') ? name.replace('past_conv.', 'present_conv.', 1) : name.replace('past_key_values.', 'present.', 1);

// A fake decoder session: the graph's full input list (base feeds, the audio and the unused
// side inputs, every initialCaches entry), logits whose last-row argmax is scripted per run,
// and fresh present_* tensors per step (KV sequence axis = past + n, as a real step gives).
function makeDecoder({ precision = 'q4f16', scripted = [10, 20, 30, 40, 50], onRun = () => {} } = {}) {
  const plan = initialCaches(TEXT_CONFIG, precision);
  const inputNames = [
    'input_ids', 'attention_mask', 'position_ids', 'logits_to_keep',
    'audio_features', 'image_features', 'video_features', 'audio_out_codes',
    ...plan.map((c) => c.name),
  ];
  const presentNames = plan.map((c) => presentOf(c.name));
  const outputNames = ['logits', 'hidden_states', ...presentNames];
  const steps = [];
  let i = 0;
  async function run(feeds) {
    onRun(i);
    const rec = { feeds };
    steps.push(rec);
    const past = Number(feeds.position_ids.data[0]);
    const n = feeds.position_ids.dims[1];
    const data = new Float32Array(n * VOCAB).fill(-1);
    data[(n - 1) * VOCAB + scripted[i % scripted.length]] = 1;
    const outs = {
      logits: new FakeTensor('float32', data, [1, n, VOCAB]),
      hidden_states: new FakeTensor('float32', new Float32Array(n * 2048), [1, n, 2048]),
    };
    for (const p of presentNames) {
      const shape = p.startsWith('present_conv.') ? [1, 2048, 7] : [1, 4, past + n, 128];
      outs[p] = new FakeTensor('float16', new ArrayBuffer(shape.reduce((a, b) => a * b, 1) * 2), shape);
    }
    rec.outputs = outs;
    i++;
    return outs;
  }
  return { inputNames, outputNames, run, steps };
}

function makeEncoder({ rows = 4 } = {}) {
  const calls = [];
  async function run(feeds) {
    calls.push(feeds);
    return { audio_features: new FakeTensor('float32', new Float32Array(rows * 2048).fill(0.25), [rows, 2048]) };
  }
  return { inputNames: ['input_features'], outputNames: ['audio_features'], run, calls };
}

function makeRuntime({ precision = 'q4f16', scripted, onRun, encoderRows } = {}) {
  const decoder = makeDecoder({ precision, scripted, onRun });
  const audioEncoder = makeEncoder({ rows: encoderRows });
  const runtime = createOmniRuntime({ ort: fakeOrt, config: CONFIG, sessions: { decoder, audioEncoder }, precision });
  return { runtime, decoder, audioEncoder };
}

const plainPrompt = (n, value = 7) => Array(n).fill(value);

test('every past_* input of the graph is fed from the cache plan, and the previous present_* becomes the next past_*', async () => {
  const { runtime, decoder } = makeRuntime({ precision: 'q4f16' });
  const plan = initialCaches(TEXT_CONFIG, 'q4f16');
  const { ids, truncated } = await runtime.generate({ ids: [1, 2, 3], maxNewTokens: 2 });
  assert.deepEqual(ids, [10, 20]);
  assert.equal(truncated, true, '2 out of the 2 requested tokens');
  assert.equal(decoder.steps.length, 2, 'one prefill + one decode step (the last slot needs no step)');
  const feeds = decoder.steps[0].feeds;
  assert.equal(Object.keys(feeds).length, decoder.inputNames.length, 'feeds are built from inputNames, nothing extra');
  for (const c of plan) {
    assert.ok(feeds[c.name], `feeds carry ${c.name}`);
    assert.equal(feeds[c.name].type, c.dtype, `${c.name} has the plan dtype`);
    assert.deepEqual(feeds[c.name].dims, c.shape, `${c.name} has the plan shape`);
  }
  assert.deepEqual(Array.from(feeds.input_ids.data), [1n, 2n, 3n]);
  assert.equal(feeds.input_ids.type, 'int64');
  assert.deepEqual(feeds.attention_mask.dims, [1, 3]);
  assert.ok(Array.from(feeds.attention_mask.data).every((v) => v === 1n));
  assert.deepEqual(Array.from(feeds.position_ids.data), [0n, 1n, 2n]);
  assert.deepEqual(Array.from(feeds.logits_to_keep.data), [1n]);
  assert.deepEqual(feeds.audio_features.dims, [0, 2048], 'no audio: zero rows, as side_inputs');
  assert.deepEqual(feeds.image_features.dims, [0, 2048]);
  assert.deepEqual(feeds.audio_out_codes.dims, [0, 12]);
  // the decode step feeds exactly the tensors the prefill returned as present_*
  for (const c of plan) {
    assert.equal(decoder.steps[1].feeds[c.name], decoder.steps[0].outputs[presentOf(c.name)], `${c.name} is the previous present_*`);
  }
  assert.deepEqual(Array.from(decoder.steps[1].feeds.input_ids.data), [10n], 'the sampled token is fed back');
});

test('a 2500-token prompt prefills in 1024, 1024, 452 and positions and mask grow', async () => {
  const { runtime, decoder } = makeRuntime();
  const { truncated } = await runtime.generate({ ids: plainPrompt(2500), maxNewTokens: 2 });
  assert.equal(truncated, true);
  assert.equal(decoder.steps.length, 4, '3 prefill chunks + 1 decode step');
  const [c1, c2, c3, d1] = decoder.steps.map((s) => s.feeds);
  assert.deepEqual(c1.position_ids.dims, [1, 1024]);
  assert.deepEqual(c2.position_ids.dims, [1, 1024]);
  assert.deepEqual(c3.position_ids.dims, [1, 452]);
  assert.deepEqual(d1.position_ids.dims, [1, 1]);
  assert.equal(c1.position_ids.data[0], 0n);
  assert.equal(c2.position_ids.data[0], 1024n);
  assert.equal(c3.position_ids.data[0], 2048n);
  assert.equal(d1.position_ids.data[0], 2500n);
  assert.deepEqual(c1.attention_mask.dims, [1, 1024]);
  assert.deepEqual(c2.attention_mask.dims, [1, 2048]);
  assert.deepEqual(c3.attention_mask.dims, [1, 2500]);
  assert.deepEqual(d1.attention_mask.dims, [1, 2501]);
  assert.equal(c3.input_ids.dims[1], 452);
  assert.ok(Array.from(c3.position_ids.data).every((v, k) => v === 2048n + BigInt(k)));
});

test('encodeAudio runs the encoder with the mel output and checks the row count', async () => {
  const { runtime, audioEncoder } = makeRuntime({ encoderRows: 4 });
  const x = new Float32Array(4800);
  for (let i = 0; i < 4800; i++) x[i] = 0.6 * Math.cos((2 * Math.PI * 320 * i) / 16000) + 0.4 * Math.sin((2 * Math.PI * 2400 * i) / 16000);
  const mel = logMelFeatures(x);
  assert.equal(mel.frames, 29);
  const { features, tokens } = await runtime.encodeAudio(mel);
  assert.equal(tokens, 4, 'ceil(29 / 8)');
  assert.equal(tokens, audioTokenCount(29));
  assert.equal(features.length, 4 * 2048);
  assert.deepEqual(audioEncoder.calls[0].input_features.dims, [1, 128, 29], 'input_features [1, 128, T]');
  assert.equal(audioEncoder.calls[0].input_features.type, 'float32');
  assert.equal(audioEncoder.calls[0].input_features.data, mel.features, 'the mel features, not a copy');
  const bad = makeRuntime({ encoderRows: 5 });
  await assert.rejects(bad.runtime.encodeAudio(mel), RangeError, '5 rows for 29 frames is not ceil(29/8)');
});

test('audio features reach the decoder on the chunk that holds the placeholders, nowhere else', async () => {
  // 2000 plain + 13 audio (one 1 s clip) + 487 plain: the run sits inside chunk 2
  const { runtime, decoder } = makeRuntime();
  const clip = { features: new Float32Array(13 * 2048).fill(0.3), tokens: 13 };
  const prompt = [...plainPrompt(2000), ...Array(13).fill(AUDIO), ...plainPrompt(487)];
  assert.equal(prompt.length, 2500);
  await runtime.generate({ ids: prompt, audio: [clip], maxNewTokens: 1 });
  const audioDims = decoder.steps.map((s) => s.feeds.audio_features.dims);
  assert.deepEqual(audioDims, [[0, 2048], [13, 2048], [0, 2048]], 'only chunk 2 carries the 13 rows');
  assert.equal(decoder.steps[1].feeds.audio_features.data[0], clip.features[0], 'the clip rows, exact float32 values');
  assert.ok(decoder.steps[1].feeds.audio_features.data.every((v) => v === clip.features[0]));
  // the same run split across the chunk 2 / chunk 3 boundary: rows 0-7 and 8-12
  const split = makeRuntime();
  const prompt2 = [...plainPrompt(2040), ...Array(13).fill(AUDIO), ...plainPrompt(447)];
  await split.runtime.generate({ ids: prompt2, audio: [clip], maxNewTokens: 1 });
  const splitDims = split.decoder.steps.map((s) => s.feeds.audio_features.dims);
  assert.deepEqual(splitDims, [[0, 2048], [8, 2048], [5, 2048]], 'the split run gives each chunk its part');
  assert.equal(split.decoder.steps[1].feeds.audio_features.data[0], clip.features[0]);
  assert.equal(split.decoder.steps[2].feeds.audio_features.data[0], clip.features[0]);
  // placeholder/row mismatches throw, as the reference's check_inputs does
  const mismatch = makeRuntime();
  await assert.rejects(
    mismatch.runtime.generate({ ids: [1, AUDIO, 2], maxNewTokens: 1 }),
    RangeError,
    'a placeholder with no clip rows',
  );
});

test('greedy takes the arg-max; stop ids end it; maxNewTokens truncates; an aborted signal ends at once', async () => {
  const seen = [];
  const { runtime } = makeRuntime({ scripted: [10, 20, 30, 40, 50] });
  const r1 = await runtime.generate({ ids: [5], maxNewTokens: 3, onToken: (id) => seen.push(id) });
  assert.deepEqual(r1.ids, [10, 20, 30], 'the scripted arg-max of each step last row');
  assert.equal(r1.truncated, true, '3 of the 3 requested tokens');
  assert.deepEqual(seen, [10, 20, 30], 'onToken per new token, in order');

  const r2 = await makeRuntime({ scripted: [10, 20, 30, 40, 50] }).runtime.generate({ ids: [5], maxNewTokens: 8, stopIds: [20] });
  assert.deepEqual(r2.ids, [10, 20], 'the stop id is included and ends the turn');
  assert.equal(r2.truncated, false);

  const abortedBefore = new AbortController();
  abortedBefore.abort();
  const early = makeRuntime();
  const r3 = await early.runtime.generate({ ids: [5], maxNewTokens: 4, signal: abortedBefore.signal });
  assert.deepEqual(r3.ids, [], 'an already-aborted signal generates nothing');
  assert.equal(r3.truncated, false);
  assert.equal(early.decoder.steps.length, 0);

  const mid = new AbortController();
  const midRun = makeRuntime({ onRun: (i) => { if (i === 3) mid.abort(); } });
  const r4 = await midRun.runtime.generate({ ids: [5], maxNewTokens: 6, signal: mid.signal });
  assert.deepEqual(r4.ids, [10, 20, 30], 'aborted after the 3rd sampled token');
  assert.equal(r4.truncated, false, 'stopped by the signal, not the cap');
  assert.equal(midRun.decoder.steps.length, 4, 'prefill + 3 steps, no 4th');

  await assert.rejects(makeRuntime().runtime.generate({ ids: [], maxNewTokens: 1 }), RangeError, 'an empty prompt cannot start');
});

test('dispose releases the caches', async () => {
  const { runtime } = makeRuntime();
  runtime.dispose();
  await assert.rejects(runtime.generate({ ids: [5], maxNewTokens: 1 }), /disposed/);
  await assert.rejects(runtime.encodeAudio({ features: new Float32Array(0), frames: 1, bins: 128, mask: new Uint8Array(1) }), /disposed/);
});

test('halfToFloat decodes IEEE half bits', () => {
  assert.equal(halfToFloat(0x3c00), 1);
  assert.equal(halfToFloat(0xc000), -2);
  assert.equal(halfToFloat(0x7bff), 65504);
  assert.equal(halfToFloat(0x0001), 2 ** -24);
  assert.equal(halfToFloat(0x7c00), Infinity);
  assert.ok(Number.isNaN(halfToFloat(0x7e00)));
});

test('a suppressed id is never picked, even when it has the top logit', async () => {
  const { runtime } = makeRuntime({ scripted: [9, 9, 9] });
  const { ids } = await runtime.generate({ ids: [1, 2], maxNewTokens: 3, suppressIds: [9] });
  assert.equal(ids.length, 3);
  assert.ok(!ids.includes(9), `got ${ids}`);
});

test('float16 logits (Uint16Array bits) are compared as numbers, not as raw bits', async () => {
  const decoder = makeDecoder();
  const run = decoder.run;
  decoder.run = async (feeds) => {
    const outs = await run(feeds);
    const n = outs.logits.dims[1];
    const data = new Uint16Array(n * VOCAB).fill(0xbc00); // -1.0
    data[(n - 1) * VOCAB + 2] = 0x3c00; // 1.0: the real maximum
    data[(n - 1) * VOCAB + 5] = 0xc000; // -2.0: the largest raw bit pattern
    outs.logits = new FakeTensor('float16', data, [1, n, VOCAB]);
    return outs;
  };
  const runtime = createOmniRuntime({ ort: fakeOrt, config: CONFIG, sessions: { decoder, audioEncoder: makeEncoder() } });
  const { ids } = await runtime.generate({ ids: [1, 2], maxNewTokens: 1 });
  assert.deepEqual(ids, [2]);
});
