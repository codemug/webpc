// LFM3-Omni log-mel front end (M3 prep): a pure port of the model's feature extractor and of
// LiquidONNX's numpy reference, no Web Audio, no DOM.
//
// Recipe (all facts cited in .lanes/scratch/models/omni-port-note.md):
//   - right-pad to max(n_fft, n + hop * ceil((n - n_fft) / hop)) samples;
//   - frames at hop 160, no centering (center=False): frame t covers samples [t*160, t*160+400);
//   - periodic Hann of win_length (here == n_fft), cast to float32 as the reference does;
//   - power spectrum |STFT|² in float64 (torch's float32 STFT is ~1e-7 off, the reference's
//     numpy math is float64 too);
//   - the mel bank of transformers.audio_utils.mel_filter_bank (5.19.0), slaney scale and norm,
//     0..sampling_rate/2: 130 slaney mel points, triangular filters over fft bins at
//     i * (sr/2) / (bins-1), each filter divided by 2/(upper-lower);
//   - log10, clamped at log_floor (-12), then (x + offset) / divisor; float32 output.
//
// The extractor's input_features is [num_mel_bins, frames] (mel-major) and its
// feature_attention_mask is all ones for a single clip; both come back here.

export const DEFAULT_MEL = {
  sampling_rate: 16000,
  num_mel_bins: 128,
  n_fft: 400,
  win_length: 400,
  hop_length: 160,
  log_floor: -12.0,
  normalization_offset: 4.0,
  normalization_divisor: 4.0,
  encoder_stride: 8,
};

// Slaney mel scale (transformers 5.19.0 hertz_to_mel / mel_to_hertz, mel_scale "slaney"):
// linear to 1000 Hz (15 mels there), log above.
const SLANEY_LOGSTEP = 27 / Math.log(6.4);
export function hzToMel(f) {
  return f < 1000 ? (3 * f) / 200 : 15 + Math.log(f / 1000) * SLANEY_LOGSTEP;
}
export function melToHz(m) {
  return m < 15 ? (200 * m) / 3 : 1000 * Math.exp((Math.log(6.4) / 27) * (m - 15));
}

// Right-padding length and frame count of a clip of n samples.
export function padLength(n, cfg = DEFAULT_MEL) {
  if (n <= cfg.n_fft) return cfg.n_fft;
  return cfg.n_fft + cfg.hop_length * Math.ceil((n - cfg.n_fft) / cfg.hop_length);
}
export function numFrames(n, cfg = DEFAULT_MEL) {
  return 1 + (padLength(n, cfg) - cfg.n_fft) / cfg.hop_length;
}

// [num_mel_bins, n_fft/2+1] float32 (row-major mel * bins + freqBin): the triangular bank with
// the slaney area norm (2 / band width), filters computed in float64 then cast, as the
// extractor casts them to the power's dtype before the matmul.
const bankCache = new WeakMap();
export function melFilterBank(cfg = DEFAULT_MEL) {
  let cached = bankCache.get(cfg);
  if (cached) return cached;
  const mels = cfg.num_mel_bins;
  const bins = cfg.n_fft / 2 + 1;
  const melMin = hzToMel(0);
  const melMax = hzToMel(cfg.sampling_rate / 2);
  const ff = new Float64Array(mels + 2);
  for (let i = 0; i <= mels + 1; i++) ff[i] = melToHz(melMin + ((melMax - melMin) * i) / (mels + 1));
  const bank = new Float32Array(mels * bins);
  for (let m = 0; m < mels; m++) {
    const lower = ff[m];
    const center = ff[m + 1];
    const upper = ff[m + 2];
    const norm = 2 / (upper - lower);
    for (let i = 0; i < bins; i++) {
      const f = ((cfg.sampling_rate / 2) * i) / (bins - 1);
      bank[m * bins + i] = Math.max(0, Math.min((f - lower) / (center - lower), (upper - f) / (upper - center))) * norm;
    }
  }
  bankCache.set(cfg, bank);
  return bank;
}

// Complex in-place FFT of length n = 2^a * 5^b (400 = 16 * 25), mixed-radix DIT: p-point DFTs of
// the stride-m rows, then m-point DFTs of the twiddled columns (twiddle e^{-2*pi*i*p/n}).
function dft5(z, off) {
  const re = new Float64Array(5);
  const im = new Float64Array(5);
  for (let s = 0; s < 5; s++) {
    re[s] = z[off + 2 * s];
    im[s] = z[off + 2 * s + 1];
  }
  // w_a = e^{-2*pi*i*a/5}; out_a = sum_s re[s]+i*im[s] * w_{(s*a) mod 5}
  const wr = [1, Math.cos((-2 * Math.PI) / 5), Math.cos((-4 * Math.PI) / 5), Math.cos((-6 * Math.PI) / 5), Math.cos((-8 * Math.PI) / 5)];
  const wi = [0, Math.sin((-2 * Math.PI) / 5), Math.sin((-4 * Math.PI) / 5), Math.sin((-6 * Math.PI) / 5), Math.sin((-8 * Math.PI) / 5)];
  for (let a = 0; a < 5; a++) {
    let r = 0;
    let i = 0;
    for (let s = 1; s < 5; s++) {
      const k = (s * a) % 5;
      r += re[s] * wr[k] - im[s] * wi[k];
      i += re[s] * wi[k] + im[s] * wr[k];
    }
    r += re[0];
    i += im[0];
    z[off + 2 * a] = r;
    z[off + 2 * a + 1] = i;
  }
}

