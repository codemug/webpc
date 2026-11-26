// LLM worker: loads one model at a time on WebGPU and streams generated text back.
import "./hf-pin.js"; // also installs the fetch pinning (must precede the bundle import)
import {
  AutoTokenizer, AutoModelForCausalLM, TextStreamer, InterruptableStoppingCriteria, Tensor, DynamicCache, ones, env,
  AutoProcessor, Qwen3_5ForConditionalGeneration, Gemma4ForConditionalGeneration, RawImage,
} from "./vendor/transformers.min.js";
import { gemmaToCanonical, gemmaVisible } from "./gemma-calls.js";

import { MODELS } from "./models.js";
// Local runtime files; the worker itself is created only by the explicit Load model action.
const vendorUrl = file => new URL(`./vendor/${file}`, import.meta.url).href;
env.allowLocalModels = false;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.wasmPaths = { mjs: vendorUrl("ort-wasm-simd-threaded.asyncify.mjs") };
async function loadWasm() {
  const parts = await Promise.all(["parta", "partb"].map(async part => {
    const res = await fetch(vendorUrl(`ort-wasm-simd-threaded.asyncify.wasm.${part}`));
    if (!res.ok) throw new Error(`Could not fetch local ONNX Runtime: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }));
  const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { joined.set(part, offset); offset += part.length; }
  env.backends.onnx.wasm.wasmBinary = joined.buffer;
}
// 2048: a full 26-app list needs about 500 tokens; most tool-call rounds stay far shorter, but a
// big single call (gridcraft set_cells with a whole table, sweep b17 gridcraft-01: the round cut
// at 1024 mid-call and the whole reply was unreadable tool syntax - "no visible answer") needs
// the extra room. Capped rounds still bound on the 240 s run timer and the 28-round limit.
const MAX_NEW_TOKENS = 2048;
// Long prompts are prefilled in chunks: one pass over the whole prompt makes an attention buffer of about
// prompt² × 32 bytes, and ONNX Runtime WebGPU overflows ("SafeIntOnOverflow") once that passes 4 GiB
// (~11.6k tokens on LFM3). A chunk's buffer is only chunk × context × 32 bytes, so the chunk shrinks as the
// context grows to stay under that limit.
const PREFILL_CHUNK = 2048;
const MAX_ATTENTION_CELLS = 64e6; // chunk × context; 64M × 32 bytes = 2 GiB, half the overflow point

let tokenizer = null;
let model = null;
// Qwen vision models only: the processor builds the chat template + pixel inputs; loaded with the vision model.
let processor = null;
// "gemma4" while Gemma 4 is loaded: it has its own generate path (generateGemma).
let family = null;
// The model state after the last generate(): the token ids it has seen and their cache. The next prompt
// usually starts with exactly those tokens (same chat plus a tool result), so only the new tail is prefilled.
// Qwen3.5 and LFM3 keep recurrent/conv state that cannot be rewound, so any other prompt starts over.
let cached = null;
const stopper = new InterruptableStoppingCriteria();

async function load(key, vision = false) {
  const spec = MODELS[key];
  if (!spec) throw new Error(`Unknown model "${key}"`);
  await loadWasm();
  await dropCache();
  if (model) await model.dispose(); // free GPU memory before the next download
  model = tokenizer = processor = family = null;

  const progress_callback = (p) => postMessage({ type: "progress", key, ...p });
  tokenizer = await AutoTokenizer.from_pretrained(spec.repo, { revision: spec.revision, progress_callback });
  // Gemma 4 is one multimodal model: the processor and all four q4f16 graphs (every file under
  // Chrome's 2^31-byte Response limit; the q8 embeddings have a 2.35 GB shard) load together.
  if (spec.family === "gemma4") {
    processor = await AutoProcessor.from_pretrained(spec.repo, { revision: spec.revision, progress_callback });
    model = await Gemma4ForConditionalGeneration.from_pretrained(spec.repo, {
      revision: spec.revision, dtype: spec.dtype, device: "webgpu", progress_callback,
    });
    family = "gemma4";
    postMessage({ type: "ready", key, vision: true });
    return;
  }
  // Image input (Qwen only): the vision-encoder submodel downloads only on this path, with the same
  // dtype as the rest; the text-only load above stays byte-identical to the pre-vision behaviour.
  const useVision = Boolean(vision && spec.vision);
  if (useVision) {
    processor = await AutoProcessor.from_pretrained(spec.repo, { revision: spec.revision, progress_callback });
    model = await Qwen3_5ForConditionalGeneration.from_pretrained(spec.repo, {
      revision: spec.revision, dtype: { ...spec.dtype, vision_encoder: "q4f16" }, device: "webgpu", progress_callback,
    });
  } else {
    model = await AutoModelForCausalLM.from_pretrained(spec.repo, {
      revision: spec.revision, dtype: spec.dtype, device: "webgpu", progress_callback,
    });
  }
  // LFM3's graph requires `logits_to_keep`, which Transformers.js 4.3 neither fills nor lets through:
  // generate() only keeps kwargs named in forward_params. Whitelist it; generate() below supplies it.
  if (needsLogitsToKeep()) model.forward_params = [...model.forward_params, "logits_to_keep"];
  postMessage({ type: "ready", key, vision: useVision });
}

const needsLogitsToKeep = () => Boolean(model?.sessions?.model?.inputNames.includes("logits_to_keep"));

const renderPrompt = (messages, tools) => tokenizer.apply_chat_template(messages, {
  tools, add_generation_prompt: true, enable_thinking: false, return_dict: true,
});

// Tokenizing only (no model run): milliseconds, used for the compaction budget.
async function count({ id, messages, tools }) {
  if (!tokenizer) throw new Error("No model loaded");
  const images = imagePayloads(messages);
  if (images.length) {
    // The template alone leaves one image placeholder; the processor expands it into the real grid tokens.
    if (!processor) throw new Error("Image input needs a vision model load (Image input on, Qwen model).");
    const text = processor.apply_chat_template(conversationOf(messages), { add_generation_prompt: true, enable_thinking: false });
    const inputs = await processor(text, images.length === 1 ? toRawImage(images[0]) : images.map(toRawImage));
    postMessage({ type: "counted", id, tokens: inputs.input_ids.dims[1] });
    return;
  }
  postMessage({ type: "counted", id, tokens: renderPrompt(messages, tools).input_ids.dims[1] });
}

async function dropCache() {
  const old = cached;
  cached = null;
  await old?.pkv.dispose();
}

// Inputs that make a forward pass compute logits for the last position only (the graphs name it differently).
function lastLogitOnly() {
  const names = (model.sessions.model ?? model.sessions.decoder_model_merged).inputNames;
  return {
    ...(names.includes("logits_to_keep") && { logits_to_keep: new Tensor("int64", [1n], [1]) }),
    ...(names.includes("num_logits_to_keep") && { num_logits_to_keep: new Tensor("int64", [1n], []) }),
  };
}

// With no tools offered (wrap-up and summary calls), small models still start a tool call or a think block from
// habit; banning the markers forces plain text.
const NO_TOOLS_BANNED = ["<tool_call>", "<think>"];
const bannedMarkers = () => NO_TOOLS_BANNED.map((t) => Array.from(tokenizer.encode(t, { add_special_tokens: false }), Number));

const pastName = (name) => name.replace(/^present_(ssm|conv|recurrent)/, "past_$1").replace(/^present/, "past_key_values");

/** Feed all but the last token of `ids` into the cache, reusing the previous turn's cache when it is a prefix. */
async function prefill(ids) {
  const reusable = cached && cached.ids.length < ids.length && cached.ids.every((t, i) => t === ids[i]);
  if (!reusable) await dropCache();
  let pkv = reusable ? cached.pkv : null;
  let done = reusable ? cached.ids.length : 0;
  cached = null; // the cache is mutated below; it is only valid again once generate() finishes
  const target = ids.length - 1; // generate() needs at least one new token to start from
  while (target - done > 0) {
    const chunk = Math.max(64, Math.min(PREFILL_CHUNK, Math.floor(MAX_ATTENTION_CELLS / target)));
    if (target - done <= chunk && done === 0) break; // short prompt: generate() prefills it in one go
    const end = Math.min(target, done + chunk);
    const out = await model.forward({
      input_ids: new Tensor("int64", ids.slice(done, end), [1, end - done]),
      attention_mask: ones([1, end]),
      past_key_values: pkv,
      ...lastLogitOnly(),
    });
    const fresh = {};
    for (const [name, tensor] of Object.entries(out)) {
      if (name.startsWith("present")) fresh[pastName(name)] = tensor;
      else if (tensor.location === "gpu-buffer") tensor.dispose();
    }
    if (pkv) pkv.update(fresh);
    else pkv = new DynamicCache(fresh);
    done = end;
  }
  return pkv;
}

// Image payloads (RGBA + dimensions) in the order their parts appear across the messages.
const imagePayloads = (messages) => {
  const images = [];
  for (const m of messages) for (const part of Array.isArray(m.content) ? m.content : []) if (part.type === "image" && part.image) images.push(part.image);
  return images;
};

// Conversation for the chat template: image parts become bare {type:"image"} markers; pixels travel via the processor.
const conversationOf = (messages) => messages.map((m) => Array.isArray(m.content)
  ? { role: m.role, content: m.content.filter((p) => p.type === "text").map((p) => ({ type: "text", text: p.text })) }
  : m);

const toRawImage = (img) => new RawImage(new Uint8Array(img.data), img.width, img.height, 4);

async function generate({ id, messages, tools }) {
  if (!model) throw new Error("No model loaded");
  if (family === "gemma4") return generateGemma({ id, messages, tools });
  const images = imagePayloads(messages);
  if (images.length) return generateImage({ id, messages, images });
  stopper.reset();
  const inputs = renderPrompt(messages, tools);
  const ids = Array.from(inputs.input_ids.data);
  // T16 (sweep b17, ~2/130 runs): a turn's first round can hang before the first token - a
  // WebGPU prefill that never returns. The 240 s turn timer then expires with an empty answer
  // and an empty trace. The watchdog turns the stall into a visible error 60 s in; the first
  // token clears it. A late done or tokens for the already-errored id are dropped by the
  // client (pending map); if the GPU stays wedged the worker's queue stalls behind it, which
  // a page reload (or the eval runner's next page) clears.
  const stall = setTimeout(() => postMessage({ type: 'error', id, message: 'the model stalled before its first token (no token in 60 s; the GPU may be wedged - reload the page)' }), 60000);
  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (text) => { clearTimeout(stall); postMessage({ type: 'token', id, text }); },
  });
  let pkv;
  try {
    pkv = await prefill(ids);
  } catch (err) {
    await dropCache();
    throw err;
  }
  // Rides along in model_inputs on every decoding step; 1 = logits for the last token only.
  const extra = needsLogitsToKeep() ? { logits_to_keep: new Tensor("int64", [1n], [1]) } : {};
  let output;
  try {
    output = await model.generate({
      input_ids: inputs.input_ids,
      attention_mask: ones([1, ids.length]),
      ...(pkv && { past_key_values: pkv }),
      ...extra,
      ...(!tools?.length && { bad_words_ids: bannedMarkers() }),
      max_new_tokens: MAX_NEW_TOKENS, do_sample: false, streamer, stopping_criteria: stopper,
      return_dict_in_generate: true,
    });
  } catch (err) {
    await pkv?.dispose();
    throw err;
  }
  const { sequences, past_key_values } = output;
  // The last generated token was never fed back, so the cache covers one token less than `sequences`.
  cached = { ids: Array.from(sequences.data).slice(0, past_key_values.get_seq_length()), pkv: past_key_values };
  const [text] = tokenizer.batch_decode(sequences.slice(null, [ids.length, null]), { skip_special_tokens: true });
  // Stop also ends a generation early; only reaching the token cap marks a cut-off answer.
  clearTimeout(stall);
  postMessage({ type: "done", id, text, ...(sequences.dims[1] - ids.length >= MAX_NEW_TOKENS && { truncated: true }) });
}

/**
 * Image turn (Qwen vision models only): the processor builds the template and pixel inputs, and
 * generate() merges the vision features into the prompt. No chunked prefill or prefix-cache reuse;
 * Stop still interrupts mid-prefill/decode through the shared stopper.
 */
async function generateImage({ id, messages, images }) {
  if (!processor) throw new Error("Image input needs a vision model load (Image input on, Qwen model).");
  stopper.reset();
  const text = processor.apply_chat_template(conversationOf(messages), { add_generation_prompt: true, enable_thinking: false });
  const inputs = await processor(text, images.length === 1 ? toRawImage(images[0]) : images.map(toRawImage));
  const promptLength = inputs.input_ids.dims[1];
  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (chunk) => postMessage({ type: "token", id, text: chunk }),
  });
  const output = await model.generate({
    ...inputs,
    bad_words_ids: bannedMarkers(),
    max_new_tokens: MAX_NEW_TOKENS, do_sample: false, streamer, stopping_criteria: stopper,
    return_dict_in_generate: true,
  });
  const [answer] = tokenizer.batch_decode(output.sequences.slice(null, [promptLength, null]), { skip_special_tokens: true });
  postMessage({ type: "done", id, text: answer, ...(output.sequences.dims[1] - promptLength >= MAX_NEW_TOKENS && { truncated: true }) });
}

/**
 * Gemma 4 turn: the processor renders the template (tools, tool calls and tool results included)
 * and the image parts, and the decoded text keeps Gemma's special tokens so gemma-calls.js can turn
 * its <|tool_call>call:NAME{...}<tool_call|> markup into the canonical form parseToolCalls reads.
 * The stream shows only the prose before a call (gemmaVisible). No chunked prefill or prefix-cache
 * reuse, as on the image path; Stop still ends it through the shared stopper.
 */
const gemmaConversation = (messages) => messages.map((m) => Array.isArray(m.content)
  ? { ...m, content: m.content.map((p) => (p.type === "image" || p.type === "audio" ? { type: p.type } : { type: "text", text: p.text })) }
  : m);
// Recorded audio (16 kHz mono Float32Array samples) in the order its parts appear; Gemma's processor
// reads the first one.
const audioPayloads = (messages) => {
  const out = [];
  for (const m of messages) for (const part of Array.isArray(m.content) ? m.content : []) if (part.type === "audio" && part.audio?.samples) out.push(part.audio.samples);
  return out;
};
async function generateGemma({ id, messages, tools }) {
  stopper.reset();
  const images = imagePayloads(messages).map(toRawImage);
  const prompt = processor.apply_chat_template(gemmaConversation(messages), {
    ...(tools?.length && { tools }), add_generation_prompt: true, enable_thinking: false,
  });
  const audio = audioPayloads(messages);
  const inputs = await processor(prompt, images.length ? (images.length === 1 ? images[0] : images) : null, audio.length ? audio : null, { add_special_tokens: false });
  const promptLength = inputs.input_ids.dims.at(-1);
  let raw = "", shown = "";
  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: false,
    callback_function: (chunk) => {
      raw += chunk;
      const visible = gemmaVisible(raw);
      if (visible.length > shown.length && visible.startsWith(shown)) {
        postMessage({ type: "token", id, text: visible.slice(shown.length) });
        shown = visible;
      }
    },
  });
  const output = await model.generate({
    ...inputs, max_new_tokens: MAX_NEW_TOKENS, do_sample: false, streamer, stopping_criteria: stopper,
    return_dict_in_generate: true,
  });
  const [decoded] = tokenizer.batch_decode(output.sequences.slice(null, [promptLength, null]), { skip_special_tokens: false });
  postMessage({ type: "done", id, text: gemmaToCanonical(decoded), ...(output.sequences.dims[1] - promptLength >= MAX_NEW_TOKENS && { truncated: true }) });
}

// Serialize requests. The host terminates this worker on cancellation, including model download and prefill.
let queue = Promise.resolve();
// Per-request interrupt ({ type: "interrupt", id }): that generation ends early through the shared
// stopper (a normal done with the partial text); a queued id is dropped with an aborted error.
// The global "stop" stays the kill-everything path.
let runningId = null;
const queuedIds = new Set();
self.onmessage = ({ data }) => {
  if (data.type === "stop") return stopper.interrupt();
  if (data.type === "interrupt") {
    if (data.id === runningId) stopper.interrupt();
    else if (queuedIds.delete(data.id)) postMessage({ type: "error", id: data.id, message: "aborted" });
    return;
  }
  if (data.type === "generate") queuedIds.add(data.id);
  queue = queue.then(async () => {
    try {
      if (data.type === "load") await load(data.key, data.vision);
      else if (data.type === "generate") {
        queuedIds.delete(data.id);
        runningId = data.id;
        try { await generate(data); } finally { runningId = null; }
      }
      else if (data.type === "count") await count(data);
    } catch (err) {
      postMessage({ type: "error", id: data.id, key: data.key, message: String(err?.message ?? err) });
    }
  });
};
