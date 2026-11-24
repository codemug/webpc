// Unit tests for the LFM3-Omni log-mel front end (src/apps/ai-agent/omni/mel.js): frame counts
// and padding, the silence floor, a 440 Hz tone landing in its mel bin, a mixed clip against
// the numpy reference, and the mel filter bank. The reference rows were computed by
// liquidonnx's log_mel (Liquid4All/onnx-export @ 26857c2e, lfm3_audio/session.py:197-219) with
// transformers 5.19.0's mel_filter_bank (slaney scale and norm); mel.js matched them
// bit-exactly. Run: node --test tests/omni-mel.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logMelFeatures, numFrames, padLength, melFilterBank, hzToMel, melToHz } from '../src/apps/ai-agent/omni/mel.js';

// 1 s 440 Hz cosine (16000 samples), frame 49, all 128 mel bins: -2 is the silence floor
// ((log_floor + offset) / divisor); the tone's energy spans mel bins 16-20, peaking at 18.
const TONE_ROW_49 = [
  -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2,
  1.495020032, 1.488005996, 1.635869145, 1.425759315, 1.437908173, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2,
  -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2,
  -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2,
  -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2,
  -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2,
  -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2,
  -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2,
];
// 0.3 s mix 0.6*cos(320 Hz) + 0.4*sin(2400 Hz) (4800 samples, 29 frames): frame 0 row, and the
// sum over all 128 x 29 values. Non-floor bins are 28, 57, 86 and 115.
const MIX_ROW_0 = [
  -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2,
  -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, 0.399887383, -2, -2, -2,
  -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2,
  -2, -2, -2, -2, -2, -2, -2, -2, -2, 0.497451812, -2, -2, -2, -2, -2, -2,
  -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2,
  -2, -2, -2, -2, -2, -2, 0.520470321, -2, -2, -2, -2, -2, -2, -2, -2, -2,
  -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2,
  -2, -2, -2, 0.486015558, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2, -2,
];
const MIX_SUM = -6277.49434655;

function tone1s() {
  const x = new Float32Array(16000);
  for (let i = 0; i < 16000; i++) x[i] = Math.cos((2 * Math.PI * 440 * i) / 16000);
  return x;
}
function mixed03() {
  const x = new Float32Array(4800);
  for (let i = 0; i < 4800; i++) {
    x[i] = 0.6 * Math.cos((2 * Math.PI * 320 * i) / 16000) + 0.4 * Math.sin((2 * Math.PI * 2400 * i) / 16000);
  }
  return x;
}
function maxDiff(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
  return d;
}

test('frame counts and padding: 1 s and 30 s clips, whole-frame and short clips', () => {
  // 16000 samples: 400 + 15600; 15600/160 = 97.5 -> pad 80 to 16080 -> 99 frames
  assert.equal(numFrames(16000), 99);
  assert.equal(padLength(16000), 16080);
  // 30 s: 480000 samples -> 480080 padded -> 2999 frames
  assert.equal(numFrames(480000), 2999);
  assert.equal(padLength(480000), 480080);
  // whole-frame clips need no padding
  assert.equal(numFrames(1200), 6);
  assert.equal(padLength(1200), 1200);
  assert.equal(numFrames(16080), 99);
  assert.equal(padLength(16080), 16080);
  assert.equal(numFrames(400), 1);
  assert.equal(padLength(400), 400);
  // short clips are padded to one whole window
  assert.equal(numFrames(399), 1);
  assert.equal(padLength(399), 400);

  const one = logMelFeatures(new Float32Array(16000));
  assert.equal(one.frames, 99);
  assert.equal(one.bins, 128);
  assert.equal(one.features.length, 128 * 99);
  assert.equal(one.mask.length, 99);
  assert.equal(new Set(one.mask).size, 1, 'the single-clip attention mask is all ones');
  const short = logMelFeatures(new Float32Array(1200));
  assert.equal(short.frames, 6);
  assert.equal(short.features.length, 128 * 6);
  const tiny = logMelFeatures(new Float32Array(399));
  assert.equal(tiny.frames, 1);
  assert.equal(tiny.features.length, 128);
});

test('silence gives the floor value after normalisation, exactly', () => {
  const r = logMelFeatures(new Float32Array(800));
  assert.equal(r.frames, 4);
  for (const v of r.features) assert.equal(v, -2.0, '(log_floor + offset) / divisor = (-12 + 4) / 4');
});

test('a 440 Hz tone lands in its mel bin', () => {
  const features = logMelFeatures(tone1s()).features;
  const row = Array.from({ length: 128 }, (_, m) => features[m * 99 + 49]);
  const peak = row.indexOf(Math.max(...row));
  assert.equal(peak, 18, 'the tone sits exactly at fft bin 11 (440 Hz); filter 18 is its mel bin');
  assert.ok(Math.abs(Math.max(...row) - TONE_ROW_49[peak]) < 1e-6, 'peak value matches the numpy reference');
  assert.ok(maxDiff(row, TONE_ROW_49) < 1e-6, 'the whole frame matches the numpy reference row');
});

test('a mixed clip matches the numpy reference: frame 0 and the full-matrix sum', () => {
  const r = logMelFeatures(mixed03());
  assert.equal(r.frames, 29);
  const row0 = Array.from({ length: 128 }, (_, m) => r.features[m]);
  assert.ok(maxDiff(row0, MIX_ROW_0) < 1e-6, 'frame 0 matches the numpy reference row');
  let sum = 0;
  for (const v of r.features) sum += v;
  assert.ok(Math.abs(sum - MIX_SUM) < 1e-4, `full-matrix sum ${sum} vs reference ${MIX_SUM}`);
});

test('the mel filter bank: shape, slaney-normalised values, no zero filter', () => {
  const bank = melFilterBank();
  assert.equal(bank.length, 128 * 201, '[num_mel_bins, n_fft/2 + 1]');
  // bank[m * 201 + k]: filter m at fft bin k (bin 11 is 440 Hz, bin 200 is the 8000 Hz nyquist)
  assert.ok(Math.abs(bank[18 * 201 + 11] - 0.034952353686094284) < 1e-12);
  assert.ok(Math.abs(bank[1 * 201 + 1] - 0.030392564833164215) < 1e-12);
  assert.equal(bank[127 * 201 + 200], 0, 'the last filter falls to zero at its upper edge');
  for (let m = 0; m < 128; m++) {
    let max = 0;
    for (let k = 0; k < 201; k++) max = Math.max(max, bank[m * 201 + k]);
    assert.ok(max > 0, `filter ${m} is not all zero`);
  }
});

test('the slaney scale: anchors and round trips', () => {
  assert.equal(hzToMel(0), 0);
  assert.equal(hzToMel(1000), 15, 'the linear/log boundary: 1000 Hz is 15 mels');
  assert.equal(melToHz(0), 0);
  assert.equal(melToHz(15), 1000);
  const logstep = 27 / Math.log(6.4);
  assert.ok(Math.abs(hzToMel(2000) - (15 + Math.log(2) * logstep)) < 1e-12);
  assert.ok(Math.abs(melToHz(1.5) - 100) < 1e-9, 'linear below the boundary: mels = 3f/200, so 100 Hz is 1.5 mels');
  for (const f of [100, 440, 4400, 7999.999]) {
    assert.ok(Math.abs(melToHz(hzToMel(f)) - f) / f < 1e-12, `round trip at ${f} Hz`);
  }
});
