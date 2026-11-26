// LFM3-Omni decode runtime (M3): text and audio in, text out, over an injected ONNX Runtime.
// Pure module, no DOM, no imports of ort: the caller passes the ort namespace (in the browser
// the onnxruntime-web/webgpu build) and two sessions with inputNames, outputNames and
// run(feeds) -> name-to-tensor outputs (ort.InferenceSession or a fake for unit tests).
//
// Sources (full citations in .lanes/scratch/models/omni-port-note.md):
//   - feeds: lfm3/session.py CachedDecoder.step (input_ids / attention_mask ones / position_ids
//     arange, all past_* caches every step, logits_to_keep [1]), side_inputs (zero-row feature
//     and code inputs), update_cache (present.* -> past_* per step);
//   - audio rows: lfm3_audio/session.py prompt_ids (each <|audio|> expanded in place, features
//     stacked in clip order) and the decoder's scattering of audio_features over the
//     <|audio|> placeholders (ONNX README:141);
//   - cache plan and chunk sizes: omni/plan.js (initialCaches, prefillChunks, presentToPast,
//     audioTokenCount);
//   - the encoder input [1, 128, T] float32 -> audio_features [N, 2048] float32
//     (lfm3_audio/encoder.py:6-7,19-20).

import { audioTokenCount, initialCaches, prefillChunks, presentToPast, sideInputShape } from './plan.js';

