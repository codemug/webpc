// Decode-plan helpers for LFM3-Omni (M3 prep): pure, no ORT, no DOM.
//
// Sources (full citations in .lanes/scratch/models/omni-port-note.md):
//   - LiquidAI/LFM3-Omni-2B-ONNX @ d2e656f0: config.json (text_config, token ids), README
//     ("Use with ONNX Runtime": cache dtypes per precision, the browser note in 4.6).
//   - Liquid4All/onnx-export @ 26857c2e: README 4.6 (1024-token prefill chunks, the WebGPU
//     session options), lfm3/session.py (CachedDecoder's feeds, initialize_cache's shapes),
//     lfm3_audio/session.py (prompt_ids' in-place <|audio|> expansion, the token suppressions).

// Prefill in chunks of at most `max` tokens (README 4.6: past the 256-token sliding window the
// sliding layers materialize [B, 16, S, T] probabilities and a single long run overflows; 1024
// chunks reach the 128,000-token context). Returns the chunk sizes, summing to `length`.
export function prefillChunks(length, max = 1024) {
  if (length <= 0) return [];
  if (!Number.isInteger(max) || max < 1) throw new RangeError(`max chunk must be an integer >= 1, got ${max}`);
  const out = [];
  for (let left = length; left > 0; left -= max) out.push(Math.min(max, left));
  return out;
}

// The decoder graph's initial caches, planned from config.json's text_config and the precision:
// one past_conv.{layer} [1, hidden_size, conv_L_cache] per conv layer, and
// past_key_values.{layer}.{key,value} [1, num_key_value_heads, 0, head_dim] per attention layer
// (the sequence axis starts empty, as initialize_cache zeros it). The fp16, q4f16 and q8f16
// decoders keep their caches in fp16 (ONNX README), the others in fp32. The runtime must still
// verify names, dtypes and shapes against the loaded graph's inputs: this is the plan.
const FP16_CACHES = new Set(['fp16', 'q4f16', 'q8f16']);
export function initialCaches(textConfig, precision) {
  const dtype = FP16_CACHES.has(precision) ? 'float16' : 'float32';
  const caches = [];
  textConfig.layer_types.forEach((type, layer) => {
    if (type === 'conv') {
      caches.push({ name: `past_conv.${layer}`, dtype, shape: [1, textConfig.hidden_size, textConfig.conv_L_cache] });
    } else {
      // full_attention and sliding_attention layers both carry a KV cache (the sliding window is
      // GroupQueryAttention's local_window_size, not a shorter cache)
      for (const part of ['key', 'value']) {
        caches.push({ name: `past_key_values.${layer}.${part}`, dtype, shape: [1, textConfig.num_key_value_heads, 0, textConfig.head_dim] });
      }
    }
  });
  return caches;
}

// Encoder tokens per mel frame: the encoder downsamples T frames to ceil(T / encoder_stride)
// (the encoder's three stride-2 convolutions, Lfm3OmniFeatureExtractor.num_encoder_tokens).
export function audioTokenCount(frames, cfg = { encoder_stride: 8 }) {
  if (!Number.isInteger(frames) || frames < 0) throw new RangeError(`frames must be an integer >= 0, got ${frames}`);
  return Math.ceil(frames / cfg.encoder_stride);
}

// The audio side of prompt_ids: replace each <|audio|> id with its clip's token count, in
// prompt order (LiquidONNX expands each placeholder to its clip's encoder tokens in place; the
// template's media markers are already in the text). Throws on a count mismatch, as the
// reference's check_inputs does for feature rows.
export function expandAudioTokens(ids, audioTokenId, counts) {
  let seen = 0;
  const out = [];
  for (const id of ids) {
    if (id !== audioTokenId) {
      out.push(id);
      continue;
    }
    if (seen >= counts.length) throw new RangeError(`prompt has more than ${counts.length} audio placeholder(s)`);
    for (let i = 0; i < counts[seen]; i++) out.push(audioTokenId);
    seen++;
  }
  if (seen !== counts.length) {
    throw new RangeError(`prompt has ${seen} audio placeholder(s), got ${counts.length} clip count(s)`);
  }
  return out;
}