function fftInPlace(z, off, n) {
  if (n === 1) return;
  const p = n % 2 === 0 ? 2 : 5;
  const m = n / p;
  const y = new Float64Array(2 * n);
  for (let r = 0; r < m; r++) {
    for (let s = 0; s < p; s++) {
      const src = 2 * (off + r + m * s);
      const dst = 2 * (r * p + s);
      y[dst] = z[src];
      y[dst + 1] = z[src + 1];
    }
  }
  for (let r = 0; r < m; r++) {
    const row = 2 * p * r; // row r of y starts at z-index r*p
    if (p === 2) {
      const re0 = y[row];
      const im0 = y[row + 1];
      const re1 = y[row + 2];
      const im1 = y[row + 3];
      y[row] = re0 + re1;
      y[row + 1] = im0 + im1;
      y[row + 2] = re0 - re1;
      y[row + 3] = im0 - im1;
    } else {
      dft5(y, row);
    }
  }
  // stage 2: per output branch a, the twiddled column DFTs
  const out = new Float64Array(2 * n);
  const col = new Float64Array(2 * m);
  const twoPiOverN = (2 * Math.PI) / n;
  for (let a = 0; a < p; a++) {
    for (let r = 0; r < m; r++) {
      const t = twoPiOverN * r * a;
      const re = y[2 * (r * p + a)];
      const im = y[2 * (r * p + a) + 1];
      // (re + i*im) * e^{-i*t}
      col[2 * r] = re * Math.cos(t) + im * Math.sin(t);
      col[2 * r + 1] = im * Math.cos(t) - re * Math.sin(t);
    }
    fftInPlace(col, 0, m);
    for (let c = 0; c < m; c++) {
      const k = a + p * c;
      out[2 * k] = col[2 * c];
      out[2 * k + 1] = col[2 * c + 1];
    }
  }
  z.set(out, 2 * off);
}

// rfft power of one frame of n real samples: |X_k|², k = 0..n/2 (float64).
const windowCache = new WeakMap();
function hannWindow(cfg) {
  let w = windowCache.get(cfg);
  if (!w) {
    w = new Float32Array(cfg.win_length);
    for (let i = 0; i < cfg.win_length; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / cfg.win_length);
    windowCache.set(cfg, w);
  }
  return w;
}

// { features: Float32Array [num_mel_bins * frames], frames, bins, mask: Uint8Array of ones }
// of one mono clip at cfg.sampling_rate. `samples` is Float32Array, Float64Array or number[].
export function logMelFeatures(samples, cfg = DEFAULT_MEL) {
  const x = samples instanceof Float32Array ? samples : new Float32Array(samples);
  const frames = numFrames(x.length, cfg);
  const nfft = cfg.n_fft;
  const hop = cfg.hop_length;
  const bins = nfft / 2 + 1;
  const window = hannWindow(cfg);
  const padded = new Float64Array((frames - 1) * hop + nfft);
  padded.set(x.subarray(0, Math.min(x.length, padded.length)));
  const z = new Float64Array(2 * nfft);
  const power = new Float64Array(bins * frames);
  for (let t = 0; t < frames; t++) {
    const base = t * hop;
    for (let i = 0; i < nfft; i++) {
      z[2 * i] = padded[base + i] * window[i];
      z[2 * i + 1] = 0;
    }
    fftInPlace(z, 0, nfft);
    for (let k = 0; k < bins; k++) {
      const re = z[2 * k];
      const im = z[2 * k + 1];
      power[k + t * bins] = re * re + im * im;
    }
  }
  const bank = melFilterBank(cfg);
  const mels = cfg.num_mel_bins;
  const features = new Float32Array(mels * frames);
  for (let m = 0; m < mels; m++) {
    const row = m * bins;
    const out = m * frames;
    for (let t = 0; t < frames; t++) {
      let acc = 0;
      for (let k = 0; k < bins; k++) acc += bank[row + k] * power[k + t * bins];
      let v = Math.log10(acc);
      if (v < cfg.log_floor) v = cfg.log_floor;
      features[out + t] = (v + cfg.normalization_offset) / cfg.normalization_divisor;
    }
  }
  return { features, frames, bins: mels, mask: new Uint8Array(frames).fill(1) };
}
