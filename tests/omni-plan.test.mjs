// Unit tests for the LFM3-Omni decode-plan helpers (src/apps/ai-agent/omni/plan.js): prefill
// chunking, the initial cache plan from the pinned config.json, encoder token counts, and the
// <|audio|> placeholder expansion. Run: node --test tests/omni-plan.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prefillChunks, initialCaches, audioTokenCount, expandAudioTokens } from '../src/apps/ai-agent/omni/plan.js';

// text_config of the pinned ONNX export's config.json (LiquidAI/LFM3-Omni-2B-ONNX @ d2e656f0,
// keys the plan reads): 24 layers, conv/attention pattern, hidden 2048, conv_L_cache 7,
// 4 KV heads, head_dim 128.
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
const CONV_LAYERS = [0, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23];
const ATTENTION_LAYERS = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22];

test('prefillChunks: at most max per chunk, summing to the length', () => {
  assert.deepEqual(prefillChunks(0), []);
  assert.deepEqual(prefillChunks(1024), [1024]);
  assert.deepEqual(prefillChunks(1025), [1024, 1]);
  assert.deepEqual(prefillChunks(3000), [1024, 1024, 952]);
  assert.deepEqual(prefillChunks(4096, 256), Array(16).fill(256));
  assert.deepEqual(prefillChunks(5, 1024), [5]);
  for (const length of [1, 1023, 1024, 1025, 8191, 131072]) {
    const chunks = prefillChunks(length);
    assert.equal(chunks.reduce((a, b) => a + b, 0), length);
    assert.ok(chunks.every((c) => c <= 1024));
  }
  assert.throws(() => prefillChunks(10, 0), RangeError);
  assert.throws(() => prefillChunks(10, 1.5), RangeError);
});

test('initialCaches: 13 conv caches and 22 KV caches, the right shapes and dtypes', () => {
  const q4f16 = initialCaches(TEXT_CONFIG, 'q4f16');
  assert.equal(q4f16.length, 35, '13 conv + 11 attention layers * 2');
  const conv = q4f16.filter((c) => c.name.startsWith('past_conv.'));
  assert.deepEqual(conv.map((c) => c.name), CONV_LAYERS.map((i) => `past_conv.${i}`));
  for (const c of conv) {
    assert.deepEqual(c.shape, [1, 2048, 7]);
    assert.equal(c.dtype, 'float16', 'the q4f16 decoder keeps its caches in fp16');
  }
  const kv = q4f16.filter((c) => c.name.startsWith('past_key_values.'));
  assert.deepEqual(
    kv.map((c) => c.name),
    ATTENTION_LAYERS.flatMap((i) => [`past_key_values.${i}.key`, `past_key_values.${i}.value`]),
  );
  for (const c of kv) {
    assert.deepEqual(c.shape, [1, 4, 0, 128], 'batch 1, 4 KV heads, empty sequence, head_dim 128');
    assert.equal(c.dtype, 'float16');
  }
  const q4 = initialCaches(TEXT_CONFIG, 'q4');
  assert.ok(q4.every((c) => c.dtype === 'float32'), 'the q4 decoder caches are fp32');
  assert.deepEqual(q4.map((c) => c.name), q4f16.map((c) => c.name));
});

test('audioTokenCount: ceil(frames / encoder_stride), as num_encoder_tokens', () => {
  assert.equal(audioTokenCount(0), 0);
  assert.equal(audioTokenCount(8), 1);
  assert.equal(audioTokenCount(9), 2);
  assert.equal(audioTokenCount(16), 2);
  assert.equal(audioTokenCount(17), 3);
  assert.equal(audioTokenCount(99), 13, '1 s of audio: 99 mel frames -> 13 encoder tokens');
  assert.equal(audioTokenCount(2999), 375, '30 s of audio: 2999 frames -> 375 tokens');
  assert.equal(audioTokenCount(7, { encoder_stride: 4 }), 2);
  assert.throws(() => audioTokenCount(-1), RangeError);
  assert.throws(() => audioTokenCount(1.5), RangeError);
});

test('expandAudioTokens: each <|audio|> becomes its clip count, in prompt order', () => {
  const AUDIO = 125031;
  assert.deepEqual(expandAudioTokens([1, 2, 3], AUDIO, []), [1, 2, 3], 'no placeholders: unchanged');
  assert.deepEqual(expandAudioTokens([1, AUDIO, 2], AUDIO, [5]), [1, AUDIO, AUDIO, AUDIO, AUDIO, AUDIO, 2]);
  const two = expandAudioTokens([1, AUDIO, 2, AUDIO, 3], AUDIO, [2, 3]);
  assert.equal(two.length, 8, '3 passthrough tokens + 2 + 3 expanded');
  assert.deepEqual(two.slice(0, 5), [1, AUDIO, AUDIO, 2, AUDIO]);
  assert.throws(() => expandAudioTokens([1, AUDIO, AUDIO, 2], AUDIO, [1]), RangeError, 'more placeholders than clips');
  assert.throws(() => expandAudioTokens([1, AUDIO, 2], AUDIO, [2, 3]), RangeError, 'more clips than placeholders');
});
