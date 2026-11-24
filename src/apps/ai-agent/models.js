// Pinned upstream model revisions. Weights are fetched only after Load model.
export const MODELS = {
  "qwen3.5-0.8b": {
    "repo": "onnx-community/Qwen3.5-0.8B-ONNX-OPT",
    "label": "Qwen3.5 \u00b7 0.8B",
    "size": "~600 MB",
    "dtype": {
      "embed_tokens": "q4f16",
      "decoder_model_merged": "q4f16"
    },
    "vision": {
      "size": "~62 MB"
    },
    "license": "Apache-2.0",
    "revision": "9a4c21d8f724176b0a7edaaed36303044451886e"
  },
  "qwen3.5-2b": {
    "repo": "onnx-community/Qwen3.5-2B-ONNX-OPT",
    "label": "Qwen3.5 \u00b7 2B",
    "size": "~1.4 GB",
    "dtype": {
      "embed_tokens": "q4f16",
      "decoder_model_merged": "q4f16"
    },
    "vision": {
      "size": "~197 MB"
    },
    "license": "Apache-2.0 (base model)",
    "revision": "ed446636739bf426e73c5a00714fd8e010d36c21"
  },
  "lfm3-1.7b": {
    "repo": "LiquidAI/LFM3-1.7B-ONNX",
    "label": "LFM3 \u00b7 1.7B",
    "size": "~1.4 GB",
    "dtype": "q4f16",
    "license": "LFM Open License v1.0",
    "revision": "57c125dfa29f2d39157e280b1d1f7480b8736d8d"
  },
  "gemma4-e2b": {
    "repo": "onnx-community/gemma-4-E2B-it-ONNX",
    "label": "Gemma 4 \u00b7 E2B",
    "size": "~3.3 GB",
    "family": "gemma4",
    "dtype": {
      "embed_tokens": "q4f16",
      "decoder_model_merged": "q4f16",
      "vision_encoder": "q4f16",
      "audio_encoder": "q4f16"
    },
    "vision": {
      "size": "~99 MB"
    },
    "audio": {
      "size": "~171 MB"
    },
    "license": "Apache-2.0",
    "revision": "6f21c99d7e18237f8d2ce92aadfdbfeba877f63a"
  }
};
export const DEFAULT_MODEL = "lfm3-1.7b";
