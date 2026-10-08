// Monophonic pitch detectors operating on one analysis frame.
//
// Two classic time-domain methods are implemented here so they can be compared
// head-to-head in the test harness (see TEST_RESULTS.md):
//   - McLeod Pitch Method (MPM, "NSDF + key maxima")
//   - YIN (cumulative mean normalised difference function)
// Both share an FFT-based autocorrelation, so a frame of 2048–4096 samples
// costs well under a millisecond.

import { FFT } from './fft.ts';

export interface PitchEstimate {
  /** Fundamental frequency in Hz. */
  freq: number;
  /** 0..1, how periodic the frame is (NSDF peak height, or 1 - YIN dip). */
  clarity: number;
  /** Lag (period in samples, fractional). */
  period: number;
}

export interface DetectorOptions {
  sampleRate: number;
  frameSize: number;
  minFreq: number;
  maxFreq: number;
}

export type DetectorKind = 'mpm' | 'yin';

/** Shared autocorrelation machinery. */
class Autocorr {
  readonly n: number;
  private readonly fft: FFT;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  /** r[τ] = Σ x[i]·x[i+τ] over the full frame (biased, shrinking overlap). */
  readonly r: Float64Array;
  /** prefix sums of x² so that energy of any sub-range is O(1). */
  readonly sq: Float64Array;

  constructor(n: number) {
    this.n = n;
    let size = 1;
    while (size < 2 * n) size <<= 1;
    this.fft = new FFT(size);
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
    this.r = new Float64Array(n);
    this.sq = new Float64Array(n + 1);
  }

  compute(x: ArrayLike<number>): void {
    const { re, im, n } = this;
    re.fill(0); im.fill(0);
    for (let i = 0; i < n; i++) re[i] = x[i];
    this.fft.transform(re, im);
    for (let i = 0; i < re.length; i++) {
      re[i] = re[i] * re[i] + im[i] * im[i];
      im[i] = 0;
    }
    this.fft.transform(re, im, true);
    const scale = 1 / re.length;
    for (let t = 0; t < n; t++) this.r[t] = re[t] * scale;
    this.sq[0] = 0;
    for (let i = 0; i < n; i++) this.sq[i + 1] = this.sq[i] + x[i] * x[i];
  }
}

function parabolic(y0: number, y1: number, y2: number): { offset: number; value: number } {
  const d = y0 - 2 * y1 + y2;
  if (d === 0) return { offset: 0, value: y1 };
  const offset = (y0 - y2) / (2 * d);
  return { offset, value: y1 - 0.25 * (y0 - y2) * offset };
}

/**
 * McLeod Pitch Method. Returns the NSDF too so callers (octave guard) can
 * inspect alternative lags.
 */
export class McLeodDetector {
  readonly opts: DetectorOptions;
  /** "k" constant: pick the first key maximum ≥ k · highest maximum. */
  k = 0.9;
  private readonly ac: Autocorr;
  readonly nsdf: Float64Array;
  private readonly minLag: number;
  private readonly maxLag: number;

  constructor(opts: DetectorOptions) {
    this.opts = opts;
    this.ac = new Autocorr(opts.frameSize);
    this.nsdf = new Float64Array(opts.frameSize);
    this.minLag = Math.max(2, Math.floor(opts.sampleRate / opts.maxFreq));
    this.maxLag = Math.min(opts.frameSize - 2, Math.ceil(opts.sampleRate / opts.minFreq));
  }

  /** Fill this.nsdf for the given frame. */
  computeNsdf(frame: ArrayLike<number>): void {
    const { ac, nsdf } = this;
    ac.compute(frame);
    const n = this.opts.frameSize;
    const total = ac.sq[n];
    for (let t = 0; t <= this.maxLag + 1 && t < n; t++) {
      // m(τ) = Σ_{i<n-τ} x[i]² + x[i+τ]²
      const m = ac.sq[n - t] + (total - ac.sq[t]);
      nsdf[t] = m > 0 ? (2 * ac.r[t]) / m : 0;
    }
  }

  /** Key maxima: the highest point between each positive-going and negative-going zero crossing. */
  keyMaxima(): number[] {
    const { nsdf } = this;
    const peaks: number[] = [];
    let t = 1;
    // Skip the initial lobe around τ=0.
    while (t < this.maxLag && nsdf[t] > 0) t++;
    while (t < this.maxLag) {
      while (t < this.maxLag && nsdf[t] <= 0) t++;
      let best = -1;
      while (t < this.maxLag && nsdf[t] > 0) {
        if (t >= this.minLag && (best < 0 || nsdf[t] > nsdf[best])) best = t;
        t++;
      }
      if (best > 0 && best + 1 < nsdf.length) peaks.push(best);
    }
    return peaks;
  }

