// Audio I/O and signal-processing helpers for the Node test harness.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { FFT } from '../../src/dsp/fft.ts';

export const ROOT = process.cwd();
export const CACHE = join(ROOT, 'test', 'fixtures');

export function readWav(path: string): { data: Float32Array; sampleRate: number } {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a wav: ' + path);
  let off = 12;
  let sampleRate = 44100, channels = 1, bits = 16;
  while (off < buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(off + 10);
      sampleRate = buf.readUInt32LE(off + 12);
      bits = buf.readUInt16LE(off + 22);
    } else if (id === 'data') {
      if (bits !== 16) throw new Error('only 16-bit wav supported');
      const frames = size / 2 / channels;
      const data = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let s = 0;
        for (let c = 0; c < channels; c++) s += buf.readInt16LE(off + 8 + (i * channels + c) * 2);
        data[i] = s / channels / 32768;
      }
      return { data, sampleRate };
    }
    off += 8 + size + (size & 1);
  }
  throw new Error('no data chunk: ' + path);
}

export function writeWav(path: string, data: Float32Array, sampleRate: number): void {
  const buf = Buffer.alloc(44 + data.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + data.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(data.length * 2, 40);
  for (let i = 0; i < data.length; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(data[i] * 32767))), 44 + i * 2);
  }
  writeFileSync(path, buf);
}

/** Decode any audio file to mono 16-bit wav via ffmpeg (cached). */
export function decodeToWav(src: string, name: string, sampleRate = 44100): { data: Float32Array; sampleRate: number } {
  const dir = join(CACHE, 'decoded');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${name}_${sampleRate}.wav`);
  if (!existsSync(out)) {
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-ac', '1', '-ar', String(sampleRate), '-c:a', 'pcm_s16le', out]);
    if (r.status !== 0) throw new Error('ffmpeg failed: ' + r.stderr);
  }
  return readWav(out);
}

/** Cubic (Catmull-Rom) resampling by an arbitrary ratio: out[i] = in[i * step]. */
export function resample(input: Float32Array, step: number, maxLen = Infinity): Float32Array {
  const len = Math.min(maxLen, Math.floor((input.length - 3) / step));
  const out = new Float32Array(Math.max(0, len));
  for (let i = 0; i < len; i++) {
    const pos = i * step + 1;
    const k = Math.floor(pos);
    const f = pos - k;
    const y0 = input[k - 1], y1 = input[k], y2 = input[k + 1], y3 = input[k + 2];
    out[i] = y1 + 0.5 * f * (y2 - y0 + f * (2 * y0 - 5 * y1 + 4 * y2 - y3 + f * (3 * (y1 - y2) + y3 - y0)));
  }
  return out;
}

/** Deterministic PRNG (mulberry32) so every harness run is reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rand: () => number): number {
  const u = Math.max(1e-12, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** 2nd-order Butterworth high-pass (RBJ biquad), in place. */
export function highpass(x: Float32Array, fc: number, sr: number): Float32Array {
  const w = (2 * Math.PI * fc) / sr;
  const alpha = Math.sin(w) / Math.SQRT2;
  const cw = Math.cos(w);
  const a0 = 1 + alpha;
  const b0 = (1 + cw) / 2 / a0, b1 = -(1 + cw) / a0, b2 = b0;
  const a1 = (-2 * cw) / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    x[i] = y0;
  }
  return x;
}

/** One-pole low-pass, in place (used to colour noise). */
export function onePoleLowpass(x: Float32Array, fc: number, sr: number): Float32Array {
  const a = Math.exp((-2 * Math.PI * fc) / sr);
  let y = 0;
  for (let i = 0; i < x.length; i++) { y = (1 - a) * x[i] + a * y; x[i] = y; }
  return x;
}

export function convolve(x: Float32Array, ir: Float32Array): Float32Array {
  let size = 1;
  while (size < x.length + ir.length) size <<= 1;
  const fft = new FFT(size);
  const ar = new Float64Array(size), ai = new Float64Array(size);
  const br = new Float64Array(size), bi = new Float64Array(size);
  ar.set(x); br.set(ir);
  fft.transform(ar, ai); fft.transform(br, bi);
  for (let i = 0; i < size; i++) {
    const r = ar[i] * br[i] - ai[i] * bi[i];
    const im = ar[i] * bi[i] + ai[i] * br[i];
    ar[i] = r; ai[i] = im;
  }
  fft.transform(ar, ai, true);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = ar[i] / size;
  return out;
}

/** Synthetic room: exponentially decaying noise tail mixed with the dry signal. */
export function addReverb(x: Float32Array, sr: number, rt60: number, wet: number, rand: () => number): Float32Array {
  const len = Math.floor(rt60 * sr);
  const ir = new Float32Array(len);
  const predelay = Math.floor(0.012 * sr);
  let energy = 0;
  for (let i = predelay; i < len; i++) {
    const t = i / sr;
    ir[i] = gaussian(rand) * Math.exp((-6.9 * t) / rt60);
    energy += ir[i] * ir[i];
  }
  // Rooms absorb highs faster than lows.
  onePoleLowpass(ir, 4000, sr);
  const norm = 1 / Math.sqrt(energy || 1);
  for (let i = 0; i < len; i++) ir[i] *= norm;
  const tail = convolve(x, ir);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] + wet * tail[i];
  return out;
}

export function rms(x: Float32Array, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

/** Add white+pink-ish noise at a given SNR (dB) relative to the RMS of the loudest 0.5 s. */
export function addNoise(x: Float32Array, sr: number, snrDb: number, rand: () => number): Float32Array {
  const win = Math.floor(0.5 * sr);
  let peak = 0;
  for (let i = 0; i + win <= x.length; i += Math.floor(win / 4)) peak = Math.max(peak, rms(x, i, i + win));
  if (peak === 0) peak = rms(x);
  const noise = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) noise[i] = gaussian(rand);
  const pink = onePoleLowpass(Float32Array.from(noise), 300, sr);
  for (let i = 0; i < x.length; i++) noise[i] = 0.4 * noise[i] + 4 * pink[i];
  const nr = rms(noise);
  const g = (peak / Math.pow(10, snrDb / 20)) / nr;
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] + g * noise[i];
  return out;
}

/** Mains hum (fundamental + a couple of harmonics). */
export function addHum(x: Float32Array, sr: number, freq: number, levelDb: number, ref: number): Float32Array {
  const a = ref * Math.pow(10, levelDb / 20);
  for (let i = 0; i < x.length; i++) {
    const t = i / sr;
    x[i] += a * (Math.sin(2 * Math.PI * freq * t) + 0.5 * Math.sin(4 * Math.PI * freq * t) + 0.3 * Math.sin(6 * Math.PI * freq * t));
  }
  return x;
}

export function mixInto(dst: Float32Array, src: Float32Array, offset: number, gain = 1): void {
  for (let i = 0; i < src.length && i + offset < dst.length; i++) dst[i + offset] += gain * src[i];
}

export function normalizePeak(x: Float32Array, peak = 0.5): Float32Array {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
  if (m > 0) for (let i = 0; i < x.length; i++) x[i] *= peak / m;
  return x;
}