// { encodeAudio(mel), generate({ ids, audio, maxNewTokens, stopIds, suppressIds, onToken, signal }), dispose() }
// of one LFM3-Omni export. precision picks the decoder cache dtype (fp16 for fp16 / q4f16 /
// q8f16, else fp32, ONNX README:141); the browser pairs decoder_q4f16, the default.
/** IEEE 754 half-precision bits -> number. */
export function halfToFloat(h) {
  const sign = h & 0x8000 ? -1 : 1;
  const exponent = (h >> 10) & 0x1f;
  const fraction = h & 0x3ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

export function createOmniRuntime({ ort, config, sessions, precision = 'q4f16' }) {
  const decoder = sessions.decoder;
  const audioEncoder = sessions.audioEncoder;
  const decoderInputNames = decoder.inputNames;
  const hidden = config.text_config.hidden_size; // audio_features width (2048)
  const audioTokenId = config.audio_token_id; // <|audio|>, 125031
  const numCodebooks = config.num_codebooks; // 12

  const tensor = (type, data, dims) => new ort.Tensor(type, data, dims);
  const zeros = (dtype, shape) => {
    const n = shape.reduce((a, b) => a * b, 1);
    return dtype === 'float16' ? new ArrayBuffer(n * 2) : dtype === 'int64' ? new BigInt64Array(n) : new Float32Array(n);
  };

  // name -> ort tensor of the decoder caches: zeroed initialCaches, replaced by each step's
  // present_* outputs (lfm3/session.py update_cache).
  const cache = new Map(
    initialCaches(config.text_config, precision).map((c) => [c.name, tensor(c.dtype, zeros(c.dtype, c.shape), c.shape)]),
  );
  let disposed = false;

  // One decoder feed, built only from decoderInputNames (never a hard-coded list): the base
  // feeds as CachedDecoder.step binds them (chunkIds is this run's ids, past the tokens so
  // far), every past_* input from the cache map, the reference's zero-row side inputs when
  // the graph has them, and this chunk's audio rows.
  function feedsFor(chunkIds, past, audioSlice) {
    const feeds = {};
    const len = chunkIds.length;
    for (const name of decoderInputNames) {
      if (name === 'input_ids') {
        feeds[name] = tensor('int64', BigInt64Array.from(chunkIds, BigInt), [1, len]);
      } else if (name === 'attention_mask') {
        feeds[name] = tensor('int64', new BigInt64Array(past + len).fill(1n), [1, past + len]);
      } else if (name === 'position_ids') {
        const a = new BigInt64Array(len);
        for (let i = 0; i < len; i++) a[i] = BigInt(past + i);
        feeds[name] = tensor('int64', a, [1, len]);
      } else if (name === 'logits_to_keep') {
        feeds[name] = tensor('int64', new BigInt64Array([1n]), [1]);
      } else if (name === 'audio_features') {
        feeds[name] = tensor('float32', audioSlice, [audioSlice.length / hidden, hidden]);
      } else {
        const side = sideInputShape(name, config.text_config, numCodebooks);
        if (side) {
          feeds[name] = tensor(side.dtype, zeros(side.dtype, side.shape), side.shape);
        } else if (name.startsWith('past_')) {
          const t = cache.get(name);
          if (!t) throw new Error(`decoder input ${name} has no cache in the plan`);
          feeds[name] = t;
        } else {
          throw new Error(`decoder input ${name} is not supported by the text+audio runtime`);
        }
      }
    }
    return feeds;
  }

  // Replace each cache input with this step's present_* output (only names the plan has).
  function absorbOutputs(outputs) {
    for (const name of decoder.outputNames) {
      const past = presentToPast(name);
      if (past && cache.has(past)) cache.set(past, outputs[name]);
    }
  }

  // The audio rows this prefill chunk carries: the stacked rows of the <|audio|> positions
  // inside it (a run split across chunks gives each chunk its part; chunks with no
  // placeholders carry zero rows, as side_inputs does for absent features).
  function audioSliceFor(rowsAt, start, len, stacked) {
    let first = -1;
    let last = -1;
    for (let i = start; i < start + len; i++) {
      const r = rowsAt[i];
      if (r >= 0) {
        if (first < 0) first = r;
        last = r;
      }
    }
    return first < 0 ? new Float32Array(0) : stacked.subarray(first * hidden, (last + 1) * hidden);
  }

  // Greedy pick over the last row of logits, skipping suppressed ids (session.py:259-261 sets
  // them to -inf). onnxruntime-web hands float16 tensors back as raw Uint16Array bits, which
  // do not order like the numbers they encode (negative values sort backwards), so they are
  // decoded first.
  function argmaxLastRow(logits, suppress) {
    if (!logits) throw new Error('the decoder returned no logits output');
    const dims = logits.dims;
    const vocab = dims[dims.length - 1];
    const data = logits.data;
    const read = data instanceof Uint16Array ? (k) => halfToFloat(data[k]) : (k) => data[k];
    const rows = dims.slice(0, -1).reduce((a, b) => a * b, 1);
    const start = (rows - 1) * vocab;
    let best = -1;
    let bestValue = -Infinity;
    for (let k = start; k < start + vocab; k++) {
      if (suppress.has(k - start)) continue;
      const value = read(k);
      if (value > bestValue) {
        bestValue = value;
        best = k - start;
      }
    }
    return best;
  }

  // { features: Float32Array [tokens * 2048], tokens }: one logMelFeatures() result through
  // the audio encoder graph. The row count must equal the placeholder count
  // (audioTokenCount, ceil(frames / 8)), as the processor's num_audio_tokens does.
  async function encodeAudio(mel) {
    if (disposed) throw new Error('the runtime is disposed');
    const inName = audioEncoder.inputNames.includes('input_features')
      ? 'input_features'
      : audioEncoder.inputNames[0];
    const outName = audioEncoder.outputNames.includes('audio_features')
      ? 'audio_features'
      : audioEncoder.outputNames[0];
    const feeds = { [inName]: tensor('float32', mel.features, [1, mel.bins, mel.frames]) };
    const outputs = await audioEncoder.run(feeds);
    const out = outputs[outName];
    const tokens = out.dims[0];
    const expected = audioTokenCount(mel.frames);
    if (tokens !== expected) {
      throw new RangeError(`the encoder gave ${tokens} rows for ${mel.frames} mel frames, expected ${expected}`);
    }
    const features = out.data instanceof Float32Array ? out.data : new Float32Array(out.data);
    if (features.length !== tokens * hidden) {
      throw new RangeError(`the encoder gave ${features.length} values, expected ${tokens * hidden}`);
    }
    return { features, tokens };
  }

  // Greedy text decode: prefill the prompt (already <|audio|>-expanded) in at-most-1024-token
  // chunks, then one token per step until a stop id, maxNewTokens (truncated: true) or an
  // aborted signal. audio: the encodeAudio() result per clip, in placeholder order.
  async function generate({
    ids,
    audio = [],
    maxNewTokens = 1024,
    stopIds = [],
    suppressIds = [],
    onToken = () => {},
    signal = undefined,
  } = {}) {
    if (disposed) throw new Error('the runtime is disposed');
    const promptIds = Array.isArray(ids) ? ids : Array.from(ids);
    const rowsAt = new Int32Array(promptIds.length).fill(-1);
    let row = 0;
    for (let i = 0; i < promptIds.length; i++) {
      if (promptIds[i] === audioTokenId) rowsAt[i] = row++;
    }
    const stacked = new Float32Array(row * hidden);
    let at = 0;
    for (const clip of audio) {
      for (const v of clip.features) stacked[at++] = v;
    }
    if (row !== at / hidden) {
      throw new RangeError(`the prompt has ${row} audio placeholder(s) but the clips give ${at / hidden} feature row(s)`);
    }

    if (signal && signal.aborted) return { ids: [], truncated: false };
    const suppress = new Set(suppressIds);

    // Prefill in at-most-1024-token chunks; the last chunk's logits start the decode (the
    // reference prefills once and samples from those logits).
    let past = 0;
    let logits;
    for (const len of prefillChunks(promptIds.length)) {
      const outputs = await decoder.run(
        feedsFor(promptIds.slice(past, past + len), past, audioSliceFor(rowsAt, past, len, stacked)),
      );
      absorbOutputs(outputs);
      past += len;
      logits = outputs.logits;
      if (signal && signal.aborted) break;
    }
    if (!logits) throw new RangeError('generate needs at least one prompt id');

    // One token per slot: sample from the previous run's logits, then feed that token back
    // (audio_session.py generate_ids: the last slot needs no further step).
    const EMPTY = new Float32Array(0);
    const out = [];
    let stopped = false;
    for (let step = 0; step < maxNewTokens; step++) {
      if (signal && signal.aborted) break;
      const token = argmaxLastRow(logits, suppress);
      out.push(token);
      onToken(token);
      if (stopIds.includes(token)) {
        stopped = true;
        break;
      }
      if (step === maxNewTokens - 1) break;
      const next = await decoder.run(feedsFor([token], past, EMPTY));
      absorbOutputs(next);
      past += 1;
      logits = next.logits;
    }
    return { ids: out, truncated: !stopped && !signal?.aborted && out.length === maxNewTokens };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    cache.clear();
  }

  return { encodeAudio, generate, dispose };
}