  refine(lag: number): { period: number; value: number } {
    const { nsdf } = this;
    const p = parabolic(nsdf[lag - 1], nsdf[lag], nsdf[lag + 1]);
    return { period: lag + p.offset, value: Math.min(1, p.value) };
  }

  detect(frame: ArrayLike<number>): PitchEstimate | null {
    this.computeNsdf(frame);
    const peaks = this.keyMaxima();
    if (peaks.length === 0) return null;
    let max = 0;
    for (const p of peaks) max = Math.max(max, this.nsdf[p]);
    if (max <= 0) return null;
    const thr = this.k * max;
    const chosen = peaks.find((p) => this.nsdf[p] >= thr)!;
    const { period, value } = this.refine(chosen);
    return { freq: this.opts.sampleRate / period, clarity: value, period };
  }
}

/** YIN (de Cheveigné & Kawahara 2002) with fixed integration window. */
export class YinDetector {
  readonly opts: DetectorOptions;
  threshold = 0.15;
  private readonly ac: Autocorr;
  private readonly fft: FFT;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly re2: Float64Array;
  private readonly im2: Float64Array;
  readonly cmnd: Float64Array;
  private readonly minLag: number;
  private readonly maxLag: number;
  private readonly win: number;

  constructor(opts: DetectorOptions) {
    this.opts = opts;
    this.minLag = Math.max(2, Math.floor(opts.sampleRate / opts.maxFreq));
    this.maxLag = Math.ceil(opts.sampleRate / opts.minFreq);
    this.win = opts.frameSize - this.maxLag - 1;
    if (this.win < this.maxLag / 2) throw new Error('frame too short for YIN at this minFreq');
    this.ac = new Autocorr(opts.frameSize);
    let size = 1;
    while (size < 2 * opts.frameSize) size <<= 1;
    this.fft = new FFT(size);
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
    this.re2 = new Float64Array(size);
    this.im2 = new Float64Array(size);
    this.cmnd = new Float64Array(this.maxLag + 2);
  }

  detect(frame: ArrayLike<number>): PitchEstimate | null {
    const { re, im, re2, im2, win } = this;
    const n = this.opts.frameSize;
    // r_W(τ) = Σ_{i<W} x[i]·x[i+τ]: cross-correlate the first W samples with the frame.
    re.fill(0); im.fill(0); re2.fill(0); im2.fill(0);
    for (let i = 0; i < n; i++) re[i] = frame[i];
    for (let i = 0; i < win; i++) re2[i] = frame[i];
    this.fft.transform(re, im);
    this.fft.transform(re2, im2);
    for (let i = 0; i < re.length; i++) {
      // X · conj(W)
      const a = re[i], b = im[i], c = re2[i], d = -im2[i];
      re[i] = a * c - b * d;
      im[i] = a * d + b * c;
    }
    this.fft.transform(re, im, true);
    const scale = 1 / re.length;
    this.ac.compute(frame); // reuse prefix sums of squares
    const sq = this.ac.sq;
    const e0 = sq[win];
    const cm = this.cmnd;
    cm[0] = 1;
    let running = 0;
    for (let t = 1; t <= this.maxLag + 1; t++) {
      const et = sq[t + win] - sq[t];
      const d = e0 + et - 2 * re[t] * scale;
      running += d;
      cm[t] = running > 0 ? (d * t) / running : 1;
    }
    // First dip below threshold, then walk to its local minimum.
    let tau = -1;
    for (let t = this.minLag; t <= this.maxLag; t++) {
      if (cm[t] < this.threshold) {
        while (t + 1 <= this.maxLag && cm[t + 1] < cm[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) {
      // No dip under threshold: fall back to the global minimum (low confidence).
      let best = this.minLag;
      for (let t = this.minLag; t <= this.maxLag; t++) if (cm[t] < cm[best]) best = t;
      tau = best;
    }
    if (tau <= 1 || tau >= this.maxLag + 1) return null;
    const p = parabolic(cm[tau - 1], cm[tau], cm[tau + 1]);
    const period = tau + p.offset;
    return { freq: this.opts.sampleRate / period, clarity: Math.max(0, 1 - p.value), period };
  }
}
